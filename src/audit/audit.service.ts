import { AuditLog, AuditTargetType, Prisma } from '@prisma/client';
import { FastifyBaseLogger } from 'fastify';
import { AuditAction, AuditFields } from '../shared/audit';
import { AuditSink, RequestContext } from '../shared/audit-sink';
import { buildPageMeta, Paginated } from '../shared/http';
import { AuditFilter, AuditInsert, AuditRepository } from './audit.repository';
import { AuditLogResponse, AuditQuery } from './audit.schemas';

/**
 * Forbidden metadata keys (ADR-046). The audit service builds `metadata` ONLY
 * from the typed AuditFields allowlist, but this redaction pass is the fail-safe
 * second line of defence: if any of these keys ever appears in the assembled
 * object it is dropped before INSERT, so a careless caller can never persist a
 * secret/PII into the durable, admin-queryable store. Mirrors the logger.ts
 * REDACT_PATHS set, extended with the OAuth/PKCE secrets ADR-046 names.
 */
const FORBIDDEN_METADATA_KEYS: ReadonlySet<string> = new Set([
  'password',
  'passwordHash',
  'refreshToken',
  'accessToken',
  'token',
  'authorization',
  'cookie',
  'code_verifier',
  'codeVerifier',
  'state',
  'sub',
  'googleSub',
  'id_token',
  'idToken',
  'client_secret',
  'clientSecret',
]);

/**
 * Map a `targetType` audit field to the DB enum value. Returns null when no
 * target kind was provided (some events have no single target).
 *
 * @param targetType The audit field's target kind, if any.
 * @returns The matching AuditTargetType, or null.
 */
function toTargetType(targetType: AuditFields['targetType']): AuditTargetType | null {
  return targetType ?? null;
}

/**
 * Build the durable `metadata` JSON from the allowlisted AuditFields, dropping
 * any forbidden key (ADR-046 fail-safe) and any undefined value. `actorId`,
 * `resourceId` (→ targetId), and `targetType` are columned separately and are
 * NOT duplicated into metadata.
 *
 * @param fields The typed, non-sensitive audit fields.
 * @returns A plain JSON object safe to persist.
 */
function buildMetadata(fields: AuditFields): Prisma.InputJsonObject {
  const candidate: Record<string, string | number> = {};
  if (fields.outcome !== undefined) {
    candidate.outcome = fields.outcome;
  }
  if (fields.family !== undefined) {
    candidate.family = fields.family;
  }
  if (fields.jti !== undefined) {
    candidate.jti = fields.jti;
  }
  if (fields.reason !== undefined) {
    candidate.reason = fields.reason;
  }
  if (fields.count !== undefined) {
    candidate.count = fields.count;
  }
  const metadata: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(candidate)) {
    if (!FORBIDDEN_METADATA_KEYS.has(key)) {
      metadata[key] = value;
    }
  }
  return metadata;
}

/**
 * Map an audit row to its wire DTO (security S11 — only intended fields).
 *
 * @param row The persisted audit row.
 * @returns The serializable response.
 */
function toAuditLogResponse(row: AuditLog): AuditLogResponse {
  return {
    id: row.id,
    eventType: row.eventType,
    actorId: row.actorId,
    targetId: row.targetId,
    targetType: row.targetType,
    ipAddress: row.ipAddress,
    userAgent: row.userAgent,
    metadata: row.metadata,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Translate the validated query DTO into the repository filter shape (snake_case
 * query keys → camelCase filter fields).
 *
 * @param query The validated audit query.
 * @returns The repository filter.
 */
function toFilter(query: AuditQuery): AuditFilter {
  return {
    eventType: query.event_type,
    actorId: query.actor_id,
    targetId: query.target_id,
    from: query.from,
    to: query.to,
  };
}

/**
 * Business logic for the audit module (ADR-049). Implements the {@link AuditSink}
 * port: `record` is the fire-and-forget emit (route-injected sink), `query` is
 * the admin read API. Owns NO Fastify types — `record` takes a plain
 * {@link RequestContext} POJO, never a FastifyRequest, so the service stays
 * Fastify-free (ADR-010 rule #2).
 */
export class AuditService implements AuditSink {
  /**
   * @param repo The audit repository (the only Prisma importer in the module).
   * @param logger App-level logger for the AUDIT_WRITE_FAILED fallback (the
   *   request logger may be gone by the time a detached INSERT rejects).
   */
  constructor(
    private readonly repo: AuditRepository,
    private readonly logger: FastifyBaseLogger,
  ) {}

  /**
   * Record an audit event durably — fire-and-forget (ADR-049 / security S8).
   *
   * Synchronously builds + redacts the row from server-derived `ctx` and the
   * allowlisted `fields` (ADR-046), then fires the INSERT WITHOUT awaiting and
   * attaches the SINGLE try/catch: on failure it logs `AUDIT_WRITE_FAILED`
   * (never silently swallowed, never re-thrown — the main op already succeeded).
   * Returns `void` and NEVER throws, so a route call site is one clean line with
   * no try/catch and the main operation can never fail because of an audit write.
   *
   * @param action The audited action.
   * @param ctx Server-derived provenance (actor/ip/userAgent).
   * @param fields Allowlisted, non-sensitive context.
   * @returns void.
   */
  record(action: AuditAction, ctx: RequestContext, fields: AuditFields): void {
    const row: AuditInsert = {
      eventType: action,
      actorId: ctx.actorId,
      targetId: fields.resourceId ?? null,
      targetType: toTargetType(fields.targetType),
      ipAddress: ctx.ip,
      userAgent: ctx.userAgent,
      metadata: buildMetadata(fields),
    };
    // Fire-and-forget: do NOT await. The detached `.catch` is the one place the
    // non-blocking guarantee is enforced — the route never sees this promise.
    void this.repo.insert(row).catch((err: unknown) => {
      this.logger.error(
        { event: 'AUDIT_WRITE_FAILED', action, actorId: ctx.actorId, err },
        'audit write failed',
      );
    });
  }

  /**
   * Read a filtered, paginated page of audit events, newest first (admin-only;
   * the route guard enforces the ADMIN capability — security S1). Delegates to
   * the repository's parameterized read and maps rows to the wire DTO.
   *
   * @param query The validated audit query (filters + pagination).
   * @returns A paginated page of audit-log DTOs.
   */
  async query(query: AuditQuery): Promise<Paginated<AuditLogResponse>> {
    const { rows, total } = await this.repo.findMany(toFilter(query), {
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    return {
      items: rows.map(toAuditLogResponse),
      pageInfo: buildPageMeta(query.page, query.limit, total),
    };
  }
}
