// ENG-351 Phase 1 — citation registry built from Emma's search tool calls.
import { buildCitationRegistry, domainFromUrl, prettySiteName } from '../utils/citations';

const searchCall = (results: any[]) => ({
  name: 'search_tool_response',
  result: { success: true, query: 'q', results },
});

describe('domainFromUrl', () => {
  it('strips protocol and leading www', () => {
    expect(domainFromUrl('https://www.grandviewresearch.com/report/x')).toBe('grandviewresearch.com');
    expect(domainFromUrl('http://Statista.com/data')).toBe('statista.com');
  });
  it('returns empty string for unparseable input', () => {
    expect(domainFromUrl('not a url')).toBe('');
  });
});

describe('prettySiteName', () => {
  it('drops the TLD and title-cases the label', () => {
    expect(prettySiteName('grandviewresearch.com')).toBe('Grandviewresearch');
    expect(prettySiteName('search-console.google.com')).toBe('Search Console Google');
  });
  it('falls back to the raw domain when empty-ish', () => {
    expect(prettySiteName('')).toBe('');
  });
});

describe('buildCitationRegistry', () => {
  it('returns [] for no/empty/non-array tool calls', () => {
    expect(buildCitationRegistry(undefined)).toEqual([]);
    expect(buildCitationRegistry(null)).toEqual([]);
    expect(buildCitationRegistry([])).toEqual([]);
  });

  it('ignores tool calls that are not source-bearing search calls', () => {
    const calls = [
      { name: 'get_seo_metrics', result: { results: [{ url: 'https://x.com', title: 'x' }] } },
      { name: 'generate_image', result: { imageUrl: 'https://img.com/a.png' } },
    ];
    expect(buildCitationRegistry(calls)).toEqual([]);
  });

  it('extracts structured sources and assigns stable 1-based ids', () => {
    const calls = [
      searchCall([
        { url: 'https://www.grandviewresearch.com/report', title: 'CRM Market To Reach $163B', snippet: 's1', publishedDate: '2025-01-01' },
        { url: 'https://www.statista.com/crm', title: 'CRM stats' },
      ]),
    ];
    const cites = buildCitationRegistry(calls);
    expect(cites).toHaveLength(2);
    expect(cites[0]).toMatchObject({
      id: 1,
      url: 'https://www.grandviewresearch.com/report',
      domain: 'grandviewresearch.com',
      title: 'CRM Market To Reach $163B',
      snippet: 's1',
      publishedDate: '2025-01-01',
    });
    expect(cites[1]).toMatchObject({ id: 2, domain: 'statista.com', title: 'CRM stats' });
    expect(cites[1].snippet).toBeUndefined();
  });

  it('de-duplicates the same url across multiple searches (hash/trailing slash ignored)', () => {
    const calls = [
      searchCall([{ url: 'https://a.com/x/', title: 'A' }]),
      searchCall([{ url: 'https://a.com/x#section', title: 'A dup' }, { url: 'https://b.com', title: 'B' }]),
    ];
    const cites = buildCitationRegistry(calls);
    expect(cites.map((c) => c.domain)).toEqual(['a.com', 'b.com']);
    expect(cites.map((c) => c.id)).toEqual([1, 2]);
  });

  it('skips entries without a usable http(s) url', () => {
    const calls = [
      searchCall([
        { title: 'no url' },
        { url: 'ftp://x.com/file', title: 'wrong scheme' },
        { url: 'https://ok.com', title: 'ok' },
      ]),
    ];
    const cites = buildCitationRegistry(calls);
    expect(cites).toHaveLength(1);
    expect(cites[0]).toMatchObject({ id: 1, domain: 'ok.com' });
  });
});
