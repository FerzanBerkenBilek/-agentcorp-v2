import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires -- read the installed manifest, not the JS API.
import rateLimitPkg from '@fastify/rate-limit/package.json';

/**
 * VERSION-PINNING / INTERNAL-CONTRACT GUARD for the bulk N-weighting adapter
 * (`rate-limit-weight.ts`, ADR-043).
 *
 * `chargeAdditionalUnits` is the ONLY code that couples to `@fastify/rate-limit`
 * INTERNALS, because the plugin (as of 9.1.0) exposes no public weight/consume
 * primitive. This test fails LOUDLY the moment any of those internals drift, so
 * a plugin upgrade cannot silently degrade the DoS control to "1 unit per batch
 * of 50".
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ IF THIS TEST FAILS: the rate-limit plugin changed its internals. DO NOT  │
 * │ just bump the version pin below. Re-verify `chargeAdditionalUnits`       │
 * │ against ADR-043 first:                                                   │
 * │   1. Does `app.rateLimit()` still return the GLOBAL handler over the     │
 * │      same store + keyGenerator? (key derivation contract)                │
 * │   2. Does the per-request guard symbol still gate re-entry, and is it    │
 * │      still discoverable by description? (single-fire contract)           │
 * │   3. Does one handler invocation still `incr` the global key by exactly  │
 * │      1? (weight contract)                                                 │
 * │ ONLY after re-verifying (and adjusting the adapter if needed) update the │
 * │ PINNED_VERSION below to the re-verified version.                         │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

/** The exact version the adapter in rate-limit-weight.ts was written and verified against. */
const PINNED_VERSION = '9.1.0';

/** The guard-symbol description the adapter matches on to defeat the single-fire guard. */
const RATE_LIMIT_RAN_SYMBOL_DESCRIPTION = 'fastify.request.rateLimitRan';

describe('rate-limit-weight adapter — version + internal-contract pin (ADR-043)', () => {
  it('should_have_the_pinned_@fastify/rate-limit_version_installed', () => {
    // If this fails, a plugin upgrade slipped in. See the banner above before bumping.
    expect(rateLimitPkg.version).toBe(PINNED_VERSION);
  });

  it('should_expose_the_global_rateLimit_handler_factory_the_adapter_calls', async () => {
    const app = Fastify({ trustProxy: false });
    const fastifyRateLimit = (await import('@fastify/rate-limit')).default;
    await app.register(fastifyRateLimit, { global: true, max: 100, timeWindow: '1 minute' });
    await app.ready();

    // The adapter relies on `app.rateLimit()` (no options) returning the GLOBAL
    // handler over the same plugin component (store + keyGenerator).
    expect(app.hasDecorator('rateLimit')).toBe(true);
    const handler = (app as unknown as { rateLimit: () => unknown }).rateLimit();
    expect(typeof handler).toBe('function');

    await app.close();
  });

  it('should_decorate_requests_with_a_discoverable_single_fire_guard_symbol', async () => {
    const app = Fastify({ trustProxy: false });
    const fastifyRateLimit = (await import('@fastify/rate-limit')).default;
    await app.register(fastifyRateLimit, { global: true, max: 100, timeWindow: '1 minute' });

    let symbolDescriptions: (string | undefined)[] = [];
    let remainingAfterGlobalHook: number | undefined;
    app.get('/probe', async (request, reply) => {
      symbolDescriptions = Object.getOwnPropertySymbols(request).map((s) => s.description);
      const remaining = reply.getHeader('x-ratelimit-remaining');
      remainingAfterGlobalHook = typeof remaining === 'string' ? Number(remaining) : (remaining as number);
      return reply.send({ ok: true });
    });
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/probe' });
    expect(res.statusCode).toBe(200);

    // (a) The guard symbol the adapter matches on by description must exist.
    expect(symbolDescriptions).toContain(RATE_LIMIT_RAN_SYMBOL_DESCRIPTION);
    // (b) The global hook must charge exactly 1 unit per inbound request (so the
    //     adapter's job is precisely the additional N-1). max=100 -> remaining=99.
    expect(remainingAfterGlobalHook).toBe(99);

    await app.close();
  });

  it('should_increment_the_global_key_by_exactly_one_per_extra_handler_invocation', async () => {
    // Proves the weight contract: re-invoking the global handler after flipping
    // the guard symbol charges the SAME key by exactly +1 each time (the adapter
    // relies on this to net N total units from N-1 extra invocations).
    const app = Fastify({ trustProxy: false });
    const fastifyRateLimit = (await import('@fastify/rate-limit')).default;
    await app.register(fastifyRateLimit, { global: true, max: 100, timeWindow: '1 minute' });

    let finalRemaining: number | undefined;
    app.get('/charge', async (request, reply) => {
      const ranSymbol = Object.getOwnPropertySymbols(request).find(
        (s) => s.description === RATE_LIMIT_RAN_SYMBOL_DESCRIPTION,
      );
      expect(ranSymbol).toBeDefined();
      const chargeOnce = (app as unknown as { rateLimit: () => (req: unknown, rep: unknown) => Promise<void> }).rateLimit();
      // Charge 4 additional units (simulating an N=5 batch: 1 from the global hook + 4 here).
      for (let i = 0; i < 4; i += 1) {
        (request as unknown as Record<symbol, boolean>)[ranSymbol as symbol] = false;
        await chargeOnce(request, reply);
      }
      const remaining = reply.getHeader('x-ratelimit-remaining');
      finalRemaining = typeof remaining === 'string' ? Number(remaining) : (remaining as number);
      return reply.send({ ok: true });
    });
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/charge' });
    expect(res.statusCode).toBe(200);
    // max=100, 1 (global hook) + 4 (adapter) = 5 charged -> remaining 95.
    expect(finalRemaining).toBe(95);

    await app.close();
  });
});
