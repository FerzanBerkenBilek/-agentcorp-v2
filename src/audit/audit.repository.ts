import { AuditLog, AuditTargetType, Prisma, PrismaClient } from '@prisma/client';
import { prisma } from '../shared/prisma';

/**
 * A row to INSERT into audit_logs. All provenance is server-derived (ADR-049);
 * `id`/`createdAt` are DB-defaulted and never supplied here. `metadata` is the
 * already-allowlisted/redacted context object (ADR-046) — the repository does
 * NO redaction, that is the service's job (the repo is pure data access).
 */
export interface AuditInsert {
  eventType: string;
  actorId: string | null;
  targetId: string | null;
  targetType: AuditTargetType | null;
  ipAddress: string | null;
  userAgent: string | null;
  metadata: Prisma.InputJsonValue;
}

/** Equality + range filters for the admin audit-log read (all optional). */
export interface AuditFilter {
  eventType?: string;
  actorId?: string;
  targetId?: string;
  /** Inclusive lower bound on createdAt. */
  from?: Date;
  /** Exclusive upper bound on createdAt. */
  to?: Date;
}

/** Zero-based pagination window for the read (limit already capped by the schema). */
export interface AuditPage {
  skip: number;
  take: number;
}

/** A page of audit rows plus the total matching count (for pagination meta). */
export interface AuditFindManyResult {
  rows: AuditLog[];
  total: number;
}

/**
 * Repository for the AuditLog aggregate — the ONLY place audit rows are
 * written/read (ADR-010 layering). It exposes INSERT + read ONLY: there is no
 * update/delete method, because audit_logs is append-only and DB-immutable (a
 * BEFORE UPDATE/DELETE trigger RAISEs, ADR-045/migration 006). Contains no
 * authorization or business rules (those live in the service / route guard).
 */
export class AuditRepository {
  /** @param db Injected Prisma client (defaults to the shared singleton). */
  constructor(private readonly db: PrismaClient = prisma) {}

  /**
   * Insert one audit row (the only legal write). Returns `Promise<void>` rather
   * than an ADR-044 Result: this is a fire-and-forget write with no recoverable
   * business conflict for a caller to branch on (id is a server UUID, no natural
   * key). It MAY reject (DB down) — the service's detached `.catch` handles that
   * (ADR-049), never the route. created_at/id default in the DB.
   *
   * @param row The fully-built, already-redacted audit row (ADR-046).
   * @returns A promise that resolves once the row is written.
   */
  async insert(row: AuditInsert): Promise<void> {
    await this.db.auditLog.create({
      data: {
        eventType: row.eventType,
        actorId: row.actorId,
        targetId: row.targetId,
        targetType: row.targetType,
        ipAddress: row.ipAddress,
        userAgent: row.userAgent,
        metadata: row.metadata,
      },
    });
  }

  /**
   * Read a filtered, paginated page of audit rows, newest first. Every filter
   * is applied via Prisma's parameterized builder (NO `$queryRawUnsafe` / no
   * string interpolation — security S9). Ordering is `created_at DESC` (served
   * Sort-free by the created_at-leading indexes, ADR-048). Runs the page query
   * and the matching count in one transaction so both observe the same snapshot.
   *
   * @param filter Optional equality (event_type/actor_id/target_id) + date range.
   * @param page Zero-based skip/take (take already capped ≤100 by the schema).
   * @returns The page rows plus the total matching count.
   */
  async findMany(filter: AuditFilter, page: AuditPage): Promise<AuditFindManyResult> {
    const where = buildWhere(filter);
    const [rows, total] = await this.db.$transaction([
      this.db.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: page.skip,
        take: page.take,
      }),
      this.db.auditLog.count({ where }),
    ]);
    return { rows, total };
  }
}

/**
 * Build the Prisma `where` clause from the optional filters. Absent filters are
 * omitted (no predicate), so the default unfiltered read is a plain newest-first
 * scan. The date range maps to `created_at >= from AND < to`.
 *
 * @param filter The validated filter values.
 * @returns A Prisma AuditLogWhereInput.
 */
function buildWhere(filter: AuditFilter): Prisma.AuditLogWhereInput {
  const where: Prisma.AuditLogWhereInput = {};
  if (filter.eventType !== undefined) {
    where.eventType = filter.eventType;
  }
  if (filter.actorId !== undefined) {
    where.actorId = filter.actorId;
  }
  if (filter.targetId !== undefined) {
    where.targetId = filter.targetId;
  }
  if (filter.from !== undefined || filter.to !== undefined) {
    where.createdAt = {
      ...(filter.from !== undefined ? { gte: filter.from } : {}),
      ...(filter.to !== undefined ? { lt: filter.to } : {}),
    };
  }
  return where;
}
