import { describe, expect, it } from 'vitest';
import { canonicalizeRegistrableDomain } from './domain-canonical';

/**
 * Unit tests for the ADR-034 canonicalization pipeline — the blocklist BYPASS
 * surface. The mandatory bypass matrix (security-engineer R15/R16): for a stored
 * `evil.com`, every encoding of it must canonicalize to the SAME `evil.com`, and
 * unrelated domains must canonicalize to something different (anti-over-block).
 */

describe('canonicalizeRegistrableDomain — bypass matrix (all must equal evil.com)', () => {
  it.each([
    ['evil.com', 'evil.com'],
    ['EVIL.com', 'evil.com'],
    ['Evil.Com', 'evil.com'],
    ['evil.com.', 'evil.com'], // trailing FQDN dot
    ['www.evil.com', 'evil.com'], // single subdomain
    ['a.b.evil.com', 'evil.com'], // deep subdomain
    ['  evil.com  ', 'evil.com'], // surrounding whitespace
  ])('should_canonicalize_%s_to_%s', (input, expected) => {
    expect(canonicalizeRegistrableDomain(input)).toBe(expected);
  });

  it('should_canonicalize_a_cyrillic_homograph_to_its_punycode_registrable_form', () => {
    // "еvil.com" with a Cyrillic 'е' (U+0435) punycodes to xn--vil-qdd.com; both
    // the homograph and its xn-- form normalize to ONE ASCII string, so they
    // cannot diverge (the bypass is closed by canonicalizing both sides).
    const homograph = canonicalizeRegistrableDomain('еvil.com');
    const puny = canonicalizeRegistrableDomain('xn--vil-qdd.com');
    expect(homograph).not.toBeNull();
    expect(homograph).toBe(puny);
    expect(homograph).toBe('xn--vil-qdd.com');
  });
});

describe('canonicalizeRegistrableDomain — anti-over-block (must NOT equal evil.com)', () => {
  it.each([
    ['notevil.com', 'notevil.com'],
    ['goodevil.com', 'goodevil.com'],
    ['evil.com.attacker.net', 'attacker.net'], // registrable is the suffix owner
  ])('should_canonicalize_%s_to_%s_not_evil.com', (input, expected) => {
    const result = canonicalizeRegistrableDomain(input);
    expect(result).toBe(expected);
    expect(result).not.toBe('evil.com');
  });
});

describe('canonicalizeRegistrableDomain — multi-label public suffixes (eTLD+1)', () => {
  it.each([
    ['shop.co.uk', 'shop.co.uk'],
    ['a.b.shop.co.uk', 'shop.co.uk'],
    ['foo.com.tr', 'foo.com.tr'],
    ['x.y.foo.com.tr', 'foo.com.tr'],
    ['site.com.au', 'site.com.au'],
  ])('should_reduce_%s_to_registrable_%s', (input, expected) => {
    expect(canonicalizeRegistrableDomain(input)).toBe(expected);
  });

  it('should_fall_back_to_last_two_labels_for_an_unknown_multi_label_suffix', () => {
    // `.zz.qq` is not in the in-repo subset -> last-two-labels fail-safe.
    expect(canonicalizeRegistrableDomain('a.b.thing.zz.qq')).toBe('zz.qq');
  });
});

describe('canonicalizeRegistrableDomain — fail-closed cases', () => {
  it('should_return_null_for_an_empty_host', () => {
    expect(canonicalizeRegistrableDomain('')).toBeNull();
  });

  it('should_return_null_for_an_overlong_host', () => {
    expect(canonicalizeRegistrableDomain(`${'a'.repeat(260)}.com`)).toBeNull();
  });

  it('should_return_null_for_an_ipv6_literal', () => {
    expect(canonicalizeRegistrableDomain('[::1]')).toBeNull();
  });

  it('should_pass_through_a_single_label_unchanged', () => {
    expect(canonicalizeRegistrableDomain('localhost')).toBe('localhost');
  });

  it('should_pass_through_a_bare_two_label_domain', () => {
    expect(canonicalizeRegistrableDomain('example.org')).toBe('example.org');
  });
});
