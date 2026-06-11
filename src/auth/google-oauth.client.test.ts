import { createHash } from 'crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthError } from '../shared/errors';
import { GoogleOAuthClient, type GoogleOAuthClientConfig } from './google-oauth.client';

/**
 * Unit tests for the transport-only Google OAuth client (Phase OA-5, qa-engineer).
 *
 * EXTENDS — does not duplicate — backend-dev's route smoke suite
 * (google-oauth.routes.integration.test.ts), which mocks
 * `exchangeCodeForIdentity` WHOLESALE and therefore never executes the hardened
 * egress path (`fetchGoogle`/`readBounded` — 67% line coverage at OA-4 close).
 *
 * Here the global `fetch` is mocked the same way `url-safety.test.ts` mocks
 * `node:dns/promises.lookup`: each test arranges exactly what Google "returns"
 * so the REAL fetchGoogle hardening (G15–G17) runs with no live network. This
 * exercises:
 *  - the token-exchange + userinfo back-channel (G12, the identity source),
 *  - PKCE S256 challenge derivation in the authorization URL (G8),
 *  - egress hardening: HTTPS-only, timeout, redirect:'manual', body cap,
 *    Zod-validate → fail-closed generic AuthError (G15/G16),
 *  - the fixed (non-user) Google URLs + `client_secret` confined to the token
 *    POST body, never the userinfo GET / never reflected (G19),
 *  - that the egress is NOT routed through assertSafeUrl (G17 — fixed URLs).
 */

const CFG: GoogleOAuthClientConfig = {
  clientId: 'test-client-id.apps.googleusercontent.com',
  clientSecret: 'super-secret-value',
  redirectUri: 'http://localhost:3000/auth/google/callback',
};

const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_ENDPOINT = 'https://openidconnect.googleapis.com/v1/userinfo';
const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';

/** A captured fetch call (url + the init we passed to global fetch). */
interface FetchCall {
  url: string;
  init: RequestInit;
}

let fetchMock: ReturnType<typeof vi.fn>;
let calls: FetchCall[];

/**
 * Build a minimal Response-like object honouring only what fetchGoogle reads:
 * `status`, `type`, and `text()`. Avoids constructing a real Response (which
 * normalises 3xx / opaqueredirect in ways the undici test env varies on).
 */
function fakeResponse(opts: {
  status?: number;
  type?: 'default' | 'opaqueredirect' | 'basic' | 'cors' | 'error' | 'opaque';
  body?: string;
}): Response {
  return {
    status: opts.status ?? 200,
    type: opts.type ?? 'default',
    text: async () => opts.body ?? '',
  } as unknown as Response;
}

/** Arrange the mocked fetch to return the given responses in call order. */
function arrangeFetch(...responses: Array<Response | (() => never | Promise<never>)>): void {
  for (const r of responses) {
    if (typeof r === 'function') {
      fetchMock.mockImplementationOnce(async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return (r as () => Promise<never>)();
      });
    } else {
      fetchMock.mockImplementationOnce(async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return r;
      });
    }
  }
}

beforeEach(() => {
  calls = [];
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('GoogleOAuthClient.buildAuthorizationUrl (G8 — PKCE S256)', () => {
  it('should_carry_code_challenge_S256_derived_from_the_verifier_and_never_the_verifier', () => {
    const client = new GoogleOAuthClient(CFG);
    const codeVerifier = 'verifier-abc-123';
    const url = new URL(client.buildAuthorizationUrl({ codeVerifier, state: 'st-1' }));

    // Endpoint is the fixed Google authorization URL (G17 — not user-controlled).
    expect(url.origin + url.pathname).toBe(GOOGLE_AUTH_ENDPOINT);
    // S256 only — there is no `plain` branch anywhere (G8).
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    // The challenge is exactly base64url(SHA256(verifier)).
    const expected = createHash('sha256').update(codeVerifier).digest('base64url');
    expect(url.searchParams.get('code_challenge')).toBe(expected);
    // The raw verifier must NEVER appear in the redirect (G11): not as a param,
    // not anywhere in the query string.
    expect(url.searchParams.get('code_verifier')).toBeNull();
    expect(url.toString()).not.toContain(codeVerifier);
    // State is echoed; client_id + fixed redirect_uri are pinned (G14/G21).
    expect(url.searchParams.get('state')).toBe('st-1');
    expect(url.searchParams.get('client_id')).toBe(CFG.clientId);
    expect(url.searchParams.get('redirect_uri')).toBe(CFG.redirectUri);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('scope')).toBe('openid email profile');
  });

  it('should_produce_distinct_challenges_for_distinct_verifiers', () => {
    const client = new GoogleOAuthClient(CFG);
    const a = new URL(client.buildAuthorizationUrl({ codeVerifier: 'v1', state: 's' }));
    const b = new URL(client.buildAuthorizationUrl({ codeVerifier: 'v2', state: 's' }));
    expect(a.searchParams.get('code_challenge')).not.toBe(b.searchParams.get('code_challenge'));
  });
});

describe('GoogleOAuthClient.exchangeCodeForIdentity — happy back-channel (G12)', () => {
  it('should_exchange_code_then_fetch_userinfo_and_return_the_verified_identity', async () => {
    arrangeFetch(
      fakeResponse({ body: JSON.stringify({ access_token: 'ya29.fresh-access-token' }) }),
      fakeResponse({
        body: JSON.stringify({
          sub: 'google-sub-1',
          email: 'person@example.com',
          email_verified: true,
          name: 'A Person',
        }),
      }),
    );

    const client = new GoogleOAuthClient(CFG);
    const identity = await client.exchangeCodeForIdentity('auth-code-1', 'pkce-verifier-1');

    expect(identity).toEqual({
      sub: 'google-sub-1',
      email: 'person@example.com',
      emailVerified: true,
      name: 'A Person',
    });

    // Exactly two egress calls, to the FIXED Google endpoints (G15/G17).
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe(GOOGLE_TOKEN_ENDPOINT);
    expect(calls[1].url).toBe(GOOGLE_USERINFO_ENDPOINT);

    // Hardening flags on every call: redirect:'manual' + an abort signal (G15).
    for (const c of calls) {
      expect(c.init.redirect).toBe('manual');
      expect(c.init.signal).toBeInstanceOf(AbortSignal);
    }

    // The token POST carries grant/code/verifier/redirect + BOTH credentials in
    // the BODY only (G19/G21); the userinfo GET carries the bearer access token.
    const tokenBody = String(calls[0].init.body);
    expect(calls[0].init.method).toBe('POST');
    expect(tokenBody).toContain('grant_type=authorization_code');
    expect(tokenBody).toContain('code=auth-code-1');
    expect(tokenBody).toContain('code_verifier=pkce-verifier-1');
    expect(tokenBody).toContain(`client_id=${encodeURIComponent(CFG.clientId)}`);
    expect(tokenBody).toContain('client_secret=super-secret-value');
    expect(tokenBody).toContain(encodeURIComponent(CFG.redirectUri));

    expect(calls[1].init.method).toBe('GET');
    expect((calls[1].init.headers as Record<string, string>).authorization).toBe(
      'Bearer ya29.fresh-access-token',
    );
  });

  it('should_send_client_secret_ONLY_in_the_token_post_never_on_the_userinfo_call_G19', async () => {
    arrangeFetch(
      fakeResponse({ body: JSON.stringify({ access_token: 'tok' }) }),
      fakeResponse({
        body: JSON.stringify({ sub: 's', email: 'e@x.com', email_verified: true }),
      }),
    );
    const client = new GoogleOAuthClient(CFG);
    await client.exchangeCodeForIdentity('c', 'v');

    // The secret must not leak onto the userinfo GET (no body, no header, no url).
    const userinfo = calls[1];
    expect(userinfo.url).not.toContain(CFG.clientSecret);
    expect(JSON.stringify(userinfo.init.headers)).not.toContain(CFG.clientSecret);
    expect(String(userinfo.init.body ?? '')).not.toContain(CFG.clientSecret);
  });

  it('should_treat_email_verified_string_true_as_verified_and_absent_as_unverified', async () => {
    // Google has historically sent "true"/"false" strings — the client coerces.
    arrangeFetch(
      fakeResponse({ body: JSON.stringify({ access_token: 'tok' }) }),
      fakeResponse({
        body: JSON.stringify({ sub: 's1', email: 'e@x.com', email_verified: 'true' }),
      }),
    );
    const client = new GoogleOAuthClient(CFG);
    const verified = await client.exchangeCodeForIdentity('c', 'v');
    expect(verified.emailVerified).toBe(true);
    expect(verified.name).toBeNull(); // no name provided → null (not undefined)

    arrangeFetch(
      fakeResponse({ body: JSON.stringify({ access_token: 'tok' }) }),
      // email_verified absent → must NOT be treated as verified (G4 input side).
      fakeResponse({ body: JSON.stringify({ sub: 's2', email: 'e2@x.com' }) }),
    );
    const absent = await client.exchangeCodeForIdentity('c', 'v');
    expect(absent.emailVerified).toBe(false);
  });
});

describe('GoogleOAuthClient.exchangeCodeForIdentity — egress fail-closed (G15/G16)', () => {
  it('should_fail_closed_when_the_token_endpoint_returns_non_2xx', async () => {
    arrangeFetch(fakeResponse({ status: 400, body: JSON.stringify({ error: 'invalid_grant' }) }));
    const client = new GoogleOAuthClient(CFG);
    await expect(client.exchangeCodeForIdentity('bad', 'v')).rejects.toBeInstanceOf(AuthError);
    // No userinfo call once the token exchange failed (no silent continue).
    expect(calls).toHaveLength(1);
  });

  it('should_fail_closed_on_a_5xx_from_google', async () => {
    arrangeFetch(fakeResponse({ status: 503, body: 'upstream down' }));
    const client = new GoogleOAuthClient(CFG);
    await expect(client.exchangeCodeForIdentity('c', 'v')).rejects.toBeInstanceOf(AuthError);
  });

  it('should_treat_a_manual_redirect_3xx_as_a_hard_failure_no_follow', async () => {
    // redirect:'manual' surfaces a 3xx as status 3xx OR type 'opaqueredirect';
    // both must fail closed (never follow a 3xx to an attacker host, G15).
    arrangeFetch(fakeResponse({ status: 302, body: '' }));
    const client = new GoogleOAuthClient(CFG);
    await expect(client.exchangeCodeForIdentity('c', 'v')).rejects.toBeInstanceOf(AuthError);

    arrangeFetch(fakeResponse({ type: 'opaqueredirect', status: 0, body: '' }));
    await expect(client.exchangeCodeForIdentity('c', 'v')).rejects.toBeInstanceOf(AuthError);
  });

  it('should_fail_closed_when_fetch_rejects_network_error_or_timeout_abort', async () => {
    // A thrown fetch (network error, DNS failure, or AbortSignal.timeout firing)
    // becomes a generic AuthError — never a leaked provider string, never a retry.
    arrangeFetch(() => {
      throw new Error('ECONNREFUSED 142.250.0.0:443');
    });
    const client = new GoogleOAuthClient(CFG);
    const err = await client.exchangeCodeForIdentity('c', 'v').catch((e) => e);
    expect(err).toBeInstanceOf(AuthError);
    // The generic message must not echo the underlying network detail.
    expect((err as AuthError).message).not.toContain('ECONNREFUSED');

    arrangeFetch(() => {
      const abort = new DOMException('The operation was aborted', 'TimeoutError');
      throw abort;
    });
    await expect(client.exchangeCodeForIdentity('c', 'v')).rejects.toBeInstanceOf(AuthError);
  });

  it('should_fail_closed_on_malformed_json_body', async () => {
    arrangeFetch(fakeResponse({ body: 'this-is-not-json{' }));
    const client = new GoogleOAuthClient(CFG);
    await expect(client.exchangeCodeForIdentity('c', 'v')).rejects.toBeInstanceOf(AuthError);
  });

  it('should_fail_closed_when_token_response_is_missing_access_token_schema_violation', async () => {
    // Valid JSON but the Zod token schema (access_token min 1) is not satisfied.
    arrangeFetch(fakeResponse({ body: JSON.stringify({ token_type: 'Bearer' }) }));
    const client = new GoogleOAuthClient(CFG);
    await expect(client.exchangeCodeForIdentity('c', 'v')).rejects.toBeInstanceOf(AuthError);
  });

  it('should_fail_closed_when_userinfo_is_missing_sub_or_email_schema_violation', async () => {
    arrangeFetch(
      fakeResponse({ body: JSON.stringify({ access_token: 'tok' }) }),
      // userinfo with no `sub` — schema violation → fail closed (G15).
      fakeResponse({ body: JSON.stringify({ email: 'e@x.com', email_verified: true }) }),
    );
    const client = new GoogleOAuthClient(CFG);
    await expect(client.exchangeCodeForIdentity('c', 'v')).rejects.toBeInstanceOf(AuthError);
  });

  it('should_fail_closed_when_userinfo_email_is_not_a_valid_email', async () => {
    arrangeFetch(
      fakeResponse({ body: JSON.stringify({ access_token: 'tok' }) }),
      fakeResponse({ body: JSON.stringify({ sub: 's', email: 'not-an-email' }) }),
    );
    const client = new GoogleOAuthClient(CFG);
    await expect(client.exchangeCodeForIdentity('c', 'v')).rejects.toBeInstanceOf(AuthError);
  });

  it('should_reject_a_response_body_larger_than_the_1MB_cap_G15', async () => {
    // Valid JSON shape but the body exceeds MAX_RESPONSE_BYTES (1 MB) → readBounded
    // throws before parse. Build a >1MB JSON string by padding a passthrough field.
    const huge = 'x'.repeat(1024 * 1024 + 16);
    arrangeFetch(fakeResponse({ body: JSON.stringify({ access_token: 'tok', pad: huge }) }));
    const client = new GoogleOAuthClient(CFG);
    await expect(client.exchangeCodeForIdentity('c', 'v')).rejects.toBeInstanceOf(AuthError);
  });
});
