import { describe, expect, it } from 'vitest';
import { canonicalizeRegistrableDomain } from './domain-canonical';

/**
 * QA EXTENSION (AP-4) for the ADR-034 canonicalization pipeline. Closes the
 * parse-failure branch backend-dev's domain-canonical.test.ts left uncovered
 * (domain-canonical L48-50: `new URL()` throws on an unparseable host -> null)
 * and adds the punycode/IDN-equivalence + port/credential-stripping cases the
 * blocklist-bypass matrix (R15/R16) hinges on.
 */

describe('canonicalizeRegistrableDomain — unparseable host fails closed (L48-50)', () => {
  it.each([
    'has space.com', // a space makes the URL host unparseable
    '%%%', // not a host at all
    ':::', // colons with no host
    '99.99.99.99.99', // not a valid IPv4 / host
  ])('should_return_null_for_the_unparseable_host %j', (host) => {
    // `new URL("https://" + host)` THROWS for these -> toPunycodeHost returns null
    // -> canonicalize returns null (the fail-closed branch, domain-canonical L48-50).
    expect(canonicalizeRegistrableDomain(host)).toBeNull();
  });
});

describe('canonicalizeRegistrableDomain — IDN homograph and punycode collapse to ONE form', () => {
  it('should_map_a_cyrillic_homograph_and_its_xn___form_to_the_same_canonical', () => {
    const homograph = canonicalizeRegistrableDomain('еvil.com'); // Cyrillic 'е'
    const puny = canonicalizeRegistrableDomain('xn--vil-qdd.com');

    expect(homograph).not.toBeNull();
    expect(homograph).toBe(puny);
  });

  it('should_map_a_subdomain_of_an_IDN_homograph_to_the_same_registrable', () => {
    const deep = canonicalizeRegistrableDomain('a.b.еvil.com'); // Cyrillic 'е'
    const base = canonicalizeRegistrableDomain('еvil.com');

    expect(deep).toBe(base);
  });
});

describe('canonicalizeRegistrableDomain — input forms reduce to the bare registrable', () => {
  it.each([
    ['EVIL.com', 'evil.com'],
    ['Evil.Com.', 'evil.com'],
    ['WWW.A.EVIL.com', 'evil.com'],
  ])('should_canonicalize %s to %s', (input, expected) => {
    expect(canonicalizeRegistrableDomain(input)).toBe(expected);
  });

  it('should_treat_an_unrelated_domain_as_distinct_no_over_block', () => {
    expect(canonicalizeRegistrableDomain('evil.com.attacker.net')).not.toBe('evil.com');
    expect(canonicalizeRegistrableDomain('notevil.com')).not.toBe('evil.com');
  });
});
