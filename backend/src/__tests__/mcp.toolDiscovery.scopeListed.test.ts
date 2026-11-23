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

describe('memory:org (ENG-2840 W2-2)', () => {
  const ORG_TOOLS = ['save_org_memory', 'delete_org_memory', 'list_memories'];

  it('lists the org memory write tools, and list_memories to find an id, for a key holding memory:org', () => {
    const listed = names(['tools:read', 'tools:execute', 'memory:org']);
    for (const name of ORG_TOOLS) expect(listed).toContain(name);
  });

  it('hides them for default keys and non-key callers', () => {
    for (const scopes of [undefined, ['tools:read', 'tools:execute'], ['tools:read']]) {
      const listed = names(scopes);
      for (const name of ORG_TOOLS) expect(listed).not.toContain(name);
    }
  });

  it('the user\'s own memory tools are not in tools/list for anyone (progressive disclosure: callable by name, found by search)', () => {
    for (const scopes of [undefined, ['tools:read', 'tools:execute'], ['tools:read', 'tools:execute', 'memory:org']]) {
      const listed = names(scopes);
      expect(listed).not.toContain('save_memory');
      expect(listed).not.toContain('delete_memory');
    }
  });

  it('the scope lists nothing else (the Smartlead and email tools stay hidden from a memory:org key)', () => {
    const listed = names(['tools:read', 'tools:execute', 'memory:org']);
    expect(listed).not.toContain('read_email');
    expect(listed).not.toContain('list_smartlead_campaigns');
  });
});
