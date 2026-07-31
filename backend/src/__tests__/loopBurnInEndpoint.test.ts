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
      .query({ releaseAt: RELEASE_AT });

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
      .query({ releaseAt: RELEASE_AT });

    expect(res.status).toBe(200);
    expect(res.body.verdict).toBe('clean');
    expect(res.body.passesClosureCheck4).toBe(true);
    // AC2: the comparison is auditable — both sides come back.
    expect(res.body.baseline).not.toBeNull();
    expect(res.body.baseline.date).toBe('2026-07-19');
    expect(res.body.baseline.failedRunRate).toBeGreaterThan(0);
    expect(res.body.postRelease.date).toBe('2026-07-21');
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
