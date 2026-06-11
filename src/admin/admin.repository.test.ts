import { BlockedDomain, PrismaClient } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it } from 'vitest';
import { ConflictError } from '../shared/errors';
import { createFakePrisma, type FakeStore } from '../test/fake-prisma';
import { AdminRepository } from './admin.repository';

/**
 * Repository-level unit tests for AdminRepository.addBlockedDomain — the P2002
 * create seam relocated into the repo by ADR-044 Option B. The admin service
 * tests mock the repo, so this is the only test covering the relocated non-P2002
 * `throw error` rethrow branch (P2002 -> err is also exercised via integration,
 * but is asserted here directly too for a focused regression). The rethrow case
 * end-to-end-verifies security's "non-P2002 errors are rethrown unchanged" claim.
 */

const DOMAIN = 'gooogle.com';
const NOTE = 'typosquat';
const CURATOR = 'admin-id-1111';

/**
 * Build a PrismaClient whose `blockedDomain.create` rejects with the supplied
 * error, to drive the repository's non-P2002 rethrow branch. Only the single
 * method the repo touches is implemented; widened at the injection boundary
 * (never `as any`).
 */
function rejectingClient(error: unknown): PrismaClient {
  const stub = {
    blockedDomain: {
      create: (): Promise<BlockedDomain> => Promise.reject(error),
    },
  };
  return stub as unknown as PrismaClient;
}

let store: FakeStore;
let repo: AdminRepository;

beforeEach(() => {
  const fake = createFakePrisma();
  store = fake.store;
  repo = new AdminRepository(fake.prisma);
});

describe('AdminRepository.addBlockedDomain', () => {
  it('should_return_ok_with_the_persisted_blocked_domain_on_success', async () => {
    const result = await repo.addBlockedDomain({
      domain: DOMAIN,
      note: NOTE,
      addedByUserId: CURATOR,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.domain).toBe(DOMAIN);
      expect(result.value.note).toBe(NOTE);
      expect(result.value.addedByUserId).toBe(CURATOR);
    }
    expect(store.blockedDomains.has(DOMAIN)).toBe(true);
  });

  it('should_return_err_ConflictError_when_the_domain_already_exists', async () => {
    await repo.addBlockedDomain({ domain: DOMAIN, note: NOTE, addedByUserId: CURATOR });

    const result = await repo.addBlockedDomain({
      domain: DOMAIN,
      note: 'again',
      addedByUserId: CURATOR,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(ConflictError);
      expect(result.error.message).toBe('Domain is already on the blocklist');
    }
  });

  it('should_rethrow_a_plain_non_P2002_error_unchanged', async () => {
    const boom = new Error('connection lost');
    const failing = new AdminRepository(rejectingClient(boom));

    await expect(
      failing.addBlockedDomain({ domain: DOMAIN, note: NOTE, addedByUserId: CURATOR }),
    ).rejects.toBe(boom);
  });

  it('should_rethrow_a_non_P2002_prisma_error_unchanged', async () => {
    const fkError = new Prisma.PrismaClientKnownRequestError('Foreign key constraint failed', {
      code: 'P2003',
      clientVersion: 'test',
    });
    const failing = new AdminRepository(rejectingClient(fkError));

    await expect(
      failing.addBlockedDomain({ domain: DOMAIN, note: NOTE, addedByUserId: CURATOR }),
    ).rejects.toBe(fkError);
  });
});
