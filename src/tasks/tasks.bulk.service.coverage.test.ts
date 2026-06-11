import type { Task } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UsersRepository } from '../users/users.repository';
import type { TasksRepository } from './tasks.repository';
import { BULK_FAILURE_REASON, TasksService } from './tasks.service';

/**
 * QA coverage-gap closers for the bulk service methods (BULK-2026-06-11).
 *
 * Complements backend-dev's smoke + the route-integration suite. Specifically
 * exercises the DEFAULT no-op internal-error sink path (the service is called
 * WITHOUT a sink, as a direct service consumer may do) so an INTERNAL per-item
 * failure still classifies safely to the closed `INTERNAL` token and never
 * throws — proving the H4 mapping holds even when no logger is wired.
 */

function makeTask(overrides: Partial<Task> = {}): Task {
  const now = new Date();
  return {
    id: 'task-aaaa',
    title: 'T',
    description: null,
    status: 'TODO',
    priority: 'MEDIUM',
    ownerId: 'caller-1',
    assigneeId: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeMocks() {
  const tasksMock = {
    findById: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    listForUser: vi.fn(),
  };
  const usersMock = { existsById: vi.fn() };
  const service = new TasksService(
    tasksMock as unknown as TasksRepository,
    usersMock as unknown as UsersRepository,
  );
  return { service, tasksMock, usersMock };
}

describe('TasksService bulk — default no-op sink (H4 mapping without a logger)', () => {
  let m: ReturnType<typeof makeMocks>;
  beforeEach(() => {
    m = makeMocks();
  });

  it('should_classify_INTERNAL_via_the_default_sink_when_none_is_provided_on_bulkCreate', async () => {
    // No sink argument -> the module-default NOOP_INTERNAL_SINK is used. An
    // unexpected repo error must still map to INTERNAL and not propagate.
    m.tasksMock.create.mockRejectedValueOnce(new Error('unexpected repo failure'));
    const { outcomes } = await m.service.bulkCreate('caller-1', { items: [{ title: 'x' }] });
    expect(outcomes[0].reason).toBe(BULK_FAILURE_REASON.INTERNAL);
    expect(JSON.stringify(outcomes)).not.toContain('unexpected repo failure');
  });

  it('should_classify_INTERNAL_via_the_default_sink_on_bulkUpdate', async () => {
    m.tasksMock.findById.mockResolvedValue(makeTask());
    m.tasksMock.update.mockRejectedValueOnce(new Error('db down'));
    const { outcomes } = await m.service.bulkUpdate('caller-1', {
      items: [{ id: 'task-aaaa', title: 'y' }],
    });
    expect(outcomes[0].reason).toBe(BULK_FAILURE_REASON.INTERNAL);
  });

  it('should_classify_INTERNAL_via_the_default_sink_on_bulkDelete', async () => {
    m.tasksMock.findById.mockResolvedValue(makeTask());
    m.tasksMock.delete.mockRejectedValueOnce(new Error('db down'));
    const { outcomes } = await m.service.bulkDelete('caller-1', { ids: ['task-aaaa'] });
    expect(outcomes[0].reason).toBe(BULK_FAILURE_REASON.INTERNAL);
  });
});
