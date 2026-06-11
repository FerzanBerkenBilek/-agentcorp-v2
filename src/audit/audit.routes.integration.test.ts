import jwt from 'jsonwebtoken';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { AuditTargetType, UserRole } from '@prisma/client';
import type { AuditLog, User } from '@prisma/client';
import { createFakePrisma, type FakeStore } from '../test/fake-prisma';
import { AUDIT_ACTION } from '../shared/audit';

/**
 * HTTP integration tests for the admin-only audit-log read API (GET /audit-logs,
 * ADR-049 / security S1–S11). Builds the REAL app with ONLY Prisma faked
 * (in-memory) so no live PostgreSQL is needed. Exercises the contract
 * end-to-end:
 *  - S1 auth/role: 401 unauthenticated, 403 authenticated-non-admin, 200 admin.
 *  - no IDOR: actor_id is an admin FILTER, never a self-scope — a non-admin can
 *    read NOTHING (not even their own rows).
 *  - filters: event_type / actor_id / target_id / date range (all Zod-validated).
 *  - newest-first ordering and the max-100/page cap.
 *  - durable write-through: a real admin mutation emits via the wired auditSink,
 *    the row lands in the store, and the read API returns it.
 *  - app-contract immutability: the fake auditLog delegate RAISEs on update/delete
 *    (mirroring the DB BEFORE UPDATE/DELETE trigger, ADR-045) — the real DB-level
 *    rejection on Postgres 16 was verified separately by db-engineer (see note).
 */

const fake = createFakePrisma();
vi.mock('../shared/prisma', () => ({
  prisma: fake.prisma,
  disconnectPrisma: async () => undefined,
}));

// The admin blocklist screen path calls DNS; stub it so a real admin mutation
// (used for the durable write-through test) does not make a live lookup.
const lookupMock = vi.fn();
vi.mock('node:dns/promises', () => ({
  lookup: (...args: unknown[]) => lookupMock(...args),
}));

let app: FastifyInstance;
let store: FakeStore;

const ADMIN_ID = '11111111-1111-1111-1111-111111111111';
const USER_ID = '22222222-2222-2222-2222-222222222222';
const OTHER_ID = '33333333-3333-3333-3333-333333333333';
const TARGET_ID = '44444444-4444-4444-4444-444444444444';

/** Seed a user with an explicit role. */
function seedUser(id: string, role: UserRole): void {
  const now = new Date();
  const row: User = { id, email: `${id}@example.com`, passwordHash: 'x', name: id, role, googleId: null, googleEmail: null, createdAt: now, updatedAt: now };
  store.users.set(id, row);
}

/** Sign a real HS256 access token carrying the role claim (as the app does). */
function tokenFor(userId: string, role: UserRole): string {
  return jwt.sign({ sub: userId, role }, process.env.JWT_SECRET!, { algorithm: 'HS256', expiresIn: '15m' });
}

function adminAuth(): { authorization: string } {
  return { authorization: `Bearer ${tokenFor(ADMIN_ID, UserRole.ADMIN)}` };
}
function userAuth(): { authorization: string } {
  return { authorization: `Bearer ${tokenFor(USER_ID, UserRole.USER)}` };
}

/** Seed an audit row directly with an explicit createdAt for deterministic reads. */
function seedAudit(overrides: {
  id: string;
  eventType?: string;
  actorId?: string | null;
  targetId?: string | null;
  targetType?: AuditTargetType | null;
  createdAt: Date;
}): void {
  const row: AuditLog = {
    id: overrides.id,
    eventType: overrides.eventType ?? AUDIT_ACTION.LOGIN,
    actorId: overrides.actorId ?? null,
    targetId: overrides.targetId ?? null,
    targetType: overrides.targetType ?? null,
    ipAddress: '203.0.113.9',
    userAgent: 'seed/1',
    metadata: { outcome: 'success' },
    createdAt: overrides.createdAt,
  };
  store.auditLogs.set(row.id, row);
}

beforeEach(async () => {
  lookupMock.mockReset();
  lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);

  const { buildApp } = await import('../app');
  app = await buildApp();
  store = fake.store;
  store.users.clear();
  store.shortUrls.clear();
  store.blockedDomains.clear();
  store.flaggedUrls.clear();
  store.auditLogs.clear();
  seedUser(ADMIN_ID, UserRole.ADMIN);
  seedUser(USER_ID, UserRole.USER);
});

afterEach(async () => {
  await app.close();
});

describe('GET /audit-logs — auth + role guard (S1)', () => {
  it('should_return_401_without_a_token', async () => {
    const res = await app.inject({ method: 'GET', url: '/audit-logs' });
    expect(res.statusCode).toBe(401);
  });

  it('should_return_403_for_an_authenticated_non_admin', async () => {
    const res = await app.inject({ method: 'GET', url: '/audit-logs', headers: userAuth() });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
  });

  it('should_return_200_for_an_admin', async () => {
    const res = await app.inject({ method: 'GET', url: '/audit-logs', headers: adminAuth() });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.items).toEqual([]);
    expect(res.json().data.pageInfo).toMatchObject({ page: 1, limit: 20, total: 0 });
  });
});

describe('GET /audit-logs — no IDOR (actor_id is a filter, not a self-scope)', () => {
  it('should_not_let_a_non_admin_read_even_their_own_rows', async () => {
    seedAudit({ id: 'own', actorId: USER_ID, createdAt: new Date('2026-01-01T00:00:00Z') });

    // The non-admin tries to scope to their own actor_id — still 403, no rows.
    const res = await app.inject({
      method: 'GET',
      url: `/audit-logs?actor_id=${USER_ID}`,
      headers: userAuth(),
    });

    expect(res.statusCode).toBe(403);
  });

  it('should_let_an_admin_filter_by_any_actor_id', async () => {
    seedAudit({ id: 'a', actorId: USER_ID, createdAt: new Date('2026-01-01T00:00:00Z') });
    seedAudit({ id: 'b', actorId: OTHER_ID, createdAt: new Date('2026-01-02T00:00:00Z') });

    const res = await app.inject({
      method: 'GET',
      url: `/audit-logs?actor_id=${OTHER_ID}`,
      headers: adminAuth(),
    });

    expect(res.statusCode).toBe(200);
    const { items } = res.json().data;
    expect(items).toHaveLength(1);
    expect(items[0].actorId).toBe(OTHER_ID);
  });
});

describe('GET /audit-logs — filters (S9)', () => {
  beforeEach(() => {
    seedAudit({ id: 'login-a', eventType: AUDIT_ACTION.LOGIN, actorId: USER_ID, createdAt: new Date('2026-01-01T00:00:00Z') });
    seedAudit({ id: 'task-a', eventType: AUDIT_ACTION.TASK_CREATE, actorId: USER_ID, targetId: TARGET_ID, targetType: AuditTargetType.task, createdAt: new Date('2026-01-03T00:00:00Z') });
    seedAudit({ id: 'login-b', eventType: AUDIT_ACTION.LOGIN, actorId: OTHER_ID, createdAt: new Date('2026-01-02T00:00:00Z') });
  });

  it('should_filter_by_event_type', async () => {
    const res = await app.inject({ method: 'GET', url: `/audit-logs?event_type=${AUDIT_ACTION.LOGIN}`, headers: adminAuth() });
    expect(res.statusCode).toBe(200);
    const { items, pageInfo } = res.json().data;
    expect(pageInfo.total).toBe(2);
    expect(items.map((i: { id: string }) => i.id)).toEqual(['login-b', 'login-a']);
  });

  it('should_filter_by_target_id', async () => {
    const res = await app.inject({ method: 'GET', url: `/audit-logs?target_id=${TARGET_ID}`, headers: adminAuth() });
    const { items } = res.json().data;
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe('task-a');
  });

  it('should_filter_by_an_inclusive_from_exclusive_to_date_range', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/audit-logs?from=2026-01-02T00:00:00Z&to=2026-01-03T00:00:00Z',
      headers: adminAuth(),
    });
    const { items } = res.json().data;
    expect(items.map((i: { id: string }) => i.id)).toEqual(['login-b']);
  });

  it('should_reject_an_inverted_date_range_with_422', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/audit-logs?from=2026-02-01T00:00:00Z&to=2026-01-01T00:00:00Z',
      headers: adminAuth(),
    });
    expect(res.statusCode).toBe(422);
  });

  it('should_reject_a_non_uuid_actor_id_with_422', async () => {
    const res = await app.inject({ method: 'GET', url: '/audit-logs?actor_id=not-a-uuid', headers: adminAuth() });
    expect(res.statusCode).toBe(422);
  });

  it('should_reject_an_event_type_outside_the_enum_with_422', async () => {
    const res = await app.inject({ method: 'GET', url: '/audit-logs?event_type=not.a.real.action', headers: adminAuth() });
    expect(res.statusCode).toBe(422);
  });

  it('should_reject_an_unknown_query_key_with_422_strict', async () => {
    const res = await app.inject({ method: 'GET', url: '/audit-logs?wat=1', headers: adminAuth() });
    expect(res.statusCode).toBe(422);
  });
});

describe('GET /audit-logs — ordering + pagination (S9)', () => {
  beforeEach(() => {
    // 5 rows, ascending createdAt; the read must return them newest-first.
    for (let i = 0; i < 5; i += 1) {
      seedAudit({ id: `r${i}`, actorId: USER_ID, createdAt: new Date(`2026-01-0${i + 1}T00:00:00Z`) });
    }
  });

  it('should_return_rows_newest_first', async () => {
    const res = await app.inject({ method: 'GET', url: '/audit-logs', headers: adminAuth() });
    const { items } = res.json().data;
    expect(items.map((i: { id: string }) => i.id)).toEqual(['r4', 'r3', 'r2', 'r1', 'r0']);
  });

  it('should_page_with_page_and_limit', async () => {
    const res = await app.inject({ method: 'GET', url: '/audit-logs?page=2&limit=2', headers: adminAuth() });
    const { items, pageInfo } = res.json().data;
    expect(items.map((i: { id: string }) => i.id)).toEqual(['r2', 'r1']);
    expect(pageInfo).toMatchObject({ page: 2, limit: 2, total: 5, totalPages: 3 });
  });

  it('should_reject_a_limit_above_the_max_of_100_with_422', async () => {
    const res = await app.inject({ method: 'GET', url: '/audit-logs?limit=101', headers: adminAuth() });
    expect(res.statusCode).toBe(422);
  });

  it('should_accept_a_limit_of_exactly_100', async () => {
    const res = await app.inject({ method: 'GET', url: '/audit-logs?limit=100', headers: adminAuth() });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.pageInfo.limit).toBe(100);
  });
});

describe('GET /audit-logs — durable write-through (a real admin mutation is audited)', () => {
  it('should_persist_an_audit_row_for_a_blocklist_add_and_return_it_via_the_read_API', async () => {
    // Drive a real admin mutation; the wired auditSink records it durably.
    const add = await app.inject({
      method: 'POST',
      url: '/admin/blocklist',
      headers: adminAuth(),
      payload: { domain: 'evil.com', note: 'phishing' },
    });
    expect(add.statusCode).toBe(201);

    // The durable row landed in the store (fire-and-forget already completed).
    expect(store.auditLogs.size).toBe(1);

    const res = await app.inject({
      method: 'GET',
      url: `/audit-logs?event_type=${AUDIT_ACTION.BLOCKLIST_ADD}`,
      headers: adminAuth(),
    });

    expect(res.statusCode).toBe(200);
    const { items } = res.json().data;
    expect(items).toHaveLength(1);
    expect(items[0].eventType).toBe(AUDIT_ACTION.BLOCKLIST_ADD);
    // Provenance is server-derived: the admin is the actor (S2).
    expect(items[0].actorId).toBe(ADMIN_ID);
    // No secret/PII leaked into metadata (S4).
    expect(JSON.stringify(items[0].metadata)).not.toMatch(/password|token|secret/i);
  });
});

describe('audit_logs immutability — app contract (ADR-045 / S5/S6)', () => {
  /**
   * NOTE ON SCOPE: vitest runs against the in-memory fake Prisma (no live PG), so
   * this asserts the APP-CONTRACT layer only — the fake auditLog delegate RAISEs
   * on update/delete exactly as the DB BEFORE UPDATE/DELETE trigger does. The
   * REAL DB-level rejection was verified separately by db-engineer on PostgreSQL
   * 16 (Docker): a direct `UPDATE audit_logs` and `DELETE FROM audit_logs` each
   * returned `ERROR: audit_logs is append-only: <OP> is not permitted (ADR-045)`
   * with SQLSTATE 23001, INSERT unaffected. This test does NOT exercise that real
   * trigger — it covers the application contract that mirrors it.
   */
  it('should_reject_an_update_against_audit_logs_at_the_fake_delegate', async () => {
    seedAudit({ id: 'immutable-1', actorId: USER_ID, createdAt: new Date('2026-01-01T00:00:00Z') });

    await expect(
      (fake.prisma.auditLog.update as unknown as (a: unknown) => Promise<unknown>)({
        where: { id: 'immutable-1' },
        data: { eventType: 'tampered' },
      }),
    ).rejects.toThrow(/append-only/i);
  });

  it('should_reject_a_delete_against_audit_logs_at_the_fake_delegate', async () => {
    seedAudit({ id: 'immutable-2', actorId: USER_ID, createdAt: new Date('2026-01-01T00:00:00Z') });

    await expect(
      (fake.prisma.auditLog.delete as unknown as (a: unknown) => Promise<unknown>)({
        where: { id: 'immutable-2' },
      }),
    ).rejects.toThrow(/append-only/i);
  });
});
