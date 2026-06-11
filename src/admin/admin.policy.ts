import { FlaggedUrl, FlagState } from '@prisma/client';
import { ConflictError, NotFoundError } from '../shared/errors';

/**
 * State-machine authorization for flagged-URL moderation (ADR-032, R9/R11).
 *
 * The SINGLE place the approve/reject preconditions are enforced. Mirrors the
 * object-level policy pattern (urls/tasks): a missing row is a 404 (the id is an
 * unguessable UUID; we do not differentiate it from "exists but not yours"
 * because the admin queue legitimately spans all submitters — there is no
 * cross-tenant object secret, only an existence check). A non-PENDING (terminal)
 * row cannot be re-reviewed → 409 Conflict.
 */

/**
 * Assert a flagged row exists and is actionable (PENDING) before an admin
 * approve/reject mutates it.
 *
 * @param flagged The flagged row (or null if the id is unknown).
 * @returns The non-null PENDING flagged row.
 * @throws NotFoundError (404) if the id is unknown (R9).
 * @throws ConflictError (409) if the row is already APPROVED/REJECTED (R11).
 */
export function assertReviewable(flagged: FlaggedUrl | null): FlaggedUrl {
  if (!flagged) {
    throw new NotFoundError('Flagged URL');
  }
  if (flagged.state !== FlagState.PENDING) {
    throw new ConflictError('Flagged URL has already been reviewed');
  }
  return flagged;
}
