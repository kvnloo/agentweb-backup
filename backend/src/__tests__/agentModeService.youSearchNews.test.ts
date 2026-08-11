/**
 * ENG-1050 — you_search_news reporting.
 *
 * A news search may be answered by news articles, by recent web pages from the
 * same freshness window (You.com only emits a news bucket for news-intent
 * queries), or by neither. The tool result must say which, so a scheduled
 * competitor digest can tell "no coverage this week" from "the search returned
 * nothing", and never presents a web page as a news article.
 */
const mockSearch = jest.fn();

jest.mock('@slack/web-api', () => ({
  WebClient: jest.fn().mockImplementation(() => ({
    chat: { postMessage: jest.fn() },
    conversations: { info: jest.fn(), list: jest.fn() },
    views: { open: jest.fn() },
  })),
}));

jest.mock('../search/youSearchProvider', () => ({
  YouSearchProvider: jest.fn().mockImplementation(() => ({ search: mockSearch })),
}));

import { AgentModeService } from '../services/agentModeService';

describe('youSearchNews result reporting (ENG-1050)', () => {
  let service: AgentModeService;

  beforeEach(() => {
    mockSearch.mockReset();
    service = new AgentModeService();
  });

  it('distinguishes news articles from recent web pages in the message and formatted content', async () => {
    mockSearch.mockResolvedValue({
      provider: 'you',
      query: 'Stripe payments',
      results: [
        { title: 'Stripe launches X', url: 'https://news.example.com/stripe', snippet: 'n', sourceType: 'news' },
        { title: 'Stripe valuation history', url: 'https://web.example.com/stripe', snippet: 'w', sourceType: 'web' },
        { title: 'Stripe-PayPal deal review', url: 'https://web.example.com/deal', snippet: 'w', sourceType: 'web' },
      ],
      metadata: { freshness: 'week' },
    });

    const result = await service.youSearchNews('Stripe payments', 10);

    expect(result.success).toBe(true);
    expect(result.totalResults).toBe(3);
    expect(result.message).toContain('1 news article');
    expect(result.message).toContain('2 recent web pages');
    expect(result.formattedContent).toContain('📰 News article — Stripe launches X');
    expect(result.formattedContent).toContain('🌐 Recent web page — Stripe valuation history');
  });

  it('reports an empty news search as "no coverage found", not as a failure', async () => {
    mockSearch.mockResolvedValue({ provider: 'you', query: 'Zenoti', results: [], metadata: { freshness: 'week' } });

    const result = await service.youSearchNews('Zenoti', 10);

    expect(result.success).toBe(true);
    expect(result.message).toContain('0 news articles');
    expect(result.message).toContain('0 recent web pages');
    expect(result.formattedContent).toContain('no coverage found');
    expect(result.formattedContent).toContain('The search itself succeeded');
  });

  it('still defaults a news search to the week freshness window', async () => {
    mockSearch.mockResolvedValue({ provider: 'you', query: 'Zenoti', results: [], metadata: {} });

    await service.youSearchNews('Zenoti', 10);

    expect(mockSearch).toHaveBeenCalledWith(expect.objectContaining({
      query: 'Zenoti',
      freshness: 'week',
      resultSource: 'news',
      purpose: 'news',
    }));
  });

  it('leaves the web-search message untouched', async () => {
    mockSearch.mockResolvedValue({
      provider: 'you',
      query: 'agentweb pricing',
      results: [{ title: 'Pricing', url: 'https://example.com/p', snippet: 'p', sourceType: 'web' }],
      metadata: {},
    });

    const result = await service.youSearchWeb('agentweb pricing', 5);

    expect(result.message).toBe('Found 1 web search results for "agentweb pricing"');
    expect(result.formattedContent).toContain('🔍 Web Search Results');
    expect(result.formattedContent).not.toContain('Recent web page');
  });
});
