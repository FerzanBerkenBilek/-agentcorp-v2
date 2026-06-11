import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import { chargeAdditionalUnits } from './rate-limit-weight';

/**
 * Unit tests for the bulk N-weighting adapter (`chargeAdditionalUnits`, ADR-043).
 *
 * These drive the EXPORTED function directly (the pin test only guards the
 * plugin's internal contract; it reimplements the charge loop inline and never
 * calls the adapter). The load-bearing properties verified here:
 *   - FAIL-CLOSED (security-engineer MUST-HAVE / H5): if the private
 *     `rateLimitRan` guard symbol is ABSENT, the adapter THROWS rather than
 *     silently under-counting — a silent under-count would reopen the H5 DoS
 *     amplification.
 *   - n <= 1 is a no-op (never over-counts normal single-item traffic).
 *   - n > 1 charges exactly n-1 additional units against the global key.
 */

const RATE_LIMIT_RAN_SYMBOL_DESCRIPTION = 'fastify.request.rateLimitRan';

/**
 * Build a fresh rate-limited Fastify app with a single GET `route` whose handler
 * runs `body(request, reply)`. The route is registered BEFORE `ready()` (a
 * listening instance rejects new routes), mirroring the pin test's pattern.
 */
async function withRoute(
  body: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>,
): Promise<{ app: FastifyInstance }> {
  const app = Fastify({ trustProxy: false });
  const fastifyRateLimit = (await import('@fastify/rate-limit')).default;
  await app.register(fastifyRateLimit, { global: true, max: 100, timeWindow: '1 minute' });
  app.get('/probe', async (request, reply) => {
    const result = await body(request, reply);
    return reply.send(result ?? { ok: true });
  });
  await app.ready();
  return { app };
}

/** Read the numeric x-ratelimit-remaining header off a reply. */
function remainingOf(reply: FastifyReply): number {
  const raw = reply.getHeader('x-ratelimit-remaining');
  return typeof raw === 'string' ? Number(raw) : (raw as number);
}

/** Find the plugin's per-request guard symbol on a real request. */
function ranSymbolOf(request: FastifyRequest): symbol {
  const sym = Object.getOwnPropertySymbols(request).find(
    (s) => s.description === RATE_LIMIT_RAN_SYMBOL_DESCRIPTION,
  );
  if (sym === undefined) {
    throw new Error('guard symbol not found in fixture');
  }
  return sym;
}

describe('chargeAdditionalUnits — fail-closed (security MUST-HAVE / H5)', () => {
  it('should_throw_when_the_rateLimitRan_guard_symbol_is_absent', async () => {
    // Simulate the plugin's internal contract vanishing on the request object:
    // a plain request that carries NO discoverable guard symbol. The adapter
    // must refuse to proceed (silent under-count would reopen H5 DoS).
    const { app } = await withRoute(async () => undefined);
    const fakeRequest = { server: app } as unknown as FastifyRequest;
    const fakeReply = {} as FastifyReply;

    await expect(chargeAdditionalUnits(fakeRequest, fakeReply, 5)).rejects.toThrow(
      /rate-limit weighting unavailable/i,
    );
    await app.close();
  });

  it('should_NOT_throw_for_a_no_op_charge_even_without_the_guard_symbol', async () => {
    // n<=1 short-circuits BEFORE the symbol lookup, so a missing symbol is
    // irrelevant when there is nothing extra to charge.
    const { app } = await withRoute(async () => undefined);
    const fakeRequest = { server: app } as unknown as FastifyRequest;
    const fakeReply = {} as FastifyReply;
    await expect(chargeAdditionalUnits(fakeRequest, fakeReply, 1)).resolves.toBeUndefined();
    await app.close();
  });
});

describe('chargeAdditionalUnits — weighting against the global key', () => {
  it('should_be_a_no_op_when_n_is_1', async () => {
    let remaining: number | undefined;
    const { app } = await withRoute(async (request, reply) => {
      await chargeAdditionalUnits(request, reply, 1);
      remaining = remainingOf(reply);
    });
    const res = await app.inject({ method: 'GET', url: '/probe' });
    expect(res.statusCode).toBe(200);
    // Only the global onRequest hook's 1 unit -> remaining 99.
    expect(remaining).toBe(99);
    await app.close();
  });

  it('should_be_a_no_op_when_n_is_0', async () => {
    let remaining: number | undefined;
    const { app } = await withRoute(async (request, reply) => {
      await chargeAdditionalUnits(request, reply, 0);
      remaining = remainingOf(reply);
    });
    const res = await app.inject({ method: 'GET', url: '/probe' });
    expect(res.statusCode).toBe(200);
    expect(remaining).toBe(99);
    await app.close();
  });

  it('should_charge_exactly_n_minus_1_additional_units_when_n_is_greater_than_1', async () => {
    let remaining: number | undefined;
    const { app } = await withRoute(async (request, reply) => {
      // Sanity: the real guard symbol is present on a genuine request.
      expect(() => ranSymbolOf(request)).not.toThrow();
      await chargeAdditionalUnits(request, reply, 10);
      remaining = remainingOf(reply);
    });
    const res = await app.inject({ method: 'GET', url: '/probe' });
    expect(res.statusCode).toBe(200);
    // 1 (global hook) + 9 (adapter) = 10 charged -> remaining 90.
    expect(remaining).toBe(90);
    await app.close();
  });
});
