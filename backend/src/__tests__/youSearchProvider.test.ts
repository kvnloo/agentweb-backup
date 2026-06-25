import { YouSearchProvider } from '../search/youSearchProvider';

describe('YouSearchProvider', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.restoreAllMocks();
  });

  it('posts a You.com Search request with the expected endpoint, auth header, and JSON body', async () => {
    const post = jest.fn().mockResolvedValue({
      data: {
        results: { web: [] },
        metadata: { query: 'agent search' },
      },
    });
    const provider = new YouSearchProvider({
      apiKey: 'test-you-key',
      httpClient: { post } as any,
    });

    await provider.search({
      query: 'agent search',
      count: 7,
      includeDomains: ['example.com'],
      livecrawl: 'web',
      livecrawlFormat: 'markdown',
    });

    expect(post).toHaveBeenCalledWith(
      'https://ydc-index.io/v1/search',
      {
        query: 'agent search',
        count: 7,
        include_domains: ['example.com'],
        livecrawl: 'web',
        livecrawl_formats: ['markdown'],
      },
      expect.objectContaining({
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': 'test-you-key',
        },
      }),
    );
  });

  it('normalizes web and news results into the existing search_web result shape', async () => {
    const provider = new YouSearchProvider({
      apiKey: 'test-you-key',
      httpClient: {
        post: jest.fn().mockResolvedValue({
          data: {
            results: {
              web: [{
                title: 'Web result',
                url: 'https://example.com/web',
                description: 'A web description',
                snippets: ['web snippet'],
                page_age: '2026-06-22T12:00:00Z',
                thumbnail_url: 'https://example.com/thumb.png',
              }],
              news: [{
                title: 'News result',
                url: 'https://example.com/news',
                snippets: ['news snippet'],
                page_age: '2026-06-23T08:00:00Z',
              }],
            },
            metadata: { query: 'latest updates', latency: 0.12 },
          },
        }),
      } as any,
    });

    const response = await provider.search({ query: 'latest updates', count: 5 });

    expect(response.provider).toBe('you');
    expect(response.results).toEqual([
      expect.objectContaining({
        title: 'Web result',
        url: 'https://example.com/web',
        snippet: 'A web description',
        snippets: ['web snippet'],
        publishedDate: '2026-06-22T12:00:00.000Z',
        thumbnail: 'https://example.com/thumb.png',
        sourceType: 'web',
      }),
      expect.objectContaining({
        title: 'News result',
        url: 'https://example.com/news',
        snippet: 'news snippet',
        sourceType: 'news',
      }),
    ]);
  });

  it('treats empty You.com web and news arrays as a successful zero-result search', async () => {
    const provider = new YouSearchProvider({
      apiKey: 'test-you-key',
      httpClient: {
        post: jest.fn().mockResolvedValue({
          data: { results: { web: [], news: [] }, metadata: { query: 'nothing' } },
        }),
      } as any,
    });

    await expect(provider.search({ query: 'nothing', count: 5 })).resolves.toEqual(
      expect.objectContaining({
        provider: 'you',
        query: 'nothing',
        results: [],
      }),
    );
  });

  it('filters normalized results to the requested You.com result source', async () => {
    const provider = new YouSearchProvider({
      apiKey: 'test-you-key',
      httpClient: {
        post: jest.fn().mockResolvedValue({
          data: {
            results: {
              web: [{ title: 'Web', url: 'https://example.com/web', description: 'web' }],
              news: [{ title: 'News', url: 'https://example.com/news', description: 'news' }],
            },
            metadata: { query: 'current topic' },
          },
        }),
      } as any,
    });

    const webOnly = await provider.search({ query: 'current topic', count: 5, resultSource: 'web' });
    const newsOnly = await provider.search({ query: 'current topic', count: 5, resultSource: 'news' });

    expect(webOnly.provider).toBe('you');
    expect(webOnly.results.map((result) => result.sourceType)).toEqual(['web']);
    expect(webOnly.metadata).toEqual(expect.objectContaining({ provider: 'you', resultSource: 'web' }));
    expect(newsOnly.provider).toBe('you');
    expect(newsOnly.results.map((result) => result.sourceType)).toEqual(['news']);
    expect(newsOnly.metadata).toEqual(expect.objectContaining({ provider: 'you', resultSource: 'news' }));
  });
});
