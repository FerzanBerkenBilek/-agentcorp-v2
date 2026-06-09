import type { Task } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NotFoundError, ValidationError } from '../shared/errors';
import type { UsersRepository } from '../users/users.repository';
import type { TasksRepository } from './tasks.repository';
import { TasksService } from './tasks.service';
import type { CreateTaskInput, UpdateTaskInput } from './tasks.schemas';

/**
 * Unit tests for TasksService.
 *
 * Mocks ONLY the two repositories. The real tasks.policy is exercised through
 * the service (never mocked) so authorization decisions are tested for real.
 */

const CALLER = 'caller-id-1111';
const OTHER = 'other-id-2222';
const ASSIGNEE = 'assignee-id-3333';
const TASK_ID = 'task-id-aaaa';

/** Build a Task row owned by `ownerId`, optionally assigned. */
function makeTask(overrides: Partial<Task> = {}): Task {
  const now = new Date();
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

function makeMocks(): {
  service: TasksService;
  tasksMock: {
    findById: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
    listForUser: ReturnType<typeof vi.fn>;
  };
  usersMock: { existsById: ReturnType<typeof vi.fn> };
} {
  const tasksMock = {
    findById: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn().mockResolvedValue(undefined),
    listForUser: vi.fn(),
  };
  const usersMock = { existsById: vi.fn() };
  const service = new TasksService(
    tasksMock as unknown as TasksRepository,
    usersMock as unknown as UsersRepository,
  );
  return { service, tasksMock, usersMock };
}

describe('TasksService.create', () => {
  let m: ReturnType<typeof makeMocks>;
  beforeEach(() => {
    m = makeMocks();
  });

  it('should_set_ownerId_from_caller_userId', async () => {
    // Even if a client somehow supplied an ownerId, it is ignored: the service
    // takes ownership only from the authenticated caller id.
    m.tasksMock.create.mockResolvedValue(makeTask());
    const input = { title: 'New task', ownerId: OTHER } as unknown as CreateTaskInput;

    await m.service.create(CALLER, input);

    expect(m.tasksMock.create).toHaveBeenCalledOnce();
    expect(m.tasksMock.create.mock.calls[0][0].ownerId).toBe(CALLER);
  });

  it('should_throw_ValidationError_when_assigneeId_does_not_exist', async () => {
    m.usersMock.existsById.mockResolvedValue(false);
    const input: CreateTaskInput = { title: 'New task', assigneeId: ASSIGNEE };

    await expect(m.service.create(CALLER, input)).rejects.toBeInstanceOf(ValidationError);
    expect(m.tasksMock.create).not.toHaveBeenCalled();
  });

  it('should_create_when_assigneeId_exists', async () => {
    m.usersMock.existsById.mockResolvedValue(true);
    m.tasksMock.create.mockResolvedValue(makeTask({ assigneeId: ASSIGNEE }));
    const input: CreateTaskInput = { title: 'New task', assigneeId: ASSIGNEE };

    const result = await m.service.create(CALLER, input);

    expect(m.usersMock.existsById).toHaveBeenCalledWith(ASSIGNEE);
    expect(result.assigneeId).toBe(ASSIGNEE);
  });
});

describe('TasksService.list', () => {
  let m: ReturnType<typeof makeMocks>;
  beforeEach(() => {
    m = makeMocks();
  });

  it('should_paginate_tasks_with_default_page_and_limit', async () => {
    m.tasksMock.listForUser.mockResolvedValue({ items: [makeTask()], total: 1 });

    const result = await m.service.list(CALLER, { page: 1, limit: 20 });

    expect(m.tasksMock.listForUser).toHaveBeenCalledWith(
      expect.objectContaining({ userId: CALLER, page: 1, limit: 20 }),
    );
    expect(result.pageInfo).toEqual({ page: 1, limit: 20, total: 1, totalPages: 1 });
  });

  it('should_compute_totalPages_from_total_and_limit', async () => {
    m.tasksMock.listForUser.mockResolvedValue({ items: [], total: 45 });

    const result = await m.service.list(CALLER, { page: 2, limit: 20 });

    expect(result.pageInfo.totalPages).toBe(3);
  });

  it('should_filter_tasks_by_status', async () => {
    m.tasksMock.listForUser.mockResolvedValue({ items: [], total: 0 });

    await m.service.list(CALLER, { page: 1, limit: 20, status: 'DONE' });

    expect(m.tasksMock.listForUser).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'DONE', priority: undefined }),
    );
  });

  it('should_filter_tasks_by_priority', async () => {
    m.tasksMock.listForUser.mockResolvedValue({ items: [], total: 0 });

    await m.service.list(CALLER, { page: 1, limit: 20, priority: 'HIGH' });

    expect(m.tasksMock.listForUser).toHaveBeenCalledWith(
      expect.objectContaining({ priority: 'HIGH', status: undefined }),
    );
  });

  it('should_filter_tasks_by_status_and_priority', async () => {
    m.tasksMock.listForUser.mockResolvedValue({ items: [], total: 0 });

    await m.service.list(CALLER, {
      page: 1,
      limit: 20,
      status: 'IN_PROGRESS',
      priority: 'URGENT',
    });

    expect(m.tasksMock.listForUser).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'IN_PROGRESS', priority: 'URGENT' }),
    );
  });
});

describe('TasksService.getById (real policy)', () => {
  let m: ReturnType<typeof makeMocks>;
  beforeEach(() => {
    m = makeMocks();
  });

  it('should_return_task_when_caller_is_owner', async () => {
    m.tasksMock.findById.mockResolvedValue(makeTask({ ownerId: CALLER }));

    const result = await m.service.getById(CALLER, TASK_ID);

    expect(result.id).toBe(TASK_ID);
  });

  it('should_throw_NotFoundError_when_caller_is_neither_owner_nor_assignee', async () => {
    m.tasksMock.findById.mockResolvedValue(makeTask({ ownerId: OTHER, assigneeId: null }));

    await expect(m.service.getById(CALLER, TASK_ID)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('TasksService.update (real policy)', () => {
  let m: ReturnType<typeof makeMocks>;
  beforeEach(() => {
    m = makeMocks();
  });

  it('should_allow_assignee_to_update_status', async () => {
    m.tasksMock.findById.mockResolvedValue(
      makeTask({ ownerId: OTHER, assigneeId: CALLER }),
    );
    m.tasksMock.update.mockResolvedValue(makeTask({ status: 'DONE' }));

    const result = await m.service.update(CALLER, TASK_ID, { status: 'DONE' });

    expect(result.status).toBe('DONE');
  });

  it('should_throw_NotFoundError_when_non_owner_non_assignee_updates', async () => {
    m.tasksMock.findById.mockResolvedValue(makeTask({ ownerId: OTHER, assigneeId: null }));

    await expect(
      m.service.update(CALLER, TASK_ID, { status: 'DONE' }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('should_throw_NotFoundError_when_assignee_tries_to_reassign', async () => {
    // Reassign (assigneeId in payload) is owner-only; assignee is rejected.
    m.tasksMock.findById.mockResolvedValue(
      makeTask({ ownerId: OTHER, assigneeId: CALLER }),
    );
    const input: UpdateTaskInput = { assigneeId: ASSIGNEE };

    await expect(m.service.update(CALLER, TASK_ID, input)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect(m.tasksMock.update).not.toHaveBeenCalled();
  });

  it('should_validate_new_assignee_exists_when_owner_reassigns', async () => {
    m.tasksMock.findById.mockResolvedValue(makeTask({ ownerId: CALLER }));
    m.usersMock.existsById.mockResolvedValue(false);
    const input: UpdateTaskInput = { assigneeId: ASSIGNEE };

    await expect(m.service.update(CALLER, TASK_ID, input)).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('should_never_include_ownerId_in_the_update_data', async () => {
    m.tasksMock.findById.mockResolvedValue(makeTask({ ownerId: CALLER }));
    m.tasksMock.update.mockResolvedValue(makeTask());
    const input = { title: 'Renamed', ownerId: OTHER } as unknown as UpdateTaskInput;

    await m.service.update(CALLER, TASK_ID, input);

    const updateData = m.tasksMock.update.mock.calls[0][1];
    expect(updateData).not.toHaveProperty('ownerId');
    expect(updateData).toHaveProperty('title', 'Renamed');
  });

  it('should_allow_owner_to_unassign_by_setting_assigneeId_null', async () => {
    m.tasksMock.findById.mockResolvedValue(makeTask({ ownerId: CALLER, assigneeId: ASSIGNEE }));
    m.tasksMock.update.mockResolvedValue(makeTask({ assigneeId: null }));

    await m.service.update(CALLER, TASK_ID, { assigneeId: null });

    // Unassign is owner-only and must NOT trigger an existence check on null.
    expect(m.usersMock.existsById).not.toHaveBeenCalled();
    expect(m.tasksMock.update.mock.calls[0][1]).toHaveProperty('assigneeId', null);
  });
});

describe('TasksService.delete (real policy)', () => {
  let m: ReturnType<typeof makeMocks>;
  beforeEach(() => {
    m = makeMocks();
  });

  it('should_allow_owner_to_delete', async () => {
    m.tasksMock.findById.mockResolvedValue(makeTask({ ownerId: CALLER }));

    await m.service.delete(CALLER, TASK_ID);

    expect(m.tasksMock.delete).toHaveBeenCalledWith(TASK_ID);
  });

  it('should_throw_NotFoundError_when_non_owner_tries_to_delete', async () => {
    m.tasksMock.findById.mockResolvedValue(makeTask({ ownerId: OTHER, assigneeId: CALLER }));

    await expect(m.service.delete(CALLER, TASK_ID)).rejects.toBeInstanceOf(NotFoundError);
    expect(m.tasksMock.delete).not.toHaveBeenCalled();
  });

  it('should_throw_NotFoundError_when_task_missing', async () => {
    m.tasksMock.findById.mockResolvedValue(null);

    await expect(m.service.delete(CALLER, TASK_ID)).rejects.toBeInstanceOf(NotFoundError);
  });
});
