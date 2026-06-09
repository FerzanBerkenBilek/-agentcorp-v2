import { describe, expect, it } from 'vitest';
import { NotFoundError } from '../shared/errors';
import { assertIsOwner } from './urls.policy';

/**
 * Unit tests for short-URL object-level authorization (H3 / ADR-013/021).
 *
 * Pure function, no mocks. The load-bearing security property: a non-owner is
 * treated EXACTLY like a missing code — NotFoundError (404), never 403 — so a
 * caller cannot enumerate codes by probing for 403-vs-404.
 */

const OWNER = 'owner-id-aaaa';
const STRANGER = 'stranger-id-bbbb';

/** Minimal short-URL shape accepted by the policy helper. */
function shortUrl(ownerId: string) {
  return { ownerId };
}

describe('assertIsOwner (stats + delete: owner ONLY)', () => {
  it('should_return_the_url_when_caller_is_owner', () => {
    const u = shortUrl(OWNER);
    expect(assertIsOwner(u, OWNER)).toBe(u);
  });

  it('should_throw_NotFoundError_when_caller_is_not_the_owner', () => {
    const u = shortUrl(OWNER);
    expect(() => assertIsOwner(u, STRANGER)).toThrow(NotFoundError);
  });

  it('should_throw_NotFoundError_when_the_url_is_null', () => {
    expect(() => assertIsOwner(null, OWNER)).toThrow(NotFoundError);
  });

  it('should_return_404_status_not_403_for_a_non_owner', () => {
    // IDOR defense: the unauthorized case is indistinguishable from "missing".
    const u = shortUrl(OWNER);
    try {
      assertIsOwner(u, STRANGER);
      expect.unreachable('expected assertIsOwner to throw');
    } catch (err) {
      expect((err as NotFoundError).statusCode).toBe(404);
    }
  });

  it('should_return_404_status_not_403_for_a_missing_code', () => {
    try {
      assertIsOwner(null, OWNER);
      expect.unreachable('expected assertIsOwner to throw');
    } catch (err) {
      expect((err as NotFoundError).statusCode).toBe(404);
    }
  });
});
