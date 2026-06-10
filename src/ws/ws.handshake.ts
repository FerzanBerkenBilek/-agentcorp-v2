import { config } from '../config';
import { isAllowedOrigin, resolveRequestOrigin } from '../shared/csrf';
import { AccessTokenPayload, verifyAccessToken } from '../shared/jwt';

/**
 * Pure (Fastify-free) WebSocket handshake logic: token transport extraction,
 * JWT verification, and the CSWSH Origin decision (ADR-026 / ADR-027 / R1-R4).
 *
 * Keeping these as plain functions over primitive inputs means `ws.routes.ts`
 * stays a thin transport adapter and every security branch here is unit-testable
 * without booting a socket.
 */

/** Subprotocol prefix carrying the access token (ADR-026, preferred transport). */
const SUBPROTOCOL_PREFIX = 'access_token.';

/** Why a handshake was rejected (drives the audit reason; never sent to the client). */
export type HandshakeRejection = 'origin' | 'auth';

/** Result of {@link authenticateHandshake}. */
export type HandshakeResult =
  | { ok: true; payload: AccessTokenPayload; subprotocol?: string }
  | { ok: false; reason: HandshakeRejection };

/**
 * Extract the access token from the handshake. The `Sec-WebSocket-Protocol`
 * subprotocol (`access_token.<jwt>`) is PREFERRED (ADR-026 — never appears in
 * the request URL); a `?token=` query param is the browser/tooling fallback.
 *
 * @param subprotocolHeader The raw `sec-websocket-protocol` header (may list several).
 * @param queryToken The `token` query-param value (already parsed by Fastify).
 * @returns The token and (when the subprotocol path is used) the exact
 *   subprotocol value to echo back per RFC 6455; both undefined if absent.
 */
export function extractToken(
  subprotocolHeader: string | undefined,
  queryToken: string | undefined,
): { token?: string; subprotocol?: string } {
  if (subprotocolHeader) {
    const offered = subprotocolHeader.split(',').map((s) => s.trim());
    const match = offered.find((p) => p.startsWith(SUBPROTOCOL_PREFIX));
    if (match) {
      return { token: match.slice(SUBPROTOCOL_PREFIX.length), subprotocol: match };
    }
  }
  if (queryToken && queryToken.length > 0) {
    return { token: queryToken };
  }
  return {};
}

/**
 * Decide whether to accept the connection's Origin (CSWSH defense, ADR-027 /
 * R3). DEVIATION from the HTTP guard: in production an empty allowlist or a
 * missing/unlisted Origin FAILS CLOSED. In non-production an empty allowlist
 * skips the check (dev convenience, matching the HTTP behavior).
 *
 * @param origin The raw Origin header value.
 * @param referer The raw Referer header (fallback source).
 * @returns True iff the upgrade may proceed on Origin grounds.
 */
export function isOriginAllowed(
  origin: string | undefined,
  referer: string | undefined,
): boolean {
  if (config.CORS_ORIGINS.length === 0) {
    // Empty allowlist: skip in dev, but fail closed in production (the WS-only
    // CSWSH deviation from csrfOriginGuard's skip-on-empty).
    return !config.isProduction;
  }
  return isAllowedOrigin(resolveRequestOrigin(origin, referer));
}

/**
 * Run the full handshake decision: Origin check first (R3), then JWT verify via
 * the reused `verifyAccessToken` (R1/R2 — HS256 pinned, `alg:none`/expired
 * already rejected; no second verify path). Fail closed on any error.
 *
 * @param input The relevant handshake inputs (Fastify-free).
 * @returns A discriminated result the route maps to register-or-close.
 */
export function authenticateHandshake(input: {
  origin: string | undefined;
  referer: string | undefined;
  subprotocolHeader: string | undefined;
  queryToken: string | undefined;
}): HandshakeResult {
  if (!isOriginAllowed(input.origin, input.referer)) {
    return { ok: false, reason: 'origin' };
  }
  const { token, subprotocol } = extractToken(input.subprotocolHeader, input.queryToken);
  if (!token) {
    return { ok: false, reason: 'auth' };
  }
  try {
    const payload = verifyAccessToken(token);
    return { ok: true, payload, subprotocol };
  } catch {
    // verifyAccessToken throws AuthError; for a WS handshake we never send an
    // HTTP body — the route closes with 1008 (R2). Reason stays generic (R19).
    return { ok: false, reason: 'auth' };
  }
}

/**
 * Milliseconds remaining until the token expires (R18). The route schedules a
 * close at this delay so a live socket never outlives its access token. Floored
 * at 0 so an already-expired token closes immediately.
 *
 * @param payload The verified access-token payload.
 * @param nowMs Current time in ms (injectable for tests; defaults to Date.now).
 * @returns Non-negative milliseconds until `exp`.
 */
export function msUntilExpiry(payload: AccessTokenPayload, nowMs: number = Date.now()): number {
  return Math.max(0, payload.exp * 1000 - nowMs);
}
