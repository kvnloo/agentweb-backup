/**
 * ENG-2196: the daily sampler adds creative (gate pass rate, rubric score distribution) and
 * account-health (state distribution, flip rate) snapshots from stored grader output. Reads are
 * bounded scans of two small tables; a truncated or failed read reports no numbers. Synthetic rows only.
 */
import type { DynamoAttributeMap, DynamoPort, DynamoQueryParams } from '../loops/core/ports';
import type { DocItem, ReadRequest } from '../loops/eval/agentGraderLoader';
import { aggregateAccountHealth, aggregateCreative, buildSurfaceSnapshotItem, surfaceSnapshotSortKey } from '../loops/eval/evalV2Surfaces';
import { buildSnapshotItem, aggregateEvalV2 } from '../loops/eval/evalV2Sampler';
import {
  readEvalV2SurfaceTrend,
  readEvalV2Trend,
  surfaceScanReader,
  writeEvalV2SurfaceSnapshots,
  type SurfaceReader,
  type SurfaceScanPage,
} from '../cron/evalV2SamplerCron';

const NOW = new Date('2026-09-25T17:15:00.000Z');
const DATE = '2026-09-24';
const TABLES = { humanEvalQueue: 'HEQ', accountCapabilityRequirements: 'ACR' };

const gates = (passed: boolean, failed: string[] = []) => ({
  passed,
  version: '2026-09-25.1',
  checks: [{ id: 'decode', status: 'pass' }, ...failed.map((id) => ({ id, status: 'fail' }))],
});
const rubric = (passedCount: number) => ({ status: 'ok', passedCount, passed: passedCount === 7, version: '2026-09-25.1' });

const creatives: DocItem[] = [
  { createdAt: '2026-09-24T10:00:00.000Z', creativeGates: gates(true), creativeRubric: rubric(7) },
  { createdAt: '2026-09-24T11:00:00.000Z', creativeGates: gates(false, ['aspect_ratio', 'dimensions']), creativeRubric: rubric(5) },
  { createdAt: '2026-09-24T12:00:00.000Z', creativeGates: gates(true), creativeRubric: { status: 'error', version: '2026-09-25.1' } },
  { createdAt: '2026-09-20T12:00:00.000Z', creativeGates: gates(false, ['blank_render']) },
  { createdAt: '2026-09-10T12:00:00.000Z', creativeGates: gates(false, ['blank_render']) },
];

const accounts: DocItem[] = [
  { state: 'healthy', stateSince: '2026-09-01T00:00:00.000Z', version: 1 },
  { state: 'at_risk', stateSince: '2026-09-24T05:00:00.000Z', version: 3 },
  { state: 'activation_incomplete', stateSince: '2026-09-21T05:00:00.000Z', version: 2 },
  // First classification inside the window is not a flip.
  { state: 'insufficient_evidence', stateSince: '2026-09-24T06:00:00.000Z', version: 1 },
];

describe('aggregateCreative', () => {
  it('reports gate pass rate with CI, failing checks and the rubric criteria-passed distribution', () => {
    const day = aggregateCreative(creatives, { date: DATE, windowLabel: '1d', now: NOW });
    expect(day).toMatchObject({ surface: 'creative', status: 'ok', creatives: 3, windowStartDate: DATE, windowEndDate: DATE });
    expect(day.gates).toMatchObject({ n: 3, passes: 2, versions: ['2026-09-25.1'], failedChecks: { aspect_ratio: 1, dimensions: 1 }, mayGate: false });
    expect(day.gates.rate).toBeCloseTo(2 / 3);
    expect(day.gates.ci?.low).toBeLessThan(day.gates.rate as number);
    expect(day.rubric).toMatchObject({ judged: 2, errors: 1, skipped: 0, passedCountDistribution: [0, 0, 0, 0, 0, 1, 0, 1], mayGate: false });
    expect(day.rubric.floorMet).toMatchObject({ n: 2, passes: 1, rate: 0.5 });

    const week = aggregateCreative(creatives, { date: DATE, windowLabel: '7d', now: NOW });
    expect(week).toMatchObject({ creatives: 4, windowStartDate: '2026-09-18' });
    expect(week.gates.failedChecks).toEqual({ aspect_ratio: 1, dimensions: 1, blank_render: 1 });
  });

  it('reports nothing for a truncated read', () => {
    const snap = aggregateCreative(creatives, { date: DATE, windowLabel: '7d', now: NOW, status: 'truncated', statusReason: 'too many' });
    expect(snap).toMatchObject({ status: 'truncated', statusReason: 'too many', creatives: 0, gates: { n: 0, rate: null, ci: null } });
  });
});

describe('aggregateAccountHealth', () => {
  it('counts states and flips (a re-classification that entered its state in the window)', () => {
    const day = aggregateAccountHealth(accounts, { date: DATE, windowLabel: '1d', now: NOW });
    expect(day).toMatchObject({
      surface: 'account_health',
      accounts: 4,
      byState: { healthy: 1, at_risk: 1, activation_incomplete: 1, insufficient_evidence: 1, other: 0 },
      flips: { n: 4, passes: 1, rate: 0.25 },
      mayGate: false,
    });
    expect(aggregateAccountHealth(accounts, { date: DATE, windowLabel: '7d', now: NOW }).flips.passes).toBe(2);
  });

  it('reports zero accounts when the classifier has written nothing', () => {
    expect(aggregateAccountHealth([], { date: DATE, windowLabel: '7d', now: NOW })).toMatchObject({ accounts: 0, flips: { n: 0, rate: null } });
  });
});

class FakeDynamo implements DynamoPort {
  rows = new Map<string, DynamoAttributeMap>();
  private key = (item: DynamoAttributeMap) => `${String(item.loopId)}|${String(item.tsSession)}`;
  async putItem(_t: string, item: DynamoAttributeMap) { this.rows.set(this.key(item), item); }
  async getItem(_t: string, key: DynamoAttributeMap) { return this.rows.get(this.key(key)) ?? null; }
  async query(params: DynamoQueryParams) {
    return { items: [...this.rows.values()].filter((r) => r.loopId === params.expressionAttributeValues?.[':l']) };
  }
}

/** Pages of `pageSize` over fixed rows per table; `fail` makes a table's scan throw. */
function fakeSurfaceReader(rows: Record<string, DocItem[]>, opts: { pageSize?: number; fail?: string } = {}): SurfaceReader & { calls: ReadRequest[] } {
  const calls: ReadRequest[] = [];
  return {
    calls,
    scan: async (request): Promise<SurfaceScanPage> => {
      calls.push(request);
      if (request.TableName === opts.fail) throw new Error('AccessDenied');
      const all = rows[request.TableName] ?? [];
      const start = Number(request.ExclusiveStartKey?.i ?? 0);
      const size = Math.min(opts.pageSize ?? all.length, request.Limit ?? all.length);
      const page = all.slice(start, start + size);
      const next = start + page.length;
      return { Items: page, ScannedCount: page.length, ...(next < all.length ? { LastEvaluatedKey: { i: next } } : {}) };
    },
  };
}

describe('writeEvalV2SurfaceSnapshots', () => {
  it('writes 1d and 7d snapshots for both surfaces, beside the agent snapshots, and the trend read returns them', async () => {
    const dynamo = new FakeDynamo();
    const reader = fakeSurfaceReader({ HEQ: creatives, ACR: accounts }, { pageSize: 2 });
    await dynamo.putItem('L', buildSnapshotItem(aggregateEvalV2([], { date: DATE, windowLabel: '7d', now: NOW })));
    const snaps = await writeEvalV2SurfaceSnapshots(dynamo, reader, TABLES, DATE, NOW);
    expect(snaps.map((s) => `${s.surface}:${s.windowLabel}:${s.status}`).sort()).toEqual([
      'account_health:1d:ok', 'account_health:7d:ok', 'creative:1d:ok', 'creative:7d:ok',
    ]);
    expect(reader.calls.find((c) => c.TableName === 'ACR')).toMatchObject({ FilterExpression: '#cap = :cap', ExpressionAttributeValues: { ':cap': 'account_health_signal' } });

    const trend = await readEvalV2SurfaceTrend(dynamo, { windowLabel: '7d' });
    expect(trend.creative).toHaveLength(1);
    expect(trend.creative[0]).toMatchObject({ creatives: 4, gates: { n: 4 } });
    expect(trend.accountHealth[0]).toMatchObject({ accounts: 4 });
    // The agent trend read is unaffected by the new rows.
    expect(await readEvalV2Trend(dynamo, { windowLabel: '7d' })).toHaveLength(1);
  });

  it('records a failed read as unavailable, without numbers, and keeps the other surface', async () => {
    const dynamo = new FakeDynamo();
    const snaps = await writeEvalV2SurfaceSnapshots(dynamo, fakeSurfaceReader({ HEQ: creatives, ACR: accounts }, { fail: 'HEQ' }), TABLES, DATE, NOW);
    const creative = snaps.find((s) => s.surface === 'creative' && s.windowLabel === '7d');
    expect(creative).toMatchObject({ status: 'unavailable', statusReason: 'AccessDenied', creatives: 0 });
    expect(snaps.find((s) => s.surface === 'account_health' && s.windowLabel === '7d')).toMatchObject({ status: 'ok', accounts: 4 });
  });
});

describe('surface snapshot rows and reader', () => {
  it('keys a surface snapshot beside, never over, the agent snapshot', () => {
    expect(surfaceSnapshotSortKey(DATE, '7d', 'creative')).toBe('2026-09-24#7d#creative');
    const item = buildSurfaceSnapshotItem(aggregateCreative([], { date: DATE, windowLabel: '7d', now: NOW }));
    expect(item).toMatchObject({ loopId: 'eval-v2-daily', eventType: 'eval_v2_creative_snapshot', tsSession: '2026-09-24#7d#creative' });
  });

  it('refuses to scan any table but the two surface tables', async () => {
    const reader = surfaceScanReader(TABLES, 'us-west-2');
    await expect(reader.scan({ TableName: 'AW-ChatSessions' })).rejects.toThrow('scan of AW-ChatSessions refused');
  });
});
