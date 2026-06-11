import { z } from 'zod';

/**
 * Zod schemas for the admin abuse-prevention endpoints. Every body/param is
 * `.strict()` (mass-assignment defense, R2/R12): the ONLY client-supplied field
 * on blocklist-add is `domain` (+ optional `note`); `addedByUserId`,
 * `reviewedByUserId`, ids, and timestamps are all server-set. Server never reads
 * `role`/`isAdmin`/`addedByUserId` from a body — `.strict()` rejects them.
 */

/** Max length of a domain name (RFC 1035) — bounds the canonicalization work. */
const MAX_DOMAIN_LENGTH = 253;
/** Max curator note length (abuse + log-size bound). */
const MAX_NOTE_LENGTH = 500;

/** POST /admin/blocklist body. `domain` is canonicalized server-side (ADR-034). */
export const addBlocklistSchema = z
  .object({
    domain: z.string().min(1, 'domain is required').max(MAX_DOMAIN_LENGTH, 'domain is too long'),
    note: z.string().max(MAX_NOTE_LENGTH, 'note is too long').optional(),
  })
  .strict();

/**
 * DELETE /admin/blocklist/:domain param. The raw domain is canonicalized in the
 * service before lookup, so we only bound the structural length here.
 */
export const blocklistDomainParamSchema = z
  .object({
    domain: z.string().min(1, 'domain is required').max(MAX_DOMAIN_LENGTH, 'domain is too long'),
  })
  .strict();

/**
 * Flagged-id route param (approve/reject). UUID-shaped (IDOR-resistant, R9): a
 * malformed id is a 422 before any DB hit; an unknown-but-valid UUID is a 404.
 */
export const flaggedIdParamSchema = z
  .object({ id: z.string().uuid('Invalid flagged URL id') })
  .strict();

export type AddBlocklistInput = z.infer<typeof addBlocklistSchema>;
export type BlocklistDomainParam = z.infer<typeof blocklistDomainParamSchema>;
export type FlaggedIdParam = z.infer<typeof flaggedIdParamSchema>;
