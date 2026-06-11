import { TaskPriority, TaskStatus } from '@prisma/client';
import { z } from 'zod';

/**
 * Zod schemas for task endpoints. `.strict()` blocks unknown keys (mass-
 * assignment defense). Note: ownerId is NEVER accepted from the client — it is
 * set server-side from the JWT — and is therefore absent from every schema.
 */

/** Max title length (matches Task.title VARCHAR(255)). */
const MAX_TITLE_LENGTH = 255;
/** Default page number when omitted. */
const DEFAULT_PAGE = 1;
/** Default page size when omitted. */
const DEFAULT_LIMIT = 20;
/** Hard maximum page size (M7 / ADR-014). */
export const MAX_LIMIT = 100;

/** Native enum validators reused across create/update/filter. */
const statusSchema = z.nativeEnum(TaskStatus);
const prioritySchema = z.nativeEnum(TaskPriority);

/** POST /tasks body. assigneeId optional; ownerId is server-set, not accepted. */
export const createTaskSchema = z
  .object({
    title: z.string().min(1, 'Title is required').max(MAX_TITLE_LENGTH),
    description: z.string().optional(),
    status: statusSchema.optional(),
    priority: prioritySchema.optional(),
    assigneeId: z.string().uuid().optional(),
  })
  .strict();

/**
 * The strict partial-update object shape, WITHOUT the non-empty refine. Kept as a
 * standalone `ZodObject` so it can be `.extend()`ed (the bulk-update element adds
 * `id`). `.refine()` would wrap this in a `ZodEffects`, which has no `.extend()`,
 * so the refine is applied by `withNonEmpty` to each concrete schema instead.
 */
const updateTaskObject = z
  .object({
    title: z.string().min(1).max(MAX_TITLE_LENGTH).optional(),
    description: z.string().nullable().optional(),
    status: statusSchema.optional(),
    priority: prioritySchema.optional(),
    assigneeId: z.string().uuid().nullable().optional(),
  })
  .strict();

/** Reusable "at least one field must be provided" guard (rejects an empty patch). */
const NON_EMPTY_PATCH = {
  check: (obj: Record<string, unknown>) => Object.keys(obj).length > 0,
  message: 'At least one field must be provided',
} as const;

/**
 * PATCH /tasks/:id body. assigneeId may be set to null to unassign.
 * `.refine` requires at least one field so an empty patch is rejected.
 */
export const updateTaskSchema = updateTaskObject.refine(NON_EMPTY_PATCH.check, {
  message: NON_EMPTY_PATCH.message,
});

/** GET /tasks query params. page/limit are coerced and clamped (M7). */
export const listTasksQuerySchema = z
  .object({
    status: statusSchema.optional(),
    priority: prioritySchema.optional(),
    page: z.coerce.number().int().min(1).default(DEFAULT_PAGE),
    limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  })
  .strict();

/** Route params carrying a task id. */
export const taskIdParamSchema = z.object({ id: z.string().uuid('Invalid task id') }).strict();

/**
 * Hard maximum items per bulk request (M1 / H5 / ADR-014). Enforced in the Zod
 * wrapper BEFORE any DB op so a 51-element batch is rejected request-level (422)
 * and never reaches the per-item loop. Caps DB-op amplification per request.
 */
export const MAX_BULK_ITEMS = 50;

/**
 * One element of a `PATCH /tasks/bulk-update` batch: a target task `id` plus the
 * SAME partial-update shape as the single-task endpoint (H2).
 *
 * Built by `.extend()`ing the strict `updateTaskObject` with `id` (NOT
 * `z.intersection` — intersecting two `.strict()` objects fails because each side
 * flags the other's keys as unknown, which 422'd every real `{ id, ... }` element).
 * `.extend()` preserves the source's `unknownKeys: 'strict'`, so the only accepted
 * keys remain `id` + the known update fields — the mass-assignment defense (H2,
 * ADR-006) is intact and `ownerId` is still never accepted.
 *
 * The non-empty-patch rule (≥1 update field) is re-applied here, counting update
 * fields ONLY (the routing `id` is excluded from the count) so `{ id }` alone is
 * rejected, matching the single-task contract. Key presence is preserved verbatim,
 * so the service's `'assigneeId' in input` reassign-detection (H1/L1) still fires.
 */
export const bulkUpdateItemSchema = updateTaskObject
  .extend({ id: z.string().uuid('Invalid task id') })
  .refine((obj) => NON_EMPTY_PATCH.check(omitId(obj)), {
    message: NON_EMPTY_PATCH.message,
  });

/** Drop the routing `id` so the non-empty-patch count sees update fields only. */
function omitId(obj: Record<string, unknown>): Record<string, unknown> {
  const { id: _id, ...rest } = obj;
  return rest;
}

/** `POST /tasks/bulk-create` body: 1..50 elements, each = createTaskSchema verbatim (H2/M1). */
export const bulkCreateSchema = z
  .object({
    items: z.array(createTaskSchema).min(1, 'At least one item is required').max(MAX_BULK_ITEMS),
  })
  .strict();

/** `PATCH /tasks/bulk-update` body: 1..50 elements, each = { id } + updateTaskSchema (H2/M1). */
export const bulkUpdateSchema = z
  .object({
    items: z.array(bulkUpdateItemSchema).min(1, 'At least one item is required').max(MAX_BULK_ITEMS),
  })
  .strict();

/** `DELETE /tasks/bulk-delete` body: 1..50 task ids (owner-only per item, M1). */
export const bulkDeleteSchema = z
  .object({
    ids: z
      .array(z.string().uuid('Invalid task id'))
      .min(1, 'At least one id is required')
      .max(MAX_BULK_ITEMS),
  })
  .strict();

export type CreateTaskInput = z.infer<typeof createTaskSchema>;
export type UpdateTaskInput = z.infer<typeof updateTaskSchema>;
export type ListTasksQuery = z.infer<typeof listTasksQuerySchema>;
export type BulkUpdateItem = z.infer<typeof bulkUpdateItemSchema>;
export type BulkCreateInput = z.infer<typeof bulkCreateSchema>;
export type BulkUpdateInput = z.infer<typeof bulkUpdateSchema>;
export type BulkDeleteInput = z.infer<typeof bulkDeleteSchema>;
