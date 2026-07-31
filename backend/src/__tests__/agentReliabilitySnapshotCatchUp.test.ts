/**
 * ENG-746 — snapshot catch-up.
 *
 * The trend endpoint returned nothing because the writer had never run. Once it
 * does run, writing only "today" still leaves closure-gate check 4 unusable for
 * another full day: a single snapshot has no pre-release baseline to compare
 * against, so every assessment is `insufficient_data`.
 *
 * Catch-up closes that gap by computing the recent days that have no row yet
 * from events already in the store, which also makes the cron self-healing
 * after a deploy gap or an outage. Today's row is always rewritten because its
 * window is still moving; completed days are left alone once written.
 */

import type { DynamoAttributeMap, DynamoPort } from '../loops/core/ports';
import { asSubjectId, type NormalizedEvent } from '../loops/core/types';
import {
  EVT_RUN_VERDICT,
  AGENT_MODE_LOOP_ID,
} from '../loops/instances/agent-mode/eventTypes';
import { eventToItem } from '../loops/core/sensors/eventTableEventSource';
import {
  writeReliabilitySnapshots,
  readReliabilityTrend,
  RELIABILITY_SNAPSHOT_LOOP_ID,
} from '../cron/agentReliabilitySnapshotCron';
import { evaluateBurnIn } from '../cron/burnInEvaluation';

const NOW = new Date('2026-06-14T18:00:00Z');

function verdict(ts: string, v: string, runId: string): NormalizedEvent {
  return {
    subjectId: asSubjectId(runId),
    eventType: EVT_RUN_VERDICT,
    ts: new Date(ts),
    dimensions: { verdict: v },
  };
}

function fakeDynamo(seed: NormalizedEvent[] = []) {
  const store = new Map<string, DynamoAttributeMap>();
  for (const e of seed) {
    const item = eventToItem(AGENT_MODE_LOOP_ID, e);
    store.set(`${item.loopId}#${item.tsSession}`, item);
  }
  const port: DynamoPort = {
    putItem: jest.fn(async (_table: string, item: DynamoAttributeMap) => {
      store.set(`${item.loopId}#${item.tsSession}`, item);
    }),
    getItem: jest.fn(async () => null),
    query: jest.fn(async (params) => {
      const loopId = params.expressionAttributeValues?.[':loopId'];
      const items = [...store.values()].filter((i) => i.loopId === loopId);
      return { items };
    }),
  };
  return { port, store };
}

/** Seed several ok/failed verdicts per day across a date range. */
function seedDays(dates: string[], runsPerDay = 10): NormalizedEvent[] {
  const out: NormalizedEvent[] = [];
  for (const d of dates) {
    for (let i = 0; i < runsPerDay; i++) {
      const hh = String(i % 24).padStart(2, '0');
      out.push(verdict(`${d}T${hh}:10:00.000Z`, i === 0 ? 'failed' : 'ok', `${d}-r${i}`));
    }
  }
  return out;
}

const clock = { now: () => NOW };

describe('writeReliabilitySnapshots catch-up (ENG-746)', () => {
  it('writes a row for each recent day that has none, not just today', async () => {
    const { port } = fakeDynamo(
      seedDays(['2026-06-11', '2026-06-12', '2026-06-13', '2026-06-14']),
    );

    await writeReliabilitySnapshots({ dynamo: port, clock }, { catchUpDays: 4 });

    const trend = await readReliabilityTrend(port, { limit: 30, windowLabel: '24h' });
    const dates = trend.map((s) => s.date);

    expect(dates).toEqual(['2026-06-11', '2026-06-12', '2026-06-13', '2026-06-14']);
    // Each day's rates come from that day's own events, so they are real
    // numbers rather than a repeated copy of today.
    for (const s of trend) {
      expect(s.runCount).toBeGreaterThan(0);
      expect(s.failedRunRate).toBeGreaterThan(0);
    }
  });

  it('defaults to today only, preserving the previous behaviour', async () => {
    const { port } = fakeDynamo(seedDays(['2026-06-12', '2026-06-13', '2026-06-14']));

    await writeReliabilitySnapshots({ dynamo: port, clock });

    const trend = await readReliabilityTrend(port, { limit: 30, windowLabel: '24h' });
    expect(trend.map((s) => s.date)).toEqual(['2026-06-14']);
  });

  it('does not rewrite a completed day that already has a row', async () => {
    const { port } = fakeDynamo(seedDays(['2026-06-13', '2026-06-14']));

    await writeReliabilitySnapshots({ dynamo: port, clock }, { catchUpDays: 3 });
    const writesAfterFirst = (port.putItem as jest.Mock).mock.calls.length;

    await writeReliabilitySnapshots({ dynamo: port, clock }, { catchUpDays: 3 });
    const writesAfterSecond = (port.putItem as jest.Mock).mock.calls.length;

    // Second pass rewrites only the current day (24h + 7d = 2 rows).
    expect(writesAfterSecond - writesAfterFirst).toBe(2);
  });

  it('stays idempotent — repeat runs never duplicate a (date, window) row', async () => {
    const { port } = fakeDynamo(seedDays(['2026-06-12', '2026-06-13', '2026-06-14']));

    await writeReliabilitySnapshots({ dynamo: port, clock }, { catchUpDays: 3 });
    await writeReliabilitySnapshots({ dynamo: port, clock }, { catchUpDays: 3 });

    const trend = await readReliabilityTrend(port, { limit: 30, windowLabel: '24h' });
    expect(trend.map((s) => s.date)).toEqual(['2026-06-12', '2026-06-13', '2026-06-14']);
    expect(new Set(trend.map((s) => s.date)).size).toBe(trend.length);
  });

  it('reads the event partition once regardless of how many days it fills', async () => {
    const { port } = fakeDynamo(seedDays(['2026-06-10', '2026-06-12', '2026-06-14']));

    await writeReliabilitySnapshots({ dynamo: port, clock }, { catchUpDays: 7 });

    const eventQueries = (port.query as jest.Mock).mock.calls.filter(
      (c) => c[0]?.expressionAttributeValues?.[':loopId'] === AGENT_MODE_LOOP_ID,
    );
    expect(eventQueries.length).toBe(1);
  });

  it('writes both window labels for every caught-up day', async () => {
    const { port } = fakeDynamo(seedDays(['2026-06-13', '2026-06-14']));

    await writeReliabilitySnapshots({ dynamo: port, clock }, { catchUpDays: 2 });

    const daily = await readReliabilityTrend(port, { limit: 30, windowLabel: '24h' });
    const weekly = await readReliabilityTrend(port, { limit: 30, windowLabel: '7d' });

    expect(daily.map((s) => s.date)).toEqual(['2026-06-13', '2026-06-14']);
    expect(weekly.map((s) => s.date)).toEqual(['2026-06-13', '2026-06-14']);
    expect(String(RELIABILITY_SNAPSHOT_LOOP_ID)).toBe('agent-reliability-daily');
  });

  // Greptile #2: subtracting whole days from `now` preserves the time of day,
  // so a row labelled for one UTC date carried hours from the previous one.
  // Burn-in classifies rows pre/post-release purely by that label, so a
  // "post-release" snapshot could be full of pre-release events.
  it('a completed day covers its own UTC date, not a now-anchored 24h slice', async () => {
    // NOW is 18:00Z. Events at 02:00 and 22:00 on 06-13 both belong to 06-13,
    // but a now-anchored window (06-12T18:00 → 06-13T18:00) would capture the
    // 02:00 one and miss the 22:00 one.
    const { port } = fakeDynamo([
      verdict('2026-06-13T02:00:00.000Z', 'ok', 'early'),
      verdict('2026-06-13T22:00:00.000Z', 'failed', 'late'),
    ]);

    await writeReliabilitySnapshots({ dynamo: port, clock }, { catchUpDays: 3 });

    const trend = await readReliabilityTrend(port, { limit: 30, windowLabel: '24h' });
    const day13 = trend.find((s) => s.date === '2026-06-13');

    expect(day13).toBeDefined();
    // Both of that date's runs are counted in that date's row.
    expect(day13?.runCount).toBe(2);
    expect(day13?.failedRuns).toBe(1);
    expect(day13?.windowEnd).toBe('2026-06-13T23:59:59.999Z');
  });

  it('does not leak a completed day\'s events into the following day\'s row', async () => {
    const { port } = fakeDynamo([verdict('2026-06-13T22:00:00.000Z', 'failed', 'late')]);

    await writeReliabilitySnapshots({ dynamo: port, clock }, { catchUpDays: 3 });

    const trend = await readReliabilityTrend(port, { limit: 30, windowLabel: '24h' });
    const day12 = trend.find((s) => s.date === '2026-06-12');

    expect(day12?.runCount).toBe(0);
  });

  it('still lets today be a partial window ending at now', async () => {
    const { port } = fakeDynamo(seedDays(['2026-06-14']));

    await writeReliabilitySnapshots({ dynamo: port, clock }, { catchUpDays: 2 });

    const trend = await readReliabilityTrend(port, { limit: 30, windowLabel: '24h' });
    const today = trend.find((s) => s.date === '2026-06-14');

    expect(today?.windowEnd).toBe(NOW.toISOString());
  });

  it('end-to-end: catch-up makes check 4 computable on the first run', async () => {
    // The whole point — before this, one run produced one snapshot and check 4
    // stayed insufficient_data for want of a baseline.
    const { port } = fakeDynamo(
      seedDays(['2026-06-11', '2026-06-12', '2026-06-13', '2026-06-14']),
    );

    await writeReliabilitySnapshots({ dynamo: port, clock }, { catchUpDays: 4 });
    const snapshots = await readReliabilityTrend(port, { limit: 30, windowLabel: '24h' });

    const assessment = evaluateBurnIn({
      snapshots,
      releaseAt: new Date('2026-06-13T09:00:00.000Z'),
    });

    expect(assessment.verdict).toBe('clean');
    expect(assessment.passesClosureCheck4).toBe(true);
    expect(assessment.baseline?.date).toBe('2026-06-12');
    expect(assessment.postRelease?.date).toBe('2026-06-14');
  });

  it('a day with no events still yields no false-clean verdict', async () => {
    // 06-13 is deliberately absent from the seed.
    const { port } = fakeDynamo(seedDays(['2026-06-11', '2026-06-12']));

    await writeReliabilitySnapshots({ dynamo: port, clock }, { catchUpDays: 4 });
    const snapshots = await readReliabilityTrend(port, { limit: 30, windowLabel: '24h' });

    // A row exists for 06-14, but it summarizes zero runs.
    const today = snapshots.find((s) => s.date === '2026-06-14');
    expect(today).toBeDefined();
    expect(today?.runCount).toBe(0);
    expect(today?.failedRunRate).toBe(0); // the trap: 0 looks perfect

    const assessment = evaluateBurnIn({
      snapshots,
      releaseAt: new Date('2026-06-14T09:00:00.000Z'),
    });

    expect(assessment.verdict).toBe('insufficient_data');
    expect(assessment.passesClosureCheck4).toBe(false);
  });
});
