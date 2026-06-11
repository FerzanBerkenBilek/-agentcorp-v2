import { createHash } from 'crypto';
import { z } from 'zod';
import { AuthError } from '../shared/errors';

/**
 * Google OAuth2 client — TRANSPORT ONLY (architect ADR-038, security ADR-039/040).
 *
 * Responsibilities are strictly: build the authorization URL (with PKCE S256),
 * exchange an authorization code for tokens, and fetch the userinfo over the
 * freshly-exchanged access token. It holds NO policy: no create-or-link
 * decision, no token issuance, no Prisma, no Fastify type. The email_verified
 * gate and session minting are the auth SERVICE tier's job.
 *
 * Identity source (ADR-039, G12–G14): identity is read ONLY from the
 * back-channel — the userinfo endpoint called with the access token we just
 * exchanged server-side — NEVER from any redirect/callback param. This avoids
 * id_token JWKS/RS256 verification entirely, so NO new dependency is needed
 * (Node 22 global fetch + node:crypto only). `aud`/`client_id` is pinned via the
 * confidential token exchange (the secret-authenticated POST).
 *
 * Egress hardening (ADR-040, G15–G17): every Google call goes through the ONE
 * `fetchGoogle()` helper — HTTPS-only (asserted), AbortSignal.timeout (fail
 * closed), redirect:'manual' (never follow a 3xx to an attacker host), bounded
 * response body, Zod-validated JSON. `assertSafeUrl` (the user-URL SSRF guard)
 * is deliberately NOT applied: these are fixed, non-user URLs from config (G17).
 */

/** Google's well-known OAuth2/OIDC endpoints (fixed, non-user-controlled). */
const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_ENDPOINT = 'https://openidconnect.googleapis.com/v1/userinfo';

/** Read-only OIDC scopes requested (orchestrator OUT-scope: no write scopes). */
const GOOGLE_SCOPES = 'openid email profile';

/** Egress timeout: fail closed if Google does not answer within 5s (G15/G16). */
const FETCH_TIMEOUT_MS = 5000;

/** Hard cap on a Google response body (1 MB) to bound memory (G15). */
const MAX_RESPONSE_BYTES = 1024 * 1024;

/** The verified identity returned to the service tier (back-channel only). */
export interface GoogleIdentity {
  /** Google `sub` — the immutable subject id (the join key, ADR-036 §1). */
  sub: string;
  /** The user's Google email. */
  email: string;
  /** Whether Google asserts the email is verified — the takeover gate (G4). */
  emailVerified: boolean;
  /** Display name, if Google provided one. */
  name: string | null;
}

/** Inputs needed to build a PKCE authorization redirect. */
export interface AuthorizationRequest {
  /** PKCE code_verifier (held in the oauth_tx cookie; never sent to Google here). */
  codeVerifier: string;
  /** Single-use CSRF state (echoed by Google in the callback). */
  state: string;
}

/** Zod shape of Google's token-exchange response (only the field we use). */
const tokenResponseSchema = z
  .object({
    access_token: z.string().min(1),
  })
  .passthrough();

/** Zod shape of Google's userinfo response (back-channel identity, G12). */
const userInfoSchema = z
  .object({
    sub: z.string().min(1),
    email: z.string().email(),
    // Google may send a boolean or, historically, a "true"/"false" string.
    email_verified: z.union([z.boolean(), z.enum(['true', 'false'])]).optional(),
    name: z.string().optional(),
  })
  .passthrough();

/** Configuration injected into the client (from the validated app config). */
export interface GoogleOAuthClientConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

/**
 * Transport-only client for Google's OAuth2 endpoints.
 */
export class GoogleOAuthClient {
  /** @param cfg Client id/secret/redirect-uri from the validated app config (G18). */
  constructor(private readonly cfg: GoogleOAuthClientConfig) {}

  /**
   * Build the Google authorization-redirect URL with PKCE S256 (G8) + state.
   * `code_challenge_method` is hard-coded `S256`; there is NO `plain` branch.
   *
   * @param req The PKCE code_verifier + CSRF state for this round-trip.
   * @returns The absolute https URL to 302-redirect the browser to.
   */
  buildAuthorizationUrl(req: AuthorizationRequest): string {
    const url = new URL(GOOGLE_AUTH_ENDPOINT);
    url.searchParams.set('client_id', this.cfg.clientId);
    url.searchParams.set('redirect_uri', this.cfg.redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', GOOGLE_SCOPES);
    url.searchParams.set('state', req.state);
    url.searchParams.set('code_challenge', codeChallengeS256(req.codeVerifier));
    url.searchParams.set('code_challenge_method', 'S256');
    // Force a server-side refreshable consent only when needed; keep it minimal.
    url.searchParams.set('access_type', 'online');
    return url.toString();
  }

  /**
   * Exchange an authorization code for tokens, then fetch the verified identity
   * from the userinfo endpoint over the fresh access token (ADR-039, G12–G14).
   * The `client_secret` is sent ONLY in this POST body over TLS (G19); the
   * `code_verifier` proves PKCE possession (G8); `redirect_uri` is the fixed
   * config value, identical to the authorization request (G21).
   *
   * @param code The authorization code from Google's callback query.
   * @param codeVerifier The PKCE verifier from the oauth_tx cookie.
   * @returns The verified Google identity (sub/email/email_verified/name).
   * @throws AuthError on any transport/validation failure (fail-closed, generic).
   */
  async exchangeCodeForIdentity(code: string, codeVerifier: string): Promise<GoogleIdentity> {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: this.cfg.clientId,
      client_secret: this.cfg.clientSecret,
      redirect_uri: this.cfg.redirectUri,
      code_verifier: codeVerifier,
    });
    const token = await this.fetchGoogle(
      GOOGLE_TOKEN_ENDPOINT,
      tokenResponseSchema,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body: body.toString(),
      },
    );
    const info = await this.fetchGoogle(GOOGLE_USERINFO_ENDPOINT, userInfoSchema, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${token.access_token}`,
        accept: 'application/json',
      },
    });
    return {
      sub: info.sub,
      email: info.email,
      emailVerified: info.email_verified === true || info.email_verified === 'true',
      name: info.name ?? null,
    };
  }

  /**
   * The ONE hardened fetch wrapper for all Google egress (G15–G17).
   * HTTPS-only, timeout (fail closed), redirect:'manual', bounded body,
   * Zod-validated JSON. Any failure becomes a generic AuthError — never a silent
   * success, never a retry storm, never a leaked Google error string.
   *
   * @param endpoint A fixed Google https endpoint (NOT user-controlled — G17).
   * @param schema The Zod schema the parsed JSON must satisfy.
   * @param init Fetch init (method/headers/body).
   * @returns The validated, typed response.
   * @throws AuthError on non-https, timeout, redirect, non-2xx, oversize, or
   *   schema-validation failure.
   */
  private async fetchGoogle<S extends z.ZodTypeAny>(
    endpoint: string,
    schema: S,
    init: { method: string; headers: Record<string, string>; body?: string },
  ): Promise<z.infer<S>> {
    // HTTPS-only assertion (defense in depth; these are constants but verify).
    if (!endpoint.startsWith('https://')) {
      throw new AuthError('OAuth provider unavailable');
    }
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: init.method,
        headers: init.headers,
        body: init.body,
        redirect: 'manual', // never follow a 3xx to an attacker-controlled host
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), // fail closed on a hang
      });
    } catch {
      // Network error, timeout, or aborted — fail closed, generic message.
      throw new AuthError('OAuth provider unavailable');
    }
    // redirect:'manual' surfaces a 3xx as an opaque/200-but-type-'opaqueredirect'
    // or a 3xx status; treat any non-2xx (incl. redirects) as a hard failure.
    if (response.status < 200 || response.status >= 300 || response.type === 'opaqueredirect') {
      throw new AuthError('OAuth exchange failed');
    }
    const text = await this.readBounded(response);
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new AuthError('OAuth exchange failed');
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      throw new AuthError('OAuth exchange failed');
    }
    return parsed.data;
  }

  /**
   * Read a response body, rejecting anything over MAX_RESPONSE_BYTES (G15).
   *
   * @param response The fetch Response.
   * @returns The body text (≤ 1 MB).
   * @throws AuthError if the body exceeds the cap.
   */
  private async readBounded(response: Response): Promise<string> {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
      throw new AuthError('OAuth exchange failed');
    }
    return text;
  }
}

/**
 * Compute the PKCE S256 code_challenge = base64url(SHA256(code_verifier)) (G8).
 * S256 ONLY — there is no `plain` path anywhere in this module.
 *
 * @param codeVerifier The PKCE code_verifier.
 * @returns The base64url-encoded SHA-256 challenge.
 */
function codeChallengeS256(codeVerifier: string): string {
  return createHash('sha256').update(codeVerifier).digest('base64url');
}
