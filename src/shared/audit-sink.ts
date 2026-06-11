import { AuditAction, AuditFields } from './audit';

/**
 * The audit emission seam (ADR-049).
 *
 * This is a PURE-TYPES port plus one no-op constant. It imports nothing from
 * `src/audit/`, the feature modules, or Fastify — only the `AuditAction` /
 * `AuditFields` vocabulary already in `shared/`. Route plugins depend DOWNWARD
 * on this port (never on the concrete `AuditService`, ADR-011: no cross-module
 * concrete import), and `app.ts` injects the real sink at the composition root.
 * With the no-op default, every route plugin and all existing tests run
 * unaffected when the DB audit sink is not wired (mirrors NOOP_PUBLISHER,
 * ADR-025) — this is what keeps the 558 existing tests green.
 *
 * The durable DB sink is ADDITIVE to the existing logger `audit()` (M8): both
 * run at a call site; this port carries the DB mirror, not a replacement.
 */

/**
 * Server-derived request provenance captured at the route layer and passed
 * DOWN to the sink as a plain value object — so no `FastifyRequest` ever enters
 * a service (ADR-010 rule #2). All three fields are server-derived, NEVER read
 * from a client-controlled body field (ADR-049 / security S2/S3).
 */
export interface RequestContext {
  /** The acting user's id (JWT `sub`), or null for an unauthenticated attempt. */
  actorId: string | null;
  /** The client IP (Fastify `request.ip`, honouring trustProxy), or null. */
  ip: string | null;
  /** The client User-Agent (length-capped, opaque), or null. */
  userAgent: string | null;
}

/**
 * The audit emission port. `record` is fire-and-forget (returns `void`): the
 * route NEVER awaits the DB write and the main operation never fails because an
 * audit INSERT failed (ADR-049). The single try/catch lives in the concrete
 * impl, not at call sites — `record` MUST NOT throw.
 */
export interface AuditSink {
  /**
   * Record an audit event durably (fire-and-forget).
   *
   * @param action The audited action (see AUDIT_ACTION).
   * @param ctx Server-derived request provenance (actor/ip/userAgent).
   * @param fields Structured, allowlisted, non-sensitive context (ADR-046).
   * @returns void — the DB write is detached; never awaited, never throws.
   */
  record(action: AuditAction, ctx: RequestContext, fields: AuditFields): void;
}

/**
 * The default sink: does nothing. Injected into route plugins when the DB audit
 * sink is not wired (unit/integration tests, audit-disabled runs) so emission
 * is a safe no-op and the existing test suite is unaffected.
 */
export const NOOP_AUDIT_SINK: AuditSink = {
  record(): void {
    /* intentional no-op — durable DB audit disabled */
  },
};
