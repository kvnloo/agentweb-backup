// ENG-351 Phase 1/2 — citation registry accumulated from Emma's web-search tool results.
import { CitationRegistry, buildCitationIndexBlock, domainFromUrl, prettySiteName, WEB_SEARCH_TOOL_NAMES } from '../utils/citations';

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

describe('WEB_SEARCH_TOOL_NAMES', () => {
  it('covers the three web-search tools and excludes the S3 slice-reader', () => {
    expect(WEB_SEARCH_TOOL_NAMES.has('you_search_web')).toBe(true);
    expect(WEB_SEARCH_TOOL_NAMES.has('you_search_news')).toBe(true);
    expect(WEB_SEARCH_TOOL_NAMES.has('google_search_web')).toBe(true);
    expect(WEB_SEARCH_TOOL_NAMES.has('search_tool_response')).toBe(false);
  });
});

describe('buildCitationIndexBlock', () => {
  it('returns empty string for an empty batch', () => {
    expect(buildCitationIndexBlock([])).toBe('');
  });
  it('maps each source id to a {{cite:N}} marker line', () => {
    const block = buildCitationIndexBlock([
      { id: 2, url: 'https://x.com', domain: 'grandviewresearch.com', siteName: 'Grand View Research' },
      { id: 5, url: 'https://y.com', domain: 'statista.com', siteName: 'Statista' },
    ]);
    expect(block).toContain('{{cite:2}} = Grand View Research (grandviewresearch.com)');
    expect(block).toContain('{{cite:5}} = Statista (statista.com)');
    expect(block).toContain('INLINE CITATIONS');
    expect(block.endsWith('\n\n')).toBe(true); // separated from the search body it is prepended to
  });
});

describe('CitationRegistry', () => {
  it('starts empty and ignores non-array / missing results', () => {
    const reg = new CitationRegistry();
    reg.registerSearchResults(undefined);
    reg.registerSearchResults(null);
    reg.registerSearchResults('nope' as any);
    expect(reg.size).toBe(0);
    expect(reg.list()).toEqual([]);
  });

  it('extracts structured sources and assigns stable 1-based ids', () => {
    const reg = new CitationRegistry();
    reg.registerSearchResults([
      { url: 'https://www.grandviewresearch.com/report', title: 'CRM Market To Reach $163B', snippet: 's1', publishedDate: '2025-01-01' },
      { url: 'https://www.statista.com/crm', title: 'CRM stats' },
    ]);
    const cites = reg.list();
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

  it('de-duplicates the same url ACROSS multiple search calls (hash/trailing slash ignored)', () => {
    const reg = new CitationRegistry();
    reg.registerSearchResults([{ url: 'https://a.com/x/', title: 'A' }]);
    reg.registerSearchResults([{ url: 'https://a.com/x#section', title: 'A dup' }, { url: 'https://b.com', title: 'B' }]);
    const cites = reg.list();
    expect(cites.map((c) => c.domain)).toEqual(['a.com', 'b.com']);
    expect(cites.map((c) => c.id)).toEqual([1, 2]);
  });

  it('returns the batch with global ids, reusing ids for urls seen in a prior search (Phase 2)', () => {
    const reg = new CitationRegistry();
    const batch1 = reg.registerSearchResults([{ url: 'https://a.com', title: 'A' }, { url: 'https://b.com', title: 'B' }]);
    expect(batch1.map((c) => [c.id, c.domain])).toEqual([[1, 'a.com'], [2, 'b.com']]);

    // Second search: b.com repeats (keeps id 2), c.com is new (id 3).
    const batch2 = reg.registerSearchResults([{ url: 'https://b.com', title: 'B again' }, { url: 'https://c.com', title: 'C' }]);
    expect(batch2.map((c) => [c.id, c.domain])).toEqual([[2, 'b.com'], [3, 'c.com']]);
    expect(reg.list().map((c) => c.id)).toEqual([1, 2, 3]);
  });

  it('skips entries without a usable http(s) url or parseable host', () => {
    const reg = new CitationRegistry();
    reg.registerSearchResults([
      { title: 'no url' },
      { url: 'ftp://x.com/file', title: 'wrong scheme' },
      { url: 'https://', title: 'no host' },
      { url: 'https://ok.com', title: 'ok' },
    ]);
    const cites = reg.list();
    expect(cites).toHaveLength(1);
    expect(cites[0]).toMatchObject({ id: 1, domain: 'ok.com' });
  });
});
