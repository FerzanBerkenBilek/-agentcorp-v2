import { PrismaClient, ShortUrl } from '@prisma/client';
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
   * collision guard; a duplicate code surfaces as Prisma error P2002, which the
   * service catches to retry (ADR-022). This method does not catch it.
   *
   * @param data Code, validated originalUrl, and server-set ownerId.
   * @returns The created short URL.
   */
  async create(data: CreateShortUrlData): Promise<ShortUrl> {
    return this.db.shortUrl.create({ data });
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
