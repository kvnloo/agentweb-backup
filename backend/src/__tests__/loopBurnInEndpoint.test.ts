/**
 * ENG-746 AC4 — end-to-end proof through the real admin endpoint.
 *
 * "An end-to-end test proves an auto-closure attempt with absent burn-in data
 * fails closed and routes to Harsha, and one with clean burn-in data passes
 * check 4."
 *
 * These drive the actual Express router against a stubbed Dynamo, so what is
 * proven is the wire contract an agent would consume — not just the pure
 * function underneath it.
 */

import express from 'express';
import request from 'supertest';

import {
  writeReliabilitySnapshots,
  RELIABILITY_SNAPSHOT_LOOP_ID,
} from '../cron/agentReliabilitySnapshotCron';
import { LOOP_EVENTS_TABLE } from '../loops/core/sensors/eventTableEventSource';
import type { DynamoAttributeMap } from '../loops/core/ports';

/** In-memory Dynamo double: PK(loopId)+SK(tsSession), putItem overwrites. */
class FakeDynamo {
  rows = new Map<string, DynamoAttributeMap>();

  async putItem(_table: string, item: DynamoAttributeMap): Promise<void> {
    this.rows.set(`${String(item.loopId)}|${String(item.tsSession)}`, item);
  }

  async query(params: {
    tableName: string;
    expressionAttributeValues: Record<string, unknown>;
  }): Promise<{ items: DynamoAttributeMap[] }> {
    const wanted = params.expressionAttributeValues[':loopId'];
    const items = Array.from(this.rows.values()).filter((r) => r.loopId === wanted);
    return { items };
  }

  async getItem(): Promise<DynamoAttributeMap | null> {
    return null;
  }
}

const fake = new FakeDynamo();

// The route builds its own adapter; point it at the fake.
jest.mock('../loops/adapters/awsAdapters', () => ({
  awsDynamoAdapter: () => fake,
  productionLoopPorts: () => ({ dynamo: fake, clock: { now: () => new Date() } }),
}));

// /health is not under test here and would reach for real infra.
jest.mock('../loops/health/loopHealthService', () => ({
  getLoopHealthReport: async () => ({ loops: [] }),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const loopHealthRouter = require('../routes/loopHealth').default;

function makeApp() {
  const app = express();
  app.use('/api/admin/loops', loopHealthRouter);
  return app;
}

/** A verdict event the snapshot math will count. */
function verdictEvent(runId: string, verdict: string, ts: string) {
  return {
    loopId: 'agent-mode',
    tsSession: `${ts}#${runId}`,
    eventType: 'agent_run_verdict',
    subjectId: runId,
    ts,
    dimensions: { verdict },
  } as unknown as DynamoAttributeMap;
}

const RELEASE_AT = '2026-07-20T12:00:00.000Z';

describe('GET /api/admin/loops/burn-in (ENG-746 AC4)', () => {
  beforeEach(() => {
    fake.rows.clear();
  });

  it('fails closed with an explicit verdict when NO burn-in data exists', async () => {
    const res = await request(makeApp())
      .get('/api/admin/loops/burn-in')
      .query({ releaseAt: RELEASE_AT, releaseIssueId: 'ENG-746' });

    expect(res.status).toBe(200);
    expect(res.body.verdict).toBe('insufficient_data');
    expect(res.body.passesClosureCheck4).toBe(false);
    expect(typeof res.body.reason).toBe('string');
    expect(res.body.reason.length).toBeGreaterThan(0);
    // An agent reading this must not find any field that reads as a pass.
    expect(res.body.verdict).not.toBe('clean');
  });

  it('passes check 4 when a real baseline and a clean post-release window exist', async () => {
    // Baseline day: 20 ok runs, 1 failed.
    const before: DynamoAttributeMap[] = [];
    for (let i = 0; i < 20; i++) {
      before.push(verdictEvent(`b${i}`, 'ok', `2026-07-19T09:0${i % 10}:00.000Z`));
    }
    before.push(verdictEvent('bf', 'failed', '2026-07-19T09:30:00.000Z'));

    // Post-release day: 20 ok runs, 0 failed — no worse than baseline.
    const after: DynamoAttributeMap[] = [];
    for (let i = 0; i < 20; i++) {
      after.push(verdictEvent(`a${i}`, 'ok', `2026-07-21T09:0${i % 10}:00.000Z`));
    }

    for (const e of [...before, ...after]) {
      await fake.putItem(LOOP_EVENTS_TABLE, e);
    }

    // Write the two dated snapshots the way the cron does.
    await writeReliabilitySnapshots({
      dynamo: fake as never,
      clock: { now: () => new Date('2026-07-19T17:45:00.000Z') },
    });
    await writeReliabilitySnapshots({
      dynamo: fake as never,
      clock: { now: () => new Date('2026-07-21T17:45:00.000Z') },
    });

    const res = await request(makeApp())
      .get('/api/admin/loops/burn-in')
      .query({ releaseAt: RELEASE_AT, releaseIssueId: 'ENG-746' });

    expect(res.status).toBe(200);
    expect(res.body.verdict).toBe('clean');
    expect(res.body.passesClosureCheck4).toBe(true);
    // AC2: the comparison is auditable — both sides come back.
    expect(res.body.baseline).not.toBeNull();
    expect(res.body.baseline.date).toBe('2026-07-19');
    expect(res.body.baseline.failedRunRate).toBeGreaterThan(0);
    expect(res.body.postRelease.date).toBe('2026-07-21');
  });

  // Greptile #1: query overrides let a caller manufacture a pass. The policy is
  // fixed; a request may tighten it but never loosen it.
  it('ignores minRuns=0 — a caller cannot buy a pass with a zero-run window', async () => {
    // One post-release run only, and a baseline day.
    await fake.putItem(
      LOOP_EVENTS_TABLE,
      verdictEvent('b0', 'ok', '2026-07-19T09:00:00.000Z'),
    );
    await writeReliabilitySnapshots({
      dynamo: fake as never,
      clock: { now: () => new Date('2026-07-19T17:45:00.000Z') },
    });
    await writeReliabilitySnapshots({
      dynamo: fake as never,
      clock: { now: () => new Date('2026-07-21T17:45:00.000Z') },
    });

    const res = await request(makeApp())
      .get('/api/admin/loops/burn-in')
      .query({ releaseAt: RELEASE_AT, releaseIssueId: 'ENG-746', minRuns: 0 });

    expect(res.body.verdict).toBe('insufficient_data');
    expect(res.body.passesClosureCheck4).toBe(false);
    // The clamp held: the effective policy is still the default.
    expect(res.body.minRunCount).toBe(5);
  });

  it('ignores tolerance=1 — a caller cannot excuse a 0%-to-100% regression', async () => {
    const before: DynamoAttributeMap[] = [];
    for (let i = 0; i < 20; i++) {
      before.push(verdictEvent(`b${i}`, 'ok', `2026-07-19T09:0${i % 10}:00.000Z`));
    }
    // Post-release: every run failed.
    const after: DynamoAttributeMap[] = [];
    for (let i = 0; i < 20; i++) {
      after.push(verdictEvent(`a${i}`, 'failed', `2026-07-21T09:0${i % 10}:00.000Z`));
    }
    for (const e of [...before, ...after]) await fake.putItem(LOOP_EVENTS_TABLE, e);

    await writeReliabilitySnapshots({
      dynamo: fake as never,
      clock: { now: () => new Date('2026-07-19T17:45:00.000Z') },
    });
    await writeReliabilitySnapshots({
      dynamo: fake as never,
      clock: { now: () => new Date('2026-07-21T17:45:00.000Z') },
    });

    const res = await request(makeApp())
      .get('/api/admin/loops/burn-in')
      .query({ releaseAt: RELEASE_AT, releaseIssueId: 'ENG-746', tolerance: 1 });

    expect(res.body.verdict).toBe('regressed');
    expect(res.body.passesClosureCheck4).toBe(false);
    expect(res.body.tolerance).toBe(0.02);
  });

  it('accepts a STRICTER override in both directions', async () => {
    const events: DynamoAttributeMap[] = [];
    for (let i = 0; i < 20; i++) {
      events.push(verdictEvent(`b${i}`, 'ok', `2026-07-19T09:0${i % 10}:00.000Z`));
      events.push(verdictEvent(`a${i}`, 'ok', `2026-07-21T09:0${i % 10}:00.000Z`));
    }
    for (const e of events) await fake.putItem(LOOP_EVENTS_TABLE, e);

    await writeReliabilitySnapshots({
      dynamo: fake as never,
      clock: { now: () => new Date('2026-07-19T17:45:00.000Z') },
    });
    await writeReliabilitySnapshots({
      dynamo: fake as never,
      clock: { now: () => new Date('2026-07-21T17:45:00.000Z') },
    });

    // minRuns above the default is honoured...
    const strict = await request(makeApp())
      .get('/api/admin/loops/burn-in')
      .query({
        releaseAt: RELEASE_AT,
        releaseIssueId: 'ENG-746',
        minRuns: 5000,
        tolerance: 0.001,
      });

    expect(strict.body.minRunCount).toBe(5000);
    expect(strict.body.tolerance).toBe(0.001);
    expect(strict.body.verdict).toBe('insufficient_data');
    expect(strict.body.passesClosureCheck4).toBe(false);
  });

  it('rejects a missing releaseAt rather than defaulting to a pass', async () => {
    const res = await request(makeApp()).get('/api/admin/loops/burn-in');

    expect(res.status).toBe(400);
    expect(res.body.passesClosureCheck4).toBe(false);
  });

  it('rejects an unparseable releaseAt rather than defaulting to a pass', async () => {
    const res = await request(makeApp())
      .get('/api/admin/loops/burn-in')
      .query({ releaseAt: 'yesterday-ish' });

    expect(res.status).toBe(400);
    expect(res.body.passesClosureCheck4).toBe(false);
  });

  it('requires release attribution rather than evaluating an anonymous release', async () => {
    const res = await request(makeApp())
      .get('/api/admin/loops/burn-in')
      .query({ releaseAt: RELEASE_AT });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('releaseIssueId_required');
    expect(res.body.passesClosureCheck4).toBe(false);
  });

  // Incident exclusion is an exact match against releaseIssueId, so a
  // free-form or differently-cased id would fail to match its own incident and
  // exclude the very window that indicts the release.
  it.each(['eng-759', 'ENG 759', '759', 'PR-2293'])(
    'rejects releaseIssueId %p rather than evaluating an unmatchable attribution',
    async (releaseIssueId) => {
      const res = await request(makeApp())
        .get('/api/admin/loops/burn-in')
        .query({ releaseAt: RELEASE_AT, releaseIssueId });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('releaseIssueId_invalid');
      expect(res.body.passesClosureCheck4).toBe(false);
    },
  );

  it('rejects requester-selected 7d policy instead of blending window lines', async () => {
    const res = await request(makeApp())
      .get('/api/admin/loops/burn-in')
      .query({ releaseAt: RELEASE_AT, releaseIssueId: 'ENG-746', window: '7d' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('window_fixed');
    expect(res.body.passesClosureCheck4).toBe(false);
  });

  it('rejects malformed incident attribution', async () => {
    const res = await request(makeApp())
      .get('/api/admin/loops/burn-in')
      .query({ releaseAt: RELEASE_AT, releaseIssueId: 'ENG-746', incident: 'last-week:ENG-1' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('incident_invalid');
    expect(res.body.passesClosureCheck4).toBe(false);
  });
});

describe('fail-closed on infrastructure failure', () => {
  beforeEach(() => {
    fake.rows.clear();
    jest.restoreAllMocks();
  });

  it('burn-in returns 500 WITH passesClosureCheck4:false when the store throws', async () => {
    jest.spyOn(fake, 'query').mockRejectedValueOnce(new Error('dynamo down'));
    jest.spyOn(console, 'error').mockImplementation(() => undefined);

    const res = await request(makeApp())
      .get('/api/admin/loops/burn-in')
      .query({ releaseAt: RELEASE_AT, releaseIssueId: 'ENG-746' });

    expect(res.status).toBe(500);
    // An error must never be mistaken for approval.
    expect(res.body.passesClosureCheck4).toBe(false);
    expect(res.body.verdict).toBe('insufficient_data');
  });

  it('reliability-trend returns 500 rather than an empty-looking success', async () => {
    jest.spyOn(fake, 'query').mockRejectedValueOnce(new Error('dynamo down'));
    jest.spyOn(console, 'error').mockImplementation(() => undefined);

    const res = await request(makeApp()).get('/api/admin/loops/reliability-trend');

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('internal_error');
    // Critically, it does NOT report hasData:false with a 200 — that would be
    // indistinguishable from a genuinely empty trend.
    expect(res.body.hasData).toBeUndefined();
  });
});

describe('GET /api/admin/loops/reliability-trend — emptiness is explicit (AC3)', () => {
  beforeEach(() => {
    fake.rows.clear();
  });

  it('marks an empty trend with hasData:false, not a bare count:0', async () => {
    const res = await request(makeApp()).get('/api/admin/loops/reliability-trend');

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(0);
    expect(res.body.hasData).toBe(false);
    expect(res.body.snapshots).toEqual([]);
  });

  it('marks a populated trend with hasData:true', async () => {
    await fake.putItem(LOOP_EVENTS_TABLE, verdictEvent('r1', 'ok', '2026-07-21T09:00:00.000Z'));
    await writeReliabilitySnapshots({
      dynamo: fake as never,
      clock: { now: () => new Date('2026-07-21T17:45:00.000Z') },
    });

    const res = await request(makeApp()).get('/api/admin/loops/reliability-trend');

    expect(res.status).toBe(200);
    expect(res.body.hasData).toBe(true);
    expect(res.body.count).toBeGreaterThan(0);
    expect(res.body.snapshots[0].failedRunRate).not.toBeNull();
    expect(res.body.snapshots[0].degradedRunRate).not.toBeNull();
    expect(res.body.snapshots[0].loopId).toBeUndefined();
    expect(String(RELIABILITY_SNAPSHOT_LOOP_ID)).toBe('agent-reliability-daily');
  });
});
