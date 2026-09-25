/**
 * ENG-2137: read-only loader for the agent graders. Synthetic rows only.
 */
import {
  buildLoadedSession,
  endsWithRunFailurePlaceholder,
  finalReplyOf,
  groupEventsBySession,
  loadSessionsForGrading,
  orderedMessages,
  sessionModel,
  spendBySession,
  toGraderWorkPlan,
  toLedger,
  type DocItem,
  type ReadOnlyDocReader,
  type ReadPage,
  type ReadRequest,
} from '../loops/eval/agentGraderLoader';

const row = (messageIndex: number, message: DocItem): DocItem => ({ sessionId: 's-1', messageIndex, message });

const TRANSCRIPT: DocItem[] = [
  row(3, { role: 'tool', tool_call_id: 'c1', content: '{"success":true,"campaignResourceName":"customers/1/campaigns/222222"}' }),
  row(0, { role: 'system', content: 'sys' }),
  row(1, { role: 'user', content: 'do it' }),
  row(2, {
    role: 'assistant',
    content: '',
    metadata: {
      toolCalls: [
        { id: 'c1', name: 'call_google_ads_api', arguments: { action: 'CREATE' }, result: {} },
        { id: 'c2', name: 'send_email', arguments: {}, error: 'SMTP down' },
        { id: 'c3', name: 'generate_image', arguments: {}, duplicateOf: 'c0' },
      ],
    },
  }),
  row(4, { role: 'tool', tool_call_id: 'c2', content: 'Error: SMTP down' }),
  row(5, { role: 'assistant', content: 'All set.', metadata: { toolCalls: [{ id: 'c1', name: 'call_google_ads_api', arguments: {} }] } }),
];

describe('message normalizers', () => {
  it('orders messages by messageIndex and builds the ledger once per call id', () => {
    const messages = orderedMessages(TRANSCRIPT);
    expect(messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool', 'tool', 'assistant']);
    expect(toLedger(messages)).toEqual([
      {
        id: 'c1',
        toolName: 'call_google_ads_api',
        args: { action: 'CREATE' },
        status: 'success',
        result: {},
        output: { success: true, campaignResourceName: 'customers/1/campaigns/222222' },
      },
      { id: 'c2', toolName: 'send_email', args: {}, status: 'error' },
    ]);
  });

  it('takes the final reply from the last assistant text that is not a crash placeholder', () => {
    const messages = orderedMessages(TRANSCRIPT);
    expect(finalReplyOf(messages)).toBe('All set.');
    expect(endsWithRunFailurePlaceholder(messages)).toBe(false);

    const crashed = orderedMessages([
      ...TRANSCRIPT,
      row(6, { role: 'assistant', content: "This run didn't finish", metadata: { isRunFailureNotice: true } }),
      row(7, { role: 'system', content: 'note' }),
    ]);
    expect(finalReplyOf(crashed)).toBe('All set.');
    expect(endsWithRunFailurePlaceholder(crashed)).toBe(true);
    expect(finalReplyOf(orderedMessages([row(0, { role: 'assistant', content: [{ type: 'text', text: 'multi' }, { type: 'text', text: 'part' }] })])))
      .toBe('multipart');
  });

  it('keeps only the work-plan fields the grader reads', () => {
    expect(toGraderWorkPlan({
      title: 'T',
      steps: [{ stepCount: 1, status: 'completed', title: 'secret title', requiredFunctionCalls: ['a', 7] }, 'junk', { stepCount: 2 }],
      pendingRequiredFunctionCalls: ['b'],
    })).toEqual({
      title: 'T',
      steps: [{ stepCount: 1, status: 'completed', requiredFunctionCalls: ['a'] }, { stepCount: 2, status: 'pending', requiredFunctionCalls: undefined }],
      pendingRequiredFunctionCalls: ['b'],
    });
    expect(toGraderWorkPlan(undefined)).toBeUndefined();
  });
});

describe('events, spend and model', () => {
  const EVENTS: DocItem[] = [
    { eventType: 'agent_run_verdict', subjectId: 'r2', ts: '2026-09-25T00:00:03Z', dimensions: { sessionId: 's-1', llmModel: 'model-b' } },
    { eventType: 'agent_run_started', subjectId: 'r1', ts: '2026-09-25T00:00:01Z', dimensions: { sessionId: 's-1', llmModel: 'model-a', nested: { x: 1 } } },
    { eventType: 'agent_run_verdict', subjectId: 'r1', ts: '2026-09-25T00:00:02Z', dimensions: { sessionId: 's-1', llmModel: 'model-b' } },
    { eventType: 'agent_tool_invoked', subjectId: 'r9', ts: '2026-09-25T00:00:02Z', dimensions: { toolName: 'x' } },
  ];

  it('groups loop events by session, in time order, dropping rows without a session', () => {
    const grouped = groupEventsBySession(EVENTS);
    expect([...grouped.keys()]).toEqual(['s-1']);
    const events = grouped.get('s-1') ?? [];
    expect(events.map((e) => e.runId)).toEqual(['r1', 'r1', 'r2']);
    expect(events[0].dimensions).toEqual({ sessionId: 's-1', llmModel: 'model-a' });
  });

  it('sums settled spend per session and tokens from llm_token rows only', () => {
    const spend = spendBySession([
      { references: { sessionId: 's-1' }, lifecycle: 'settled', costMicroUsd: 1500, unit: 'llm_token', quantity: 100, operation: 'model-b' },
      { references: { sessionId: 's-1' }, lifecycle: 'settled', costMicroUsd: 500, unit: 'image', quantity: 1, operation: 'gpt-image' },
      { references: { sessionId: 's-1' }, lifecycle: 'reserved', costMicroUsd: 9999, unit: 'llm_token', quantity: 1 },
      { lifecycle: 'settled', costMicroUsd: 7, unit: 'llm_token', quantity: 1 },
    ]);
    expect(spend.get('s-1')).toEqual({ costMicroUsd: 2000, tokens: 100, costByOperation: { 'model-b': 1500, 'gpt-image': 500 } });
    expect(spend.size).toBe(1);
  });

  it('picks the model from run verdicts, then run starts, then the largest spend', () => {
    const events = groupEventsBySession(EVENTS).get('s-1') ?? [];
    expect(sessionModel(events)).toBe('model-b');
    expect(sessionModel(events.filter((e) => e.eventType === 'agent_run_started'))).toBe('model-a');
    expect(sessionModel([], { costMicroUsd: 3, tokens: 0, costByOperation: { cheap: 1, dear: 2 } })).toBe('dear');
    expect(sessionModel([])).toBe('unknown');
  });

  it('assembles one session for grading', () => {
    const loaded = buildLoadedSession(
      { sessionId: 's-1', workPlan: { title: 'T', steps: [{ stepCount: 1, status: 'completed' }] } },
      TRANSCRIPT,
      groupEventsBySession(EVENTS).get('s-1') ?? [],
      { costMicroUsd: 10, tokens: 5, costByOperation: {} },
    );
    expect(loaded).toMatchObject({
      model: 'model-b',
      spend: { costMicroUsd: 10, tokens: 5 },
      session: { sessionId: 's-1', finalReply: 'All set.', userTurns: 1, endsWithRunFailurePlaceholder: false },
    });
    expect(loaded.session.ledger).toHaveLength(2);
    expect(loaded.session.events).toHaveLength(3);
  });
});

describe('loadSessionsForGrading', () => {
  const TABLES = { sessions: 'S', messages: 'M', loopEvents: 'L', spendEvents: 'P' };

  function fakeReader(): { reader: ReadOnlyDocReader; calls: Array<{ op: string; request: ReadRequest }> } {
    const calls: Array<{ op: string; request: ReadRequest }> = [];
    const respond = (op: string, request: ReadRequest): ReadPage => {
      calls.push({ op, request });
      if (request.TableName === 'S') {
        // two pages, to prove pagination
        return request.ExclusiveStartKey
          ? { Items: [{ sessionId: 'old', updatedAt: '2026-09-20T00:00:00Z', createdAt: '2026-08-01T00:00:00Z' }] }
          : { Items: [{ sessionId: 's-1', updatedAt: '2026-09-24T00:00:00Z', createdAt: '2026-09-19T00:00:00Z' }], LastEvaluatedKey: { k: 1 } };
      }
      if (request.TableName === 'M') return { Items: request.ExpressionAttributeValues?.[':s'] === 's-1' ? TRANSCRIPT : [] };
      if (request.TableName === 'L') {
        return { Items: [{ eventType: 'agent_run_verdict', subjectId: 'r1', ts: '2026-09-24T00:00:00Z', dimensions: { sessionId: 's-1', llmModel: 'm' } }] };
      }
      return { Items: [{ references: { sessionId: 's-1' }, lifecycle: 'settled', costMicroUsd: 42, unit: 'llm_token', quantity: 3 }] };
    };
    return {
      calls,
      reader: {
        query: async (request) => respond('query', request),
        scan: async (request) => respond('scan', request),
      },
    };
  }

  it('reads sessions, events, spend and messages and returns graded inputs, newest first', async () => {
    const { reader, calls } = fakeReader();
    const loaded = await loadSessionsForGrading(reader, TABLES, { from: '2026-09-18T00:00:00.000Z', to: '2026-09-25T00:00:00.000Z' });
    expect(loaded.map((l) => l.session.sessionId)).toEqual(['s-1', 'old']);
    expect(loaded[0]).toMatchObject({ model: 'm', spend: { costMicroUsd: 42, tokens: 3 } });
    expect(loaded[1]).toMatchObject({ model: 'unknown', session: { ledger: [] } });

    expect(calls.filter((c) => c.request.TableName === 'S')).toHaveLength(2);
    expect(calls.find((c) => c.request.TableName === 'P')?.op).toBe('scan');
    // Loop events reach back to the earliest session's start, but never more than 14 days before `from`.
    const events = calls.find((c) => c.request.TableName === 'L');
    expect(events?.request.ExpressionAttributeValues?.[':from']).toBe('2026-09-04T00:00:00.000Z');
  });

  it('applies the limit before reading messages', async () => {
    const { reader, calls } = fakeReader();
    const loaded = await loadSessionsForGrading(reader, TABLES, { from: '2026-09-18T00:00:00.000Z', to: '2026-09-25T00:00:00.000Z', limit: 1 });
    expect(loaded.map((l) => l.session.sessionId)).toEqual(['s-1']);
    expect(calls.filter((c) => c.request.TableName === 'M')).toHaveLength(1);
    expect(calls.find((c) => c.request.TableName === 'L')?.request.ExpressionAttributeValues?.[':from']).toBe('2026-09-18T00:00:00.000Z');
  });

  it('reads nothing else when no session was updated in the window', async () => {
    const calls: string[] = [];
    const reader: ReadOnlyDocReader = {
      query: async (r) => { calls.push(r.TableName); return { Items: [] }; },
      scan: async (r) => { calls.push(r.TableName); return { Items: [] }; },
    };
    await expect(loadSessionsForGrading(reader, TABLES, { from: '2026-09-18', to: '2026-09-25' })).resolves.toEqual([]);
    expect(calls).toEqual(['S']);
  });
});
