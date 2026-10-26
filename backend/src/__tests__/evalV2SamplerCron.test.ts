/**
 * ENG-2144: online eval sampler cron — the flag contract, dry run, idempotency per
 * (day, session), resuming a half-finished day, and query-only reads. In-memory Dynamo and
 * reader; synthetic sessions only.
 */
import type { DynamoAttributeMap, DynamoPort, DynamoQueryParams } from '../loops/core/ports';
import type { DocItem, ReadOnlyDocReader, ReadPage, ReadRequest } from '../loops/eval/agentGraderLoader';
import { buildSampleRunItem, sampleSeed, sampleUniform } from '../loops/eval/evalV2Sampler';
import {
  DEFAULT_EVAL_V2_SAMPLE_SIZE,
  readEvalV2Trend,
  resolveSampleSize,
  runEvalV2Sample,
  samplerEnabled,
  type SamplerDeps,
} from '../cron/evalV2SamplerCron';

const TABLES = { sessions: 'S', messages: 'M', loopEvents: 'L', spendEvents: 'P' };
const NOW = new Date('2026-09-25T17:15:00.000Z');

/** PK(loopId)+SK(tsSession) store supporting the key conditions the cron uses. */
class FakeDynamo implements DynamoPort {
  rows = new Map<string, DynamoAttributeMap>();
  writes = 0;

  private key(item: DynamoAttributeMap): string {
    return `${String(item.loopId)}|${String(item.tsSession)}`;
  }

  async putItem(_table: string, item: DynamoAttributeMap): Promise<void> {
    this.writes++;
    this.rows.set(this.key(item), item);
  }

  async putItemIfAbsent(_table: string, item: DynamoAttributeMap): Promise<boolean> {
    if (this.rows.has(this.key(item))) return false;
    this.writes++;
    this.rows.set(this.key(item), item);
    return true;
  }

  async getItem(_table: string, key: DynamoAttributeMap): Promise<DynamoAttributeMap | null> {
    return this.rows.get(this.key(key)) ?? null;
  }

  async query(params: DynamoQueryParams): Promise<{ items: DynamoAttributeMap[] }> {
    const v = params.expressionAttributeValues ?? {};
    const items = [...this.rows.values()].filter((r) => {
      if (r.loopId !== v[':l']) return false;
      if (!params.keyConditionExpression.includes('BETWEEN')) return true;
      const sk = String(r.tsSession);
      return sk >= String(v[':from']) && sk <= String(v[':to']);
    });
    return { items };
  }
}

interface FakeReader extends ReadOnlyDocReader {
  calls: ReadRequest[];
}

/** `count` sessions last active on 2026-09-24; each with one user turn and one web_search call. */
function fakeReader(count: number, messagesOf?: (sessionId: string) => DocItem[] | undefined): FakeReader {
  const frame: DocItem[] = Array.from({ length: count }, (_, i) => ({
    sessionId: `s-${String(i).padStart(2, '0')}`,
    userId: 'u',
    createdAt: '2026-09-24T01:00:00.000Z',
    updatedAt: '2026-09-24T02:00:00.000Z',
    portalType: 'agent',
    sessionType: i % 2 ? 'scheduled' : 'regular',
  }));
  const calls: ReadRequest[] = [];
  const respond = (request: ReadRequest): ReadPage => {
    if (request.TableName === 'S' && request.IndexName === 'AdminUpdatedAtIndex') return { Items: frame };
    if (request.TableName === 'S') {
      return { Items: [{ ...frame[0], sessionId: request.ExpressionAttributeValues?.[':s'], updatedAt: '2026-09-25T09:00:00.000Z' }] };
    }
    if (request.TableName === 'M') {
      const override = messagesOf?.(String(request.ExpressionAttributeValues?.[':s']));
      if (override) return { Items: override };
      return {
        Items: [
          { messageIndex: 0, message: { role: 'user', content: 'go' } },
          { messageIndex: 1, message: { role: 'assistant', content: 'Done.', metadata: { toolCalls: [{ id: 'c', name: 'web_search', arguments: {}, result: {} }] } } },
        ],
      };
    }
    return { Items: [] };
  };
  return {
    calls,
    query: async (request) => {
      calls.push(request);
      return respond(request);
    },
    scan: async (request) => {
      throw new Error(`scan of ${request.TableName}`);
    },
  };
}

function deps(dynamo: FakeDynamo, reader: FakeReader): SamplerDeps {
  return { dynamo, reader, tables: TABLES, clock: { now: () => NOW } };
}

const scoreRows = (dynamo: FakeDynamo) => [...dynamo.rows.values()].filter((r) => r.eventType === 'eval_v2_scored');

describe('runEvalV2Sample — flag contract', () => {
  it('refuses a live run without EVAL_V2_SAMPLER_ENABLED, before any read or write', async () => {
    const dynamo = new FakeDynamo();
    const reader = fakeReader(5);
    const result = await runEvalV2Sample(deps(dynamo, reader), { enabled: false, dryRun: false, sampleSize: 3 });
    expect(result).toEqual({ status: 'refused', reason: 'flag_off' });
    expect(reader.calls).toHaveLength(0);
    expect(dynamo.rows.size).toBe(0);
  });

  it('allows a dry run with the flag off: reads and grades, writes nothing', async () => {
    const dynamo = new FakeDynamo();
    const reader = fakeReader(5);
    const result = await runEvalV2Sample(deps(dynamo, reader), { enabled: false, dryRun: true, sampleSize: 3 });
    expect(result).toMatchObject({ status: 'dry_run', sampleDate: '2026-09-24', frameSize: 5, sampled: 3, graded: 3, written: 0, snapshotsWritten: 0 });
    expect(dynamo.writes).toBe(0);
  });

  it('refuses a day that has not ended, and a malformed date', async () => {
    const run = (sampleDate: string) =>
      runEvalV2Sample(deps(new FakeDynamo(), fakeReader(1)), { enabled: true, dryRun: false, sampleSize: 1, sampleDate });
    await expect(run('2026-09-25')).resolves.toMatchObject({ status: 'refused', reason: 'day_not_over' });
    await expect(run('2026-02-30')).resolves.toMatchObject({ status: 'refused', reason: 'invalid_date' });
  });

  it('reads EVAL_V2_SAMPLER_ENABLED as on only for "true", and clamps EVAL_V2_SAMPLE_SIZE', () => {
    expect([undefined, '', 'false', 'TRUE', '1'].map(samplerEnabled)).toEqual([false, false, false, false, false]);
    expect(samplerEnabled('true')).toBe(true);
    expect([undefined, '', 'abc'].map(resolveSampleSize)).toEqual([DEFAULT_EVAL_V2_SAMPLE_SIZE, DEFAULT_EVAL_V2_SAMPLE_SIZE, DEFAULT_EVAL_V2_SAMPLE_SIZE]);
    expect([resolveSampleSize('0'), resolveSampleSize('20.7'), resolveSampleSize('9999')]).toEqual([1, 20, 500]);
  });
});

describe('runEvalV2Sample — live run', () => {
  it('samples the previous day uniformly from the time-ordered index, never a scan', async () => {
    const dynamo = new FakeDynamo();
    const reader = fakeReader(12);
    const result = await runEvalV2Sample(deps(dynamo, reader), { enabled: true, dryRun: false, sampleSize: 5 });
    expect(result).toMatchObject({ status: 'sampled', sampleDate: '2026-09-24', frameSize: 12, sampled: 5, graded: 5, written: 5, alreadyScored: 0, snapshotsWritten: 2 });

    const frameQuery = reader.calls.find((c) => c.IndexName === 'AdminUpdatedAtIndex');
    expect(frameQuery?.ExpressionAttributeValues).toMatchObject({ ':from': '2026-09-24T00:00:00.000Z', ':to': '2026-09-24T23:59:59.999Z' });

    const expected = sampleUniform(Array.from({ length: 12 }, (_, i) => `s-${String(i).padStart(2, '0')}`), 5, sampleSeed('2026-09-24'), (x) => x);
    expect(scoreRows(dynamo).map((r) => r.subjectId).sort()).toEqual([...expected].sort());
    expect(scoreRows(dynamo).map((r) => (r.dimensions as Record<string, unknown>).surface)).toEqual(
      expect.arrayContaining(['agent/regular']),
    );
  });

  it('ENG-2648: skips a sampled branch nobody continued (all its rows are a copy of its source)', async () => {
    const dynamo = new FakeDynamo();
    const branchCopy: DocItem[] = [
      { messageIndex: 0, message: { role: 'system', content: 'sys', metadata: { branchOrigin: { sourceSessionId: 'src', sourceMessageIndex: 2, branchedAt: '2026-09-24T01:00:00.000Z' } } } },
      { messageIndex: 1, message: { role: 'user', content: 'copied question' } },
      { messageIndex: 2, message: { role: 'assistant', content: 'copied answer', metadata: { toolCalls: [{ id: 'c', name: 'web_search', arguments: {}, result: {} }] } } },
    ];
    const reader = fakeReader(4, (id) => (id === 's-01' ? branchCopy : undefined));
    const result = await runEvalV2Sample(deps(dynamo, reader), { enabled: true, dryRun: false, sampleSize: 4 });
    expect(result).toMatchObject({ status: 'sampled', sampled: 4, graded: 3, written: 3 });
    expect(scoreRows(dynamo).map((r) => r.subjectId).sort()).toEqual(['s-00', 's-02', 's-03']);
  });

  it('is idempotent per day: a second run writes nothing', async () => {
    const dynamo = new FakeDynamo();
    await runEvalV2Sample(deps(dynamo, fakeReader(8)), { enabled: true, dryRun: false, sampleSize: 4 });
    const writes = dynamo.writes;
    const rows = new Map(dynamo.rows);
    const again = await runEvalV2Sample(deps(dynamo, fakeReader(8)), { enabled: true, dryRun: false, sampleSize: 4 });
    expect(again).toEqual({ status: 'already_sampled', sampleDate: '2026-09-24', sampled: 4, frameSize: 8 });
    expect(dynamo.writes).toBe(writes);
    expect(dynamo.rows).toEqual(rows);
  });

  it('resumes a half-finished day with the same draw, one score per session', async () => {
    const dynamo = new FakeDynamo();
    // A crashed run claimed s-01, s-03 and s-77 (touched since, so outside today's frame) and
    // stored s-01's score before dying.
    await dynamo.putItemIfAbsent('L', buildSampleRunItem({
      sampleDate: '2026-09-24', status: 'sampling', seed: sampleSeed('2026-09-24'), frameSize: 6, sampleSize: 3,
      sessionIds: ['s-01', 's-03', 's-77'], startedAt: '2026-09-25T17:15:00.000Z',
    }));
    await dynamo.putItemIfAbsent('L', { loopId: 'eval-v2', tsSession: 'eval_v2_scored#2026-09-24#s-01', eventType: 'eval_v2_scored', subjectId: 's-01', ts: 'x' });

    const reader = fakeReader(6);
    const result = await runEvalV2Sample(deps(dynamo, reader), { enabled: true, dryRun: false, sampleSize: 3 });
    expect(result).toMatchObject({ status: 'sampled', sampled: 3, graded: 3, written: 2, alreadyScored: 1 });
    expect(scoreRows(dynamo).map((r) => r.subjectId).sort()).toEqual(['s-01', 's-03', 's-77']);
    expect(reader.calls.some((c) => c.TableName === 'S' && !c.IndexName && c.ExpressionAttributeValues?.[':s'] === 's-77')).toBe(true);

    const run = dynamo.rows.get('eval-v2|eval_v2_sample_run#2026-09-24');
    expect(run?.run).toMatchObject({ status: 'complete', written: 2, alreadyScored: 1 });
  });

  it('writes 1d and 7d snapshots that the trend read returns', async () => {
    const dynamo = new FakeDynamo();
    await runEvalV2Sample(deps(dynamo, fakeReader(4)), { enabled: true, dryRun: false, sampleSize: 4 });
    const [week] = await readEvalV2Trend(dynamo, { windowLabel: '7d' });
    expect(week).toMatchObject({ date: '2026-09-24', windowLabel: '7d', sessions: 4 });
    expect(week.coverage).toEqual([{ date: '2026-09-24', frameSize: 4, sampleSize: 4, scored: 4 }]);
    const tools = week.groups[0].metrics.find((m) => m.graderId === 'agent-tool-correctness');
    expect(tools).toMatchObject({ n: 4, passes: 4, mayGate: false });
    expect(await readEvalV2Trend(dynamo, { windowLabel: '1d' })).toHaveLength(1);
  });
});
