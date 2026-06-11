import { ShortUrl } from '@prisma/client';
import { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { AdminService } from '../admin/admin.service';
import { audit, AUDIT_ACTION } from '../shared/audit';
import { AuditSink, NOOP_AUDIT_SINK } from '../shared/audit-sink';
import { authGuard, requireAuth } from '../shared/auth-context';
import { HTTP_STATUS, ValidationError } from '../shared/errors';
import { ok } from '../shared/http';
import { requestContext } from '../shared/request-context';
import { parseOrThrow } from '../shared/validate';
import { codeParamSchema, shortenSchema } from './urls.schemas';
import { QuotaExceededError, ShortenOutcome, UrlsService } from './urls.service';

/** Dependencies injected into the PUBLIC redirect plugin (no admin surface). */
export interface PublicUrlsRoutesDeps {
  urlsService: UrlsService;
}

/** Dependencies injected into the authenticated urls route plugin. */
export interface UrlsRoutesDeps extends PublicUrlsRoutesDeps {
  /** Admin service — used to persist a screening FLAG as a PENDING row (R25). */
  adminService: AdminService;
  /**
   * Durable audit sink (ADR-049). Optional with a NOOP default so existing
   * tests that do not inject it run unaffected (558 tests stay green).
   */
  auditSink?: AuditSink;
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

/** Generic client message for a screened-out URL (R18/R23 — no rule leakage). */
const BLOCKED_MESSAGE = 'This URL is not allowed.';

/**
 * Resolve a screened shorten outcome into the HTTP response (R18/R23/R25):
 *  - ALLOW: 201 with the created short URL; audit URL_SHORTEN.
 *  - FLAG:  persist a PENDING flagged row (no live link), audit URL_FLAGGED, and
 *           return a generic 202-style "accepted for review" envelope.
 *  - BLOCK: persist nothing, audit URL_BLOCKED, and reject with a generic 422.
 * The specific matched rule + score live in the AUDIT log only, never the client.
 *
 * @param request The Fastify request (for the request-scoped audit logger).
 * @param reply The Fastify reply.
 * @param adminService Used to persist a FLAG as a PENDING row.
 * @param userId The authenticated submitter.
 * @param outcome The discriminated screening outcome from the service.
 * @returns The Fastify reply.
 * @throws ValidationError (422) for a BLOCK verdict.
 */
async function handleShortenOutcome(
  request: FastifyRequest,
  reply: FastifyReply,
  adminService: AdminService,
  auditSink: AuditSink,
  userId: string,
  outcome: ShortenOutcome,
): Promise<FastifyReply> {
  const ctx = requestContext(request);
  if (outcome.decision === 'ALLOW') {
    audit(request.log, AUDIT_ACTION.URL_SHORTEN, {
      actorId: userId,
      resourceId: outcome.url.code,
      outcome: 'success',
    });
    auditSink.record(AUDIT_ACTION.URL_SHORTEN, ctx, {
      actorId: userId,
      resourceId: outcome.url.code,
      targetType: 'url',
      outcome: 'success',
    });
    return reply.status(HTTP_STATUS.CREATED).send(ok(toShortenResponse(outcome.url)));
  }

  if (outcome.decision === 'FLAG') {
    const flagged = await adminService.recordFlag(
      userId,
      outcome.safeUrl,
      outcome.screen.score,
      outcome.screen.reason,
    );
    audit(request.log, AUDIT_ACTION.URL_FLAGGED, {
      actorId: userId,
      resourceId: flagged.id,
      outcome: 'success',
    });
    auditSink.record(AUDIT_ACTION.URL_FLAGGED, ctx, {
      actorId: userId,
      resourceId: flagged.id,
      targetType: 'url',
      outcome: 'success',
    });
    return reply.status(HTTP_STATUS.ACCEPTED).send(
      ok({ status: 'pending_review', message: 'This URL has been submitted for review.' }),
    );
  }

  // BLOCK: nothing persisted; audit the rejection with the server-only reason.
  audit(request.log, AUDIT_ACTION.URL_BLOCKED, { actorId: userId, outcome: 'failure' });
  auditSink.record(AUDIT_ACTION.URL_BLOCKED, ctx, {
    actorId: userId,
    targetType: 'url',
    outcome: 'failure',
  });
  throw new ValidationError(BLOCKED_MESSAGE, [{ path: 'url', message: 'blocked' }]);
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
export const publicUrlsRoutes: FastifyPluginAsync<PublicUrlsRoutesDeps> = async (
  app: FastifyInstance,
  deps: PublicUrlsRoutesDeps,
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
  const { urlsService, adminService, auditSink = NOOP_AUDIT_SINK } = deps;
  app.addHook('preHandler', authGuard);

  app.post(
    '/shorten',
    { config: { rateLimit: { max: SHORTEN_RATE_MAX, timeWindow: SHORTEN_RATE_WINDOW } } },
    async (request, reply) => {
      const { userId } = requireAuth(request);
      const input = parseOrThrow(shortenSchema, request.body);
      let outcome: ShortenOutcome;
      try {
        outcome = await urlsService.shorten(userId, input.url);
      } catch (error) {
        if (error instanceof QuotaExceededError) {
          audit(request.log, AUDIT_ACTION.QUOTA_EXCEEDED, { actorId: userId, outcome: 'failure' });
          auditSink.record(AUDIT_ACTION.QUOTA_EXCEEDED, requestContext(request), {
            actorId: userId,
            targetType: 'url',
            outcome: 'failure',
          });
        }
        throw error;
      }
      return handleShortenOutcome(request, reply, adminService, auditSink, userId, outcome);
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
    auditSink.record(AUDIT_ACTION.URL_DELETE, requestContext(request), {
      actorId: userId,
      resourceId: code,
      targetType: 'url',
      outcome: 'success',
    });
    return reply.status(HTTP_STATUS.NO_CONTENT).send();
  });
};
