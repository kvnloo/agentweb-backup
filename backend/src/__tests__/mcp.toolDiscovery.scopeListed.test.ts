/**
 * Opt-in scope tools must appear in tools/list for keys holding the scope —
 * MCP clients can only call listed tools — and stay hidden otherwise.
 */
jest.mock('../mcp/server/httpClient', () => ({ mcpFetch: jest.fn() }));

import '../mcp/server/apiTools';
import '../mcp/server/workflowTools';
import '../mcp/server/landingWorkflowTools';
import '../mcp/server/publishWorkflowTools';
import '../mcp/server/reviewSiteTool';
import '../mcp/server/readEmailTool';
import { getListedToolDefinitions } from '../mcp/server/toolDiscovery';

const names = (scopes?: string[]) => getListedToolDefinitions(scopes).map((d: any) => d.name);

describe('scope-listed tools', () => {
  it('lists read_email and list_connected_accounts for an email:read key', () => {
    const listed = names(['tools:read', 'tools:execute', 'email:read']);
    expect(listed).toContain('read_email');
    expect(listed).toContain('list_connected_accounts');
  });

  it('hides them for default keys and non-key callers', () => {
    for (const scopes of [undefined, ['tools:read', 'tools:execute']]) {
      const listed = names(scopes);
      expect(listed).not.toContain('read_email');
      expect(listed).not.toContain('list_connected_accounts');
    }
  });
});
