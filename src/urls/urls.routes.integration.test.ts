import jwt from 'jsonwebtoken';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { User } from '@prisma/client';
import { createFakePrisma, type FakeStore } from '../test/fake-prisma';
import { audit } from '../shared/audit';

/**
 * HTTP integration tests for the URL-shortener routes.
 *
 * Builds the REAL Fastify app (publicUrlsRoutes + urlsRoutes -> service ->
 * policy -> repository) with ONLY the Prisma data layer faked (in-memory) and
 * DNS resolution mocked (so SSRF validation is deterministic + offline). Covers
 * auth gating, the anonymous 302 redirect + click tracking + no-store header,
 * SSRF rejection, owner-only stats/delete (404-not-403), malformed codes, and
 * the per-route 10/min rate limit. No live PostgreSQL or network required.
 */

const fake = createFakePrisma();
vi.mock('../shared/prisma', () => ({
  prisma: fake.prisma,
  disconnectPrisma: async () => undefined,
}));

// Deterministic, offline DNS: by default every host resolves to a public IP so
// assertSafeUrl accepts it. Individual tests override to force SSRF rejection.
const lookupMock = vi.fn();
vi.mock('node:dns/promises', () => ({
  lookup: (...args: unknown[]) => lookupMock(...args),
}));

// Spy on audit while keeping AUDIT_ACTION + the real signature, mirroring the
// auth integration suite — lets us assert shorten/delete emit audit events
// without depending on Pino output (disabled in test mode).
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

const OWNER_ID = '11111111-1111-1111-1111-111111111111';
const STRANGER_ID = '33333333-3333-3333-3333-333333333333';
const PUBLIC_URL = 'https://example.com/landing';

/** Seed a user row directly into the fake store. */
function seedUser(id: string, email: string): void {
  const now = new Date();
  const row: User = { id, email, passwordHash: 'x', name: email, createdAt: now, updatedAt: now };
  store.users.set(id, row);
}

/** Sign a real HS256 access token for a user id (same secret as the app). */
function tokenFor(userId: string): string {
  return jwt.sign({ sub: userId }, process.env.JWT_SECRET!, { algorithm: 'HS256', expiresIn: '15m' });
}

/** Authorization header for a given user id. */
function authHeader(userId: string): { authorization: string } {
  return { authorization: `Bearer ${tokenFor(userId)}` };
}

/** Shorten a URL via the API as `userId`; returns the created code. */
async function shorten(userId: string, url = PUBLIC_URL): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/shorten',
    headers: authHeader(userId),
    payload: { url },
  });
  expect(res.statusCode).toBe(201);
  return res.json().data.code as string;
}

beforeEach(async () => {
  lookupMock.mockReset();
  // Default: resolve any host to a public address so assertSafeUrl accepts it.
  lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
  auditMock.mockClear();

  const { buildApp } = await import('../app');
  app = await buildApp();
  store = fake.store;
  store.users.clear();
  store.tasks.clear();
  store.refreshTokens.clear();
  store.shortUrls.clear();
  seedUser(OWNER_ID, 'owner@example.com');
  seedUser(STRANGER_ID, 'stranger@example.com');
});

afterEach(async () => {
  await app.close();
});

describe('POST /shorten', () => {
  it('should_return_401_when_no_bearer_token', async () => {
    const res = await app.inject({ method: 'POST', url: '/shorten', payload: { url: PUBLIC_URL } });

    expect(res.statusCode).toBe(401);
  });

  it('should_return_201_with_code_and_originalUrl_when_authenticated', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/shorten',
      headers: authHeader(OWNER_ID),
      payload: { url: PUBLIC_URL },
    });

    expect(res.statusCode).toBe(201);
    const { data } = res.json();
    expect(data.code).toMatch(/^[A-Za-z0-9]{6}$/);
    expect(data.originalUrl).toBe(PUBLIC_URL);
    expect(typeof data.createdAt).toBe('string');
  });

  it('should_not_echo_ownerId_on_the_create_response', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/shorten',
      headers: authHeader(OWNER_ID),
      payload: { url: PUBLIC_URL },
    });

    expect(res.json().data).not.toHaveProperty('ownerId');
  });

  it('should_set_ownerId_from_jwt_and_reject_an_ownerId_in_the_body', async () => {
    // .strict() schema: an injected ownerId is a 422, never a silent set.
    const res = await app.inject({
      method: 'POST',
      url: '/shorten',
      headers: authHeader(OWNER_ID),
      payload: { url: PUBLIC_URL, ownerId: STRANGER_ID },
    });

    expect(res.statusCode).toBe(422);
  });

  it('should_persist_the_short_url_under_the_authenticated_owner', async () => {
    const code = await shorten(OWNER_ID);

    expect(store.shortUrls.get(code)?.ownerId).toBe(OWNER_ID);
  });

  it('should_emit_a_url_shorten_audit_event', async () => {
    await shorten(OWNER_ID);

    expect(auditedAction('url.shorten')).toBe(true);
  });

  it('should_return_422_when_the_url_resolves_to_a_private_ip (SSRF)', async () => {
    lookupMock.mockResolvedValue([{ address: '169.254.169.254', family: 4 }]);

    const res = await app.inject({
      method: 'POST',
      url: '/shorten',
      headers: authHeader(OWNER_ID),
      payload: { url: 'https://metadata.evil.com/' },
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('should_return_422_for_a_non_http_scheme (SSRF)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/shorten',
      headers: authHeader(OWNER_ID),
      payload: { url: 'javascript:alert(1)' },
    });

    expect(res.statusCode).toBe(422);
  });
});

describe('GET /:code (anonymous redirect + click tracking)', () => {
  it('should_redirect_302_with_location_and_no_store_for_a_known_code', async () => {
    const code = await shorten(OWNER_ID);

    const res = await app.inject({ method: 'GET', url: `/${code}` });

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(PUBLIC_URL);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('should_work_anonymously_without_a_token', async () => {
    const code = await shorten(OWNER_ID);

    // No auth header at all — the redirect route carries NO authGuard.
    const res = await app.inject({ method: 'GET', url: `/${code}` });

    expect(res.statusCode).toBe(302);
  });

  it('should_increment_the_click_count_on_each_redirect', async () => {
    const code = await shorten(OWNER_ID);

    await app.inject({ method: 'GET', url: `/${code}` });
    await app.inject({ method: 'GET', url: `/${code}` });

    const statsRes = await app.inject({
      method: 'GET',
      url: `/${code}/stats`,
      headers: authHeader(OWNER_ID),
    });
    expect(statsRes.json().data.clickCount).toBe(2);
    expect(statsRes.json().data.lastAccessedAt).not.toBeNull();
  });

  it('should_return_404_for_an_unknown_but_well_formed_code', async () => {
    const res = await app.inject({ method: 'GET', url: '/Zzzzzz' });

    expect(res.statusCode).toBe(404);
  });

  it.each(['/short', '/ABCDEFG', '/abc-12'])(
    'should_return_422_for_a_malformed_code (%s)',
    async (path) => {
      const res = await app.inject({ method: 'GET', url: path });

      expect(res.statusCode).toBe(422);
    },
  );
});

describe('GET /:code/stats (owner-only)', () => {
  it('should_return_200_with_stats_for_the_owner', async () => {
    const code = await shorten(OWNER_ID);

    const res = await app.inject({
      method: 'GET',
      url: `/${code}/stats`,
      headers: authHeader(OWNER_ID),
    });

    expect(res.statusCode).toBe(200);
    const { data } = res.json();
    expect(data.clickCount).toBe(0);
    expect(typeof data.createdAt).toBe('string');
    expect(data.lastAccessedAt).toBeNull();
  });

  it('should_return_404_not_403_for_a_non_owner', async () => {
    const code = await shorten(OWNER_ID);

    const res = await app.inject({
      method: 'GET',
      url: `/${code}/stats`,
      headers: authHeader(STRANGER_ID),
    });

    expect(res.statusCode).toBe(404);
  });

  it('should_return_404_for_a_missing_code', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/Zzzzzz/stats',
      headers: authHeader(OWNER_ID),
    });

    expect(res.statusCode).toBe(404);
  });

  it('should_return_401_without_a_token', async () => {
    const code = await shorten(OWNER_ID);

    const res = await app.inject({ method: 'GET', url: `/${code}/stats` });

    expect(res.statusCode).toBe(401);
  });
});

describe('DELETE /:code (owner-only)', () => {
  it('should_return_204_and_remove_the_url_for_the_owner', async () => {
    const code = await shorten(OWNER_ID);

    const res = await app.inject({
      method: 'DELETE',
      url: `/${code}`,
      headers: authHeader(OWNER_ID),
    });

    expect(res.statusCode).toBe(204);
    expect(store.shortUrls.has(code)).toBe(false);
  });

  it('should_emit_a_url_delete_audit_event', async () => {
    const code = await shorten(OWNER_ID);
    auditMock.mockClear();

    await app.inject({ method: 'DELETE', url: `/${code}`, headers: authHeader(OWNER_ID) });

    expect(auditedAction('url.delete')).toBe(true);
  });

  it('should_return_404_not_403_for_a_non_owner_and_keep_the_url', async () => {
    const code = await shorten(OWNER_ID);

    const res = await app.inject({
      method: 'DELETE',
      url: `/${code}`,
      headers: authHeader(STRANGER_ID),
    });

    expect(res.statusCode).toBe(404);
    expect(store.shortUrls.has(code)).toBe(true);
  });

  it('should_return_404_for_a_missing_code', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/Zzzzzz',
      headers: authHeader(OWNER_ID),
    });

    expect(res.statusCode).toBe(404);
  });

  it('should_return_401_without_a_token', async () => {
    const code = await shorten(OWNER_ID);

    const res = await app.inject({ method: 'DELETE', url: `/${code}` });

    expect(res.statusCode).toBe(401);
  });

  it('should_make_a_deleted_code_redirect_to_404', async () => {
    const code = await shorten(OWNER_ID);
    await app.inject({ method: 'DELETE', url: `/${code}`, headers: authHeader(OWNER_ID) });

    const res = await app.inject({ method: 'GET', url: `/${code}` });

    expect(res.statusCode).toBe(404);
  });
});

describe('POST /shorten rate limit (10/min/IP)', () => {
  it('should_return_429_on_the_11th_request_within_a_minute', async () => {
    // 10 succeed, the 11th from the same IP trips the per-route limit (ADR-014).
    for (let i = 0; i < 10; i += 1) {
      const res = await app.inject({
        method: 'POST',
        url: '/shorten',
        headers: authHeader(OWNER_ID),
        payload: { url: PUBLIC_URL },
      });
      expect(res.statusCode).toBe(201);
    }

    const res = await app.inject({
      method: 'POST',
      url: '/shorten',
      headers: authHeader(OWNER_ID),
      payload: { url: PUBLIC_URL },
    });

    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe('RATE_LIMIT_EXCEEDED');
  });
});
