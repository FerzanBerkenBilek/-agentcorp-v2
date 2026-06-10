import { Task } from '@prisma/client';

/**
 * Single source of the task wire DTO (ADR-025, DRY Refactor 1).
 *
 * Extracted from `tasks.routes.ts` so BOTH the REST route layer and the
 * WebSocket emission seam (`task-events.ts` -> `ConnectionHub`) serialize a task
 * to the exact same shape — there is no second task DTO. Lives in `shared/`
 * (the cross-cutting core, ADR-010) so the downward-only dependency rule holds:
 * the tasks module and the ws module both depend on this, neither on the other.
 */

/** Wire shape of a task (Dates serialized to ISO strings). */
export interface TaskResponse {
  id: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  ownerId: string;
  assigneeId: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Map an internal Task to its wire DTO.
 *
 * @param task The task entity.
 * @returns The serializable task response.
 */
export function toTaskResponse(task: Task): TaskResponse {
  return {
    id: task.id,
    title: task.title,
    description: task.description,
    status: task.status,
    priority: task.priority,
    ownerId: task.ownerId,
    assigneeId: task.assigneeId,
    createdAt: task.createdAt.toISOString(),
    updatedAt: task.updatedAt.toISOString(),
  };
}
