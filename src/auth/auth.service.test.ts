import bcrypt from 'bcrypt';
import { createHash } from 'crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthError, ConflictError } from '../shared/errors';
import type { PublicUser, UsersRepository } from '../users/users.repository';
import type { User } from '@prisma/client';
import type { AuthRepository } from './auth.repository';
import { AuthService } from './auth.service';
import { TokenReuseError } from './token-reuse.error';
import type { RegisterInput, LoginInput } from './auth.schemas';

/**
 * Unit tests for AuthService.
 *
 * Mocks ONLY the two repositories (the layer directly below — ADR-010). bcrypt,
 * jwt, and crypto run for real so password hashing and token rotation are
 * exercised end-to-end. No HTTP, no database.
 */

const USER_ID = '11111111-1111-1111-1111-111111111111';
const SHA256_HEX_LEN = 64;

/**
 * Compute the SHA-256 hex digest exactly as the service does, so a test can
 * locate the row the service persisted in the fake repository.
 *
 * @param token Raw token string.
 * @returns 64-char hex digest.
 */
function sha256(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Build a full User row (with passwordHash) for repository stubs. */
function makeUser(overrides: Partial<User> = {}): User {
  const now = new Date();
  return {
    id: USER_ID,
    email: 'alice@example.com',
    passwordHash: 'placeholder',
    name: 'Alice',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/** Build a PublicUser (no passwordHash). */
function makePublicUser(overrides: Partial<PublicUser> = {}): PublicUser {
  const { passwordHash: _omit, ...rest } = makeUser();
  return { ...rest, ...overrides };
}

const validRegister: RegisterInput = {
  email: 'Alice@Example.com',
  password: 'Password123',
  name: 'Alice',
};

const validLogin: LoginInput = {
  email: 'Alice@Example.com',
  password: 'Password123',
};

/** Create typed, explicit mocks of the two repositories. */
function makeMocks(): {
  users: UsersRepository;
  authRepo: AuthRepository;
  usersMock: {
    findByEmail: ReturnType<typeof vi.fn>;
    findPublicById: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
  };
  authMock: {
    findByHash: ReturnType<typeof vi.fn>;
    createToken: ReturnType<typeof vi.fn>;
    revokeById: ReturnType<typeof vi.fn>;
    revokeFamily: ReturnType<typeof vi.fn>;
  };
} {
  const usersMock = {
    findByEmail: vi.fn(),
    findPublicById: vi.fn(),
    create: vi.fn(),
  };
  const authMock = {
    findByHash: vi.fn(),
    createToken: vi.fn().mockResolvedValue(undefined),
    revokeById: vi.fn().mockResolvedValue(undefined),
    revokeFamily: vi.fn().mockResolvedValue(0),
  };
  return {
    users: usersMock as unknown as UsersRepository,
    authRepo: authMock as unknown as AuthRepository,
    usersMock,
    authMock,
  };
}

describe('AuthService.register', () => {
  let mocks: ReturnType<typeof makeMocks>;
  let service: AuthService;

  beforeEach(() => {
    mocks = makeMocks();
    service = new AuthService(mocks.users, mocks.authRepo);
  });

  it('should_register_user_when_valid_input', async () => {
    mocks.usersMock.findByEmail.mockResolvedValue(null);
    mocks.usersMock.create.mockResolvedValue(makePublicUser());

    const result = await service.register(validRegister);

    expect(result.user.email).toBe('alice@example.com');
    expect(typeof result.accessToken).toBe('string');
    expect(typeof result.refreshToken).toBe('string');
    expect(mocks.usersMock.create).toHaveBeenCalledOnce();
    expect(mocks.authMock.createToken).toHaveBeenCalledOnce();
  });

  it('should_throw_ConflictError_when_email_already_exists', async () => {
    mocks.usersMock.findByEmail.mockResolvedValue(makeUser());

    await expect(service.register(validRegister)).rejects.toBeInstanceOf(ConflictError);
    expect(mocks.usersMock.create).not.toHaveBeenCalled();
  });

  it('should_lowercase_email_before_storing', async () => {
    mocks.usersMock.findByEmail.mockResolvedValue(null);
    mocks.usersMock.create.mockResolvedValue(makePublicUser());

    await service.register(validRegister);

    // Existence check AND the create call must both use the lowercased email.
    expect(mocks.usersMock.findByEmail).toHaveBeenCalledWith('alice@example.com');
    expect(mocks.usersMock.create).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'alice@example.com' }),
    );
  });

  it('should_hash_password_before_storing', async () => {
    mocks.usersMock.findByEmail.mockResolvedValue(null);
    mocks.usersMock.create.mockResolvedValue(makePublicUser());

    await service.register(validRegister);

    const createArg = mocks.usersMock.create.mock.calls[0][0];
    expect(createArg.passwordHash).not.toBe(validRegister.password);
    // The stored hash must actually verify against the plaintext (real bcrypt).
    await expect(bcrypt.compare(validRegister.password, createArg.passwordHash)).resolves.toBe(
      true,
    );
  });
});

describe('AuthService.login', () => {
  let mocks: ReturnType<typeof makeMocks>;
  let service: AuthService;
  let realHash: string;

  beforeEach(async () => {
    mocks = makeMocks();
    service = new AuthService(mocks.users, mocks.authRepo);
    realHash = await bcrypt.hash(validLogin.password, 10);
  });

  it('should_login_successfully_when_valid_credentials', async () => {
    mocks.usersMock.findByEmail.mockResolvedValue(makeUser({ passwordHash: realHash }));

    const result = await service.login(validLogin);

    expect(result.user.id).toBe(USER_ID);
    expect(typeof result.accessToken).toBe('string');
    // The returned public user must never carry the password hash.
    expect((result.user as Record<string, unknown>).passwordHash).toBeUndefined();
  });

  it('should_throw_AuthError_when_email_not_found', async () => {
    mocks.usersMock.findByEmail.mockResolvedValue(null);

    await expect(service.login(validLogin)).rejects.toMatchObject({
      message: 'Invalid email or password',
    });
  });

  it('should_throw_AuthError_when_password_incorrect', async () => {
    mocks.usersMock.findByEmail.mockResolvedValue(makeUser({ passwordHash: realHash }));

    await expect(
      service.login({ ...validLogin, password: 'WrongPassword9' }),
    ).rejects.toMatchObject({ message: 'Invalid email or password' });
  });

  it('should_return_identical_message_for_unknown_email_and_wrong_password', async () => {
    // No user enumeration: both failure modes yield the exact same message.
    mocks.usersMock.findByEmail.mockResolvedValueOnce(null);
    const unknownErr = await service.login(validLogin).catch((e: Error) => e.message);

    mocks.usersMock.findByEmail.mockResolvedValueOnce(makeUser({ passwordHash: realHash }));
    const wrongPwErr = await service
      .login({ ...validLogin, password: 'WrongPassword9' })
      .catch((e: Error) => e.message);

    expect(unknownErr).toBe(wrongPwErr);
    expect(unknownErr).toBe('Invalid email or password');
  });
});

describe('AuthService.refresh', () => {
  let mocks: ReturnType<typeof makeMocks>;
  let service: AuthService;

  beforeEach(() => {
    mocks = makeMocks();
    service = new AuthService(mocks.users, mocks.authRepo);
  });

  /** A still-active refresh token row (revokedAt null, far-future expiry). */
  function activeRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: 'token-row-1',
      hashedToken: sha256('raw-token'),
      family: 'fam-1',
      jti: 'jti-1',
      userId: USER_ID,
      revokedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
      createdAt: new Date(),
      ...overrides,
    };
  }

  it('should_rotate_refresh_token_on_refresh', async () => {
    mocks.authMock.findByHash.mockResolvedValue(activeRecord());
    mocks.usersMock.findPublicById.mockResolvedValue(makePublicUser());

    const result = await service.refresh('raw-token');

    // Old token consumed, a new one minted in the SAME family.
    expect(mocks.authMock.revokeById).toHaveBeenCalledWith('token-row-1');
    expect(mocks.authMock.createToken).toHaveBeenCalledOnce();
    expect(mocks.authMock.createToken.mock.calls[0][0].family).toBe('fam-1');
    expect(typeof result.refreshToken).toBe('string');
  });

  it('should_revoke_entire_family_when_refresh_token_reused', async () => {
    // A consumed (revokedAt set) token presented again => assume theft.
    mocks.authMock.findByHash.mockResolvedValue(
      activeRecord({ revokedAt: new Date(Date.now() - 1000) }),
    );

    // P2.3: client-facing message is the SAME generic string a normal invalid
    // refresh token returns, so reuse is not distinguishable by message text.
    await expect(service.refresh('raw-token')).rejects.toMatchObject({
      message: 'Invalid refresh token',
    });
    expect(mocks.authMock.revokeFamily).toHaveBeenCalledWith('fam-1');
    // No new token may be issued on a reuse attempt.
    expect(mocks.authMock.createToken).not.toHaveBeenCalled();
  });

  it('should_throw_TokenReuseError_when_consumed_token_is_presented_again', async () => {
    // P1.1: reuse must raise the typed TokenReuseError (not a generic
    // AuthError) so the route can emit TOKEN_REUSE_DETECTED. It still extends
    // AuthError, so the client still sees a generic 401 (no info leak).
    mocks.authMock.findByHash.mockResolvedValue(
      activeRecord({ revokedAt: new Date(Date.now() - 1000) }),
    );

    const error = await service.refresh('raw-token').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TokenReuseError);
    // Still an AuthError subtype => global handler maps it to a generic 401.
    expect(error).toBeInstanceOf(AuthError);
    // Reuse context must be populated for the audit call in the route.
    const reuse = error as TokenReuseError;
    expect(reuse.reuseUserId).toBe(USER_ID);
    expect(reuse.reuseFamily).toBe('fam-1');
    expect(reuse.reuseJti).toBe('jti-1');
  });

  it('should_throw_AuthError_when_refresh_token_expired', async () => {
    mocks.authMock.findByHash.mockResolvedValue(
      activeRecord({ expiresAt: new Date(Date.now() - 1000) }),
    );

    await expect(service.refresh('raw-token')).rejects.toMatchObject({
      message: 'Refresh token expired',
    });
    expect(mocks.authMock.createToken).not.toHaveBeenCalled();
  });

  it('should_throw_AuthError_when_refresh_token_unknown', async () => {
    mocks.authMock.findByHash.mockResolvedValue(null);

    await expect(service.refresh('raw-token')).rejects.toBeInstanceOf(AuthError);
    expect(mocks.authMock.revokeById).not.toHaveBeenCalled();
  });
});

describe('AuthService.logout', () => {
  let mocks: ReturnType<typeof makeMocks>;
  let service: AuthService;

  beforeEach(() => {
    mocks = makeMocks();
    service = new AuthService(mocks.users, mocks.authRepo);
  });

  it('should_revoke_family_on_logout', async () => {
    mocks.authMock.findByHash.mockResolvedValue({ family: 'fam-9' });

    await service.logout('raw-token');

    expect(mocks.authMock.revokeFamily).toHaveBeenCalledWith('fam-9');
  });

  it('should_noop_when_no_token_provided', async () => {
    await service.logout(undefined);

    expect(mocks.authMock.findByHash).not.toHaveBeenCalled();
    expect(mocks.authMock.revokeFamily).not.toHaveBeenCalled();
  });

  it('should_return_userId_from_logout_when_token_is_valid', async () => {
    // P1.2: logout must surface the resolved owner so the route audits the
    // real actor instead of a hardcoded null.
    mocks.authMock.findByHash.mockResolvedValue({ family: 'fam-9', userId: USER_ID });

    const actorId = await service.logout('raw-token');

    expect(actorId).toBe(USER_ID);
    expect(mocks.authMock.revokeFamily).toHaveBeenCalledWith('fam-9');
  });

  it('should_return_null_from_logout_when_token_not_found', async () => {
    // P1.2: an unknown token resolves to no actor (null) — logout stays
    // idempotent and the family is never revoked.
    mocks.authMock.findByHash.mockResolvedValue(null);

    const actorId = await service.logout('raw-token');

    expect(actorId).toBeNull();
    expect(mocks.authMock.revokeFamily).not.toHaveBeenCalled();
  });

  it('should_persist_only_a_sha256_hash_never_plaintext', async () => {
    // Cross-check H2: the stored token key is the SHA-256 of the raw token.
    mocks.usersMock.findByEmail.mockResolvedValue(null);
    mocks.usersMock.create.mockResolvedValue(makePublicUser());

    const result = await service.register(validRegister);

    const stored = mocks.authMock.createToken.mock.calls[0][0].hashedToken;
    expect(stored).toHaveLength(SHA256_HEX_LEN);
    expect(stored).toBe(sha256(result.refreshToken));
    expect(stored).not.toContain(result.refreshToken);
  });
});
