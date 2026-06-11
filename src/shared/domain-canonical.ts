import { MULTI_LABEL_PUBLIC_SUFFIXES } from './abuse-data';

/**
 * Domain canonicalization pipeline (ADR-034 — the blocklist BYPASS surface).
 *
 * The SINGLE source of the canonical registrable-domain form. It is applied to
 * BOTH the candidate host (at screen time) AND a stored blocklist entry (at
 * `POST /admin/blocklist` write time) so the two always agree and a blocklist
 * match is a single index-backed EQUALITY probe, never a suffix scan. The
 * ordered steps each close one bypass class:
 *
 *   1. lowercase            — `EVIL.com`
 *   2. IDN → punycode       — `еvil.com` (Cyrillic), `xn--…` (both normalize to
 *                             one ASCII form). We reuse the WHATWG `URL` parser,
 *                             which ALREADY emits punycode for IDN hostnames —
 *                             we do NOT hand-roll IDN (the same primitive
 *                             url-safety.ts relies on).
 *   3. strip trailing dot   — `evil.com.`
 *   4. reduce to eTLD+1     — `a.b.evil.com` → `evil.com`
 *
 * Note: scheme/port/credential/path stripping is handled UPSTREAM by the WHATWG
 * parse in `assertSafeUrl` (R0/R17) — this module only canonicalizes a bare
 * host, never re-parses a full URL.
 */

/** A `host:port`-style input could arrive only via misuse; guard the host length. */
const MAX_HOST_LENGTH = 253;

/**
 * Lowercase + IDN→punycode a bare hostname using the WHATWG URL parser.
 *
 * Constructing `https://<host>` and reading back `url.hostname` yields the
 * parser's canonical host: lowercased and, for an IDN, punycode-encoded
 * (`xn--…`). This is the exact normalization url-safety.ts already depends on —
 * we never hand-roll Unicode/IDN handling.
 *
 * @param host A bare hostname (no scheme/port/path).
 * @returns The lowercased, punycode-normalized host, or null if it cannot be
 *   parsed as a host (caller treats null as "not canonicalizable").
 */
function toPunycodeHost(host: string): string | null {
  if (host.length === 0 || host.length > MAX_HOST_LENGTH) {
    return null;
  }
  try {
    // The parser lowercases + punycodes the hostname; brackets wrap IPv6 literals.
    return new URL(`https://${host}`).hostname;
  } catch {
    return null;
  }
}

/**
 * Strip a single trailing FQDN dot (`evil.com.` → `evil.com`).
 *
 * @param host A host string.
 * @returns The host without a single trailing dot.
 */
function stripTrailingDot(host: string): string {
  return host.endsWith('.') ? host.slice(0, -1) : host;
}

/**
 * Reduce a host to its registrable domain (eTLD+1) using the in-repo
 * public-suffix subset, with a last-two-labels fail-safe (ADR-034).
 *
 * Walks the longest matching multi-label public suffix; the registrable domain
 * is one label more than that suffix. If no multi-label suffix matches, falls
 * back to the last two labels (the common `evil.com` case). Fewer than two
 * labels (a bare TLD or single label) is returned unchanged.
 *
 * @param host A lowercased, punycode, dot-stripped host.
 * @returns The registrable domain (eTLD+1).
 */
function registrableDomain(host: string): string {
  const labels = host.split('.');
  if (labels.length <= 2) {
    return host;
  }
  // Try the two-label suffix (e.g. `co.uk`); if it is a known multi-label public
  // suffix, the registrable domain takes one extra label (three from the end).
  const twoLabelSuffix = labels.slice(-2).join('.');
  if (MULTI_LABEL_PUBLIC_SUFFIXES.has(twoLabelSuffix)) {
    return labels.slice(-3).join('.');
  }
  // Fail-safe: last two labels. Never under-blocks the common eTLD+1 case.
  return labels.slice(-2).join('.');
}

/**
 * Canonicalize a bare host to its registrable domain through the full ordered
 * ADR-034 pipeline (lowercase → punycode → strip trailing dot → eTLD+1).
 *
 * @param host A bare hostname (already extracted from a parsed URL, or an
 *   admin-supplied domain string).
 * @returns The canonical registrable domain, or null if the host cannot be
 *   canonicalized (caller decides the fail-closed behavior).
 */
export function canonicalizeRegistrableDomain(host: string): string | null {
  const trimmed = stripTrailingDot(host.trim());
  const puny = toPunycodeHost(trimmed);
  if (puny === null) {
    return null;
  }
  // IPv6 literals arrive bracketed; they are never a registrable "domain".
  if (puny.startsWith('[')) {
    return null;
  }
  return registrableDomain(stripTrailingDot(puny));
}
