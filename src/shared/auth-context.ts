import { FastifyReply, FastifyRequest } from 'fastify';
import { AuthError } from './errors';
import { verifyAccessToken } from './jwt';

/**
 * Authenticated principal attached to a request after the auth guard runs.
 */
export interface AuthContext {
  /** Authenticated user's id (JWT `sub`). */
  userId: string;
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
  request.authContext = { userId: payload.sub };
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
