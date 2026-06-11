import { FastifyReply, FastifyRequest } from 'fastify';
import { UserRole } from '@prisma/client';
import { AuthError, ForbiddenError } from './errors';
import { verifyAccessToken } from './jwt';

/**
 * Authenticated principal attached to a request after the auth guard runs.
 */
export interface AuthContext {
  /** Authenticated user's id (JWT `sub`). */
  userId: string;
  /** Authorization role (ADR-030/033), derived from the signed `role` claim. */
  role: UserRole;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by `authGuard` once a valid access token is verified. */
    authContext?: AuthContext;
  }
}

/** Authorization header scheme prefix. */
const BEARER_PREFIX = 'Bearer ';

/**
 * Fastify preHandler that authenticates a request via a Bearer access token
 * (ADR-010: auth is centralized in the route guard, never duplicated in
 * handlers). On success it decorates `request.authContext`. On failure it
 * throws AuthError (-> 401) via the global error handler.
 *
 * @param request The incoming request.
 * @param _reply Unused (errors flow through the global handler).
 * @returns A promise that resolves once authentication succeeds.
 * @throws AuthError if the header is missing/malformed or the token is invalid/expired.
 */
export async function authGuard(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const header = request.headers.authorization;
  if (!header || !header.startsWith(BEARER_PREFIX)) {
    throw new AuthError('Missing or malformed Authorization header');
  }
  const token = header.slice(BEARER_PREFIX.length).trim();
  const payload = verifyAccessToken(token);
  request.authContext = { userId: payload.sub, role: payload.role };
}

/**
 * Read the authenticated context off a request, asserting it is present.
 * Use in handlers that run behind `authGuard`.
 *
 * @param request The request decorated by `authGuard`.
 * @returns The authenticated context.
 * @throws AuthError if the guard did not run (programming error / unprotected route).
 */
export function requireAuth(request: FastifyRequest): AuthContext {
  if (!request.authContext) {
    throw new AuthError('Authentication required');
  }
  return request.authContext;
}

/**
 * Fastify preHandler factory that authorizes a request by role (ADR-033, R7/R8).
 *
 * Returns a preHandler that runs AFTER `authGuard` (which sets `authContext`)
 * and asserts the authenticated principal holds `required`. Default-deny: a
 * missing context (guard not run) or a non-matching role both fail. Unlike the
 * object-level 404-not-403 posture (ADR-013/021), a role failure throws
 * `ForbiddenError` (403): the admin *capability* is not an enumerable object
 * secret, so an honest 403 leaks nothing and is the correct, debuggable signal
 * for an authenticated non-admin (ADR-033 ruling). Object-level checks (e.g. a
 * missing flagged `:id`) stay 404 in their own service/policy layer.
 *
 * @param required The role the caller must hold (e.g. `UserRole.ADMIN`).
 * @returns A Fastify preHandler enforcing the role.
 */
export function requireRole(required: UserRole) {
  return async function roleGuard(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    const context = requireAuth(request);
    if (context.role !== required) {
      throw new ForbiddenError('Admin role required');
    }
  };
}
