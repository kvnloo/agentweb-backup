/**
 * ENG-1050 — you_search_news returned zero or irrelevant results for entity queries.
 *
 * Verified against the live You.com /v1/search API:
 *  - The `news` bucket is only populated when the query itself carries news
 *    intent. "Stripe payments", "Zenoti", "Surfer SEO tool" (freshness=week) all
 *    come back with a `web` bucket ONLY — and the provider threw that bucket away
 *    for news searches, so the tool reported "No results found" for companies with
 *    abundant coverage.
 *  - When the `news` bucket IS returned it is a loosely-matched trending feed:
 *    "Guesty vacation rental software company news" yields King Charles' castle and
 *    Zelenskyy in Serbia; "Stripe payments news" yields UEFA and USMNT.
 *
 * So for resultSource='news' the provider must (a) drop news articles with no
 * lexical connection to the query and (b) fall back to the freshness-scoped,
 * query-ranked `web` bucket instead of returning nothing.
 */
import { YouSearchProvider } from '../search/youSearchProvider';

const makeProvider = (data: any) => {
  const post = jest.fn().mockResolvedValue({ data });
  return { provider: new YouSearchProvider({ apiKey: 'k', httpClient: { post } as any }), post };
};

describe('YouSearchProvider news searches (ENG-1050)', () => {
  it('falls back to the web bucket when You.com returns no news bucket at all', async () => {
    const { provider } = makeProvider({
      results: {
        web: [
          { title: 'Stripe (STRI.PVT) Valuation, History & News', url: 'https://finance.example.com/stripe', description: 'Stripe payments volume', page_age: '2026-08-10T03:48:23' },
          { title: 'Stripe-PayPal deal would face regulatory review', url: 'https://mergermarket.example.com/stripe', description: 'Stripe payments deal', page_age: '2026-08-05T14:10:04' },
        ],
      },
      metadata: { query: 'Stripe payments' },
    });

    const response = await provider.search({ query: 'Stripe payments', count: 10, freshness: 'week', resultSource: 'news' });

    expect(response.results).toHaveLength(2);
    expect(response.results.map((r) => r.url)).toEqual([
      'https://finance.example.com/stripe',
      'https://mergermarket.example.com/stripe',
    ]);
    expect(response.metadata).toEqual(expect.objectContaining({
      resultSource: 'news',
      newsResultCount: 0,
      webFallbackCount: 2,
    }));
  });

  it('drops news articles unrelated to the query and supplements from the web bucket', async () => {
    const { provider } = makeProvider({
      results: {
        news: [
          { title: "King Charles makes new addition to summer home", url: 'https://news.example.com/charles', description: 'Royal summer break in Scotland' },
          { title: "Ukraine's Zelenskyy arrives for first visit to Serbia", url: 'https://news.example.com/serbia', description: 'Official visit' },
          { title: 'Guesty acquires a vacation rental pricing startup', url: 'https://news.example.com/guesty', description: 'The vacation rental platform Guesty announced a deal' },
        ],
        web: [
          { title: 'Guesty vs Hostaway: Vacation Rental Software Comparison', url: 'https://reviews.example.com/guesty', description: 'Comparison', page_age: '2026-08-09T00:00:00' },
        ],
      },
      metadata: { query: 'Guesty vacation rental software company news' },
    });

    const response = await provider.search({
      query: 'Guesty vacation rental software company news',
      count: 10,
      freshness: 'week',
      resultSource: 'news',
    });

    expect(response.results.map((r) => r.url)).toEqual([
      'https://news.example.com/guesty',
      'https://reviews.example.com/guesty',
    ]);
    expect(response.results[0].sourceType).toBe('news');
    expect(response.results[1].sourceType).toBe('web');
    expect(response.metadata).toEqual(expect.objectContaining({
      newsResultCount: 1,
      irrelevantNewsDropped: 2,
      webFallbackCount: 1,
    }));
  });

  it('reports a trustworthy empty result when neither bucket has anything', async () => {
    const { provider } = makeProvider({ results: { web: [], news: [] }, metadata: { query: 'Zenoti' } });

    const response = await provider.search({ query: 'Zenoti', count: 10, freshness: 'week', resultSource: 'news' });

    expect(response.results).toEqual([]);
    expect(response.metadata).toEqual(expect.objectContaining({
      newsResultCount: 0,
      irrelevantNewsDropped: 0,
      webFallbackCount: 0,
    }));
  });

  it('keeps every news article for a generic query that has no entity to match on', async () => {
    const { provider } = makeProvider({
      results: {
        news: [
          { title: 'AI CEOs are in their manifesto era', url: 'https://news.example.com/a' },
          { title: 'China bets on AI weather forecasting', url: 'https://news.example.com/b' },
        ],
        web: [{ title: 'AI News | TechCrunch', url: 'https://tc.example.com/ai' }],
      },
      metadata: { query: 'latest news today' },
    });

    const response = await provider.search({ query: 'latest news today', count: 10, freshness: 'day', resultSource: 'news' });

    expect(response.results.map((r) => r.url)).toEqual([
      'https://news.example.com/a',
      'https://news.example.com/b',
      'https://tc.example.com/ai',
    ]);
    expect(response.metadata).toEqual(expect.objectContaining({ irrelevantNewsDropped: 0 }));
  });

  it('never returns more than the requested count', async () => {
    const { provider } = makeProvider({
      results: {
        news: [{ title: 'Zenoti raises a round', url: 'https://news.example.com/zenoti' }],
        web: [
          { title: 'Zenoti Trust Center', url: 'https://web.example.com/1' },
          { title: 'Zenoti pricing', url: 'https://web.example.com/2' },
        ],
      },
      metadata: { query: 'Zenoti' },
    });

    const response = await provider.search({ query: 'Zenoti', count: 2, freshness: 'week', resultSource: 'news' });

    expect(response.results).toHaveLength(2);
    expect(response.results[0].url).toBe('https://news.example.com/zenoti');
  });

  it('does not duplicate a URL that appears in both buckets', async () => {
    const { provider } = makeProvider({
      results: {
        news: [{ title: 'Zenoti raises a round', url: 'https://news.example.com/zenoti' }],
        web: [{ title: 'Zenoti raises a round', url: 'https://news.example.com/zenoti' }],
      },
      metadata: { query: 'Zenoti' },
    });

    const response = await provider.search({ query: 'Zenoti', count: 10, freshness: 'week', resultSource: 'news' });

    expect(response.results).toHaveLength(1);
    expect(response.results[0].sourceType).toBe('news');
  });

  it('leaves web-only and combined searches untouched', async () => {
    const { provider, post } = makeProvider({
      results: {
        web: [{ title: 'Web', url: 'https://example.com/web' }],
        news: [{ title: 'Unrelated celebrity story', url: 'https://example.com/news' }],
      },
      metadata: { query: 'Zenoti' },
    });

    const webOnly = await provider.search({ query: 'Zenoti', count: 5, resultSource: 'web' });
    expect(webOnly.results.map((r) => r.sourceType)).toEqual(['web']);
    expect(webOnly.metadata).not.toHaveProperty('newsResultCount');

    const all = await provider.search({ query: 'Zenoti', count: 5, resultSource: 'all' });
    expect(all.results.map((r) => r.sourceType)).toEqual(['web', 'news']);

    // request body is unchanged by the news handling
    expect(post.mock.calls[0][1]).toEqual({ query: 'Zenoti', count: 5 });
  });
});
