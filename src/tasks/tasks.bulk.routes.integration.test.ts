import { randomUUID } from 'crypto';
import jwt from 'jsonwebtoken';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { UserRole } from '@prisma/client';
import type { Task, User } from '@prisma/client';
import { createFakePrisma, type FakeStore } from '../test/fake-prisma';

/**
 * HTTP route-integration tests for the bulk task endpoints (BULK-2026-06-11).
 *
 * Builds the REAL Fastify app (routes -> service -> policy -> repository) with
 * ONLY the Prisma data layer faked, then drives the three bulk endpoints over
 * HTTP and asserts the full Gate-1 security contract at the wire boundary:
 *   - M1 request-level validation (empty / over-cap / non-array / unknown key) -> 422 pre-DB.
 *   - H3 non-enumeration: nonexistent and real-but-foreign ids return the SAME NOT_FOUND token.
 *   - H4 no-leak: an INTERNAL failure never leaks Prisma/stack/error text in the response.
 *   - M2 duplicate ids: the second occurrence is NOT_FOUND.
 *   - Partial success: mixed ok+fail is HTTP 200 with the correct {succeeded,failed} split.
 *   - bulk-create failure id = array index string; non-owner reassign -> per-item NOT_FOUND.
 *   - L1 per-item audit (one line per item, real outcome + resourceId).
 *   - H6 (fixed): PATCH /tasks/bulk-update with a valid {id, field} element round-trips end-to-end.
 *
 * The audit module is mocked so L1 per-item audit lines are inspectable (the
 * test-env pino logger is a no-op, so audit calls are otherwise unobservable).
 */

const fake = createFakePrisma();
vi.mock('../shared/prisma', () => ({
  prisma: fake.prisma,
  disconnectPrisma: async () => undefined,
}));

// L1: capture every audit line so per-item attribution is assertable. The real
// `audit()` just calls a no-op pino logger in test env, so we spy on it directly.
const auditSpy = vi.fn();
vi.mock('../shared/audit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../shared/audit')>();
  return { ...actual, audit: (...args: unknown[]) => auditSpy(...args) };
});

let app: FastifyInstance;
let store: FakeStore;

const OWNER_ID = '11111111-1111-1111-1111-111111111111';
const ASSIGNEE_ID = '22222222-2222-2222-2222-222222222222';
const STRANGER_ID = '33333333-3333-3333-3333-333333333333';
// A syntactically valid UUID that is never seeded -> a "nonexistent" row.
const ABSENT_ID = '99999999-9999-9999-9999-999999999999';

/** Seed a user row directly into the fake store. */
function seedUser(id: string, email: string): void {
  const now = new Date();
  const row: User = {
    id,
    email,
    passwordHash: 'x',
    name: email,
    role: UserRole.USER,
    googleId: null,
    googleEmail: null,
    createdAt: now,
    updatedAt: now,
  };
  store.users.set(id, row);
}

/**
 * Seed a task row directly into the fake store and return its id. The id is a
 * real UUID so it satisfies the bulk schemas' `z.string().uuid()` element/id
 * validation (a non-UUID id would 422 at the request layer before any per-item
 * logic — exactly the request-level contract, but not what these tests target).
 */
function seedTask(ownerId: string, overrides: Partial<Task> = {}): string {
  const now = new Date();
  const id = overrides.id ?? randomUUID();
  const row: Task = {
    title: 'seeded',
    description: null,
    status: 'TODO',
    priority: 'MEDIUM',
    ownerId,
    assigneeId: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
    id,
  };
  store.tasks.set(row.id, row);
  return row.id;
}

/** Authorization header for a given user id (real HS256, same secret as the app). */
function authHeader(userId: string): { authorization: string } {
  const token = jwt.sign({ sub: userId }, process.env.JWT_SECRET!, {
    algorithm: 'HS256',
    expiresIn: '15m',
  });
  return { authorization: `Bearer ${token}` };
}

beforeEach(async () => {
  const { buildApp } = await import('../app');
  app = await buildApp();
  store = fake.store;
  store.users.clear();
  store.tasks.clear();
  store.refreshTokens.clear();
  auditSpy.mockClear();
  vi.restoreAllMocks();
  seedUser(OWNER_ID, 'owner@example.com');
  seedUser(ASSIGNEE_ID, 'assignee@example.com');
  seedUser(STRANGER_ID, 'stranger@example.com');
});

afterEach(async () => {
  await app.close();
});

// ---------------------------------------------------------------------------
// Group 1 — M1 request-level validation, fail-closed BEFORE any DB op.
// ---------------------------------------------------------------------------
describe('Group 1 — request-level validation (M1) returns 422 pre-DB', () => {
  it('should_return_422_when_bulk_create_items_array_is_empty', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/tasks/bulk-create',
      headers: authHeader(OWNER_ID),
      payload: { items: [] },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
    expect(store.tasks.size).toBe(0); // no DB write happened
  });

  it('should_return_422_when_bulk_create_exceeds_50_items', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/tasks/bulk-create',
      headers: authHeader(OWNER_ID),
      payload: { items: Array.from({ length: 51 }, (_, i) => ({ title: `t-${i}` })) },
    });
    expect(res.statusCode).toBe(422);
    expect(store.tasks.size).toBe(0);
  });

  it('should_return_422_when_bulk_create_body_items_is_not_an_array', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/tasks/bulk-create',
      headers: authHeader(OWNER_ID),
      payload: { items: 'not-an-array' },
    });
    expect(res.statusCode).toBe(422);
  });

  it('should_return_422_when_bulk_create_element_has_an_unknown_key', async () => {
    // .strict() element schema: an injected ownerId (mass-assignment, H2) is a 422.
    const res = await app.inject({
      method: 'POST',
      url: '/tasks/bulk-create',
      headers: authHeader(OWNER_ID),
      payload: { items: [{ title: 'ok', ownerId: STRANGER_ID }] },
    });
    expect(res.statusCode).toBe(422);
    expect(store.tasks.size).toBe(0);
  });

  it('should_return_422_when_bulk_update_items_array_is_empty', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/tasks/bulk-update',
      headers: authHeader(OWNER_ID),
      payload: { items: [] },
    });
    expect(res.statusCode).toBe(422);
  });

  it('should_return_422_when_bulk_update_exceeds_50_items', async () => {
    const items = Array.from({ length: 51 }, () => ({ id: ABSENT_ID, title: 'x' }));
    const res = await app.inject({
      method: 'PATCH',
      url: '/tasks/bulk-update',
      headers: authHeader(OWNER_ID),
      payload: { items },
    });
    expect(res.statusCode).toBe(422);
  });

  it('should_return_422_when_bulk_update_body_items_is_not_an_array', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/tasks/bulk-update',
      headers: authHeader(OWNER_ID),
      payload: { items: { id: ABSENT_ID, title: 'x' } },
    });
    expect(res.statusCode).toBe(422);
  });

  it('should_return_422_when_bulk_update_element_has_an_unknown_key', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/tasks/bulk-update',
      headers: authHeader(OWNER_ID),
      payload: { items: [{ id: ABSENT_ID, title: 'x', ownerId: STRANGER_ID }] },
    });
    expect(res.statusCode).toBe(422);
  });

  it('should_return_422_when_bulk_delete_ids_array_is_empty', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/tasks/bulk-delete',
      headers: authHeader(OWNER_ID),
      payload: { ids: [] },
    });
    expect(res.statusCode).toBe(422);
  });

  it('should_return_422_when_bulk_delete_exceeds_50_ids', async () => {
    const ids = Array.from({ length: 51 }, () => ABSENT_ID);
    const res = await app.inject({
      method: 'DELETE',
      url: '/tasks/bulk-delete',
      headers: authHeader(OWNER_ID),
      payload: { ids },
    });
    expect(res.statusCode).toBe(422);
  });

  it('should_return_422_when_bulk_delete_body_ids_is_not_an_array', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/tasks/bulk-delete',
      headers: authHeader(OWNER_ID),
      payload: { ids: ABSENT_ID },
    });
    expect(res.statusCode).toBe(422);
  });

  it('should_return_422_when_bulk_delete_id_is_not_a_uuid', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/tasks/bulk-delete',
      headers: authHeader(OWNER_ID),
      payload: { ids: ['not-a-uuid'] },
    });
    expect(res.statusCode).toBe(422);
  });

  it('should_return_422_when_bulk_delete_body_has_an_unknown_top_level_key', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/tasks/bulk-delete',
      headers: authHeader(OWNER_ID),
      payload: { ids: [ABSENT_ID], extra: 'nope' },
    });
    expect(res.statusCode).toBe(422);
  });

  it('should_return_401_when_no_bearer_token_on_a_bulk_endpoint', async () => {
    // Auth gate fires before validation: an unauthenticated bulk call never
    // reaches the schema or the DB.
    const res = await app.inject({
      method: 'POST',
      url: '/tasks/bulk-create',
      payload: { items: [{ title: 'x' }] },
    });
    expect(res.statusCode).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Group 2 — H3 non-enumeration: nonexistent vs real-but-foreign -> IDENTICAL token.
// ---------------------------------------------------------------------------
describe('Group 2 — H3 non-enumeration (identical NOT_FOUND token)', () => {
  it('should_return_identical_NOT_FOUND_for_nonexistent_and_foreign_ids_on_bulk_update', async () => {
    const foreignId = seedTask(STRANGER_ID); // real row, owned by someone else
    const res = await app.inject({
      method: 'PATCH',
      url: '/tasks/bulk-update',
      headers: authHeader(OWNER_ID),
      payload: {
        items: [
          { id: ABSENT_ID, title: 'x' },
          { id: foreignId, title: 'y' },
        ],
      },
    });

    expect(res.statusCode).toBe(200);
    const failed = res.json().data.failed as Array<{ id: string; reason: string }>;
    expect(failed).toHaveLength(2);
    const absent = failed.find((f) => f.id === ABSENT_ID)!;
    const foreign = failed.find((f) => f.id === foreignId)!;
    // Byte-identical token — no FORBIDDEN / distinct code distinguishes them.
    expect(absent.reason).toBe('NOT_FOUND');
    expect(foreign.reason).toBe('NOT_FOUND');
    expect(absent.reason).toBe(foreign.reason);
    // No oracle: the foreign row was NOT mutated.
    expect(store.tasks.get(foreignId)!.title).toBe('seeded');
    // No distinct FORBIDDEN/OWNER token anywhere in the body.
    expect(JSON.stringify(failed)).not.toMatch(/FORBIDDEN|OWNER|EXISTS/i);
  });

  it('should_return_identical_NOT_FOUND_for_nonexistent_and_foreign_ids_on_bulk_delete', async () => {
    const foreignId = seedTask(STRANGER_ID);
    const res = await app.inject({
      method: 'DELETE',
      url: '/tasks/bulk-delete',
      headers: authHeader(OWNER_ID),
      payload: { ids: [ABSENT_ID, foreignId] },
    });

    expect(res.statusCode).toBe(200);
    const failed = res.json().data.failed as Array<{ id: string; reason: string }>;
    expect(failed).toHaveLength(2);
    expect(failed.every((f) => f.reason === 'NOT_FOUND')).toBe(true);
    // The foreign row is still present — a non-owner cannot delete it.
    expect(store.tasks.has(foreignId)).toBe(true);
  });

  it('should_return_NOT_FOUND_not_403_when_assignee_attempts_bulk_delete_of_owners_task', async () => {
    // An assignee may read/update but NOT delete -> the per-item path throws
    // NotFoundError, collapsing to NOT_FOUND (never a distinct 403-style token).
    const taskId = seedTask(OWNER_ID, { assigneeId: ASSIGNEE_ID });
    const res = await app.inject({
      method: 'DELETE',
      url: '/tasks/bulk-delete',
      headers: authHeader(ASSIGNEE_ID),
      payload: { ids: [taskId] },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data.failed[0].reason).toBe('NOT_FOUND');
    expect(store.tasks.has(taskId)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Group 3 — H4 no-leak: an INTERNAL failure leaks no Prisma/stack/error text.
// ---------------------------------------------------------------------------
describe('Group 3 — H4 INTERNAL no-leak', () => {
  it('should_map_unexpected_repo_error_to_INTERNAL_without_leaking_detail', async () => {
    // Force a non-NotFound / non-Validation error from the repository layer.
    const secret = 'PRISMA-INTERNAL-COLUMN-x99-stacktrace-leak';
    vi.spyOn(fake.prisma.task, 'create').mockRejectedValueOnce(new Error(secret));

    const res = await app.inject({
      method: 'POST',
      url: '/tasks/bulk-create',
      headers: authHeader(OWNER_ID),
      payload: { items: [{ title: 'will-explode' }] },
    });

    expect(res.statusCode).toBe(200); // partial-success: the batch request itself succeeds
    const failed = res.json().data.failed as Array<{ id: string; reason: string }>;
    expect(failed).toHaveLength(1);
    expect(failed[0].reason).toBe('INTERNAL');
    // H4: the raw error text / stack / Prisma detail never reaches the client.
    const raw = res.payload;
    expect(raw).not.toContain(secret);
    expect(raw).not.toMatch(/stack|prisma|column/i);
  });

  it('should_still_return_200_when_every_item_fails_internally', async () => {
    vi.spyOn(fake.prisma.task, 'create').mockRejectedValue(new Error('boom'));
    const res = await app.inject({
      method: 'POST',
      url: '/tasks/bulk-create',
      headers: authHeader(OWNER_ID),
      payload: { items: [{ title: 'a' }, { title: 'b' }] },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json().data;
    expect(body.succeeded).toHaveLength(0);
    expect(body.failed).toHaveLength(2);
    expect(body.failed.every((f: { reason: string }) => f.reason === 'INTERNAL')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Group 4 — M2 duplicate ids: the second occurrence is NOT_FOUND.
// ---------------------------------------------------------------------------
describe('Group 4 — M2 duplicate ids within one batch', () => {
  it('should_report_duplicate_second_occurrence_as_NOT_FOUND_on_bulk_delete', async () => {
    const taskId = seedTask(OWNER_ID);
    const res = await app.inject({
      method: 'DELETE',
      url: '/tasks/bulk-delete',
      headers: authHeader(OWNER_ID),
      payload: { ids: [taskId, taskId] },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json().data;
    // First occurrence deletes; second sees a now-missing row -> NOT_FOUND.
    expect(body.succeeded).toHaveLength(1);
    expect(body.failed).toHaveLength(1);
    expect(body.failed[0].reason).toBe('NOT_FOUND');
    expect(store.tasks.has(taskId)).toBe(false);
  });

  it('should_apply_first_update_then_NOT_FOUND_when_duplicate_is_not_re_failing', async () => {
    // A duplicate id in bulk-update: both occurrences target an existing, owned
    // row, so BOTH succeed (update is idempotent against an existing row). This
    // proves duplicates are processed independently, not deduped/dropped.
    const taskId = seedTask(OWNER_ID, { title: 'orig' });
    const res = await app.inject({
      method: 'PATCH',
      url: '/tasks/bulk-update',
      headers: authHeader(OWNER_ID),
      payload: {
        items: [
          { id: taskId, title: 'first' },
          { id: taskId, title: 'second' },
        ],
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json().data;
    expect(body.succeeded).toHaveLength(2);
    expect(body.failed).toHaveLength(0);
    expect(store.tasks.get(taskId)!.title).toBe('second'); // last write wins
  });
});

// ---------------------------------------------------------------------------
// Group 5 — Partial success: mixed ok+fail -> HTTP 200 with the correct split.
// ---------------------------------------------------------------------------
describe('Group 5 — partial success split', () => {
  it('should_split_mixed_outcomes_into_succeeded_and_failed_on_bulk_update', async () => {
    const mine = seedTask(OWNER_ID, { title: 'mine' });
    const foreign = seedTask(STRANGER_ID);
    const res = await app.inject({
      method: 'PATCH',
      url: '/tasks/bulk-update',
      headers: authHeader(OWNER_ID),
      payload: {
        items: [
          { id: mine, status: 'DONE' },
          { id: foreign, status: 'DONE' },
          { id: ABSENT_ID, status: 'DONE' },
        ],
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json().data;
    expect(body.succeeded).toHaveLength(1);
    expect(body.succeeded[0].id).toBe(mine);
    expect(body.succeeded[0].status).toBe('DONE');
    expect(body.failed).toHaveLength(2);
    expect(body.failed.map((f: { id: string }) => f.id).sort()).toEqual([ABSENT_ID, foreign].sort());
  });

  it('should_return_200_with_all_succeeded_when_every_item_is_valid_on_bulk_create', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/tasks/bulk-create',
      headers: authHeader(OWNER_ID),
      payload: { items: [{ title: 'a' }, { title: 'b' }, { title: 'c' }] },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json().data;
    expect(body.succeeded).toHaveLength(3);
    expect(body.failed).toHaveLength(0);
    expect(body.succeeded.every((t: { ownerId: string }) => t.ownerId === OWNER_ID)).toBe(true);
    expect(store.tasks.size).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Group 6 — create failure id = array index; non-owner reassign in bulk-update.
// ---------------------------------------------------------------------------
describe('Group 6 — create-index id + reassign-by-non-owner', () => {
  it('should_use_array_index_string_as_failure_id_on_bulk_create', async () => {
    // index 0 ok; index 1 fails (assignee does not exist -> VALIDATION); index 2 ok.
    const res = await app.inject({
      method: 'POST',
      url: '/tasks/bulk-create',
      headers: authHeader(OWNER_ID),
      payload: {
        items: [
          { title: 'ok-0' },
          { title: 'bad-1', assigneeId: ABSENT_ID },
          { title: 'ok-2' },
        ],
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json().data;
    expect(body.succeeded).toHaveLength(2);
    expect(body.failed).toHaveLength(1);
    // ADR-042: create failures are identified by the array INDEX as a string.
    expect(body.failed[0].id).toBe('1');
    expect(body.failed[0].reason).toBe('VALIDATION');
  });

  it('should_not_echo_assignee_existence_detail_in_a_VALIDATION_reason', async () => {
    // H4: assignee-existence is itself an enumeration oracle — the reason is a
    // flat token, never the "No user with this id" field message.
    const res = await app.inject({
      method: 'POST',
      url: '/tasks/bulk-create',
      headers: authHeader(OWNER_ID),
      payload: { items: [{ title: 'x', assigneeId: ABSENT_ID }] },
    });

    expect(res.json().data.failed[0].reason).toBe('VALIDATION');
    expect(res.payload).not.toMatch(/No user with this id|assignee/i);
  });

  it('should_fail_only_the_reassign_item_for_a_non_owner_while_owner_items_succeed', async () => {
    // assignee may update content but NOT reassign (owner-only). In one batch the
    // assignee updates an allowed field on one task and tries to reassign another:
    // the reassign item is NOT_FOUND, the content update succeeds.
    const updatable = seedTask(OWNER_ID, { assigneeId: ASSIGNEE_ID });
    const reassignTarget = seedTask(OWNER_ID, { assigneeId: ASSIGNEE_ID });
    const res = await app.inject({
      method: 'PATCH',
      url: '/tasks/bulk-update',
      headers: authHeader(ASSIGNEE_ID),
      payload: {
        items: [
          { id: updatable, status: 'IN_PROGRESS' },
          { id: reassignTarget, assigneeId: STRANGER_ID },
        ],
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json().data;
    expect(body.succeeded).toHaveLength(1);
    expect(body.succeeded[0].id).toBe(updatable);
    expect(body.failed).toHaveLength(1);
    expect(body.failed[0].id).toBe(reassignTarget);
    expect(body.failed[0].reason).toBe('NOT_FOUND');
    // The reassign was NOT applied.
    expect(store.tasks.get(reassignTarget)!.assigneeId).toBe(ASSIGNEE_ID);
  });
});

// ---------------------------------------------------------------------------
// Group 7 — L1 audit: one line per item, real outcome + resourceId.
// ---------------------------------------------------------------------------
describe('Group 7 — L1 per-item audit', () => {
  it('should_emit_one_audit_line_per_item_with_real_outcome_on_bulk_update', async () => {
    const mine = seedTask(OWNER_ID);
    const res = await app.inject({
      method: 'PATCH',
      url: '/tasks/bulk-update',
      headers: authHeader(OWNER_ID),
      payload: {
        items: [
          { id: mine, status: 'DONE' },
          { id: ABSENT_ID, status: 'DONE' },
        ],
      },
    });
    expect(res.statusCode).toBe(200);

    // Exactly one audit line per item (2 items -> 2 lines).
    expect(auditSpy).toHaveBeenCalledTimes(2);
    const calls = auditSpy.mock.calls.map((c) => ({ action: c[1], fields: c[2] }));
    const success = calls.find((c) => c.fields.resourceId === mine)!;
    const failure = calls.find((c) => c.fields.resourceId === ABSENT_ID)!;
    expect(success.fields.outcome).toBe('success');
    expect(success.fields.actorId).toBe(OWNER_ID);
    expect(failure.fields.outcome).toBe('failure');
    expect(failure.fields.resourceId).toBe(ABSENT_ID);
  });

  it('should_audit_TASK_ASSIGN_for_reassign_items_and_TASK_UPDATE_otherwise', async () => {
    const content = seedTask(OWNER_ID);
    const reassign = seedTask(OWNER_ID);
    const res = await app.inject({
      method: 'PATCH',
      url: '/tasks/bulk-update',
      headers: authHeader(OWNER_ID),
      payload: {
        items: [
          { id: content, status: 'DONE' },
          { id: reassign, assigneeId: ASSIGNEE_ID },
        ],
      },
    });
    expect(res.statusCode).toBe(200);

    const byResource = (rid: string) =>
      auditSpy.mock.calls.find((c) => c[2].resourceId === rid)![1];
    // 'assigneeId' in element -> TASK_ASSIGN; otherwise -> TASK_UPDATE (L1 action mapping).
    expect(byResource(reassign)).toBe('task.assign');
    expect(byResource(content)).toBe('task.update');
  });

  it('should_emit_one_create_audit_line_per_item_with_success_outcome', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/tasks/bulk-create',
      headers: authHeader(OWNER_ID),
      payload: { items: [{ title: 'a' }, { title: 'b' }] },
    });
    expect(res.statusCode).toBe(200);

    // One audit line per item (L1), all TASK_CREATE, all success.
    expect(auditSpy).toHaveBeenCalledTimes(2);
    expect(auditSpy.mock.calls.every((c) => c[1] === 'task.create')).toBe(true);
    expect(auditSpy.mock.calls.every((c) => c[2].outcome === 'success')).toBe(true);
    expect(auditSpy.mock.calls.every((c) => c[2].actorId === OWNER_ID)).toBe(true);

    // OBSERVATION (documented, ADR-042 create-id-is-index): on bulk-CREATE the
    // audit `resourceId` carries the array INDEX ("0","1"), not the created
    // task's UUID. The response body (`succeeded[].id`) DOES carry the real
    // UUIDs, so attribution is recoverable, but the audit line alone does not
    // name the created row. This is consistent with the per-item outcome id
    // being the array index for create (no client id exists pre-creation). See
    // QA finding L-A1 in the brief — flagged as LOW (audit fidelity), not a
    // security bypass.
    const auditedResourceIds = auditSpy.mock.calls.map((c) => c[2].resourceId);
    expect(auditedResourceIds.sort()).toEqual(['0', '1']);
  });
});

// ---------------------------------------------------------------------------
// Group 8 — H6 fixed: PATCH /tasks/bulk-update with a valid {id, field} element
// is ACCEPTED and round-trips end-to-end (was broken by the intersection schema).
// ---------------------------------------------------------------------------
describe('Group 8 — H6 bulk-update round-trips end-to-end (regression)', () => {
  it('should_accept_a_valid_id_plus_one_field_element_and_apply_the_update', async () => {
    const taskId = seedTask(OWNER_ID, { title: 'before', status: 'TODO' });
    const res = await app.inject({
      method: 'PATCH',
      url: '/tasks/bulk-update',
      headers: authHeader(OWNER_ID),
      payload: { items: [{ id: taskId, title: 'after' }] },
    });

    // Pre-H6-fix this 422'd EVERY valid {id,...} element. It must now 200 + apply.
    expect(res.statusCode).toBe(200);
    const body = res.json().data;
    expect(body.failed).toHaveLength(0);
    expect(body.succeeded).toHaveLength(1);
    expect(body.succeeded[0].id).toBe(taskId);
    expect(body.succeeded[0].title).toBe('after');
    expect(store.tasks.get(taskId)!.title).toBe('after');
  });

  it('should_round_trip_an_assigneeId_null_unassign_via_bulk_update', async () => {
    // Key-presence preserved: {id, assigneeId:null} is accepted and unassigns
    // (the 'assigneeId' in input reassign path still fires, owner-only).
    const taskId = seedTask(OWNER_ID, { assigneeId: ASSIGNEE_ID });
    const res = await app.inject({
      method: 'PATCH',
      url: '/tasks/bulk-update',
      headers: authHeader(OWNER_ID),
      payload: { items: [{ id: taskId, assigneeId: null }] },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data.succeeded[0].assigneeId).toBeNull();
    expect(store.tasks.get(taskId)!.assigneeId).toBeNull();
  });

  it('should_return_422_for_an_id_only_bulk_update_element_no_update_field', async () => {
    // The ≥1-update-field rule survives .extend(): {id} alone is rejected pre-DB.
    const taskId = seedTask(OWNER_ID);
    const res = await app.inject({
      method: 'PATCH',
      url: '/tasks/bulk-update',
      headers: authHeader(OWNER_ID),
      payload: { items: [{ id: taskId }] },
    });
    expect(res.statusCode).toBe(422);
  });

  it('should_round_trip_a_multi_item_mixed_field_bulk_update', async () => {
    const t1 = seedTask(OWNER_ID, { title: 't1' });
    const t2 = seedTask(OWNER_ID, { priority: 'LOW' });
    const res = await app.inject({
      method: 'PATCH',
      url: '/tasks/bulk-update',
      headers: authHeader(OWNER_ID),
      payload: {
        items: [
          { id: t1, title: 'renamed' },
          { id: t2, priority: 'HIGH', status: 'DONE' },
        ],
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data.succeeded).toHaveLength(2);
    expect(store.tasks.get(t1)!.title).toBe('renamed');
    expect(store.tasks.get(t2)!.priority).toBe('HIGH');
    expect(store.tasks.get(t2)!.status).toBe('DONE');
  });

  it('should_round_trip_a_description_field_update_via_bulk_update', async () => {
    // Exercises the `description` branch of the reused toUpdateData mapper
    // through the bulk path (the other fields are covered above).
    const taskId = seedTask(OWNER_ID, { description: null });
    const res = await app.inject({
      method: 'PATCH',
      url: '/tasks/bulk-update',
      headers: authHeader(OWNER_ID),
      payload: { items: [{ id: taskId, description: 'a fresh description' }] },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data.succeeded[0].description).toBe('a fresh description');
    expect(store.tasks.get(taskId)!.description).toBe('a fresh description');
  });
});
