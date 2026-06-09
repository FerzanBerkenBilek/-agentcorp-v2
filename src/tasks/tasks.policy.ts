import { Task } from '@prisma/client';
import { NotFoundError } from '../shared/errors';

/**
 * Centralized object-level authorization for tasks (H1 / ADR-013).
 *
 * Every task read/update/delete path runs through these helpers — there is no
 * other place that decides who may touch a task. To prevent resource
 * enumeration, an unauthorized caller is treated identically to a missing
 * resource: we throw NotFoundError (-> 404), never 403 (H1).
 *
 * Rules:
 *  - Read / update: caller must be the owner OR the assignee.
 *  - Delete / reassign (change assigneeId): owner ONLY.
 */

/** True if the user created the task. */
function isOwner(task: Pick<Task, 'ownerId'>, userId: string): boolean {
  return task.ownerId === userId;
}

/** True if the task is currently assigned to the user. */
function isAssignee(task: Pick<Task, 'assigneeId'>, userId: string): boolean {
  return task.assigneeId === userId;
}

/**
 * Assert the caller may VIEW or UPDATE the task (owner or assignee).
 *
 * @param task The task (or null if it does not exist).
 * @param userId The authenticated caller's id.
 * @returns The non-null task once access is confirmed.
 * @throws NotFoundError if the task is missing OR the caller is neither owner nor assignee.
 */
export function assertCanAccess<T extends Pick<Task, 'ownerId' | 'assigneeId'>>(
  task: T | null,
  userId: string,
): T {
  if (!task || (!isOwner(task, userId) && !isAssignee(task, userId))) {
    throw new NotFoundError('Task');
  }
  return task;
}

/**
 * Assert the caller may DELETE or REASSIGN the task (owner only).
 *
 * @param task The task (or null if it does not exist).
 * @param userId The authenticated caller's id.
 * @returns The non-null task once ownership is confirmed.
 * @throws NotFoundError if the task is missing OR the caller is not the owner.
 */
export function assertIsOwner<T extends Pick<Task, 'ownerId'>>(
  task: T | null,
  userId: string,
): T {
  if (!task || !isOwner(task, userId)) {
    throw new NotFoundError('Task');
  }
  return task;
}
