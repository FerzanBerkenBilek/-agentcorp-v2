import { PrismaClient, User } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it } from 'vitest';
import { ConflictError } from '../shared/errors';
import { createFakePrisma } from '../test/fake-prisma';
import { UsersRepository } from './users.repository';

/**
 * Repository-level unit tests for UsersRepository.create and createFromOAuth —
 * the P2002 create seam relocated into the repo by ADR-044 Option B. The auth
 * service tests mock the repo, so these cover the relocated `catch` branches:
 * P2002 -> err(ConflictError) AND the non-P2002 `throw error` rethrow
 * (end-to-end-verifying security's "non-P2002 errors are rethrown unchanged"
 * claim against a real PrismaClientKnownRequestError envelope).
 *
 * Success returns a PublicUser (the runtime `select` must drop passwordHash, M8)
 * — asserted explicitly here so a select regression fails this test.
 */

const EMAIL = 'user@example.com';
const HASH = 'argon2-hash-value';
const NAME = 'Test User';
const GOOGLE_ID = 'google-sub-123';
const GOOGLE_EMAIL = 'user@gmail.com';

/**
 * Build a PrismaClient whose `user.create` rejects with the supplied error, to
 * drive the repository's non-P2002 rethrow branch. Only the single method the
 * repo touches is implemented; widened at the injection boundary (never
 * `as any`).
 */
function rejectingClient(error: unknown): PrismaClient {
  const stub = {
    user: {
      create: (): Promise<User> => Promise.reject(error),
    },
  };
  return stub as unknown as PrismaClient;
}

let repo: UsersRepository;

beforeEach(() => {
  const fake = createFakePrisma();
  repo = new UsersRepository(fake.prisma);
});

describe('UsersRepository.create', () => {
  it('should_return_ok_with_a_public_user_without_passwordHash_on_success', async () => {
    const result = await repo.create({ email: EMAIL, passwordHash: HASH, name: NAME });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.email).toBe(EMAIL);
      expect(result.value.name).toBe(NAME);
      // PublicUser = Omit<User,'passwordHash'>: the secret must NOT be returned.
      expect('passwordHash' in result.value).toBe(false);
    }
  });

  it('should_return_err_ConflictError_when_the_email_already_exists', async () => {
    await repo.create({ email: EMAIL, passwordHash: HASH, name: NAME });

    const result = await repo.create({ email: EMAIL, passwordHash: HASH, name: 'Someone Else' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(ConflictError);
      expect(result.error.message).toBe('Email address is already registered');
    }
  });

  it('should_rethrow_a_non_P2002_error_unchanged', async () => {
    const boom = new Error('connection lost');
    const failing = new UsersRepository(rejectingClient(boom));

    await expect(
      failing.create({ email: EMAIL, passwordHash: HASH, name: NAME }),
    ).rejects.toBe(boom);
  });
});

describe('UsersRepository.createFromOAuth', () => {
  it('should_return_ok_with_a_public_user_carrying_the_google_identity_on_success', async () => {
    const result = await repo.createFromOAuth({
      email: EMAIL,
      passwordHash: HASH,
      name: NAME,
      googleId: GOOGLE_ID,
      googleEmail: GOOGLE_EMAIL,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.googleId).toBe(GOOGLE_ID);
      expect(result.value.googleEmail).toBe(GOOGLE_EMAIL);
      expect('passwordHash' in result.value).toBe(false);
    }
  });

  it('should_return_err_ConflictError_when_the_email_already_exists', async () => {
    // Seed a password account on the same email; the OAuth create then collides
    // on UNIQUE(email) -> real P2002 (the G6 takeover backstop).
    await repo.create({ email: EMAIL, passwordHash: HASH, name: NAME });

    const result = await repo.createFromOAuth({
      email: EMAIL,
      passwordHash: HASH,
      name: NAME,
      googleId: GOOGLE_ID,
      googleEmail: GOOGLE_EMAIL,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(ConflictError);
      expect(result.error.message).toBe('This Google account cannot be linked');
    }
  });

  it('should_return_err_ConflictError_when_the_google_id_already_exists', async () => {
    // First OAuth account binds the googleId; a second on a different email but
    // the same googleId collides on UNIQUE(google_id) -> real P2002.
    await repo.createFromOAuth({
      email: EMAIL,
      passwordHash: HASH,
      name: NAME,
      googleId: GOOGLE_ID,
      googleEmail: GOOGLE_EMAIL,
    });

    const result = await repo.createFromOAuth({
      email: 'other@example.com',
      passwordHash: HASH,
      name: 'Other',
      googleId: GOOGLE_ID,
      googleEmail: GOOGLE_EMAIL,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(ConflictError);
      expect(result.error.message).toBe('This Google account cannot be linked');
    }
  });

  it('should_rethrow_a_non_P2002_error_unchanged', async () => {
    const fkError = new Prisma.PrismaClientKnownRequestError('Foreign key constraint failed', {
      code: 'P2003',
      clientVersion: 'test',
    });
    const failing = new UsersRepository(rejectingClient(fkError));

    await expect(
      failing.createFromOAuth({
        email: EMAIL,
        passwordHash: HASH,
        name: NAME,
        googleId: GOOGLE_ID,
        googleEmail: GOOGLE_EMAIL,
      }),
    ).rejects.toBe(fkError);
  });
});
