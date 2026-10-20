import { buildAgentRunTrace, redactText, TRACE_LIMITS, type TraceMessageRow } from '../services/agentRunTrace';

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
    expect(step1.callIds).toEqual(['c4']);
    expect(step1.statusCallId).toBe('c5');
    expect(step1.closedWithoutCalls).toBe(false);
    expect(step2.callIds).toEqual(['c6', 'c7']);
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
