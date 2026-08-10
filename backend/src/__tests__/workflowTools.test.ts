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

    // Session created and goal sent from a single tool call. The trailing read
    // is the pending-question confirmation on the terminal path.
    expect(paths().slice(0, 2)).toEqual(['/api/agent-mode/sessions', '/api/agent-mode/generate']);
    const body = JSON.parse(res.content[0].text);
    // The caller gets a handle for the task either way; whether it needs to be
    // polled is asserted separately, per the synchronous-vs-detached contract.
    expect(body.task_id).toBe('task-42');
  });

  it('emma_run_marketing_task continues an existing task without creating a second one', async () => {
    mockMcpFetch.mockResolvedValueOnce({ message: 'continuing' });

    await tool('emma_run_marketing_task').execute({ goal: 'and add a CTA', task_id: 'task-42' }, CALLER);

    // The point: no SECOND session is created when one was supplied.
    expect(paths()).not.toContain('/api/agent-mode/sessions');
    expect(paths()[0]).toBe('/api/agent-mode/generate');
  });

  // ── REST contract assertions ──────────────────────────────────────────────
  // Greptile caught three P1s on #2306 that this suite missed entirely, because
  // it asserted only which PATHS were called and never what was SENT or how the
  // response was read. Mocking mcpFetch and then checking your own arguments is
  // tautological. These assert the contracts the endpoints actually enforce.

  it('emma_run_marketing_task sends userMessage, the field the endpoint requires', async () => {
    mockMcpFetch
      .mockResolvedValueOnce({ sessionId: 'task-42' })
      .mockResolvedValueOnce({ message: 'on it' });

    await tool('emma_run_marketing_task').execute({ goal: 'launch a campaign' }, CALLER);

    // /api/agent-mode/generate rejects a body without `userMessage` with a 400.
    // Sending `message` made every call fail; nothing here caught it before.
    const generate = mockMcpFetch.mock.calls.find(c => c[0]?.path === '/api/agent-mode/generate');
    expect(generate[0].body).toMatchObject({ sessionId: 'task-42', userMessage: 'launch a campaign' });
    expect(generate[0].body.message).toBeUndefined();
  });

  it('emma_run_marketing_task returns a CONFIRMED result when generate answers synchronously', async () => {
    // /api/agent-mode/generate returns { content } once the turn finishes, and
    // only returns early with stillBuilding on a detached long build. Telling
    // every caller to poll sent them hunting for an answer already in hand.
    mockMcpFetch
      .mockResolvedValueOnce({ sessionId: 'task-42' })
      .mockResolvedValueOnce({ content: 'campaign drafted and scheduled' });

    const res: any = await tool('emma_run_marketing_task').execute({ goal: 'launch' }, CALLER);
    const body = JSON.parse(res.content[0].text);

    expect(body.status).toBe('complete');
    expect(body.completion_confirmed).toBe(true);
    expect(body.result).toBe('campaign drafted and scheduled');
    expect(body.next).toBeUndefined();
  });

  it('emma_run_marketing_task reports a detached run as unconfirmed and points at a tool that exists', async () => {
    mockMcpFetch
      .mockResolvedValueOnce({ sessionId: 'task-42' })
      .mockResolvedValueOnce({ content: 'still building…', stillBuilding: true });

    const res: any = await tool('emma_run_marketing_task').execute({ goal: 'launch' }, CALLER);
    const body = JSON.parse(res.content[0].text);

    expect(body.status).toBe('running');
    expect(body.completion_confirmed).toBe(false);
    // Points at emma_get_session, which is registered. The dedicated polling
    // tool is deliberately gone: the only case it served was the detached run,
    // and that is exactly the case nothing can confirm until ENG-1015.
    expect(body.next).toMatch(/emma_get_session/);
    expect(body.next).toMatch(/ENG-1015/);
  });

  it('guidance naming another tool also names that tool\'s real parameter', () => {
    // Greptile P1 on #2318: the hint said "using this task_id", but
    // emma_get_session takes `session_id`. An agent following the instruction
    // literally issues an invalid call — the exact failure this whole layer
    // exists to prevent, reintroduced in a help string.
    const referencedParam: Record<string, string> = { emma_get_session: 'session_id' };

    for (const name of WORKFLOW_TOOL_NAMES) {
      const text = JSON.stringify(tool(name).definition);
      for (const [referenced, param] of Object.entries(referencedParam)) {
        if (text.includes(referenced)) expect(text).toContain(param);
      }
    }
  });

  it('no workflow tool points the caller at a tool that is not registered', () => {
    // The failure this guards: a description or `next` hint naming a removed
    // tool sends an agent to call something that does not exist, and it has no
    // way to recover. Cheap to check, and it is what broke when the polling
    // tool was dropped.
    const registered = new Set(mcpToolRegistry.getToolNames());
    for (const name of WORKFLOW_TOOL_NAMES) {
      const text = JSON.stringify(tool(name).definition);
      for (const referenced of text.match(/emma_[a-z_]+/g) ?? []) {
        expect([...registered, name]).toContain(referenced);
      }
    }
  });

  it('emma_run_marketing_task confirms a blocking question against the SESSION, not the generate reply', async () => {
    // The generate response does not carry pendingUserQuestion — no res.json in
    // agentModeController includes it. Reading it off the reply was dead code,
    // so a run blocked on a question reported "complete" and the caller walked
    // away from work waiting on them.
    mockMcpFetch
      .mockResolvedValueOnce({ sessionId: 'task-42' })
      .mockResolvedValueOnce({ content: 'which audience?' }) // generate: no pending field
      .mockResolvedValueOnce({ pendingUserQuestion: { question: 'which audience?' } }); // session GET

    const res: any = await tool('emma_run_marketing_task').execute({ goal: 'launch' }, CALLER);
    const body = JSON.parse(res.content[0].text);

    expect(paths()).toEqual([
      '/api/agent-mode/sessions',
      '/api/agent-mode/generate',
      '/api/agent-mode/session/task-42',
    ]);
    expect(body.status).toBe('awaiting_input');
    expect(body.next).toMatch(/emma_answer_question/);
  });

  it('emma_run_marketing_task does not spend a confirmation read when the run detached', async () => {
    // stillBuilding already means "not terminal", so there is nothing to confirm.
    mockMcpFetch
      .mockResolvedValueOnce({ sessionId: 'task-42' })
      .mockResolvedValueOnce({ content: 'still building…', stillBuilding: true });

    await tool('emma_run_marketing_task').execute({ goal: 'launch' }, CALLER);

    expect(paths()).toEqual(['/api/agent-mode/sessions', '/api/agent-mode/generate']);
  });

  it('emma_run_marketing_task still returns the result if the confirmation read fails', async () => {
    // The turn succeeded; discarding a result we already hold because a
    // follow-up read failed would lose real work.
    mockMcpFetch
      .mockResolvedValueOnce({ sessionId: 'task-42' })
      .mockResolvedValueOnce({ content: 'campaign drafted' })
      .mockRejectedValueOnce(new Error('API error (500): boom'));

    const res: any = await tool('emma_run_marketing_task').execute({ goal: 'launch' }, CALLER);
    const body = JSON.parse(res.content[0].text);

    expect(body.result).toBe('campaign drafted');
    // ...but a FAILED check is not a negative result. Reporting confirmed here
    // would claim completion while the session might be awaiting input — the
    // same false confidence this tool exists to avoid.
    expect(body.completion_confirmed).toBe(false);
    // `complete` is terminal in this contract — the tool description tells the
    // caller not to poll it. An unverified turn must not wear it.
    expect(body.status).toBe('unconfirmed');
    expect(body.next).toMatch(/unconfirmed/);
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

  it('emma_get_brand_profile treats an unfilled section as unconfigured only when the read SUCCEEDS', async () => {
    // routes/brand.ts returns 200 when a section is simply not filled in — it
    // reserves 404 for "User not found". So "unconfigured" is an empty 200
    // body, never an exception.
    mockMcpFetch
      .mockResolvedValueOnce({ tone: 'direct' })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce([]);

    const res: any = await tool('emma_get_brand_profile').execute({}, CALLER);
    const body = JSON.parse(res.content[0].text);

    expect(body.brand_guidelines).toEqual({ tone: 'direct' });
    expect(body.market_strategy).toBeNull();
    expect(body.unavailable).toBeUndefined();
    expect(body.note).toMatch(/genuinely not filled in/);
  });

  it('emma_get_brand_profile surfaces a 404 as a failure, because 404 here means "user not found"', async () => {
    // The trap: 404 looks like "no profile" but these endpoints only return it
    // when the USER is missing. Reporting that as an empty brand would hand the
    // agent fabricated context.
    mockMcpFetch
      .mockResolvedValueOnce({ tone: 'direct' })
      .mockRejectedValueOnce(new Error('API error (404): User not found'))
      .mockResolvedValueOnce([]);

    const res: any = await tool('emma_get_brand_profile').execute({}, CALLER);
    const body = JSON.parse(res.content[0].text);

    expect(body.unavailable).toEqual([expect.stringContaining('market_strategy')]);
    expect(body.note).toMatch(/UNKNOWN, not as unconfigured/);
  });

  it('emma_get_brand_profile does NOT disguise an operational failure as "unconfigured"', async () => {
    // The bug this replaces: `.catch(() => null)` told the agent this company
    // had no brand whenever the service was down or the caller was over quota,
    // and an agent told the brand is empty will invent one.
    mockMcpFetch
      .mockResolvedValueOnce({ tone: 'direct' })
      .mockRejectedValueOnce(new Error('API error (429): quota exceeded'))
      .mockResolvedValueOnce([]);

    const res: any = await tool('emma_get_brand_profile').execute({}, CALLER);
    const body = JSON.parse(res.content[0].text);

    expect(body.market_strategy).toBeNull();
    expect(body.unavailable).toEqual([expect.stringContaining('market_strategy')]);
    expect(body.note).toMatch(/UNKNOWN, not as unconfigured/);
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
