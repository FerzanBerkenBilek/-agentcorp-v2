import { AuditTargetType, Prisma, PrismaClient } from '@prisma/client';
import { beforeEach, describe, expect, it } from 'vitest';
import { createFakePrisma, type FakeStore } from '../test/fake-prisma';
import { AuditInsert, AuditRepository } from './audit.repository';

/**
 * Unit tests for AuditRepository against the in-memory fake Prisma (no live PG).
 *
 * Covers: insert maps every AuditInsert field 1:1 to `auditLog.create` (and that
 * id/createdAt are DB-defaulted, not supplied); findMany builds the parameterized
 * where (equality on event_type/actor_id/target_id + the created_at range),
 * orders newest-first, applies skip/take, and returns the matching total; and the
 * append-only contract — the fake delegate RAISEs on update/delete, mirroring the
 * DB trigger (ADR-045), and the repository exposes no method that reaches them.
 */

const ACTOR_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const ACTOR_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const TARGET = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

let prisma: PrismaClient;
let store: FakeStore;
let repo: AuditRepository;

beforeEach(() => {
  const fake = createFakePrisma();
  prisma = fake.prisma;
  store = fake.store;
  repo = new AuditRepository(prisma);
});

/**
 * Seed an audit row directly into the store with an explicit createdAt, so the
 * read tests can assert ordering/filtering deterministically.
 */
function seedRow(overrides: {
  id: string;
  eventType?: string;
  actorId?: string | null;
  targetId?: string | null;
  createdAt: Date;
}): void {
  store.auditLogs.set(overrides.id, {
    id: overrides.id,
    eventType: overrides.eventType ?? 'auth.login',
    actorId: overrides.actorId ?? null,
    targetId: overrides.targetId ?? null,
    targetType: null,
    ipAddress: null,
    userAgent: null,
    metadata: {},
    createdAt: overrides.createdAt,
  });
}

describe('AuditRepository.insert', () => {
  it('should_persist_every_field_and_default_id_and_createdAt', async () => {
    const row: AuditInsert = {
      eventType: 'task.create',
      actorId: ACTOR_A,
      targetId: TARGET,
      targetType: AuditTargetType.task,
      ipAddress: '203.0.113.10',
      userAgent: 'agent/1',
      metadata: { outcome: 'success' },
    };

    await repo.insert(row);

    expect(store.auditLogs.size).toBe(1);
    const persisted = [...store.auditLogs.values()][0];
    expect(persisted.eventType).toBe('task.create');
    expect(persisted.actorId).toBe(ACTOR_A);
    expect(persisted.targetId).toBe(TARGET);
    expect(persisted.targetType).toBe(AuditTargetType.task);
    expect(persisted.ipAddress).toBe('203.0.113.10');
    expect(persisted.userAgent).toBe('agent/1');
    expect(persisted.metadata).toEqual({ outcome: 'success' });
    // id + createdAt are DB-defaulted, never supplied by the repo.
    expect(persisted.id).toBeTruthy();
    expect(persisted.createdAt).toBeInstanceOf(Date);
  });

  it('should_persist_null_provenance_for_an_unauthenticated_event', async () => {
    await repo.insert({
      eventType: 'auth.oauth_start',
      actorId: null,
      targetId: null,
      targetType: null,
      ipAddress: null,
      userAgent: null,
      metadata: {},
    });

    const persisted = [...store.auditLogs.values()][0];
    expect(persisted.actorId).toBeNull();
    expect(persisted.targetId).toBeNull();
    expect(persisted.targetType).toBeNull();
    expect(persisted.metadata).toEqual({});
  });
});

describe('AuditRepository.findMany', () => {
  beforeEach(() => {
    seedRow({ id: 'r1', eventType: 'auth.login', actorId: ACTOR_A, createdAt: new Date('2026-01-01T00:00:00Z') });
    seedRow({ id: 'r2', eventType: 'task.create', actorId: ACTOR_A, targetId: TARGET, createdAt: new Date('2026-01-03T00:00:00Z') });
    seedRow({ id: 'r3', eventType: 'auth.login', actorId: ACTOR_B, createdAt: new Date('2026-01-02T00:00:00Z') });
  });

  it('should_order_newest_first_and_return_the_total', async () => {
    const { rows, total } = await repo.findMany({}, { skip: 0, take: 100 });
    expect(total).toBe(3);
    expect(rows.map((r) => r.id)).toEqual(['r2', 'r3', 'r1']);
  });

  it('should_filter_by_event_type', async () => {
    const { rows, total } = await repo.findMany({ eventType: 'auth.login' }, { skip: 0, take: 100 });
    expect(total).toBe(2);
    expect(rows.map((r) => r.id)).toEqual(['r3', 'r1']);
  });

  it('should_filter_by_actor_id', async () => {
    const { rows, total } = await repo.findMany({ actorId: ACTOR_B }, { skip: 0, take: 100 });
    expect(total).toBe(1);
    expect(rows[0].id).toBe('r3');
  });

  it('should_filter_by_target_id', async () => {
    const { rows } = await repo.findMany({ targetId: TARGET }, { skip: 0, take: 100 });
    expect(rows.map((r) => r.id)).toEqual(['r2']);
  });

  it('should_apply_the_inclusive_from_and_exclusive_to_date_range', async () => {
    // from <= createdAt < to → keeps r3 (Jan 02) only.
    const { rows, total } = await repo.findMany(
      { from: new Date('2026-01-02T00:00:00Z'), to: new Date('2026-01-03T00:00:00Z') },
      { skip: 0, take: 100 },
    );
    expect(total).toBe(1);
    expect(rows[0].id).toBe('r3');
  });

  it('should_apply_only_the_lower_bound_when_to_is_absent', async () => {
    const { rows } = await repo.findMany(
      { from: new Date('2026-01-02T00:00:00Z') },
      { skip: 0, take: 100 },
    );
    expect(rows.map((r) => r.id)).toEqual(['r2', 'r3']);
  });

  it('should_apply_only_the_upper_bound_when_from_is_absent', async () => {
    // to-only branch: createdAt < to keeps r1 (Jan 01) only.
    const { rows, total } = await repo.findMany(
      { to: new Date('2026-01-02T00:00:00Z') },
      { skip: 0, take: 100 },
    );
    expect(total).toBe(1);
    expect(rows[0].id).toBe('r1');
  });

  it('should_page_with_skip_and_take_while_total_reflects_the_full_match', async () => {
    const { rows, total } = await repo.findMany({}, { skip: 1, take: 1 });
    expect(total).toBe(3);
    expect(rows.map((r) => r.id)).toEqual(['r3']);
  });

  it('should_combine_an_equality_filter_with_a_date_range', async () => {
    const { rows, total } = await repo.findMany(
      { eventType: 'auth.login', from: new Date('2026-01-02T00:00:00Z') },
      { skip: 0, take: 100 },
    );
    expect(total).toBe(1);
    expect(rows[0].id).toBe('r3');
  });
});

describe('AuditRepository append-only contract (ADR-045 / immutability)', () => {
  it('should_expose_no_update_or_delete_method', () => {
    expect((repo as unknown as Record<string, unknown>).update).toBeUndefined();
    expect((repo as unknown as Record<string, unknown>).delete).toBeUndefined();
  });

  it('should_reject_a_direct_auditLog_update_the_way_the_DB_trigger_does', async () => {
    await repo.insert({
      eventType: 'auth.login',
      actorId: ACTOR_A,
      targetId: null,
      targetType: null,
      ipAddress: null,
      userAgent: null,
      metadata: {},
    });
    const id = [...store.auditLogs.keys()][0];

    // The fake delegate mirrors the BEFORE UPDATE trigger: any update RAISEs.
    await expect(
      (prisma.auditLog.update as unknown as (a: unknown) => Promise<unknown>)({
        where: { id },
        data: { eventType: 'tampered' } as Prisma.AuditLogUpdateInput,
      }),
    ).rejects.toThrow(/append-only/i);
  });

  it('should_reject_a_direct_auditLog_delete_the_way_the_DB_trigger_does', async () => {
    await expect(
      (prisma.auditLog.delete as unknown as (a: unknown) => Promise<unknown>)({
        where: { id: 'whatever' },
      }),
    ).rejects.toThrow(/append-only/i);
  });
});
