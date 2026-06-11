import { Prisma, PrismaClient, ShortUrl } from '@prisma/client';
import { ConflictError } from '../shared/errors';
import { err, ok, Result } from '../shared/result';
import { prisma } from '../shared/prisma';

/** Fields persisted on short-URL creation (code + ownerId are server-set). */
export interface CreateShortUrlData {
  code: string;
  originalUrl: string;
  ownerId: string;
}

/**
 * Repository for the ShortUrl aggregate — the ONLY place short URLs are
 * read/written (ADR-010 layering). Contains no authorization or business rules
 * (those live in the policy and service). The click increment is performed
 * atomically in the database (ADR-023), never read-modify-write.
 */
export class UrlsRepository {
  /** @param db Injected Prisma client (defaults to the shared singleton). */
  constructor(private readonly db: PrismaClient = prisma) {}

  /**
   * Insert a short URL. The UNIQUE(code) constraint is the authoritative
   * collision guard; a duplicate code surfaces as Prisma error P2002, which this
   * method catches and returns as `err(ConflictError)` (ADR-044) so the service's
   * insert-retry branches on the value instead of catching a throw (ADR-022).
   * Any non-P2002 error is rethrown unchanged.
   *
   * @param data Code, validated originalUrl, and server-set ownerId.
   * @returns ok(ShortUrl) on success, or err(ConflictError) on a code collision.
   */
  async create(data: CreateShortUrlData): Promise<Result<ShortUrl, ConflictError>> {
    try {
      return ok(await this.db.shortUrl.create({ data }));
    } catch (error) {
      if (isUniqueViolation(error)) {
        return err(new ConflictError('Could not allocate a unique short code, please retry'));
      }
      throw error;
    }
  }

  /**
   * Look up a short URL by its public code (the hot redirect/stats path —
   * backed by the UNIQUE index). Unscoped; authorization is applied by the
   * policy in the service layer.
   *
   * @param code The 6-char public code.
   * @returns The short URL, or null if no such code exists.
   */
  async findByCode(code: string): Promise<ShortUrl | null> {
    return this.db.shortUrl.findUnique({ where: { code } });
  }

  /**
   * Count the live short URLs a user has created since `since` — the per-user
   * daily-quota probe (ADR-032/R24). The WHERE shape (`owner_id = ? AND
   * created_at >= ?`) is served index-only by the composite
   * `short_urls(owner_id, created_at)` (db-engineer EXPLAIN-verified); `since`
   * MUST be UTC midnight so the count is a calendar-day-UTC window.
   *
   * @param ownerId The owner whose links are counted.
   * @param since Inclusive lower bound on createdAt (UTC midnight for the day).
   * @returns The number of live short URLs created by the owner since `since`.
   */
  async countCreatedSince(ownerId: string, since: Date): Promise<number> {
    return this.db.shortUrl.count({ where: { ownerId, createdAt: { gte: since } } });
  }

  /**
   * Atomically record a click: increment clickCount and set lastAccessedAt in a
   * single UPDATE (ADR-023). Serialized by the row lock, so concurrent redirects
   * cannot lose an increment.
   *
   * @param code The code being redirected.
   * @returns A promise that resolves once the row is updated.
   */
  async recordClick(code: string): Promise<void> {
    await this.db.shortUrl.update({
      where: { code },
      data: { clickCount: { increment: 1 }, lastAccessedAt: new Date() },
    });
  }

  /**
   * Delete a short URL by code.
   *
   * @param code The code to delete.
   * @returns A promise that resolves once the row is deleted.
   */
  async delete(code: string): Promise<void> {
    await this.db.shortUrl.delete({ where: { code } });
  }
}

/**
 * True if the error is a Prisma unique-constraint (P2002) violation — i.e. a
 * short-code collision the create seam converts to a ConflictError (ADR-044).
 *
 * @param error The caught error.
 * @returns True if it is a P2002 known-request error.
 */
function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}
