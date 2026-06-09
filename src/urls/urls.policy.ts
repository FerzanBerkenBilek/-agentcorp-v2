import { ShortUrl } from '@prisma/client';
import { NotFoundError } from '../shared/errors';

/**
 * Centralized object-level authorization for short URLs (H3 / ADR-013/021).
 *
 * Stats and delete are OWNER-ONLY. Every owner-scoped path runs through this
 * single helper — there is no other place that decides who may read another
 * user's click data or delete a link. To prevent code enumeration, an
 * unauthorized caller is treated identically to a missing code: we throw
 * NotFoundError (-> 404), never 403 (mirrors tasks.policy).
 *
 * Note: GET /:code (the anonymous redirect) does NOT pass through here — it is
 * public by design and reveals nothing beyond the already-public redirect.
 */

/** True if the user created the short URL. */
function isOwner(url: Pick<ShortUrl, 'ownerId'>, userId: string): boolean {
  return url.ownerId === userId;
}

/**
 * Assert the caller owns the short URL (stats + delete). A non-owner or a
 * missing code is indistinguishable to the client (both 404).
 *
 * @param url The short URL (or null if no such code exists).
 * @param userId The authenticated caller's id.
 * @returns The non-null short URL once ownership is confirmed.
 * @throws NotFoundError if the code is missing OR the caller is not the owner.
 */
export function assertIsOwner<T extends Pick<ShortUrl, 'ownerId'>>(
  url: T | null,
  userId: string,
): T {
  if (!url || !isOwner(url, userId)) {
    throw new NotFoundError('Short URL');
  }
  return url;
}
