/**
 * Tests for fetchMergedPRs pagination.
 * Verifies that when GitHub returns a full page (100 results), we fetch subsequent pages
 * until a partial page is returned — so large date ranges return all PRs.
 */

import { fetchMergedPRs } from '../services/prDigestService';

jest.mock('../utils/secretsManager', () => ({
  getGitHubOrgToken: jest.fn().mockResolvedValue({ token: 'test-token', org: 'TestOrg' }),
}));

const makePRItem = (n: number) => ({
  number: n,
  title: `PR ${n}`,
  html_url: `https://github.com/TestOrg/agentweb/pull/${n}`,
  user: { login: 'dev' },
  state: 'closed',
  merged_at: '2026-04-01T10:00:00Z',
  body: null,
  additions: 5,
  deletions: 2,
  changed_files: 1,
});

/**
 * Build a mock fetch implementation that simulates paginated GitHub Search responses.
 * @param totalPRs Total number of PRs to spread across pages.
 */
function makePaginatedFetch(totalPRs: number) {
  const allItems = Array.from({ length: totalPRs }, (_, i) => makePRItem(i + 1));

  return jest.fn().mockImplementation(async (url: string) => {
    // PR detail endpoint: /repos/:org/:repo/pulls/:number
    const prDetailMatch = url.match(/\/pulls\/(\d+)$/);
    if (prDetailMatch) {
      const num = parseInt(prDetailMatch[1], 10);
      const pr = allItems.find(p => p.number === num);
      if (!pr) return { ok: false, text: async () => 'Not found' };
      return {
        ok: true,
        json: async () => pr,
      };
    }

    // Search endpoint: extract page param (defaults to 1)
    const pageMatch = url.match(/[?&]page=(\d+)/);
    const page = pageMatch ? parseInt(pageMatch[1], 10) : 1;
    const perPage = 100;
    const start = (page - 1) * perPage;
    const pageItems = allItems.slice(start, start + perPage);

    return {
      ok: true,
      json: async () => ({
        total_count: totalPRs,
        items: pageItems,
      }),
    };
  });
}

describe('fetchMergedPRs pagination', () => {
  const since = '2026-03-30T00:00:00Z';
  const until = '2026-04-29T23:59:59Z';

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ─── FAIL tests (boundary / invalid inputs) ────────────────────────────

  it('should fetch a second page when the first page returns exactly 100 items', async () => {
    // 150 PRs across agentweb; 0 for customer-portal
    const mockFetch = makePaginatedFetch(150);
    global.fetch = mockFetch as any;

    const results = await fetchMergedPRs(since, until);
    const awResult = results.find(r => r.repo === 'agentweb')!;

    // Without pagination we'd only get 100 — must get 150
    expect(awResult.prs.length).toBe(150);
  });

  it('should fetch all pages when PRs span exactly 3 full pages (300 PRs)', async () => {
    const mockFetch = makePaginatedFetch(300);
    global.fetch = mockFetch as any;

    const results = await fetchMergedPRs(since, until);
    const awResult = results.find(r => r.repo === 'agentweb')!;

    expect(awResult.prs.length).toBe(300);
  });

  it('should stop paginating when a page returns fewer than 100 items (no extra request)', async () => {
    // 250 PRs: pages [100, 100, 50] — should make exactly 3 search calls per repo
    const mockFetch = makePaginatedFetch(250);
    global.fetch = mockFetch as any;

    await fetchMergedPRs(since, until);

    // Count search calls for agentweb (not PR detail calls)
    const searchCalls = (mockFetch.mock.calls as [string, ...any[]][])
      .filter(([url]) => url.includes('/search/issues') && url.includes('agentweb'))
      .filter(([url]) => !url.includes('customer-portal'));

    // Should have fetched pages 1, 2, 3 (not 4)
    expect(searchCalls.length).toBe(3);
  });

  it('should return an empty array when there are 0 PRs (no second page fetch)', async () => {
    const mockFetch = makePaginatedFetch(0);
    global.fetch = mockFetch as any;

    const results = await fetchMergedPRs(since, until);
    const awResult = results.find(r => r.repo === 'agentweb')!;

    expect(awResult.prs.length).toBe(0);
    const searchCalls = (mockFetch.mock.calls as [string, ...any[]][])
      .filter(([url]) => url.includes('/search/issues'));
    // Only 1 call per repo (page 1 returned 0 items → stop)
    expect(searchCalls.length).toBe(2); // one per repo
  });

  // ─── SUCCESS tests ────────────────────────────────────────────────────

  it('should return exactly 100 PRs from a single full page when total is exactly 100', async () => {
    const mockFetch = makePaginatedFetch(100);
    global.fetch = mockFetch as any;

    const results = await fetchMergedPRs(since, until);
    const awResult = results.find(r => r.repo === 'agentweb')!;

    // 100 exactly — single page, no second request needed
    expect(awResult.prs.length).toBe(100);
  });

  it('should return all PRs across both repos independently', async () => {
    // 150 for agentweb, 80 for customer-portal
    // We simulate this by tracking which repo URL is called
    const awItems = Array.from({ length: 150 }, (_, i) => makePRItem(i + 1));
    const cpItems = Array.from({ length: 80 }, (_, i) => makePRItem(i + 1));

    global.fetch = jest.fn().mockImplementation(async (url: string) => {
      const isCP = url.includes('customer-portal');
      const allItems = isCP ? cpItems : awItems;

      const prDetailMatch = url.match(/\/pulls\/(\d+)$/);
      if (prDetailMatch) {
        const num = parseInt(prDetailMatch[1], 10);
        const pr = allItems.find(p => p.number === num);
        if (!pr) return { ok: false, text: async () => 'Not found' };
        return { ok: true, json: async () => pr };
      }

      const pageMatch = url.match(/[?&]page=(\d+)/);
      const page = pageMatch ? parseInt(pageMatch[1], 10) : 1;
      const start = (page - 1) * 100;
      return {
        ok: true,
        json: async () => ({
          total_count: allItems.length,
          items: allItems.slice(start, start + 100),
        }),
      };
    }) as any;

    const results = await fetchMergedPRs(since, until);
    const awResult = results.find(r => r.repo === 'agentweb')!;
    const cpResult = results.find(r => r.repo === 'agentweb-customer-portal')!;

    expect(awResult.prs.length).toBe(150);
    expect(cpResult.prs.length).toBe(80);
  });
});
