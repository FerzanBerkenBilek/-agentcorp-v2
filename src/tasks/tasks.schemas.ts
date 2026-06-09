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
 * PATCH /tasks/:id body. assigneeId may be set to null to unassign.
 * `.refine` requires at least one field so an empty patch is rejected.
 */
export const updateTaskSchema = z
  .object({
    title: z.string().min(1).max(MAX_TITLE_LENGTH).optional(),
    description: z.string().nullable().optional(),
    status: statusSchema.optional(),
    priority: prioritySchema.optional(),
    assigneeId: z.string().uuid().nullable().optional(),
  })
  .strict()
  .refine((obj) => Object.keys(obj).length > 0, {
    message: 'At least one field must be provided',
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

export type CreateTaskInput = z.infer<typeof createTaskSchema>;
export type UpdateTaskInput = z.infer<typeof updateTaskSchema>;
export type ListTasksQuery = z.infer<typeof listTasksQuerySchema>;
