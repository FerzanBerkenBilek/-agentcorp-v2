import { FastifyBaseLogger } from 'fastify';

/**
 * Audit logging for security-relevant events (M8).
 *
 * Emits a structured, queryable log line (event=AUDIT) for auth events and task
 * mutations. Only non-sensitive identifiers are recorded — never passwords,
 * tokens, or PII beyond the actor's user id (log redaction is also enforced
 * globally in logger.ts).
 */

/** Enumerated audit actions (no magic strings at call sites). */
export const AUDIT_ACTION = {
  REGISTER: 'auth.register',
  LOGIN: 'auth.login',
  LOGOUT: 'auth.logout',
  TOKEN_REFRESH: 'auth.token_refresh',
  TOKEN_REUSE_DETECTED: 'auth.token_reuse_detected',
  TASK_CREATE: 'task.create',
  TASK_UPDATE: 'task.update',
  TASK_ASSIGN: 'task.assign',
  TASK_DELETE: 'task.delete',
  URL_SHORTEN: 'url.shorten',
  URL_DELETE: 'url.delete',
  // Abuse prevention (ADR-034/035, R14). Admin mutations + screen/quota events.
  URL_BLOCKED: 'url.blocked',
  URL_FLAGGED: 'url.flagged',
  QUOTA_EXCEEDED: 'url.quota_exceeded',
  BLOCKLIST_ADD: 'admin.blocklist_add',
  BLOCKLIST_REMOVE: 'admin.blocklist_remove',
  FLAG_APPROVE: 'admin.flag_approve',
  FLAG_REJECT: 'admin.flag_reject',
  WS_CONNECT: 'ws.connect',
  WS_AUTH_FAILURE: 'ws.auth_failure',
  WS_CAP_EXCEEDED: 'ws.cap_exceeded',
  WS_FRAME_ABUSE: 'ws.frame_abuse',
  WS_TOKEN_EXPIRED: 'ws.token_expired',
} as const;

export type AuditAction = (typeof AUDIT_ACTION)[keyof typeof AUDIT_ACTION];

/** Structured fields recorded with every audit entry. */
export interface AuditFields {
  /** The acting user's id, or null for unauthenticated attempts. */
  actorId: string | null;
  /** The id of the affected resource, if any. */
  resourceId?: string;
  /** Whether the action succeeded. */
  outcome: 'success' | 'failure';
  /** Refresh-token rotation family (TOKEN_REUSE_DETECTED context, ADR-012). */
  family?: string;
  /** Refresh-token jti (TOKEN_REUSE_DETECTED context, ADR-012). */
  jti?: string;
}

/**
 * Write a single audit log entry.
 *
 * @param logger The request-scoped Fastify logger.
 * @param action The audited action (see AUDIT_ACTION).
 * @param fields Structured, non-sensitive context.
 * @returns void
 */
export function audit(
  logger: FastifyBaseLogger,
  action: AuditAction,
  fields: AuditFields,
): void {
  logger.info({ event: 'AUDIT', action, ...fields }, `audit:${action}`);
}
