import { describe, expect, it, vi } from 'vitest';
import { screenUrl } from './url-screen';

/**
 * QA EXTENSION (AP-4) for the abuse-screening verdict layer — closes the
 * remaining branch gaps backend-dev's url-screen.test.ts left uncovered
 * (`hostOf` parse-failure catch, the punycode-skeleton fallback branch, the
 * exact Levenshtein distance boundaries 0/1/2/3) and pins behaviour the R0–R25
 * checklist requires. Complements (does not duplicate) url-screen.test.ts.
 *
 * The blocklist probe is injected (a vi.fn) so these are pure + offline; the
 * screen always receives an already-validated href (assertSafeUrl's output),
 * but here we deliberately feed malformed input to drive the fail-closed path.
 */

/** A blocklist probe that blocks exactly the given canonical domains. */
function blocklist(...blocked: string[]): (d: string) => Promise<boolean> {
  const set = new Set(blocked);
  return vi.fn((domain: string) => Promise.resolve(set.has(domain)));
}
const allowAll = blocklist();

describe('screenUrl — fail closed on an unparseable href (R17, hostOf catch)', () => {
  it('should_BLOCK_when_the_href_is_not_a_valid_url', async () => {
    // `hostOf` does `new URL(href)` which THROWS on a bare non-URL string ->
    // the catch returns null -> screen fails CLOSED (covers url-screen L166-171).
    const probe = blocklist();
    const result = await screenUrl('::: not a url :::', probe);

    expect(result.decision).toBe('BLOCK');
    expect(result.reason).toBe('uncanonicalizable_host');
    expect(result.canonicalDomain).toBe('');
    // Never consults the blocklist for a host it could not even parse.
    expect(probe).not.toHaveBeenCalled();
  });

  it('should_BLOCK_an_empty_href', async () => {
    const result = await screenUrl('', allowAll);

    expect(result.decision).toBe('BLOCK');
    expect(result.reason).toBe('uncanonicalizable_host');
  });
});

describe('screenUrl — blocklist equality on the canonical registrable (R15/R16)', () => {
  // The blocklist stores the canonical registrable form; the screen canonicalizes
  // the candidate the SAME way, so every encoding of a stored domain BLOCKs while
  // a genuinely different domain does NOT (the headline bypass property, unit level).
  it.each([
    ['https://evil.com/', true],
    ['https://EVIL.com/', true], // mixed case
    ['https://evil.com./', true], // trailing FQDN dot
    ['https://www.evil.com/', true], // subdomain
    ['https://a.b.c.evil.com/x?y=1', true], // deep subdomain + path/query
    ['https://evil.com:443/p', true], // explicit standard port
  ])('should_match_stored_evil.com_for %s', async (href, blocked) => {
    const result = await screenUrl(href, blocklist('evil.com'));
    expect(result.decision).toBe(blocked ? 'BLOCK' : 'ALLOW');
  });

  it.each([
    'https://notevil.com/',
    'https://goodevil.com/',
    'https://evil.com.attacker.net/', // registrable owner is attacker.net
    'https://evilcom.org/',
  ])('should_NOT_over_block %s', async (href) => {
    const result = await screenUrl(href, blocklist('evil.com'));
    expect(result.decision).not.toBe('BLOCK');
  });

  it('should_BLOCK_a_punycode_xn___form_when_its_homograph_registrable_is_blocked', async () => {
    // Cyrillic "еvil.com" punycodes to xn--vil-qdd.com; if THAT canonical form is
    // on the blocklist, both the xn-- input and the raw homograph BLOCK — the IDN
    // bypass is closed because both sides canonicalize identically (R15/R16).
    const blockedHomograph = blocklist('xn--vil-qdd.com');
    const viaPuny = await screenUrl('https://xn--vil-qdd.com/', blockedHomograph);
    const viaHomograph = await screenUrl('https://еvil.com/', blockedHomograph);

    expect(viaPuny.decision).toBe('BLOCK');
    expect(viaHomograph.decision).toBe('BLOCK');
  });
});

describe('screenUrl — Levenshtein typosquat distance boundaries (R20)', () => {
  // Distance 0 = the real brand (ALLOW); 1–2 = FLAG; >=3 = no signal (ALLOW).
  it('should_ALLOW_distance_0_the_exact_brand', async () => {
    expect((await screenUrl('https://github.com/', allowAll)).decision).toBe('ALLOW');
  });

  it('should_FLAG_distance_1', async () => {
    // "gthub.com" -> github.com is a single deletion (distance 1).
    expect((await screenUrl('https://gthub.com/', allowAll)).decision).toBe('FLAG');
  });

  it('should_FLAG_distance_2', async () => {
    // "gthb.com" -> github.com is two deletions (distance 2).
    expect((await screenUrl('https://gthb.com/', allowAll)).decision).toBe('FLAG');
  });

  it('should_ALLOW_distance_3_or_more', async () => {
    // "gtb.com" is distance >=3 from every brand -> no signal.
    expect((await screenUrl('https://gtb.com/', allowAll)).decision).toBe('ALLOW');
  });
});

describe('screenUrl — blocklist precedence over a heuristic signal', () => {
  it('should_BLOCK_not_FLAG_when_a_typosquat_is_also_explicitly_blocklisted', async () => {
    // A domain that is BOTH a typosquat AND blocklisted must take the BLOCK
    // (deterministic, higher-severity) verdict, never the FLAG branch.
    const result = await screenUrl('https://gooogle.com/', blocklist('gooogle.com'));

    expect(result.decision).toBe('BLOCK');
    expect(result.reason).toContain('blocklist:gooogle.com');
  });
});

describe('screenUrl — score lives in the documented band for each verdict', () => {
  it('should_score_a_BLOCK_at_or_above_the_block_threshold', async () => {
    const r = await screenUrl('https://evil.com/', blocklist('evil.com'));
    expect(r.score).toBeGreaterThanOrEqual(80);
  });

  it('should_score_a_FLAG_inside_the_flag_band', async () => {
    const r = await screenUrl('https://gooogle.com/', allowAll);
    expect(r.score).toBeGreaterThanOrEqual(40);
    expect(r.score).toBeLessThan(80);
  });

  it('should_score_an_ALLOW_below_the_flag_threshold', async () => {
    const r = await screenUrl('https://example.com/', allowAll);
    expect(r.score).toBeLessThan(40);
  });
});
