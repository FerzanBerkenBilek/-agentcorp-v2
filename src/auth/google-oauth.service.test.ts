import bcrypt from 'bcrypt';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UserRole } from '@prisma/client';
import { createFakePrisma, type FakeStore } from '../test/fake-prisma';
import { AuthError, ConflictError } from '../shared/errors';
import { verifyAccessToken } from '../shared/jwt';
import type { UsersRepository } from '../users/users.repository';
import type { AuthService } from './auth.service';
import type { GoogleIdentity } from './google-oauth.client';

/**
 * Unit tests for the create-or-link ladder in AuthService.loginWithGoogle
 * (Phase OA-5, qa-engineer). EXTENDS the route smoke suite: this drives the
 * SERVICE directly against the in-memory fake Prisma so the ladder's branch
 * matrix (G1–G7) and the race/conflict backstops (G5/G6) are exercised in
 * isolation, with assertions on the persisted store AND the issued token
 * (same path as /auth/login — G22, no fork).
 *
 * No network: the GoogleIdentity is the already-back-channel-verified value the
 * client would have returned; loginWithGoogle never talks to Google.
 */

// The fake Prisma is created at module top and injected via vi.mock (which
// vitest hoists above this line — the `fake` reference is resolved lazily inside
// the factory, so it is initialized by the time the factory runs). The service
// and repositories are imported DYNAMICALLY in beforeEach (after the mock is in
// place) so their transitive `../shared/prisma` import binds to the fake — the
// same harness shape the route integration test uses for buildApp.
const fake = createFakePrisma();
vi.mock('../shared/prisma', () => ({
  prisma: fake.prisma,
  disconnectPrisma: async () => undefined,
}));

let service: AuthService;
let store: FakeStore;

/** Seed an existing account directly into the store. */
function seedUser(over: Partial<Parameters<FakeStore['users']['set']>[1]> = {}): {
  id: string;
} {
  const id = crypto.randomUUID();
  store.users.set(id, {
    id,
    email: 'victim@example.com',
    passwordHash: 'real-password-hash',
    name: 'Victim',
    role: UserRole.USER,
    googleId: null,
    googleEmail: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  });
  return { id };
}

const identity = (over: Partial<GoogleIdentity> = {}): GoogleIdentity => ({
  sub: 'g-sub-default',
  email: 'person@example.com',
  emailVerified: true,
  name: 'A Person',
  ...over,
});

beforeEach(async () => {
  // Dynamic import AFTER vi.mock('../shared/prisma') is applied, so the repos
  // bind to the fake Prisma (not a live client).
  const { AuthService } = await import('./auth.service');
  const { UsersRepository } = await import('../users/users.repository');
  const { AuthRepository } = await import('./auth.repository');
  store = fake.store;
  store.users.clear();
  store.refreshTokens.clear();
  service = new AuthService(new UsersRepository(), new AuthRepository());
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AuthService.loginWithGoogle — ladder branches (G1–G3)', () => {
  it('should_CREATE_a_passwordless_USER_when_verified_and_no_match_G3', async () => {
    const result = await service.loginWithGoogle(
      identity({ sub: 'g-new', email: 'New@Example.com', name: 'New Person' }),
    );

    expect(result.kind).toBe('create');
    const row = [...store.users.values()].find((u) => u.googleId === 'g-new');
    expect(row).toBeDefined();
    expect(row?.email).toBe('new@example.com'); // lowercased by the service
    expect(row?.googleEmail).toBe('new@example.com');
    expect(row?.role).toBe(UserRole.USER); // never elevated from Google claims
    // The issued access token signs the role from the persisted column (G22).
    expect(verifyAccessToken(result.accessToken).role).toBe(UserRole.USER);
    expect(result.refreshToken).toBeTruthy();
    // A refresh token row was persisted via the SAME issueNewSession path (G22).
    expect(store.refreshTokens.size).toBe(1);
  });

  it('should_default_name_to_the_email_when_google_sends_no_name', async () => {
    const result = await service.loginWithGoogle(
      identity({ sub: 'g-noname', email: 'noname@example.com', name: null }),
    );
    expect(result.kind).toBe('create');
    const row = [...store.users.values()].find((u) => u.googleId === 'g-noname');
    expect(row?.name).toBe('noname@example.com');
  });

  it('should_LINK_a_verified_email_to_an_existing_password_account_first_time_only_G2', async () => {
    const { id } = seedUser({ email: 'victim@example.com', googleId: null });

    const result = await service.loginWithGoogle(
      identity({ sub: 'g-link', email: 'Victim@Example.com' }),
    );

    expect(result.kind).toBe('link');
    expect(result.user.id).toBe(id); // same account, not a duplicate
    expect(store.users.size).toBe(1);
    expect(store.users.get(id)?.googleId).toBe('g-link'); // bound
    expect(store.users.get(id)?.googleEmail).toBe('victim@example.com');
  });

  it('should_LOGIN_a_returning_user_resolved_by_google_id_only_G1', async () => {
    const { id } = seedUser({
      email: 'returning@example.com',
      googleId: 'g-returning',
      googleEmail: 'returning@example.com',
    });

    // Google now reports a DIFFERENT email; resolution is by google_id (G1),
    // so no re-link, no new row, and the email match path is never consulted.
    const result = await service.loginWithGoogle(
      identity({ sub: 'g-returning', email: 'changed@example.com' }),
    );

    expect(result.kind).toBe('login');
    expect(result.user.id).toBe(id);
    expect(store.users.size).toBe(1);
    expect(store.users.get(id)?.email).toBe('returning@example.com'); // unchanged
  });

  it('should_resolve_by_google_id_even_when_google_now_reports_unverified_email_G1_precedence', async () => {
    // A previously-linked account is a trusted prior decision: the google_id
    // lookup precedes the email_verified gate, so a returning user still logs in
    // even if Google currently reports email_verified=false.
    const { id } = seedUser({ googleId: 'g-trust', email: 'trust@example.com' });
    const result = await service.loginWithGoogle(
      identity({ sub: 'g-trust', emailVerified: false, email: 'trust@example.com' }),
    );
    expect(result.kind).toBe('login');
    expect(result.user.id).toBe(id);
  });
});

describe('AuthService.loginWithGoogle — takeover defense (G4)', () => {
  it('should_REJECT_an_unverified_email_matching_a_victim_account_no_link_no_create_no_session', async () => {
    // THE account-takeover regression test (security OA-F1 / G4). An attacker
    // controls a Google account asserting the victim's email but UNVERIFIED.
    // The service MUST reject before any email-based link/create: the victim's
    // row stays untouched (google_id NULL), no new row, and no session/token is
    // issued. Root cause guarded: email_verified gate sits AFTER the google_id
    // lookup but BEFORE the findByEmail branch (auth.service.ts loginWithGoogle).
    const { id } = seedUser({ email: 'victim@example.com', googleId: null });

    await expect(
      service.loginWithGoogle(
        identity({ sub: 'attacker-sub', email: 'victim@example.com', emailVerified: false }),
      ),
    ).rejects.toBeInstanceOf(AuthError);

    expect(store.users.get(id)?.googleId).toBeNull(); // victim untouched
    expect(store.users.size).toBe(1); // no separate account created
    expect(store.refreshTokens.size).toBe(0); // NO session issued
  });

  it('should_REJECT_an_unverified_email_with_no_existing_account_no_create', async () => {
    // Unverified + no match must NOT silently create a separate account either.
    await expect(
      service.loginWithGoogle(
        identity({ sub: 'g-unv', email: 'brandnew@example.com', emailVerified: false }),
      ),
    ).rejects.toBeInstanceOf(AuthError);
    expect(store.users.size).toBe(0);
    expect(store.refreshTokens.size).toBe(0);
  });
});

describe('AuthService.loginWithGoogle — race + uniqueness backstops (G5/G6)', () => {
  it('should_raise_ConflictError_when_the_target_account_is_already_linked_race_lost_G5', async () => {
    // findByEmail finds the row, but it is ALREADY linked to a different google_id.
    // The conditional updateMany (WHERE google_id IS NULL) matches 0 rows → repo
    // returns null → the service maps that to a ConflictError (the first-time-only
    // race-lost / re-point-attempt signal). The existing link is NOT overwritten.
    const { id } = seedUser({
      email: 'victim@example.com',
      googleId: 'already-linked-sub',
      googleEmail: 'victim@example.com',
    });

    await expect(
      service.loginWithGoogle(identity({ sub: 'second-identity', email: 'victim@example.com' })),
    ).rejects.toBeInstanceOf(ConflictError);

    expect(store.users.get(id)?.googleId).toBe('already-linked-sub'); // not overwritten
  });

  it('should_map_a_UNIQUE_google_id_violation_on_CREATE_to_ConflictError_G6', async () => {
    // A concurrent create of the same google_id: a row with that sub already
    // exists under a DIFFERENT email, so findByGoogleId is bypassed only because
    // we simulate the create-time race by pre-seeding the sub then forcing the
    // ladder down the create branch with a non-matching email. The fake Prisma
    // mirrors UNIQUE(google_id) → P2002 → guardUniqueGoogleId → ConflictError.
    seedUser({ email: 'other@example.com', googleId: 'dup-sub' });
    // findByGoogleId('dup-sub') WOULD match — so to force the create path while
    // still hitting the UNIQUE backstop, use a verified identity whose email has
    // no account but whose sub collides. We stub findByGoogleId to miss once
    // (simulating the read-then-write race window) so create runs and hits P2002.
    const usersRepo = (service as unknown as { users: UsersRepository }).users;
    vi.spyOn(usersRepo, 'findByGoogleId').mockResolvedValueOnce(null);

    await expect(
      service.loginWithGoogle(identity({ sub: 'dup-sub', email: 'fresh@example.com' })),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('should_propagate_a_non_P2002_repo_error_unchanged_not_swallow_it_as_a_conflict', async () => {
    // guardUniqueGoogleId only maps P2002 → ConflictError; ANY other error (e.g.
    // a DB connection failure during the create write) must propagate unchanged
    // so it is NOT silently masked as a benign "already linked" conflict. Drive
    // the create branch (verified, no email match) and make the write throw.
    const usersRepo = (service as unknown as { users: UsersRepository }).users;
    const boom = new Error('connection reset by peer');
    vi.spyOn(usersRepo, 'createFromOAuth').mockRejectedValueOnce(boom);

    const thrown = await service
      .loginWithGoogle(identity({ sub: 'g-boom', email: 'boom@example.com' }))
      .catch((e) => e);
    expect(thrown).toBe(boom); // exact same error object, not a ConflictError
    expect(thrown).not.toBeInstanceOf(ConflictError);
  });

  it('should_map_a_UNIQUE_google_id_violation_on_LINK_to_ConflictError_G6', async () => {
    // Genuine concurrent-race reachability: in the real ladder findByGoogleId
    // runs FIRST, so for the link updateMany to trip UNIQUE(google_id) the
    // incoming sub must be UNCLAIMED at read time (findByGoogleId misses) but
    // claimed by another row by write time. Model that read-then-write window by
    // stubbing findByGoogleId to miss once; the holder row already owns the sub,
    // so the conditional link write trips P2002 → guardUniqueGoogleId →
    // ConflictError, and the victim row is NOT bound.
    seedUser({ email: 'holder@example.com', googleId: 'incoming-sub' });
    const { id } = seedUser({ email: 'victim@example.com', googleId: null });
    const usersRepo = (service as unknown as { users: UsersRepository }).users;
    vi.spyOn(usersRepo, 'findByGoogleId').mockResolvedValueOnce(null);

    await expect(
      service.loginWithGoogle(identity({ sub: 'incoming-sub', email: 'victim@example.com' })),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(store.users.get(id)?.googleId).toBeNull(); // victim not bound
  });
});

describe('AuthService — passwordless OAuth user cannot password-login (G7)', () => {
  it('should_fail_closed_when_an_oauth_created_account_attempts_password_login', async () => {
    // Create a passwordless account via OAuth (stamped with the dummy hash).
    await service.loginWithGoogle(identity({ sub: 'g-pw', email: 'pwless@example.com' }));
    const row = [...store.users.values()].find((u) => u.googleId === 'g-pw');
    expect(row).toBeDefined();

    // Any password attempt must fail closed: bcrypt.compare vs the non-matching
    // dummy hash returns false → generic AuthError (no enumeration). Sanity-check
    // the stored hash really is a non-matching bcrypt hash.
    expect(await bcrypt.compare('any-password', row!.passwordHash)).toBe(false);
    await expect(
      service.login({ email: 'pwless@example.com', password: 'any-password' }),
    ).rejects.toBeInstanceOf(AuthError);
  });
});
