import jwt from 'jsonwebtoken';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { UserRole } from '@prisma/client';
import type { User } from '@prisma/client';
import { createFakePrisma, type FakeStore } from '../test/fake-prisma';

/**
 * HTTP integration tests for bulk rate-limit N-weighting (H5 / ADR-043).
 *
 * Builds the REAL Fastify app with only Prisma faked, then proves that an
 * N-item bulk request consumes N units against the EXISTING global 100/min
 * limiter (ADR-014) — NOT 1 — and that crossing the 100/min boundary throttles
 * with the standard 429 envelope. In the test env `NODE_ENV=test`, so
 * `trustProxy` is off and every injected request shares the same client IP
 * (127.0.0.1), so charges accumulate on one global key across requests within a
 * single test — exactly the shared-budget the requirement targets.
 *
 * The single-item (N=1) path is also asserted to charge exactly 1 (the adapter
 * is a no-op when n<=1), so the weighting never over-counts normal traffic.
 */

const fake = createFakePrisma();
vi.mock('../shared/prisma', () => ({
  prisma: fake.prisma,
  disconnectPrisma: async () => undefined,
}));

let app: FastifyInstance;
let store: FakeStore;

const OWNER_ID = '11111111-1111-1111-1111-111111111111';
const GLOBAL_MAX = 100;

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

/** Authorization header for a given user id (real HS256, same secret as the app). */
function authHeader(userId: string): { authorization: string } {
  const token = jwt.sign({ sub: userId }, process.env.JWT_SECRET!, {
    algorithm: 'HS256',
    expiresIn: '15m',
  });
  return { authorization: `Bearer ${token}` };
}

/** Build a bulk-create payload of `n` distinct titles. */
function bulkCreatePayload(n: number): { items: { title: string }[] } {
  return { items: Array.from({ length: n }, (_, i) => ({ title: `task-${i}` })) };
}

/** Read the numeric x-ratelimit-remaining header off a response. */
function remaining(res: { headers: Record<string, unknown> }): number {
  const raw = res.headers['x-ratelimit-remaining'];
  return typeof raw === 'string' ? Number(raw) : (raw as number);
}

beforeEach(async () => {
  const { buildApp } = await import('../app');
  app = await buildApp();
  store = fake.store;
  store.users.clear();
  store.tasks.clear();
  store.refreshTokens.clear();
  seedUser(OWNER_ID, 'owner@example.com');
});

afterEach(async () => {
  await app.close();
});

describe('bulk N-weighting against the global limiter (H5 / ADR-043)', () => {
  it('should_charge_a_50_item_batch_as_50_units_not_1', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/tasks/bulk-create',
      headers: authHeader(OWNER_ID),
      payload: bulkCreatePayload(50),
    });

    expect(res.statusCode).toBe(200);
    // 1 (global onRequest hook) + 49 (adapter) = 50 charged -> 100 - 50 = 50 left.
    // If weighting were broken (1 unit/batch), remaining would be 99.
    expect(remaining(res)).toBe(GLOBAL_MAX - 50);
    expect(res.json().data.succeeded).toHaveLength(50);
  });

  it('should_charge_a_single_item_bulk_create_as_exactly_1_unit', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/tasks/bulk-create',
      headers: authHeader(OWNER_ID),
      payload: bulkCreatePayload(1),
    });

    expect(res.statusCode).toBe(200);
    // n<=1 -> adapter is a no-op; only the global hook's 1 unit is charged.
    expect(remaining(res)).toBe(GLOBAL_MAX - 1);
  });

  it('should_accumulate_units_across_requests_on_the_shared_global_key', async () => {
    const first = await app.inject({
      method: 'POST',
      url: '/tasks/bulk-create',
      headers: authHeader(OWNER_ID),
      payload: bulkCreatePayload(30),
    });
    expect(first.statusCode).toBe(200);
    expect(remaining(first)).toBe(GLOBAL_MAX - 30);

    // Second 30-item batch on the same shared key: 30 + 30 = 60 consumed.
    const second = await app.inject({
      method: 'POST',
      url: '/tasks/bulk-create',
      headers: authHeader(OWNER_ID),
      payload: bulkCreatePayload(30),
    });
    expect(second.statusCode).toBe(200);
    expect(remaining(second)).toBe(GLOBAL_MAX - 60);
  });

  it('should_throttle_with_429_once_weighted_batches_exhaust_the_100_per_min_budget', async () => {
    // Two cap-50 batches consume exactly 100 of the 100/min budget. (A single
    // batch cannot exceed 100 because the cap-50 schema rejects >50 pre-DB at
    // 422 — proving the N-weight is always bounded; ADR-043 constraint #2.)
    for (let i = 0; i < 2; i += 1) {
      const ok = await app.inject({
        method: 'POST',
        url: '/tasks/bulk-create',
        headers: authHeader(OWNER_ID),
        payload: bulkCreatePayload(50),
      });
      expect(ok.statusCode).toBe(200);
    }

    // Budget now exhausted (100/100). The very next request is throttled by the
    // plugin's own global hook (current 101 > 100) before any item work — the
    // weighting made earlier batches "count as N", so a user can no longer drive
    // 50x amplification past the shared ceiling.
    const res = await app.inject({
      method: 'POST',
      url: '/tasks/bulk-create',
      headers: authHeader(OWNER_ID),
      payload: bulkCreatePayload(1),
    });

    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe('RATE_LIMIT_EXCEEDED');
  });

  it('should_weight_the_bulk_delete_route_by_id_count_too', async () => {
    // The DELETE bulk route weights by ids.length the same way. 45 ids (all
    // NOT_FOUND is fine — weighting runs before the service loop): 1 + 44 = 45.
    const ids = Array.from(
      { length: 45 },
      (_, i) => `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`,
    );
    const del = await app.inject({
      method: 'DELETE',
      url: '/tasks/bulk-delete',
      headers: authHeader(OWNER_ID),
      payload: { ids },
    });
    expect(del.statusCode).toBe(200);
    expect(remaining(del)).toBe(GLOBAL_MAX - 45);
  });
});
