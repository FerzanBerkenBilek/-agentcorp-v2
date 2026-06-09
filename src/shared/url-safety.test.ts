import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ValidationError } from './errors';
import { assertSafeUrl, MAX_URL_LENGTH } from './url-safety';

/**
 * Unit tests for the SSRF / open-redirect URL validator (ADR-019, security
 * findings H1/H2/M2/L1).
 *
 * DNS is mocked (`node:dns/promises.lookup`) so the resolved-IP range checks are
 * deterministic and run fully offline — the validator otherwise performs a real
 * DNS lookup. Each test arranges exactly what the host resolves to, so the
 * assertion is about the validator's decision, not the network.
 */

/** Controllable resolver result for the current test (set per-test). */
const lookupMock = vi.fn();

vi.mock('node:dns/promises', () => ({
  lookup: (...args: unknown[]) => lookupMock(...args),
}));

/** Make the mocked DNS lookup resolve a host to the given IPs. */
function resolvesTo(...addresses: string[]): void {
  lookupMock.mockResolvedValue(addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })));
}

beforeEach(() => {
  lookupMock.mockReset();
});

describe('assertSafeUrl — scheme allowlist (H1)', () => {
  it.each([
    ['javascript:alert(1)', 'javascript'],
    ['data:text/html,<script>1</script>', 'data'],
    ['file:///etc/passwd', 'file'],
    ['ftp://example.com/x', 'ftp'],
  ])('should_reject_%s_scheme', async (raw) => {
    await expect(assertSafeUrl(raw)).rejects.toBeInstanceOf(ValidationError);
  });

  it('should_not_perform_dns_lookup_for_a_rejected_scheme', async () => {
    await expect(assertSafeUrl('file:///etc/passwd')).rejects.toBeInstanceOf(ValidationError);
    expect(lookupMock).not.toHaveBeenCalled();
  });
});

describe('assertSafeUrl — loopback / unspecified literals (H1)', () => {
  it.each([
    'http://localhost/',
    'http://127.0.0.1/',
    'http://0.0.0.0/',
    'http://[::1]/',
  ])('should_reject_%s', async (raw) => {
    await expect(assertSafeUrl(raw)).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('assertSafeUrl — private / reserved IPv4 literals (H1)', () => {
  it.each([
    ['http://10.0.0.1/', 'RFC1918 10/8'],
    ['http://10.255.255.255/', 'RFC1918 10/8 upper'],
    ['http://172.16.0.1/', 'RFC1918 172.16/12'],
    ['http://172.31.255.255/', 'RFC1918 172.16/12 upper'],
    ['http://192.168.1.1/', 'RFC1918 192.168/16'],
    ['http://169.254.0.1/', 'link-local 169.254/16'],
    ['http://169.254.169.254/latest/meta-data/', 'cloud metadata'],
    ['http://100.64.0.1/', 'CGNAT 100.64/10'],
    ['http://255.255.255.255/', 'broadcast'],
  ])('should_reject_%s (%s)', async (raw) => {
    await expect(assertSafeUrl(raw)).rejects.toBeInstanceOf(ValidationError);
  });

  it('should_not_resolve_dns_for_a_blocked_ip_literal', async () => {
    await expect(assertSafeUrl('http://169.254.169.254/')).rejects.toBeInstanceOf(ValidationError);
    expect(lookupMock).not.toHaveBeenCalled();
  });
});

describe('assertSafeUrl — encoded private IPs cannot bypass (H1)', () => {
  it('should_reject_decimal_encoded_loopback_2130706433', async () => {
    // 2130706433 === 127.0.0.1; WHATWG URL canonicalizes it to dotted-quad.
    await expect(assertSafeUrl('http://2130706433/')).rejects.toBeInstanceOf(ValidationError);
  });

  it('should_reject_hex_encoded_loopback', async () => {
    await expect(assertSafeUrl('http://0x7f.0.0.1/')).rejects.toBeInstanceOf(ValidationError);
  });

  it('should_reject_octal_encoded_loopback', async () => {
    await expect(assertSafeUrl('http://0177.0.0.1/')).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('assertSafeUrl — internal IPv6 literals (H1)', () => {
  it.each([
    'http://[fd00::1]/', // unique-local fc00::/7
    'http://[fe80::1]/', // link-local fe80::/10
  ])('should_reject_%s', async (raw) => {
    await expect(assertSafeUrl(raw)).rejects.toBeInstanceOf(ValidationError);
  });

});

describe('assertSafeUrl — IPv4-mapped IPv6 literals (H1, SSRF bypass fixed)', () => {
  // Regression matrix for the High-severity IPv4-mapped-IPv6 SSRF bypass
  // (formerly pinned as CURRENTLY_ACCEPTS_ipv4_mapped_ipv6_loopback__KNOWN_SSRF_BUG).
  // The WHATWG URL parser canonicalizes an IPv4-mapped IPv6 host literal to its
  // COMPRESSED-HEX form (`[::ffff:127.0.0.1]` -> hostname `::ffff:7f00:1`, and it
  // drops a leading all-zero hextet so `::ffff:0:1` -> `::ffff:1`). backend-dev's
  // fix (ADR-019/H1) extracts the embedded IPv4 from BOTH the dotted-decimal and
  // the compressed-hex tail, runs it through the IPv4 CIDR blocklist, and FAILS
  // CLOSED on any unparseable `::ffff:` form. These are IP literals — no DNS.
  it.each([
    ['http://[::ffff:127.0.0.1]/', 'loopback 127.0.0.1 (dotted)'],
    ['http://[::ffff:7f00:1]/', 'loopback 127.0.0.1 (hex)'],
    ['http://[::ffff:a9fe:a9fe]/', '169.254.169.254 cloud metadata'],
    ['http://[::ffff:0a00:0001]/', '10.0.0.1 RFC1918'],
    ['http://[::ffff:c0a8:1]/', '192.168.0.1 RFC1918'],
    ['http://[::ffff:0:0]/', '0.0.0.0 unspecified'],
    ['http://[::ffff:1]/', '0.0.0.1 (mapped low, 0.0.0.0/8)'],
  ])('should_reject_ipv4_mapped_ipv6_%s (%s)', async (raw) => {
    await expect(assertSafeUrl(raw)).rejects.toBeInstanceOf(ValidationError);
  });

  it('should_not_resolve_dns_for_a_mapped_ipv6_literal', async () => {
    await expect(assertSafeUrl('http://[::ffff:127.0.0.1]/')).rejects.toBeInstanceOf(ValidationError);
    expect(lookupMock).not.toHaveBeenCalled();
  });

  // ACCEPT a PUBLIC IPv4-mapped address — guards against a future over-broad
  // "reject every ::ffff:" regression. 8.8.8.8 is public, so it must pass.
  it.each([
    ['http://[::ffff:8.8.8.8]/', 'public 8.8.8.8 (dotted)'],
    ['http://[::ffff:808:808]/', 'public 8.8.8.8 (hex)'],
  ])('should_accept_public_ipv4_mapped_ipv6_%s (%s)', async (raw) => {
    const result = await assertSafeUrl(raw);
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
    expect(lookupMock).not.toHaveBeenCalled();
  });
});

describe('assertSafeUrl — resolved-IP range check (H1, DNS-rebind defense)', () => {
  it('should_reject_a_public_name_that_resolves_to_a_private_ip', async () => {
    resolvesTo('10.0.0.5');
    await expect(assertSafeUrl('https://evil.example.com/')).rejects.toBeInstanceOf(ValidationError);
  });

  it('should_reject_when_any_resolved_ip_is_private_even_if_one_is_public', async () => {
    resolvesTo('93.184.216.34', '192.168.0.9');
    await expect(assertSafeUrl('https://mixed.example.com/')).rejects.toBeInstanceOf(ValidationError);
  });

  it('should_reject_a_name_that_resolves_to_no_addresses', async () => {
    lookupMock.mockResolvedValue([]);
    await expect(assertSafeUrl('https://empty.example.com/')).rejects.toBeInstanceOf(ValidationError);
  });

  it('should_reject_a_name_that_resolves_to_a_dotted_ipv4_mapped_private_ipv6', async () => {
    // A resolver can hand back the dotted IPv4-mapped form (::ffff:10.0.0.1);
    // the embedded private IPv4 must still be range-checked and rejected.
    resolvesTo('::ffff:10.0.0.1');
    await expect(assertSafeUrl('https://mapped.example.com/')).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('assertSafeUrl — credentials, ports, length, malformed (H1/L1)', () => {
  it('should_reject_credentials_in_url', async () => {
    await expect(assertSafeUrl('http://user:pass@example.com/')).rejects.toBeInstanceOf(ValidationError);
  });

  it('should_reject_non_80_443_ports', async () => {
    await expect(assertSafeUrl('http://example.com:22/')).rejects.toBeInstanceOf(ValidationError);
  });

  it('should_reject_urls_longer_than_the_max', async () => {
    const longUrl = `https://example.com/${'a'.repeat(MAX_URL_LENGTH)}`;
    expect(longUrl.length).toBeGreaterThan(MAX_URL_LENGTH);
    await expect(assertSafeUrl(longUrl)).rejects.toBeInstanceOf(ValidationError);
  });

  it('should_reject_a_malformed_url', async () => {
    await expect(assertSafeUrl('not a url')).rejects.toBeInstanceOf(ValidationError);
  });

  it('should_reject_an_empty_url', async () => {
    await expect(assertSafeUrl('')).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('assertSafeUrl — DNS fail-closed (M2)', () => {
  it('should_reject_when_dns_lookup_rejects', async () => {
    lookupMock.mockRejectedValue(new Error('ENOTFOUND'));
    await expect(assertSafeUrl('https://broken.example.com/')).rejects.toBeInstanceOf(ValidationError);
  });

  it('should_fail_closed_and_reject_when_dns_lookup_hangs_past_the_timeout', async () => {
    // The lookup never resolves; the validator's internal 3s timeout must win
    // and reject. We drive real timers forward so the test stays fast.
    vi.useFakeTimers();
    lookupMock.mockImplementation(() => new Promise(() => undefined));
    try {
      const promise = assertSafeUrl('https://hang.example.com/');
      const expectation = expect(promise).rejects.toBeInstanceOf(ValidationError);
      await vi.advanceTimersByTimeAsync(3500);
      await expectation;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('assertSafeUrl — accepts a normal public https url', () => {
  it('should_accept_and_return_normalized_href_for_a_public_host', async () => {
    resolvesTo('93.184.216.34'); // example.com's public address
    const result = await assertSafeUrl('https://example.com/path?q=1');
    expect(result).toBe('https://example.com/path?q=1');
    expect(lookupMock).toHaveBeenCalledOnce();
  });

  it('should_accept_a_public_ip_literal_without_a_dns_lookup', async () => {
    const result = await assertSafeUrl('https://93.184.216.34/');
    expect(result).toBe('https://93.184.216.34/');
    expect(lookupMock).not.toHaveBeenCalled();
  });
});
