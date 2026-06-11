import { Prisma, ShortUrl } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConflictError, NotFoundError, ValidationError } from '../shared/errors';
import { assertSafeUrl } from '../shared/url-safety';
import { generateShortCode } from '../shared/short-code';
import { UrlsService, MAX_INSERT_RETRIES, DAILY_QUOTA, QuotaExceededError } from './urls.service';
import type { UrlsRepository } from './urls.repository';

/**
 * Unit tests for UrlsService.
 *
 * Mocks ONLY the repository and the two collaborating shared helpers
 * (`assertSafeUrl`, `generateShortCode`) — `assertSafeUrl`'s SSRF matrix and the
 * code generator have their own dedicated unit tests, so here we control them to
 * isolate the service's orchestration: ownerId sourcing, collision-retry,
 * click-tracking, and owner-only authorization (the REAL urls.policy is
 * exercised through the service, never mocked).
 */

const SAFE_URL = 'https://example.com/';
const RAW_URL = 'https://example.com';
const CALLER = 'caller-id-1111';
const OTHER = 'other-id-2222';
const CODE = 'Abc123';

vi.mock('../shared/url-safety', () => ({ assertSafeUrl: vi.fn() }));
vi.mock('../shared/short-code', () => ({ generateShortCode: vi.fn() }));

const assertSafeUrlMock = vi.mocked(assertSafeUrl);
const generateShortCodeMock = vi.mocked(generateShortCode);

/** Build a ShortUrl row owned by `ownerId`. */
function makeShortUrl(overrides: Partial<ShortUrl> = {}): ShortUrl {
  const now = new Date();
  return {
    id: 'url-id-aaaa',
    code: CODE,
    originalUrl: SAFE_URL,
    ownerId: CALLER,
    clickCount: 0,
    createdAt: now,
    lastAccessedAt: null,
    updatedAt: now,
    ...overrides,
  };
}

/** A real Prisma P2002 (unique-violation) error — what UNIQUE(code) raises. */
function uniqueViolation(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
    meta: { target: ['code'] },
  });
}

function makeMocks(): {
  service: UrlsService;
  repo: {
    create: ReturnType<typeof vi.fn>;
    findByCode: ReturnType<typeof vi.fn>;
    recordClick: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
    countCreatedSince: ReturnType<typeof vi.fn>;
  };
  isBlocked: ReturnType<typeof vi.fn>;
} {
  const repo = {
    create: vi.fn(),
    findByCode: vi.fn(),
    recordClick: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    // Default: under quota (0 links today) so the gate passes.
    countCreatedSince: vi.fn().mockResolvedValue(0),
  };
  // Default: nothing is on the blocklist, so the screen ALLOWs a public URL.
  const isBlocked = vi.fn().mockResolvedValue(false);
  const service = new UrlsService(repo as unknown as UrlsRepository, isBlocked);
  return { service, repo, isBlocked };
}

beforeEach(() => {
  assertSafeUrlMock.mockReset();
  generateShortCodeMock.mockReset();
  assertSafeUrlMock.mockResolvedValue(SAFE_URL);
  generateShortCodeMock.mockReturnValue(CODE);
});

describe('UrlsService.shorten', () => {
  it('should_validate_the_url_via_assertSafeUrl_before_persisting', async () => {
    const m = makeMocks();
    m.repo.create.mockResolvedValue(makeShortUrl());

    await m.service.shorten(CALLER, RAW_URL);

    expect(assertSafeUrlMock).toHaveBeenCalledWith(RAW_URL);
    // The persisted originalUrl is the VALIDATED/normalized value, not the raw input.
    expect(m.repo.create.mock.calls[0][0].originalUrl).toBe(SAFE_URL);
  });

  it('should_set_ownerId_from_the_caller_argument_not_from_input', async () => {
    const m = makeMocks();
    m.repo.create.mockResolvedValue(makeShortUrl());

    await m.service.shorten(CALLER, RAW_URL);

    expect(m.repo.create).toHaveBeenCalledOnce();
    expect(m.repo.create.mock.calls[0][0].ownerId).toBe(CALLER);
  });

  it('should_propagate_ValidationError_from_unsafe_urls_without_persisting', async () => {
    const m = makeMocks();
    assertSafeUrlMock.mockRejectedValue(new ValidationError('URL failed safety validation'));

    await expect(m.service.shorten(CALLER, 'http://169.254.169.254/')).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(m.repo.create).not.toHaveBeenCalled();
  });

  it('should_retry_on_a_single_code_collision_then_succeed', async () => {
    const m = makeMocks();
    generateShortCodeMock.mockReturnValueOnce('Coll01').mockReturnValueOnce('Uniq02');
    m.repo.create
      .mockRejectedValueOnce(uniqueViolation())
      .mockResolvedValueOnce(makeShortUrl({ code: 'Uniq02' }));

    const outcome = await m.service.shorten(CALLER, RAW_URL);

    expect(outcome.decision).toBe('ALLOW');
    expect(outcome.decision === 'ALLOW' && outcome.url.code).toBe('Uniq02');
    expect(m.repo.create).toHaveBeenCalledTimes(2);
  });

  it('should_throw_ConflictError_after_exhausting_retries_on_persistent_collision', async () => {
    const m = makeMocks();
    m.repo.create.mockRejectedValue(uniqueViolation());

    await expect(m.service.shorten(CALLER, RAW_URL)).rejects.toBeInstanceOf(ConflictError);
    expect(m.repo.create).toHaveBeenCalledTimes(MAX_INSERT_RETRIES);
  });

  it('should_rethrow_a_non_unique_repository_error_without_retrying', async () => {
    const m = makeMocks();
    m.repo.create.mockRejectedValue(new Error('connection lost'));

    await expect(m.service.shorten(CALLER, RAW_URL)).rejects.toThrow('connection lost');
    expect(m.repo.create).toHaveBeenCalledOnce();
  });
});

describe('UrlsService.shorten — daily quota (R24)', () => {
  it('should_reject_with_ConflictError_when_the_quota_is_reached', async () => {
    const m = makeMocks();
    m.repo.countCreatedSince.mockResolvedValue(DAILY_QUOTA);

    await expect(m.service.shorten(CALLER, RAW_URL)).rejects.toBeInstanceOf(QuotaExceededError);
    // Quota is checked PRE-validate/PRE-persist: nothing is created, no SSRF call.
    expect(m.repo.create).not.toHaveBeenCalled();
    expect(assertSafeUrlMock).not.toHaveBeenCalled();
  });

  it('should_allow_the_request_when_just_under_the_quota', async () => {
    const m = makeMocks();
    m.repo.countCreatedSince.mockResolvedValue(DAILY_QUOTA - 1);
    m.repo.create.mockResolvedValue(makeShortUrl());

    const outcome = await m.service.shorten(CALLER, RAW_URL);

    expect(outcome.decision).toBe('ALLOW');
  });

  it('should_count_only_the_caller_links_since_utc_midnight', async () => {
    const m = makeMocks();
    m.repo.create.mockResolvedValue(makeShortUrl());

    await m.service.shorten(CALLER, RAW_URL);

    const [ownerId, since] = m.repo.countCreatedSince.mock.calls[0];
    expect(ownerId).toBe(CALLER);
    // The window lower bound is UTC midnight (time-of-day all zero).
    expect(since.getUTCHours()).toBe(0);
    expect(since.getUTCMinutes()).toBe(0);
    expect(since.getUTCSeconds()).toBe(0);
  });
});

describe('UrlsService.shorten — screen verdicts (ADR-034/035)', () => {
  it('should_BLOCK_and_persist_nothing_when_the_domain_is_blocklisted', async () => {
    const m = makeMocks();
    m.isBlocked.mockResolvedValue(true);

    const outcome = await m.service.shorten(CALLER, RAW_URL);

    expect(outcome.decision).toBe('BLOCK');
    expect(m.repo.create).not.toHaveBeenCalled();
  });

  it('should_FLAG_and_persist_nothing_for_a_typosquat', async () => {
    const m = makeMocks();
    assertSafeUrlMock.mockResolvedValue('https://gooogle.com/');

    const outcome = await m.service.shorten(CALLER, 'https://gooogle.com');

    expect(outcome.decision).toBe('FLAG');
    expect(outcome.decision === 'FLAG' && outcome.safeUrl).toBe('https://gooogle.com/');
    expect(m.repo.create).not.toHaveBeenCalled();
  });

  it('should_run_the_screen_strictly_after_assertSafeUrl', async () => {
    const m = makeMocks();
    m.repo.create.mockResolvedValue(makeShortUrl());

    await m.service.shorten(CALLER, RAW_URL);

    // The blocklist probe receives the canonical host of assertSafeUrl's href.
    expect(assertSafeUrlMock).toHaveBeenCalled();
    expect(m.isBlocked).toHaveBeenCalledWith('example.com');
  });
});

describe('UrlsService.createApproved', () => {
  it('should_mint_a_short_url_without_screening_or_quota_check', async () => {
    const m = makeMocks();
    m.repo.create.mockResolvedValue(makeShortUrl());

    const url = await m.service.createApproved(CALLER, SAFE_URL);

    expect(url.code).toBe(CODE);
    expect(m.repo.create.mock.calls[0][0].ownerId).toBe(CALLER);
    // The approval path does NOT re-screen or re-check quota.
    expect(m.isBlocked).not.toHaveBeenCalled();
    expect(m.repo.countCreatedSince).not.toHaveBeenCalled();
  });
});

describe('UrlsService.resolveAndTrack', () => {
  it('should_return_the_target_url_and_record_a_click_for_a_known_code', async () => {
    const m = makeMocks();
    m.repo.findByCode.mockResolvedValue(makeShortUrl({ originalUrl: SAFE_URL }));

    const target = await m.service.resolveAndTrack(CODE);

    expect(target).toBe(SAFE_URL);
    expect(m.repo.recordClick).toHaveBeenCalledWith(CODE);
  });

  it('should_return_null_and_not_record_a_click_for_an_unknown_code', async () => {
    const m = makeMocks();
    m.repo.findByCode.mockResolvedValue(null);

    const target = await m.service.resolveAndTrack('Zzzzzz');

    expect(target).toBeNull();
    expect(m.repo.recordClick).not.toHaveBeenCalled();
  });
});

describe('UrlsService.getStats (real policy)', () => {
  it('should_return_stats_when_the_caller_owns_the_code', async () => {
    const m = makeMocks();
    const created = new Date('2026-01-01T00:00:00.000Z');
    const last = new Date('2026-01-02T00:00:00.000Z');
    m.repo.findByCode.mockResolvedValue(
      makeShortUrl({ ownerId: CALLER, clickCount: 7, createdAt: created, lastAccessedAt: last }),
    );

    const stats = await m.service.getStats(CALLER, CODE);

    expect(stats).toEqual({ clickCount: 7, createdAt: created, lastAccessedAt: last });
  });

  it('should_throw_NotFoundError_when_a_non_owner_requests_stats', async () => {
    const m = makeMocks();
    m.repo.findByCode.mockResolvedValue(makeShortUrl({ ownerId: OTHER }));

    await expect(m.service.getStats(CALLER, CODE)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('should_throw_NotFoundError_when_the_code_is_missing', async () => {
    const m = makeMocks();
    m.repo.findByCode.mockResolvedValue(null);

    await expect(m.service.getStats(CALLER, CODE)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('UrlsService.delete (real policy)', () => {
  it('should_delete_when_the_caller_owns_the_code', async () => {
    const m = makeMocks();
    m.repo.findByCode.mockResolvedValue(makeShortUrl({ ownerId: CALLER }));

    await m.service.delete(CALLER, CODE);

    expect(m.repo.delete).toHaveBeenCalledWith(CODE);
  });

  it('should_throw_NotFoundError_and_not_delete_when_a_non_owner_tries', async () => {
    const m = makeMocks();
    m.repo.findByCode.mockResolvedValue(makeShortUrl({ ownerId: OTHER }));

    await expect(m.service.delete(CALLER, CODE)).rejects.toBeInstanceOf(NotFoundError);
    expect(m.repo.delete).not.toHaveBeenCalled();
  });

  it('should_throw_NotFoundError_when_deleting_a_missing_code', async () => {
    const m = makeMocks();
    m.repo.findByCode.mockResolvedValue(null);

    await expect(m.service.delete(CALLER, CODE)).rejects.toBeInstanceOf(NotFoundError);
    expect(m.repo.delete).not.toHaveBeenCalled();
  });
});
