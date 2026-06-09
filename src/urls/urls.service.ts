import { Prisma, ShortUrl } from '@prisma/client';
import { ConflictError } from '../shared/errors';
import { generateShortCode } from '../shared/short-code';
import { assertSafeUrl } from '../shared/url-safety';
import { assertIsOwner } from './urls.policy';
import { UrlsRepository } from './urls.repository';

/** Max insert attempts before giving up on code-collision retry (ADR-022). */
export const MAX_INSERT_RETRIES = 5;

/** Prisma unique-constraint violation code (raised by UNIQUE(code)). */
const PRISMA_UNIQUE_VIOLATION = 'P2002';

/** Click stats returned for an owned short URL. */
export interface ShortUrlStats {
  clickCount: number;
  createdAt: Date;
  lastAccessedAt: Date | null;
}

/**
 * URL-shortener business logic + authorization orchestration.
 *
 * The caller's id (from the JWT) is the only trusted source of ownership — it
 * is never taken from the request body (mass-assignment defense). All SSRF /
 * open-redirect validation is delegated to `assertSafeUrl` (ADR-019) at write
 * time; all owner-only authorization is delegated to `urls.policy` (ADR-021).
 */
export class UrlsService {
  /** @param urls Short-URL repository (persistence). */
  constructor(private readonly urls: UrlsRepository) {}

  /**
   * Validate a destination URL, then store it under a freshly generated,
   * collision-checked short code owned by the caller.
   *
   * @param userId Authenticated caller (becomes ownerId).
   * @param rawUrl The untrusted destination URL.
   * @returns The created short URL.
   * @throws ValidationError if the URL fails SSRF/safety validation (ADR-019).
   * @throws ConflictError if a unique code could not be allocated after retries.
   */
  async shorten(userId: string, rawUrl: string): Promise<ShortUrl> {
    const safeUrl = await assertSafeUrl(rawUrl);
    return this.insertWithRetry(safeUrl, userId);
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
      try {
        return await this.urls.create({ code: generateShortCode(), originalUrl, ownerId });
      } catch (error) {
        if (!isUniqueViolation(error)) {
          throw error;
        }
      }
    }
    throw new ConflictError('Could not allocate a unique short code, please retry');
  }
}

/**
 * True if the error is a Prisma unique-constraint (P2002) violation — i.e. a
 * short-code collision worth retrying.
 *
 * @param error The caught error.
 * @returns True if it is a P2002 known-request error.
 */
function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === PRISMA_UNIQUE_VIOLATION
  );
}
