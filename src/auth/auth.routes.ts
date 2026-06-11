import { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { audit, AUDIT_ACTION, AuditAction } from '../shared/audit';
import { AuditSink, NOOP_AUDIT_SINK, RequestContext } from '../shared/audit-sink';
import { requestContext } from '../shared/request-context';
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
import { AuthService, AuthResult, GoogleLoginKind, GoogleLoginResult } from './auth.service';
import { AuthResponse, loginSchema, registerSchema } from './auth.schemas';
import { TokenReuseError } from './token-reuse.error';
import { GoogleOAuthClient } from './google-oauth.client';
import {
  newOAuthTx,
  oauthTxCookieOptions,
  openOAuthTx,
  OAUTH_TX_COOKIE_NAME,
  OAUTH_TX_COOKIE_PATH,
  sealOAuthTx,
  statesMatch,
} from './oauth-tx';

/** Dependencies injected into the auth routes plugin. */
export interface AuthRoutesDeps {
  authService: AuthService;
  /** Transport-only Google OAuth2 client (ADR-038). */
  googleOAuthClient: GoogleOAuthClient;
  /**
   * Durable audit sink (ADR-049). Optional with a NOOP default so existing
   * tests that do not inject it run unaffected (558 tests stay green).
   */
  auditSink?: AuditSink;
}

/**
 * Build the audit provenance for an auth event whose actor is freshly resolved
 * by the service (login/register/refresh/oauth) — there is no prior
 * `authContext` on these public routes, so the verified actor id comes from the
 * auth RESULT (server-derived, never a body field — security S2). ip/userAgent
 * still come from the request.
 *
 * @param request The incoming request.
 * @param actorId The server-resolved actor id, or null for a failed attempt.
 * @returns The provenance context for the durable sink.
 */
function authContextFor(request: FastifyRequest, actorId: string | null): RequestContext {
  return { ...requestContext(request), actorId };
}

/** Per-IP rate limit for the OAuth start/callback endpoints (reuse ADR-014 shape). */
const OAUTH_RATE_LIMIT = { max: 20, timeWindow: '15 minutes' } as const;

/**
 * Google's callback query (G11/G12: identity is NEVER read from these params —
 * only `code` + `state` are used; everything else is ignored). `error` is set
 * when the user denies consent or Google rejects the request.
 */
const googleCallbackQuerySchema = z
  .object({
    code: z.string().min(1).optional(),
    state: z.string().min(1).optional(),
    error: z.string().min(1).optional(),
  })
  .passthrough();

/** Audit action per create-or-link branch (G24). */
const OAUTH_KIND_AUDIT: Record<GoogleLoginKind, AuditAction> = {
  login: AUDIT_ACTION.OAUTH_CALLBACK,
  link: AUDIT_ACTION.OAUTH_LINK,
  create: AUDIT_ACTION.OAUTH_CREATE,
};

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
  const { authService, googleOAuthClient, auditSink = NOOP_AUDIT_SINK } = deps;

  app.post(
    '/auth/register',
    { config: { rateLimit: CREDENTIAL_RATE_LIMIT } },
    async (request, reply) => {
      const input = parseOrThrow(registerSchema, request.body);
      const result = await authService.register(input);
      audit(request.log, AUDIT_ACTION.REGISTER, { actorId: result.user.id, outcome: 'success' });
      auditSink.record(AUDIT_ACTION.REGISTER, authContextFor(request, result.user.id), {
        actorId: result.user.id,
        resourceId: result.user.id,
        targetType: 'user',
        outcome: 'success',
      });
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
      auditSink.record(AUDIT_ACTION.LOGIN, authContextFor(request, result.user.id), {
        actorId: result.user.id,
        resourceId: result.user.id,
        targetType: 'user',
        outcome: 'success',
      });
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
          auditSink.record(
            AUDIT_ACTION.TOKEN_REUSE_DETECTED,
            authContextFor(request, err.reuseUserId),
            {
              actorId: err.reuseUserId,
              family: err.reuseFamily,
              jti: err.reuseJti,
              outcome: 'failure',
            },
          );
        }
        throw err;
      }
      audit(request.log, AUDIT_ACTION.TOKEN_REFRESH, {
        actorId: result.user.id,
        outcome: 'success',
      });
      auditSink.record(AUDIT_ACTION.TOKEN_REFRESH, authContextFor(request, result.user.id), {
        actorId: result.user.id,
        resourceId: result.user.id,
        targetType: 'user',
        outcome: 'success',
      });
      return sendSession(reply, result, HTTP_STATUS.OK);
    },
  );

  app.post('/auth/logout', { preHandler: csrfOriginGuard }, async (request, reply) => {
    const raw = readRefreshCookie(request);
    const actorId = await authService.logout(raw);
    audit(request.log, AUDIT_ACTION.LOGOUT, { actorId, outcome: 'success' });
    auditSink.record(AUDIT_ACTION.LOGOUT, authContextFor(request, actorId), {
      actorId,
      resourceId: actorId ?? undefined,
      targetType: 'user',
      outcome: 'success',
    });
    reply.clearCookie(REFRESH_COOKIE_NAME, { path: REFRESH_COOKIE_PATH });
    return reply.send(ok({ loggedOut: true }));
  });

  // GET /auth/google — begin "Sign in with Google" (ADR-037, G3/G8–G11).
  // Generate a fresh single-use state + PKCE verifier, seal them in the signed
  // HttpOnly SameSite=Lax oauth_tx cookie, and 302-redirect to Google's
  // authorization URL (PKCE S256). No identity is asserted yet (G12).
  // INTENTIONALLY PUBLIC: this is an unauthenticated login entry point, like
  // /auth/login. No CSRF Origin guard: it is a top-level GET that mutates no
  // server state (the cookie is the only effect and is itself the CSRF token).
  app.get('/auth/google', { config: { rateLimit: OAUTH_RATE_LIMIT } }, async (request, reply) => {
    const tx = newOAuthTx();
    reply.setCookie(OAUTH_TX_COOKIE_NAME, sealOAuthTx(tx), oauthTxCookieOptions());
    const url = googleOAuthClient.buildAuthorizationUrl({
      codeVerifier: tx.verifier,
      state: tx.state,
    });
    audit(request.log, AUDIT_ACTION.OAUTH_START, { actorId: null, outcome: 'success' });
    auditSink.record(AUDIT_ACTION.OAUTH_START, authContextFor(request, null), {
      actorId: null,
      outcome: 'success',
    });
    return reply.redirect(url, HTTP_STATUS.FOUND);
  });

  // GET /auth/google/callback — handle Google's redirect (ADR-036/037/039/040).
  // Validate state from the signed cookie (single-use, constant-time), exchange
  // the code (PKCE) for the back-channel-verified identity, run the create-or-
  // link ladder, and issue the SAME session as /auth/login (G22). The oauth_tx
  // cookie is ALWAYS cleared (success and failure) → single-use (G10). No
  // attacker-controlled redirect is honored (G20): the session is issued in
  // place (refresh cookie + access token in the JSON body), like /auth/login.
  app.get(
    '/auth/google/callback',
    { config: { rateLimit: OAUTH_RATE_LIMIT } },
    async (request, reply) => {
      // Single-use: clear the transient cookie up front, before anything can
      // throw, so a replay after this request finds no cookie (G10).
      const txCookie = request.cookies[OAUTH_TX_COOKIE_NAME];
      reply.clearCookie(OAUTH_TX_COOKIE_NAME, { path: OAUTH_TX_COOKIE_PATH });

      const query = parseOrThrow(googleCallbackQuerySchema, request.query);
      const tx = openOAuthTx(txCookie);

      // G11: reject on absent/forged cookie, missing/mismatched state, or a
      // Google-reported error — all map to the same generic rejection (no
      // enumeration), audited as OAUTH_STATE_REJECTED.
      if (!tx || query.error || !query.state || !query.code || !statesMatch(tx.state, query.state)) {
        audit(request.log, AUDIT_ACTION.OAUTH_STATE_REJECTED, {
          actorId: null,
          outcome: 'failure',
        });
        auditSink.record(AUDIT_ACTION.OAUTH_STATE_REJECTED, authContextFor(request, null), {
          actorId: null,
          outcome: 'failure',
        });
        throw new AuthError('OAuth login failed');
      }

      // Back-channel exchange (G12–G15) — identity ONLY from this server-side call.
      const identity = await googleOAuthClient.exchangeCodeForIdentity(query.code, tx.verifier);

      let result: GoogleLoginResult;
      try {
        result = await authService.loginWithGoogle(identity);
      } catch (err) {
        // G4: an unverified-email rejection is the takeover-defense event —
        // audit it distinctly before the generic error reaches the client.
        if (err instanceof AuthError) {
          audit(request.log, AUDIT_ACTION.OAUTH_LINK_DENIED, {
            actorId: null,
            outcome: 'failure',
          });
          auditSink.record(AUDIT_ACTION.OAUTH_LINK_DENIED, authContextFor(request, null), {
            actorId: null,
            outcome: 'failure',
          });
        }
        throw err;
      }

      const kindAction = OAUTH_KIND_AUDIT[result.kind];
      audit(request.log, kindAction, {
        actorId: result.user.id,
        outcome: 'success',
      });
      auditSink.record(kindAction, authContextFor(request, result.user.id), {
        actorId: result.user.id,
        resourceId: result.user.id,
        targetType: 'user',
        outcome: 'success',
      });
      return sendSession(reply, result, HTTP_STATUS.OK);
    },
  );
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
