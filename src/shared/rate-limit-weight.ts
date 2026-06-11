import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * Bulk rate-limit N-weighting adapter (ADR-043).
 *
 * THIS IS THE ONLY MODULE IN THE CODEBASE THAT TOUCHES `@fastify/rate-limit`
 * INTERNALS. The coupling is deliberately fenced here behind a single helper so
 * a plugin upgrade that changes the internal contract breaks in exactly one
 * place — and the version-pinning test (`rate-limit-weight.pin.test.ts`) fails
 * loudly before such an upgrade can silently degrade the DoS control.
 *
 * WHY THIS EXISTS — `@fastify/rate-limit@9.1.0` has no public weight / points /
 * consume primitive: `store.incr` increments the counter by exactly 1, and the
 * global hook fires once per request guarded by a private per-request
 * `Symbol('fastify.request.rateLimitRan')`. ADR-043 (Option 3) ruled that a
 * bulk request of N items must consume N units against the SAME global limiter
 * key — without a new dependency. The plugin already charged 1 unit for the
 * inbound request via its global `onRequest` hook; this adapter charges the
 * additional N−1 units against the SAME global key (the plugin derives the key
 * itself via its configured `keyGenerator`, i.e. client IP — never a child
 * store, which would be a separate counter that does not consume the shared
 * global budget; ADR-043 forbids that).
 *
 * MECHANISM — `app.rateLimit()` (called with no options) returns the plugin's
 * GLOBAL request handler, closed over the SAME plugin component (same global
 * store + same `keyGenerator`) the `onRequest` hook uses. That handler short-
 * circuits when the request's `rateLimitRan` symbol is already `true`, so to
 * make it increment again we flip that symbol back to `false` before each
 * extra invocation. Each invocation does exactly one `store.incr(key, …)` on
 * the global key — netting N total units for an N-item batch.
 *
 * If the additional charge pushes the caller over the limit, the plugin's own
 * handler throws the configured `errorResponseBuilder` value (our
 * `AppError(RATE_LIMIT, 429)`) — identical to how the inbound request would be
 * throttled. We do not retroactively reject the in-flight batch on a normal
 * over-count; we let the handler's own count-then-allow / throw-on-exceed
 * semantics apply, matching the existing limiter exactly.
 */

/** Description of the per-request guard symbol the plugin decorates onto requests. */
const RATE_LIMIT_RAN_SYMBOL_DESCRIPTION = 'fastify.request.rateLimitRan';

/**
 * Locate the plugin's private per-request guard symbol on a request instance.
 *
 * `@fastify/rate-limit` decorates every request with
 * `Symbol('fastify.request.rateLimitRan')` (default `false`, set to `true` once
 * the global hook has run). It is the only reachable handle to that guard, so
 * we match it by its description. Returns `undefined` if the contract changed —
 * callers MUST treat that as "weighting unavailable", never silently proceed.
 *
 * @param request The current request (carries the decorated symbol).
 * @returns The guard symbol, or `undefined` if the plugin contract changed.
 */
function findRateLimitRanSymbol(request: FastifyRequest): symbol | undefined {
  return Object.getOwnPropertySymbols(request).find(
    (sym) => sym.description === RATE_LIMIT_RAN_SYMBOL_DESCRIPTION,
  );
}

/**
 * Charge `n − 1` ADDITIONAL units against the same global rate-limit key for
 * this request, so an N-item bulk request consumes N total units (the plugin
 * already charged 1 for the inbound request). Call AFTER request-level
 * validation (cap-50 guaranteed, so `n ∈ [1, 50]`, bounded and trusted) and
 * BEFORE per-item DB work (ADR-043).
 *
 * Charges the GLOBAL key (the plugin re-derives it via its own `keyGenerator`,
 * i.e. client IP) — NOT a child store. `n === 1` is a no-op. If the additional
 * charge crosses the limit, the plugin's handler throws the configured 429
 * `AppError`, matching the existing limiter's throttle semantics.
 *
 * @param request The current authenticated request.
 * @param reply The reply (the plugin handler may set rate-limit headers on it).
 * @param n The batch size (number of items/ids). Must be `>= 1`.
 * @throws AppError(RATE_LIMIT, 429) if the additional charge exceeds the limit.
 */
export async function chargeAdditionalUnits(
  request: FastifyRequest,
  reply: FastifyReply,
  n: number,
): Promise<void> {
  if (n <= 1) {
    return;
  }

  const ranSymbol = findRateLimitRanSymbol(request);
  if (ranSymbol === undefined) {
    // Fail-closed-by-design: the plugin's internal contract changed. Surfacing
    // an error (caught upstream by the global handler) is safer than silently
    // under-counting the DoS control. The pin test exists to catch this in CI
    // long before it reaches runtime.
    throw new Error(
      'rate-limit weighting unavailable: @fastify/rate-limit internal contract changed (see ADR-043 / rate-limit-weight.pin.test.ts)',
    );
  }

  // `request.server.rateLimit()` is declared by the plugin's type augmentation;
  // called with no options it returns the GLOBAL handler (same store + key).
  // Its declared type is a `preHandlerAsyncHookHandler` (a `this: FastifyInstance`
  // method); the plugin returns a `this`-free closure, so we invoke it through a
  // plain `(req, reply) => Promise<void>` view to satisfy the call signature.
  const chargeOnce = request.server.rateLimit() as unknown as (
    req: FastifyRequest,
    reply: FastifyReply,
  ) => Promise<void>;
  // The guard symbol is a plugin-private decorated property, not part of the
  // public FastifyRequest type — index it via a symbol-keyed record view.
  const guard = request as unknown as Record<symbol, boolean>;
  const additionalUnits = n - 1;
  for (let i = 0; i < additionalUnits; i += 1) {
    // Defeat the plugin's single-fire guard so the handler increments again,
    // then invoke it: one `store.incr` on the SAME global key per iteration.
    guard[ranSymbol] = false;
    await chargeOnce(request, reply);
  }
}
