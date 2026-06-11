/**
 * `Result<T, E>` — an explicit success/failure return value (ADR-044).
 *
 * The sanctioned transport for a repository (or any leaf) that has a real,
 * recoverable failure outcome the caller MUST branch on — instead of throwing.
 * A `Result` makes the failure part of the type, so the compiler forces the
 * caller to handle it (no silent swallow, no `null`-as-error ambiguity).
 *
 * Used today only at the P2002 create seam (ADR-044): the repo catches the
 * unique-constraint violation and returns `err(new ConflictError(...))`; the
 * owning service unwraps and re-throws the SAME typed error so route status
 * (404/409) is byte-identical. Reads that can be absent keep returning `T | null`
 * (`null` is already the explicit not-found value — see ADR-044).
 */

/**
 * A discriminated union: either a success carrying a `value`, or a failure
 * carrying an `error`. Narrow on the `ok` discriminant to access the payload.
 */
export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

/**
 * Wrap a success value in a `Result`.
 *
 * @param value The success payload.
 * @returns An `ok` Result carrying `value`.
 */
export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

/**
 * Wrap a failure value in a `Result`.
 *
 * @param error The failure payload (e.g. a domain error).
 * @returns An `err` Result carrying `error`.
 */
export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}
