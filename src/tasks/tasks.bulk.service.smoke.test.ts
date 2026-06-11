import type { Task } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UsersRepository } from '../users/users.repository';
import type { TasksRepository } from './tasks.repository';
import { BULK_FAILURE_REASON, TasksService } from './tasks.service';
import type { BulkCreateInput, BulkDeleteInput, BulkUpdateInput } from './tasks.schemas';

/**
 * Backend-dev smoke for the bulk service methods (BULK-2026-06-11). Proves the
 * load-bearing security properties (ADR-042: H3 NOT_FOUND collapse, H4 INTERNAL
 * mapping + sink, M2 duplicate handling, create index id). The exhaustive
 * matrix + route integration coverage is owned by qa-engineer.
 */

const CALLER = 'caller-1111';
const OTHER = 'other-2222';

function makeTask(overrides: Partial<Task> = {}): Task {
  const now = new Date();
  return {
    id: 'task-aaaa',
    title: 'T',
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

function makeMocks() {
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

describe('TasksService.bulkCreate', () => {
  let m: ReturnType<typeof makeMocks>;
  beforeEach(() => {
    m = makeMocks();
  });

  it('should_use_array_index_as_id_for_create_failures', async () => {
    // item 0 succeeds; item 1 has a missing assignee -> VALIDATION at index "1".
    m.tasksMock.create.mockResolvedValueOnce(makeTask());
    m.usersMock.existsById.mockResolvedValue(false);
    const input: BulkCreateInput = {
      items: [{ title: 'ok' }, { title: 'bad', assigneeId: '11111111-1111-1111-1111-111111111111' }],
    };
    const { outcomes } = await m.service.bulkCreate(CALLER, input);
    expect(outcomes[0].task).toBeDefined();
    expect(outcomes[1].reason).toBe(BULK_FAILURE_REASON.VALIDATION);
    expect(outcomes[1].id).toBe('1');
  });

  it('should_route_unmapped_errors_to_INTERNAL_and_sink', async () => {
    m.tasksMock.create.mockRejectedValueOnce(new Error('prisma exploded: column x'));
    const sink = vi.fn();
    const { outcomes } = await m.service.bulkCreate(CALLER, { items: [{ title: 'x' }] }, sink);
    expect(outcomes[0].reason).toBe(BULK_FAILURE_REASON.INTERNAL);
    // H4: the raw error is sunk server-side, never returned as reason text.
    expect(sink).toHaveBeenCalledOnce();
    expect(JSON.stringify(outcomes)).not.toContain('prisma exploded');
  });
});

describe('TasksService.bulkUpdate', () => {
  let m: ReturnType<typeof makeMocks>;
  beforeEach(() => {
    m = makeMocks();
  });

  it('should_collapse_missing_and_foreign_to_identical_NOT_FOUND', async () => {
    // id A: row missing. id B: row exists but owned by OTHER.
    m.tasksMock.findById.mockImplementation(async (id: string) =>
      id === 'B' ? makeTask({ id: 'B', ownerId: OTHER }) : null,
    );
    const input: BulkUpdateInput = {
      items: [
        { id: 'A', title: 'x' },
        { id: 'B', title: 'y' },
      ],
    };
    const { outcomes } = await m.service.bulkUpdate(CALLER, input);
    expect(outcomes[0].reason).toBe(BULK_FAILURE_REASON.NOT_FOUND);
    expect(outcomes[1].reason).toBe(BULK_FAILURE_REASON.NOT_FOUND);
    // byte-identical tokens — no missing-vs-foreign distinction (ADR-042/H3).
    expect(outcomes[0].reason).toBe(outcomes[1].reason);
  });
});

describe('TasksService.bulkDelete', () => {
  let m: ReturnType<typeof makeMocks>;
  beforeEach(() => {
    m = makeMocks();
  });

  it('should_report_duplicate_second_occurrence_as_NOT_FOUND', async () => {
    // First delete succeeds; the row is then gone -> second occurrence NOT_FOUND (M2).
    let deleted = false;
    m.tasksMock.findById.mockImplementation(async () => (deleted ? null : makeTask()));
    m.tasksMock.delete.mockImplementation(async () => {
      deleted = true;
    });
    const input: BulkDeleteInput = { ids: ['task-aaaa', 'task-aaaa'] };
    const { outcomes } = await m.service.bulkDelete(CALLER, input);
    expect(outcomes[0].task).toBeDefined();
    expect(outcomes[1].reason).toBe(BULK_FAILURE_REASON.NOT_FOUND);
  });
});
