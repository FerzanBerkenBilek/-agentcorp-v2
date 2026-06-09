import { Prisma, PrismaClient, Task, TaskPriority, TaskStatus } from '@prisma/client';
import { prisma } from '../shared/prisma';

/** Fields persisted on task creation (ownerId is set by the service from the JWT). */
export interface CreateTaskData {
  title: string;
  description?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  ownerId: string;
  assigneeId?: string | null;
}

/** Mutable task fields (ownerId is intentionally absent — it is immutable). */
export interface UpdateTaskData {
  title?: string;
  description?: string | null;
  status?: TaskStatus;
  priority?: TaskPriority;
  assigneeId?: string | null;
}

/** Filters + pagination for listing tasks. */
export interface ListTasksParams {
  userId: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  page: number;
  limit: number;
}

/** A page of tasks plus the total matching count. */
export interface TaskPage {
  items: Task[];
  total: number;
}

/**
 * Repository for the Task aggregate — the only place tasks are read/written.
 * Contains no authorization or business rules (those live in the policy and
 * service). List queries are always scoped to the caller (owner OR assignee)
 * so an unscoped row never reaches the service (ADR-013).
 */
export class TasksRepository {
  /** @param db Injected Prisma client (defaults to the shared singleton). */
  constructor(private readonly db: PrismaClient = prisma) {}

  /**
   * Find a task by id (unscoped). Authorization is applied by the policy in
   * the service layer; this returns the raw row or null.
   *
   * @param id Task UUID.
   * @returns The task, or null if it does not exist.
   */
  async findById(id: string): Promise<Task | null> {
    return this.db.task.findUnique({ where: { id } });
  }

  /**
   * Create a task.
   *
   * @param data Task fields including the server-set ownerId.
   * @returns The created task.
   */
  async create(data: CreateTaskData): Promise<Task> {
    return this.db.task.create({ data });
  }

  /**
   * Update a task by id with the provided partial fields.
   *
   * @param id Task UUID.
   * @param data Fields to change (omitted fields are untouched).
   * @returns The updated task.
   */
  async update(id: string, data: UpdateTaskData): Promise<Task> {
    return this.db.task.update({ where: { id }, data });
  }

  /**
   * Delete a task by id.
   *
   * @param id Task UUID.
   * @returns A promise that resolves once the row is deleted.
   */
  async delete(id: string): Promise<void> {
    await this.db.task.delete({ where: { id } });
  }

  /**
   * List tasks the caller can see (owned OR assigned), filtered + paginated.
   * Runs the page query and count in one transaction for a consistent total.
   *
   * @param params User scope, optional filters, and pagination.
   * @returns The page of tasks and the total matching count.
   */
  async listForUser(params: ListTasksParams): Promise<TaskPage> {
    const where = this.buildWhere(params);
    const [items, total] = await this.db.$transaction([
      this.db.task.findMany({
        where,
        skip: (params.page - 1) * params.limit,
        take: params.limit,
        orderBy: { createdAt: 'desc' },
      }),
      this.db.task.count({ where }),
    ]);
    return { items, total };
  }

  /**
   * Build the scoped, filtered where-clause for list queries.
   *
   * @param params User scope and optional status/priority filters.
   * @returns A Prisma where input scoped to owned-or-assigned tasks.
   */
  private buildWhere(params: ListTasksParams): Prisma.TaskWhereInput {
    return {
      OR: [{ ownerId: params.userId }, { assigneeId: params.userId }],
      ...(params.status !== undefined && { status: params.status }),
      ...(params.priority !== undefined && { priority: params.priority }),
    };
  }
}
