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

const makeProvider = (data: any, retryData?: any) => {
  const post = jest.fn().mockResolvedValue({ data });
  // An empty news search retries once with news intent; give that call its own payload.
  if (retryData !== undefined) post.mockResolvedValueOnce({ data }).mockResolvedValueOnce({ data: retryData });
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

  it('drops web-bucket results that are not about the query entity', async () => {
    // Live You.com response for "Zenoti" (freshness=week): the web bucket is
    // query-ranked but still pads a thin entity query with matches on nothing
    // more than a similar-looking token.
    const { provider } = makeProvider({
      results: {
        web: [
          { title: 'Zenoti raises a Series F', url: 'https://news.example.com/zenoti-series-f', page_age: '2026-08-11T00:00:00' },
          { title: 'Fine Dining Restaurant | Las Vegas Restaurants at ARIA', url: 'https://aria.example.com/dining', page_age: '2026-08-11T00:00:00' },
          { title: 'Zendaya en EL PAÍS', url: 'https://elpais.example.com/zendaya', page_age: '2026-08-06T00:00:00' },
        ],
      },
      metadata: { query: 'Zenoti' },
    });

    const response = await provider.search({ query: 'Zenoti', count: 10, freshness: 'week', resultSource: 'news' });

    expect(response.results.map((r) => r.url)).toEqual(['https://news.example.com/zenoti-series-f']);
    expect(response.metadata).toEqual(expect.objectContaining({
      newsResultCount: 0,
      irrelevantWebDropped: 2,
      webFallbackCount: 1,
    }));
  });

  it('drops web-bucket pages that cannot be coverage at all', async () => {
    // Live You.com response for "Zenoti": every page genuinely about Zenoti is a
    // product surface, because page_age is a crawl date and does not exclude
    // evergreen pages. Keeping them pads a weekly digest with vendor docs.
    const { provider } = makeProvider({
      results: {
        web: [
          { title: 'Zenoti Trust & Compliance Center | Powered by SafeBase', url: 'https://trust.zenoti.com/', page_age: '2026-08-11T20:40:53' },
          { title: 'Zenoti Mobile APK Download for Android', url: 'https://apkpure.net/zenoti-mobile/com.zenoti.mpos', page_age: '2026-08-07T00:00:00' },
        ],
      },
      metadata: { query: 'Zenoti' },
    });

    const response = await provider.search({ query: 'Zenoti', count: 10, freshness: 'week', resultSource: 'news' });

    expect(response.results).toEqual([]);
    expect(response.metadata).toEqual(expect.objectContaining({
      nonCoverageWebDropped: 2,
      irrelevantWebDropped: 0,
      webFallbackCount: 0,
    }));
  });

  it('requires a web-bucket page to name the entity in its title or URL', async () => {
    const { provider } = makeProvider({
      results: {
        web: [
          { title: 'Top 40 salon management startups to watch', url: 'https://example.com/list', description: 'Includes Booksy, Zenoti and Phorest.' },
        ],
      },
      metadata: { query: 'Zenoti' },
    });

    const response = await provider.search({ query: 'Zenoti', count: 10, freshness: 'week', resultSource: 'news' });

    expect(response.results).toEqual([]);
    expect(response.metadata).toEqual(expect.objectContaining({ irrelevantWebDropped: 1 }));
  });

  it('requires a news article to corroborate the entity with the rest of the query', async () => {
    // Live "Stripe payments news" news bucket: "stripes" singularizes onto the
    // "stripe" anchor, so sports coverage survives an anchor-only test.
    const { provider } = makeProvider({
      results: {
        news: [
          { title: 'Ohio State running backs earn black stripe removal at camp', url: 'https://sports.example.com/osu' },
          { title: 'Stripe-PayPal deal would face a regulatory test', url: 'https://news.example.com/stripe-paypal', description: 'over payments scale' },
        ],
      },
      metadata: { query: 'Stripe payments' },
    });

    const response = await provider.search({ query: 'Stripe payments', count: 10, freshness: 'week', resultSource: 'news' });

    expect(response.results.map((r) => r.url)).toEqual(['https://news.example.com/stripe-paypal']);
    expect(response.metadata).toEqual(expect.objectContaining({ irrelevantNewsDropped: 1 }));
  });

  it('reports no coverage rather than padding when nothing matches the entity', async () => {
    // Live You.com response for the made-up "Zzyxwqq Holdings": the web bucket
    // still returns six ETF holdings pages, matched on "holdings" alone.
    const { provider } = makeProvider({
      results: {
        web: [
          { title: 'TSX:ZQQ Holdings List - BMO Nasdaq 100 Equity Hedged to CAD Index ETF', url: 'https://etf.example.com/zqq' },
          { title: 'Invesco QQQ Trust Series I', url: 'https://etf.example.com/qqq' },
          { title: 'QQQI Holdings: All 105 Stocks in NEOS Nasdaq 100 High Income ETF', url: 'https://etf.example.com/qqqi' },
        ],
      },
      metadata: { query: 'Zzyxwqq Holdings' },
    });

    const response = await provider.search({ query: 'Zzyxwqq Holdings', count: 10, freshness: 'week', resultSource: 'news' });

    expect(response.results).toEqual([]);
    expect(response.metadata).toEqual(expect.objectContaining({
      irrelevantWebDropped: 3,
      webFallbackCount: 0,
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

  it('retries with news intent when a bare entity query comes back empty', async () => {
    // Live behaviour: "Stripe payments" is ranked navigationally and returns only
    // Stripe's own help centre and its Wikipedia entry, so an honest filter has
    // nothing to keep. "Stripe payments news" returns the week's real reporting.
    const { provider, post } = makeProvider(
      {
        results: {
          web: [
            { title: 'Stripe, Inc. - Wikipedia', url: 'https://en.wikipedia.org/wiki/Stripe,_Inc.' },
            { title: 'Payment card transactions : Stripe: Help & Support', url: 'https://support.stripe.com/questions/payment-card-transactions' },
          ],
        },
        metadata: { query: 'Stripe payments' },
      },
      {
        results: {
          web: [
            { title: "Stripe's first employee built a bank to fix payments' messy last mile", url: 'https://www.pymnts.com/news/banking/2026/stripe-bank/' },
            { title: 'Stripe-PayPal deal would likely face regulatory test over payments scale', url: 'https://www.whitecase.com/news/media/stripe-paypal-deal/' },
          ],
        },
        metadata: { query: 'Stripe payments news' },
      },
    );

    const response = await provider.search({ query: 'Stripe payments', count: 10, freshness: 'week', resultSource: 'news' });

    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[1][1]).toEqual(expect.objectContaining({ query: 'Stripe payments news', freshness: 'week' }));
    expect(response.results.map((r) => r.url)).toEqual([
      'https://www.pymnts.com/news/banking/2026/stripe-bank/',
      'https://www.whitecase.com/news/media/stripe-paypal-deal/',
    ]);
    // the caller's query, not the rewritten one
    expect(response.query).toBe('Stripe payments');
    expect(response.metadata).toEqual(expect.objectContaining({ newsIntentRetry: true, webFallbackCount: 2 }));
  });

  it('ignores the news bucket of the retry, which news intent fills with the trending feed', async () => {
    const { provider } = makeProvider(
      { results: { web: [] }, metadata: { query: 'Stripe payments' } },
      {
        results: {
          news: [
            { title: 'Stripe removal: Ohio State running backs earn black stripe removal', url: 'https://sports.example.com/osu', description: 'Buckeyes camp payments of dues' },
          ],
          web: [{ title: 'Stripe launches Tempo', url: 'https://news.example.com/tempo' }],
        },
        metadata: { query: 'Stripe payments news' },
      },
    );

    const response = await provider.search({ query: 'Stripe payments', count: 10, freshness: 'week', resultSource: 'news' });

    expect(response.results.map((r) => r.url)).toEqual(['https://news.example.com/tempo']);
    expect(response.results.every((r) => r.sourceType === 'web')).toBe(true);
  });

  it('does not retry a query that already asks for news', async () => {
    const { provider, post } = makeProvider({
      results: { news: [], web: [] },
      metadata: { query: 'Guesty vacation rental software company news' },
    });

    const response = await provider.search({
      query: 'Guesty vacation rental software company news',
      count: 10,
      freshness: 'week',
      resultSource: 'news',
    });

    expect(post).toHaveBeenCalledTimes(1);
    expect(response.results).toEqual([]);
    expect(response.metadata).not.toHaveProperty('newsIntentRetry');
  });

  it('keeps the honest empty result when the retry itself fails', async () => {
    const post = jest.fn()
      .mockResolvedValueOnce({ data: { results: { web: [] }, metadata: { query: 'Zenoti' } } })
      .mockRejectedValueOnce(new Error('429 rate limited'));
    const provider = new YouSearchProvider({ apiKey: 'k', httpClient: { post } as any });

    const response = await provider.search({ query: 'Zenoti', count: 10, freshness: 'week', resultSource: 'news' });

    expect(response.results).toEqual([]);
    expect(response.metadata).toEqual(expect.objectContaining({ resultSource: 'news', webFallbackCount: 0 }));
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
