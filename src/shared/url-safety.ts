import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { ValidationError } from './errors';

/**
 * SSRF / open-redirect URL validation (ADR-019, security findings H1/H2 + M2,
 * L1). `assertSafeUrl()` is the SINGLE place an inbound destination URL is
 * vetted before it is ever persisted by the shortener, and the only thing that
 * decides whether a URL is safe to store-and-later-redirect-to.
 *
 * Posture: deny-by-default. We validate at WRITE time so a stored URL is always
 * one that passed every check; the redirect path never re-derives the target
 * from request input.
 *
 * DNS-rebinding / TOCTOU caveat (ADR-019): we resolve the hostname and range-
 * check the RESOLVED IP here, at write time. Because this service only ever
 * issues an HTTP 302 redirect (the CLIENT's browser does the fetch from the
 * client's own egress) and NEVER fetches the URL server-side, the classic
 * DNS-rebinding TOCTOU window does not apply to us: there is no server-side
 * socket whose IP could change between this check and a fetch. The resolved-IP
 * check defends against a hostname that resolves to an internal address at
 * write time. If a server-side fetch/unfurl is ever added, that future fetcher
 * MUST re-resolve and pin the socket to the validated IP — do not rely on this
 * write-time check for that case.
 */

/** Allowed URL schemes — everything else (javascript:, data:, file:, ftp:, …) is rejected. */
const ALLOWED_SCHEMES = new Set(['http:', 'https:']);

/** Allowed destination ports — only the standard web ports. */
const ALLOWED_PORTS = new Set([80, 443]);

/** Hard cap on URL length to bound abuse + log/storage size (ADR-019/M2). */
export const MAX_URL_LENGTH = 2048;

/** DNS resolution timeout (ms). On timeout we fail closed -> reject (M2). */
const DNS_TIMEOUT_MS = 3000;

/** Bit lengths for CIDR math. */
const IPV4_BITS = 32;
const BYTE_BITS = 8;

/** Width (bits) of one IPv6 hextet group, and the base for parsing hex groups. */
const HEXTET_BITS = 16;
const HEX_RADIX = 16;
/** Mask for the low 8 bits of a 32-bit value (one IPv4 octet). */
const OCTET_MASK = 0xff;

/**
 * Blocked IPv4 CIDR ranges (loopback, private RFC1918, link-local incl. cloud
 * metadata 169.254.169.254, CGNAT, "this host", broadcast). ADR-019.
 */
const BLOCKED_IPV4_CIDRS: ReadonlyArray<readonly [string, number]> = [
  ['0.0.0.0', 8], // "this host" / unspecified
  ['10.0.0.0', 8], // RFC1918 private
  ['100.64.0.0', 10], // CGNAT (RFC6598)
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local (incl. 169.254.169.254 metadata)
  ['172.16.0.0', 12], // RFC1918 private
  ['192.168.0.0', 16], // RFC1918 private
  ['255.255.255.255', 32], // broadcast
];

/**
 * Convert a dotted-quad IPv4 string to its 32-bit unsigned integer.
 *
 * @param ip A canonical dotted-quad IPv4 address.
 * @returns The address as an unsigned 32-bit number.
 */
function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, octet) => (acc << BYTE_BITS) + Number(octet), 0) >>> 0;
}

/**
 * Test whether an IPv4 address falls inside a CIDR block.
 *
 * @param ip A canonical dotted-quad IPv4 address.
 * @param base The CIDR base address.
 * @param prefix The CIDR prefix length.
 * @returns True if `ip` is within `base/prefix`.
 */
function ipv4InCidr(ip: string, base: string, prefix: number): boolean {
  if (prefix === 0) return true;
  const mask = (0xffffffff << (IPV4_BITS - prefix)) >>> 0;
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(base) & mask);
}

/**
 * True if a canonical IPv4 address is in any blocked range (ADR-019).
 *
 * @param ip A canonical dotted-quad IPv4 address.
 * @returns True if the address is loopback/private/link-local/CGNAT/reserved.
 */
function isBlockedIpv4(ip: string): boolean {
  return BLOCKED_IPV4_CIDRS.some(([base, prefix]) => ipv4InCidr(ip, base, prefix));
}

/**
 * Convert an unsigned 32-bit integer to its canonical dotted-quad IPv4 string.
 *
 * @param value The address as an unsigned 32-bit number (0..0xffffffff).
 * @returns The canonical dotted-quad IPv4 address (e.g. 0x7f000001 -> "127.0.0.1").
 */
function intToIpv4(value: number): string {
  return [
    (value >>> (BYTE_BITS * 3)) & OCTET_MASK,
    (value >>> (BYTE_BITS * 2)) & OCTET_MASK,
    (value >>> BYTE_BITS) & OCTET_MASK,
    value & OCTET_MASK,
  ].join('.');
}

/**
 * Extract the embedded IPv4 from an IPv4-mapped IPv6 address (`::ffff:0:0/96`),
 * accepting BOTH forms an IPv4-mapped address can take:
 *   - dotted-decimal tail: `::ffff:1.2.3.4`
 *   - compressed-hex tail: `::ffff:HHHH:HHHH`, `::ffff:HHHH` or `::ffff:HHHH:`
 *     (the WHATWG `URL` parser canonicalizes `[::ffff:127.0.0.1]` to the hex
 *     hostname `::ffff:7f00:1`, and drops a leading all-zero hextet so e.g.
 *     `0.0.0.1` becomes `::ffff:1`). The low 32 bits across the (up to two)
 *     trailing hextets are the embedded IPv4.
 *
 * @param lower A lowercased IPv6 address string.
 * @returns The embedded IPv4 as canonical dotted-quad, or null if `lower` is not
 *   an IPv4-mapped (`::ffff:...`) address.
 */
function extractMappedIpv4(lower: string): string | null {
  const dotted = lower.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (dotted) return dotted[1];

  const hex = lower.match(/^::ffff:([0-9a-f]{1,4})(?::([0-9a-f]{1,4}))?$/);
  if (!hex) return null;

  const high = hex[2] === undefined ? 0 : parseInt(hex[1], HEX_RADIX);
  const low = hex[2] === undefined ? parseInt(hex[1], HEX_RADIX) : parseInt(hex[2], HEX_RADIX);
  const value = ((high << HEXTET_BITS) | low) >>> 0;
  return intToIpv4(value);
}

/**
 * True if an IPv6 address is loopback (::1), unspecified (::), unique-local
 * (fc00::/7), link-local (fe80::/10), or an IPv4-mapped address (::ffff:0:0/96)
 * whose embedded IPv4 is itself blocked. ADR-019.
 *
 * IPv4-mapped addresses are the SSRF foot-gun: they can reach an internal IPv4
 * via the `::ffff:` tail in either the dotted-decimal form (`::ffff:127.0.0.1`,
 * as a resolver may emit) OR the compressed-hex form (`::ffff:7f00:1`, as the
 * WHATWG `URL` parser canonicalizes a host literal to). We derive the embedded
 * IPv4 for ANY mapped form and apply the IPv4 blocklist. Belt-and-suspenders:
 * if the address is in the `::ffff:` prefix but we cannot reliably parse the
 * embedded IPv4, we FAIL CLOSED (treat it as blocked) rather than let an
 * unrecognized encoding through.
 *
 * @param ip A canonical IPv6 address (URL-parsed host literal or DNS result).
 * @returns True if the address is internal/reserved.
 */
function isBlockedIpv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower === '::') return true;
  if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) {
    return true; // fe80::/10 link-local
  }
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // fc00::/7 ULA
  if (lower.startsWith('::ffff:')) {
    const mapped = extractMappedIpv4(lower);
    // Fail closed: an IPv4-mapped prefix we cannot parse is rejected, not allowed.
    return mapped === null ? true : isBlockedIpv4(mapped);
  }
  return false;
}

/**
 * True if a literal IP string (v4 or v6) is in a blocked range.
 *
 * @param ip An IP literal (already validated as a valid IP by the caller).
 * @returns True if the address is internal/reserved/loopback.
 */
function isBlockedIp(ip: string): boolean {
  return isIP(ip) === 6 ? isBlockedIpv6(ip) : isBlockedIpv4(ip);
}

/**
 * Reject the URL with a generic 422. The raw URL is intentionally NOT echoed in
 * the message (a credential-bearing URL must never reach logs/clients, L1).
 *
 * @param reason Short machine-style reason recorded as a validation detail.
 * @throws ValidationError always (-> HTTP 422).
 */
function reject(reason: string): never {
  throw new ValidationError('URL failed safety validation', [{ path: 'url', message: reason }]);
}

/**
 * Parse + structurally validate a URL: length cap, WHATWG parse, scheme
 * allowlist, no embedded credentials, port allowlist. Normalizes a numeric
 * (decimal/hex/octal-encoded) IPv4 host into canonical dotted-quad form so the
 * IP range check cannot be bypassed by encoding (e.g. http://2130706433/).
 *
 * @param raw The untrusted URL string.
 * @returns The parsed URL plus the host to resolve (canonical IP if it was a literal).
 * @throws ValidationError on any structural violation.
 */
function parseAndCheckStructure(raw: string): { url: URL; host: string } {
  if (typeof raw !== 'string' || raw.length === 0) reject('URL is required');
  if (raw.length > MAX_URL_LENGTH) reject('URL exceeds maximum length');

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return reject('URL is malformed');
  }

  if (!ALLOWED_SCHEMES.has(url.protocol)) reject('Only http and https URLs are allowed');
  if (url.username !== '' || url.password !== '') reject('Credentials in URL are not allowed');

  if (url.port !== '' && !ALLOWED_PORTS.has(Number(url.port))) reject('Port is not allowed');

  return { url, host: normalizeHost(url.hostname) };
}

/**
 * Normalize the WHATWG-parsed hostname. The URL parser already canonicalizes
 * decimal/hex/octal IPv4 literals (e.g. 0x7f.1, 2130706433) into dotted-quad,
 * and wraps IPv6 literals in brackets — strip those brackets so `isIP` accepts
 * the address.
 *
 * @param hostname The `URL.hostname` value.
 * @returns A bare host (dotted-quad IPv4, bare IPv6, or a DNS name).
 */
function normalizeHost(hostname: string): string {
  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    return hostname.slice(1, -1);
  }
  return hostname;
}

/**
 * Reject a hostname that is obviously local before we even resolve it
 * (defense in depth; the resolved-IP check is the authoritative one).
 *
 * @param host The bare host.
 * @throws ValidationError if the host is `localhost` or a local-suffix name.
 */
function checkHostnameShortcuts(host: string): void {
  const lower = host.toLowerCase();
  if (lower === 'localhost' || lower.endsWith('.localhost') || lower.endsWith('.local')) {
    reject('Host is not allowed');
  }
}

/**
 * Resolve a DNS hostname to its addresses, failing closed on timeout/error
 * (M2). On any failure the URL is rejected — we never store a host we could
 * not vet.
 *
 * @param host The DNS hostname to resolve.
 * @returns The list of resolved IP address strings.
 * @throws ValidationError if resolution fails or times out (fail-closed).
 */
async function resolveOrReject(host: string): Promise<string[]> {
  const timeout = new Promise<never>((_resolve, rejectTimer) => {
    setTimeout(() => rejectTimer(new Error('DNS timeout')), DNS_TIMEOUT_MS).unref();
  });
  try {
    const records = await Promise.race([lookup(host, { all: true }), timeout]);
    return records.map((r) => r.address);
  } catch {
    return reject('Host could not be resolved');
  }
}

/**
 * Validate that a user-supplied URL is safe to store and later 302-redirect to
 * (ADR-019, findings H1/H2/M2/L1). Performs scheme/credential/port checks, then
 * resolves the host and range-checks EVERY resolved IP against the internal /
 * reserved blocklist. Fails closed.
 *
 * @param raw The untrusted destination URL from the request body.
 * @returns The normalized, safe URL string (`URL.href`) to persist.
 * @throws ValidationError (HTTP 422) if the URL violates any safety rule.
 */
export async function assertSafeUrl(raw: string): Promise<string> {
  const { url, host } = parseAndCheckStructure(raw);

  // Literal IP host: range-check directly (no DNS needed).
  if (isIP(host) !== 0) {
    if (isBlockedIp(host)) reject('URL resolves to a disallowed address');
    return url.href;
  }

  checkHostnameShortcuts(host);

  // DNS name: resolve and range-check every answer (resolved-IP check, ADR-019).
  const addresses = await resolveOrReject(host);
  if (addresses.length === 0) reject('Host could not be resolved');
  if (addresses.some(isBlockedIp)) reject('URL resolves to a disallowed address');

  return url.href;
}
