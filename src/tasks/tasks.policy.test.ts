import { describe, expect, it } from 'vitest';
import { NotFoundError } from '../shared/errors';
import { assertCanAccess, assertIsOwner } from './tasks.policy';

/**
 * Unit tests for the object-level authorization policy (H1 / ADR-013).
 *
 * These are pure functions — no mocks, no I/O. The load-bearing security
 * property is that an unauthorized caller is treated EXACTLY like a missing
 * resource: NotFoundError (-> 404), never ForbiddenError (403), to prevent
 * resource enumeration.
 */

const OWNER = 'owner-id-aaaa';
const ASSIGNEE = 'assignee-id-bbbb';
const STRANGER = 'stranger-id-cccc';

/** Minimal task shape accepted by the policy helpers. */
function task(ownerId: string, assigneeId: string | null) {
  return { ownerId, assigneeId };
}

describe('assertCanAccess (read/update: owner OR assignee)', () => {
  it('should_allow_owner_to_access_task', () => {
    const t = task(OWNER, null);
    expect(assertCanAccess(t, OWNER)).toBe(t);
  });

  it('should_allow_assignee_to_access_task', () => {
    const t = task(OWNER, ASSIGNEE);
    expect(assertCanAccess(t, ASSIGNEE)).toBe(t);
  });

  it('should_throw_NotFoundError_when_caller_is_neither_owner_nor_assignee', () => {
    const t = task(OWNER, ASSIGNEE);
    // IDOR defense: 404 (not 403) so the resource's existence is not revealed.
    expect(() => assertCanAccess(t, STRANGER)).toThrow(NotFoundError);
  });

  it('should_throw_NotFoundError_when_task_is_null', () => {
    expect(() => assertCanAccess(null, OWNER)).toThrow(NotFoundError);
  });

  it('should_return_404_status_not_403_for_unauthorized_access', () => {
    const t = task(OWNER, ASSIGNEE);
    try {
      assertCanAccess(t, STRANGER);
      expect.unreachable('expected assertCanAccess to throw');
    } catch (err) {
      expect((err as NotFoundError).statusCode).toBe(404);
    }
  });
});

describe('assertIsOwner (delete/reassign: owner ONLY)', () => {
  it('should_allow_owner_to_delete', () => {
    const t = task(OWNER, null);
    expect(assertIsOwner(t, OWNER)).toBe(t);
  });

  it('should_throw_NotFoundError_when_non_owner_tries_to_delete', () => {
    // The assignee may read/update but must NOT be able to delete.
    const t = task(OWNER, ASSIGNEE);
    expect(() => assertIsOwner(t, ASSIGNEE)).toThrow(NotFoundError);
  });

  it('should_allow_owner_to_reassign', () => {
    const t = task(OWNER, ASSIGNEE);
    expect(assertIsOwner(t, OWNER)).toBe(t);
  });

  it('should_throw_NotFoundError_when_non_owner_tries_to_reassign', () => {
    const t = task(OWNER, ASSIGNEE);
    expect(() => assertIsOwner(t, ASSIGNEE)).toThrow(NotFoundError);
  });

  it('should_throw_NotFoundError_when_task_is_null', () => {
    expect(() => assertIsOwner(null, OWNER)).toThrow(NotFoundError);
  });
});
