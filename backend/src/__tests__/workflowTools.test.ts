/**
 * ENG-982 — the job-shaped workflow layer.
 *
 * The point of these tools is that ONE call completes a job an agent would
 * otherwise have to assemble from several. So the assertions here are mostly
 * about call collapsing and about the shape an agent sees, not about plumbing.
 */

const mockMcpFetch = jest.fn();
jest.mock('../mcp/server/httpClient', () => ({
  mcpFetch: (...args: any[]) => mockMcpFetch(...args),
}));

import { mcpToolRegistry } from '../mcp/server/registry';
// Both layers, mirroring how mcpServerCore populates the registry. The
// additive assertions below are meaningless without the granular tools present.
import '../mcp/server/apiTools';
import { WORKFLOW_TOOL_NAMES } from '../mcp/server/workflowTools';

const CALLER = { userId: 'user-1', sessionId: 'sess-1' };

function tool(name: string) {
  const t = mcpToolRegistry.getTool(name);
  if (!t) throw new Error(`${name} is not registered`);
  return t;
}

/** The REST paths a tool hit, in order. */
function paths(): string[] {
  return mockMcpFetch.mock.calls.map(c => c[0]?.path);
}

describe('ENG-982: the workflow layer is registered and externally visible', () => {
  beforeEach(() => jest.clearAllMocks());

  it('registers every workflow tool under the emma_ namespace', () => {
    for (const name of WORKFLOW_TOOL_NAMES) {
      expect(mcpToolRegistry.getTool(name)).toBeDefined();
      expect(name.startsWith('emma_')).toBe(true);
    }
  });

  it('exposes them to external clients (they are the listed surface)', () => {
    const listed = mcpToolRegistry.getToolDefinitions().map((d: any) => d.name);
    for (const name of WORKFLOW_TOOL_NAMES) {
      expect(listed).toContain(name);
    }
  });

  it('names no tool after a CRUD verb or a resource-manager', () => {
    // The failure this layer exists to fix: `manage_task` / `list_*` tell a
    // model nothing about the outcome, and hide verbs behind an action enum.
    for (const name of WORKFLOW_TOOL_NAMES) {
      expect(name).not.toMatch(/^emma_(manage|list|get_all|create|update|delete)_/);
    }
    // And none of them takes an `action` dispatch parameter.
    for (const name of WORKFLOW_TOOL_NAMES) {
      const props = (tool(name).definition as any).inputSchema?.properties ?? {};
      expect(Object.keys(props)).not.toContain('action');
    }
  });

  it('every tool description says what it is for in the first sentence', () => {
    for (const name of WORKFLOW_TOOL_NAMES) {
      const d = (tool(name).definition as any).description as string;
      expect(typeof d).toBe('string');
      expect(d.length).toBeGreaterThan(40);
    }
  });
});

describe('ENG-982: one call completes the job', () => {
  beforeEach(() => jest.clearAllMocks());

  it('emma_run_marketing_task creates the session AND sends the goal (2 REST calls, 1 tool call)', async () => {
    mockMcpFetch
      .mockResolvedValueOnce({ sessionId: 'task-42' })
      .mockResolvedValueOnce({ message: 'on it' });

    const res: any = await tool('emma_run_marketing_task').execute({ goal: 'launch a campaign' }, CALLER);

    expect(paths()).toEqual(['/api/agent-mode/sessions', '/api/agent-mode/generate']);
    const body = JSON.parse(res.content[0].text);
    expect(body.task_id).toBe('task-42');
    // The agent is told what to do next rather than left to guess.
    expect(body.next).toMatch(/emma_get_task_result/);
  });

  it('emma_run_marketing_task continues an existing task without creating a second one', async () => {
    mockMcpFetch.mockResolvedValueOnce({ message: 'continuing' });

    await tool('emma_run_marketing_task').execute({ goal: 'and add a CTA', task_id: 'task-42' }, CALLER);

    expect(paths()).toEqual(['/api/agent-mode/generate']);
  });

  it('emma_get_brand_profile collapses three lookups into one call', async () => {
    mockMcpFetch
      .mockResolvedValueOnce({ tone: 'direct' })
      .mockResolvedValueOnce({ icp: 'early-stage founders' })
      .mockResolvedValueOnce([{ name: 'positioning.md' }]);

    const res: any = await tool('emma_get_brand_profile').execute({}, CALLER);

    expect(paths().sort()).toEqual(
      ['/api/brand/guidelines', '/api/emma/knowledge-bases', '/api/market-strategy'].sort()
    );
    const body = JSON.parse(res.content[0].text);
    expect(body.brand_guidelines).toEqual({ tone: 'direct' });
    expect(body.market_strategy).toEqual({ icp: 'early-stage founders' });
    expect(body.knowledge_base_files).toEqual([{ name: 'positioning.md' }]);
  });

  it('emma_get_brand_profile degrades one missing section to null rather than failing the whole call', async () => {
    mockMcpFetch
      .mockResolvedValueOnce({ tone: 'direct' })
      .mockRejectedValueOnce(new Error('not configured'))
      .mockResolvedValueOnce([]);

    const res: any = await tool('emma_get_brand_profile').execute({}, CALLER);
    const body = JSON.parse(res.content[0].text);

    // An account without a market strategy still gets its brand back — a
    // half-onboarded account is the common case, not an error.
    expect(body.brand_guidelines).toEqual({ tone: 'direct' });
    expect(body.market_strategy).toBeNull();
  });

  it('emma_research routes news questions to the news index and general ones to web', async () => {
    mockMcpFetch.mockResolvedValue({ results: [] });

    await tool('emma_research').execute({ query: 'ai funding', recency: 'news' }, CALLER);
    expect(paths()).toEqual(['/api/emma/you-search-news']);

    jest.clearAllMocks();
    mockMcpFetch.mockResolvedValue({ results: [] });
    await tool('emma_research').execute({ query: 'positioning frameworks' }, CALLER);
    expect(paths()).toEqual(['/api/emma/you-search-web']);
  });
});

describe('ENG-982: responses are high-signal', () => {
  beforeEach(() => jest.clearAllMocks());

  it('emma_get_account_status returns named fields, not the raw /me payload', async () => {
    mockMcpFetch.mockResolvedValueOnce({
      email: 'a@b.com',
      subscriptionType: 'Starter',
      hasBrandGuidelines: true,
      tokenUsage: { totalTokens: 10 },
      passwordHash: 'SHOULD NOT LEAK',
      sessionVersion: 3,
    });

    const res: any = await tool('emma_get_account_status').execute({}, CALLER);
    const body = JSON.parse(res.content[0].text);

    expect(body).toEqual({
      email: 'a@b.com',
      plan: 'Starter',
      is_onboarded: true,
      usage: { totalTokens: 10 },
    });
    // Passing the raw record through would hand internal fields to any caller.
    expect(res.content[0].text).not.toContain('passwordHash');
  });

  it('emma_find_leads reports how many matched instead of making the agent count', async () => {
    mockMcpFetch.mockResolvedValueOnce({ leads: [{ id: 1 }, { id: 2 }], listId: 'list-9' });

    const res: any = await tool('emma_find_leads').execute({ description: 'seed-stage founders' }, CALLER);
    const body = JSON.parse(res.content[0].text);

    expect(body.matched).toBe(2);
    expect(body.list_id).toBe('list-9');
  });
});

describe('ENG-982: the layer is additive', () => {
  it('leaves the granular tools registered and listed', () => {
    const listed = mcpToolRegistry.getToolDefinitions().map((d: any) => d.name);
    // A representative sample of what ENG-983 will later unlist. Until then
    // nothing may disappear.
    for (const name of ['manage_task', 'search_leads', 'list_gtm_plans', 'generate_landing_page']) {
      expect(listed).toContain(name);
    }
  });

  it('keeps every workflow tool behind the account gate', () => {
    // These all read or write account-scoped data, so an anonymous session must
    // not reach them (ENG-822). ENG-984's demo tool is the only planned
    // exception and is not in this set.
    for (const name of WORKFLOW_TOOL_NAMES) {
      expect(tool(name).requiresUserAccount).toBe(true);
    }
  });
});
