import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * Unit tests for the CSRF Origin/Referer guard (M6 / ADR-015).
 *
 * The guard's behavior depends on config.CORS_ORIGINS, which is parsed once at
 * config import time. We use vi.resetModules + a per-test process.env override
 * to load a fresh csrf module with the desired allowlist (no shared state).
 *
 * Because each test loads csrf through a fresh module registry, the thrown
 * ForbiddenError comes from a different module instance than a top-level import
 * would — so we assert on the rejection's stable `code`/`statusCode`/`name`
 * (403 / FORBIDDEN) rather than on `instanceof`, which is identity-fragile here.
 */

/** Assert a rejected promise carries the ForbiddenError contract (403). */
async function expectForbidden(p: Promise<unknown>): Promise<void> {
  await expect(p).rejects.toMatchObject({
    name: 'ForbiddenError',
    statusCode: 403,
    code: 'FORBIDDEN',
  });
}

/** Build a request double carrying the given headers. */
function reqWith(headers: Record<string, string | undefined>): FastifyRequest {
  return { headers } as unknown as FastifyRequest;
}

const noopReply = {} as FastifyReply;

afterEach(() => {
  vi.resetModules();
  process.env.CORS_ORIGINS = '';
});

/**
 * Import a fresh csrfOriginGuard bound to the given allowlist.
 *
 * @param origins Comma-separated CORS allowlist for this test.
 * @returns The freshly-loaded guard.
 */
async function loadGuard(origins: string) {
  vi.resetModules();
  process.env.CORS_ORIGINS = origins;
  const mod = await import('./csrf');
  return mod.csrfOriginGuard;
}

describe('csrfOriginGuard', () => {
  it('should_skip_check_when_no_allowlist_configured', async () => {
    const guard = await loadGuard('');

    await expect(
      guard(reqWith({ origin: 'https://evil.example' }), noopReply),
    ).resolves.toBeUndefined();
  });

  it('should_allow_request_with_allowlisted_origin', async () => {
    const guard = await loadGuard('https://app.example');

    await expect(
      guard(reqWith({ origin: 'https://app.example' }), noopReply),
    ).resolves.toBeUndefined();
  });

  it('should_throw_ForbiddenError_when_origin_not_allowlisted', async () => {
    const guard = await loadGuard('https://app.example');

    await expectForbidden(guard(reqWith({ origin: 'https://evil.example' }), noopReply));
  });

  it('should_fall_back_to_referer_when_origin_absent', async () => {
    const guard = await loadGuard('https://app.example');

    await expect(
      guard(reqWith({ origin: undefined, referer: 'https://app.example/page' }), noopReply),
    ).resolves.toBeUndefined();
  });

  it('should_throw_when_no_origin_or_referer_present', async () => {
    const guard = await loadGuard('https://app.example');

    await expectForbidden(
      guard(reqWith({ origin: undefined, referer: undefined }), noopReply),
    );
  });

  it('should_throw_when_referer_is_unparseable', async () => {
    const guard = await loadGuard('https://app.example');

    await expectForbidden(
      guard(reqWith({ origin: undefined, referer: 'not a url' }), noopReply),
    );
  });
});
