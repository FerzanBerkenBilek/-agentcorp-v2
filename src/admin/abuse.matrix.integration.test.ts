import jwt from 'jsonwebtoken';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { FlagState, UserRole } from '@prisma/client';
import type { ShortUrl, User } from '@prisma/client';
import { createFakePrisma, type FakeStore } from '../test/fake-prisma';
import { audit } from '../shared/audit';

/**
 * QA EXTENSION (AP-4) — the HEADLINE end-to-end abuse matrices, complementing
 * backend-dev's admin.routes.integration.test.ts (which covers the happy paths
 * of each endpoint). This file drives the R0–R25 contract through the REAL app
 * (only Prisma faked, DNS mocked) and focuses on the properties a single happy
 * path does not prove:
 *
 *  - Blocklist BYPASS MATRIX through POST /shorten (R15/R16): every encoding of a
 *    stored canonical domain (mixed-case, trailing dot, subdomain, explicit
 *    port, xn--/IDN homograph) is BLOCKed; a genuinely different domain is NOT.
 *  - Role guard / IDOR on ALL 6 admin endpoints (R7/R8/ADR-033).
 *  - Role unforgeability end-to-end: a legacy {sub} token is USER; a role stuffed
 *    in the /shorten body is ignored (R1/R6).
 *  - SSRF NON-REGRESSION (R0): assertSafeUrl still rejects an internal target even
 *    with the screen composed after it; a public URL still ALLOWs.
 *  - Quota counts PER CALENDAR DAY UTC (R24): the boundary is controlled with
 *    fake timers so 100 of yesterday's links do NOT count against today.
 *  - FLAG is not redirectable until approved (R25).
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

let app: FastifyInstance;
let store: FakeStore;

const ADMIN_ID = '11111111-1111-1111-1111-111111111111';
const USER_ID = '22222222-2222-2222-2222-222222222222';
const OTHER_USER_ID = '44444444-4444-4444-4444-444444444444';

function seedUser(id: string, role: UserRole): void {
  const now = new Date();
  const row: User = {
    id,
    email: `${id}@example.com`,
    passwordHash: 'x',
    name: id,
    role,
    createdAt: now,
    updatedAt: now,
  };
  store.users.set(id, row);
}

function tokenFor(userId: string, role: UserRole): string {
  return jwt.sign({ sub: userId, role }, process.env.JWT_SECRET!, {
    algorithm: 'HS256',
    expiresIn: '15m',
  });
}
/** A legacy pre-feature token shaped {sub} ONLY (no role claim, R6). */
function legacyTokenFor(userId: string): string {
  return jwt.sign({ sub: userId }, process.env.JWT_SECRET!, {
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

/** Seed a live ShortUrl for an owner with an explicit createdAt (quota tests). */
function seedShortUrl(code: string, ownerId: string, createdAt: Date): void {
  const row: ShortUrl = {
    id: `id-${code}`,
    code,
    originalUrl: 'https://example.com/',
    ownerId,
    clickCount: 0,
    createdAt,
    lastAccessedAt: null,
    updatedAt: createdAt,
  };
  store.shortUrls.set(code, row);
}

beforeEach(async () => {
  lookupMock.mockReset();
  // Default: every host resolves to a PUBLIC ip, so assertSafeUrl passes and the
  // screen (not SSRF) decides the verdict. SSRF-regression tests override this.
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
  seedUser(OTHER_USER_ID, UserRole.USER);
});

afterEach(async () => {
  vi.useRealTimers();
  await app.close();
});

/** Add `evil.com` to the blocklist as the admin (canonicalized server-side). */
async function blockEvilCom(): Promise<void> {
  const res = await app.inject({
    method: 'POST',
    url: '/admin/blocklist',
    headers: adminAuth(),
    payload: { domain: 'evil.com' },
  });
  expect(res.statusCode).toBe(201);
}

describe('Blocklist BYPASS MATRIX through POST /shorten (R15/R16) — all must BLOCK', () => {
  it.each([
    ['exact', 'https://evil.com/'],
    ['mixed case', 'https://EVIL.com/path'],
    ['trailing FQDN dot', 'https://evil.com./'],
    ['single subdomain', 'https://www.evil.com/'],
    ['deep subdomain', 'https://a.b.c.evil.com/landing?ref=1'],
    ['explicit standard port', 'https://evil.com:443/x'],
    ['http port 80', 'http://evil.com:80/x'],
  ])('should_BLOCK_the_%s_form', async (_label, url) => {
    await blockEvilCom();

    const res = await app.inject({ method: 'POST', url: '/shorten', headers: userAuth(), payload: { url } });

    expect(res.statusCode).toBe(422);
    // Generic client message — the matched rule never leaks (R18/R23).
    expect(res.json().error.message).not.toContain('evil.com');
    expect(store.shortUrls.size).toBe(0);
  });

  it('should_BLOCK_a_cyrillic_homograph_when_its_xn___registrable_is_blocklisted', async () => {
    // Admin blocks the punycode registrable; the raw Cyrillic "еvil.com" submission
    // canonicalizes to the SAME xn-- form and is BLOCKed (IDN bypass closed).
    const add = await app.inject({
      method: 'POST',
      url: '/admin/blocklist',
      headers: adminAuth(),
      payload: { domain: 'xn--vil-qdd.com' },
    });
    expect(add.statusCode).toBe(201);

    const res = await app.inject({
      method: 'POST',
      url: '/shorten',
      headers: userAuth(),
      payload: { url: 'https://еvil.com/login' },
    });

    expect(res.statusCode).toBe(422);
    expect(store.shortUrls.size).toBe(0);
  });
});

describe('Blocklist anti-over-block through POST /shorten (R16) — must NOT block', () => {
  it.each([
    'https://notevil.com/',
    'https://goodevil.com/',
    'https://evil.com.attacker.net/', // registrable owner is attacker.net
  ])('should_ALLOW_the_genuinely_different_domain %s', async (url) => {
    await blockEvilCom();

    const res = await app.inject({ method: 'POST', url: '/shorten', headers: userAuth(), payload: { url } });

    // 201 ALLOW (a live link is minted) — these are NOT evil.com.
    expect(res.statusCode).toBe(201);
    expect(store.shortUrls.size).toBe(1);
  });
});

describe('Admin role guard / IDOR — non-admin is 403 on ALL 6 endpoints (R7/R8)', () => {
  // A real PENDING flagged row so approve/reject reach the guard, not a 404 first.
  async function seedFlaggedId(): Promise<string> {
    await app.inject({ method: 'POST', url: '/shorten', headers: userAuth(), payload: { url: 'https://gooogle.com/' } });
    const listed = await app.inject({ method: 'GET', url: '/admin/flagged', headers: adminAuth() });
    return listed.json().data[0].id as string;
  }

  it('should_403_every_admin_endpoint_for_an_authenticated_non_admin', async () => {
    const id = await seedFlaggedId();
    const cases = [
      { method: 'GET' as const, url: '/admin/blocklist' },
      { method: 'POST' as const, url: '/admin/blocklist', payload: { domain: 'evil.com' } },
      { method: 'DELETE' as const, url: '/admin/blocklist/evil.com' },
      { method: 'GET' as const, url: '/admin/flagged' },
      { method: 'POST' as const, url: `/admin/flagged/${id}/approve` },
      { method: 'POST' as const, url: `/admin/flagged/${id}/reject` },
    ];

    for (const c of cases) {
      const res = await app.inject({ ...c, headers: userAuth() });
      expect(res.statusCode, `${c.method} ${c.url}`).toBe(403);
      expect(res.json().error.code).toBe('FORBIDDEN');
    }
    // The non-admin reached none of the side effects.
    expect(store.flaggedUrls.get(id)?.state).toBe(FlagState.PENDING);
  });

  it('should_401_every_admin_endpoint_with_no_token', async () => {
    const id = await seedFlaggedId();
    const cases = [
      { method: 'GET' as const, url: '/admin/blocklist' },
      { method: 'POST' as const, url: '/admin/blocklist', payload: { domain: 'evil.com' } },
      { method: 'DELETE' as const, url: '/admin/blocklist/evil.com' },
      { method: 'GET' as const, url: '/admin/flagged' },
      { method: 'POST' as const, url: `/admin/flagged/${id}/approve` },
      { method: 'POST' as const, url: `/admin/flagged/${id}/reject` },
    ];

    for (const c of cases) {
      const res = await app.inject(c);
      expect(res.statusCode, `${c.method} ${c.url}`).toBe(401);
    }
  });
});

describe('Role unforgeability end-to-end (R1/R6)', () => {
  it('should_treat_a_legacy_token_without_a_role_claim_as_USER_and_403_admin', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/admin/blocklist',
      headers: { authorization: `Bearer ${legacyTokenFor(USER_ID)}` },
    });

    expect(res.statusCode).toBe(403); // verified as USER, denied admin
  });

  it('should_ignore_a_role_field_stuffed_into_the_shorten_body', async () => {
    // .strict() schema rejects the unknown `role` field outright (mass-assignment
    // defense) — a user cannot smuggle privilege through a request body (R2).
    const res = await app.inject({
      method: 'POST',
      url: '/shorten',
      headers: userAuth(),
      payload: { url: 'https://example.com/', role: 'ADMIN' },
    });

    expect(res.statusCode).toBe(422);
  });

  it('should_403_a_forged_token_that_claims_admin_with_the_wrong_secret', async () => {
    const forged = jwt.sign({ sub: USER_ID, role: UserRole.ADMIN }, 'x'.repeat(40), {
      algorithm: 'HS256',
      expiresIn: '15m',
    });

    const res = await app.inject({
      method: 'GET',
      url: '/admin/blocklist',
      headers: { authorization: `Bearer ${forged}` },
    });

    expect(res.statusCode).toBe(401); // signature fails before the role guard
  });
});

describe('SSRF NON-REGRESSION with the screen composed after assertSafeUrl (R0/R17)', () => {
  it('should_still_reject_an_internal_target_422_and_persist_nothing', async () => {
    // Host resolves to loopback -> assertSafeUrl rejects BEFORE the screen runs.
    lookupMock.mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);

    const res = await app.inject({
      method: 'POST',
      url: '/shorten',
      headers: userAuth(),
      payload: { url: 'https://internal.example.com/' },
    });

    expect(res.statusCode).toBe(422);
    expect(store.shortUrls.size).toBe(0);
  });

  it('should_still_reject_an_ipv4_mapped_ipv6_loopback_literal_422', async () => {
    // The cross-session SSRF fix (extractMappedIpv4) must remain intact — an
    // IP-literal needs no DNS, so this proves the screen did not reorder the path.
    const res = await app.inject({
      method: 'POST',
      url: '/shorten',
      headers: userAuth(),
      payload: { url: 'http://[::ffff:127.0.0.1]/' },
    });

    expect(res.statusCode).toBe(422);
    expect(lookupMock).not.toHaveBeenCalled();
    expect(store.shortUrls.size).toBe(0);
  });

  it('should_still_ALLOW_a_clean_public_url_201', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/shorten',
      headers: userAuth(),
      payload: { url: 'https://example.com/article' },
    });

    expect(res.statusCode).toBe(201);
    expect(store.shortUrls.size).toBe(1);
  });
});

describe('Per-user quota is per CALENDAR DAY UTC (R24)', () => {
  it('should_429_when_the_user_already_has_100_links_today', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-06-10T12:00:00.000Z'));
    const today = new Date('2026-06-10T08:00:00.000Z'); // same UTC day
    for (let i = 0; i < 100; i += 1) {
      seedShortUrl(`today${i}`, USER_ID, today);
    }

    const res = await app.inject({
      method: 'POST',
      url: '/shorten',
      headers: userAuth(),
      payload: { url: 'https://fresh.example.org/' },
    });

    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe('RATE_LIMIT_EXCEEDED');
  });

  it('should_NOT_count_yesterdays_links_against_todays_quota', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-06-10T00:30:00.000Z')); // just after UTC midnight
    const yesterday = new Date('2026-06-09T23:00:00.000Z'); // previous UTC day
    for (let i = 0; i < 100; i += 1) {
      seedShortUrl(`yday${i}`, USER_ID, yesterday);
    }

    const res = await app.inject({
      method: 'POST',
      url: '/shorten',
      headers: userAuth(),
      payload: { url: 'https://fresh.example.org/' },
    });

    // Yesterday's 100 do NOT count -> today's first link succeeds (201).
    expect(res.statusCode).toBe(201);
  });

  it('should_count_quota_per_user_not_globally', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-06-10T12:00:00.000Z'));
    const today = new Date('2026-06-10T08:00:00.000Z');
    // 100 links belong to OTHER_USER, not USER.
    for (let i = 0; i < 100; i += 1) {
      seedShortUrl(`other${i}`, OTHER_USER_ID, today);
    }

    const res = await app.inject({
      method: 'POST',
      url: '/shorten',
      headers: userAuth(),
      payload: { url: 'https://fresh.example.org/' },
    });

    // USER's own count is 0 -> allowed despite OTHER_USER being at the cap.
    expect(res.statusCode).toBe(201);
  });

  it('should_not_consume_quota_on_a_FLAG_or_a_BLOCK', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-06-10T12:00:00.000Z'));
    const today = new Date('2026-06-10T08:00:00.000Z');
    // 99 existing today -> one slot left.
    for (let i = 0; i < 99; i += 1) {
      seedShortUrl(`u${i}`, USER_ID, today);
    }
    await blockEvilCom();

    // A BLOCK and a FLAG each persist NO ShortUrl, so neither spends the last slot.
    const blocked = await app.inject({ method: 'POST', url: '/shorten', headers: userAuth(), payload: { url: 'https://evil.com/' } });
    const flagged = await app.inject({ method: 'POST', url: '/shorten', headers: userAuth(), payload: { url: 'https://gooogle.com/' } });
    expect(blocked.statusCode).toBe(422);
    expect(flagged.statusCode).toBe(202);

    // The last slot is still free -> a clean ALLOW succeeds (proves no quota spent).
    const allowed = await app.inject({ method: 'POST', url: '/shorten', headers: userAuth(), payload: { url: 'https://example.com/' } });
    expect(allowed.statusCode).toBe(201);
  });
});

describe('FLAG path is not redirectable until approved (R25)', () => {
  it('should_persist_a_PENDING_flag_with_no_live_link_and_no_redirect', async () => {
    const flag = await app.inject({
      method: 'POST',
      url: '/shorten',
      headers: userAuth(),
      payload: { url: 'https://gooogle.com/' },
    });
    expect(flag.statusCode).toBe(202);
    expect(store.shortUrls.size).toBe(0);
    expect(store.flaggedUrls.size).toBe(1);

    const flagged = [...store.flaggedUrls.values()][0];
    expect(flagged.state).toBe(FlagState.PENDING);
    expect(flagged.ownerId).toBe(USER_ID);

    // A flagged submission mints NO short code, so there is nothing to redirect to:
    // no live ShortUrl exists, and the public redirect route never resolves a target
    // (a flag UUID is not even a structurally valid 6-char code -> 422, never a 302).
    expect(flagged.proposedCode).toBeNull();
    const redirect = await app.inject({ method: 'GET', url: `/${flagged.id}` });
    expect(redirect.statusCode).not.toBe(302);
  });

  it('should_make_the_link_live_and_redirectable_after_an_admin_approves', async () => {
    await app.inject({ method: 'POST', url: '/shorten', headers: userAuth(), payload: { url: 'https://gooogle.com/' } });
    const listed = await app.inject({ method: 'GET', url: '/admin/flagged', headers: adminAuth() });
    const id = listed.json().data[0].id as string;

    const approve = await app.inject({ method: 'POST', url: `/admin/flagged/${id}/approve`, headers: adminAuth() });
    expect(approve.statusCode).toBe(200);
    const { code } = approve.json().data;

    // Now the minted code redirects (302) to the original submitter's URL.
    const redirect = await app.inject({ method: 'GET', url: `/${code}` });
    expect(redirect.statusCode).toBe(302);
    expect(store.shortUrls.get(code)?.ownerId).toBe(USER_ID);
  });
});
