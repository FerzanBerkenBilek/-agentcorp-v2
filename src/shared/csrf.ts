import { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config';
import { ForbiddenError } from './errors';

/**
 * CSRF defense for cookie-bearing state-changing endpoints (M6 / ADR-015).
 *
 * The refresh token lives in an HttpOnly+SameSite=Strict cookie. As a second,
 * independent control we verify the request's Origin (or Referer fallback)
 * against the configured allowlist. Browsers cannot spoof these headers from a
 * cross-site context, so a forged cross-site POST is rejected here even if
 * SameSite is somehow not honored by an intermediary.
 */

/** Cookie name carrying the refresh token. */
export const REFRESH_COOKIE_NAME = 'refresh_token';

/** Path the refresh cookie is scoped to (sent only to auth endpoints). */
export const REFRESH_COOKIE_PATH = '/auth';

/**
 * Reject a request whose Origin/Referer is not on the CORS allowlist.
 * Use as a preHandler on /auth/refresh and /auth/logout.
 *
 * When no allowlist is configured (e.g., local dev with same-origin tooling)
 * the check is skipped; production deployments must configure CORS_ORIGINS.
 *
 * @param request The incoming request.
 * @param _reply Unused (errors flow through the global handler).
 * @returns A promise that resolves if the origin is allowed.
 * @throws ForbiddenError if the Origin/Referer is present but not allowlisted.
 */
export async function csrfOriginGuard(
  request: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  if (config.CORS_ORIGINS.length === 0) {
    return;
  }
  const source = resolveRequestOrigin(request.headers.origin, request.headers.referer);
  if (!isAllowedOrigin(source)) {
    throw new ForbiddenError('Cross-origin request rejected');
  }
}

/**
 * Resolve the effective request origin from the Origin header, falling back to
 * the Referer. Shared by the HTTP CSRF guard and the WS CSWSH check (ADR-027) so
 * the origin-derivation logic exists in exactly one place (DRY).
 *
 * @param origin The raw Origin header value (may be undefined).
 * @param referer The raw Referer header value (may be undefined).
 * @returns The derived origin, or undefined if neither is present/parseable.
 */
export function resolveRequestOrigin(
  origin: string | undefined,
  referer: string | undefined,
): string | undefined {
  return origin ?? deriveOrigin(referer);
}

/**
 * True if `origin` is on the configured CORS allowlist. The single allowlist
 * membership test reused by HTTP and WS. An empty allowlist returns `false`
 * here; each caller decides its empty-allowlist policy (HTTP skips, WS in
 * production fails closed — ADR-027).
 *
 * @param origin The derived request origin (or undefined).
 * @returns True iff a non-undefined origin is present and allowlisted.
 */
export function isAllowedOrigin(origin: string | undefined): boolean {
  return origin !== undefined && config.CORS_ORIGINS.includes(origin);
}

/**
 * Extract the scheme://host[:port] origin from a Referer URL.
 *
 * @param referer The raw Referer header value (may be undefined).
 * @returns The origin, or undefined if absent/unparseable.
 */
function deriveOrigin(referer: string | undefined): string | undefined {
  if (!referer) {
    return undefined;
  }
  try {
    return new URL(referer).origin;
  } catch {
    return undefined;
  }
}

/**
 * Build the Set-Cookie options for the refresh token (H2/M6).
 * HttpOnly (no JS access), Secure in prod (HTTPS only), SameSite=Strict,
 * path-scoped to /auth.
 *
 * @param maxAgeSeconds Cookie lifetime in seconds.
 * @returns Fastify cookie serialize options.
 */
export function refreshCookieOptions(maxAgeSeconds: number): {
  httpOnly: true;
  secure: boolean;
  sameSite: 'strict';
  path: string;
  maxAge: number;
} {
  return {
    httpOnly: true,
    secure: config.isProduction,
    sameSite: 'strict',
    path: REFRESH_COOKIE_PATH,
    maxAge: maxAgeSeconds,
  };
}
