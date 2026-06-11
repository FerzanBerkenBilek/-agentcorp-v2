import { BlockedDomain, FlaggedUrl, FlagState } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConflictError, NotFoundError, ValidationError } from '../shared/errors';
import { err, ok } from '../shared/result';
import type { UrlsService } from '../urls/urls.service';
import { AdminService } from './admin.service';
import type { AdminRepository } from './admin.repository';

/**
 * Unit tests for AdminService. Mocks the repository and the UrlsService (the
 * layers directly below). Covers canonicalize-on-write (ADR-034), idempotent
 * add (409), remove miss, and the flagged state machine (404 missing / 409
 * terminal / approve mints a ShortUrl / reject deletes).
 */

const ADMIN_ID = 'admin-1111';
const OWNER_ID = 'owner-2222';
const FLAG_ID = '99999999-9999-9999-9999-999999999999';

function makeFlagged(overrides: Partial<FlaggedUrl> = {}): FlaggedUrl {
  return {
    id: FLAG_ID,
    candidateUrl: 'https://gooogle.com/',
    proposedCode: null,
    ownerId: OWNER_ID,
    confidenceScore: 60,
    state: FlagState.PENDING,
    flaggedReason: 'typosquat:google.com',
    createdAt: new Date(),
    reviewedAt: null,
    reviewedByUserId: null,
    ...overrides,
  };
}

function makeMocks(): {
  service: AdminService;
  repo: Record<string, ReturnType<typeof vi.fn>>;
  urls: { createApproved: ReturnType<typeof vi.fn> };
} {
  const repo = {
    addBlockedDomain: vi.fn(),
    listBlockedDomains: vi.fn(),
    removeBlockedDomain: vi.fn(),
    isBlocked: vi.fn(),
    createFlagged: vi.fn(),
    listPendingFlagged: vi.fn(),
    findFlaggedById: vi.fn(),
    reviewFlagged: vi.fn(),
    deleteFlagged: vi.fn(),
  };
  const urls = { createApproved: vi.fn() };
  const service = new AdminService(
    repo as unknown as AdminRepository,
    urls as unknown as UrlsService,
  );
  return { service, repo, urls };
}

let m: ReturnType<typeof makeMocks>;
beforeEach(() => {
  m = makeMocks();
});

describe('AdminService.addToBlocklist', () => {
  it('should_canonicalize_the_domain_before_persisting', async () => {
    m.repo.addBlockedDomain.mockResolvedValue(ok({} as BlockedDomain));

    await m.service.addToBlocklist(ADMIN_ID, 'WWW.EVIL.com.', 'bad');

    expect(m.repo.addBlockedDomain).toHaveBeenCalledWith({
      domain: 'evil.com',
      note: 'bad',
      addedByUserId: ADMIN_ID,
    });
  });

  it('should_set_addedByUserId_from_the_admin_argument_not_input', async () => {
    m.repo.addBlockedDomain.mockResolvedValue(ok({} as BlockedDomain));

    await m.service.addToBlocklist(ADMIN_ID, 'evil.com');

    expect(m.repo.addBlockedDomain.mock.calls[0][0].addedByUserId).toBe(ADMIN_ID);
  });

  it('should_throw_ConflictError_on_a_duplicate_domain', async () => {
    m.repo.addBlockedDomain.mockResolvedValue(err(new ConflictError('Domain is already on the blocklist')));

    await expect(m.service.addToBlocklist(ADMIN_ID, 'evil.com')).rejects.toBeInstanceOf(
      ConflictError,
    );
  });

  it('should_throw_ValidationError_for_an_uncanonicalizable_domain', async () => {
    await expect(m.service.addToBlocklist(ADMIN_ID, '')).rejects.toBeInstanceOf(ValidationError);
    expect(m.repo.addBlockedDomain).not.toHaveBeenCalled();
  });

  it('should_rethrow_a_non_unique_repository_error_unchanged', async () => {
    m.repo.addBlockedDomain.mockRejectedValue(new Error('connection lost'));

    await expect(m.service.addToBlocklist(ADMIN_ID, 'evil.com')).rejects.toThrow('connection lost');
  });
});

describe('AdminService.removeFromBlocklist', () => {
  it('should_canonicalize_then_report_removed_when_a_row_was_deleted', async () => {
    m.repo.removeBlockedDomain.mockResolvedValue(1);

    const result = await m.service.removeFromBlocklist('A.B.EVIL.com');

    expect(m.repo.removeBlockedDomain).toHaveBeenCalledWith('evil.com');
    expect(result.removed).toBe(true);
  });

  it('should_report_not_removed_when_no_row_matched', async () => {
    m.repo.removeBlockedDomain.mockResolvedValue(0);

    expect((await m.service.removeFromBlocklist('evil.com')).removed).toBe(false);
  });
});

describe('AdminService.approveFlagged', () => {
  it('should_mint_a_short_url_and_mark_the_row_approved', async () => {
    m.repo.findFlaggedById.mockResolvedValue(makeFlagged());
    m.urls.createApproved.mockResolvedValue({ code: 'Abc123' });
    m.repo.reviewFlagged.mockResolvedValue(makeFlagged({ state: FlagState.APPROVED }));

    const result = await m.service.approveFlagged(ADMIN_ID, FLAG_ID);

    expect(m.urls.createApproved).toHaveBeenCalledWith(OWNER_ID, 'https://gooogle.com/');
    expect(m.repo.reviewFlagged).toHaveBeenCalledWith(
      FLAG_ID,
      expect.objectContaining({ state: FlagState.APPROVED, reviewedByUserId: ADMIN_ID }),
    );
    expect(result.code).toBe('Abc123');
  });

  it('should_throw_NotFoundError_for_an_unknown_id', async () => {
    m.repo.findFlaggedById.mockResolvedValue(null);

    await expect(m.service.approveFlagged(ADMIN_ID, FLAG_ID)).rejects.toBeInstanceOf(NotFoundError);
    expect(m.urls.createApproved).not.toHaveBeenCalled();
  });

  it('should_throw_ConflictError_when_the_row_is_already_terminal', async () => {
    m.repo.findFlaggedById.mockResolvedValue(makeFlagged({ state: FlagState.REJECTED }));

    await expect(m.service.approveFlagged(ADMIN_ID, FLAG_ID)).rejects.toBeInstanceOf(ConflictError);
    expect(m.urls.createApproved).not.toHaveBeenCalled();
  });
});

describe('AdminService.rejectFlagged', () => {
  it('should_delete_a_pending_row', async () => {
    m.repo.findFlaggedById.mockResolvedValue(makeFlagged());
    m.repo.deleteFlagged.mockResolvedValue(undefined);

    await m.service.rejectFlagged(ADMIN_ID, FLAG_ID);

    expect(m.repo.deleteFlagged).toHaveBeenCalledWith(FLAG_ID);
  });

  it('should_throw_NotFoundError_for_an_unknown_id', async () => {
    m.repo.findFlaggedById.mockResolvedValue(null);

    await expect(m.service.rejectFlagged(ADMIN_ID, FLAG_ID)).rejects.toBeInstanceOf(NotFoundError);
    expect(m.repo.deleteFlagged).not.toHaveBeenCalled();
  });

  it('should_throw_ConflictError_when_already_terminal', async () => {
    m.repo.findFlaggedById.mockResolvedValue(makeFlagged({ state: FlagState.APPROVED }));

    await expect(m.service.rejectFlagged(ADMIN_ID, FLAG_ID)).rejects.toBeInstanceOf(ConflictError);
    expect(m.repo.deleteFlagged).not.toHaveBeenCalled();
  });
});

describe('AdminService — passthrough reads', () => {
  it('should_list_blocklist_entries', async () => {
    m.repo.listBlockedDomains.mockResolvedValue([{ domain: 'evil.com' } as BlockedDomain]);

    expect(await m.service.listBlocklist()).toHaveLength(1);
  });

  it('should_list_pending_flagged', async () => {
    m.repo.listPendingFlagged.mockResolvedValue([makeFlagged()]);

    expect(await m.service.listFlagged()).toHaveLength(1);
  });

  it('should_record_a_flag_as_pending', async () => {
    m.repo.createFlagged.mockResolvedValue(makeFlagged());

    await m.service.recordFlag(OWNER_ID, 'https://gooogle.com/', 60, 'typosquat:google.com');

    expect(m.repo.createFlagged).toHaveBeenCalledWith({
      ownerId: OWNER_ID,
      candidateUrl: 'https://gooogle.com/',
      confidenceScore: 60,
      flaggedReason: 'typosquat:google.com',
    });
  });
});
