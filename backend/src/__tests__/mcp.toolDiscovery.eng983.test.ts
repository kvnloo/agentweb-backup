/**
 * ENG-983 — progressive disclosure: small listed surface, long tail reachable
 * through emma_search_tools, nothing lost.
 */
const mockMcpFetch = jest.fn();
jest.mock('../mcp/server/httpClient', () => ({
  mcpFetch: (...args: any[]) => mockMcpFetch(...args),
}));

import { mcpToolRegistry } from '../mcp/server/registry';
import '../mcp/server/apiTools';
import '../mcp/server/evaluationTools';
import '../mcp/server/workflowTools';
import '../mcp/server/landingWorkflowTools';
import '../mcp/server/publishWorkflowTools';
import { getListedToolDefinitions, SEARCH_TOOL_NAME, listedToolNames } from '../mcp/server/toolDiscovery';

const CALLER = { userId: 'user-1', sessionId: 'sess-1', externalMcp: true };
const approxTokens = (defs: any[]) => Math.ceil(JSON.stringify(defs).length / 4);

function parse(result: any) {
  return JSON.parse(result.content[0].text);
}

describe('ENG-983: progressive disclosure', () => {
  beforeEach(() => jest.clearAllMocks());

  it('AC1: listed surface is workflow tools + discovery, at most 19 (ENG-1005 adds four)', () => {
    const listed = getListedToolDefinitions().map((d: any) => d.name);
    expect(listed.length).toBeLessThanOrEqual(19);
    expect(listed).toContain(SEARCH_TOOL_NAME);
    expect(listed).not.toContain('manage_leads');
    // Every configured listed name is actually registered (no dangling names).
    for (const n of listedToolNames()) expect(mcpToolRegistry.getTool(n)).toBeDefined();
    expect(mcpToolRegistry.getToolDefinitions().length).toBeGreaterThan(listed.length + 20);
  });

  it('AC2+AC3: unlisted granular tool is discovered with schema, then callable', async () => {
    const listed = getListedToolDefinitions().map((d: any) => d.name);
    expect(listed).not.toContain('list_lead_lists');

    const found = parse(await mcpToolRegistry.execute(SEARCH_TOOL_NAME, { query: 'lead lists' }, CALLER));
    const hit = found.tools.find((t: any) => t.name === 'list_lead_lists');
    expect(hit).toBeDefined();
    expect(hit.inputSchema).toEqual(mcpToolRegistry.getTool('list_lead_lists')!.definition.inputSchema);

    mockMcpFetch.mockResolvedValueOnce({ leadLists: [{ id: 'L1' }] });
    const out = await mcpToolRegistry.execute('list_lead_lists', {}, CALLER);
    expect(mockMcpFetch).toHaveBeenCalled();
    expect(JSON.stringify(out)).toContain('L1');
  });

  it('discovery never returns internal tools or already-listed tools', async () => {
    const external = new Set(mcpToolRegistry.getToolDefinitions().map((d: any) => d.name));
    for (const q of ['search', 'email send', 'file', 'browser cookie', 'image', 'google ads']) {
      const r = parse(await mcpToolRegistry.execute(SEARCH_TOOL_NAME, { query: q, limit: 20 }, CALLER));
      for (const t of r.tools) {
        expect(external.has(t.name)).toBe(true);
        expect(listedToolNames()).not.toContain(t.name);
      }
    }
  });

  it('AC5: internal listing still includes every registered tool', () => {
    expect(mcpToolRegistry.getAllToolDefinitions().length).toBe(mcpToolRegistry.getToolNames().length);
  });

  it('AC6: every registered tool is reachable by name', () => {
    for (const name of mcpToolRegistry.getToolNames()) {
      expect(typeof mcpToolRegistry.getTool(name)?.execute).toBe('function');
    }
  });

  it('AC4: per-turn schema cost is materially lower (printed for PR body)', () => {
    const before = approxTokens(mcpToolRegistry.getToolDefinitions());
    const after = approxTokens(getListedToolDefinitions());
    // eslint-disable-next-line no-console
    console.log(`ENG-983 schema tokens/turn ≈ before ${before} → after ${after}`);
    expect(after).toBeLessThan(before / 2);
  });
});
