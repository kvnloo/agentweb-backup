import { SsrfBlockedError } from '../utils/ssrfGuard';
import { crawlWebsiteLinks, SiteLinkCrawlerDeps } from '../services/siteLinkCrawlerService';

type Reply = { status: number; headers?: Record<string, string>; data?: string } | Error;

function fakeDeps(routes: Record<string, Reply>) {
  const calls: string[] = [];
  const deps: SiteLinkCrawlerDeps = {
    resolvePinned: async (url) => {
      if (/127\.0\.0\.1|169\.254\.169\.254/.test(url)) throw new SsrfBlockedError();
      return { hostname: new URL(url).hostname, address: '93.184.216.34', family: 4 };
    },
    request: async (url, _pinned, method) => {
      calls.push(`${method} ${url}`);
      const reply = routes[`${method} ${url}`] ?? routes[`* ${url}`];
      if (!reply) throw new Error(`No fixture for ${method} ${url}`);
      if (reply instanceof Error) throw reply;
      return { status: reply.status, headers: reply.headers ?? {}, data: reply.data ?? '' };
    },
    sleep: async () => { calls.push('SLEEP'); },
  };
  return { deps, calls };
}

describe('siteLinkCrawlerService', () => {
  it('crawls the same-origin graph and checks outbound links with HEAD then GET fallback', async () => {
    const { deps, calls } = fakeDeps({
      'GET https://site.test/robots.txt': { status: 404 },
      'GET https://site.test/': {
        status: 200,
        headers: { 'content-type': 'text/html' },
        data: '<a href="/missing">Missing</a><a href="/about">About</a><a href="https://outside.test/good">Good</a>',
      },
      'GET https://site.test/about': {
        status: 200,
        headers: { 'content-type': 'text/html' },
        data: '<a href="/">Home</a><a href="/missing">Missing again</a><a href="https://outside.test/dead">Dead</a>',
      },
      'GET https://site.test/missing': { status: 404 },
      'HEAD https://outside.test/good': { status: 204 },
      'HEAD https://outside.test/dead': { status: 500 },
      'GET https://outside.test/dead': { status: 410 },
    });

    const result = await crawlWebsiteLinks('https://site.test/', { requestDelayMs: 0 }, deps);

    expect(result).toMatchObject({ success: true, pagesScanned: 3, linksChecked: 4, brokenLinkCount: 2, truncated: false });
    expect(result.brokenLinks).toEqual(expect.arrayContaining([
      expect.objectContaining({ url: 'https://site.test/missing', kind: 'internal', status: 404 }),
      expect.objectContaining({ url: 'https://outside.test/dead', kind: 'outbound', status: 410 }),
    ]));
    expect(calls).toEqual(expect.arrayContaining([
      'HEAD https://outside.test/dead',
      'GET https://outside.test/dead',
    ]));
    expect(result.brokenLinks.find((link) => link.url.endsWith('/missing'))?.foundOn).toHaveLength(2);
  });

  it('fails closed on private seeds and private redirect hops, and never GET-crawls off-origin pages', async () => {
    const privateSeed = fakeDeps({});
    await expect(crawlWebsiteLinks('http://127.0.0.1/', {}, privateSeed.deps)).rejects.toThrow(/private|internal/i);

    const redirected = fakeDeps({
      'GET https://site.test/robots.txt': { status: 404 },
      'GET https://site.test/': { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data' } },
    });
    await expect(crawlWebsiteLinks('https://site.test/', {}, redirected.deps)).rejects.toThrow(/private|internal/i);

    const outbound = fakeDeps({
      'GET https://site.test/robots.txt': { status: 404 },
      'GET https://site.test/': { status: 200, headers: { 'content-type': 'text/html' }, data: '<a href="https://other.test/page">Other</a>' },
      'HEAD https://other.test/page': { status: 200 },
    });
    await crawlWebsiteLinks('https://site.test/', {}, outbound.deps);
    expect(outbound.calls).toContain('HEAD https://other.test/page');
    expect(outbound.calls).not.toContain('GET https://other.test/page');

    const offsiteRedirect = fakeDeps({
      'GET https://site.test/robots.txt': { status: 404 },
      'GET https://site.test/': { status: 302, headers: { location: 'https://other.test/page' } },
    });
    const stopped = await crawlWebsiteLinks('https://site.test/', {}, offsiteRedirect.deps);
    expect(stopped.unverifiableLinkCount).toBe(1);
    expect(offsiteRedirect.calls).not.toContain('GET https://other.test/page');
  });

  it('honors robots longest-match rules and reports skipped pages', async () => {
    const { deps, calls } = fakeDeps({
      'GET https://site.test/robots.txt': {
        status: 200,
        data: 'User-agent: *\nDisallow: /private/*\nAllow: /private/public$\n',
      },
      'GET https://www.site.test/robots.txt': { status: 503 },
      'GET https://site.test/': {
        status: 200,
        headers: { 'content-type': 'text/html' },
        data: '<a href="/private/secret">No</a><a href="/private/public">Yes</a><a href="/private/public/child">No child</a><a href="https://www.site.test/a">A</a><a href="https://www.site.test/b">B</a>',
      },
      'GET https://site.test/private/public': { status: 200, headers: { 'content-type': 'application/json' }, data: '<a href="/must-not-crawl">No</a>' },
    });

    const result = await crawlWebsiteLinks('https://site.test/', { requestDelayMs: 0 }, deps);
    expect(result.robotsSkipped).toEqual(expect.arrayContaining(['https://site.test/private/secret', 'https://site.test/private/public/child', 'https://www.site.test/a', 'https://www.site.test/b']));
    expect(calls).not.toContain('GET https://site.test/private/secret');
    expect(calls).not.toContain('GET https://www.site.test/b');
    expect(calls).not.toContain('GET https://site.test/must-not-crawl');
    expect(calls).toContain('GET https://site.test/private/public');
  });

  it('deduplicates cycles and reports a loud max-pages truncation', async () => {
    const { deps, calls } = fakeDeps({
      'GET https://site.test/robots.txt': { status: 404 },
      'GET https://site.test/': { status: 200, headers: { 'content-type': 'text/html' }, data: '<a href="/a">A</a>' },
      'GET https://site.test/a': { status: 200, headers: { 'content-type': 'text/html' }, data: '<a href="/">Home</a><a href="/b">B</a>' },
    });

    const result = await crawlWebsiteLinks('https://site.test/', { maxPages: 2, requestDelayMs: 0 }, deps);
    expect(result).toMatchObject({ pagesScanned: 2, truncated: true });
    expect(calls.filter((call) => call === 'GET https://site.test/')).toHaveLength(1);
    expect(calls).not.toContain('GET https://site.test/b');
  });

  it('adopts only apex/www redirects and checks destination robots before its page', async () => {
    const { deps, calls } = fakeDeps({
      'GET https://site.test/robots.txt': { status: 404 },
      'GET https://site.test/': { status: 301, headers: { location: 'https://www.site.test/home' } },
      'GET https://www.site.test/robots.txt': { status: 404 },
      'GET https://www.site.test/home': { status: 200, headers: { 'content-type': 'text/html' }, data: '<a href="https://site.test/a">A</a>' },
      'GET https://site.test/a': { status: 200, headers: { 'content-type': 'text/html' }, data: '' },
    });
    const result = await crawlWebsiteLinks('https://site.test/', { requestDelayMs: 1 }, deps);
    expect(result).toMatchObject({ crawlOrigin: 'https://www.site.test', pagesScanned: 2 });
    expect(calls.indexOf('GET https://www.site.test/robots.txt')).toBeLessThan(calls.indexOf('GET https://www.site.test/home'));
    expect(calls.filter((call) => call === 'SLEEP')).toHaveLength(calls.filter((call) => call.startsWith('GET ') || call.startsWith('HEAD ')).length);
  });

  it('rejects unsafe URLs and separates terminal DNS from transient failures', async () => {
    await expect(crawlWebsiteLinks('https://user:pass@site.test/')).rejects.toThrow(/credentials/);
    await expect(crawlWebsiteLinks('https://site.test:8443/')).rejects.toThrow(/port/);
    const deadSeed = fakeDeps({});
    deadSeed.deps.resolvePinned = async () => { throw new SsrfBlockedError('DNS lookup failed: ENOTFOUND'); };
    expect(await crawlWebsiteLinks('https://gone.test/', {}, deadSeed.deps)).toMatchObject({ brokenLinkCount: 1, pagesScanned: 0 });
    const { deps, calls } = fakeDeps({
      'GET https://site.test/robots.txt': { status: 404 },
      'GET https://site.test/': { status: 200, headers: { 'content-type': 'text/html' }, data: '<a href="https://gone.test/">Gone</a><a href="https://busy.test/">Busy</a>' },
      'HEAD https://gone.test/': new Error('DNS lookup failed: ENOTFOUND'),
      'HEAD https://busy.test/': new Error('socket hang up'),
      'GET https://busy.test/': { status: 503 },
    });
    const result = await crawlWebsiteLinks('https://site.test/', { requestDelayMs: 0 }, deps);
    expect(result.brokenLinks).toEqual([expect.objectContaining({ url: 'https://gone.test/', kind: 'outbound' })]);
    expect(result.unverifiableLinks).toEqual([expect.objectContaining({ url: 'https://busy.test/', status: 503 })]);
    expect(calls).toContain('GET https://busy.test/');
    expect(calls).not.toContain('GET https://gone.test/');
  });

  it('stops loudly at the whole-scan deadline', async () => {
    let clock = 0;
    const fixture = fakeDeps({
      'GET https://site.test/robots.txt': { status: 404 },
      'GET https://site.test/': { status: 200, headers: { 'content-type': 'text/html' }, data: '<a href="/next">Next</a>' },
    });
    const request = fixture.deps.request!;
    fixture.deps.now = () => clock;
    fixture.deps.request = async (...args) => { const reply = await request(...args); clock += 6; return reply; };
    const result = await crawlWebsiteLinks('https://site.test/', { deadlineMs: 10, requestDelayMs: 0 }, fixture.deps);
    expect(result).toMatchObject({ success: false, truncated: true, deadlineExceeded: true, pagesScanned: 1 });
    const hung = fakeDeps({});
    hung.deps.resolvePinned = async () => new Promise<never>(() => undefined);
    expect(await crawlWebsiteLinks('https://site.test/', { deadlineMs: 1 }, hung.deps)).toMatchObject({ deadlineExceeded: true, truncated: true });
    const hungRequest = fakeDeps({});
    hungRequest.deps.request = async () => new Promise<never>(() => undefined);
    expect(await crawlWebsiteLinks('https://site.test/', { deadlineMs: 1, requestDelayMs: 0 }, hungRequest.deps)).toMatchObject({ deadlineExceeded: true, truncated: true });
  });

  it('caps URL, response body, and unique-link output', async () => {
    await expect(crawlWebsiteLinks(`https://site.test/${'x'.repeat(2_100)}`)).rejects.toThrow(/maximum length/);
    const oversized = fakeDeps({
      'GET https://site.test/robots.txt': { status: 404 },
      'GET https://site.test/': { status: 200, headers: { 'content-type': 'text/html' }, data: 'x'.repeat(1_000_001) },
    });
    expect(await crawlWebsiteLinks('https://site.test/', {}, oversized.deps)).toMatchObject({ truncated: true, unverifiableLinkCount: 1 });
    const capped = fakeDeps({
      'GET https://site.test/robots.txt': { status: 404 },
      'GET https://site.test/': { status: 200, headers: { 'content-type': 'text/html' }, data: '<a href="/a">A</a><a href="/b">B</a>' },
      'GET https://site.test/a': { status: 200, headers: { 'content-type': 'text/html' }, data: '' },
    });
    expect(await crawlWebsiteLinks('https://site.test/', { maxLinks: 1, requestDelayMs: 0 }, capped.deps)).toMatchObject({ truncated: true, pagesScanned: 2 });
  });
});
