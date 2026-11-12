/**
 * ENG-2898: get_conversion_summary — own-account aggregates only.
 */
jest.mock('../mcp/server/httpClient', () => ({
  mcpFetch: jest.fn(),
  generateSelfCallToken: jest.fn().mockReturnValue('mock-token'),
  clearUserCache: jest.fn(),
}));

import { mcpFetch } from '../mcp/server/httpClient';
import { mcpToolRegistry } from '../mcp/server/registry';
import { findScopeDenial } from '../mcp/server/apiKeyScopes';
import { resolveRange } from '../mcp/server/conversionSummaryTool';
import '../mcp/server/apiTools';

const mockFetch = mcpFetch as jest.MockedFunction<typeof mcpFetch>;
const parse = (r: any) => JSON.parse(r.content[0].text);

// Two principals whose data the fake backend keys strictly by context.userId.
const DATA: Record<string, any> = {
  alice: {
    lists: [
      { id: 'la', userId: 'alice', name: 'Alice LP leads', listType: 'sales' },
      { id: 'lb-shared', userId: 'bob', name: 'Bob org list', fromOrgMember: true },
      // Opslane run 1790: session lists hold visit rows, not leads.
      { id: 'ls', userId: 'alice', name: 'Alice sessions', listType: 'session' },
    ],
    pages: [
      { id: 'pa', userId: 'alice', name: 'Alice LP', deployedUrl: 'https://alice.agentwebforms.com/offer?t=secret' },
      { id: 'pb', userId: 'bob', name: 'Bob LP (org)' },
    ],
    leads: {
      la: [
        { email: 'x@ex.com', createdAt: '2026-11-01T10:00:00Z', customFields: { landingPageId: 'pa' } },
        { email: 'X@ex.com', createdAt: '2026-11-02T10:00:00Z', lastTouch: { landingUrl: 'https://alice.agentwebforms.com/offer/?utm=1' } },
        { email: 'y@ex.com', createdAt: '2026-11-03T10:00:00Z' },
        { email: 'old@ex.com', createdAt: '2025-01-01T00:00:00Z', customFields: { lpId: 'pa' } },
      ],
      'lb-shared': [{ email: 'bobsecret@ex.com', createdAt: '2026-11-01T00:00:00Z' }],
      ls: [{ email: 's1@session.local', createdAt: '2026-11-01T00:00:00Z', customFields: { landingPageId: 'pa' } }],
    },
  },
  bob: {
    lists: [{ id: 'lb', userId: 'bob', name: 'Bob list' }],
    pages: [{ id: 'pb', userId: 'bob', name: 'Bob LP' }],
    leads: { lb: [{ email: 'bobsecret@ex.com', createdAt: '2026-11-01T00:00:00Z', customFields: { landingPageId: 'pb' } }] },
  },
};

beforeEach(() => {
  mockFetch.mockReset();
  mockFetch.mockImplementation(async (opts: any) => {
    const d = DATA[opts.context.userId];
    if (opts.path === '/api/crm/lists') return d.lists;
    if (opts.path === '/api/landing-pages/v0/generated') return { pages: d.pages };
    const m = /^\/api\/crm\/lists\/([^/]+)\/leads$/.exec(opts.path);
    if (m) return { leads: d.leads[decodeURIComponent(m[1])] ?? [], hasMore: false };
    throw new Error(`unexpected ${opts.path}`);
  });
});

const run = (userId: string, args: any = { start_date: '2026-10-15', end_date: '2026-11-10' }) =>
  mcpToolRegistry.execute('get_conversion_summary', args, { userId, agentUserId: userId });

describe('ENG-2898 get_conversion_summary', () => {
  it('aggregates the caller own lists and pages only', async () => {
    const out = parse(await run('alice'));
    expect(out.lists).toEqual([{ list_id: 'la', name: 'Alice LP leads', list_type: 'sales', leads: 3 }]);
    expect(out.landing_pages).toEqual([{ page_id: 'pa', name: 'Alice LP', leads: 1, conversions: 2 }]);
    expect(out.totals).toEqual({ leads: 3, landing_page_conversions: 2, lists: 1, landing_pages: 1 });
    expect(out.truncated).toBe(false);
    // Never fetched the org member list's leads.
    expect(mockFetch.mock.calls.some((c: any) => c[0].path.includes('lb-shared'))).toBe(false);
    expect(mockFetch.mock.calls.some((c: any) => c[0].path.includes('/ls/'))).toBe(false);
  });

  it('two principals see no cross-account data', async () => {
    const a = JSON.stringify(parse(await run('alice')));
    const b = parse(await run('bob'));
    expect(a).not.toMatch(/bob|"lb"|"pb"/i);
    expect(b.lists.map((l: any) => l.list_id)).toEqual(['lb']);
    expect(JSON.stringify(b)).not.toMatch(/alice|"la"|"pa"/i);
  });

  it('outputs no PII or URLs', async () => {
    const text = JSON.stringify(parse(await run('alice')));
    expect(text).not.toMatch(/@|https?:|secret|utm/);
  });

  it.each([{ client_id: 'bob' }, { user_id: 'bob' }, { userId: 'bob' }])('rejects %j without fetching', async (extra) => {
    await expect(run('alice', { ...extra })).rejects.toThrow(/own account/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it.each([
    [{ start_date: '2025-01-01', end_date: '2026-11-10' }, /maximum is 366 days/],
    [{ start_date: '2026-11-10', end_date: '2026-11-01' }, /on or before/],
    [{ start_date: '11/01/2026' }, /YYYY-MM-DD/],
  ])('rejects range %j', async (args, msg) => {
    await expect(run('alice', args)).rejects.toThrow(msg);
  });

  it('accepts exactly 366 days and defaults to last 30', () => {
    expect(() => resolveRange({ start_date: '2024-01-01', end_date: '2024-12-31' })).not.toThrow();
    expect(() => resolveRange({ start_date: '2026-02-30', end_date: '2026-03-05' })).toThrow('start_date is not a valid date');
    const r = resolveRange({}, Date.parse('2026-11-10T12:00:00Z'));
    expect(r).toMatchObject({ start: '2026-10-12', end: '2026-11-10' });
  });

  it('Opslane run 1790: lp_id / landing-page-id spellings count as page conversions', async () => {
    mockFetch.mockImplementation(async (opts: any) => {
      if (opts.path === '/api/crm/lists') return [{ id: 'L', userId: 'dan', name: 'L' }];
      if (opts.path === '/api/landing-pages/v0/generated') return { pages: [{ id: 'w3', userId: 'dan', name: 'W3' }] };
      return { leads: [
        { email: 'a@x.co', createdAt: '2026-11-01T00:00:00Z', customFields: { lp_id: 'w3' } },
        { email: 'b@x.co', createdAt: '2026-11-01T00:00:00Z', customFields: { 'landing-page-id': 'w3' } },
        { email: 'c@x.co', createdAt: '2026-11-01T00:00:00Z', customFields: { landingPageId: 'w3' } },
      ], hasMore: false };
    });
    const out = parse(await run('dan'));
    expect(out.landing_pages).toEqual([{ page_id: 'w3', name: 'W3', leads: 3, conversions: 3 }]);
  });

  it('is readOnly and callable with a tools:read key', () => {
    const tool = mcpToolRegistry.getTool('get_conversion_summary') as any;
    expect(tool.readOnly).toBe(true);
    const req = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_conversion_summary', arguments: {} } };
    expect(findScopeDenial(req, ['tools:read'], (n) => mcpToolRegistry.getTool(n) as any)).toBeNull();
  });
  it('Opslane run 1788: reads listId-shaped lists, sourceId/case variants, blank dates, failed lists', async () => {
    const leadsCalls: any[] = [];
    mockFetch.mockImplementation(async (opts: any) => {
      if (opts.path === '/api/crm/lists') return [{ listId: 'L1', userId: 'carol', name: 'Real shape' }, { listId: 'L2', userId: 'carol', name: 'Broken' }];
      if (opts.path === '/api/landing-pages/v0/generated') return { pages: [{ id: 'lp-W2', userId: 'carol', name: 'P' }] };
      if (opts.path.includes('/L2/')) throw new Error('500 InternalFailure');
      leadsCalls.push(opts.queryParams);
      return {
        leads: [
          { email: 'a@x.com', createdAt: new Date().toISOString(), customFields: { sourceId: 'lp-w2' } },
          { email: 'b@x.com', createdAt: new Date().toISOString(), customFields: { LANDINGPAGEID: 'lp-W2' } },
          { email: 'c@x.com', createdAt: new Date().toISOString(), customFields: { landing_page_id: 'lp-W2' } },
        ],
        hasMore: false,
      };
    });
    const out = parse(await run('carol', { start_date: ' ', end_date: null }));
    expect(out.lists).toEqual([{ list_id: 'L1', name: 'Real shape', list_type: null, leads: 3 }]);
    expect(out.landing_pages[0]).toMatchObject({ page_id: 'lp-W2', conversions: 3, leads: 3 });
    expect(out.skipped_lists).toEqual([{ list_id: 'L2', name: 'Broken' }]);
    expect(leadsCalls[0].limit).toBe('200');
    // Opslane run 1792: engaged-only lists must not filter the count to 0.
    expect(leadsCalls[0].engagedOnly).toBe('false');
  });
});
