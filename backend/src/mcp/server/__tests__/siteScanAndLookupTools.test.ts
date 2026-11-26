/**
 * ENG-2840 (W2-9): scan_website_links (in-process, Emma's crawler with lower bounds and a guard) and find_or_lookup_email (one email to a
 * profile, through the portal's own quota-gated lookup route). No network: the crawler and the self-call are doubles.
 */
jest.mock('../httpClient', () => ({ mcpFetch: jest.fn() }));

import { mcpFetch } from '../httpClient';
import { mcpToolRegistry } from '../registry';
import { SITE_TOOL_GUARDS, SCAN_MAX_ANSWER_BYTES, SCAN_MAX_LINKS, SCAN_MAX_LIST_ENTRIES, SCAN_MAX_PAGES, SCAN_DEADLINE_MS, siteScanDeps } from '../siteScanAndLookupTools';

const mockFetch = mcpFetch as jest.Mock;
const ctxFor = (userId: string) => ({ userId, sessionId: 'sess-1', apiKeyId: 'key-1', externalMcp: true });
const call = (name: string, args: unknown, userId = 'user-1') => (mcpToolRegistry.getTool(name) as any).execute(args, ctxFor(userId));
const parse = (r: any) => JSON.parse(r.content[0].text);
const realCrawl = siteScanDeps.crawl;
const mockCrawl = jest.fn();

const scanResult = (over: Record<string, unknown> = {}) => ({
  success: true, startUrl: 'https://example.com/', crawlOrigin: 'https://example.com', pagesScanned: 3, linksChecked: 10,
  brokenLinkCount: 1, brokenLinks: [{ url: 'https://example.com/gone', kind: 'internal', status: 404, foundOn: ['https://example.com/'] }],
  unverifiableLinkCount: 0, unverifiableLinks: [], robotsSkipped: [], truncated: false, deadlineExceeded: false, ...over,
});

beforeEach(() => {
  mockFetch.mockReset();
  mockCrawl.mockReset();
  siteScanDeps.crawl = mockCrawl as any;
  Object.values(SITE_TOOL_GUARDS).forEach((g) => g.reset());
});
afterAll(() => { siteScanDeps.crawl = realCrawl; });

describe('scan_website_links', () => {
  it('crawls with the MCP bounds and a fixed deadline, and answers fixed fields', async () => {
    mockCrawl.mockResolvedValueOnce(scanResult());
    const out = parse(await call('scan_website_links', { url: 'https://example.com/' }));
    expect(mockCrawl).toHaveBeenCalledWith('https://example.com/', { maxPages: SCAN_MAX_PAGES, maxLinks: SCAN_MAX_LINKS, deadlineMs: SCAN_DEADLINE_MS });
    expect(Object.keys(out).sort()).toEqual(['broken_link_count', 'broken_links', 'deadline_exceeded', 'links_checked', 'lists_cut', 'pages_scanned', 'robots_skipped', 'start_url', 'success', 'truncated', 'unverifiable_link_count', 'unverifiable_links'].sort());
    expect(out.broken_links[0]).toEqual({ url: 'https://example.com/gone', kind: 'internal', status: 404, found_on: ['https://example.com/'] });
    mockCrawl.mockResolvedValueOnce(scanResult());
    await call('scan_website_links', { url: 'https://example.com/', max_pages: 5, max_links: 20 });
    expect(mockCrawl).toHaveBeenLastCalledWith('https://example.com/', { maxPages: 5, maxLinks: 20, deadlineMs: SCAN_DEADLINE_MS });
  });

  it('refuses bad URLs, caps above the MCP bounds and unknown arguments before any crawl', async () => {
    const bad: unknown[] = ['ftp://example.com/', 'https://example.com:8443/', 'https://user:pw@example.com/', 'not a url', ' https://example.com/', `https://example.com/${String.fromCharCode(0x202e)}`, 42, ''];
    for (const url of bad) await expect(call('scan_website_links', { url })).rejects.toThrow(/^scan_website_links: url/);
    await expect(call('scan_website_links', { url: 'https://example.com/', max_pages: SCAN_MAX_PAGES + 1 })).rejects.toThrow(/max_pages/);
    await expect(call('scan_website_links', { url: 'https://example.com/', max_links: 2000 })).rejects.toThrow(/max_links/);
    await expect(call('scan_website_links', { url: 'https://example.com/', max_pages: 1.5 })).rejects.toThrow(/max_pages/);
    await expect(call('scan_website_links', { url: 'https://example.com/', deadline_ms: 300000 })).rejects.toThrow(/"deadline_ms" is not an input/);
    expect(mockCrawl).not.toHaveBeenCalled();
  });

  it('cuts long lists but keeps the counts whole', async () => {
    const many = Array.from({ length: SCAN_MAX_LIST_ENTRIES + 20 }, (_, i) => ({ url: `https://x.com/${i}`, kind: 'outbound', error: 'ENOTFOUND', foundOn: Array(9).fill('https://example.com/') }));
    mockCrawl.mockResolvedValueOnce(scanResult({ brokenLinks: many, brokenLinkCount: many.length, truncated: true }));
    const out = parse(await call('scan_website_links', { url: 'https://example.com/' }));
    expect(out.broken_links).toHaveLength(SCAN_MAX_LIST_ENTRIES);
    expect(out.broken_link_count).toBe(many.length);
    expect(out.broken_links[0].found_on).toHaveLength(5);
    expect(out.lists_cut).toBe(true);
    expect(out.truncated).toBe(true);
  });

  it('cuts the lists further until the answer fits its byte ceiling, and says so', async () => {
    const longUrl = (i: number) => `https://example.com/${'x'.repeat(1900)}/${i}`;
    const many = Array.from({ length: SCAN_MAX_LIST_ENTRIES }, (_, i) => ({ url: longUrl(i), kind: 'internal', status: 404, foundOn: Array(5).fill(longUrl(0)) }));
    mockCrawl.mockResolvedValueOnce(scanResult({ brokenLinks: many, brokenLinkCount: many.length }));
    const r = await call('scan_website_links', { url: 'https://example.com/' });
    expect(Buffer.byteLength(r.content[0].text)).toBeLessThanOrEqual(SCAN_MAX_ANSWER_BYTES + 1000);
    const out = JSON.parse(r.content[0].text);
    expect(out.broken_links.length).toBeGreaterThan(0);
    expect(out.broken_links.length).toBeLessThan(SCAN_MAX_LIST_ENTRIES);
    expect(out.broken_link_count).toBe(SCAN_MAX_LIST_ENTRIES);
    expect(out.lists_cut).toBe(true);
  });

  it('one scan at a time per caller, ten an hour, and the slot is freed after a failure', async () => {
    let release: (v: unknown) => void = () => {};
    mockCrawl.mockImplementationOnce(() => new Promise((r) => { release = r; }));
    const first = call('scan_website_links', { url: 'https://example.com/' });
    await expect(call('scan_website_links', { url: 'https://example.com/' })).rejects.toThrow(/still running/);
    release(scanResult());
    await first;
    mockCrawl.mockRejectedValueOnce(new Error('socket hang up at 10.0.0.1:443 internal'));
    await expect(call('scan_website_links', { url: 'https://example.com/' })).rejects.toThrow(/^scan_website_links: the site could not be scanned\. Try again later\.$/);
    mockCrawl.mockRejectedValueOnce(new Error('Unsupported URL protocol: ftp:'));
    await expect(call('scan_website_links', { url: 'https://example.com/' })).rejects.toThrow(/could not be scanned: Unsupported URL protocol/);
    mockCrawl.mockResolvedValue(scanResult());
    for (let i = 0; i < 7; i++) await call('scan_website_links', { url: 'https://example.com/' });
    await expect(call('scan_website_links', { url: 'https://example.com/' })).rejects.toThrow(/10 calls to this tool in the last hour/);
    await expect(call('scan_website_links', { url: 'https://example.com/' }, 'user-2')).resolves.toBeDefined();
  });
});

describe('find_or_lookup_email', () => {
  it('sends one lower-cased email to the portal\'s quota-gated route and answers fixed fields', async () => {
    mockFetch.mockResolvedValueOnce({ found: true, fromCache: false, checkedAt: '2026-11-26T00:00:00Z', draft: {
      email: 'alice@acme.com', firstName: 'Alice', lastName: 'Smith', company: 'Acme', title: 'CEO', linkedin: 'https://linkedin.com/in/a',
      location: 'NYC', headline: 'h', internalScore: 9 } });
    const out = parse(await call('find_or_lookup_email', { email: 'Alice@Acme.com' }));
    expect(mockFetch).toHaveBeenCalledWith(expect.objectContaining({ method: 'POST', path: '/api/crm/leads/lookup-by-email', body: { email: 'alice@acme.com' } }));
    expect(out).toEqual({ found: true, email: 'alice@acme.com', first_name: 'Alice', last_name: 'Smith', company: 'Acme', title: 'CEO',
      linkedin: 'https://linkedin.com/in/a', location: 'NYC', headline: 'h', from_cache: false, checked_at: '2026-11-26T00:00:00Z' });
    mockFetch.mockResolvedValueOnce({ found: false, draft: null });
    expect(parse(await call('find_or_lookup_email', { email: 'bob@acme.com' }))).toEqual({ found: false, email: 'bob@acme.com' });
  });

  it('refuses Emma\'s other paths (lead ids, names, LinkedIn, bulk) and anything that is not one address, before any call', async () => {
    for (const args of [{ leadId: 'L1', listId: 'x' }, { linkedin_url: 'https://linkedin.com/in/a' }, { name: 'A', company: 'B' }, { bulk: [{ email: 'a@b.com' }] }, { email: 'a@b.com', leadId: 'L1' }]) {
      await expect(call('find_or_lookup_email', args)).rejects.toThrow(/is not an input|are not inputs|email is required/);
    }
    for (const email of ['not-an-email', 'a@b', 'a b@c.com', 'a@b.com,c@d.com', ' a@b.com', 'a@b.com\n', `${'x'.repeat(250)}@b.com`, 7]) {
      await expect(call('find_or_lookup_email', { email })).rejects.toThrow(/^find_or_lookup_email: email/);
    }
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('passes a 4xx (the daily quota) through and turns a 5xx or an unreachable route into a fixed text', async () => {
    mockFetch.mockRejectedValueOnce(new Error('API error (429): {"message":"Daily email lookup limit reached"}'));
    await expect(call('find_or_lookup_email', { email: 'a@b.com' })).rejects.toThrow(/429/);
    mockFetch.mockRejectedValueOnce(new Error('API error (500): stack at /srv/app'));
    await expect(call('find_or_lookup_email', { email: 'a@b.com' })).rejects.toThrow(/^find_or_lookup_email: the lookup service could not answer \(HTTP 500\)\. Try again later\.$/);
    mockFetch.mockRejectedValueOnce(new Error('connect ECONNREFUSED 127.0.0.1:3001'));
    await expect(call('find_or_lookup_email', { email: 'a@b.com' })).rejects.toThrow(/could not be reached or did not answer in time/);
  });
});
