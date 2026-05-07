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
});
