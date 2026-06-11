import { PrismaClient, ShortUrl } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it } from 'vitest';
import { ConflictError } from '../shared/errors';
import { createFakePrisma, type FakeStore } from '../test/fake-prisma';
import { UrlsRepository } from './urls.repository';

/**
 * Repository-level unit tests for UrlsRepository.create — the P2002 create seam
 * relocated into the repo by ADR-044 Option B. The service tests mock the repo,
 * so these are the ONLY tests that exercise the relocated `catch` branches:
 * the P2002 -> err(ConflictError) conversion AND the non-P2002 `throw error`
 * rethrow (end-to-end-verifying security's "non-P2002 errors are rethrown
 * unchanged" claim against a real PrismaClientKnownRequestError envelope).
 *
 * Uses the real `createFakePrisma` harness (its shortUrl store enforces a real
 * UNIQUE(code) P2002) for the success/collision branches, and a tiny typed
 * rejecting stub client for the rethrow branch.
 */

const CODE = 'Abc123';
const OWNER = 'owner-id-1111';
const RAW_URL = 'https://example.com/';

/**
 * Build a PrismaClient whose `shortUrl.create` rejects with the supplied error,
 * to drive the repository's non-P2002 rethrow branch. Only the single method the
 * repo touches is implemented; the partial is widened at the injection boundary
 * (mirroring how the integration tests cast the fake), never with `as any`.
 */
function rejectingClient(error: unknown): PrismaClient {
  const stub = {
    shortUrl: {
      create: (): Promise<ShortUrl> => Promise.reject(error),
    },
  };
  return stub as unknown as PrismaClient;
}

let store: FakeStore;
let repo: UrlsRepository;

beforeEach(() => {
  const fake = createFakePrisma();
  store = fake.store;
  repo = new UrlsRepository(fake.prisma);
});

describe('UrlsRepository.create', () => {
  it('should_return_ok_with_the_persisted_short_url_on_success', async () => {
    const result = await repo.create({ code: CODE, originalUrl: RAW_URL, ownerId: OWNER });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.code).toBe(CODE);
      expect(result.value.originalUrl).toBe(RAW_URL);
      expect(result.value.ownerId).toBe(OWNER);
      expect(result.value.clickCount).toBe(0);
    }
    // Persisted to the store under its unique business key (the code).
    expect(store.shortUrls.has(CODE)).toBe(true);
  });

  it('should_return_err_ConflictError_when_the_code_already_exists', async () => {
    // Seed a row with the same code so the second create collides -> real P2002.
    await repo.create({ code: CODE, originalUrl: RAW_URL, ownerId: OWNER });

    const result = await repo.create({
      code: CODE,
      originalUrl: 'https://other.example/',
      ownerId: OWNER,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(ConflictError);
      expect(result.error.message).toBe('Could not allocate a unique short code, please retry');
    }
  });

  it('should_rethrow_a_plain_non_P2002_error_unchanged', async () => {
    const boom = new Error('connection lost');
    const failing = new UrlsRepository(rejectingClient(boom));

    await expect(
      failing.create({ code: CODE, originalUrl: RAW_URL, ownerId: OWNER }),
    ).rejects.toBe(boom);
  });

  it('should_rethrow_a_non_P2002_prisma_error_unchanged', async () => {
    // A different known-request code (P2003 FK violation) must NOT be swallowed
    // as a ConflictError — it propagates so the global handler 500s it.
    const fkError = new Prisma.PrismaClientKnownRequestError('Foreign key constraint failed', {
      code: 'P2003',
      clientVersion: 'test',
    });
    const failing = new UrlsRepository(rejectingClient(fkError));

    await expect(
      failing.create({ code: CODE, originalUrl: RAW_URL, ownerId: OWNER }),
    ).rejects.toBe(fkError);
  });
});
