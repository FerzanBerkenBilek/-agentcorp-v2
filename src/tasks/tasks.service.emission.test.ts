import type { Task } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskEvent, TaskEventPublisher } from '../shared/task-events';
import type { UsersRepository } from '../users/users.repository';
import type { TasksRepository } from './tasks.repository';
import { TasksService } from './tasks.service';
import type { CreateTaskInput, UpdateTaskInput } from './tasks.schemas';

/**
 * Unit tests for the TasksService -> TaskEventPublisher emission seam (ADR-025 /
 * R14 / R15). Verifies that each successful mutation publishes exactly one event
 * with the correct type, a `toTaskResponse`-shaped task, and an ISO8601
 * timestamp; that delete publishes the pre-delete snapshot; and that the NOOP
 * default never throws (the regression guard that keeps the 197 prior tests
 * green). Repositories are mocked; the publisher is a spy.
 */

const CALLER = 'caller-1111';
const ASSIGNEE = 'assignee-3333';
const TASK_ID = 'task-aaaa';

/** Build a Task row owned by CALLER unless overridden. */
function makeTask(overrides: Partial<Task> = {}): Task {
  const now = new Date('2026-06-10T12:00:00.000Z');
  return {
    id: TASK_ID,
    title: 'Test task',
    description: null,
    status: 'TODO',
    priority: 'MEDIUM',
    ownerId: CALLER,
    assigneeId: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeMocks(publisher?: TaskEventPublisher): {
  service: TasksService;
  tasksMock: Record<string, ReturnType<typeof vi.fn>>;
  usersMock: { existsById: ReturnType<typeof vi.fn> };
} {
  const tasksMock = {
    findById: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn().mockResolvedValue(undefined),
    listForUser: vi.fn(),
  };
  const usersMock = { existsById: vi.fn().mockResolvedValue(true) };
  const service = new TasksService(
    tasksMock as unknown as TasksRepository,
    usersMock as unknown as UsersRepository,
    publisher,
  );
  return { service, tasksMock, usersMock };
}

/** ISO8601 with millisecond precision and trailing Z. */
const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

describe('TasksService emission (ADR-025 / R14)', () => {
  let publish: ReturnType<typeof vi.fn>;
  let publisher: TaskEventPublisher;

  beforeEach(() => {
    publish = vi.fn();
    publisher = { publish };
  });

  it('should_publish_task_created_after_a_successful_create', async () => {
    const created = makeTask();
    const { service, tasksMock } = makeMocks(publisher);
    tasksMock.create.mockResolvedValue(created);
    const input: CreateTaskInput = { title: 'New task' };

    await service.create(CALLER, input);

    expect(publish).toHaveBeenCalledOnce();
    const event = publish.mock.calls[0][0] as TaskEvent;
    expect(event.type).toBe('task.created');
    // R14: the task carries the exact toTaskResponse wire shape (Dates -> ISO).
    expect(event.task).toEqual({
      id: TASK_ID,
      title: 'Test task',
      description: null,
      status: 'TODO',
      priority: 'MEDIUM',
      ownerId: CALLER,
      assigneeId: null,
      createdAt: '2026-06-10T12:00:00.000Z',
      updatedAt: '2026-06-10T12:00:00.000Z',
    });
    expect(event.timestamp).toMatch(ISO_8601);
  });

  it('should_publish_task_updated_after_a_successful_update', async () => {
    const existing = makeTask();
    const updated = makeTask({ title: 'Updated', status: 'IN_PROGRESS' });
    const { service, tasksMock } = makeMocks(publisher);
    tasksMock.findById.mockResolvedValue(existing);
    tasksMock.update.mockResolvedValue(updated);
    const input: UpdateTaskInput = { title: 'Updated', status: 'IN_PROGRESS' };

    await service.update(CALLER, TASK_ID, input);

    expect(publish).toHaveBeenCalledOnce();
    const event = publish.mock.calls[0][0] as TaskEvent;
    expect(event.type).toBe('task.updated');
    expect(event.task.title).toBe('Updated');
    expect(event.task.status).toBe('IN_PROGRESS');
  });

  it('should_publish_task_deleted_with_the_pre_delete_snapshot_R15', async () => {
    // R15: delete publishes the row fetched BEFORE deletion (owner + assignee),
    // so the fan-out can authorize a row that no longer exists.
    const existing = makeTask({ assigneeId: ASSIGNEE });
    const { service, tasksMock } = makeMocks(publisher);
    tasksMock.findById.mockResolvedValue(existing);

    await service.delete(CALLER, TASK_ID);

    expect(publish).toHaveBeenCalledOnce();
    const event = publish.mock.calls[0][0] as TaskEvent;
    expect(event.type).toBe('task.deleted');
    expect(event.task.id).toBe(TASK_ID);
    expect(event.task.ownerId).toBe(CALLER);
    expect(event.task.assigneeId).toBe(ASSIGNEE);
  });

  it('should_not_publish_when_create_validation_fails', async () => {
    const { service, tasksMock, usersMock } = makeMocks(publisher);
    usersMock.existsById.mockResolvedValue(false);
    const input: CreateTaskInput = { title: 'New', assigneeId: ASSIGNEE };

    await expect(service.create(CALLER, input)).rejects.toThrow();

    expect(tasksMock.create).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it('should_not_publish_when_delete_authorization_fails', async () => {
    const { service, tasksMock } = makeMocks(publisher);
    // A non-owner attempts delete -> assertIsOwner throws before any emit.
    tasksMock.findById.mockResolvedValue(makeTask({ ownerId: 'someone-else' }));

    await expect(service.delete(CALLER, TASK_ID)).rejects.toThrow();

    expect(tasksMock.delete).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });
});

describe('TasksService emission — NOOP default (regression guard)', () => {
  it('should_not_throw_on_mutation_when_no_publisher_is_injected', async () => {
    // The two-arg constructor uses NOOP_PUBLISHER; this is what keeps the 197
    // pre-existing tests (which never pass a hub) green.
    const { service, tasksMock } = makeMocks(); // no publisher arg
    tasksMock.create.mockResolvedValue(makeTask());

    await expect(service.create(CALLER, { title: 'X' })).resolves.toBeDefined();
  });
});
