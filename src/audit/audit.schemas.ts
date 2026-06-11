import { z } from 'zod';
import { AUDIT_ACTION } from '../shared/audit';

/**
 * Zod schema for the admin audit-log read filters (security S9). `.strict()`
 * blocks unknown query keys (mass-assignment posture, project precedent). Every
 * filter is optional; an empty query is the unfiltered newest-first page.
 *
 * Validation hardens the query API against injection + DoS (security F6):
 *  - `event_type` must be one of the known AUDIT_ACTION values (a closed set).
 *  - `actor_id` / `target_id` must be UUIDs.
 *  - `from` / `to` are coerced dates; an inverted range (`from > to`) is rejected.
 *  - `page` / `limit` are coerced, bounded, and `limit` is hard-capped at 100.
 */

/** Default page number when omitted. */
const DEFAULT_PAGE = 1;
/** Default page size when omitted. */
const DEFAULT_LIMIT = 20;
/** Hard maximum page size (security S9 / ADR-048 — newest-first capped read). */
export const MAX_AUDIT_LIMIT = 100;

/** The closed set of valid `event_type` filter values (the AUDIT_ACTION vocabulary). */
const auditActionValues = Object.values(AUDIT_ACTION) as [string, ...string[]];

/** GET /audit-logs query params. All filters optional; range + pagination bounded. */
export const auditQuerySchema = z
  .object({
    event_type: z.enum(auditActionValues).optional(),
    actor_id: z.string().uuid('Invalid actor id').optional(),
    target_id: z.string().uuid('Invalid target id').optional(),
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
    page: z.coerce.number().int().min(1).default(DEFAULT_PAGE),
    limit: z.coerce.number().int().min(1).max(MAX_AUDIT_LIMIT).default(DEFAULT_LIMIT),
  })
  .strict()
  .refine((q) => q.from === undefined || q.to === undefined || q.from <= q.to, {
    message: '`from` must be on or before `to`',
    path: ['from'],
  });

export type AuditQuery = z.infer<typeof auditQuerySchema>;

/** Wire DTO for one audit row (security S11 — only intended fields exposed). */
export interface AuditLogResponse {
  id: string;
  eventType: string;
  actorId: string | null;
  targetId: string | null;
  targetType: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  metadata: unknown;
  createdAt: string;
}
