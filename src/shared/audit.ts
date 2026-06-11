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
  // Bulk task operations (BULK-2026-06-11). Distinct actions so the durable
  // audit trail can tell a single mutation from a batched one.
  TASK_BULK_CREATE: 'task.bulk_create',
  TASK_BULK_UPDATE: 'task.bulk_update',
  TASK_BULK_DELETE: 'task.bulk_delete',
  URL_SHORTEN: 'url.shorten',
  URL_DELETE: 'url.delete',
  // Moderation outcomes for a flagged candidate URL (admin acts on the queue).
  URL_APPROVED: 'url.approved',
  URL_REJECTED: 'url.rejected',
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
  // OAuth2 Google login (OA-2026-06-11, ADR-036/037/040, G24). These carry NO
  // secret/PII beyond actorId (the client_secret, tokens, code_verifier, and
  // Google sub are NEVER recorded; google email is not an audit field either).
  OAUTH_START: 'auth.oauth_start',
  OAUTH_CALLBACK: 'auth.oauth_callback',
  OAUTH_LINK: 'auth.oauth_link',
  OAUTH_CREATE: 'auth.oauth_create',
  OAUTH_LINK_DENIED: 'auth.oauth_link_denied',
  OAUTH_STATE_REJECTED: 'auth.oauth_state_rejected',
  // Admin user-role change (AUDIT-2026-06-11). Vocabulary completeness: no wired
  // role-change endpoint exists today (role is set by the register default and
  // the OAuth ladder only), so this action is defined but not yet emitted; it is
  // here so a future admin role-change op records to the durable trail without a
  // new enum edit.
  USER_ROLE_CHANGED: 'admin.user_role_changed',
} as const;

export type AuditAction = (typeof AUDIT_ACTION)[keyof typeof AUDIT_ACTION];

/**
 * Structured fields recorded with every audit entry.
 *
 * This is a STRICT allowlist of non-sensitive identifiers (ADR-046): it must
 * NEVER carry passwords/hashes, tokens/JWTs, PKCE verifiers/state, provider
 * subjects, client secrets, raw bodies/headers, or any PII beyond the actor id.
 * The durable audit sink (src/audit/audit.service.ts) builds the persisted
 * `metadata` JSON from these fields only and runs a redaction pass before
 * INSERT, so a careless caller fails safe.
 */
export interface AuditFields {
  /** The acting user's id, or null for unauthenticated attempts. */
  actorId: string | null;
  /** The id of the affected resource, if any. */
  resourceId?: string;
  /**
   * The kind of entity `resourceId` points at (audit_logs.target_type, ADR-048).
   * Used only by the durable sink; the logger emitter ignores it.
   */
  targetType?: 'task' | 'url' | 'user' | 'blocklist_entry';
  /** Whether the action succeeded. */
  outcome: 'success' | 'failure';
  /** Refresh-token rotation family (TOKEN_REUSE_DETECTED context, ADR-012). */
  family?: string;
  /** Refresh-token jti (TOKEN_REUSE_DETECTED context, ADR-012). */
  jti?: string;
  /** Non-sensitive enum reason for an outcome (e.g. a moderation decision). */
  reason?: string;
  /** Non-sensitive count (e.g. number of items in a bulk operation). */
  count?: number;
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
