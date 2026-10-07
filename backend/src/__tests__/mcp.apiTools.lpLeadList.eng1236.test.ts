jest.mock('../mcp/server/httpClient', () => ({
  mcpFetch: jest.fn(),
}));

import { mcpFetch } from '../mcp/server/httpClient';
import { mcpToolRegistry } from '../mcp/server/registry';
import '../mcp/server/apiTools';
import { readFileSync } from 'fs';
import { join } from 'path';

const mockMcpFetch = mcpFetch as jest.MockedFunction<typeof mcpFetch>;
const context = { userId: 'user-123', agentUserId: 'user-123' };

// ENG-1236 GAP 2: lead-list association must be settable on an existing page
// (including ENG-1238 imported external records) without regenerating it.
describe('set_landing_page_lead_list (ENG-1236)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('is registered and bridged to Emma', () => {
    expect(mcpToolRegistry.getToolNames()).toContain('set_landing_page_lead_list');
    // bridgedToolNames is module-private; pin the bridge entry so Emma's in-app loop can resolve it.
    expect(readFileSync(join(__dirname, '../emma/tools.ts'), 'utf8')).toMatch(/bridgedToolNames = \[[\s\S]*'set_landing_page_lead_list',[\s\S]*\];/);
  });

  it('PATCHes the existing lead-list endpoint with the list id', async () => {
    mockMcpFetch.mockResolvedValue({ id: 'p1', leadListId: 'list_1' } as any);
    await mcpToolRegistry.execute('set_landing_page_lead_list', { page_id: 'p1', lead_list_id: 'list_1' }, context);
    expect(mockMcpFetch).toHaveBeenCalledWith({
      method: 'PATCH',
      path: '/api/landing-pages/v0/generated/p1/lead-list',
      context,
      body: { leadListId: 'list_1' },
    });
  });

  it('clears the association when lead_list_id is null or empty', async () => {
    mockMcpFetch.mockResolvedValue({} as any);
    await mcpToolRegistry.execute('set_landing_page_lead_list', { page_id: 'p1', lead_list_id: null }, context);
    await mcpToolRegistry.execute('set_landing_page_lead_list', { page_id: 'p1', lead_list_id: '' }, context);
    for (const call of mockMcpFetch.mock.calls) expect((call[0] as any).body).toEqual({ leadListId: null });
  });

  it('url-encodes the page id', async () => {
    mockMcpFetch.mockResolvedValue({} as any);
    await mcpToolRegistry.execute('set_landing_page_lead_list', { page_id: 'a/b', lead_list_id: 'l' }, context);
    expect((mockMcpFetch.mock.calls[0][0] as any).path).toBe('/api/landing-pages/v0/generated/a%2Fb/lead-list');
  });
});
