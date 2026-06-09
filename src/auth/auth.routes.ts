import { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { audit, AUDIT_ACTION } from '../shared/audit';
import {
  csrfOriginGuard,
  REFRESH_COOKIE_NAME,
  REFRESH_COOKIE_PATH,
  refreshCookieOptions,
} from '../shared/csrf';
import { AuthError } from '../shared/errors';
import { HTTP_STATUS } from '../shared/errors';
import { ok } from '../shared/http';
import { parseOrThrow } from '../shared/validate';
import { AuthService, AuthResult } from './auth.service';
import { AuthResponse, loginSchema, registerSchema } from './auth.schemas';
import { TokenReuseError } from './token-reuse.error';

/** Dependencies injected into the auth routes plugin. */
export interface AuthRoutesDeps {
  authService: AuthService;
}

/** Refresh cookie lifetime in seconds (7 days; matches REFRESH_TOKEN_TTL). */
const REFRESH_COOKIE_MAX_AGE = 7 * 24 * 60 * 60;

/** Per-IP rate limit for credential endpoints: 5 requests / 15 min (H4). */
const CREDENTIAL_RATE_LIMIT = { max: 5, timeWindow: '15 minutes' } as const;
/** Per-IP rate limit for the refresh endpoint: 30 / 15 min (ADR-014). */
const REFRESH_RATE_LIMIT = { max: 30, timeWindow: '15 minutes' } as const;

/**
 * Auth route plugin: register, login, refresh, logout.
 *
 * @param app The Fastify instance.
 * @param deps Injected dependencies (auth service).
 * @returns A promise that resolves once routes are registered.
 */
export const authRoutes: FastifyPluginAsync<AuthRoutesDeps> = async (
  app: FastifyInstance,
  deps: AuthRoutesDeps,
): Promise<void> => {
  const { authService } = deps;

  app.post(
    '/auth/register',
    { config: { rateLimit: CREDENTIAL_RATE_LIMIT } },
    async (request, reply) => {
      const input = parseOrThrow(registerSchema, request.body);
      const result = await authService.register(input);
      audit(request.log, AUDIT_ACTION.REGISTER, { actorId: result.user.id, outcome: 'success' });
      return sendSession(reply, result, HTTP_STATUS.CREATED);
    },
  );

  app.post(
    '/auth/login',
    { config: { rateLimit: CREDENTIAL_RATE_LIMIT } },
    async (request, reply) => {
      const input = parseOrThrow(loginSchema, request.body);
      const result = await authService.login(input);
      audit(request.log, AUDIT_ACTION.LOGIN, { actorId: result.user.id, outcome: 'success' });
      return sendSession(reply, result, HTTP_STATUS.OK);
    },
  );

  app.post(
    '/auth/refresh',
    { config: { rateLimit: REFRESH_RATE_LIMIT }, preHandler: csrfOriginGuard },
    async (request, reply) => {
      const raw = readRefreshCookie(request);
      if (!raw) {
        throw new AuthError('Missing refresh token');
      }
      let result: AuthResult;
      try {
        result = await authService.refresh(raw);
      } catch (err) {
        // Reuse of a consumed token is the top-signal security event (ADR-012):
        // audit it here (route owns the logger) before re-throwing the generic
        // 401 the service raised. The family was already revoked in the service.
        if (err instanceof TokenReuseError) {
          audit(request.log, AUDIT_ACTION.TOKEN_REUSE_DETECTED, {
            actorId: err.reuseUserId,
            family: err.reuseFamily,
            jti: err.reuseJti,
            outcome: 'failure',
          });
        }
        throw err;
      }
      audit(request.log, AUDIT_ACTION.TOKEN_REFRESH, {
        actorId: result.user.id,
        outcome: 'success',
      });
      return sendSession(reply, result, HTTP_STATUS.OK);
    },
  );

  app.post('/auth/logout', { preHandler: csrfOriginGuard }, async (request, reply) => {
    const raw = readRefreshCookie(request);
    const actorId = await authService.logout(raw);
    audit(request.log, AUDIT_ACTION.LOGOUT, { actorId, outcome: 'success' });
    reply.clearCookie(REFRESH_COOKIE_NAME, { path: REFRESH_COOKIE_PATH });
    return reply.send(ok({ loggedOut: true }));
  });
};

/**
 * Read the raw refresh token from the HttpOnly cookie.
 *
 * @param request The incoming request.
 * @returns The raw token, or undefined if the cookie is absent.
 */
function readRefreshCookie(request: FastifyRequest): string | undefined {
  return request.cookies[REFRESH_COOKIE_NAME];
}

/**
 * Set the refresh cookie and return the access token + user in the body.
 *
 * @param reply The Fastify reply.
 * @param result The auth result (tokens + user).
 * @param status HTTP status code to respond with.
 * @returns The Fastify reply.
 */
function sendSession(reply: FastifyReply, result: AuthResult, status: number): FastifyReply {
  reply.setCookie(
    REFRESH_COOKIE_NAME,
    result.refreshToken,
    refreshCookieOptions(REFRESH_COOKIE_MAX_AGE),
  );
  const body: AuthResponse = {
    accessToken: result.accessToken,
    user: { id: result.user.id, email: result.user.email, name: result.user.name },
  };
  return reply.status(status).send(ok(body));
}
