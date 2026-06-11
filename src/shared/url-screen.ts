import { domainToUnicode } from 'node:url';
import { CONFUSABLE_MAP, TOP_BRAND_DOMAINS } from './abuse-data';
import { canonicalizeRegistrableDomain } from './domain-canonical';

/**
 * Abuse screening layer (ADR-034/035) — runs STRICTLY AFTER `assertSafeUrl`.
 *
 * `screenUrl()` takes the ALREADY-validated, normalized URL (`assertSafeUrl`'s
 * returned `href`) and produces a verdict: BLOCK / FLAG / ALLOW. It NEVER
 * re-validates scheme/port/credentials and NEVER overrides assertSafeUrl's
 * `ValidationError` (R0/R17) — SSRF remains entirely the upstream validator's
 * job, byte-untouched. A screen-internal error FAILS CLOSED (BLOCK), never a
 * silent ALLOW.
 *
 * Verdicts (confidence bands, ADR-035, exact-integer compares — no float):
 *   - BLOCK (score 100): the candidate's registrable domain is an EXACT match
 *     to a blocklist entry. The blocklist is the ONLY auto-BLOCK input.
 *   - FLAG  (40..79): a homograph/confusable lookalike of, OR a Levenshtein
 *     distance 1–2 typosquat of, a top-50 brand (and not the brand itself).
 *     FLAG → human review; a false positive costs a review, not a denied user.
 *   - ALLOW (<40): no signal.
 *
 * The matched-rule detail is for the AUDIT log only; the client gets a generic
 * message (R18/R23) — see the admin/urls service callers.
 */

/** Confidence band thresholds (ADR-035). Exact integers; single-sourced here. */
export const BLOCK_THRESHOLD = 80;
/** A confidence at/above this (but below BLOCK) is a FLAG. */
export const FLAG_THRESHOLD = 40;

/** Deterministic scores assigned by each signal (kept inside the bands). */
const SCORE_BLOCKLIST = 100;
const SCORE_HEURISTIC_FLAG = 60;
const SCORE_ALLOW = 0;

/** Levenshtein distance window that counts as a typosquat (ADR-035). */
const TYPOSQUAT_MIN_DISTANCE = 1;
const TYPOSQUAT_MAX_DISTANCE = 2;

/**
 * Cap on the candidate registrable-domain length fed to the distance calc
 * (ReDoS / algorithmic-DoS guard, R21). A registrable domain is realistically
 * <= 63 chars; the distance work is then bounded constant against the fixed list.
 */
const MAX_SCORED_LENGTH = 64;

/** The three possible screening outcomes. */
export type ScreenDecision = 'BLOCK' | 'FLAG' | 'ALLOW';

/** Result of screening a candidate URL. */
export interface ScreenResult {
  /** The verdict band. */
  decision: ScreenDecision;
  /** Confidence 0–100 (exact integer); persisted for FLAGs, audited otherwise. */
  score: number;
  /** Machine reason for the AUDIT log only — never returned to the client. */
  reason: string;
  /** The canonical registrable domain that was screened (for audit/persistence). */
  canonicalDomain: string;
}

/** Async predicate: is this canonical registrable domain on the blocklist? */
export type BlocklistLookup = (canonicalDomain: string) => Promise<boolean>;

/**
 * Fold a host to its confusable "skeleton": the IDN-decoded Unicode characters
 * mapped through the confusable table to their canonical ASCII look-alike.
 * Collapses homoglyph attacks so a Cyrillic/Greek/digit lookalike of a brand
 * becomes the brand's ASCII skeleton. Bounded by the (already length-capped)
 * input — no regex, no backtracking (R21).
 *
 * The input host may be punycode (`xn--…`) since `URL.hostname` ASCII-encodes
 * IDN. We decode it back to Unicode with the WHATWG-standard, NON-deprecated
 * `url.domainToUnicode` (a Node built-in — no dependency, no log noise) so the
 * confusable code points are visible to the fold.
 *
 * @param host The host (possibly punycode `xn--…`) from the validated URL.
 * @returns The folded ASCII skeleton string.
 */
function confusableSkeleton(host: string): string {
  const unicode = host.includes('xn--') ? domainToUnicode(host) : host;
  let out = '';
  for (const char of unicode.toLowerCase()) {
    out += CONFUSABLE_MAP.get(char) ?? char;
  }
  return out;
}

/**
 * Levenshtein edit distance between two short strings (iterative two-row DP).
 *
 * Bounded work: both inputs are length-capped before this is called (R21), and
 * it runs only against the fixed 50-entry brand list — O(n·m) with small n,m and
 * a constant list size. No regex, no backtracking.
 *
 * @param a First string.
 * @param b Second string.
 * @returns The minimum single-character edit distance.
 */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let prev = Array.from({ length: b.length + 1 }, (_unused, i) => i);
  let curr = new Array<number>(b.length + 1);

  for (let i = 1; i <= a.length; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}

/**
 * True if `domain` is itself a top-50 brand (the legitimate brand — never
 * flagged against itself, ADR-035).
 *
 * @param domain A canonical registrable domain.
 * @returns Whether it exactly equals a known brand.
 */
function isExactBrand(domain: string): boolean {
  return TOP_BRAND_DOMAINS.includes(domain);
}

/**
 * Heuristic signal: is `domain` a typosquat (Levenshtein 1–2) or a homograph
 * skeleton-match of a top-50 brand, without being the brand itself? (ADR-035).
 *
 * @param domain The candidate's canonical registrable domain (punycode/ASCII).
 * @param skeleton The confusable-folded skeleton of the candidate (homograph).
 * @returns The matched brand + signal kind, or null if there is no signal.
 */
function matchBrandHeuristic(
  domain: string,
  skeleton: string,
): { brand: string; kind: 'typosquat' | 'homograph' } | null {
  if (isExactBrand(domain)) {
    return null; // The real brand: ALLOW, never flag.
  }
  const scored = domain.slice(0, MAX_SCORED_LENGTH);
  for (const brand of TOP_BRAND_DOMAINS) {
    // Homograph: the confusable skeleton collapses exactly onto a brand.
    if (skeleton !== domain && skeleton === brand) {
      return { brand, kind: 'homograph' };
    }
    const distance = levenshtein(scored, brand);
    if (distance >= TYPOSQUAT_MIN_DISTANCE && distance <= TYPOSQUAT_MAX_DISTANCE) {
      return { brand, kind: 'typosquat' };
    }
  }
  return null;
}

/**
 * Extract the bare host from a validated URL href (post-assertSafeUrl).
 *
 * @param href The normalized URL string returned by assertSafeUrl.
 * @returns The host, or null if (defensively) it cannot be parsed.
 */
function hostOf(href: string): string | null {
  try {
    return new URL(href).hostname;
  } catch {
    return null;
  }
}

/**
 * Screen an already-SSRF-validated URL for blocklist + phishing-heuristic abuse.
 *
 * Composes STRICTLY AFTER `assertSafeUrl` (the caller passes its returned href).
 * Fails closed: a host that cannot be canonicalized is BLOCKED, not allowed.
 *
 * @param safeHref The normalized, SSRF-validated URL (assertSafeUrl's result).
 * @param isBlocked Async blocklist equality probe (injected; lives in admin repo).
 * @returns The screening verdict (BLOCK / FLAG / ALLOW) with score + audit reason.
 */
export async function screenUrl(
  safeHref: string,
  isBlocked: BlocklistLookup,
): Promise<ScreenResult> {
  const host = hostOf(safeHref);
  const canonical = host === null ? null : canonicalizeRegistrableDomain(host);
  if (host === null || canonical === null) {
    // Fail closed (R17): a URL we cannot canonicalize is not silently allowed.
    return { decision: 'BLOCK', score: SCORE_BLOCKLIST, reason: 'uncanonicalizable_host', canonicalDomain: '' };
  }

  if (await isBlocked(canonical)) {
    return { decision: 'BLOCK', score: SCORE_BLOCKLIST, reason: `blocklist:${canonical}`, canonicalDomain: canonical };
  }

  const skeleton = canonicalizeRegistrableDomain(confusableSkeleton(host)) ?? confusableSkeleton(host);
  const heuristic = matchBrandHeuristic(canonical, skeleton);
  if (heuristic !== null) {
    return {
      decision: 'FLAG',
      score: SCORE_HEURISTIC_FLAG,
      reason: `${heuristic.kind}:${heuristic.brand}`,
      canonicalDomain: canonical,
    };
  }

  return { decision: 'ALLOW', score: SCORE_ALLOW, reason: 'clean', canonicalDomain: canonical };
}
