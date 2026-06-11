import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { config } from '../config';

/**
 * The transient OAuth "tx" (transaction) cookie — the CSRF/PKCE binding carrier
 * for the Google login round-trip (ADR-037 §4, architect ADR-038, security
 * G9–G11). It carries the single-use `state` and the PKCE `code_verifier` as
 * ONE signed, integrity-protected value across the redirect to Google and back.
 *
 * It is a SEPARATE, DISTINCT cookie from the refresh cookie:
 *  - name `oauth_tx` (not `refresh_token`),
 *  - SameSite=Lax (NOT Strict): the callback is a cross-site top-level GET
 *    navigation FROM Google; a Strict cookie would be dropped on that nav and
 *    the flow would break (architect/security explicit ruling),
 *  - Path scoped to /auth/google (sent only on the OAuth routes),
 *  - HttpOnly + Secure(prod), Max-Age ≤ 600s,
 *  - cleared on the callback (success AND failure) → single-use (G10).
 *
 * The value is signed with HMAC-SHA256 over the JSON payload using JWT_SECRET
 * (an already-validated ≥32-byte secret). We sign in-module rather than relying
 * on @fastify/cookie's `signed` option so the integrity scheme is explicit,
 * self-contained, and does not require changing the global cookie registration.
 * The verifier is HttpOnly-cookie-only and never appears in a query/body/log (G11).
 */

/** Transient OAuth cookie name (distinct from the refresh cookie). */
export const OAUTH_TX_COOKIE_NAME = 'oauth_tx';

/** Path the transient cookie is scoped to (sent only on the OAuth routes). */
export const OAUTH_TX_COOKIE_PATH = '/auth/google';

/** Transient cookie lifetime: 600s (10 min) — the full auth round-trip budget (G9). */
export const OAUTH_TX_MAX_AGE_SECONDS = 600;

/** Byte length of the CSPRNG `state` and PKCE `code_verifier` seeds (G8/G9: 32 bytes). */
const RANDOM_BYTES = 32;

/** The bound transient state carried across the OAuth round-trip. */
export interface OAuthTx {
  /** Single-use CSRF state (base64url, 32 random bytes). */
  state: string;
  /** PKCE code_verifier (base64url, 32 random bytes) — never leaves the cookie. */
  verifier: string;
}

/**
 * Build the Set-Cookie options for the transient `oauth_tx` cookie (G9).
 * SameSite=Lax is deliberate and load-bearing (see module doc).
 *
 * @returns Fastify cookie serialize options for the transient cookie.
 */
export function oauthTxCookieOptions(): {
  httpOnly: true;
  secure: boolean;
  sameSite: 'lax';
  path: string;
  maxAge: number;
} {
  return {
    httpOnly: true,
    secure: config.isProduction,
    sameSite: 'lax',
    path: OAUTH_TX_COOKIE_PATH,
    maxAge: OAUTH_TX_MAX_AGE_SECONDS,
  };
}

/**
 * Generate a fresh single-use `state` + PKCE `code_verifier` pair (CSPRNG).
 *
 * @returns A new {state, verifier}, each 32 random bytes base64url-encoded.
 */
export function newOAuthTx(): OAuthTx {
  return {
    state: base64url(randomBytes(RANDOM_BYTES)),
    verifier: base64url(randomBytes(RANDOM_BYTES)),
  };
}

/**
 * Serialize + sign an OAuthTx into the cookie value `"<payloadB64>.<sigB64>"`.
 *
 * @param tx The transient state to seal.
 * @returns The signed cookie value.
 */
export function sealOAuthTx(tx: OAuthTx): string {
  const payload = base64url(Buffer.from(JSON.stringify(tx), 'utf8'));
  return `${payload}.${sign(payload)}`;
}

/**
 * Verify the cookie signature and parse it back into an OAuthTx. Returns null on
 * ANY integrity failure (bad shape, bad signature, malformed JSON) — the route
 * treats null as "reject + audit OAUTH_STATE_REJECTED" (G11). The signature
 * compare is constant-time.
 *
 * @param value The raw `oauth_tx` cookie value (may be undefined).
 * @returns The parsed transient state, or null if absent/invalid/forged.
 */
export function openOAuthTx(value: string | undefined): OAuthTx | null {
  if (!value) {
    return null;
  }
  const dot = value.indexOf('.');
  if (dot <= 0) {
    return null;
  }
  const payload = value.slice(0, dot);
  const sig = value.slice(dot + 1);
  if (!constantTimeEqual(sig, sign(payload))) {
    return null;
  }
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as unknown;
    if (!isOAuthTx(parsed)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Constant-time compare of the cookie `state` against the query `state` (G11).
 * Length-mismatched or non-string inputs return false without a timing leak.
 *
 * @param cookieState The state sealed in the cookie.
 * @param queryState The state echoed back by Google in the callback query.
 * @returns True iff the two states are byte-identical.
 */
export function statesMatch(cookieState: string, queryState: string): boolean {
  return constantTimeEqual(cookieState, queryState);
}

/**
 * HMAC-SHA256 sign a payload string with the validated JWT secret, base64url.
 *
 * @param payload The base64url payload to sign.
 * @returns The base64url signature.
 */
function sign(payload: string): string {
  return base64url(createHmac('sha256', config.JWT_SECRET).update(payload).digest());
}

/**
 * Constant-time string equality over their UTF-8 bytes (no early length leak
 * beyond comparing equal-length buffers; unequal lengths short-circuit false).
 *
 * @param a First string.
 * @param b Second string.
 * @returns True iff equal.
 */
function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) {
    return false;
  }
  return timingSafeEqual(ab, bb);
}

/**
 * Type guard for a parsed OAuthTx (defends the JSON.parse boundary).
 *
 * @param v The parsed value of unknown shape.
 * @returns True iff it is a well-formed OAuthTx.
 */
function isOAuthTx(v: unknown): v is OAuthTx {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as OAuthTx).state === 'string' &&
    typeof (v as OAuthTx).verifier === 'string'
  );
}

/**
 * Encode a buffer as URL-safe base64 with no padding.
 *
 * @param buf The bytes to encode.
 * @returns The base64url string.
 */
function base64url(buf: Buffer): string {
  return buf.toString('base64url');
}
