import { buildAgentRunTrace, cutWithoutSplittingPair, redactText, TRACE_LIMITS, type TraceMessageRow } from '../services/agentRunTrace';

let index = 0;
function row(message: Record<string, unknown>): TraceMessageRow {
  return { messageIndex: index++, message };
}
function call(id: string, name: string, args: Record<string, unknown>) {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}
function assistantCalls(...calls: ReturnType<typeof call>[]) {
  return row({ role: 'assistant', content: '', reasoning: 'private chain of thought', tool_calls: calls, usage: { prompt_tokens: 100, completion_tokens: 10, estimated_cost: 0.01 } });
}
function toolResult(id: string, name: string, content: string, ts: string) {
  return row({ role: 'tool', name, tool_call_id: id, content, metadata: { timestamp: ts } });
}

const SESSION = {
  sessionId: 's1',
  workPlan: {
    title: 'Weekly report',
    steps: [
      { stepCount: 1, title: 'Load metrics', status: 'completed', notes: 'Loaded 10 campaigns.', completedAt: '2026-10-14T10:02:24Z' },
      { stepCount: 2, title: 'Analyse', status: 'completed', notes: 'Analysed 4 files.' },
      { stepCount: 3, title: 'Create report', status: 'completed' },
    ],
  },
};

function plannedRun(): TraceMessageRow[] {
  index = 0;
  return [
    row({ role: 'system', content: 'system prompt', metadata: { timestamp: '2026-10-14T10:00:51Z' } }),
    row({ role: 'user', content: 'Run the weekly report plan.', metadata: { timestamp: '2026-10-14T10:00:51Z' } }),
    assistantCalls(call('c1', 'launch_predefined_work_plan', { planTitle: 'Weekly' })),
    toolResult('c1', 'launch_predefined_work_plan', '⚠️ Tool Error: launch_predefined_work_plan\nReason: Work plan template "Weekly" not found.', '2026-10-14T10:00:57Z'),
    assistantCalls(call('c2', 'manage_predefined_work_plan', { action: 'search' })),
    toolResult('c2', 'manage_predefined_work_plan', 'found plan_1', '2026-10-14T10:01:00Z'),
    assistantCalls(call('c3', 'launch_predefined_work_plan', { planId: 'plan_1' })),
    toolResult('c3', 'launch_predefined_work_plan', 'launched', '2026-10-14T10:01:30Z'),
    assistantCalls(call('c4', 'list_meta_ads_campaigns', { email: 'client@example.com', access_token: 'EAAB-should-not-leak' })),
    toolResult('c4', 'list_meta_ads_campaigns', '10 campaigns', '2026-10-14T10:01:53Z'),
    assistantCalls(call('c5', 'set_work_plan_status', { updates: [{ stepCount: 1, status: 'completed', notes: 'done' }] })),
    toolResult('c5', 'set_work_plan_status', 'Updated step 1', '2026-10-14T10:02:24Z'),
    assistantCalls(call('c6', 'perform_data_analysis', { file: 'a.csv' }), call('c7', 'perform_data_analysis', { file: 'b.csv' })),
    toolResult('c6', 'perform_data_analysis', 'insights a', '2026-10-14T10:03:30Z'),
    toolResult('c7', 'perform_data_analysis', 'insights b', '2026-10-14T10:04:16Z'),
    // Closes steps 2 and 3 at once: the calls go to step 2, step 3 is closed with no work of its own.
    assistantCalls(call('c8', 'set_work_plan_status', { updates: [{ stepCount: 2, status: 'completed' }, { stepCount: 3, status: 'completed' }] })),
    toolResult('c8', 'set_work_plan_status', 'Updated steps', '2026-10-14T10:06:12Z'),
    assistantCalls(call('c9', 'create_html_from_template', { templateId: 't1' })),
    toolResult('c9', 'create_html_from_template', 'https://bucket.s3.amazonaws.com/users/1/files/5a95cd2d231bea04bbf5a7c4aeb6f51a/report.html', '2026-10-14T10:07:24Z'),
    row({
      role: 'assistant',
      content: '<p>Report ready.</p>',
      usage: { prompt_tokens: 200, completion_tokens: 20, estimated_cost: 0.02 },
      metadata: {
        timestamp: '2026-10-14T10:07:42Z',
        memoryUsage: { currentRssMB: 300 },
        toolCalls: [
          { id: 'c1', name: 'launch_predefined_work_plan', duration: 71, error: 'Work plan template "Weekly" not found.' },
          { id: 'c6', name: 'perform_data_analysis', duration: 39_000 },
        ],
      },
    }),
  ];
}

describe('buildAgentRunTrace', () => {
  it('attributes calls to the step they served, with setup and unassigned buckets', () => {
    const trace = buildAgentRunTrace({ sessionId: 's1', session: SESSION, messages: plannedRun() });
    const [step1, step2, step3] = trace.workPlan!.steps;

    expect(trace.setupCallIds).toEqual(['c1', 'c2', 'c3']);
    expect(step1.callIds).toEqual(['c4', 'c5']);
    expect(step1.statusCallId).toBe('c5');
    expect(step1.closedWithoutCalls).toBe(false);
    expect(step2.callIds).toEqual(['c6', 'c7', 'c8']);
    expect(step3.callIds).toEqual([]);
    expect(step3.closedWithoutCalls).toBe(true);
    expect(trace.unassignedCallIds).toEqual(['c9']);
    expect(step1.notes).toBe('Loaded 10 campaigns.');
  });

  it('marks failures from the tool error text, takes durations from metadata, and links the recovery', () => {
    const trace = buildAgentRunTrace({ sessionId: 's1', session: SESSION, messages: plannedRun() });
    const byId = new Map(trace.calls.map((c) => [c.id, c]));

    expect(byId.get('c1')).toMatchObject({ status: 'failed', durationMs: 71, error: 'Work plan template "Weekly" not found.', recoveredByCallId: 'c3' });
    expect(byId.get('c6')).toMatchObject({ status: 'succeeded', durationMs: 39_000, result: 'insights a', endedAt: '2026-10-14T10:03:30Z' });
    expect(trace.calls).toHaveLength(9);
  });

  it('redacts secret-named arguments but keeps URLs readable', () => {
    const trace = buildAgentRunTrace({ sessionId: 's1', session: SESSION, messages: plannedRun() });
    const list = trace.calls.find((c) => c.id === 'c4')!;
    const report = trace.calls.find((c) => c.id === 'c9')!;

    expect(list.argsJson).not.toContain('EAAB');
    expect(list.argsJson).toMatch(/"access_token": "\[redacted\]"/i);
    expect(list.argsPreview).toMatch(/^email=client@example\.com access_token=\[redacted\]$/i);
    expect(report.result).toContain('5a95cd2d231bea04bbf5a7c4aeb6f51a/report.html');
  });

  it('redacts secrets in the ask, step notes and final reply too', () => {
    index = 0;
    const messages = [
      row({ role: 'user', content: 'Use api_key=sk-live-abcdef123456 for this', metadata: { timestamp: '2026-10-14T10:00:00Z' } }),
      row({ role: 'assistant', content: 'Done with Authorization: Bearer abc.def.ghi' }),
    ];
    const session = { workPlan: { steps: [{ stepCount: 1, title: 'x', status: 'completed', notes: 'used password=hunter2' }] } };
    const json = JSON.stringify(buildAgentRunTrace({ sessionId: 's', session, messages }));
    expect(json).not.toContain('sk-live-abcdef123456');
    expect(json).not.toContain('hunter2');
    expect(json).not.toContain('abc.def.ghi');
  });

  it('keeps max_tokens readable in arguments but masks session tokens', () => {
    index = 0;
    const messages = [assistantCalls(call('k', 'llm_call', { max_tokens: 500, session_token: 'zzz-secret' }))];
    const trace = buildAgentRunTrace({ sessionId: 's', messages });
    expect(trace.calls[0].argsPreview).toMatch(/^max_tokens=500 session_token=\[redacted\]$/i);
  });

  it('returns the ask, the final reply and summed usage, never reasoning or memory telemetry', () => {
    const trace = buildAgentRunTrace({ sessionId: 's1', session: SESSION, messages: plannedRun() });

    expect(trace.ask).toEqual({ text: 'Run the weekly report plan.', truncated: false });
    expect(trace.followUpAsks).toEqual([]);
    expect(trace.finalResponse).toEqual({ html: '<p>Report ready.</p>', truncated: false });
    expect(trace.usage).toEqual({ promptTokens: 1000, completionTokens: 100, estimatedCostUsd: 0.1 });
    const json = JSON.stringify(trace);
    expect(json).not.toContain('private chain of thought');
    expect(json).not.toContain('currentRssMB');
    expect(json).not.toContain('system prompt');
  });

  it('scopes a multi-run session to the run window', () => {
    index = 0;
    const messages = [
      row({ role: 'user', content: 'first run', metadata: { timestamp: '2026-10-14T09:00:00Z' } }),
      assistantCalls(call('old', 'search_web', { q: 'x' })),
      toolResult('old', 'search_web', 'old result', '2026-10-14T09:00:05Z'),
      row({ role: 'user', content: 'second run', metadata: { timestamp: '2026-10-14T10:00:00Z' } }),
      assistantCalls(call('new', 'search_web', { q: 'y' })),
      toolResult('new', 'search_web', 'new result', '2026-10-14T10:00:05Z'),
      row({ role: 'assistant', content: 'second answer' }),
    ];
    const trace = buildAgentRunTrace({ sessionId: 's2', messages, startedAt: '2026-10-14T10:00:00Z', completedAt: '2026-10-14T10:00:10Z' });

    expect(trace.ask?.text).toBe('second run');
    expect(trace.calls.map((c) => c.id)).toEqual(['new']);
    expect(trace.finalResponse?.html).toBe('second answer');
    expect(trace.workPlan).toBeUndefined();
    expect(trace.unassignedCallIds).toEqual(['new']);
  });

  it('puts a status update that closes nothing into the current segment, so every call is shown once', () => {
    index = 0;
    const messages = [
      assistantCalls(call('s1', 'set_work_plan_status', { updates: [{ stepCount: 1, status: 'pending' }] })),
      toolResult('s1', 'set_work_plan_status', 'ok', '2026-10-14T10:00:01Z'),
      assistantCalls(call('w1', 'load_data', {})),
      toolResult('w1', 'load_data', 'rows', '2026-10-14T10:00:02Z'),
      assistantCalls(call('s2', 'set_work_plan_status', { updates: [{ stepCount: 9, status: 'completed' }] })),
      toolResult('s2', 'set_work_plan_status', '⚠️ Tool Error: set_work_plan_status\nReason: step 9 not found', '2026-10-14T10:00:03Z'),
      assistantCalls(call('s3', 'set_work_plan_status', { updates: [{ stepCount: 1, status: 'completed' }] })),
      toolResult('s3', 'set_work_plan_status', 'ok', '2026-10-14T10:00:04Z'),
    ];
    const session = { workPlan: { steps: [{ stepCount: 1, title: 'Load', status: 'completed' }] } };
    const trace = buildAgentRunTrace({ sessionId: 's', session, messages });
    const shown = [...trace.setupCallIds, ...trace.workPlan!.steps.flatMap((st) => st.callIds), ...trace.unassignedCallIds];

    expect(trace.workPlan!.steps[0].callIds).toEqual(['s1', 'w1', 's2', 's3']);
    expect(shown.sort()).toEqual(trace.calls.map((c) => c.id).sort());
  });

  it('pairs results with calls in order when a provider reuses a tool-call id', () => {
    index = 0;
    const messages = [
      assistantCalls(call('call_0', 'load_data', { page: 1 })),
      toolResult('call_0', 'load_data', '⚠️ Tool Error: load_data\nReason: timeout', '2026-10-14T10:00:01Z'),
      assistantCalls(call('call_0', 'load_data', { page: 1 })),
      toolResult('call_0', 'load_data', 'rows: 10', '2026-10-14T10:00:05Z'),
    ];
    const trace = buildAgentRunTrace({ sessionId: 's', messages });

    expect(trace.calls.map((c) => [c.id, c.status])).toEqual([['call_0', 'failed'], ['call_0#2', 'succeeded']]);
    expect(trace.calls[0]).toMatchObject({ error: 'timeout', recoveredByCallId: 'call_0#2' });
    expect(trace.calls[1].result).toBe('rows: 10');
  });

  it('keeps back-to-back runs a second apart separate', () => {
    index = 0;
    const messages = [
      row({ role: 'user', content: 'run A', metadata: { timestamp: '2026-10-14T10:00:00Z' } }),
      assistantCalls(call('a1', 'load_data', {})),
      toolResult('a1', 'load_data', 'A rows', '2026-10-14T10:00:08Z'),
      row({ role: 'assistant', content: 'A done' }),
      row({ role: 'user', content: 'run B', metadata: { timestamp: '2026-10-14T10:00:11Z' } }),
      assistantCalls(call('b1', 'load_data', {})),
      toolResult('b1', 'load_data', 'B rows', '2026-10-14T10:00:12Z'),
      row({ role: 'assistant', content: 'B done' }),
    ];
    const a = buildAgentRunTrace({ sessionId: 's', messages, startedAt: '2026-10-14T10:00:00Z', completedAt: '2026-10-14T10:00:10Z' });
    const b = buildAgentRunTrace({ sessionId: 's', messages, startedAt: '2026-10-14T10:00:11Z', completedAt: '2026-10-14T10:00:13Z' });

    expect([a.ask?.text, a.calls.map((c) => c.id), a.followUpAsks, a.finalResponse?.html]).toEqual(['run A', ['a1'], [], 'A done']);
    expect([b.ask?.text, b.calls.map((c) => c.id), b.finalResponse?.html]).toEqual(['run B', ['b1'], 'B done']);
  });

  it('says when the plan shown is the session current one because the session ran again later', () => {
    index = 0;
    const messages = [
      row({ role: 'user', content: 'first', metadata: { timestamp: '2026-10-14T09:00:00Z' } }),
      row({ role: 'assistant', content: 'first done' }),
      row({ role: 'user', content: 'second', metadata: { timestamp: '2026-10-14T12:00:00Z' } }),
      row({ role: 'assistant', content: 'second done' }),
    ];
    const session = { workPlan: { steps: [{ stepCount: 1, title: 'Replanned', status: 'completed' }] } };
    const early = buildAgentRunTrace({ sessionId: 's', session, messages, startedAt: '2026-10-14T09:00:00Z', completedAt: '2026-10-14T09:00:30Z' });
    const late = buildAgentRunTrace({ sessionId: 's', session, messages, startedAt: '2026-10-14T12:00:00Z', completedAt: '2026-10-14T12:00:30Z' });

    expect(early.workPlanScope).toBe('session');
    expect(early.finalResponse?.html).toBe('first done');
    expect(late.workPlanScope).toBe('run');
  });

  it('reads older rows that have no message wrapper', () => {
    const messages = [
      { messageIndex: 0, role: 'user', content: 'old ask', metadata: { timestamp: '2026-10-14T10:00:00Z' } },
      { messageIndex: 1, role: 'assistant', content: '', tool_calls: [{ id: 'o1', function: { name: 'load_data', arguments: '{}' } }] },
      { messageIndex: 2, role: 'tool', tool_call_id: 'o1', content: 'rows' },
      { messageIndex: 3, role: 'assistant', content: 'old reply' },
    ] as unknown as TraceMessageRow[];
    const trace = buildAgentRunTrace({ sessionId: 's', messages });

    expect(trace.ask?.text).toBe('old ask');
    expect(trace.calls.map((c) => [c.id, c.status])).toEqual([['o1', 'succeeded']]);
    expect(trace.finalResponse?.html).toBe('old reply');
  });

  describe('run boundaries (fix review)', () => {
    const user = (content: string, ts: string) => row({ role: 'user', content, metadata: { timestamp: ts } });
    const reply = (content: string, ts?: string) => row({ role: 'assistant', content, ...(ts ? { metadata: { timestamp: ts } } : {}) });

    it('bounds an unfinished run by the next run, whose ask is saved before its start', () => {
      index = 0;
      const messages = [
        user('A', '2026-10-14T10:00:00Z'),
        assistantCalls(call('a1', 'load_data', {})),
        toolResult('a1', 'load_data', 'A rows', '2026-10-14T10:00:02Z'),
        reply('A partial'),
        user('B', '2026-10-14T10:00:10.950Z'),
        assistantCalls(call('b1', 'load_data', {})),
        toolResult('b1', 'load_data', 'B rows', '2026-10-14T10:00:12Z'),
        reply('B done'),
      ];
      const a = buildAgentRunTrace({ sessionId: 's', messages, startedAt: '2026-10-14T10:00:00Z', nextStartedAt: '2026-10-14T10:00:11Z' });
      expect([a.ask?.text, a.followUpAsks, a.calls.map((c) => c.id), a.finalResponse?.html]).toEqual(['A', [], ['a1'], 'A partial']);
    });

    it('keeps an ask saved well before the run started, and a mid-run reply with the calls around it', () => {
      index = 0;
      const messages = [
        user('A', '2026-10-14T10:00:00Z'),
        assistantCalls(call('w1', 'load_data', {})),
        toolResult('w1', 'load_data', 'r1', '2026-10-14T10:00:08Z'),
        assistantCalls(call('w2', 'load_data', {})),
        toolResult('w2', 'load_data', 'r2', '2026-10-14T10:00:12Z'),
        user('yes, go on', '2026-10-14T10:00:20Z'),
        assistantCalls(call('w3', 'load_data', {})),
        toolResult('w3', 'load_data', 'r3', '2026-10-14T10:00:25Z'),
        reply('done', '2026-10-14T10:00:30Z'),
      ];
      const t = buildAgentRunTrace({ sessionId: 's', messages, startedAt: '2026-10-14T10:00:07Z', completedAt: '2026-10-14T10:00:30Z' });
      expect([t.ask?.text, t.followUpAsks, t.calls.map((c) => c.id), t.finalResponse?.html]).toEqual(['A', ['yes, go on'], ['w1', 'w2', 'w3'], 'done']);
    });

    it('ends a finished run at a later user row that has no timestamp of its own', () => {
      index = 0;
      const messages = [
        user('A', '2026-10-14T10:00:00Z'),
        assistantCalls(call('a1', 'load_data', {})),
        toolResult('a1', 'load_data', 'A rows', '2026-10-14T10:00:12Z'),
        row({ role: 'user', content: 'B (legacy, no timestamp)' }),
        assistantCalls(call('b1', 'load_data', {})),
        row({ role: 'assistant', content: 'B done' }),
      ];
      const t = buildAgentRunTrace({ sessionId: 's', messages, startedAt: '2026-10-14T10:00:00Z', completedAt: '2026-10-14T10:00:10Z' });
      expect([t.followUpAsks, t.calls.map((c) => c.id)]).toEqual([[], ['a1']]);
    });

    it('keeps a mid-run user reply that has no timestamp of its own', () => {
      index = 0;
      const messages = [
        user('A', '2026-10-14T10:00:00Z'),
        toolResult('x', 'noop', 'r', '2026-10-14T10:00:02Z'),
        row({ role: 'user', content: 'yes' }),
        assistantCalls(call('a2', 'load_data', {})),
        toolResult('a2', 'load_data', 'r', '2026-10-14T10:00:05Z'),
      ];
      const t = buildAgentRunTrace({ sessionId: 's', messages, startedAt: '2026-10-14T10:00:00Z', completedAt: '2026-10-14T10:00:10Z' });
      expect([t.followUpAsks, t.calls.map((c) => c.id)]).toEqual([['yes'], ['a2']]);
    });

    it('does not treat a trailing system row as a later run', () => {
      index = 0;
      const messages = [
        user('A', '2026-10-14T10:00:00Z'),
        reply('A done', '2026-10-14T10:00:03Z'),
        row({ role: 'system', content: 'compacted', metadata: { timestamp: '2026-10-14T10:05:00Z' } }),
      ];
      const session = { workPlan: { steps: [{ stepCount: 1, title: 'x', status: 'completed' }] } };
      const t = buildAgentRunTrace({ sessionId: 's', session, messages, startedAt: '2026-10-14T10:00:00Z', completedAt: '2026-10-14T10:00:10Z' });
      expect([t.workPlanScope, t.finalResponse?.html]).toEqual(['run', 'A done']);
    });

    it('does not let one out-of-order timestamp end the run', () => {
      index = 0;
      const messages = [
        user('A', '2026-10-14T10:00:00Z'),
        assistantCalls(call('a1', 'load_data', {})),
        toolResult('a1', 'load_data', 'r', '2026-10-14T10:05:00Z'),
        assistantCalls(call('a2', 'load_data', {})),
        toolResult('a2', 'load_data', 'r', '2026-10-14T10:00:06Z'),
        reply('done', '2026-10-14T10:00:09Z'),
      ];
      const t = buildAgentRunTrace({ sessionId: 's', messages, startedAt: '2026-10-14T10:00:00Z', completedAt: '2026-10-14T10:00:10Z' });
      expect([t.calls.map((c) => [c.id, c.status]), t.finalResponse?.html]).toEqual([[['a1', 'succeeded'], ['a2', 'succeeded']], 'done']);
    });

    it("scopes the plan to the run when the only later row is the run's own late final reply", () => {
      index = 0;
      const messages = [user('A', '2026-10-14T10:00:00Z'), reply('done', '2026-10-14T10:00:16Z')];
      const session = { workPlan: { steps: [{ stepCount: 1, title: 'x', status: 'completed' }] } };
      const t = buildAgentRunTrace({ sessionId: 's', session, messages, startedAt: '2026-10-14T10:00:00Z', completedAt: '2026-10-14T10:00:10Z' });
      expect(t.workPlanScope).toBe('run');
    });
  });

  describe('call pairing and steps (fix review)', () => {
    it('does not shift later results onto an unanswered call that shares their id', () => {
      index = 0;
      const messages = [
        assistantCalls(call('call_0', 'search', {})),
        assistantCalls(call('call_0', 'fetch', {})),
        toolResult('call_0', 'fetch', 'fetched', '2026-10-14T10:00:02Z'),
        assistantCalls(call('call_0', 'fetch', {})),
        toolResult('call_0', 'fetch', '⚠️ Tool Error: fetch\nReason: 500', '2026-10-14T10:00:03Z'),
      ];
      const t = buildAgentRunTrace({ sessionId: 's', messages });
      expect(t.calls.map((c) => [c.id, c.name, c.status])).toEqual([
        ['call_0', 'search', 'no_result'],
        ['call_0#2', 'fetch', 'succeeded'],
        ['call_0#3', 'fetch', 'failed'],
      ]);
    });

    it('never gives two calls the same id when a provider id already contains #2', () => {
      index = 0;
      const messages = [
        assistantCalls(call('a', 'search', {})),
        toolResult('a', 'search', 'ok', '2026-10-14T10:00:01Z'),
        assistantCalls(call('a', 'set_work_plan_status', { updates: [{ stepCount: 1, status: 'completed' }] })),
        toolResult('a', 'set_work_plan_status', 'ok', '2026-10-14T10:00:02Z'),
        assistantCalls(call('a#2', 'set_work_plan_status', { updates: [{ stepCount: 1, status: 'pending' }] })),
        toolResult('a#2', 'set_work_plan_status', 'ok', '2026-10-14T10:00:03Z'),
      ];
      const session = { workPlan: { steps: [{ stepCount: 1, title: 'x', status: 'completed' }] } };
      const t = buildAgentRunTrace({ sessionId: 's', session, messages });
      const ids = t.calls.map((c) => c.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(t.workPlan!.steps[0].callIds).toEqual(['a', 'a#2']);
    });

    it('still flags a step closed with nothing but status updates, including a failed one and its retry', () => {
      index = 0;
      const messages = [
        assistantCalls(call('w', 'load_data', {})),
        toolResult('w', 'load_data', 'rows', '2026-10-14T10:00:01Z'),
        assistantCalls(call('c1', 'set_work_plan_status', { updates: [{ stepCount: 1, status: 'completed' }] })),
        toolResult('c1', 'set_work_plan_status', 'ok', '2026-10-14T10:00:02Z'),
        assistantCalls(call('c2', 'set_work_plan_status', { updates: [{ stepCount: 2, status: 'completed' }] })),
        toolResult('c2', 'set_work_plan_status', '❌ Cannot complete these steps yet: missing required calls', '2026-10-14T10:00:03Z'),
        assistantCalls(call('c3', 'set_work_plan_status', { updates: [{ stepCount: 2, status: 'completed' }] })),
        toolResult('c3', 'set_work_plan_status', 'ok', '2026-10-14T10:00:04Z'),
      ];
      const session = { workPlan: { steps: [{ stepCount: 1, title: 'a', status: 'completed' }, { stepCount: 2, title: 'b', status: 'completed' }] } };
      const t = buildAgentRunTrace({ sessionId: 's', session, messages });
      const step2 = t.workPlan!.steps[1];

      expect(t.calls.find((c) => c.id === 'c2')?.status).toBe('failed');
      expect(step2.callIds).toEqual(['c2', 'c3']);
      expect(step2.closedWithoutCalls).toBe(true);
    });

    it('keeps plan-management calls in setup after a status update that closes nothing', () => {
      index = 0;
      const messages = [
        assistantCalls(call('p', 'set_work_plan_status', { updates: [{ stepCount: 1, status: 'pending' }] })),
        toolResult('p', 'set_work_plan_status', 'ok', '2026-10-14T10:00:01Z'),
        assistantCalls(call('u', 'update_work_plan', {})),
        toolResult('u', 'update_work_plan', 'ok', '2026-10-14T10:00:02Z'),
        assistantCalls(call('w', 'load_data', {})),
        toolResult('w', 'load_data', 'rows', '2026-10-14T10:00:03Z'),
        assistantCalls(call('c', 'set_work_plan_status', { updates: [{ stepCount: 1, status: 'completed' }] })),
        toolResult('c', 'set_work_plan_status', 'ok', '2026-10-14T10:00:04Z'),
      ];
      const session = { workPlan: { steps: [{ stepCount: 1, title: 'a', status: 'completed' }] } };
      const t = buildAgentRunTrace({ sessionId: 's', session, messages });
      expect(t.setupCallIds).toEqual(['u']);
      expect(t.workPlan!.steps[0].callIds).toEqual(['p', 'w', 'c']);
    });
  });

  it('builds an ordered timeline of user and agent messages and calls', () => {
    const trace = buildAgentRunTrace({ sessionId: 's1', session: SESSION, messages: plannedRun() });
    const kinds = trace.timeline.map((e) => (e.kind === 'call' ? `call:${e.callId}` : `${e.kind}:${e.text.slice(0, 12)}`));

    expect(kinds[0]).toBe('user:Run the week');
    expect(kinds.slice(1, 4)).toEqual(['call:c1', 'call:c2', 'call:c3']);
    expect(kinds).toContain('call:c9');
    expect(kinds[kinds.length - 1]).toBe('agent:<p>Report re');
    expect(trace.timelineOmitted).toBe(0);
  });

  it('never cuts an emoji in half when it caps text, so the trace stays valid UTF-16 (ENG-2638)', () => {
    index = 0;
    const content = `${'x'.repeat(TRACE_LIMITS.resultChars - 1)}😀 and more`;
    const trace = buildAgentRunTrace({ sessionId: 's4', messages: [assistantCalls(call('e1', 'perform_data_analysis', {})), toolResult('e1', 'perform_data_analysis', content, '2026-10-14T10:00:00Z')] });

    expect(trace.calls[0].result).toBe('x'.repeat(TRACE_LIMITS.resultChars - 1));
    expect(trace.calls[0].resultTruncated).toBe(true);
  });

  it('caps large results and degrades every result when the run is over budget', () => {
    index = 0;
    const big = 'row of data '.repeat(Math.ceil((TRACE_LIMITS.resultChars + 100) / 12));
    const many = Array.from({ length: 60 }, (_, i) => [assistantCalls(call(`b${i}`, 'perform_data_analysis', {})), toolResult(`b${i}`, 'perform_data_analysis', big, '2026-10-14T10:00:00Z')]).flat();
    const trace = buildAgentRunTrace({ sessionId: 's3', messages: many });

    expect(trace.resultsDegraded).toBe(true);
    expect(trace.calls[0].result).toHaveLength(TRACE_LIMITS.degradedResultChars);
    expect(trace.calls[0]).toMatchObject({ resultTruncated: true, resultChars: big.length });
  });
});

describe('cutWithoutSplittingPair', () => {
  it.each([
    ['', 3, ''],
    ['abc', 0, ''],
    ['abc', 5, 'abc'],
    ['a😀', 3, 'a😀'],
    ['a😀', 2, 'a'],
    ['a\uDE00b', 2, 'a\uDE00'],
  ])('cuts %j at %i to %j, never leaving the first half of a pair (ENG-2638)', (text, max, expected) => {
    expect(cutWithoutSplittingPair(text, max)).toBe(expected);
  });
});

describe('redactText', () => {
  it('masks bearer tokens and key=value secrets but keeps URL paths and UUIDs', () => {
    const text = 'Authorization: Bearer abc.def.ghi session 04018080-3148-46de-9674-18d43ae3eb14 at https://x.test/a/0123456789abcdef0123456789abcdef?api_key=supersecretvalue1234567890';
    const out = redactText(text);

    expect(out).not.toContain('abc.def.ghi');
    expect(out).not.toContain('supersecretvalue');
    expect(out).toContain('04018080-3148-46de-9674-18d43ae3eb14');
    expect(out).toContain('https://x.test/a/0123456789abcdef0123456789abcdef');
  });

  it.each([
    ['aws_secret_access_key=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', 'wJalrXUtnFEMI'],
    ['X-Api-Key: 3f2b8c1e-9d4a-4b7e-8f6a-1c2d3e4f5a6b', '3f2b8c1e-9d4a'],
    ['X-Auth-Token: abcdef123456', 'abcdef123456'],
    ['Authorization: Bearer pat-na1-3f2b8c1e-9d4a-4b7e-8f6a-1c2d3e4f5a6b', 'pat-na1'],
    ['fetch https://admin:hunter2@db.example.com/stats', 'hunter2'],
    ['posting to https://hooks.slack.com/services/T0001/B0002/abcdefghijklmnop', 'abcdefghijklmnop'],
    ['{"refresh_token": "1//0gAbCdEf"}', '1//0gAbCdEf'],
    ['Cookie: sid=s%3Aabc.def', 's%3Aabc'],
  ])('masks %s', (text, secret) => {
    expect(redactText(text)).not.toContain(secret);
  });

  it('does not mask long camelCase names', () => {
    expect(redactText('{"requiresTrackingValidation": false}')).toBe('{"requiresTrackingValidation": false}');
  });

  it('does not mask token counts or session ids', () => {
    const out = redactText('max_tokens=4096 sessionId: 04018080-3148-46de-9674-18d43ae3eb14');
    expect(out).toBe('max_tokens=4096 sessionId: 04018080-3148-46de-9674-18d43ae3eb14');
  });

  it('keeps word-like names readable but still masks long opaque tokens and secret values', () => {
    const out = redactText('plan Meta_Ads_Perf_Report_Autonomous key sk_live_51HxYzAbCdEfGhIjKlMnOpQrStUvWx password=my_simple_pass_word');

    expect(out).toContain('Meta_Ads_Perf_Report_Autonomous');
    expect(out).not.toContain('51HxYzAbCdEfGhIjKlMnOpQrStUvWx');
    expect(out).not.toContain('my_simple_pass_word');
  });
});
