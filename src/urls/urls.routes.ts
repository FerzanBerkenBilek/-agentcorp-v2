import { ShortUrl } from '@prisma/client';
import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { audit, AUDIT_ACTION } from '../shared/audit';
import { authGuard, requireAuth } from '../shared/auth-context';
import { HTTP_STATUS } from '../shared/errors';
import { ok } from '../shared/http';
import { parseOrThrow } from '../shared/validate';
import { codeParamSchema, shortenSchema } from './urls.schemas';
import { UrlsService } from './urls.service';

/** Dependencies injected into the urls route plugins. */
export interface UrlsRoutesDeps {
  urlsService: UrlsService;
}

/** Per-route rate limit on POST /shorten: 10 requests/minute/IP (M1 / ADR-014). */
const SHORTEN_RATE_MAX = 10;
/** Window for the POST /shorten rate limit. */
const SHORTEN_RATE_WINDOW = '1 minute';
/** HTTP 302 — temporary redirect (ADR-020; NOT 301, which caches permanently). */
const REDIRECT_STATUS = HTTP_STATUS.FOUND;

/** Wire shape returned by POST /shorten (Dates serialized to ISO strings). */
interface ShortenResponse {
  code: string;
  originalUrl: string;
  createdAt: string;
}

/**
 * Map a created ShortUrl to its wire DTO. The internal UUID id, ownerId, and
 * click counters are intentionally not exposed on the create response.
 *
 * @param url The created short URL.
 * @returns The serializable shorten response.
 */
function toShortenResponse(url: ShortUrl): ShortenResponse {
  return {
    code: url.code,
    originalUrl: url.originalUrl,
    createdAt: url.createdAt.toISOString(),
  };
}

/**
 * PUBLIC urls route plugin — the anonymous redirect. Registered with NO
 * authGuard (mirrors the public /health pattern). This is the ONLY shortener
 * route reachable without a token.
 *
 * @param app The Fastify instance.
 * @param deps Injected dependencies (urls service).
 * @returns A promise that resolves once the route is registered.
 */
export const publicUrlsRoutes: FastifyPluginAsync<UrlsRoutesDeps> = async (
  app: FastifyInstance,
  deps: UrlsRoutesDeps,
): Promise<void> => {
  const { urlsService } = deps;

  app.get('/:code', async (request, reply) => {
    const { code } = parseOrThrow(codeParamSchema, request.params);
    const target = await urlsService.resolveAndTrack(code);
    if (target === null) {
      // Generic 404 (no envelope) — does not confirm whether a code ever existed.
      return reply.status(HTTP_STATUS.NOT_FOUND).send();
    }
    // 302 + no-store (ADR-020): keeps takedown/click-tracking effective; a 301
    // would be cached permanently by browsers/proxies and defeat both. Uses the
    // forward-compatible redirect(url, code) signature (Fastify v5-ready).
    return reply.header('cache-control', 'no-store').redirect(target, REDIRECT_STATUS);
  });
};

/**
 * AUTHENTICATED urls route plugin — shorten, stats, delete. Every route here
 * runs behind `authGuard`; handlers only parse input, call the service, audit,
 * and format the response (all logic/authorization live in the service/policy).
 *
 * @param app The Fastify instance.
 * @param deps Injected dependencies (urls service).
 * @returns A promise that resolves once routes are registered.
 */
export const urlsRoutes: FastifyPluginAsync<UrlsRoutesDeps> = async (
  app: FastifyInstance,
  deps: UrlsRoutesDeps,
): Promise<void> => {
  const { urlsService } = deps;
  app.addHook('preHandler', authGuard);

  app.post(
    '/shorten',
    { config: { rateLimit: { max: SHORTEN_RATE_MAX, timeWindow: SHORTEN_RATE_WINDOW } } },
    async (request, reply) => {
      const { userId } = requireAuth(request);
      const input = parseOrThrow(shortenSchema, request.body);
      const url = await urlsService.shorten(userId, input.url);
      audit(request.log, AUDIT_ACTION.URL_SHORTEN, { actorId: userId, resourceId: url.code, outcome: 'success' });
      return reply.status(HTTP_STATUS.CREATED).send(ok(toShortenResponse(url)));
    },
  );

  app.get('/:code/stats', async (request, reply) => {
    const { userId } = requireAuth(request);
    const { code } = parseOrThrow(codeParamSchema, request.params);
    const stats = await urlsService.getStats(userId, code);
    return reply.send(
      ok({
        clickCount: stats.clickCount,
        createdAt: stats.createdAt.toISOString(),
        lastAccessedAt: stats.lastAccessedAt ? stats.lastAccessedAt.toISOString() : null,
      }),
    );
  });

  app.delete('/:code', async (request, reply) => {
    const { userId } = requireAuth(request);
    const { code } = parseOrThrow(codeParamSchema, request.params);
    await urlsService.delete(userId, code);
    audit(request.log, AUDIT_ACTION.URL_DELETE, { actorId: userId, resourceId: code, outcome: 'success' });
    return reply.status(HTTP_STATUS.NO_CONTENT).send();
  });
};
