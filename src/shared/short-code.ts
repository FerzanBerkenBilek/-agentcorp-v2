import { randomInt } from 'node:crypto';

/**
 * Short-code generation (ADR-022 / M3).
 *
 * Codes are the public, non-enumerable business key for a shortened URL. They
 * MUST come from a CSPRNG — `node:crypto.randomInt` — never `Math.random()`
 * (predictable) and never a sequence/auto-increment (enumerable, lets an
 * attacker walk the keyspace and harvest every link). `randomInt(0, n)` draws
 * from `crypto.randomBytes` with rejection sampling, so it is uniform over the
 * alphabet with no modulo bias.
 */

/** Length of a generated short code (6 chars, ADR-022/024). */
export const CODE_LENGTH = 6;

/**
 * Base62 alphabet [A-Za-z0-9]. Keyspace = 62^6 ≈ 56.8 billion, so collisions
 * are vanishingly rare and handled transparently by insert-retry (ADR-022).
 */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/**
 * Generate a single CSPRNG short code.
 *
 * @returns A 6-character base62 code drawn uniformly from a CSPRNG.
 */
export function generateShortCode(): string {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i += 1) {
    code += ALPHABET[randomInt(0, ALPHABET.length)];
  }
  return code;
}
