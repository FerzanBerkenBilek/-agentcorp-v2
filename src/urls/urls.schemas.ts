import { z } from 'zod';
import { CODE_LENGTH } from '../shared/short-code';
import { MAX_URL_LENGTH } from '../shared/url-safety';

/**
 * Zod schemas for the URL-shortener endpoints. `.strict()` blocks unknown keys
 * (mass-assignment defense, L1/H1): `url` is the ONLY client-supplied field —
 * code, ownerId, clickCount, and timestamps are all set server-side. Deep
 * SSRF/scheme/IP validation lives in `assertSafeUrl` (ADR-019); the schema only
 * enforces the cheap structural bounds (presence, length cap).
 */

/** Regex for a public short code: exactly 6 base62 chars (security L2). */
const CODE_PATTERN = new RegExp(`^[A-Za-z0-9]{${CODE_LENGTH}}$`);

/** POST /shorten body. `url` only; bounded to the abuse cap before parsing. */
export const shortenSchema = z
  .object({
    url: z.string().min(1, 'URL is required').max(MAX_URL_LENGTH, 'URL exceeds maximum length'),
  })
  .strict();

/**
 * Route params carrying a short code. Validating the shape here turns malformed
 * codes into a 422 before any DB hit (security L2 — avoids needless queries and
 * log noise on enumeration attempts).
 */
export const codeParamSchema = z
  .object({ code: z.string().regex(CODE_PATTERN, 'Invalid short code') })
  .strict();

export type ShortenInput = z.infer<typeof shortenSchema>;
export type CodeParam = z.infer<typeof codeParamSchema>;
