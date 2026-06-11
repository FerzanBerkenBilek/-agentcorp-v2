import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { UserRole } from '@prisma/client';
import { createFakePrisma, type FakeStore } from '../test/fake-prisma';
import { GoogleOAuthClient, type GoogleIdentity } from './google-oauth.client';
import { OAUTH_TX_COOKIE_NAME } from './oauth-tx';

/**
 * HTTP integration smoke tests for the Google OAuth routes (Phase OA-4 self-
 * verify). Builds the REAL app; the ONLY thing mocked beyond the Prisma data
 * layer is GoogleOAuthClient's NETWORK call (exchangeCodeForIdentity) — no live
 * Google calls (G: tests mock token+userinfo). buildAuthorizationUrl runs for
 * real (pure crypto). Covers the create / link / unverified-reject / state /
 * PKCE-presence matrix at a smoke level; OA-5 (qa-engineer) writes the
 * exhaustive suite + per-G coverage.
 */

const fake = createFakePrisma();
vi.mock('../shared/prisma', () => ({
  prisma: fake.prisma,
  disconnectPrisma: async () => undefined,
}));

let app: FastifyInstance;
let store: FakeStore;

/** Stub the back-channel exchange with a fixed identity (no network). */
function stubExchange(identity: GoogleIdentity): void {
  vi.spyOn(GoogleOAuthClient.prototype, 'exchangeCodeForIdentity').mockResolvedValue(identity);
}

/** Pull the Set-Cookie header(s) as an array. */
function setCookies(headers: Record<string, unknown>): string[] {
  const raw = headers['set-cookie'];
  if (Array.isArray(raw)) {
    return raw as string[];
  }
  return raw ? [String(raw)] : [];
}

/** Drive GET /auth/google and return the sealed oauth_tx cookie value + state. */
async function startFlow(): Promise<{ cookie: string; state: string }> {
  const res = await app.inject({ method: 'GET', url: '/auth/google' });
  expect(res.statusCode).toBe(302);
  const location = res.headers.location as string;
  const state = new URL(location).searchParams.get('state') as string;
  const txCookie = setCookies(res.headers).find((c) => c.startsWith(`${OAUTH_TX_COOKIE_NAME}=`));
  expect(txCookie).toBeDefined();
  const value = (txCookie as string).split(';')[0].slice(`${OAUTH_TX_COOKIE_NAME}=`.length);
  return { cookie: `${OAUTH_TX_COOKIE_NAME}=${decodeURIComponent(value)}`, state };
}

beforeEach(async () => {
  const { buildApp } = await import('../app');
  app = await buildApp();
  store = fake.store;
  store.users.clear();
  store.refreshTokens.clear();
  vi.restoreAllMocks();
});

afterEach(async () => {
  await app.close();
});

describe('GET /auth/google', () => {
  it('should_redirect_to_google_with_pkce_s256_and_state', async () => {
    const res = await app.inject({ method: 'GET', url: '/auth/google' });
    expect(res.statusCode).toBe(302);
    const url = new URL(res.headers.location as string);
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256'); // G8: never plain
    expect(url.searchParams.get('code_challenge')).toBeTruthy();
    expect(url.searchParams.get('state')).toBeTruthy();
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('scope')).toBe('openid email profile');
    // The verifier must NOT be exposed in the redirect (G11).
    expect(res.headers.location).not.toContain('code_verifier');
    expect(setCookies(res.headers).some((c) => c.startsWith(`${OAUTH_TX_COOKIE_NAME}=`))).toBe(true);
  });
});

describe('GET /auth/google/callback — create-or-link ladder', () => {
  it('should_create_a_new_passwordless_user_when_verified_and_no_match_G3', async () => {
    const { cookie, state } = await startFlow();
    stubExchange({ sub: 'g-sub-1', email: 'New@Example.com', emailVerified: true, name: 'New' });

    const res = await app.inject({
      method: 'GET',
      url: `/auth/google/callback?code=abc&state=${state}`,
      headers: { cookie },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json().data;
    expect(body.accessToken).toBeTruthy();
    expect(body.user.email).toBe('new@example.com'); // lowercased
    // Persisted with googleId + dummy password (cannot password-login, G7).
    const created = [...store.users.values()].find((u) => u.googleId === 'g-sub-1');
    expect(created).toBeDefined();
    expect(created?.role).toBe(UserRole.USER);
    expect(created?.googleEmail).toBe('new@example.com');
    // Session issued: a refresh cookie is set (same pattern as /auth/login, G22).
    expect(setCookies(res.headers).some((c) => c.startsWith('refresh_token='))).toBe(true);
    // The transient cookie is cleared (single-use, G10).
    expect(
      setCookies(res.headers).some(
        (c) => c.startsWith(`${OAUTH_TX_COOKIE_NAME}=`) && /Expires=Thu, 01 Jan 1970/.test(c),
      ),
    ).toBe(true);
  });

  it('should_link_to_an_existing_account_on_verified_email_match_G2', async () => {
    // Seed an existing password account.
    const id = crypto.randomUUID();
    store.users.set(id, {
      id,
      email: 'victim@example.com',
      passwordHash: 'x',
      name: 'Victim',
      role: UserRole.USER,
      googleId: null,
      googleEmail: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const { cookie, state } = await startFlow();
    stubExchange({
      sub: 'g-sub-2',
      email: 'victim@example.com',
      emailVerified: true,
      name: 'Victim G',
    });

    const res = await app.inject({
      method: 'GET',
      url: `/auth/google/callback?code=abc&state=${state}`,
      headers: { cookie },
    });

    expect(res.statusCode).toBe(200);
    expect(store.users.get(id)?.googleId).toBe('g-sub-2'); // linked, not duplicated
    expect(store.users.size).toBe(1); // no new row
  });

  it('should_login_returning_user_resolved_by_google_id_G1', async () => {
    const id = crypto.randomUUID();
    store.users.set(id, {
      id,
      email: 'returning@example.com',
      passwordHash: 'x',
      name: 'Returning',
      role: UserRole.USER,
      googleId: 'g-sub-3',
      googleEmail: 'returning@example.com',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const { cookie, state } = await startFlow();
    // Even if Google now reports a DIFFERENT (verified) email, resolution is by
    // google_id only (G1) — no re-link, no new row.
    stubExchange({
      sub: 'g-sub-3',
      email: 'changed@example.com',
      emailVerified: true,
      name: 'Returning',
    });

    const res = await app.inject({
      method: 'GET',
      url: `/auth/google/callback?code=abc&state=${state}`,
      headers: { cookie },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data.user.id).toBe(id);
    expect(store.users.size).toBe(1);
  });

  it('should_REJECT_unverified_email_matching_a_victim_account_G4_takeover_defense', async () => {
    const id = crypto.randomUUID();
    store.users.set(id, {
      id,
      email: 'victim@example.com',
      passwordHash: 'x',
      name: 'Victim',
      role: UserRole.USER,
      googleId: null,
      googleEmail: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const { cookie, state } = await startFlow();
    // Attacker controls a Google account asserting the victim's email, UNVERIFIED.
    stubExchange({
      sub: 'attacker-sub',
      email: 'victim@example.com',
      emailVerified: false,
      name: 'Attacker',
    });

    const res = await app.inject({
      method: 'GET',
      url: `/auth/google/callback?code=abc&state=${state}`,
      headers: { cookie },
    });

    expect(res.statusCode).toBe(401);
    // MUST NOT link or create: victim row untouched, no new row, no session.
    expect(store.users.get(id)?.googleId).toBeNull();
    expect(store.users.size).toBe(1);
    expect(setCookies(res.headers).some((c) => c.startsWith('refresh_token='))).toBe(false);
  });
});

describe('GET /auth/google/callback — state/PKCE rejection (G11)', () => {
  it('should_reject_when_state_mismatches', async () => {
    const { cookie } = await startFlow();
    stubExchange({ sub: 's', email: 'a@b.com', emailVerified: true, name: null });
    const res = await app.inject({
      method: 'GET',
      url: `/auth/google/callback?code=abc&state=WRONG_STATE`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(401);
  });

  it('should_reject_when_oauth_tx_cookie_is_absent', async () => {
    const { state } = await startFlow();
    const res = await app.inject({
      method: 'GET',
      url: `/auth/google/callback?code=abc&state=${state}`,
      // no cookie header
    });
    expect(res.statusCode).toBe(401);
  });

  it('should_reject_a_replayed_state_after_a_completed_callback', async () => {
    const { cookie, state } = await startFlow();
    stubExchange({ sub: 'g-rep', email: 'r@b.com', emailVerified: true, name: null });
    const first = await app.inject({
      method: 'GET',
      url: `/auth/google/callback?code=abc&state=${state}`,
      headers: { cookie },
    });
    expect(first.statusCode).toBe(200);
    // The client cleared its cookie; a replay without it is rejected.
    const replay = await app.inject({
      method: 'GET',
      url: `/auth/google/callback?code=abc&state=${state}`,
    });
    expect(replay.statusCode).toBe(401);
  });

  it('should_reject_when_google_reports_an_error_param', async () => {
    const { cookie, state } = await startFlow();
    const res = await app.inject({
      method: 'GET',
      url: `/auth/google/callback?error=access_denied&state=${state}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(401);
  });

  it('should_reject_when_the_code_query_param_is_absent', async () => {
    // A callback with a valid state but no `code` cannot complete the exchange;
    // it is rejected up front (G11) without ever calling the exchange.
    const { cookie, state } = await startFlow();
    const spy = vi
      .spyOn(GoogleOAuthClient.prototype, 'exchangeCodeForIdentity')
      .mockResolvedValue({ sub: 's', email: 'a@b.com', emailVerified: true, name: null });
    const res = await app.inject({
      method: 'GET',
      url: `/auth/google/callback?state=${state}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(401);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('GET /auth/google/callback — additional end-to-end matrix (OA-5)', () => {
  it('should_fail_closed_at_the_route_when_the_back_channel_exchange_fails_G16', async () => {
    // The hardened client throws a generic AuthError on any token/userinfo
    // failure (covered exhaustively at the client unit level); here we assert the
    // ROUTE surfaces it as a 401 and issues NO session (fail-closed end to end).
    const { cookie, state } = await startFlow();
    vi.spyOn(GoogleOAuthClient.prototype, 'exchangeCodeForIdentity').mockRejectedValue(
      new (await import('../shared/errors')).AuthError('OAuth exchange failed'),
    );
    const res = await app.inject({
      method: 'GET',
      url: `/auth/google/callback?code=abc&state=${state}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(401);
    expect(setCookies(res.headers).some((c) => c.startsWith('refresh_token='))).toBe(false);
  });

  it('should_return_409_and_issue_no_session_when_the_account_is_already_linked_G6', async () => {
    // An existing account whose email matches but is ALREADY bound to a different
    // google_id: the conditional link write matches no row → ConflictError → 409.
    const id = crypto.randomUUID();
    store.users.set(id, {
      id,
      email: 'taken@example.com',
      passwordHash: 'x',
      name: 'Taken',
      role: UserRole.USER,
      googleId: 'already-bound-sub',
      googleEmail: 'taken@example.com',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const { cookie, state } = await startFlow();
    stubExchange({
      sub: 'different-incoming-sub',
      email: 'taken@example.com',
      emailVerified: true,
      name: 'Taken G',
    });
    const res = await app.inject({
      method: 'GET',
      url: `/auth/google/callback?code=abc&state=${state}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(409);
    expect(store.users.get(id)?.googleId).toBe('already-bound-sub'); // not overwritten
    expect(setCookies(res.headers).some((c) => c.startsWith('refresh_token='))).toBe(false);
  });

  it('should_never_expose_the_client_secret_in_the_callback_response_G19', async () => {
    // The success response is the standard session shape (access token + public
    // user); the Google client_secret must never appear in the body or headers.
    const { cookie, state } = await startFlow();
    stubExchange({ sub: 'g-secret', email: 's@example.com', emailVerified: true, name: 'S' });
    const res = await app.inject({
      method: 'GET',
      url: `/auth/google/callback?code=abc&state=${state}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    // test/setup.ts sets GOOGLE_CLIENT_SECRET=test-google-client-secret.
    expect(res.body).not.toContain('test-google-client-secret');
    expect(JSON.stringify(res.headers)).not.toContain('test-google-client-secret');
  });
});
