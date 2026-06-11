import { ShortUrl } from '@prisma/client';
import { AppError, ConflictError, ERROR_CODE, HTTP_STATUS } from '../shared/errors';
import { generateShortCode } from '../shared/short-code';
import { assertSafeUrl } from '../shared/url-safety';
import { screenUrl, ScreenResult, type BlocklistLookup } from '../shared/url-screen';
import { assertIsOwner } from './urls.policy';
import { UrlsRepository } from './urls.repository';

/** Max insert attempts before giving up on code-collision retry (ADR-022). */
export const MAX_INSERT_RETRIES = 5;

/** Per-user calendar-day-UTC short-URL quota (ADR-032, R24). 101st is rejected. */
export const DAILY_QUOTA = 100;

/**
 * 429 — the per-user daily short-URL quota is exhausted (R24). A distinct type
 * (not a generic ConflictError) so the route can audit QUOTA_EXCEEDED and the
 * client gets a 429 (rate-limit family) rather than a 409.
 */
export class QuotaExceededError extends AppError {
  constructor() {
    super(
      ERROR_CODE.RATE_LIMIT,
      'Daily short-URL limit reached. Try again tomorrow.',
      HTTP_STATUS.TOO_MANY_REQUESTS,
    );
    this.name = 'QuotaExceededError';
  }
}

/** Click stats returned for an owned short URL. */
export interface ShortUrlStats {
  clickCount: number;
  createdAt: Date;
  lastAccessedAt: Date | null;
}

/** Outcome of a screened shorten request (discriminated by `decision`). */
export type ShortenOutcome =
  | { decision: 'ALLOW'; url: ShortUrl }
  | { decision: 'FLAG'; safeUrl: string; screen: ScreenResult }
  | { decision: 'BLOCK'; safeUrl: string; screen: ScreenResult };

/**
 * URL-shortener business logic + authorization orchestration.
 *
 * The caller's id (from the JWT) is the only trusted source of ownership — it
 * is never taken from the request body (mass-assignment defense). All SSRF /
 * open-redirect validation is delegated to `assertSafeUrl` (ADR-019) at write
 * time; all owner-only authorization is delegated to `urls.policy` (ADR-021).
 */
export class UrlsService {
  /**
   * @param urls Short-URL repository (persistence).
   * @param isBlocked Blocklist equality probe injected from the admin repo
   *   (ADR-034) so the screen stays composable + testable and the service does
   *   not depend on the admin module directly.
   */
  constructor(
    private readonly urls: UrlsRepository,
    private readonly isBlocked: BlocklistLookup,
  ) {}

  /**
   * The shorten pipeline (R24/R0/R17/R15/R25): per-user daily-quota gate →
   * `assertSafeUrl` (SSRF, untouched) → `screenUrl` (composed STRICTLY AFTER) →
   * verdict. ALLOW persists a live ShortUrl; FLAG/BLOCK persist NO ShortUrl and
   * return the screen result so the route can audit + respond generically. A
   * FLAG is persisted as a PENDING row by the caller (route), not here, so the
   * service stays free of the admin aggregate.
   *
   * @param userId Authenticated caller (becomes ownerId; never from the body).
   * @param rawUrl The untrusted destination URL.
   * @returns A discriminated outcome: ALLOW (with the created url), FLAG, or BLOCK.
   * @throws QuotaExceededError (429) if the daily quota is exhausted (R24).
   * @throws ValidationError if the URL fails SSRF/safety validation (ADR-019).
   * @throws ConflictError if a unique code could not be allocated after retries.
   */
  async shorten(userId: string, rawUrl: string): Promise<ShortenOutcome> {
    await this.assertUnderDailyQuota(userId);
    // R0/R17: SSRF validation FIRST and unchanged; screen composes strictly after
    // on its normalized href and never overrides its ValidationError.
    const safeUrl = await assertSafeUrl(rawUrl);
    const screen = await screenUrl(safeUrl, this.isBlocked);

    if (screen.decision === 'BLOCK') {
      return { decision: 'BLOCK', safeUrl, screen };
    }
    if (screen.decision === 'FLAG') {
      return { decision: 'FLAG', safeUrl, screen };
    }
    const url = await this.insertWithRetry(safeUrl, userId);
    return { decision: 'ALLOW', url };
  }

  /**
   * Mint a live ShortUrl for an admin-APPROVED flagged candidate (ADR-032). The
   * URL was already SSRF-validated + screened at flag time, so this path does
   * NOT re-screen or re-check the submitter's quota (the user already spent the
   * intent; approval is an admin moderation action) — it only allocates a unique
   * code and persists, reusing the ADR-022 insert-retry.
   *
   * @param ownerId The original submitter (owner of the minted link).
   * @param originalUrl The already-validated destination URL.
   * @returns The created short URL.
   * @throws ConflictError if a unique code could not be allocated after retries.
   */
  async createApproved(ownerId: string, originalUrl: string): Promise<ShortUrl> {
    return this.insertWithRetry(originalUrl, ownerId);
  }

  /**
   * Enforce the per-user 100/calendar-day-UTC quota PRE-validation/PRE-persist
   * (R24). Counts only live short_urls for the caller created since UTC midnight
   * (the composite-index range path). Best-effort under concurrency (AP-11
   * accepted: the count gate + the 10/min/IP route limit bound the race window).
   *
   * @param userId The caller whose daily usage is checked.
   * @throws QuotaExceededError if the caller already owns >= DAILY_QUOTA links today.
   */
  private async assertUnderDailyQuota(userId: string): Promise<void> {
    const count = await this.urls.countCreatedSince(userId, utcMidnight());
    if (count >= DAILY_QUOTA) {
      throw new QuotaExceededError();
    }
  }

  /**
   * Resolve a code to its stored destination and atomically record the click
   * (ADR-023). Used by the anonymous redirect route.
   *
   * @param code The public short code.
   * @returns The destination URL to redirect to, or null if the code is unknown.
   */
  async resolveAndTrack(code: string): Promise<string | null> {
    const url = await this.urls.findByCode(code);
    if (!url) {
      return null;
    }
    await this.urls.recordClick(code);
    return url.originalUrl;
  }

  /**
   * Get click stats for a code the caller owns (owner-only, H3/ADR-021).
   *
   * @param userId Authenticated caller.
   * @param code The public short code.
   * @returns The click count, creation time, and last-access time.
   * @throws NotFoundError if the code is missing or not owned by the caller (404).
   */
  async getStats(userId: string, code: string): Promise<ShortUrlStats> {
    const url = assertIsOwner(await this.urls.findByCode(code), userId);
    return {
      clickCount: url.clickCount,
      createdAt: url.createdAt,
      lastAccessedAt: url.lastAccessedAt,
    };
  }

  /**
   * Delete a code the caller owns (owner-only, H3/ADR-021).
   *
   * @param userId Authenticated caller.
   * @param code The public short code.
   * @returns A promise that resolves once deleted.
   * @throws NotFoundError if the code is missing or not owned by the caller (404).
   */
  async delete(userId: string, code: string): Promise<void> {
    assertIsOwner(await this.urls.findByCode(code), userId);
    await this.urls.delete(code);
  }

  /**
   * Insert with bounded retry on code collision. The UNIQUE(code) constraint is
   * the authoritative guard; on a P2002 we regenerate and retry, never
   * check-then-insert (which races, ADR-022).
   *
   * @param originalUrl The validated, normalized destination URL.
   * @param ownerId The server-set owner id.
   * @returns The created short URL.
   * @throws ConflictError if no unique code was allocated within the retry budget.
   */
  private async insertWithRetry(originalUrl: string, ownerId: string): Promise<ShortUrl> {
    for (let attempt = 0; attempt < MAX_INSERT_RETRIES; attempt += 1) {
      // A non-P2002 error still THROWS from the repo and bubbles out immediately;
      // a P2002 collision is returned as err(ConflictError), so we retry on !r.ok.
      const r = await this.urls.create({ code: generateShortCode(), originalUrl, ownerId });
      if (r.ok) {
        return r.value;
      }
    }
    throw new ConflictError('Could not allocate a unique short code, please retry');
  }
}

/**
 * The most recent UTC calendar-day midnight (the daily-quota window lower bound,
 * ADR-032). Mirrors Postgres `date_trunc('day', now() AT TIME ZONE 'UTC')`.
 *
 * @returns A Date at 00:00:00.000 UTC of the current day.
 */
function utcMidnight(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}
