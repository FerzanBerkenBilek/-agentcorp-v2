import { Task } from '@prisma/client';
import { ValidationError } from '../shared/errors';
import { Paginated, buildPageMeta } from '../shared/http';
import { NOOP_PUBLISHER, TaskEventPublisher, TaskEventType } from '../shared/task-events';
import { toTaskResponse } from '../shared/task-serializer';
import { UsersRepository } from '../users/users.repository';
import { assertCanAccess, assertIsOwner } from './tasks.policy';
import {
  CreateTaskData,
  ListTasksParams,
  TasksRepository,
  UpdateTaskData,
} from './tasks.repository';
import { CreateTaskInput, ListTasksQuery, UpdateTaskInput } from './tasks.schemas';

/**
 * Task business logic + authorization orchestration.
 *
 * All authorization decisions are delegated to tasks.policy (H1). Assignee
 * existence is validated against the users repository before any write (M5).
 * The caller's id (from the JWT) is the only trusted source of ownership — it
 * is never taken from the request body.
 *
 * After every successful mutation the service publishes a `TaskEvent` through
 * the injected `TaskEventPublisher` port (ADR-025). The port is a pure-type
 * dependency in `shared/`; the concrete `ConnectionHub` is injected at the
 * composition root. The default is a no-op so WS-disabled runs are unaffected.
 */
export class TasksService {
  /**
   * @param tasks Task repository (persistence).
   * @param users Users repository (assignee existence checks, M5).
   * @param events Task event publisher (ADR-025); defaults to a no-op so the
   *   tasks module and existing tests run without a WebSocket hub.
   */
  constructor(
    private readonly tasks: TasksRepository,
    private readonly users: UsersRepository,
    private readonly events: TaskEventPublisher = NOOP_PUBLISHER,
  ) {}

  /**
   * Create a task owned by the caller.
   *
   * @param userId Authenticated caller (becomes ownerId).
   * @param input Validated task fields.
   * @returns The created task.
   * @throws ValidationError if a provided assigneeId does not exist (M5).
   */
  async create(userId: string, input: CreateTaskInput): Promise<Task> {
    if (input.assigneeId) {
      await this.assertAssigneeExists(input.assigneeId);
    }
    const data: CreateTaskData = {
      title: input.title,
      description: input.description,
      status: input.status,
      priority: input.priority,
      ownerId: userId,
      assigneeId: input.assigneeId ?? null,
    };
    const task = await this.tasks.create(data);
    this.emit('task.created', task);
    return task;
  }

  /**
   * Get a single task the caller may view (owner or assignee).
   *
   * @param userId Authenticated caller.
   * @param taskId Task UUID.
   * @returns The task.
   * @throws NotFoundError if missing or the caller is not owner/assignee (H1).
   */
  async getById(userId: string, taskId: string): Promise<Task> {
    const task = await this.tasks.findById(taskId);
    return assertCanAccess(task, userId);
  }

  /**
   * List tasks visible to the caller (owned or assigned), filtered + paginated.
   *
   * @param userId Authenticated caller.
   * @param query Validated filters and pagination (limit already capped, M7).
   * @returns A paginated page of tasks.
   */
  async list(userId: string, query: ListTasksQuery): Promise<Paginated<Task>> {
    const params: ListTasksParams = {
      userId,
      status: query.status,
      priority: query.priority,
      page: query.page,
      limit: query.limit,
    };
    const { items, total } = await this.tasks.listForUser(params);
    return { items, pageInfo: buildPageMeta(query.page, query.limit, total) };
  }

  /**
   * Update a task. Owner or assignee may change content/status/priority; only
   * the owner may change the assignee (reassign). ownerId is never updatable.
   *
   * @param userId Authenticated caller.
   * @param taskId Task UUID.
   * @param input Validated partial update.
   * @returns The updated task.
   * @throws NotFoundError if missing/unauthorized (H1).
   * @throws ValidationError if a new assigneeId does not exist (M5).
   */
  async update(userId: string, taskId: string, input: UpdateTaskInput): Promise<Task> {
    const existing = await this.tasks.findById(taskId);
    const task = assertCanAccess(existing, userId);
    const reassigning = 'assigneeId' in input;
    if (reassigning) {
      // Changing the assignee is an owner-only action (H1 / ADR-013).
      assertIsOwner(task, userId);
      if (input.assigneeId) {
        await this.assertAssigneeExists(input.assigneeId);
      }
    }
    const updated = await this.tasks.update(taskId, this.toUpdateData(input));
    this.emit('task.updated', updated);
    return updated;
  }

  /**
   * Delete a task. Owner only (H1).
   *
   * @param userId Authenticated caller.
   * @param taskId Task UUID.
   * @returns A promise that resolves once deleted.
   * @throws NotFoundError if missing or the caller is not the owner (H1).
   */
  async delete(userId: string, taskId: string): Promise<void> {
    const existing = await this.tasks.findById(taskId);
    const task = assertIsOwner(existing, userId);
    await this.tasks.delete(taskId);
    // R15: publish the deleted task's last-known shape (the row is now gone) so
    // the fan-out can authorize owner/assignee against that snapshot.
    this.emit('task.deleted', task);
  }

  /**
   * Validate that an assignee user exists (M5).
   *
   * @param assigneeId Candidate assignee UUID.
   * @returns A promise that resolves if the user exists.
   * @throws ValidationError if no such user exists.
   */
  private async assertAssigneeExists(assigneeId: string): Promise<void> {
    if (!(await this.users.existsById(assigneeId))) {
      throw new ValidationError('Assignee user does not exist', [
        { path: 'assigneeId', message: 'No user with this id' },
      ]);
    }
  }

  /**
   * Map a validated update DTO to repository data. ownerId is intentionally
   * never included, guaranteeing it stays immutable.
   *
   * @param input The validated partial update.
   * @returns Repository update data.
   */
  private toUpdateData(input: UpdateTaskInput): UpdateTaskData {
    return {
      ...(input.title !== undefined && { title: input.title }),
      ...(input.description !== undefined && { description: input.description }),
      ...(input.status !== undefined && { status: input.status }),
      ...(input.priority !== undefined && { priority: input.priority }),
      ...('assigneeId' in input && { assigneeId: input.assigneeId }),
    };
  }

  /**
   * Publish a task event through the injected port (ADR-025). Serializes via the
   * shared `toTaskResponse` (R14 — one wire DTO, no extra fields) and stamps an
   * ISO8601 timestamp. Fire-and-forget: the no-op default and the hub's
   * per-socket error isolation mean this never throws or blocks the write path.
   *
   * @param type The event type.
   * @param task The mutated (or deleted-snapshot) task.
   * @returns void
   */
  private emit(type: TaskEventType, task: Task): void {
    this.events.publish({ type, task: toTaskResponse(task), timestamp: new Date().toISOString() });
  }
}
