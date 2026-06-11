import { BlockedDomain, FlaggedUrl, UserRole } from '@prisma/client';
import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { audit, AUDIT_ACTION } from '../shared/audit';
import { authGuard, requireAuth, requireRole } from '../shared/auth-context';
import { HTTP_STATUS, NotFoundError } from '../shared/errors';
import { ok } from '../shared/http';
import { parseOrThrow } from '../shared/validate';
import { AdminService } from './admin.service';
import {
  addBlocklistSchema,
  blocklistDomainParamSchema,
  flaggedIdParamSchema,
} from './admin.schemas';

/** Dependencies injected into the admin route plugin. */
export interface AdminRoutesDeps {
  adminService: AdminService;
}

/** Per-route admin rate limit: 60 requests/minute/IP (R13; reuses the pattern). */
const ADMIN_RATE_MAX = 60;
/** Window for the admin rate limit. */
const ADMIN_RATE_WINDOW = '1 minute';
/** Per-route rate-limit config reused across the admin mutations. */
const ADMIN_RATE_LIMIT = { config: { rateLimit: { max: ADMIN_RATE_MAX, timeWindow: ADMIN_RATE_WINDOW } } };

/** Wire DTO for a blocklist entry (internal ids/attribution not exposed). */
interface BlockedDomainResponse {
  domain: string;
  note: string | null;
  createdAt: string;
}

/** Wire DTO for a flagged URL in the moderation queue. */
interface FlaggedUrlResponse {
  id: string;
  candidateUrl: string;
  confidenceScore: number;
  flaggedReason: string;
  state: string;
  createdAt: string;
}

/**
 * Map a blocklist entry to its wire DTO.
 *
 * @param entry The blocklist row.
 * @returns The serializable response.
 */
function toBlockedDomainResponse(entry: BlockedDomain): BlockedDomainResponse {
  return { domain: entry.domain, note: entry.note, createdAt: entry.createdAt.toISOString() };
}

/**
 * Map a flagged URL to its wire DTO. `ownerId`/`reviewedByUserId` are internal
 * and intentionally not exposed; `id` is the UUID an admin acts on.
 *
 * @param flagged The flagged row.
 * @returns The serializable response.
 */
function toFlaggedUrlResponse(flagged: FlaggedUrl): FlaggedUrlResponse {
  return {
    id: flagged.id,
    candidateUrl: flagged.candidateUrl,
    confidenceScore: flagged.confidenceScore,
    flaggedReason: flagged.flaggedReason,
    state: flagged.state,
    createdAt: flagged.createdAt.toISOString(),
  };
}

/**
 * ADMIN route plugin — blocklist curation + flagged-URL moderation (ADR-031/032).
 *
 * Default-deny (R8): a plugin-wide `authGuard` + `requireRole('admin')`
 * preHandler runs on EVERY route, so no admin endpoint is reachable without an
 * admin token (non-admin → 403, ADR-033). Handlers are thin: validate → call the
 * service → audit the mutation (R14) → format. Every mutation is audited with
 * the acting admin id + target; specific match reasons stay server-side (R18/R23).
 *
 * @param app The Fastify instance.
 * @param deps Injected dependencies (admin service).
 * @returns A promise that resolves once routes are registered.
 */
export const adminRoutes: FastifyPluginAsync<AdminRoutesDeps> = async (
  app: FastifyInstance,
  deps: AdminRoutesDeps,
): Promise<void> => {
  const { adminService } = deps;
  // Plugin-wide guards: authenticate, then require the ADMIN role (R7/R8).
  app.addHook('preHandler', authGuard);
  app.addHook('preHandler', requireRole(UserRole.ADMIN));

  app.get('/admin/blocklist', ADMIN_RATE_LIMIT, async (_request, reply) => {
    const entries = await adminService.listBlocklist();
    return reply.send(ok(entries.map(toBlockedDomainResponse)));
  });

  app.post('/admin/blocklist', ADMIN_RATE_LIMIT, async (request, reply) => {
    const { userId } = requireAuth(request);
    const input = parseOrThrow(addBlocklistSchema, request.body);
    const entry = await adminService.addToBlocklist(userId, input.domain, input.note);
    audit(request.log, AUDIT_ACTION.BLOCKLIST_ADD, {
      actorId: userId,
      resourceId: entry.domain,
      outcome: 'success',
    });
    return reply.status(HTTP_STATUS.CREATED).send(ok(toBlockedDomainResponse(entry)));
  });

  app.delete('/admin/blocklist/:domain', ADMIN_RATE_LIMIT, async (request, reply) => {
    const { userId } = requireAuth(request);
    const { domain } = parseOrThrow(blocklistDomainParamSchema, request.params);
    const { removed } = await adminService.removeFromBlocklist(domain);
    if (!removed) {
      throw new NotFoundError('Blocklist entry');
    }
    audit(request.log, AUDIT_ACTION.BLOCKLIST_REMOVE, {
      actorId: userId,
      resourceId: domain,
      outcome: 'success',
    });
    return reply.status(HTTP_STATUS.NO_CONTENT).send();
  });

  app.get('/admin/flagged', ADMIN_RATE_LIMIT, async (_request, reply) => {
    const flagged = await adminService.listFlagged();
    return reply.send(ok(flagged.map(toFlaggedUrlResponse)));
  });

  app.post('/admin/flagged/:id/approve', ADMIN_RATE_LIMIT, async (request, reply) => {
    const { userId } = requireAuth(request);
    const { id } = parseOrThrow(flaggedIdParamSchema, request.params);
    const { code } = await adminService.approveFlagged(userId, id);
    audit(request.log, AUDIT_ACTION.FLAG_APPROVE, { actorId: userId, resourceId: id, outcome: 'success' });
    return reply.send(ok({ code }));
  });

  app.post('/admin/flagged/:id/reject', ADMIN_RATE_LIMIT, async (request, reply) => {
    const { userId } = requireAuth(request);
    const { id } = parseOrThrow(flaggedIdParamSchema, request.params);
    await adminService.rejectFlagged(userId, id);
    audit(request.log, AUDIT_ACTION.FLAG_REJECT, { actorId: userId, resourceId: id, outcome: 'success' });
    return reply.status(HTTP_STATUS.NO_CONTENT).send();
  });
};
