/**
 * ENG-2196: the online sampler reads spend with a bounded query per billing user (never a scan)
 * and reports cost and latency per successful task per model × task type. Unknown spend is
 * counted as unknown, never as $0. Synthetic sessions only.
 */
import type { DynamoAttributeMap, DynamoPort, DynamoQueryParams } from '../loops/core/ports';
import type { AgentLoopEvent } from '../loops/eval/agentGraders';
import { loadSessionItems, type DocItem, type ReadOnlyDocReader, type ReadPage, type ReadRequest } from '../loops/eval/agentGraderLoader';
import { efficiencyFor, sessionRunLatencyMs, type EvalV2Score } from '../loops/eval/evalV2Sampler';
import { readEvalV2Trend, runEvalV2Sample } from '../cron/evalV2SamplerCron';

const TABLES = { sessions: 'S', messages: 'M', loopEvents: 'L', spendEvents: 'P' };
const WINDOW = { from: '2026-09-24T00:00:00.000Z', to: '2026-09-24T23:59:59.999Z' };
const SPEND_INDEX = 'BillingUserOccurredAtIndex';

const spendRow = (sessionId: string, costMicroUsd: number, operation = 'model-a') => ({
  references: { sessionId },
  costMicroUsd,
  quantity: 100,
  unit: 'llm_token',
  operation,
  lifecycle: 'settled',
});

const messages: DocItem[] = [
  { messageIndex: 0, message: { role: 'user', content: 'go' } },
  { messageIndex: 1, message: { role: 'assistant', content: 'Done.', metadata: { toolCalls: [{ id: 'c', name: 'web_search', arguments: {}, result: {} }] } } },
];

/** A reader over fixed rows: spend rows keyed by billing user, everything else empty. */
function fakeReader(opts: { frame?: DocItem[]; spendByBilling: Record<string, DocItem[]>; events?: DocItem[] }) {
  const calls: ReadRequest[] = [];
  const respond = (request: ReadRequest): ReadPage => {
    if (request.TableName === 'S' && request.IndexName === 'AdminUpdatedAtIndex') return { Items: opts.frame ?? [] };
    if (request.TableName === 'M') return { Items: messages };
    if (request.TableName === 'L') return { Items: opts.events ?? [] };
    if (request.TableName === 'P') {
      const rows = opts.spendByBilling[String(request.ExpressionAttributeValues?.[':u'])] ?? [];
      const start = Number(request.ExclusiveStartKey?.i ?? 0);
      const page = rows.slice(start, start + (request.Limit ?? rows.length));
      const next = start + page.length;
      return { Items: page, ...(next < rows.length ? { LastEvaluatedKey: { i: next } } : {}) };
    }
    return { Items: [] };
  };
  const reader: ReadOnlyDocReader & { calls: ReadRequest[] } = {
    calls,
    query: async (request) => {
      calls.push(request);
      return respond(request);
    },
    scan: async (request) => {
      throw new Error(`scan of ${request.TableName}`);
    },
  };
  return reader;
}

describe('loadSessionItems — bounded spend read', () => {
  const sessions: DocItem[] = [
    { sessionId: 'a', userId: 'member', createdAt: WINDOW.from },
    { sessionId: 'b', userId: 'solo', createdAt: WINDOW.from },
    { sessionId: 'c', userId: 'heavy', createdAt: WINDOW.from },
  ];

  it('queries each billing subject once on the occurredAt index and never scans', async () => {
    const reader = fakeReader({
      spendByBilling: {
        'org-root': [spendRow('a', 1_500_000), spendRow('a', 500_000), spendRow('other-session', 9_000_000)],
        solo: [],
        heavy: Array.from({ length: 6 }, () => spendRow('c', 1)),
      },
    });
    const loaded = await loadSessionItems(reader, TABLES, sessions, {
      ...WINDOW,
      includeSpend: true,
      spendQuery: {
        indexName: SPEND_INDEX,
        billingUserOf: async (userId) => (userId === 'member' ? 'org-root' : userId),
        maxEventsPerBillingUser: 5,
      },
    });
    const byId = new Map(loaded.map((l) => [l.session.sessionId, l]));
    expect(byId.get('a')).toMatchObject({ spendStatus: 'attributed', spend: { costMicroUsd: 2_000_000, tokens: 200 } });
    expect(byId.get('b')?.spendStatus).toBe('none');
    expect(byId.get('b')?.spend).toBeUndefined();
    // More rows than the bound: unknown, not a partial sum.
    expect(byId.get('c')?.spendStatus).toBe('truncated');
    expect(byId.get('c')?.spend).toBeUndefined();

    const spendQueries = reader.calls.filter((c) => c.TableName === 'P');
    expect(new Set(spendQueries.map((c) => c.ExpressionAttributeValues?.[':u']))).toEqual(new Set(['org-root', 'solo', 'heavy']));
    for (const q of spendQueries) {
      expect(q).toMatchObject({ IndexName: SPEND_INDEX, KeyConditionExpression: 'billingUserId = :u AND occurredAt BETWEEN :from AND :to' });
      expect(q.Limit).toBeLessThanOrEqual(6);
    }
  });

  it('reports truncated, not none, when the billing subject cannot be resolved (ENG-2196 CodeRabbit)', async () => {
    // A spend row happens to exist under the raw userId itself — if the loader ever fell back to
    // querying under it, this would misattribute that row as this session's own spend. It must not:
    // an unresolved billing subject was never checked, so it can only be `truncated` (unknown).
    const reader = fakeReader({ spendByBilling: { member: [spendRow('a', 10)] } });
    const [a] = await loadSessionItems(reader, TABLES, [sessions[0]], {
      ...WINDOW,
      includeSpend: true,
      spendQuery: { indexName: SPEND_INDEX, billingUserOf: async () => { throw new Error('no user'); }, maxEventsPerBillingUser: 5 },
    });
    expect(a.spendStatus).toBe('truncated');
    expect(a.spend).toBeUndefined();
    // Never queried under the raw userId as a fallback billing subject.
    expect(reader.calls.some((c) => c.TableName === 'P')).toBe(false);
  });

  it('reports truncated, not none, for a session with no userId at all', async () => {
    const reader = fakeReader({ spendByBilling: {} });
    const billingUserOf = jest.fn(async (userId: string) => userId);
    const [loaded] = await loadSessionItems(reader, TABLES, [{ sessionId: 'no-user', createdAt: WINDOW.from }], {
      ...WINDOW,
      includeSpend: true,
      spendQuery: { indexName: SPEND_INDEX, billingUserOf, maxEventsPerBillingUser: 5 },
    });
    expect(loaded.spendStatus).toBe('truncated');
    expect(loaded.spend).toBeUndefined();
    // Nothing to resolve a billing subject from, so the resolver is never even called.
    expect(billingUserOf).not.toHaveBeenCalled();
  });

  it('resolves one session normally and leaves another truncated when only its lookup fails', async () => {
    const reader = fakeReader({ spendByBilling: { solo: [spendRow('b', 4_000_000)] } });
    const loaded = await loadSessionItems(reader, TABLES, [sessions[0], sessions[1]], {
      ...WINDOW,
      includeSpend: true,
      spendQuery: {
        indexName: SPEND_INDEX,
        billingUserOf: async (userId) => {
          if (userId === 'member') throw new Error('org lookup failed');
          return userId;
        },
        maxEventsPerBillingUser: 5,
      },
    });
    const byId = new Map(loaded.map((l) => [l.session.sessionId, l]));
    expect(byId.get('a')?.spendStatus).toBe('truncated');
    expect(byId.get('b')).toMatchObject({ spendStatus: 'attributed', spend: { costMicroUsd: 4_000_000, tokens: 100 } });
  });
});

describe('sessionRunLatencyMs', () => {
  const ev = (eventType: string, runId: string, ts: string): AgentLoopEvent => ({ eventType, runId, ts, dimensions: {} });

  it('sums start-to-verdict wall time over runs that have both', () => {
    expect(sessionRunLatencyMs([
      ev('agent_run_started', 'r1', '2026-09-24T01:00:00.000Z'),
      ev('agent_tool_succeeded', 'r1', '2026-09-24T01:00:05.000Z'),
      ev('agent_run_verdict', 'r1', '2026-09-24T01:00:30.000Z'),
      ev('agent_run_started', 'r2', '2026-09-24T02:00:00.000Z'),
      ev('agent_run_verdict', 'r2', '2026-09-24T02:00:10.000Z'),
      ev('agent_run_started', 'r3', '2026-09-24T03:00:00.000Z'),
    ])).toBe(40_000);
  });

  it('is undefined when no run finished', () => {
    expect(sessionRunLatencyMs([ev('agent_run_started', 'r1', '2026-09-24T01:00:00.000Z')])).toBeUndefined();
  });
});

describe('efficiencyFor', () => {
  const score = (over: Partial<EvalV2Score>): EvalV2Score => ({
    sessionId: 's', sampleDate: '2026-09-24', surface: 'agent/regular', model: 'm', taskType: 'ads',
    taskVerdict: 'success', toolVerdict: 'pass', toolCalls: 1, groundednessVerdict: 'grounded', graderVersions: {},
    ...over,
  });

  it('charges failures to successes, and counts unattributed and unknown spend instead of reading $0', () => {
    const eff = efficiencyFor([
      score({ spendStatus: 'attributed', costMicroUsd: 2_000_000, runLatencyMs: 10_000 }),
      score({ spendStatus: 'attributed', costMicroUsd: 4_000_000, runLatencyMs: 30_000 }),
      score({ taskVerdict: 'failure', spendStatus: 'attributed', costMicroUsd: 3_000_000 }),
      score({ spendStatus: 'none', runLatencyMs: 20_000 }),
      score({ spendStatus: 'truncated' }),
      score({}),
      score({ taskVerdict: 'excluded', spendStatus: 'attributed', costMicroUsd: 99_000_000 }),
    ]);
    expect(eff).toMatchObject({
      graded: 6,
      successes: 5,
      withSpend: 3,
      successesWithSpend: 2,
      spendNone: 1,
      spendUnknown: 2,
      costPerSuccessUsd: 4.5,
      medianSuccessCostUsd: 2,
      successesWithLatency: 3,
      latencyPerSuccessP50Ms: 20_000,
      latencyPerSuccessP95Ms: 30_000,
    });
  });

  it('reports no cost when no success has spend', () => {
    expect(efficiencyFor([score({ spendStatus: 'none' })])).toMatchObject({ costPerSuccessUsd: null, medianSuccessCostUsd: null });
  });
});

class FakeDynamo implements DynamoPort {
  rows = new Map<string, DynamoAttributeMap>();
  private key = (item: DynamoAttributeMap) => `${String(item.loopId)}|${String(item.tsSession)}`;
  async putItem(_t: string, item: DynamoAttributeMap) { this.rows.set(this.key(item), item); }
  async putItemIfAbsent(_t: string, item: DynamoAttributeMap) {
    if (this.rows.has(this.key(item))) return false;
    this.rows.set(this.key(item), item);
    return true;
  }
  async getItem(_t: string, key: DynamoAttributeMap) { return this.rows.get(this.key(key)) ?? null; }
  async query(params: DynamoQueryParams) {
    const v = params.expressionAttributeValues ?? {};
    return {
      items: [...this.rows.values()].filter((r) => r.loopId === v[':l']
        && (!params.keyConditionExpression.includes('BETWEEN') || (String(r.tsSession) >= String(v[':from']) && String(r.tsSession) <= String(v[':to'])))),
    };
  }
}

describe('runEvalV2Sample — efficiency per model × task type', () => {
  it('stores spend and run latency on each score and reports cost and latency per success', async () => {
    const frame: DocItem[] = ['x', 'y'].map((id) => ({
      sessionId: id, userId: `user-${id}`, createdAt: '2026-09-24T01:00:00.000Z', updatedAt: '2026-09-24T02:00:00.000Z',
      portalType: 'agent', sessionType: 'regular',
      workPlan: { title: 'Launch ads', steps: [{ stepCount: 1, status: 'completed' }] },
    }));
    const events: DocItem[] = [
      { eventType: 'agent_run_started', subjectId: 'rx', ts: '2026-09-24T01:00:00.000Z', dimensions: { sessionId: 'x' } },
      { eventType: 'agent_run_verdict', subjectId: 'rx', ts: '2026-09-24T01:01:00.000Z', dimensions: { sessionId: 'x', llmModel: 'model-a' } },
    ];
    const reader = fakeReader({ frame, events, spendByBilling: { 'user-x': [spendRow('x', 3_000_000)] } });
    const dynamo = new FakeDynamo();
    await runEvalV2Sample(
      { dynamo, reader, tables: TABLES, clock: { now: () => new Date('2026-09-25T17:15:00.000Z') } },
      { enabled: true, dryRun: false, sampleSize: 2 },
    );
    expect(reader.calls.some((c) => c.TableName === 'P' && c.IndexName === SPEND_INDEX)).toBe(true);

    const scores = [...dynamo.rows.values()].filter((r) => r.eventType === 'eval_v2_scored').map((r) => r.dimensions as Record<string, unknown>);
    const x = scores.find((d) => d.sessionId === 'x');
    const y = scores.find((d) => d.sessionId === 'y');
    expect(x).toMatchObject({ spendStatus: 'attributed', costMicroUsd: 3_000_000, runLatencyMs: 60_000, model: 'model-a', samplerVersion: 2 });
    expect(y).toMatchObject({ spendStatus: 'none' });
    expect(y).not.toHaveProperty('costMicroUsd');

    const [week] = await readEvalV2Trend(dynamo, { windowLabel: '7d' });
    expect(week.spendAttribution).toEqual({ sessions: 2, attributed: 1, none: 1, truncated: 0, notRead: 0 });
    const cellX = week.groups.find((g) => g.model === 'model-a');
    expect(cellX).toMatchObject({ taskType: 'ads' });
    expect(cellX?.efficiency).toMatchObject({ successes: 1, successesWithSpend: 1, costPerSuccessUsd: 3, latencyPerSuccessP50Ms: 60_000 });
  });
});
