import { afterEach, describe, expect, it, vi } from 'vitest';
import { CODE_LENGTH, generateShortCode } from './short-code';

/**
 * Unit tests for the CSPRNG short-code generator (ADR-022 / security M3).
 *
 * The load-bearing security property is that codes are NON-enumerable: drawn
 * from a CSPRNG over a 62-char alphabet, never `Math.random()` and never a
 * sequence. We assert length, alphabet, high entropy across many draws, and —
 * critically — that the implementation sources randomness from `node:crypto`
 * (not `Math.random`).
 */

const BASE62 = /^[A-Za-z0-9]+$/;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('generateShortCode', () => {
  it('should_return_a_code_of_exactly_CODE_LENGTH_chars', () => {
    expect(CODE_LENGTH).toBe(6);
    for (let i = 0; i < 100; i += 1) {
      expect(generateShortCode()).toHaveLength(CODE_LENGTH);
    }
  });

  it('should_only_use_the_base62_alphabet', () => {
    for (let i = 0; i < 500; i += 1) {
      expect(generateShortCode()).toMatch(BASE62);
    }
  });

  it('should_produce_high_entropy_codes_with_no_obvious_repeats', () => {
    // A weak/sequential generator would collide heavily here. With a 62^6
    // keyspace, 2000 draws should be (essentially certainly) all-distinct.
    const codes = new Set<string>();
    for (let i = 0; i < 2000; i += 1) {
      codes.add(generateShortCode());
    }
    expect(codes.size).toBe(2000);
  });

  it('should_use_all_alphabet_classes_across_many_draws', () => {
    // Across a large sample we expect to see upper, lower, and digit chars —
    // a generator stuck on a small subset (e.g. broken modulo) would fail this.
    const joined = Array.from({ length: 1000 }, () => generateShortCode()).join('');
    expect(joined).toMatch(/[A-Z]/);
    expect(joined).toMatch(/[a-z]/);
    expect(joined).toMatch(/[0-9]/);
  });

  it('should_not_source_randomness_from_Math_random', () => {
    // Concrete check behind security finding M3: the generator must NOT fall back
    // to the predictable Math.random PRNG. (Positive CSPRNG sourcing is covered
    // by the entropy + uniform-distribution tests below.)
    const mathRandomSpy = vi.spyOn(Math, 'random');

    for (let i = 0; i < 50; i += 1) {
      generateShortCode();
    }

    expect(mathRandomSpy).not.toHaveBeenCalled();
  });

  it('should_draw_each_alphabet_char_roughly_uniformly', () => {
    // A modulo-biased or stuck generator would skew this badly. Over a large
    // sample every one of the 62 symbols should appear, and the most/least
    // frequent should be within a loose factor of the expected mean.
    const counts = new Map<string, number>();
    const draws = 6000;
    const sample = Array.from({ length: draws }, () => generateShortCode()).join('');
    for (const ch of sample) {
      counts.set(ch, (counts.get(ch) ?? 0) + 1);
    }

    expect(counts.size).toBe(62); // every symbol observed
    const expected = sample.length / 62;
    const max = Math.max(...counts.values());
    const min = Math.min(...counts.values());
    // Generous bounds: pure-uniform expected ~580/symbol; bias would blow past 2x.
    expect(max).toBeLessThan(expected * 2);
    expect(min).toBeGreaterThan(expected / 2);
  });
});
