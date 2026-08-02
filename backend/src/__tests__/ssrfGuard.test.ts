/**
 * Unit tests for ssrfGuard utility.
 * Rejects URLs whose hostnames resolve to private/internal IPs.
 */

jest.mock('dns/promises', () => ({
  __esModule: true,
  lookup: jest.fn(),
}));

import { lookup as dnsLookup } from 'dns/promises';

const mockLookup = dnsLookup as unknown as jest.Mock;

// Helper to mock dns.lookup() returning a single IP for the hostname
function mockResolvesTo(ip: string, family: 4 | 6 = ip.includes(':') ? 6 : 4) {
  mockLookup.mockResolvedValue([{ address: ip, family }]);
}

function mockResolvesToAll(addrs: Array<{ address: string; family: 4 | 6 }>) {
  mockLookup.mockResolvedValue(addrs);
}

beforeEach(() => {
  mockLookup.mockReset();
});

describe('assertPublicHostname', () => {
  // ─── REJECT cases ────────────────────────────────────────────────────────

  it('rejects 10.0.0.1 (RFC1918)', async () => {
    mockResolvesTo('10.0.0.1');
    const { assertPublicHostname } = require('../utils/ssrfGuard');
    await expect(assertPublicHostname('http://internal.example.com')).rejects.toThrow(/private|internal/i);
  });

  it('rejects 192.168.1.1 (RFC1918)', async () => {
    mockResolvesTo('192.168.1.1');
    const { assertPublicHostname } = require('../utils/ssrfGuard');
    await expect(assertPublicHostname('http://router.local')).rejects.toThrow(/private|internal/i);
  });

  it('rejects 172.20.0.5 (RFC1918 middle of range)', async () => {
    mockResolvesTo('172.20.0.5');
    const { assertPublicHostname } = require('../utils/ssrfGuard');
    await expect(assertPublicHostname('http://docker.local')).rejects.toThrow(/private|internal/i);
  });

  it('rejects 127.0.0.1 (loopback)', async () => {
    mockResolvesTo('127.0.0.1');
    const { assertPublicHostname } = require('../utils/ssrfGuard');
    await expect(assertPublicHostname('http://localhost-resolved.example.com')).rejects.toThrow(/private|internal/i);
  });

  it('rejects 169.254.169.254 (link-local / cloud metadata)', async () => {
    mockResolvesTo('169.254.169.254');
    const { assertPublicHostname } = require('../utils/ssrfGuard');
    await expect(assertPublicHostname('http://meta.example.com')).rejects.toThrow(/private|internal/i);
  });

  it('rejects 100.64.0.1 (CGNAT)', async () => {
    mockResolvesTo('100.64.0.1');
    const { assertPublicHostname } = require('../utils/ssrfGuard');
    await expect(assertPublicHostname('http://cgnat.example.com')).rejects.toThrow(/private|internal/i);
  });

  it('rejects ::1 (IPv6 loopback)', async () => {
    mockResolvesTo('::1', 6);
    const { assertPublicHostname } = require('../utils/ssrfGuard');
    await expect(assertPublicHostname('http://ipv6-loop.example.com')).rejects.toThrow(/private|internal/i);
  });

  it('rejects fc00::1 (IPv6 unique local)', async () => {
    mockResolvesTo('fc00::1', 6);
    const { assertPublicHostname } = require('../utils/ssrfGuard');
    await expect(assertPublicHostname('http://ula.example.com')).rejects.toThrow(/private|internal/i);
  });

  it('rejects fe80::1 (IPv6 link-local)', async () => {
    mockResolvesTo('fe80::1', 6);
    const { assertPublicHostname } = require('../utils/ssrfGuard');
    await expect(assertPublicHostname('http://ll.example.com')).rejects.toThrow(/private|internal/i);
  });

  it('rejects ::ffff:10.0.0.1 (IPv4-mapped private)', async () => {
    mockResolvesTo('::ffff:10.0.0.1', 6);
    const { assertPublicHostname } = require('../utils/ssrfGuard');
    await expect(assertPublicHostname('http://mapped.example.com')).rejects.toThrow(/private|internal/i);
  });

  it('rejects hostname literal `localhost`', async () => {
    const { assertPublicHostname } = require('../utils/ssrfGuard');
    await expect(assertPublicHostname('http://localhost/x')).rejects.toThrow(/private|internal/i);
  });

  it('rejects hostname `metadata.google.internal`', async () => {
    const { assertPublicHostname } = require('../utils/ssrfGuard');
    await expect(assertPublicHostname('http://metadata.google.internal/')).rejects.toThrow(/private|internal/i);
  });

  it('rejects hostname `metadata.aws.internal`', async () => {
    const { assertPublicHostname } = require('../utils/ssrfGuard');
    await expect(assertPublicHostname('http://metadata.aws.internal/')).rejects.toThrow(/private|internal/i);
  });

  it('rejects when DNS returns multiple IPs and any one is private', async () => {
    mockResolvesToAll([
      { address: '8.8.8.8', family: 4 },
      { address: '10.0.0.5', family: 4 },
    ]);
    const { assertPublicHostname } = require('../utils/ssrfGuard');
    await expect(assertPublicHostname('http://multi.example.com')).rejects.toThrow(/private|internal/i);
  });

  it('rejects when URL has a literal private IP as hostname (no DNS)', async () => {
    const { assertPublicHostname } = require('../utils/ssrfGuard');
    await expect(assertPublicHostname('http://10.0.0.5/')).rejects.toThrow(/private|internal/i);
  });

  it('rejects when URL is malformed', async () => {
    const { assertPublicHostname } = require('../utils/ssrfGuard');
    await expect(assertPublicHostname('not a url')).rejects.toThrow();
  });

  // ─── A.2: multicast / broadcast / class-E (added Phase 4) ────────────────

  it('rejects 224.0.0.1 (IPv4 multicast)', async () => {
    mockResolvesTo('224.0.0.1');
    const { assertPublicHostname } = require('../utils/ssrfGuard');
    await expect(assertPublicHostname('http://multicast.example')).rejects.toThrow(/private|internal/i);
  });

  it('rejects 239.255.255.250 (IPv4 SSDP multicast)', async () => {
    mockResolvesTo('239.255.255.250');
    const { assertPublicHostname } = require('../utils/ssrfGuard');
    await expect(assertPublicHostname('http://ssdp.example')).rejects.toThrow(/private|internal/i);
  });

  it('rejects 255.255.255.255 (IPv4 broadcast)', async () => {
    mockResolvesTo('255.255.255.255');
    const { assertPublicHostname } = require('../utils/ssrfGuard');
    await expect(assertPublicHostname('http://broadcast.example')).rejects.toThrow(/private|internal/i);
  });

  it('rejects 240.0.0.0 (IPv4 class E reserved)', async () => {
    mockResolvesTo('240.0.0.0');
    const { assertPublicHostname } = require('../utils/ssrfGuard');
    await expect(assertPublicHostname('http://classe.example')).rejects.toThrow(/private|internal/i);
  });

  it('rejects ff02::1 (IPv6 multicast)', async () => {
    mockResolvesTo('ff02::1', 6);
    const { assertPublicHostname } = require('../utils/ssrfGuard');
    await expect(assertPublicHostname('http://[ff02::1]/')).rejects.toThrow(/private|internal/i);
  });

  // ─── ACCEPT cases ────────────────────────────────────────────────────────

  it('accepts public IPv4 (8.8.8.8)', async () => {
    mockResolvesTo('8.8.8.8');
    const { assertPublicHostname } = require('../utils/ssrfGuard');
    await expect(assertPublicHostname('http://example.com/path')).resolves.toBeUndefined();
  });

  it('accepts public IPv4 (1.1.1.1)', async () => {
    mockResolvesTo('1.1.1.1');
    const { assertPublicHostname } = require('../utils/ssrfGuard');
    await expect(assertPublicHostname('https://cloudflare.com/path')).resolves.toBeUndefined();
  });

  it('accepts public IPv6 (2606:4700:4700::1111)', async () => {
    mockResolvesTo('2606:4700:4700::1111', 6);
    const { assertPublicHostname } = require('../utils/ssrfGuard');
    await expect(assertPublicHostname('https://example-v6.com')).resolves.toBeUndefined();
  });

  // ─── Coverage: branches missed by the cases above ────────────────────────

  it('rejects ::ffff:0a00:0001 (hex-form IPv4-mapped → 10.0.0.1)', async () => {
    mockResolvesTo('::ffff:0a00:0001', 6);
    const { assertPublicHostname } = require('../utils/ssrfGuard');
    await expect(assertPublicHostname('http://hex-mapped.example')).rejects.toThrow(/private|internal/i);
  });

  it('accepts ::ffff:0808:0808 (hex-form IPv4-mapped → 8.8.8.8 public)', async () => {
    mockResolvesTo('::ffff:0808:0808', 6);
    const { assertPublicHostname } = require('../utils/ssrfGuard');
    await expect(assertPublicHostname('http://hex-mapped-public.example')).resolves.toBeUndefined();
  });

  it('accepts a literal public IPv4 hostname (no DNS lookup)', async () => {
    const { assertPublicHostname } = require('../utils/ssrfGuard');
    // 1.1.1.1 is parsed as an IP literal, so the IP-literal short-circuit
    // returns success without ever calling dnsLookup.
    await expect(assertPublicHostname('http://1.1.1.1/')).resolves.toBeUndefined();
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it('rejects when DNS lookup itself throws', async () => {
    mockLookup.mockRejectedValueOnce(new Error('ENOTFOUND'));
    const { assertPublicHostname } = require('../utils/ssrfGuard');
    await expect(assertPublicHostname('http://no-such-host.example'))
      .rejects.toThrow(/DNS lookup failed/);
  });

  it('rejects with "unknown" message when DNS error has no message', async () => {
    // Mock rejecting with an object lacking `.message` so the `|| "unknown"`
    // fallback branch is exercised.
    mockLookup.mockRejectedValueOnce({});
    const { assertPublicHostname } = require('../utils/ssrfGuard');
    await expect(assertPublicHostname('http://no-message-err.example'))
      .rejects.toThrow(/DNS lookup failed: unknown/);
  });

  it('rejects when DNS returns no addresses', async () => {
    mockLookup.mockResolvedValueOnce([]);
    const { assertPublicHostname } = require('../utils/ssrfGuard');
    await expect(assertPublicHostname('http://empty-resolve.example'))
      .rejects.toThrow(/did not resolve/);
  });

  it('rejects URLs that parse but have an empty hostname (javascript:, file:, data:)', async () => {
    const { assertPublicHostname } = require('../utils/ssrfGuard');
    await expect(assertPublicHostname('javascript:alert(1)')).rejects.toThrow(/Invalid URL/);
    await expect(assertPublicHostname('file:///etc/passwd')).rejects.toThrow(/Invalid URL/);
    await expect(assertPublicHostname('data:text/plain,hi')).rejects.toThrow(/Invalid URL/);
  });

  it('rejects 0.0.0.0/8 (this-network range)', async () => {
    mockResolvesTo('0.0.0.0');
    const { assertPublicHostname } = require('../utils/ssrfGuard');
    await expect(assertPublicHostname('http://zero.example')).rejects.toThrow(/private|internal/i);
  });

  it('rejects 0.1.2.3 (also in this-network /8)', async () => {
    mockResolvesTo('0.1.2.3');
    const { assertPublicHostname } = require('../utils/ssrfGuard');
    await expect(assertPublicHostname('http://zero2.example')).rejects.toThrow(/private|internal/i);
  });

  it('rejects :: (IPv6 unspecified)', async () => {
    mockResolvesTo('::', 6);
    const { assertPublicHostname } = require('../utils/ssrfGuard');
    await expect(assertPublicHostname('http://unspec.example')).rejects.toThrow(/private|internal/i);
  });
});

// Greptile finding: assertPublicHostname validates one DNS answer, but a
// caller that then does its own separate DNS lookup to actually connect
// (e.g. axios.get without pinning) is vulnerable to DNS rebinding — an
// attacker-controlled DNS server can return a public IP for the validation
// lookup and a private IP for the connection lookup (different responses to
// different queries). resolvePinnedPublicAddress returns the validated
// address itself so the caller can pin its connection to exactly that IP,
// eliminating the second, unvalidated lookup entirely.
describe('resolvePinnedPublicAddress', () => {
  it('returns the validated address and family for a public hostname', async () => {
    mockResolvesTo('93.184.216.34');
    const { resolvePinnedPublicAddress } = require('../utils/ssrfGuard');

    const result = await resolvePinnedPublicAddress('http://example.com/audience.csv');

    expect(result).toEqual({ hostname: 'example.com', address: '93.184.216.34', family: 4 });
  });

  it('returns the literal IP directly when the hostname is itself an IP (no DNS lookup)', async () => {
    const { resolvePinnedPublicAddress } = require('../utils/ssrfGuard');

    const result = await resolvePinnedPublicAddress('http://93.184.216.34/audience.csv');

    expect(result).toEqual({ hostname: '93.184.216.34', address: '93.184.216.34', family: 4 });
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it('rejects the same way assertPublicHostname does when the resolved address is private', async () => {
    mockResolvesTo('169.254.169.254');
    const { resolvePinnedPublicAddress } = require('../utils/ssrfGuard');

    await expect(resolvePinnedPublicAddress('http://metadata.example/audience.csv')).rejects.toThrow(/private|internal/i);
  });
});
