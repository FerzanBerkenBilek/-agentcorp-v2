import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { bulkUpdateItemSchema } from './tasks.schemas';

/**
 * Backend-dev regression for the H6 `bulkUpdateItemSchema` fix (BULK-2026-06-11).
 *
 * The previous `z.intersection({ id }, updateTaskSchema)` 422'd EVERY real
 * `{ id, ...update }` element, because the strict `updateTaskSchema` side flagged
 * `id` as an unknown key. The fix uses `updateTaskObject.extend({ id })` so `id`
 * plus the known update fields are accepted while strict mass-assignment defense
 * (H2, ADR-006) and the "≥1 update field" rule (ADR-042) are preserved.
 *
 * These assertions lock the contract: a valid single-field element is ACCEPTED;
 * an `{ id }`-only element and an `{ id, unknownKey }` element are REJECTED (422).
 */
describe('bulkUpdateItemSchema', () => {
  const id = randomUUID();

  it('should_accept_when_id_plus_one_update_field', () => {
    const result = bulkUpdateItemSchema.safeParse({ id, title: 'Renamed' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ id, title: 'Renamed' });
    }
  });

  it('should_reject_when_id_only_no_update_fields', () => {
    // The "≥1 update field" rule must survive the extend: id alone is not a patch.
    const result = bulkUpdateItemSchema.safeParse({ id });
    expect(result.success).toBe(false);
  });

  it('should_reject_when_unknown_key_present_mass_assignment_defense', () => {
    // strict() must survive the extend: only id + known update fields are allowed.
    const result = bulkUpdateItemSchema.safeParse({ id, title: 'ok', unknownKey: 'x' });
    expect(result.success).toBe(false);
  });

  it('should_reject_when_ownerId_present_no_privilege_escalation', () => {
    // H2: ownerId is server-set, never accepted from the body.
    const result = bulkUpdateItemSchema.safeParse({ id, title: 'ok', ownerId: randomUUID() });
    expect(result.success).toBe(false);
  });

  it('should_preserve_assigneeId_key_presence_when_unassigning', () => {
    // Key PRESENCE must survive so the service's `'assigneeId' in input` reassign
    // path (H1/L1) still fires; null is a valid "unassign" value, not an omission.
    const result = bulkUpdateItemSchema.safeParse({ id, assigneeId: null });
    expect(result.success).toBe(true);
    if (result.success) {
      expect('assigneeId' in result.data).toBe(true);
      expect(result.data.assigneeId).toBeNull();
    }
  });
});
