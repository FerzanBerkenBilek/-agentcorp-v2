import fastifyCookie from '@fastify/cookie';
import fastifyCors from '@fastify/cors';
import fastifyHelmet from '@fastify/helmet';
import fastifyRateLimit from '@fastify/rate-limit';
import Fastify, { FastifyInstance } from 'fastify';
import { authRoutes } from './auth/auth.routes';
import { AuthRepository } from './auth/auth.repository';
import { AuthService } from './auth/auth.service';
import { BODY_LIMIT_BYTES, config } from './config';
import { errorHandler } from './shared/error-handler';
import { AppError, ERROR_CODE, HTTP_STATUS } from './shared/errors';
import { buildLoggerOptions } from './shared/logger';
import { prisma } from './shared/prisma';
import { ok } from './shared/http';
import { APP_VERSION } from './shared/version';
import { tasksRoutes } from './tasks/tasks.routes';
import { TasksRepository } from './tasks/tasks.repository';
import { TasksService } from './tasks/tasks.service';
import { usersRoutes } from './users/users.routes';
import { UsersRepository } from './users/users.repository';
import { publicUrlsRoutes, urlsRoutes } from './urls/urls.routes';
import { UrlsRepository } from './urls/urls.repository';
import { UrlsService } from './urls/urls.service';
import { ConnectionHub } from './ws/connection-hub';
import { wsRoutes } from './ws/ws.routes';

/** Default authenticated rate limit: 100 requests/min per IP (ADR-014). */
const GLOBAL_RATE_LIMIT_MAX = 100;
/** Global rate-limit window. */
const GLOBAL_RATE_LIMIT_WINDOW = '1 minute';

/**
 * Build and configure the Fastify application (composition root).
 *
 * Registers security plugins (helmet, CORS allowlist, cookie, rate-limit), the
 * global error handler, wires dependencies top-down (repos -> services ->
 * routes), and mounts the three feature modules. Returns the instance without
 * starting to listen, so tests can use `app.inject`.
 *
 * @returns The configured Fastify instance (not yet listening).
 */
export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: buildLoggerOptions(),
    bodyLimit: BODY_LIMIT_BYTES,
    trustProxy: config.isProduction,
  });

  await registerPlugins(app);
  app.setErrorHandler(errorHandler);
  registerModules(app);

  // Public, unauthenticated liveness probe (registered before the auth guard).
  // Reports status, current server time, and the version from package.json,
  // wrapped in the shared success envelope ({ success, data }) like every
  // other endpoint, so the three contract fields live under `data`.
  app.get('/health', async (_request, reply) =>
    reply.send(
      ok({
        status: 'ok',
        timestamp: new Date().toISOString(),
        version: APP_VERSION,
      }),
    ),
  );

  return app;
}

/**
 * Register cross-cutting security plugins.
 *
 * @param app The Fastify instance.
 * @returns A promise that resolves once plugins are registered.
 */
async function registerPlugins(app: FastifyInstance): Promise<void> {
  // M8: secure default headers.
  await app.register(fastifyHelmet);

  // M6/M8: strict origin allowlist; credentials allowed only for listed origins.
  await app.register(fastifyCors, {
    origin: config.CORS_ORIGINS.length > 0 ? config.CORS_ORIGINS : false,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
  });

  // Parses the HttpOnly refresh cookie (H2/M6).
  await app.register(fastifyCookie);

  // H4/ADR-014: global default limit; per-route overrides set in route configs.
  await app.register(fastifyRateLimit, {
    global: true,
    max: GLOBAL_RATE_LIMIT_MAX,
    timeWindow: GLOBAL_RATE_LIMIT_WINDOW,
    // @fastify/rate-limit v9 THROWS the return value of errorResponseBuilder
    // as-is (index.js: `throw params.errorResponseBuilder(...)`). A plain object
    // has no statusCode, so the global error handler would treat it as an
    // unexpected 500. Returning an AppError(RATE_LIMIT, 429) makes the thrown
    // value flow through the AppError branch of error-handler.ts and produce a
    // correct 429 with the uniform envelope. (QA fix — see Test Summary.)
    errorResponseBuilder: () =>
      new AppError(
        ERROR_CODE.RATE_LIMIT,
        'Too many requests. Please try again later.',
        HTTP_STATUS.TOO_MANY_REQUESTS,
      ),
  });
}

/**
 * Wire dependencies and register the feature modules (DI composition).
 *
 * @param app The Fastify instance.
 * @returns void
 */
function registerModules(app: FastifyInstance): void {
  const usersRepository = new UsersRepository(prisma);
  const authRepository = new AuthRepository(prisma);
  const tasksRepository = new TasksRepository(prisma);
  const urlsRepository = new UrlsRepository(prisma);

  // ADR-025: one plain-singleton hub, injected as the task event publisher AND
  // registered as the WS plugin's connection registry (the same instance).
  const connectionHub = new ConnectionHub();

  const authService = new AuthService(usersRepository, authRepository);
  const tasksService = new TasksService(tasksRepository, usersRepository, connectionHub);
  const urlsService = new UrlsService(urlsRepository);

  void app.register(authRoutes, { authService });
  void app.register(tasksRoutes, { tasksService });
  void app.register(usersRoutes, { usersRepository });
  // URL shortener: the anonymous redirect (publicUrlsRoutes, NO authGuard) and
  // the authenticated shorten/stats/delete routes (urlsRoutes, behind authGuard).
  void app.register(publicUrlsRoutes, { urlsService });
  void app.register(urlsRoutes, { urlsService });
  // Real-time task updates: the WS upgrade endpoint (its own handshake auth via
  // verifyAccessToken, NOT authGuard) wired to the shared hub (ADR-025).
  void app.register(wsRoutes, { hub: connectionHub });
}
