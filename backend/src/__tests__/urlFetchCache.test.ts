/**
 * ENG-926 §G — the per-run URL fetch cache.
 *
 * Two §G checks read customer pages and their URL sets overlap. This makes fetch-once a
 * property of the mechanism rather than a comparison someone has to keep correct.
 */

import { createUrlFetchCache, normaliseUrlForCache, MAX_CACHE_ENTRIES } from '../services/urlFetchCache';

describe('normaliseUrlForCache', () => {
  it('folds only what the URL spec says is insensitive', () => {
    expect(normaliseUrlForCache('HTTPS://Example.COM/Path')).toBe('https://example.com/Path');
    expect(normaliseUrlForCache('https://example.com:443/a')).toBe('https://example.com/a');
    expect(normaliseUrlForCache('http://example.com:80/a')).toBe('http://example.com/a');
    expect(normaliseUrlForCache('https://example.com/a#frag')).toBe('https://example.com/a');
  });

  it('does NOT fold things that can be different pages', () => {
    // Over-normalising is worse than fetching twice: it makes two pages share one verdict.
    expect(normaliseUrlForCache('https://example.com/a'))
      .not.toBe(normaliseUrlForCache('https://example.com/a/'));
    expect(normaliseUrlForCache('https://www.example.com/a'))
      .not.toBe(normaliseUrlForCache('https://example.com/a'));
    expect(normaliseUrlForCache('https://example.com/a?x=1'))
      .not.toBe(normaliseUrlForCache('https://example.com/a?x=2'));
    // Path case is significant on most servers.
    expect(normaliseUrlForCache('https://example.com/A'))
      .not.toBe(normaliseUrlForCache('https://example.com/a'));
  });

  it('keys an unparseable value verbatim rather than dropping it', () => {
    expect(normaliseUrlForCache('not a url')).toBe('not a url');
    expect(normaliseUrlForCache('  ')).toBe('');
  });
});

describe('createUrlFetchCache', () => {
  it('fetches a URL once however many callers ask', async () => {
    const underlying = jest.fn().mockResolvedValue('<html>ok</html>');
    const cache = createUrlFetchCache(underlying);

    const a = await cache.fetchHtml('https://example.com/lander');
    const b = await cache.fetchHtml('https://example.com/lander');
    const c = await cache.fetchHtml('HTTPS://Example.com/lander');

    expect(a).toBe('<html>ok</html>');
    expect(b).toBe(a);
    expect(c).toBe(a);
    expect(underlying).toHaveBeenCalledTimes(1);
    expect(cache.stats()).toEqual({ fetches: 1, hits: 2, distinct: 1, evicted: 0 });
    // The RAW url reaches the fetcher, not the normalised key — a change there would
    // alter what the SSRF-guarded fetcher actually requests.
    expect(underlying).toHaveBeenCalledWith('https://example.com/lander');
  });

  it('shares ONE in-flight request between concurrent callers', async () => {
    // Storing the promise, not the settled value: two checks racing in the same tick would
    // otherwise both miss an empty cache and both fire.
    let resolve!: (v: string) => void;
    const underlying = jest.fn().mockReturnValue(new Promise<string>((r) => { resolve = r; }));
    const cache = createUrlFetchCache(underlying);

    const p1 = cache.fetchHtml('https://example.com/x');
    const p2 = cache.fetchHtml('https://example.com/x');
    resolve('<html>shared</html>');

    expect(await p1).toBe('<html>shared</html>');
    expect(await p2).toBe('<html>shared</html>');
    expect(underlying).toHaveBeenCalledTimes(1);
  });

  it('CACHES FAILURES — a 403 site is asked once per sweep, not once per checker', async () => {
    const boom = new Error('403 Forbidden');
    const underlying = jest.fn().mockRejectedValue(boom);
    const cache = createUrlFetchCache(underlying);

    await expect(cache.fetchHtml('https://blocked.test/')).rejects.toThrow('403 Forbidden');
    await expect(cache.fetchHtml('https://blocked.test/')).rejects.toThrow('403 Forbidden');
    expect(underlying).toHaveBeenCalledTimes(1);
  });

  it('re-throws the ORIGINAL error object, so caller error handling still works', async () => {
    const boom = Object.assign(new Error('nope'), { code: 'ENOTFOUND' });
    const cache = createUrlFetchCache(jest.fn().mockRejectedValue(boom));

    await expect(cache.fetchHtml('https://x.test/')).rejects.toBe(boom);
    await expect(cache.fetchHtml('https://x.test/')).rejects.toBe(boom);
  });

  it('still fetches genuinely different URLs', async () => {
    const underlying = jest.fn().mockResolvedValue('<html></html>');
    const cache = createUrlFetchCache(underlying);
    await cache.fetchHtml('https://a.test/');
    await cache.fetchHtml('https://b.test/');
    expect(underlying).toHaveBeenCalledTimes(2);
    expect(cache.stats().distinct).toBe(2);
  });
});


describe('bounded memory', () => {
  it('evicts the oldest entries rather than holding the fleet\'s HTML for the whole sweep', async () => {
    // A page is capped at 5MB and a sweep reads every destination AND every generated site,
    // in a process that also serves the API. Unbounded, that is the whole fleet resident.
    const cache = createUrlFetchCache(jest.fn().mockResolvedValue('<html></html>'));
    for (let i = 0; i < MAX_CACHE_ENTRIES + 25; i++) {
      await cache.fetchHtml(`https://site-${i}.test/`);
    }
    const st = cache.stats();
    expect(st.distinct).toBeLessThanOrEqual(MAX_CACHE_ENTRIES);
    expect(st.evicted).toBe(25);
  });

  it('still serves a hit for a recently-seen URL', async () => {
    const underlying = jest.fn().mockResolvedValue('<html></html>');
    const cache = createUrlFetchCache(underlying);
    await cache.fetchHtml('https://a.test/');
    await cache.fetchHtml('https://a.test/');
    expect(underlying).toHaveBeenCalledTimes(1);
  });
});
