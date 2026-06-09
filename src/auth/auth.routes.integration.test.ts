import bcrypt from 'bcrypt';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createFakePrisma, type FakeStore } from '../test/fake-prisma';
import { audit, AUDIT_ACTION } from '../shared/audit';

/**
 * HTTP integration tests for the auth routes.
 *
 * Builds the REAL Fastify app via buildApp() — real routes, services, policy,
 * repositories, error handler, helmet, CORS, cookie, rate-limit. ONLY the
 * Prisma data layer is faked (in-memory), so no live PostgreSQL is needed (CI
 * constraint). Each test gets a fresh app + fresh store (no shared state).
 */

// Replace the shared Prisma singleton with an in-memory fake. The factory holds
// the fake so a test helper can reach its store via the exported accessor.
const fake = createFakePrisma();
vi.mock('../shared/prisma', () => ({
  prisma: fake.prisma,
  disconnectPrisma: async () => undefined,
}));

// Spy on the audit logger while keeping AUDIT_ACTION (real string constants) and
// the real audit signature intact. This lets the tests assert that the route
// emits the correct security-audit events (action/actorId/family/jti/outcome)
// without depending on Pino output, which is disabled in test mode (logger.ts).
vi.mock('../shared/audit', async (importActual) => {
  const actual = await importActual<typeof import('../shared/audit')>();
  return { ...actual, audit: vi.fn() };
});

/** The audit() call as a typed mock for assertions. */
const auditMock = vi.mocked(audit);

/**
 * Find the single audit() invocation for a given action.
 *
 * @param action The AUDIT_ACTION value to look for.
 * @returns The fields object passed to that audit call, or undefined.
 */
function auditFieldsFor(action: string): Record<string, unknown> | undefined {
  const call = auditMock.mock.calls.find((c) => c[1] === action);
  return call ? (call[2] as unknown as Record<string, unknown>) : undefined;
}

let app: FastifyInstance;
let store: FakeStore;

/** Clear the in-memory store so each test starts from a clean database. */
function resetStore(): void {
  store.users.clear();
  store.tasks.clear();
  store.refreshTokens.clear();
}

beforeEach(async () => {
  const { buildApp } = await import('../app');
  app = await buildApp();
  store = fake.store;
  resetStore();
  auditMock.mockClear();
});

afterEach(async () => {
  await app.close();
});

const validRegisterBody = {
  email: 'alice@example.com',
  password: 'Password123',
  name: 'Alice',
};

/**
 * Extract the refresh_token value from a Set-Cookie header (string or array).
 *
 * @param raw The set-cookie header value.
 * @returns The raw refresh token, or undefined.
 */
function extractRefreshCookie(raw: string | string[] | undefined): string | undefined {
  if (!raw) {
    return undefined;
  }
  const cookies = Array.isArray(raw) ? raw : [raw];
  const match = cookies.find((c) => c.startsWith('refresh_token='));
  return match ? match.split(';')[0].split('=')[1] : undefined;
}

describe('POST /auth/register', () => {
  it('should_return_201_and_access_token_when_register_succeeds', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: validRegisterBody,
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(typeof body.data.accessToken).toBe('string');
    expect(body.data.user.email).toBe('alice@example.com');
    // Password hash must never appear in the response.
    expect(JSON.stringify(body)).not.toContain('Password123');
    expect(extractRefreshCookie(res.headers['set-cookie'])).toBeTruthy();
  });

  it('should_return_409_when_email_already_registered', async () => {
    await app.inject({ method: 'POST', url: '/auth/register', payload: validRegisterBody });

    const res = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: validRegisterBody,
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('CONFLICT');
  });

  it('should_return_422_when_password_too_short', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { ...validRegisterBody, password: 'Ab1' },
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('should_lowercase_email_so_mixed_case_register_then_login_succeeds', async () => {
    await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { ...validRegisterBody, email: 'Alice@Example.COM' },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'alice@example.com', password: 'Password123' },
    });

    expect(res.statusCode).toBe(200);
  });
});

describe('POST /auth/login', () => {
  beforeEach(async () => {
    await app.inject({ method: 'POST', url: '/auth/register', payload: validRegisterBody });
  });

  it('should_return_200_and_set_refresh_cookie_when_login_succeeds', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'alice@example.com', password: 'Password123' },
    });

    expect(res.statusCode).toBe(200);
    const cookie = res.headers['set-cookie'];
    expect(extractRefreshCookie(cookie)).toBeTruthy();
    // Refresh cookie must be HttpOnly + SameSite=Strict + path-scoped to /auth.
    const cookieStr = Array.isArray(cookie) ? cookie.join(';') : String(cookie);
    expect(cookieStr).toContain('HttpOnly');
    expect(cookieStr).toContain('SameSite=Strict');
    expect(cookieStr).toContain('Path=/auth');
  });

  it('should_return_401_when_login_credentials_invalid', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'alice@example.com', password: 'WrongPassword9' },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json().error.message).toBe('Invalid email or password');
  });

  it('should_return_429_when_rate_limit_exceeded', async () => {
    // Credential endpoints allow 5 requests / 15 min per IP (H4 / ADR-014).
    const bad = {
      method: 'POST' as const,
      url: '/auth/login',
      payload: { email: 'nobody@example.com', password: 'WrongPassword9' },
    };
    const codes: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      const res = await app.inject(bad);
      codes.push(res.statusCode);
    }

    expect(codes.slice(0, 5).every((c) => c === 401)).toBe(true);
    expect(codes[5]).toBe(429);
  });
});

describe('POST /auth/refresh + /auth/logout', () => {
  let refreshCookie: string;

  beforeEach(async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: validRegisterBody,
    });
    refreshCookie = extractRefreshCookie(res.headers['set-cookie'])!;
  });

  it('should_return_200_and_new_tokens_when_refresh_succeeds', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      cookies: { refresh_token: refreshCookie },
    });

    expect(res.statusCode).toBe(200);
    const newCookie = extractRefreshCookie(res.headers['set-cookie']);
    expect(newCookie).toBeTruthy();
    // Rotation: the new refresh token differs from the presented one.
    expect(newCookie).not.toBe(refreshCookie);
    expect(typeof res.json().data.accessToken).toBe('string');
  });

  it('should_return_401_when_refresh_token_reused', async () => {
    // First refresh consumes the original token (rotation).
    await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      cookies: { refresh_token: refreshCookie },
    });

    // Presenting the now-consumed token again => reuse => family revoked => 401.
    const reuse = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      cookies: { refresh_token: refreshCookie },
    });

    expect(reuse.statusCode).toBe(401);
  });

  it('should_revoke_whole_family_when_refresh_token_reused', async () => {
    const rotated = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      cookies: { refresh_token: refreshCookie },
    });
    const rotatedCookie = extractRefreshCookie(rotated.headers['set-cookie'])!;

    // Replay the consumed original => entire family revoked.
    await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      cookies: { refresh_token: refreshCookie },
    });

    // Even the freshly-rotated token is now dead (family-wide revocation).
    const afterReuse = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      cookies: { refresh_token: rotatedCookie },
    });
    expect(afterReuse.statusCode).toBe(401);
  });

  it('should_return_401_when_refresh_called_without_cookie', async () => {
    const res = await app.inject({ method: 'POST', url: '/auth/refresh' });

    expect(res.statusCode).toBe(401);
  });

  it('should_clear_cookie_and_return_success_on_logout', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      cookies: { refresh_token: refreshCookie },
    });

    expect(res.statusCode).toBe(200);
    const cleared = Array.isArray(res.headers['set-cookie'])
      ? res.headers['set-cookie'].join(';')
      : String(res.headers['set-cookie']);
    // clearCookie sets an expired cookie.
    expect(cleared).toContain('refresh_token=');

    // After logout the token's family is revoked: refresh now fails.
    const afterLogout = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      cookies: { refresh_token: refreshCookie },
    });
    expect(afterLogout.statusCode).toBe(401);
  });
});

describe('security: password storage', () => {
  it('should_store_only_a_bcrypt_hash_never_plaintext', async () => {
    await app.inject({ method: 'POST', url: '/auth/register', payload: validRegisterBody });

    const stored = [...store.users.values()][0];
    expect(stored.passwordHash).not.toBe('Password123');
    await expect(bcrypt.compare('Password123', stored.passwordHash)).resolves.toBe(true);
  });
});

describe('audit: token-reuse + logout actor (P1.1 / P1.2)', () => {
  /**
   * Register a user and return the actor id plus the issued refresh cookie.
   *
   * @returns The new user's id and the raw refresh token cookie value.
   */
  async function registerAndGetSession(): Promise<{ userId: string; refreshCookie: string }> {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: validRegisterBody,
    });
    const userId = res.json().data.user.id as string;
    const refreshCookie = extractRefreshCookie(res.headers['set-cookie'])!;
    return { userId, refreshCookie };
  }

  it('should_emit_TOKEN_REUSE_DETECTED_audit_when_consumed_refresh_token_is_replayed', async () => {
    const { userId, refreshCookie } = await registerAndGetSession();

    // First refresh consumes the original token (rotation).
    await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      cookies: { refresh_token: refreshCookie },
    });

    // Replay the now-consumed token => reuse detection fires.
    const reuse = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      cookies: { refresh_token: refreshCookie },
    });

    // Client still gets a 401 with the AUTH_ERROR code — same status/code as any
    // other refresh failure, so reuse is not distinguishable by HTTP status.
    // P2.3: the message is now ALSO the generic "Invalid refresh token", so reuse
    // is indistinguishable from a normal invalid token by message text either.
    expect(reuse.statusCode).toBe(401);
    expect(reuse.json().error.code).toBe('AUTH_ERROR');
    expect(reuse.json().error.message).toBe('Invalid refresh token');

    // But the security audit event MUST be recorded with the real actor.
    const fields = auditFieldsFor(AUDIT_ACTION.TOKEN_REUSE_DETECTED);
    expect(fields).toBeDefined();
    expect(fields).toMatchObject({ actorId: userId, outcome: 'failure' });
    // Reuse context (family/jti) is carried for forensic correlation (ADR-012).
    expect(typeof fields!.family).toBe('string');
    expect(typeof fields!.jti).toBe('string');
  });

  it('should_audit_real_userId_on_logout', async () => {
    const { userId, refreshCookie } = await registerAndGetSession();
    auditMock.mockClear();

    const res = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      cookies: { refresh_token: refreshCookie },
    });

    expect(res.statusCode).toBe(200);
    const fields = auditFieldsFor(AUDIT_ACTION.LOGOUT);
    expect(fields).toBeDefined();
    // P1.2: the resolved owner, NOT a hardcoded null.
    expect(fields).toMatchObject({ actorId: userId, outcome: 'success' });
  });

  it('should_audit_null_actorId_on_logout_when_token_unknown', async () => {
    // No cookie present => no token to resolve => actor is null, but logout
    // remains idempotent and still succeeds.
    const res = await app.inject({ method: 'POST', url: '/auth/logout' });

    expect(res.statusCode).toBe(200);
    const fields = auditFieldsFor(AUDIT_ACTION.LOGOUT);
    expect(fields).toBeDefined();
    expect(fields).toMatchObject({ actorId: null, outcome: 'success' });
  });
});
