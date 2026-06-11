import { Task } from '@prisma/client';
import { NotFoundError, ValidationError } from '../shared/errors';
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
import {
  BulkCreateInput,
  BulkDeleteInput,
  BulkUpdateInput,
  BulkUpdateItem,
  CreateTaskInput,
  ListTasksQuery,
  UpdateTaskInput,
} from './tasks.schemas';

/**
 * Closed, safe-token enum for a per-item bulk failure (ADR-042 / H3).
 *
 * This is a machine CODE, never a sentence, never an `err.message`. `NOT_FOUND`
 * deliberately collapses "row missing" and "caller not owner/assignee" into ONE
 * indistinguishable token so a 50-id batch cannot become an existence/ownership
 * enumeration oracle (extends ADR-013 404-not-403 to the per-item channel).
 */
export const BULK_FAILURE_REASON = {
  NOT_FOUND: 'NOT_FOUND',
  VALIDATION: 'VALIDATION',
  INTERNAL: 'INTERNAL',
} as const;

export type BulkFailureReason =
  (typeof BULK_FAILURE_REASON)[keyof typeof BULK_FAILURE_REASON];

/** A single per-item failure in a bulk response (ADR-042). */
export interface BulkFailure {
  /** The item's identifier: the task id (update/delete) or the array index (create). */
  id: string;
  /** The safe-token reason (H3/H4). */
  reason: BulkFailureReason;
}

/**
 * Outcome of one item in a bulk batch — carries enough for the route to emit a
 * per-item audit line (L1) without re-deriving any business state. On success
 * `task` is set; on failure `reason` is set. They are mutually exclusive.
 */
export interface BulkItemOutcome {
  /** Item identifier (task id, or create-array index as a string). */
  id: string;
  /** The created/updated task when the item succeeded. */
  task?: Task;
  /** The safe-token reason when the item failed (H3/H4). */
  reason?: BulkFailureReason;
}

/**
 * Aggregated result of a bulk operation (partial success, no rollback). The
 * route splits `outcomes` into the `{ succeeded, failed }` wire shape and emits
 * one audit line per outcome (L1).
 */
export interface BulkResult {
  outcomes: BulkItemOutcome[];
}

/**
 * Server-side sink for unexpected (INTERNAL) per-item errors (H4). The service
 * is framework-agnostic (ADR-010) and owns no logger, so the route injects this
 * to wire `request.log.error`. The full error is logged server-side; only the
 * flat `INTERNAL` token ever crosses the response boundary.
 */
export type InternalErrorSink = (error: unknown, itemId: string) => void;

/** Default no-op sink so the service and existing tests run without a logger. */
const NOOP_INTERNAL_SINK: InternalErrorSink = () => {
  /* intentionally empty: logging is wired at the route boundary (H4) */
};

/**
 * Strip the routing `id` from a bulk-update element, yielding the exact
 * `UpdateTaskInput` the reused single-task {@link TasksService.update} path
 * expects. Key PRESENCE is preserved (notably `assigneeId`), so the reused
 * path's `'assigneeId' in input` reassign-detection (H1) still fires identically.
 *
 * @param item A validated bulk-update element ({ id } + partial update).
 * @returns The partial update with `id` removed.
 */
function toUpdatePayload(item: BulkUpdateItem): UpdateTaskInput {
  const { id: _id, ...update } = item;
  return update as UpdateTaskInput;
}

/**
 * Map an arbitrary per-item error to a safe-token reason by TYPE (ADR-042 / H3 /
 * H4). Never inspects `err.message`. `NotFoundError -> NOT_FOUND` (missing OR
 * unauthorized — indistinguishable), `ValidationError -> VALIDATION` (flat
 * token, never the assignee-existence field text), anything else -> `INTERNAL`.
 *
 * @param error The error thrown by the reused per-item service path.
 * @returns The closed-enum reason token.
 */
function toBulkFailureReason(error: unknown): BulkFailureReason {
  if (error instanceof NotFoundError) {
    return BULK_FAILURE_REASON.NOT_FOUND;
  }
  if (error instanceof ValidationError) {
    return BULK_FAILURE_REASON.VALIDATION;
  }
  return BULK_FAILURE_REASON.INTERNAL;
}

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
   * @returns The deleted task's last-known snapshot (the row is now gone). Single-
   *   task callers may ignore it (204 No Content); bulk-delete serializes it so
   *   its `succeeded[]` stays a uniform `TaskResponse[]`.
   * @throws NotFoundError if missing or the caller is not the owner (H1).
   */
  async delete(userId: string, taskId: string): Promise<Task> {
    const existing = await this.tasks.findById(taskId);
    const task = assertIsOwner(existing, userId);
    await this.tasks.delete(taskId);
    // R15: publish the deleted task's last-known shape (the row is now gone) so
    // the fan-out can authorize owner/assignee against that snapshot.
    this.emit('task.deleted', task);
    return task;
  }

  /**
   * Bulk-create up to 50 tasks for the caller (partial success, no rollback).
   * Each element is run through the EXISTING {@link create} path verbatim (H2):
   * ownerId is server-set from the JWT, assignee existence is validated. A failed
   * element does not affect the others. Create items have no client id, so the
   * failure identifier is the element's ARRAY INDEX (as a string) — see ADR-042.
   *
   * @param userId Authenticated caller (becomes every task's ownerId).
   * @param input Validated batch (1..50 createTaskSchema elements; cap enforced pre-DB, M1).
   * @param onInternalError Sink for unmapped errors (route wires request.log.error, H4).
   * @returns Per-item outcomes for response splitting + per-item audit (L1).
   */
  async bulkCreate(
    userId: string,
    input: BulkCreateInput,
    onInternalError: InternalErrorSink = NOOP_INTERNAL_SINK,
  ): Promise<BulkResult> {
    const outcomes = await this.runEach(input.items, (item, index) =>
      this.runItem(String(index), () => this.create(userId, item), onInternalError),
    );
    return { outcomes };
  }

  /**
   * Bulk-update up to 50 tasks (partial success, no rollback). Each element runs
   * through the EXISTING {@link update} path verbatim (H1): per-item
   * assertCanAccess, plus assertIsOwner when the element reassigns. A
   * missing/foreign id lands in `failed` as NOT_FOUND, indistinguishable from a
   * nonexistent one (ADR-042). Duplicate ids are processed independently; the
   * second occurrence naturally yields NOT_FOUND after the first mutation (M2).
   *
   * @param userId Authenticated caller.
   * @param input Validated batch (1..50 { id } + updateTaskSchema elements).
   * @param onInternalError Sink for unmapped errors (H4).
   * @returns Per-item outcomes (identified by task id).
   */
  async bulkUpdate(
    userId: string,
    input: BulkUpdateInput,
    onInternalError: InternalErrorSink = NOOP_INTERNAL_SINK,
  ): Promise<BulkResult> {
    const outcomes = await this.runEach(input.items, (item) =>
      this.runItem(item.id, () => this.update(userId, item.id, toUpdatePayload(item)), onInternalError),
    );
    return { outcomes };
  }

  /**
   * Bulk-delete up to 50 tasks (partial success, no rollback). Each id runs
   * through the EXISTING {@link delete} path verbatim (H1): owner-only
   * assertIsOwner. Missing/foreign ids yield NOT_FOUND, indistinguishable
   * (ADR-042). A duplicate id's second occurrence yields NOT_FOUND (M2). On
   * success the deleted task's id is reported (no body), so the outcome carries
   * the id but no task.
   *
   * @param userId Authenticated caller.
   * @param input Validated batch (1..50 uuids).
   * @param onInternalError Sink for unmapped errors (H4).
   * @returns Per-item outcomes (identified by task id; no task body on success).
   */
  async bulkDelete(
    userId: string,
    input: BulkDeleteInput,
    onInternalError: InternalErrorSink = NOOP_INTERNAL_SINK,
  ): Promise<BulkResult> {
    const outcomes = await this.runEach(input.ids, (id) =>
      this.runItem(id, () => this.delete(userId, id), onInternalError),
    );
    return { outcomes };
  }

  /**
   * Run an async per-item mapper over a batch SEQUENTIALLY, preserving order.
   * Sequential execution keeps duplicate-id semantics deterministic (M2: the
   * second occurrence sees the first's effect) and bounds concurrent DB load.
   *
   * @param items The validated batch elements.
   * @param mapItem Maps one element (and its index) to its outcome; never throws.
   * @returns The ordered outcome list.
   */
  private async runEach<T>(
    items: readonly T[],
    mapItem: (item: T, index: number) => Promise<BulkItemOutcome>,
  ): Promise<BulkItemOutcome[]> {
    const outcomes: BulkItemOutcome[] = [];
    for (let index = 0; index < items.length; index += 1) {
      outcomes.push(await mapItem(items[index], index));
    }
    return outcomes;
  }

  /**
   * Run one create/update item: on success return the task; on failure map the
   * error to a safe-token reason (H3) and, when INTERNAL, push the full error to
   * the sink for server-side logging (H4). Never throws.
   *
   * @param id The item identifier (task id, or create-array index as a string).
   * @param run The reused single-task service call producing a Task.
   * @param onInternalError Sink invoked with the raw error for INTERNAL failures.
   * @returns A success or failure outcome.
   */
  private async runItem(
    id: string,
    run: () => Promise<Task>,
    onInternalError: InternalErrorSink,
  ): Promise<BulkItemOutcome> {
    try {
      return { id, task: await run() };
    } catch (error) {
      return { id, reason: this.classify(error, id, onInternalError) };
    }
  }

  /**
   * Classify a per-item error into a safe-token reason and route unexpected
   * errors to the server-side sink (H4). Keeps the leak decision in one place.
   *
   * @param error The thrown error.
   * @param id The item id (logged server-side only, never returned in detail).
   * @param onInternalError The server-side error sink.
   * @returns The closed-enum reason token (H3).
   */
  private classify(
    error: unknown,
    id: string,
    onInternalError: InternalErrorSink,
  ): BulkFailureReason {
    const reason = toBulkFailureReason(error);
    if (reason === BULK_FAILURE_REASON.INTERNAL) {
      onInternalError(error, id);
    }
    return reason;
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
