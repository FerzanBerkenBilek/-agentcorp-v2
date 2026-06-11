import { UserRole } from '@prisma/client';
import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { authGuard, requireRole } from '../shared/auth-context';
import { ok } from '../shared/http';
import { parseOrThrow } from '../shared/validate';
import { AuditService } from './audit.service';
import { auditQuerySchema } from './audit.schemas';

/** Dependencies injected into the audit route plugin. */
export interface AuditRoutesDeps {
  auditService: AuditService;
}

/**
 * AUDIT route plugin — the admin-only audit-log read API (ADR-049 / security
 * S1). Default-deny: a plugin-wide `authGuard` + `requireRole(ADMIN)` preHandler
 * runs on every route, so a non-admin is rejected with 403 (ADR-033) and the
 * org-wide forensic trail is never exposed to a regular user. `actor_id` is an
 * admin FILTER, not an ownership scope — there is NO per-user self-service read
 * branch, so no object-level IDOR question arises (one capability gate, no
 * per-row owner secret).
 *
 * @param app The Fastify instance.
 * @param deps Injected dependencies (audit service).
 * @returns A promise that resolves once routes are registered.
 */
export const auditRoutes: FastifyPluginAsync<AuditRoutesDeps> = async (
  app: FastifyInstance,
  deps: AuditRoutesDeps,
): Promise<void> => {
  const { auditService } = deps;
  // Plugin-wide guards: authenticate, then require the ADMIN role (S1).
  app.addHook('preHandler', authGuard);
  app.addHook('preHandler', requireRole(UserRole.ADMIN));

  app.get('/audit-logs', async (request, reply) => {
    const query = parseOrThrow(auditQuerySchema, request.query);
    const page = await auditService.query(query);
    return reply.send(ok(page));
  });
};
