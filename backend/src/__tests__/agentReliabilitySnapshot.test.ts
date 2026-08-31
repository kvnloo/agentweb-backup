/**
 * Tests for the agent-mode daily reliability snapshot.
 *
 * Covers the three human-written acceptance criteria + the cluster aggregation:
 *   AC1 — tool_success_rate = succeeded/invoked, degraded_rate =
 *         degraded/total-verdicts, computed correctly; one row written per date.
 *   AC2 — running the cron twice for the same date => ONE row (idempotent).
 *   AC3 — the read path returns snapshots in date order.
 *   + top toolName×errorClass cluster aggregation.
 */

import type { DynamoAttributeMap, DynamoPort } from '../loops/core/ports';
import { asSubjectId } from '../loops/core/types';
import type { NormalizedEvent } from '../loops/core/types';
import {
  EVT_DECISION,
  EVT_RUN_VERDICT,
  EVT_TOOL_FAILED,
  EVT_TOOL_INVOKED,
  EVT_TOOL_SUCCEEDED,
} from '../loops/instances/agent-mode/eventTypes';
import { LOOP_EVENTS_TABLE } from '../loops/core/sensors/eventTableEventSource';
import { AGENT_MODE_LOOP_ID } from '../loops/instances/agent-mode/eventTypes';
import { eventToItem } from '../loops/core/sensors/eventTableEventSource';
import { computeReliabilitySnapshot } from '../cron/agentReliabilitySnapshot';
import {
  writeReliabilitySnapshots,
  readReliabilityTrend,
  RELIABILITY_SNAPSHOT_LOOP_ID,
} from '../cron/agentReliabilitySnapshotCron';

const NOW = new Date('2026-06-14T18:00:00Z');

function ev(
  eventType: string,
  ts: string,
  dimensions: Record<string, string | number | boolean | null>,
  subjectId = 'run-x',
): NormalizedEvent {
  return { subjectId: asSubjectId(subjectId), eventType, ts: new Date(ts), dimensions };
}

/** In-memory DynamoPort keyed by `loopId#tsSession` — putItem overwrites a
 * duplicate key, exactly like the real table. */
function fakeDynamo(seed: NormalizedEvent[] = []) {
  const store = new Map<string, DynamoAttributeMap>();
  // Seed agent-mode events so writeReliabilitySnapshots can read them.
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

describe('computeReliabilitySnapshot (pure)', () => {
  it('AC1: tool_success_rate = succeeded/invoked and degraded_rate = degraded/total-verdicts', () => {
    const start = new Date('2026-06-13T18:00:00Z');
    const events: NormalizedEvent[] = [
      // 4 invocations, 3 succeeded, 1 failed => success rate 3/4 = 0.75
      ev(EVT_TOOL_INVOKED, '2026-06-14T01:00:00Z', { toolName: 'a' }),
      ev(EVT_TOOL_INVOKED, '2026-06-14T02:00:00Z', { toolName: 'a' }),
      ev(EVT_TOOL_INVOKED, '2026-06-14T03:00:00Z', { toolName: 'b' }),
      ev(EVT_TOOL_INVOKED, '2026-06-14T04:00:00Z', { toolName: 'b' }),
      ev(EVT_TOOL_SUCCEEDED, '2026-06-14T01:01:00Z', { toolName: 'a' }),
      ev(EVT_TOOL_SUCCEEDED, '2026-06-14T02:01:00Z', { toolName: 'a' }),
      ev(EVT_TOOL_SUCCEEDED, '2026-06-14T03:01:00Z', { toolName: 'b' }),
      ev(EVT_TOOL_FAILED, '2026-06-14T04:01:00Z', { toolName: 'b', errorClass: 'TimeoutError' }),
      // 4 verdicts: 2 ok, 1 degraded, 1 failed => degraded 1/4=0.25, failed 1/4=0.25
      ev(EVT_RUN_VERDICT, '2026-06-14T01:05:00Z', { verdict: 'ok' }, 'r1'),
      ev(EVT_RUN_VERDICT, '2026-06-14T02:05:00Z', { verdict: 'ok' }, 'r2'),
      ev(EVT_RUN_VERDICT, '2026-06-14T03:05:00Z', { verdict: 'degraded' }, 'r3'),
      ev(EVT_RUN_VERDICT, '2026-06-14T04:05:00Z', { verdict: 'failed' }, 'r4'),
    ];

    const snap = computeReliabilitySnapshot({
      events,
      date: '2026-06-14',
      windowStart: start,
      windowEnd: NOW,
      windowLabel: '24h',
      now: NOW,
    });

    expect(snap.toolInvoked).toBe(4);
    expect(snap.toolSucceeded).toBe(3);
    expect(snap.toolSuccessRate).toBeCloseTo(0.75, 6);
    expect(snap.runCount).toBe(4);
    expect(snap.degradedRunRate).toBeCloseTo(0.25, 6);
    expect(snap.failedRunRate).toBeCloseTo(0.25, 6);
  });

  it('handles zero denominators without NaN', () => {
    const snap = computeReliabilitySnapshot({
      events: [],
      date: '2026-06-14',
      windowStart: new Date('2026-06-13T18:00:00Z'),
      windowEnd: NOW,
      windowLabel: '24h',
      now: NOW,
    });
    expect(snap.toolSuccessRate).toBe(0);
    expect(snap.degradedRunRate).toBe(0);
    expect(snap.failedRunRate).toBe(0);
    expect(snap.runCount).toBe(0);
    expect(snap.topClusters).toEqual([]);
  });

  it('computes median + p90 iterations from per-run max decision iteration', () => {
    const start = new Date('2026-06-13T18:00:00Z');
    // 5 runs with max iterations 1,2,3,4,10 => median 3, p90 (nearest-rank) = 10
    const mk = (run: string, iters: number[]) =>
      iters.map((i) => ev(EVT_DECISION, '2026-06-14T01:00:00Z', { iteration: i }, run));
    const events: NormalizedEvent[] = [
      ...mk('r1', [1]),
      ...mk('r2', [1, 2]),
      ...mk('r3', [1, 2, 3]),
      ...mk('r4', [4]),
      ...mk('r5', [10]),
    ];
    const snap = computeReliabilitySnapshot({
      events,
      date: '2026-06-14',
      windowStart: start,
      windowEnd: NOW,
      windowLabel: '24h',
      now: NOW,
    });
    expect(snap.medianIterations).toBe(3);
    expect(snap.p90Iterations).toBe(10);
  });

  it('aggregates the top 5 toolName×errorClass clusters by count', () => {
    const start = new Date('2026-06-13T18:00:00Z');
    const fail = (tool: string, ec: string, n: number) =>
      Array.from({ length: n }, () =>
        ev(EVT_TOOL_FAILED, '2026-06-14T01:00:00Z', { toolName: tool, errorClass: ec }),
      );
    const events: NormalizedEvent[] = [
      ...fail('search', 'TimeoutError', 5),
      ...fail('search', 'AuthError', 2),
      ...fail('email', 'RateLimit', 4),
      ...fail('image', 'ValidationError', 3),
      ...fail('crm', 'TimeoutError', 1),
      ...fail('deploy', 'NetworkError', 6),
    ];
    const snap = computeReliabilitySnapshot({
      events,
      date: '2026-06-14',
      windowStart: start,
      windowEnd: NOW,
      windowLabel: '24h',
      now: NOW,
    });
    expect(snap.topClusters).toHaveLength(5);
    expect(snap.topClusters[0]).toEqual({ toolName: 'deploy', errorClass: 'NetworkError', count: 6 });
    expect(snap.topClusters[1]).toEqual({ toolName: 'search', errorClass: 'TimeoutError', count: 5 });
    // The smallest cluster (crm×TimeoutError, 1) is dropped by the top-5 cap.
    expect(snap.topClusters.some((c) => c.toolName === 'crm')).toBe(false);
  });

  it('does not collide two distinct toolName/errorClass pairs that share the same joined string (CodeRabbit, PR #2443)', () => {
    // "alpha beta" + "gamma" and "alpha" + "beta gamma" both naively join to
    // "alpha beta gamma" under a plain `${toolName} ${errorClass}` key.
    const start = new Date('2026-06-13T18:00:00Z');
    const events: NormalizedEvent[] = [
      ev(EVT_TOOL_FAILED, '2026-06-14T01:00:00Z', { toolName: 'alpha beta', errorClass: 'gamma' }),
      ev(EVT_TOOL_FAILED, '2026-06-14T01:01:00Z', { toolName: 'alpha', errorClass: 'beta gamma' }),
    ];
    const snap = computeReliabilitySnapshot({
      events,
      date: '2026-06-14',
      windowStart: start,
      windowEnd: NOW,
      windowLabel: '24h',
      now: NOW,
    });
    expect(snap.topClusters).toHaveLength(2);
    expect(snap.topClusters).toEqual(
      expect.arrayContaining([
        { toolName: 'alpha beta', errorClass: 'gamma', count: 1 },
        { toolName: 'alpha', errorClass: 'beta gamma', count: 1 },
      ]),
    );
  });

  it('ignores events outside the window', () => {
    const start = new Date('2026-06-14T00:00:00Z');
    const events: NormalizedEvent[] = [
      ev(EVT_TOOL_INVOKED, '2026-06-10T01:00:00Z', { toolName: 'a' }), // before window
      ev(EVT_TOOL_INVOKED, '2026-06-14T01:00:00Z', { toolName: 'a' }), // in window
      ev(EVT_TOOL_SUCCEEDED, '2026-06-14T01:01:00Z', { toolName: 'a' }),
    ];
    const snap = computeReliabilitySnapshot({
      events,
      date: '2026-06-14',
      windowStart: start,
      windowEnd: NOW,
      windowLabel: '24h',
      now: NOW,
    });
    expect(snap.toolInvoked).toBe(1);
    expect(snap.toolSuccessRate).toBe(1);
  });
});

describe('writeReliabilitySnapshots + readReliabilityTrend (store)', () => {
  const clock = { now: () => NOW };

  it('AC1: writes exactly one snapshot row per (date, window)', async () => {
    const seed: NormalizedEvent[] = [
      ev(EVT_TOOL_INVOKED, '2026-06-14T01:00:00Z', { toolName: 'a' }),
      ev(EVT_TOOL_SUCCEEDED, '2026-06-14T01:01:00Z', { toolName: 'a' }),
      ev(EVT_RUN_VERDICT, '2026-06-14T01:05:00Z', { verdict: 'ok' }, 'r1'),
    ];
    const { port, store } = fakeDynamo(seed);

    const written = await writeReliabilitySnapshots({ dynamo: port, clock });

    // Two windows (24h + 7d) => two snapshot rows for this date.
    expect(written.map((s) => s.windowLabel).sort()).toEqual(['24h', '7d']);
    const snapRows = [...store.values()].filter((i) => i.loopId === RELIABILITY_SNAPSHOT_LOOP_ID);
    expect(snapRows).toHaveLength(2);
    const row24h = written.find((s) => s.windowLabel === '24h')!;
    expect(row24h.date).toBe('2026-06-14');
    expect(row24h.toolSuccessRate).toBe(1);
  });

  it('AC2: running twice for the same date results in ONE row per window (idempotent overwrite)', async () => {
    const { port, store } = fakeDynamo([
      ev(EVT_TOOL_INVOKED, '2026-06-14T01:00:00Z', { toolName: 'a' }),
      ev(EVT_TOOL_SUCCEEDED, '2026-06-14T01:01:00Z', { toolName: 'a' }),
    ]);

    await writeReliabilitySnapshots({ dynamo: port, clock });
    await writeReliabilitySnapshots({ dynamo: port, clock });

    const snapRows = [...store.values()].filter((i) => i.loopId === RELIABILITY_SNAPSHOT_LOOP_ID);
    // Still only 2 rows (24h + 7d), not 4 — the second run overwrote.
    expect(snapRows).toHaveLength(2);
  });

  it('AC3: the read path returns snapshots in date order (oldest-first)', async () => {
    const { port } = fakeDynamo();

    // Write three days out of order.
    for (const d of ['2026-06-12T18:00:00Z', '2026-06-10T18:00:00Z', '2026-06-11T18:00:00Z']) {
      await writeReliabilitySnapshots({ dynamo: port, clock: { now: () => new Date(d) } });
    }

    const trend = await readReliabilityTrend(port, { windowLabel: '24h' });
    expect(trend.map((s) => s.date)).toEqual(['2026-06-10', '2026-06-11', '2026-06-12']);
  });

  it('read path honors the limit (last N)', async () => {
    const { port } = fakeDynamo();
    for (const d of ['2026-06-09', '2026-06-10', '2026-06-11', '2026-06-12']) {
      await writeReliabilitySnapshots({ dynamo: port, clock: { now: () => new Date(`${d}T18:00:00Z`) } });
    }
    const trend = await readReliabilityTrend(port, { windowLabel: '24h', limit: 2 });
    expect(trend.map((s) => s.date)).toEqual(['2026-06-11', '2026-06-12']);
  });

  it('read path filters by window label', async () => {
    const { port } = fakeDynamo();
    await writeReliabilitySnapshots({ dynamo: port, clock });
    const trend7d = await readReliabilityTrend(port, { windowLabel: '7d' });
    expect(trend7d).toHaveLength(1);
    expect(trend7d[0].windowLabel).toBe('7d');
  });
});
