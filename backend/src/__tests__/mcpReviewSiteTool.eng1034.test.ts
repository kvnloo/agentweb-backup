/**
 * ENG-1034 acceptance: emma_review_site, the one tool a stranger may run.
 * Network and DNS are injected; nothing here touches a real socket.
 */
jest.mock('dns/promises', () => ({ lookup: jest.fn() }));

import * as dns from 'dns/promises';
import * as fs from 'fs';
import * as path from 'path';
import { ANONYMOUS_TOOLS, isAnonymouslyPermitted } from '../mcp/server/anonymousTransport';
import { reviewSite, analyseHtml, REVIEW_SITE_MAX_BYTES } from '../mcp/server/reviewSiteTool';
import { AnonymousToolLimiter } from '../mcp/server/anonymousToolLimits';
import { HttpResponseLike } from '../utils/ssrfGuard';

const lookup = dns.lookup as unknown as jest.Mock;
const PAGE = '<html><head><title>Acme payroll for small teams</title><meta name="viewport" content="x"></head><body><h1>Payroll in 5 minutes</h1><a href="/s">Get started</a></body></html>';

function parse(result: any) {
  return JSON.parse(result.content[0].text);
}
const openLimiter = { check: () => ({ allowed: true }) };

function run(url: string, request: jest.Mock, limiter: any = openLimiter) {
  return reviewSite({ url }, '203.0.113.9', { fetchDeps: { request }, limiter }).then(parse);
}
const ok = (data = PAGE): HttpResponseLike => ({ status: 200, headers: { 'content-type': 'text/html' }, data: Buffer.from(data) });

beforeEach(() => {
  lookup.mockReset();
  lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
});

describe('AC1: private destinations refused after DNS resolution', () => {
  const classes: Array<[string, string, number]> = [
    ['loopback', '127.0.0.1', 4],
    ['rfc1918 10/8', '10.1.2.3', 4],
    ['rfc1918 172.16/12', '172.20.0.1', 4],
    ['rfc1918 192.168/16', '192.168.1.1', 4],
    ['link-local metadata', '169.254.169.254', 4],
    ['cgnat', '100.64.0.1', 4],
    ['ipv6 loopback', '::1', 6],
    ['ipv6 unique-local', 'fd00::1', 6],
  ];
  it.each(classes)('refuses a public-looking hostname that resolves to %s', async (_n, address, family) => {
    lookup.mockResolvedValue([{ address, family }]);
    const request = jest.fn();
    const out = await run('https://innocent.example.com/', request);
    expect(out.status).toBe('refused');
    expect(request).not.toHaveBeenCalled();
  });

  it('refuses a literal metadata IP without any DNS lookup or request', async () => {
    const request = jest.fn();
    const out = await run('http://169.254.169.254/latest/meta-data/', request);
    expect(out.status).toBe('refused');
    expect(request).not.toHaveBeenCalled();
  });
});

describe('AC2: every redirect hop re-validated', () => {
  it('refuses a public URL that 302s to 169.254.169.254', async () => {
    const request = jest.fn().mockResolvedValueOnce({ status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' }, data: Buffer.alloc(0) });
    const out = await run('https://public.example.com/', request);
    expect(out.status).toBe('refused');
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('refuses a redirect to a hostname that resolves private', async () => {
    lookup
      .mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }])
      .mockResolvedValueOnce([{ address: '10.0.0.5', family: 4 }]);
    const request = jest.fn().mockResolvedValueOnce({ status: 301, headers: { location: 'https://internal.example.com/' }, data: Buffer.alloc(0) });
    const out = await run('https://public.example.com/', request);
    expect(out.status).toBe('refused');
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('refuses a redirect onto a non-standard port', async () => {
    const request = jest.fn().mockResolvedValueOnce({ status: 302, headers: { location: 'https://public.example.com:8443/' }, data: Buffer.alloc(0) });
    const out = await run('https://public.example.com/', request);
    expect(out.status).toBe('refused');
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('follows a legitimate public redirect', async () => {
    const request = jest.fn()
      .mockResolvedValueOnce({ status: 301, headers: { location: 'https://www.example.com/' }, data: Buffer.alloc(0) })
      .mockResolvedValueOnce(ok());
    const out = await run('https://example.com/', request);
    expect(out.status).toBe('ok');
    expect(out.review.finalUrl).toBe('https://www.example.com/');
  });
});

describe('AC3: scheme, port, and body constraints', () => {
  it.each(['file:///etc/passwd', 'gopher://example.com/', 'ftp://example.com/', 'data:text/html,hi', 'https://example.com:22/'])(
    'refuses %s before any network activity',
    async url => {
      const request = jest.fn();
      const out = await run(url, request);
      expect(out.status).toBe('refused');
      expect(request).not.toHaveBeenCalled();
      expect(lookup).not.toHaveBeenCalled();
    }
  );

  it('passes a body cap to the transport and refuses an oversize body', async () => {
    const request = jest.fn().mockResolvedValue({ status: 200, headers: { 'content-type': 'text/html' }, data: Buffer.alloc(REVIEW_SITE_MAX_BYTES + 1) });
    const out = await run('https://example.com/', request);
    expect(request.mock.calls[0][3]).toBe(REVIEW_SITE_MAX_BYTES);
    expect(out.status).toBe('failed');
    expect(out.error).toMatch(/too large/i);
  });
});

describe('AC4/AC5: per-IP and global ceilings, refused loudly', () => {
  const envKeys = ['MCP_ANONYMOUS_PER_IP_LIMIT', 'MCP_ANONYMOUS_GLOBAL_DAILY_LIMIT'];
  afterEach(() => envKeys.forEach(k => delete process.env[k]));

  it('refuses an IP after N calls in the window, pointing at Connect, without fetching', async () => {
    process.env.MCP_ANONYMOUS_PER_IP_LIMIT = '2';
    const limiter = new AnonymousToolLimiter(() => Date.parse('2026-10-20T00:00:00Z'));
    const request = jest.fn().mockResolvedValue(ok());
    expect((await run('https://example.com/', request, limiter)).status).toBe('ok');
    expect((await run('https://example.com/', request, limiter)).status).toBe('ok');
    const third = await run('https://example.com/', request, limiter);
    expect(third.status).toBe('rate_limited');
    expect(third.scope).toBe('ip');
    expect(third.error).toMatch(/Connect/);
    expect(third.review).toBeUndefined();
    expect(request).toHaveBeenCalledTimes(2);
    expect(limiter.check('198.51.100.1').allowed).toBe(true);
  });

  it('refuses everyone once the daily budget is spent, and resets the next day', () => {
    process.env.MCP_ANONYMOUS_GLOBAL_DAILY_LIMIT = '3';
    let now = Date.parse('2026-10-20T10:00:00Z');
    const limiter = new AnonymousToolLimiter(() => now);
    ['a', 'b', 'c'].forEach(ip => expect(limiter.check(ip).allowed).toBe(true));
    const v = limiter.check('d') as any;
    expect(v.allowed).toBe(false);
    expect(v.scope).toBe('global');
    expect(v.message).toMatch(/Connect/);
    now = Date.parse('2026-10-21T00:00:01Z');
    expect(limiter.check('d').allowed).toBe(true);
  });

  it('a missing IP shares one fail-closed bucket', () => {
    process.env.MCP_ANONYMOUS_PER_IP_LIMIT = '1';
    const limiter = new AnonymousToolLimiter(() => 0);
    expect(limiter.check(undefined).allowed).toBe(true);
    expect(limiter.check('').allowed).toBe(false);
  });
});

describe('AC6: no user data', () => {
  it('the tool module imports nothing user-scoped', () => {
    const src = fs
      .readFileSync(path.join(__dirname, '../mcp/server/reviewSiteTool.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    const imports = Array.from(src.matchAll(/from\s+'([^']+)'/g)).map(m => m[1]);
    expect(imports.sort()).toEqual(['../../utils/ssrfGuard', './anonymousToolLimits', './registry', './toolHelpers'].sort());
    expect(src).not.toMatch(/mcpFetch|userDb|dynamo|knowledge|crm/i);
  });

  it('the registered handler ignores userId/session and reads only clientIp', async () => {
    const { mcpToolRegistry } = require('../mcp/server/registry');
    const handler = mcpToolRegistry.getTool('emma_review_site');
    expect(handler.requiresUserAccount).toBeFalsy();
    const ctx = new Proxy({ clientIp: '203.0.113.9' } as any, {
      get(t, k) {
        if (k !== 'clientIp' && k !== 'then') throw new Error(`handler read context.${String(k)}`);
        return t[k];
      },
    });
    const out = parse(await handler.execute({ url: 'ftp://x' }, ctx));
    expect(out.status).toBe('refused');
  });
});

describe('AC7: the anonymous allowlist has exactly one member', () => {
  it('is exactly emma_review_site', () => {
    expect(ANONYMOUS_TOOLS.size).toBe(1);
    expect([...ANONYMOUS_TOOLS]).toEqual(['emma_review_site']);
    expect(isAnonymouslyPermitted({ method: 'tools/call', params: { name: 'emma_review_site' } })).toBe(true);
    expect(isAnonymouslyPermitted([
      { method: 'tools/call', params: { name: 'emma_review_site' } },
      { method: 'tools/call', params: { name: 'send_email' } },
    ])).toBe(false);
  });
});

describe('analysis', () => {
  it('produces positioning, offer, and conversion findings from HTML', () => {
    const r = analyseHtml('<html><body><p>hi</p></body></html>', 'http://x.com/', 'http://x.com/');
    expect(r.positioning.length).toBeGreaterThan(0);
    expect(r.offerClarity.length).toBeGreaterThan(0);
    expect(r.conversionBlockers.join(' ')).toMatch(/call to action/);
    expect(r.conversionBlockers.join(' ')).toMatch(/HTTP/);
  });
});
