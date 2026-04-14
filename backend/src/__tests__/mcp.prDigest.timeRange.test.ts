/**
 * Tests for get_pr_digest tool time range support.
 * Verifies that days_ago parameter and since/until params are handled correctly.
 */

// Mock prDigestService before importing apiTools (which imports it at module level)
jest.mock('../services/prDigestService', () => ({
  fetchMergedPRs: jest.fn().mockResolvedValue([
    {
      repo: 'agentweb',
      prs: [
        {
          number: 101,
          title: 'feat: add feature',
          html_url: 'https://github.com/org/agentweb/pull/101',
          user: { login: 'john' },
          merged_at: '2026-04-12T10:00:00Z',
          body: 'Added feature X',
          additions: 50,
          deletions: 10,
          changed_files: 3,
        },
      ],
    },
    { repo: 'agentweb-customer-portal', prs: [] },
  ]),
  formatDigestText: jest.fn().mockReturnValue('mock digest text'),
}));

// Also mock the other apiTools dependencies (same as mcp.apiTools.test.ts)
jest.mock('../mcp/server/httpClient', () => ({
  mcpFetch: jest.fn(),
  generateSelfCallToken: jest.fn().mockReturnValue('mock-token'),
  clearUserCache: jest.fn(),
}));

jest.mock('../services/skillService', () => ({
  skillService: {
    getPublishedSkills: jest.fn().mockResolvedValue([]),
  },
}));

jest.mock('../services/subscriptionService', () => ({
  getAllowedSkills: jest.fn().mockResolvedValue(['*']),
}));

jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    installSkills: jest.fn().mockResolvedValue({ success: true }),
    getUnassociatedToolNames: jest.fn().mockReturnValue([]),
  },
}));

import { fetchMergedPRs, formatDigestText } from '../services/prDigestService';
import { mcpToolRegistry } from '../mcp/server/registry';
import '../mcp/server/apiTools';

const mockFetchMergedPRs = fetchMergedPRs as jest.MockedFunction<typeof fetchMergedPRs>;
const mockFormatDigestText = formatDigestText as jest.MockedFunction<typeof formatDigestText>;

describe('get_pr_digest time range support', () => {
  const HOUR_MS = 60 * 60 * 1000;
  const DAY_MS = 24 * HOUR_MS;

  beforeEach(() => {
    jest.clearAllMocks();
    mockFetchMergedPRs.mockResolvedValue([
      { repo: 'agentweb', prs: [] },
      { repo: 'agentweb-customer-portal', prs: [] },
    ]);
    mockFormatDigestText.mockReturnValue('mock digest text');
  });

  // ─── Tool registration ────────────────────────────────────────────────

  it('should register get_pr_digest tool', () => {
    expect(mcpToolRegistry.getToolNames()).toContain('get_pr_digest');
  });

  it('should expose days_ago parameter in the tool schema', () => {
    const defs = mcpToolRegistry.getToolDefinitions();
    const toolDef = defs.find((d: any) => d.name === 'get_pr_digest');
    expect(toolDef).toBeDefined();
    expect(toolDef.inputSchema.properties).toHaveProperty('days_ago');
    expect(toolDef.inputSchema.properties.days_ago.type).toBe('integer');
  });

  // ─── FAIL tests (boundary / invalid inputs) ──────────────────────────

  it('should fall back to 24h window when no args provided', async () => {
    const before = Date.now();
    await mcpToolRegistry.execute('get_pr_digest', {}, {});
    const after = Date.now();

    expect(mockFetchMergedPRs).toHaveBeenCalledTimes(1);
    const [since, until] = mockFetchMergedPRs.mock.calls[0];

    const sinceMs = new Date(since).getTime();
    const untilMs = new Date(until).getTime();

    // since should be ~24h ago (within 1s of expected)
    expect(sinceMs).toBeGreaterThanOrEqual(before - DAY_MS - 1000);
    expect(sinceMs).toBeLessThanOrEqual(after - DAY_MS + 1000);
    // until should be ~now
    expect(untilMs).toBeGreaterThanOrEqual(before);
    expect(untilMs).toBeLessThanOrEqual(after + 1000);
  });

  it('should use 24h window when days_ago is 0 (degenerate case)', async () => {
    // days_ago: 0 is treated as 0 days = since === until, so fetchMergedPRs
    // is still called but with a very narrow (empty) window
    const before = Date.now();
    await mcpToolRegistry.execute('get_pr_digest', { days_ago: 0 }, {});
    const after = Date.now();

    expect(mockFetchMergedPRs).toHaveBeenCalledTimes(1);
    const [since, until] = mockFetchMergedPRs.mock.calls[0];

    const sinceMs = new Date(since).getTime();
    const untilMs = new Date(until).getTime();
    // since ≈ until (both ~now), window is ~0
    expect(Math.abs(sinceMs - untilMs)).toBeLessThan(1000);
    expect(untilMs).toBeGreaterThanOrEqual(before);
    expect(untilMs).toBeLessThanOrEqual(after + 1000);
  });

  it('should ignore explicit since when days_ago is also provided (days_ago takes precedence)', async () => {
    const explicitSince = '2020-01-01T00:00:00Z';
    const before = Date.now();
    await mcpToolRegistry.execute('get_pr_digest', { days_ago: 7, since: explicitSince }, {});
    const after = Date.now();

    const [since] = mockFetchMergedPRs.mock.calls[0];
    const sinceMs = new Date(since).getTime();

    // Should be ~7 days ago, NOT 2020
    expect(sinceMs).toBeGreaterThanOrEqual(before - 7 * DAY_MS - 1000);
    expect(sinceMs).toBeLessThanOrEqual(after - 7 * DAY_MS + 1000);
    expect(since).not.toBe(explicitSince);
  });

  // ─── SUCCESS tests ────────────────────────────────────────────────────

  it('should compute since as days_ago * 24h when days_ago: 7', async () => {
    const before = Date.now();
    await mcpToolRegistry.execute('get_pr_digest', { days_ago: 7 }, {});
    const after = Date.now();

    expect(mockFetchMergedPRs).toHaveBeenCalledTimes(1);
    const [since, until] = mockFetchMergedPRs.mock.calls[0];

    const sinceMs = new Date(since).getTime();
    const untilMs = new Date(until).getTime();

    // since should be ~7 days ago (within 1s)
    expect(sinceMs).toBeGreaterThanOrEqual(before - 7 * DAY_MS - 1000);
    expect(sinceMs).toBeLessThanOrEqual(after - 7 * DAY_MS + 1000);
    // until should be ~now
    expect(untilMs).toBeGreaterThanOrEqual(before);
    expect(untilMs).toBeLessThanOrEqual(after + 1000);
  });

  it('should compute since as days_ago * 24h when days_ago: 30', async () => {
    const before = Date.now();
    await mcpToolRegistry.execute('get_pr_digest', { days_ago: 30 }, {});
    const after = Date.now();

    const [since] = mockFetchMergedPRs.mock.calls[0];
    const sinceMs = new Date(since).getTime();

    expect(sinceMs).toBeGreaterThanOrEqual(before - 30 * DAY_MS - 1000);
    expect(sinceMs).toBeLessThanOrEqual(after - 30 * DAY_MS + 1000);
  });

  it('should use explicit since/until ISO strings when provided (no days_ago)', async () => {
    const since = '2026-04-06T00:00:00Z';
    const until = '2026-04-13T00:00:00Z';

    await mcpToolRegistry.execute('get_pr_digest', { since, until }, {});

    expect(mockFetchMergedPRs).toHaveBeenCalledWith(since, until);
  });

  it('should default until to now when only since is provided', async () => {
    const since = '2026-04-01T00:00:00Z';
    const before = Date.now();
    await mcpToolRegistry.execute('get_pr_digest', { since }, {});
    const after = Date.now();

    const [, until] = mockFetchMergedPRs.mock.calls[0];
    const untilMs = new Date(until).getTime();

    expect(mockFetchMergedPRs).toHaveBeenCalledWith(since, expect.any(String));
    expect(untilMs).toBeGreaterThanOrEqual(before);
    expect(untilMs).toBeLessThanOrEqual(after + 1000);
  });

  it('should return totalPRs, since, until, and text in the result', async () => {
    mockFetchMergedPRs.mockResolvedValue([
      {
        repo: 'agentweb',
        prs: [
          {
            number: 42,
            title: 'feat: test PR',
            html_url: 'https://github.com/org/agentweb/pull/42',
            user: { login: 'dev' },
            merged_at: '2026-04-12T10:00:00Z',
            body: null,
            additions: 10,
            deletions: 5,
            changed_files: 2,
          },
        ],
      },
      { repo: 'agentweb-customer-portal', prs: [] },
    ]);
    mockFormatDigestText.mockReturnValue('Digest: 1 PR(s)');

    const result = await mcpToolRegistry.execute('get_pr_digest', { days_ago: 7 }, {});
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.totalPRs).toBe(1);
    expect(parsed.since).toBeDefined();
    expect(parsed.until).toBeDefined();
    expect(parsed.text).toBe('Digest: 1 PR(s)');
    expect(parsed.results).toHaveLength(2);
  });

  it('should include days_ago in description to guide LLM on relative time ranges', () => {
    const defs = mcpToolRegistry.getToolDefinitions();
    const toolDef = defs.find((d: any) => d.name === 'get_pr_digest');
    const desc = toolDef.inputSchema.properties.days_ago.description as string;

    // Description should mention relative time and example
    expect(desc.toLowerCase()).toContain('days');
    expect(desc).toMatch(/\d/); // contains a number (example like 7)
  });
});
