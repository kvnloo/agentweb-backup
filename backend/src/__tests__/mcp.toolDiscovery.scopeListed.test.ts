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
import { getListedToolDefinitions, searchTools } from '../mcp/server/toolDiscovery';
import '../mcp/server/memoryTools';

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

describe('memory:org: what a key is offered must be what it can call (Opslane, first W2-2 head)', () => {
  it('a key that holds ONLY memory:org is offered the two org write tools but not list_memories (a read needs tools:read)', () => {
    const listed = names(['memory:org']);
    expect(listed).toContain('save_org_memory');
    expect(listed).toContain('delete_org_memory');
    expect(listed).not.toContain('list_memories');
  });

  it('list_memories is offered to a memory:org key that can also read or execute', () => {
    expect(names(['tools:read', 'memory:org'])).toContain('list_memories');
    expect(names(['tools:execute', 'memory:org'])).toContain('list_memories');
  });

  it('a key without memory:org is never offered it, whatever else it holds', () => {
    expect(names(['tools:read', 'tools:execute'])).not.toContain('list_memories');
  });
});

describe('emma_search_tools and the memory tools (the apiKeyOnly filter of the search)', () => {
  const find = (caller?: any) => searchTools('save delete org memory', 20, caller).map((d: any) => d.name);
  const KEY = (scopes: string[]) => ({ externalMcp: true, authMethod: 'api_key', apiKeyScopes: scopes });

  it('does not offer the org write tools to a default key, an OAuth client or an anonymous caller (they would be refused)', () => {
    for (const caller of [KEY(['tools:read', 'tools:execute']), { externalMcp: true, authMethod: 'oauth' }, { externalMcp: true, authMethod: 'anonymous' }]) {
      const found = find(caller);
      expect(found).not.toContain('save_org_memory');
      expect(found).not.toContain('delete_org_memory');
    }
  });

  it('offers them to a key that holds memory:org, and to an in-process caller', () => {
    for (const caller of [KEY(['tools:read', 'tools:execute', 'memory:org']), undefined, { externalMcp: false }]) {
      const found = find(caller);
      expect(found).toContain('save_org_memory');
      expect(found).toContain('delete_org_memory');
    }
  });

  it('offers the user\'s own memory tools to every caller, since none of them is refused', () => {
    for (const caller of [KEY(['tools:read', 'tools:execute']), { externalMcp: true, authMethod: 'oauth' }]) {
      const found = searchTools('save memory', 20, caller).map((d: any) => d.name);
      expect(found).toContain('save_memory');
    }
  });
});

import '../mcp/server/gtmEmailTool';

describe('gtm:email (ENG-2840, emailing GTM reports over MCP)', () => {
  const KEY = (scopes: string[]) => ({ externalMcp: true, authMethod: 'api_key', apiKeyScopes: scopes });
  const find = (caller: any) => searchTools('email a gtm status report', 20, caller).map((d: any) => d.name);

  it('lists send_gtm_status_report for a key holding gtm:email', () => {
    expect(names(['tools:read', 'tools:execute', 'gtm:email'])).toContain('send_gtm_status_report');
  });

  it('hides it for default keys, read-only keys and non-key callers', () => {
    for (const scopes of [undefined, ['tools:read', 'tools:execute'], ['tools:read']]) {
      expect(names(scopes)).not.toContain('send_gtm_status_report');
    }
  });

  it('the scope lists only that tool (the org memory, Smartlead and mailbox tools stay hidden from a gtm:email key)', () => {
    const listed = names(['tools:read', 'tools:execute', 'gtm:email']);
    for (const hidden of ['save_org_memory', 'delete_org_memory', 'read_email', 'list_smartlead_campaigns']) expect(listed).not.toContain(hidden);
  });

  it('a key that holds only gtm:email is offered the tool it can call, and no read it could not make', () => {
    const listed = names(['gtm:email']);
    expect(listed).toContain('send_gtm_status_report');
    expect(listed).not.toContain('list_memories');
  });

  it('search does not offer it to a default key, an OAuth client or an anonymous caller (they would be refused)', () => {
    for (const caller of [KEY(['tools:read', 'tools:execute']), { externalMcp: true, authMethod: 'oauth' }, { externalMcp: true, authMethod: 'anonymous' }]) {
      expect(find(caller)).not.toContain('send_gtm_status_report');
    }
  });

  it('search offers it to a key that holds gtm:email, and to an in-process caller', () => {
    for (const caller of [KEY(['tools:read', 'tools:execute', 'gtm:email']), undefined, { externalMcp: false }]) {
      expect(find(caller)).toContain('send_gtm_status_report');
    }
  });
});
