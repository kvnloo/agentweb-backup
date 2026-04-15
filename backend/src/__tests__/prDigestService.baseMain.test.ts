/**
 * Tests for prDigestService — verifies that GitHub search queries are
 * restricted to PRs merged into main (base:main filter).
 */

const mockFetch = jest.fn();
global.fetch = mockFetch;

jest.mock('../utils/secretsManager', () => ({
  getGitHubOrgToken: jest.fn().mockResolvedValue({ token: 'mock-token', org: 'AgentWebPro' }),
}));

import { fetchMergedPRs } from '../services/prDigestService';

describe('prDigestService — base:main filter', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Default: return empty results for all calls
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ items: [] }),
      text: async () => '',
    });
  });

  it('should include base:main in the GitHub search query for agentweb', async () => {
    await fetchMergedPRs('2026-04-14T00:00:00Z', '2026-04-15T00:00:00Z');

    const calls = mockFetch.mock.calls;
    const searchCall = calls.find(([url]: [string]) =>
      url.includes('/search/issues') && url.includes('agentweb')
    );
    expect(searchCall).toBeDefined();
    const url = decodeURIComponent(searchCall[0] as string);
    expect(url).toContain('base:main');
  });

  it('should include base:main in the GitHub search query for agentweb-customer-portal', async () => {
    await fetchMergedPRs('2026-04-14T00:00:00Z', '2026-04-15T00:00:00Z');

    const calls = mockFetch.mock.calls;
    const searchCall = calls.find(([url]: [string]) =>
      url.includes('/search/issues') && url.includes('agentweb-customer-portal')
    );
    expect(searchCall).toBeDefined();
    const url = decodeURIComponent(searchCall[0] as string);
    expect(url).toContain('base:main');
  });

  it('should NOT include PRs merged into non-main branches in the query', async () => {
    await fetchMergedPRs('2026-04-14T00:00:00Z', '2026-04-15T00:00:00Z');

    const calls = mockFetch.mock.calls;
    const searchCalls = calls.filter(([url]: [string]) => url.includes('/search/issues'));
    for (const [url] of searchCalls) {
      const decoded = decodeURIComponent(url as string);
      // The query must contain base:main and must NOT omit the base filter
      expect(decoded).toContain('base:main');
      // Should not match against an arbitrary dev branch
      expect(decoded).not.toMatch(/base:harsha/);
    }
  });

  it('should return empty prs array when GitHub returns no results', async () => {
    const results = await fetchMergedPRs('2026-04-14T00:00:00Z', '2026-04-15T00:00:00Z');
    expect(results).toHaveLength(2);
    expect(results[0].prs).toHaveLength(0);
    expect(results[1].prs).toHaveLength(0);
  });
});
