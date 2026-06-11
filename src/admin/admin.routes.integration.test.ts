import jwt from 'jsonwebtoken';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { FlagState, UserRole } from '@prisma/client';
import type { User } from '@prisma/client';
import { createFakePrisma, type FakeStore } from '../test/fake-prisma';
import { audit } from '../shared/audit';

/**
 * HTTP integration tests for the abuse-prevention surface: the 6 admin endpoints
 * + the screen/quota wiring on POST /shorten. Builds the REAL app with ONLY
 * Prisma faked (in-memory) and DNS mocked. Exercises the R0–R25 contract
 * end-to-end: role guard 403, blocklist canonicalize/idempotent/404, flagged
 * state machine (404/409), blocklist BLOCK, typosquat FLAG (no live link),
 * per-user daily quota, and audit emission.
 */

const fake = createFakePrisma();
vi.mock('../shared/prisma', () => ({
  prisma: fake.prisma,
  disconnectPrisma: async () => undefined,
}));

const lookupMock = vi.fn();
vi.mock('node:dns/promises', () => ({
  lookup: (...args: unknown[]) => lookupMock(...args),
}));

vi.mock('../shared/audit', async (importActual) => {
  const actual = await importActual<typeof import('../shared/audit')>();
  return { ...actual, audit: vi.fn() };
});
const auditMock = vi.mocked(audit);

/** True if an audit() call was made for the given action. */
function auditedAction(action: string): boolean {
  return auditMock.mock.calls.some((c) => c[1] === action);
}

let app: FastifyInstance;
let store: FakeStore;

const ADMIN_ID = '11111111-1111-1111-1111-111111111111';
const USER_ID = '22222222-2222-2222-2222-222222222222';

/** Seed a user with an explicit role. */
function seedUser(id: string, role: UserRole): void {
  const now = new Date();
  const row: User = { id, email: `${id}@example.com`, passwordHash: 'x', name: id, role, createdAt: now, updatedAt: now };
  store.users.set(id, row);
}

/** Sign a real HS256 access token carrying the role claim (as the app does). */
function tokenFor(userId: string, role: UserRole): string {
  return jwt.sign({ sub: userId, role }, process.env.JWT_SECRET!, {
    algorithm: 'HS256',
    expiresIn: '15m',
  });
}

function adminAuth(): { authorization: string } {
  return { authorization: `Bearer ${tokenFor(ADMIN_ID, UserRole.ADMIN)}` };
}
function userAuth(): { authorization: string } {
  return { authorization: `Bearer ${tokenFor(USER_ID, UserRole.USER)}` };
}

beforeEach(async () => {
  lookupMock.mockReset();
  lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
  auditMock.mockClear();

  const { buildApp } = await import('../app');
  app = await buildApp();
  store = fake.store;
  store.users.clear();
  store.shortUrls.clear();
  store.blockedDomains.clear();
  store.flaggedUrls.clear();
  seedUser(ADMIN_ID, UserRole.ADMIN);
  seedUser(USER_ID, UserRole.USER);
});

afterEach(async () => {
  await app.close();
});

describe('Admin role guard (R7/R8/ADR-033)', () => {
  it('should_return_401_without_a_token', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/blocklist' });
    expect(res.statusCode).toBe(401);
  });

  it('should_return_403_for_an_authenticated_non_admin', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/blocklist', headers: userAuth() });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
  });

  it('should_allow_an_admin', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/blocklist', headers: adminAuth() });
    expect(res.statusCode).toBe(200);
  });
});

describe('POST /admin/blocklist', () => {
  it('should_create_a_canonicalized_entry_and_audit', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/blocklist',
      headers: adminAuth(),
      payload: { domain: 'WWW.EVIL.com.', note: 'phishing' },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().data.domain).toBe('evil.com');
    expect(store.blockedDomains.has('evil.com')).toBe(true);
    expect(auditedAction('admin.blocklist_add')).toBe(true);
  });

  it('should_set_addedByUserId_server_side_and_reject_it_in_the_body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/blocklist',
      headers: adminAuth(),
      payload: { domain: 'evil.com', addedByUserId: USER_ID },
    });

    expect(res.statusCode).toBe(422); // .strict() rejects the injected column
  });

  it('should_return_409_on_a_duplicate_domain', async () => {
    const body = { method: 'POST' as const, url: '/admin/blocklist', headers: adminAuth(), payload: { domain: 'evil.com' } };
    await app.inject(body);

    const res = await app.inject(body);

    expect(res.statusCode).toBe(409);
  });

  it('should_return_422_for_an_empty_domain', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/blocklist',
      headers: adminAuth(),
      payload: { domain: '' },
    });
    expect(res.statusCode).toBe(422);
  });
});

describe('DELETE /admin/blocklist/:domain', () => {
  it('should_remove_a_canonical_match_and_audit', async () => {
    await app.inject({ method: 'POST', url: '/admin/blocklist', headers: adminAuth(), payload: { domain: 'evil.com' } });

    const res = await app.inject({
      method: 'DELETE',
      url: '/admin/blocklist/A.B.EVIL.com',
      headers: adminAuth(),
    });

    expect(res.statusCode).toBe(204);
    expect(store.blockedDomains.has('evil.com')).toBe(false);
    expect(auditedAction('admin.blocklist_remove')).toBe(true);
  });

  it('should_return_404_for_an_unknown_domain', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/admin/blocklist/nope.com',
      headers: adminAuth(),
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('POST /shorten — blocklist BLOCK (R16/R18)', () => {
  it('should_reject_a_blocklisted_domain_with_a_generic_422_and_persist_nothing', async () => {
    await app.inject({ method: 'POST', url: '/admin/blocklist', headers: adminAuth(), payload: { domain: 'evil.com' } });

    const res = await app.inject({
      method: 'POST',
      url: '/shorten',
      headers: userAuth(),
      payload: { url: 'https://sub.evil.com/landing' },
    });

    expect(res.statusCode).toBe(422);
    // Generic client message — no rule/score leakage (R18/R23).
    expect(res.json().error.message).not.toContain('evil.com');
    expect(store.shortUrls.size).toBe(0);
    expect(auditedAction('url.blocked')).toBe(true);
  });
});

describe('POST /shorten — typosquat FLAG (R20/R25)', () => {
  it('should_accept_for_review_without_minting_a_live_link', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/shorten',
      headers: userAuth(),
      payload: { url: 'https://gooogle.com/' },
    });

    expect(res.statusCode).toBe(202);
    expect(res.json().data.status).toBe('pending_review');
    // No live ShortUrl; a PENDING flagged row exists instead (R25).
    expect(store.shortUrls.size).toBe(0);
    expect(store.flaggedUrls.size).toBe(1);
    expect(auditedAction('url.flagged')).toBe(true);
  });
});

describe('GET /admin/flagged + approve/reject (R9/R11/R32)', () => {
  /** Submit a typosquat as USER so a PENDING flagged row exists; return its id. */
  async function seedFlag(): Promise<string> {
    await app.inject({ method: 'POST', url: '/shorten', headers: userAuth(), payload: { url: 'https://gooogle.com/' } });
    const res = await app.inject({ method: 'GET', url: '/admin/flagged', headers: adminAuth() });
    return res.json().data[0].id as string;
  }

  it('should_list_pending_flags_for_an_admin', async () => {
    await seedFlag();

    const res = await app.inject({ method: 'GET', url: '/admin/flagged', headers: adminAuth() });

    expect(res.statusCode).toBe(200);
    expect(res.json().data).toHaveLength(1);
  });

  it('should_mint_a_live_short_url_on_approve_and_audit', async () => {
    const id = await seedFlag();

    const res = await app.inject({
      method: 'POST',
      url: `/admin/flagged/${id}/approve`,
      headers: adminAuth(),
    });

    expect(res.statusCode).toBe(200);
    const { code } = res.json().data;
    expect(code).toMatch(/^[A-Za-z0-9]{6}$/);
    expect(store.shortUrls.get(code)?.ownerId).toBe(USER_ID);
    expect(store.flaggedUrls.get(id)?.state).toBe(FlagState.APPROVED);
    expect(auditedAction('admin.flag_approve')).toBe(true);
  });

  it('should_delete_the_row_on_reject_and_audit', async () => {
    const id = await seedFlag();

    const res = await app.inject({
      method: 'POST',
      url: `/admin/flagged/${id}/reject`,
      headers: adminAuth(),
    });

    expect(res.statusCode).toBe(204);
    expect(store.flaggedUrls.has(id)).toBe(false);
    expect(store.shortUrls.size).toBe(0);
    expect(auditedAction('admin.flag_reject')).toBe(true);
  });

  it('should_return_409_when_approving_an_already_reviewed_row', async () => {
    const id = await seedFlag();
    await app.inject({ method: 'POST', url: `/admin/flagged/${id}/approve`, headers: adminAuth() });

    const res = await app.inject({
      method: 'POST',
      url: `/admin/flagged/${id}/approve`,
      headers: adminAuth(),
    });

    expect(res.statusCode).toBe(409);
  });

  it('should_return_404_for_an_unknown_flagged_id', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/flagged/33333333-3333-3333-3333-333333333333/approve',
      headers: adminAuth(),
    });
    expect(res.statusCode).toBe(404);
  });

  it('should_return_422_for_a_malformed_flagged_id', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/flagged/not-a-uuid/approve',
      headers: adminAuth(),
    });
    expect(res.statusCode).toBe(422);
  });

  it('should_403_a_non_admin_on_approve', async () => {
    const id = await seedFlag();

    const res = await app.inject({
      method: 'POST',
      url: `/admin/flagged/${id}/approve`,
      headers: userAuth(),
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('POST /shorten — per-user daily quota (R24)', () => {
  it('should_reject_the_request_when_the_user_is_at_the_daily_cap', async () => {
    // Seed 100 existing live links for USER created today (bypassing the route
    // rate limit, which would otherwise cap us at 10/min).
    const now = new Date();
    for (let i = 0; i < 100; i += 1) {
      store.shortUrls.set(`seed${i}`, {
        id: `id-${i}`,
        code: `seed${i}`,
        originalUrl: 'https://example.com/',
        ownerId: USER_ID,
        clickCount: 0,
        createdAt: now,
        lastAccessedAt: null,
        updatedAt: now,
      });
    }

    const res = await app.inject({
      method: 'POST',
      url: '/shorten',
      headers: userAuth(),
      payload: { url: 'https://fresh-target.example.org/' },
    });

    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe('RATE_LIMIT_EXCEEDED');
    expect(auditedAction('url.quota_exceeded')).toBe(true);
  });
});
