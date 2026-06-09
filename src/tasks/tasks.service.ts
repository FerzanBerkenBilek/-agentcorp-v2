import { Task } from '@prisma/client';
import { ValidationError } from '../shared/errors';
import { Paginated, buildPageMeta } from '../shared/http';
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
 */
export class TasksService {
  /**
   * @param tasks Task repository (persistence).
   * @param users Users repository (assignee existence checks, M5).
   */
  constructor(
    private readonly tasks: TasksRepository,
    private readonly users: UsersRepository,
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
    return this.tasks.create(data);
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
    return this.tasks.update(taskId, this.toUpdateData(input));
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
    assertIsOwner(existing, userId);
    await this.tasks.delete(taskId);
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
}
