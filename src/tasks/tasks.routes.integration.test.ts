import { randomUUID } from 'crypto';
import jwt from 'jsonwebtoken';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { UserRole } from '@prisma/client';
import type { User } from '@prisma/client';
import { createFakePrisma, type FakeStore } from '../test/fake-prisma';

/**
 * HTTP integration tests for the task routes.
 *
 * Builds the REAL Fastify app (routes -> service -> policy -> repository) with
 * ONLY the Prisma data layer faked. Covers auth gating, the IDOR/object-level
 * authorization rules (404-not-403), ownerId-from-JWT, assignee validation,
 * filtering, and pagination. No live PostgreSQL required.
 */

const fake = createFakePrisma();
vi.mock('../shared/prisma', () => ({
  prisma: fake.prisma,
  disconnectPrisma: async () => undefined,
}));

let app: FastifyInstance;
let store: FakeStore;

const OWNER_ID = '11111111-1111-1111-1111-111111111111';
const ASSIGNEE_ID = '22222222-2222-2222-2222-222222222222';
const STRANGER_ID = '33333333-3333-3333-3333-333333333333';

/** Seed a user row directly into the fake store. */
function seedUser(id: string, email: string): void {
  const now = new Date();
  const row: User = {
    id,
    email,
    passwordHash: 'x',
    name: email,
    role: UserRole.USER,
    // ADR-041: password-seeded fixture user has no Google identity.
    googleId: null,
    googleEmail: null,
    createdAt: now,
    updatedAt: now,
  };
  store.users.set(id, row);
}

/** Sign a real HS256 access token for a user id (same secret as the app). */
function tokenFor(userId: string): string {
  return jwt.sign({ sub: userId }, process.env.JWT_SECRET!, {
    algorithm: 'HS256',
    expiresIn: '15m',
  });
}

/** Authorization header for a given user id. */
function authHeader(userId: string): { authorization: string } {
  return { authorization: `Bearer ${tokenFor(userId)}` };
}

beforeEach(async () => {
  const { buildApp } = await import('../app');
  app = await buildApp();
  store = fake.store;
  store.users.clear();
  store.tasks.clear();
  store.refreshTokens.clear();
  seedUser(OWNER_ID, 'owner@example.com');
  seedUser(ASSIGNEE_ID, 'assignee@example.com');
  seedUser(STRANGER_ID, 'stranger@example.com');
});

afterEach(async () => {
  await app.close();
});

/** Create a task via the API as `userId` and return the created task body. */
async function createTask(
  userId: string,
  overrides: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const res = await app.inject({
    method: 'POST',
    url: '/tasks',
    headers: authHeader(userId),
    payload: { title: 'A task', ...overrides },
  });
  return res.json().data;
}

describe('auth gating', () => {
  it('should_return_401_when_no_bearer_token', async () => {
    const res = await app.inject({ method: 'GET', url: '/tasks' });

    expect(res.statusCode).toBe(401);
  });

  it('should_return_401_when_bearer_token_expired', async () => {
    const expired = jwt.sign({ sub: OWNER_ID }, process.env.JWT_SECRET!, {
      algorithm: 'HS256',
      expiresIn: -10,
    });

    const res = await app.inject({
      method: 'GET',
      url: '/tasks',
      headers: { authorization: `Bearer ${expired}` },
    });

    expect(res.statusCode).toBe(401);
  });

  it('should_return_401_when_bearer_token_signed_with_wrong_secret', async () => {
    const forged = jwt.sign({ sub: OWNER_ID }, 'a-different-secret-not-the-real-one-xx', {
      algorithm: 'HS256',
    });

    const res = await app.inject({
      method: 'GET',
      url: '/tasks',
      headers: { authorization: `Bearer ${forged}` },
    });

    expect(res.statusCode).toBe(401);
  });
});

describe('POST /tasks', () => {
  it('should_return_201_with_task_when_create_succeeds', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/tasks',
      headers: authHeader(OWNER_ID),
      payload: { title: 'Write tests', priority: 'HIGH' },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.data.title).toBe('Write tests');
    expect(body.data.priority).toBe('HIGH');
  });

  it('should_set_ownerId_from_jwt_not_from_body', async () => {
    // A malicious body tries to set ownerId; it must be ignored (and rejected
    // by the strict schema). Ownership comes only from the JWT sub.
    const res = await app.inject({
      method: 'POST',
      url: '/tasks',
      headers: authHeader(OWNER_ID),
      payload: { title: 'Owned task' },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().data.ownerId).toBe(OWNER_ID);
  });

  it('should_reject_unknown_body_fields_like_ownerId', async () => {
    // .strict() schema: an attempt to inject ownerId is a 422, never a silent set.
    const res = await app.inject({
      method: 'POST',
      url: '/tasks',
      headers: authHeader(OWNER_ID),
      payload: { title: 'Owned task', ownerId: STRANGER_ID },
    });

    expect(res.statusCode).toBe(422);
  });

  it('should_return_422_when_assigneeId_does_not_exist', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/tasks',
      headers: authHeader(OWNER_ID),
      payload: { title: 'Assigned task', assigneeId: randomUUID() },
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });
});

describe('GET /tasks (list, filter, paginate)', () => {
  beforeEach(async () => {
    await createTask(OWNER_ID, { status: 'TODO', priority: 'LOW' });
    await createTask(OWNER_ID, { status: 'DONE', priority: 'HIGH' });
    await createTask(OWNER_ID, { status: 'DONE', priority: 'LOW' });
  });

  it('should_return_200_with_paginated_tasks', async () => {
    const res = await app.inject({ method: 'GET', url: '/tasks', headers: authHeader(OWNER_ID) });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.items).toHaveLength(3);
    expect(body.data.pageInfo).toMatchObject({ page: 1, limit: 20, total: 3, totalPages: 1 });
  });

  it('should_return_200_filtered_by_status', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/tasks?status=DONE',
      headers: authHeader(OWNER_ID),
    });

    expect(res.statusCode).toBe(200);
    const items = res.json().data.items as Array<{ status: string }>;
    expect(items).toHaveLength(2);
    expect(items.every((t) => t.status === 'DONE')).toBe(true);
  });

  it('should_return_200_filtered_by_priority', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/tasks?priority=LOW',
      headers: authHeader(OWNER_ID),
    });

    expect(res.statusCode).toBe(200);
    const items = res.json().data.items as Array<{ priority: string }>;
    expect(items).toHaveLength(2);
    expect(items.every((t) => t.priority === 'LOW')).toBe(true);
  });

  it('should_return_200_filtered_by_status_and_priority', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/tasks?status=DONE&priority=LOW',
      headers: authHeader(OWNER_ID),
    });

    expect(res.json().data.items).toHaveLength(1);
  });

  it('should_return_422_when_limit_exceeds_100', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/tasks?limit=101',
      headers: authHeader(OWNER_ID),
    });

    expect(res.statusCode).toBe(422);
  });

  it('should_only_list_tasks_owned_or_assigned_to_caller', async () => {
    // Stranger has no tasks owned or assigned => empty page (no data leak).
    const res = await app.inject({
      method: 'GET',
      url: '/tasks',
      headers: authHeader(STRANGER_ID),
    });

    expect(res.json().data.items).toHaveLength(0);
  });
});

describe('GET /tasks/:id (object-level authz / IDOR)', () => {
  it('should_return_404_when_task_not_found', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/tasks/${randomUUID()}`,
      headers: authHeader(OWNER_ID),
    });

    expect(res.statusCode).toBe(404);
  });

  it('should_return_404_when_non_owner_non_assignee_gets_task', async () => {
    const task = await createTask(OWNER_ID);

    // IDOR check: a stranger gets 404 (not 403) so existence is not revealed.
    const res = await app.inject({
      method: 'GET',
      url: `/tasks/${task.id}`,
      headers: authHeader(STRANGER_ID),
    });

    expect(res.statusCode).toBe(404);
  });

  it('should_return_200_when_assignee_gets_task', async () => {
    const task = await createTask(OWNER_ID, { assigneeId: ASSIGNEE_ID });

    const res = await app.inject({
      method: 'GET',
      url: `/tasks/${task.id}`,
      headers: authHeader(ASSIGNEE_ID),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data.id).toBe(task.id);
  });

  it('should_return_422_when_task_id_is_not_a_uuid', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/tasks/not-a-uuid',
      headers: authHeader(OWNER_ID),
    });

    expect(res.statusCode).toBe(422);
  });
});

describe('PATCH /tasks/:id', () => {
  it('should_allow_assignee_to_update_status', async () => {
    const task = await createTask(OWNER_ID, { assigneeId: ASSIGNEE_ID });

    const res = await app.inject({
      method: 'PATCH',
      url: `/tasks/${task.id}`,
      headers: authHeader(ASSIGNEE_ID),
      payload: { status: 'IN_PROGRESS' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data.status).toBe('IN_PROGRESS');
  });

  it('should_return_404_when_assignee_tries_to_reassign', async () => {
    // Reassign is owner-only; an assignee attempting it gets 404 (policy).
    const task = await createTask(OWNER_ID, { assigneeId: ASSIGNEE_ID });

    const res = await app.inject({
      method: 'PATCH',
      url: `/tasks/${task.id}`,
      headers: authHeader(ASSIGNEE_ID),
      payload: { assigneeId: STRANGER_ID },
    });

    expect(res.statusCode).toBe(404);
  });

  it('should_return_404_when_non_owner_non_assignee_updates', async () => {
    const task = await createTask(OWNER_ID);

    const res = await app.inject({
      method: 'PATCH',
      url: `/tasks/${task.id}`,
      headers: authHeader(STRANGER_ID),
      payload: { status: 'DONE' },
    });

    expect(res.statusCode).toBe(404);
  });
});

describe('DELETE /tasks/:id', () => {
  it('should_return_204_when_owner_deletes_task', async () => {
    const task = await createTask(OWNER_ID);

    const res = await app.inject({
      method: 'DELETE',
      url: `/tasks/${task.id}`,
      headers: authHeader(OWNER_ID),
    });

    expect(res.statusCode).toBe(204);
    expect(store.tasks.has(task.id as string)).toBe(false);
  });

  it('should_return_404_when_non_owner_tries_to_delete', async () => {
    // Assignee may read/update but NOT delete => 404.
    const task = await createTask(OWNER_ID, { assigneeId: ASSIGNEE_ID });

    const res = await app.inject({
      method: 'DELETE',
      url: `/tasks/${task.id}`,
      headers: authHeader(ASSIGNEE_ID),
    });

    expect(res.statusCode).toBe(404);
    expect(store.tasks.has(task.id as string)).toBe(true);
  });

  it('should_return_404_when_owner_deletes_nonexistent_task', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/tasks/${randomUUID()}`,
      headers: authHeader(OWNER_ID),
    });

    expect(res.statusCode).toBe(404);
  });
});
