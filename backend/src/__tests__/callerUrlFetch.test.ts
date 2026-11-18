/**
 * The one place agent tools fetch a URL a caller chose (utils/callerUrlFetch.ts). No real network or DNS: the resolver and the
 * transport are injected, and literal IP addresses are judged by the real resolver (it never does DNS for a literal IP).
 */
import { lookup as dnsLookup } from 'dns/promises';
import {
  CALLER_URL_BLOCKED_MESSAGE,
  CALLER_URL_MAX_TEXT_BYTES,
  CALLER_URL_TIMEOUT_MS,
  CallerUrlBlockedError,
  CallerUrlTooLargeError,
  fetchCallerUrlBuffer,
  fetchCallerUrlText,
} from '../utils/callerUrlFetch';
import { SsrfBlockedError, resolvePinnedPublicAddress } from '../utils/ssrfGuard';

// No test here may need a DNS lookup: addresses (IPv4 and IPv6 literals) and reserved names are judged without one, and names are stubbed
// below. A lookup would fail this suite (see the afterEach), so a literal can never pass because "its name did not resolve".
jest.mock('dns/promises', () => ({ lookup: jest.fn(async () => { throw new Error('DNS lookup attempted'); }) }));

const PUBLIC = { hostname: 'example.com', address: '93.184.216.34', family: 4 };

/**
 * Only example.com, its subdomains and our S3 bucket host resolve (to a public address). Everything else, literal IPs and `localhost`
 * included, goes through the real resolver, which refuses those without any DNS lookup. No test here may reach a name the real resolver
 * would have to look up (the `dns/promises` mock above fails the suite if one does).
 */
const STUB_PUBLIC_HOSTS = (host: string) => host === 'example.com' || host.endsWith('.example.com') || host.endsWith('.amazonaws.com');
const resolver = async (url: string) => {
  const host = new URL(url).hostname;
  return STUB_PUBLIC_HOSTS(host) ? PUBLIC : resolvePinnedPublicAddress(url);
};

const ok = (body: string, headers: Record<string, string> = { 'content-type': 'text/csv; charset=utf-8' }) => ({
  status: 200,
  headers,
  data: Buffer.from(body),
});

const opts = (request: jest.Mock, extra: Record<string, unknown> = {}) => ({
  tool: 'test_tool',
  userId: 'user-1',
  maxBytes: 1024,
  deps: { resolvePinned: resolver, request },
  ...extra,
});

describe('fetchCallerUrlBuffer / fetchCallerUrlText', () => {
  let warn: jest.SpyInstance;
  beforeEach(() => {
    (dnsLookup as unknown as jest.Mock).mockClear();
    warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    warn.mockRestore();
    expect(dnsLookup).not.toHaveBeenCalled();
  });

  describe('what still works', () => {
    it('returns the body, the content type without parameters and the final URL for a public https URL', async () => {
      const request = jest.fn().mockResolvedValue(ok('a,b\n1,2'));
      const r = await fetchCallerUrlBuffer('https://example.com/data.csv', opts(request));
      expect(r.buffer.toString()).toBe('a,b\n1,2');
      expect(r.contentType).toBe('text/csv');
      expect(r.finalUrl).toBe('https://example.com/data.csv');
      expect(warn).not.toHaveBeenCalled();
    });

    it('plain http to a public host is fetched too (as before)', async () => {
      const request = jest.fn().mockResolvedValue(ok('hello'));
      await expect(fetchCallerUrlText('http://example.com/x.txt', opts(request))).resolves.toBe('hello');
    });

    it('a public URL that redirects to another public URL is followed', async () => {
      const request = jest
        .fn()
        .mockResolvedValueOnce({ status: 302, headers: { location: 'https://cdn.example.com/real.html' }, data: Buffer.alloc(0) })
        .mockResolvedValueOnce(ok('<p>hi</p>', { 'content-type': 'text/html' }));
      await expect(fetchCallerUrlText('https://example.com/short', opts(request))).resolves.toBe('<p>hi</p>');
      expect(request).toHaveBeenCalledTimes(2);
    });

    it('one of our own bucket URLs takes the same guarded fetch, with no extra ownership step (a plain GET uses no server privilege)', async () => {
      const request = jest.fn().mockResolvedValue(ok('mine'));
      const url = 'https://agentweb-user-files.s3.us-west-2.amazonaws.com/users/u1/files/1/a/f.csv';
      await expect(fetchCallerUrlText(url, opts(request))).resolves.toBe('mine');
      expect(request).toHaveBeenCalledTimes(1);
    });

    it('passes the size cap and a default total time down to the transport', async () => {
      const request = jest.fn().mockResolvedValue(ok('x'));
      await fetchCallerUrlBuffer('https://example.com/x', opts(request, { maxBytes: 777 }));
      const [, , timeoutMs, maxBytes] = request.mock.calls[0];
      expect(maxBytes).toBe(777);
      expect(timeoutMs).toBeLessThanOrEqual(CALLER_URL_TIMEOUT_MS);
      expect(timeoutMs).toBeGreaterThan(CALLER_URL_TIMEOUT_MS - 5000);
    });

    it('a caller-chosen total time is what the transport gets', async () => {
      const request = jest.fn().mockResolvedValue(ok('x'));
      await fetchCallerUrlBuffer('https://example.com/x', opts(request, { timeoutMs: 5000 }));
      const timeoutMs = request.mock.calls[0][2];
      expect(timeoutMs).toBeLessThanOrEqual(5000);
      expect(timeoutMs).toBeGreaterThan(4000);
    });

    it('the default text cap is 20 MB and the default time 30 s (the HTML sites use these)', () => {
      expect(CALLER_URL_MAX_TEXT_BYTES).toBe(20 * 1024 * 1024);
      expect(CALLER_URL_TIMEOUT_MS).toBe(30_000);
    });

    it('a 404 is rethrown unchanged, so a tool can still tell a dead link from a blocked one', async () => {
      const request = jest.fn().mockResolvedValue({ status: 404, headers: {}, data: Buffer.alloc(0) });
      const err: any = await fetchCallerUrlBuffer('https://example.com/gone', opts(request)).catch((e) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(CallerUrlBlockedError);
      expect(err.message).toMatch(/status code 404/);
    });

    it('a transport failure is rethrown unchanged (not reported as a block)', async () => {
      const boom = Object.assign(new Error('timeout of 30000ms exceeded'), { code: 'ECONNABORTED' });
      const request = jest.fn().mockRejectedValue(boom);
      await expect(fetchCallerUrlBuffer('https://example.com/slow', opts(request))).rejects.toBe(boom);
    });
  });

  describe('what is refused (one generic error, nothing fetched)', () => {
    // Literal addresses are judged by the real resolver, so none of these reaches DNS or the network.
    it.each([
      ['loopback', 'http://127.0.0.1/admin'],
      ['loopback name', 'http://localhost/admin'],
      ['cloud metadata address', 'http://169.254.169.254/latest/meta-data/iam/security-credentials/'],
      ['private 10/8', 'http://10.0.0.5/'],
      ['private 192.168/16', 'https://192.168.1.1/'],
      ['IPv6 loopback', 'http://[::1]/'],
      ['decimal-encoded loopback (127.0.0.1)', 'http://2130706433/'],
      ['hex-encoded loopback (127.0.0.1)', 'http://0x7f000001/'],
      ['IPv4-mapped IPv6 loopback', 'http://[::ffff:127.0.0.1]/'],
    ])('%s is refused before any request is made', async (_label, url) => {
      const request = jest.fn();
      const err: any = await fetchCallerUrlBuffer(url, opts(request)).catch((e) => e);
      expect(err).toBeInstanceOf(CallerUrlBlockedError);
      expect(request).not.toHaveBeenCalled();
    });

    // IPv6 literals are judged by range (URL.hostname keeps the brackets and the guard strips them), never by a failed name lookup.
    it.each([
      ['unspecified ::', 'http://[::]/'],
      ['IPv4-mapped loopback, hex form', 'http://[::ffff:7f00:1]/'],
      ['IPv4-compatible loopback', 'http://[::127.0.0.1]/'],
      ['AWS IPv6 metadata address', 'http://[fd00:ec2::254]/latest/meta-data/'],
      ['a unique-local address', 'https://[fc00::1]/'],
      ['a link-local address', 'http://[fe80::1]/'],
      ['a multicast address', 'http://[ff02::1]/'],
      ['NAT64 of the metadata address', 'http://[64:ff9b::a9fe:a9fe]/'],
      ['NAT64 of loopback', 'http://[64:ff9b::7f00:1]/'],
      ['6to4 of loopback', 'http://[2002:7f00:1::]/'],
    ])('IPv6: %s is refused, judged by range with no name lookup', async (_label, url) => {
      const request = jest.fn();
      await expect(fetchCallerUrlBuffer(url, opts(request))).rejects.toBeInstanceOf(CallerUrlBlockedError);
      expect(request).not.toHaveBeenCalled();
    });

    it.each([
      ['a public IPv6 literal', 'https://[2606:4700:4700::1111]/x', '2606:4700:4700::1111'],
      ['NAT64 of a public IPv4 address', 'https://[64:ff9b::808:808]/x', '64:ff9b::808:808'],
    ])('IPv6: %s is fetched, pinned to the address as written', async (_label, url, address) => {
      const request = jest.fn().mockResolvedValue(ok('v6'));
      await expect(fetchCallerUrlText(url, opts(request))).resolves.toBe('v6');
      expect(request.mock.calls[0][1]).toMatchObject({ address, family: 6 });
    });

    it.each([
      ['file', 'file:///etc/passwd'],
      ['ftp', 'ftp://example.com/x'],
      ['gopher', 'gopher://example.com/_x'],
      ['data', 'data:text/plain;base64,aGk='],
      ['javascript', 'javascript:alert(1)'],
      ['not a URL', 'not a url'],
    ])('only http(s) is fetched: %s', async (_label, url) => {
      const request = jest.fn();
      await expect(fetchCallerUrlBuffer(url, opts(request))).rejects.toBeInstanceOf(CallerUrlBlockedError);
      expect(request).not.toHaveBeenCalled();
    });

    it('a public URL that redirects to the metadata address is refused on the second hop', async () => {
      const request = jest
        .fn()
        .mockResolvedValueOnce({ status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' }, data: Buffer.alloc(0) });
      await expect(fetchCallerUrlBuffer('https://example.com/r', opts(request))).rejects.toBeInstanceOf(CallerUrlBlockedError);
      expect(request).toHaveBeenCalledTimes(1); // the second hop is refused before it is requested
    });

    it('a public URL that redirects to a relative private-looking path on a public host is still just followed', async () => {
      const request = jest
        .fn()
        .mockResolvedValueOnce({ status: 301, headers: { location: '/internal/admin' }, data: Buffer.alloc(0) })
        .mockResolvedValueOnce(ok('page'));
      await expect(fetchCallerUrlText('https://example.com/a', opts(request))).resolves.toBe('page');
    });

    it('more than 5 redirect hops end the fetch (an ordinary error, not a refusal), after exactly 6 requests', async () => {
      const request = jest.fn().mockImplementation(async (u: string) => ({ status: 302, headers: { location: `${u}x` }, data: Buffer.alloc(0) }));
      const err: any = await fetchCallerUrlBuffer('https://example.com/r', opts(request)).catch((e) => e);
      expect(err).not.toBeInstanceOf(CallerUrlBlockedError);
      expect(err.message).toMatch(/Too many redirects/);
      expect(request).toHaveBeenCalledTimes(6);
    });

    it.each([['file:///etc/passwd'], ['ftp://example.com/x'], ['gopher://example.com/_x']])(
      'a public URL that redirects to %s gets the same generic refusal as any other blocked URL',
      async (location) => {
        const request = jest.fn().mockResolvedValueOnce({ status: 302, headers: { location }, data: Buffer.alloc(0) });
        const err: any = await fetchCallerUrlBuffer('https://example.com/r', opts(request)).catch((e) => e);
        expect(err).toBeInstanceOf(CallerUrlBlockedError);
        expect(err.message).toBe(CALLER_URL_BLOCKED_MESSAGE);
        expect(JSON.stringify(err.message)).not.toMatch(/file|ftp|gopher|redirect/i);
        expect(request).toHaveBeenCalledTimes(1);
      },
    );

    it('a redirect to a host that does not resolve is refused generically after the first hop', async () => {
      const request = jest.fn().mockResolvedValueOnce({ status: 302, headers: { location: 'https://gone.invalid/x' }, data: Buffer.alloc(0) });
      const resolvePinned = jest.fn(async (u: string) => {
        if (u.includes('gone.invalid')) throw new SsrfBlockedError('DNS lookup failed: getaddrinfo ENOTFOUND gone.invalid');
        return PUBLIC;
      });
      const err: any = await fetchCallerUrlBuffer('https://example.com/r', { tool: 't', maxBytes: 10, deps: { resolvePinned, request } }).catch((e) => e);
      expect(err).toBeInstanceOf(CallerUrlBlockedError);
      expect(err.message).toBe(CALLER_URL_BLOCKED_MESSAGE);
      expect(request).toHaveBeenCalledTimes(1);
    });

    it('a host that does not resolve and a host that resolves to a private address give the SAME error text (no network map)', async () => {
      const noDns = jest.fn();
      const a: any = await fetchCallerUrlBuffer('https://no-such-host.invalid/x', {
        tool: 't',
        maxBytes: 10,
        deps: {
          resolvePinned: async () => {
            throw new SsrfBlockedError('DNS lookup failed: getaddrinfo ENOTFOUND no-such-host.invalid');
          },
          request: noDns,
        },
      }).catch((e) => e);
      const b: any = await fetchCallerUrlBuffer('http://10.1.2.3/x', opts(noDns)).catch((e) => e);
      expect(a).toBeInstanceOf(CallerUrlBlockedError);
      expect(b).toBeInstanceOf(CallerUrlBlockedError);
      expect(a.message).toBe(CALLER_URL_BLOCKED_MESSAGE);
      expect(b.message).toBe(a.message);
      expect(noDns).not.toHaveBeenCalled();
    });

    it('the refusal carries no address, no DNS text, no cause and no extra fields', async () => {
      const err: any = await fetchCallerUrlBuffer('http://169.254.169.254/latest/meta-data/', opts(jest.fn())).catch((e) => e);
      const everything = JSON.stringify({ message: err.message, name: err.name, own: Object.getOwnPropertyNames(err), cause: err.cause });
      expect(everything).not.toMatch(/169\.254|private|internal|resolve|DNS|ENOTFOUND|meta-data/i);
      expect(err.cause).toBeUndefined();
      expect((err as any).error).toBeUndefined();
    });

    it('logs the caller and the host only: never the path, the query or a token', async () => {
      await fetchCallerUrlBuffer('http://169.254.169.254/latest/meta-data/?token=SECRET123', opts(jest.fn())).catch(() => undefined);
      expect(warn).toHaveBeenCalledTimes(1);
      const line = JSON.parse(warn.mock.calls[0][0]);
      expect(line).toEqual({ event: 'caller_url_blocked', tool: 'test_tool', userId: 'user-1', host: '169.254.169.254' });
      expect(warn.mock.calls[0][0]).not.toMatch(/SECRET123|meta-data/);
    });

    it('a missing caller is logged as null, and an unparsable URL logs a fixed host label (nothing from the input)', async () => {
      await fetchCallerUrlBuffer('::::not a url SECRET', { tool: 't', maxBytes: 10, deps: { request: jest.fn() } }).catch(() => undefined);
      const line = JSON.parse(warn.mock.calls[0][0]);
      expect(line).toEqual({ event: 'caller_url_blocked', tool: 't', userId: null, host: 'invalid' });
      expect(warn.mock.calls[0][0]).not.toMatch(/SECRET/);
    });
  });

  describe('size', () => {
    it('a body over the cap is refused with the limit named', async () => {
      const request = jest.fn().mockResolvedValue(ok('x'.repeat(2000)));
      const err: any = await fetchCallerUrlBuffer('https://example.com/big', opts(request, { maxBytes: 1000 })).catch((e) => e);
      expect(err).toBeInstanceOf(CallerUrlTooLargeError);
      expect(err.maxBytes).toBe(1000);
      expect(err.message).toContain('1000');
    });

    it('a declared Content-Length over the cap is refused', async () => {
      const request = jest.fn().mockResolvedValue({ status: 200, headers: { 'content-length': '999999' }, data: Buffer.from('x') });
      await expect(fetchCallerUrlBuffer('https://example.com/big', opts(request, { maxBytes: 1000 }))).rejects.toBeInstanceOf(CallerUrlTooLargeError);
    });

    it('the real transport signals an over-cap body with an axios maxContentLength error: also reported as too large', async () => {
      const axiosErr = Object.assign(new Error('maxContentLength size of 1000 exceeded'), { code: 'ERR_BAD_RESPONSE' });
      const request = jest.fn().mockRejectedValue(axiosErr);
      await expect(fetchCallerUrlBuffer('https://example.com/big', opts(request, { maxBytes: 1000 }))).rejects.toBeInstanceOf(CallerUrlTooLargeError);
    });

    it('a body exactly at the cap is accepted', async () => {
      const request = jest.fn().mockResolvedValue(ok('x'.repeat(1000)));
      const r = await fetchCallerUrlBuffer('https://example.com/edge', opts(request, { maxBytes: 1000 }));
      expect(r.buffer.length).toBe(1000);
    });
  });

  it('fetchCallerUrlText decodes UTF-8', async () => {
    const request = jest.fn().mockResolvedValue({ status: 200, headers: {}, data: Buffer.from('héllo — ✓', 'utf8') });
    await expect(fetchCallerUrlText('https://example.com/u', opts(request))).resolves.toBe('héllo — ✓');
  });
});
