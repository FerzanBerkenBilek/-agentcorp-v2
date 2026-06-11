import { describe, expect, it, vi } from 'vitest';
import { BLOCK_THRESHOLD, FLAG_THRESHOLD, screenUrl } from './url-screen';

/**
 * Unit tests for the abuse-screening verdict layer (ADR-034/035).
 *
 * The blocklist probe is injected (a vi.fn) so these tests are pure + offline.
 * The screen receives an ALREADY-validated href (assertSafeUrl's output) — we do
 * NOT re-test SSRF here (url-safety.test.ts owns that). Covers: blocklist BLOCK,
 * homograph + typosquat FLAG, real-brand ALLOW (no flag against itself), clean
 * ALLOW, fail-closed BLOCK, and the confidence bands.
 */

/** A blocklist probe that blocks exactly the given canonical domains. */
function blocklist(...blocked: string[]): (d: string) => Promise<boolean> {
  const set = new Set(blocked);
  return vi.fn((domain: string) => Promise.resolve(set.has(domain)));
}

const allowAll = blocklist();

describe('screenUrl — blocklist BLOCK (the only auto-BLOCK input)', () => {
  it('should_BLOCK_a_url_whose_registrable_domain_is_blocked', async () => {
    const result = await screenUrl('https://evil.com/path', blocklist('evil.com'));

    expect(result.decision).toBe('BLOCK');
    expect(result.score).toBeGreaterThanOrEqual(BLOCK_THRESHOLD);
    expect(result.canonicalDomain).toBe('evil.com');
  });

  it('should_BLOCK_a_subdomain_of_a_blocked_registrable_domain', async () => {
    const result = await screenUrl('https://a.b.evil.com/', blocklist('evil.com'));

    expect(result.decision).toBe('BLOCK');
  });

  it('should_keep_the_specific_reason_server_side_only', async () => {
    const result = await screenUrl('https://evil.com/', blocklist('evil.com'));

    // The reason names the matched rule (audit only); it is never client-facing.
    expect(result.reason).toContain('blocklist:evil.com');
  });
});

describe('screenUrl — typosquat / homograph FLAG (never auto-BLOCK)', () => {
  it.each([
    'https://gooogle.com/', // distance-1 insertion
    'https://g00gle.com/', // digit homoglyph (skeleton)
    'https://paypaI.com/', // capital-I for l
  ])('should_FLAG_the_lookalike %s', async (href) => {
    const result = await screenUrl(href, allowAll);

    expect(result.decision).toBe('FLAG');
    expect(result.score).toBeGreaterThanOrEqual(FLAG_THRESHOLD);
    expect(result.score).toBeLessThan(BLOCK_THRESHOLD);
  });

  it('should_FLAG_a_cyrillic_homograph_of_a_brand', async () => {
    // "pаypal.com" with a Cyrillic 'а' (U+0430) — skeleton folds to paypal.com.
    const result = await screenUrl('https://pаypal.com/', allowAll);

    expect(result.decision).toBe('FLAG');
    expect(result.reason).toContain('paypal.com');
  });
});

describe('screenUrl — ALLOW', () => {
  it('should_ALLOW_a_real_top_brand_domain_without_flagging_it_against_itself', async () => {
    const result = await screenUrl('https://google.com/', allowAll);

    expect(result.decision).toBe('ALLOW');
    expect(result.score).toBeLessThan(FLAG_THRESHOLD);
  });

  it('should_ALLOW_an_unrelated_clean_domain', async () => {
    const result = await screenUrl('https://example.com/', allowAll);

    expect(result.decision).toBe('ALLOW');
    expect(result.reason).toBe('clean');
  });

  it('should_ALLOW_a_distant_domain_that_is_not_a_typosquat', async () => {
    // Levenshtein >= 3 from every brand -> no signal.
    const result = await screenUrl('https://mybusiness.io/', allowAll);

    expect(result.decision).toBe('ALLOW');
  });
});

describe('screenUrl — fail closed (R17)', () => {
  it('should_BLOCK_a_url_whose_host_cannot_be_canonicalized', async () => {
    // An IPv6-literal host has no registrable domain -> canonicalize returns null
    // -> the screen must fail CLOSED (BLOCK), never silently ALLOW.
    const result = await screenUrl('https://[2606:4700:4700::1111]/', allowAll);

    expect(result.decision).toBe('BLOCK');
    expect(result.reason).toBe('uncanonicalizable_host');
  });

  it('should_not_call_the_blocklist_for_an_uncanonicalizable_host', async () => {
    const probe = blocklist();
    await screenUrl('https://[2606:4700:4700::1111]/', probe);

    expect(probe).not.toHaveBeenCalled();
  });
});

describe('screenUrl — scorer edge branches', () => {
  it('should_ALLOW_a_single_label_host_with_no_brand_signal', async () => {
    // Single-label registrable -> distinct length from every two-label brand;
    // exercises the levenshtein length-mismatch / large-distance path.
    const result = await screenUrl('https://intranet/', allowAll);

    expect(result.decision).toBe('ALLOW');
  });

  it('should_BLOCK_a_blocked_single_label_host', async () => {
    const result = await screenUrl('https://intranet/', blocklist('intranet'));

    expect(result.decision).toBe('BLOCK');
  });

  it('should_not_flag_an_ascii_brand_skeleton_equal_to_itself', async () => {
    // skeleton === domain for a pure-ASCII brand -> homograph branch is false,
    // distance 0 -> ALLOW (the real brand is never flagged against itself).
    const result = await screenUrl('https://apple.com/', allowAll);

    expect(result.decision).toBe('ALLOW');
  });
});

describe('screenUrl — band constants', () => {
  it('should_expose_block_above_flag_above_zero', () => {
    expect(BLOCK_THRESHOLD).toBeGreaterThan(FLAG_THRESHOLD);
    expect(FLAG_THRESHOLD).toBeGreaterThan(0);
  });
});
