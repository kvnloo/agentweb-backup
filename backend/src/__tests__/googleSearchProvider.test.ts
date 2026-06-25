jest.mock('googleapis', () => ({
  google: {
    customsearch: jest.fn(),
  },
}));

import { google } from 'googleapis';
import { extractPublishedDate, GoogleSearchProvider } from '../search/googleSearchProvider';

describe('GoogleSearchProvider', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('uses Google Custom Search credentials and normalizes web results', async () => {
    const list = jest.fn().mockResolvedValue({
      data: {
        items: [{
          title: 'Google result',
          link: 'https://example.com/google',
          snippet: 'A Google result snippet',
          pagemap: {
            metatags: [{ 'article:published_time': '2026-06-23T12:00:00Z' }],
            cse_thumbnail: [{ src: 'https://example.com/thumb.jpg' }],
          },
        }],
      },
    });
    (google.customsearch as jest.Mock).mockReturnValue({ cse: { list } });

    const provider = new GoogleSearchProvider({
      credentialsProvider: async () => ({
        apiKey: 'google-api-key',
        searchEngineId: 'google-cse-id',
      }),
    });

    const response = await provider.search({ query: 'agent search', count: 12 });

    expect(list).toHaveBeenCalledWith(expect.objectContaining({
      auth: 'google-api-key',
      cx: 'google-cse-id',
      q: 'agent search',
      num: 10,
    }));
    expect(response).toEqual(expect.objectContaining({
      provider: 'google',
      query: 'agent search',
      metadata: expect.objectContaining({ provider: 'google', resultSource: 'web' }),
      results: [
        expect.objectContaining({
          title: 'Google result',
          url: 'https://example.com/google',
          snippet: 'A Google result snippet',
          publishedDate: '2026-06-23T12:00:00.000Z',
          thumbnail: 'https://example.com/thumb.jpg',
          sourceType: 'web',
        }),
      ],
    }));
  });

  it('extracts published dates from supported Google metadata fields', () => {
    expect(extractPublishedDate({ pubdate: '2026-06-24' })).toBe('2026-06-24T00:00:00.000Z');
    expect(extractPublishedDate({ nope: '2026-06-24' })).toBeNull();
  });
});
