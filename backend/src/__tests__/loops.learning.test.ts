/**
 * Tests for the layer-5 learning engine: the generic metric evaluator + the
 * attribution (did-the-fix-move-the-metric) engine that closes the loop.
 *
 * Behavioral acceptance criteria (human-written):
 *  - computeTargetMetric counts numerator/denominator events in a window and
 *    returns null ratio when there is no denominator (no signal).
 *  - computeVerdict is conservative: too few samples OR no baseline → inconclusive;
 *    it never retires a fix on noise.
 *  - runAttribution attributes a shipped mutation once its settle window elapses,
 *    writes the outcome back, is idempotent (no double-attribution), and respects
 *    the settle window (no attribution before it elapses).
 *  - the recorded outcome is readable via lastOutcomeForRule (the policy read-back
 *    that closes the loop).
 */

import {
  computeTargetMetric,
  type TargetMetricSpec,
} from '../loops/core/learning/metricEvaluator';
import {
  computeVerdict,
  runAttribution,
  type VerdictThresholds,
} from '../loops/core/learning/attribution';
import { InMemoryLearningStore } from '../loops/core/learning/inMemoryLearningStore';
import type { EventSource, NormalizedEvent, TimeWindow } from '../loops/core/types';
import { asLoopId, asMutationId, asRunId, asSubjectId } from '../loops/core/types';

const METRIC: TargetMetricSpec = {
  name: 'eval_to_signup_rate',
  numeratorEvent: 'signed_up',
  denominatorEvent: 'form_submitted',
  windowDays: 7,
};
const DAY = 24 * 60 * 60 * 1000;

/** Sensor stub backed by a flat event list, filtering like the real one. */
class StubSensor implements EventSource {
  constructor(private readonly events: NormalizedEvent[]) {}
  async fetchEvents(window: TimeWindow, filter?: { eventTypes?: readonly string[] }) {
    return this.events.filter(
      (e) =>
        e.ts >= window.start &&
        e.ts <= window.end &&
        (!filter?.eventTypes || filter.eventTypes.includes(e.eventType)),
    );
  }
}

function ev(eventType: string, ts: Date): NormalizedEvent {
  return { subjectId: asSubjectId(`s-${eventType}-${ts.getTime()}-${Math.floor(ts.getMilliseconds())}`), eventType, ts };
}

function manyEvents(eventType: string, n: number, baseTs: number): NormalizedEvent[] {
  return Array.from({ length: n }, (_, i) => ev(eventType, new Date(baseTs + i)));
}

// ---------------------------------------------------------------------------
// computeTargetMetric
// ---------------------------------------------------------------------------

describe('computeTargetMetric', () => {
  const window: TimeWindow = { start: new Date(0), end: new Date(100 * DAY) };

  it('computes ratio = numerator / denominator', async () => {
    const sensor = new StubSensor([
      ...manyEvents('form_submitted', 10, 1 * DAY),
      ...manyEvents('signed_up', 4, 2 * DAY),
      ...manyEvents('landed', 99, 3 * DAY), // ignored — not part of the metric
    ]);
    const r = await computeTargetMetric(sensor, METRIC, window);
    expect(r).toEqual({ ratio: 0.4, numerator: 4, denominator: 10 });
  });

  it('returns null ratio when there is no denominator (no signal, not 0%)', async () => {
    const sensor = new StubSensor(manyEvents('signed_up', 3, 1 * DAY));
    const r = await computeTargetMetric(sensor, METRIC, window);
    expect(r).toEqual({ ratio: null, numerator: 3, denominator: 0 });
  });

  it('only counts events inside the window', async () => {
    const sensor = new StubSensor([
      ...manyEvents('form_submitted', 5, 1 * DAY),
      ...manyEvents('form_submitted', 5, 50 * DAY),
    ]);
    const r = await computeTargetMetric(sensor, METRIC, { start: new Date(0), end: new Date(2 * DAY) });
    expect(r.denominator).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// computeVerdict
// ---------------------------------------------------------------------------

describe('computeVerdict', () => {
  const t: VerdictThresholds = { promoteLiftPct: 15, retireLiftPct: -10, minSampleN: 5 };
  const r = (ratio: number | null, denominator: number) => ({
    ratio,
    denominator,
    numerator: ratio == null ? 0 : Math.round(ratio * denominator),
  });

  it('improved when lift >= promoteLiftPct', () => {
    expect(computeVerdict(r(0.1, 20), r(0.2, 20), t)).toMatchObject({ verdict: 'improved', observedLiftPct: 100 });
  });

  it('regressed when lift <= retireLiftPct', () => {
    expect(computeVerdict(r(0.2, 20), r(0.1, 20), t)).toMatchObject({ verdict: 'regressed' });
  });

  it('no_change for a small move inside the band', () => {
    expect(computeVerdict(r(0.2, 20), r(0.21, 20), t)).toMatchObject({ verdict: 'no_change' });
  });

  it('inconclusive when the after-sample is too small (never retire on noise)', () => {
    expect(computeVerdict(r(0.2, 20), r(0.0, 2), t)).toEqual({
      verdict: 'inconclusive',
      observedLiftPct: null,
      sampleN: 2,
    });
  });

  it('inconclusive when there is no baseline', () => {
    expect(computeVerdict(r(null, 0), r(0.2, 20), t)).toMatchObject({ verdict: 'inconclusive' });
  });

  it('improved from a zero baseline when the rate becomes positive', () => {
    expect(computeVerdict(r(0, 20), r(0.1, 20), t)).toMatchObject({ verdict: 'improved' });
  });

  it('no_change from zero to zero', () => {
    expect(computeVerdict(r(0, 20), r(0, 20), t)).toMatchObject({ verdict: 'no_change' });
  });
});

// ---------------------------------------------------------------------------
// runAttribution
// ---------------------------------------------------------------------------

describe('runAttribution', () => {
  const loopId = asLoopId('ai-eval-funnel');
  const manifest = {
    loopId,
    targetMetric: METRIC,
    thresholds: { promoteLiftPct: 15, retireLiftPct: -10, promoteMinNPerArm: 5 },
  };
  const shippedAt = new Date(30 * DAY);

  /** Seed the store with one shipped (auto_shipped) mutation for capture-broken. */
  async function seedShipped(store: InMemoryLearningStore) {
    await store.record({
      loopId,
      runId: asRunId('run-1'),
      ts: shippedAt,
      proposal: {
        proposalId: asMutationId('m1'),
        sourceRuleId: 'capture-broken',
        hypothesis: 'capture is broken',
        kind: 'copy',
        payload: {},
        triggeringStats: {},
      },
      mutation: { mutationId: asMutationId('m1'), proposalId: asMutationId('m1'), kind: 'copy', artifact: {} },
      decision: { status: 'auto_shipped', decidedAt: shippedAt },
      shippedAt,
    });
  }

  // before-window [shippedAt-7d, shippedAt]: 10 submits, 1 signup → 0.1
  // after-window  [shippedAt, shippedAt+7d]: 10 submits, 4 signups → 0.4 → improved
  function improvedSensor(): StubSensor {
    return new StubSensor([
      ...manyEvents('form_submitted', 10, shippedAt.getTime() - 3 * DAY),
      ...manyEvents('signed_up', 1, shippedAt.getTime() - 2 * DAY),
      ...manyEvents('form_submitted', 10, shippedAt.getTime() + 1 * DAY),
      ...manyEvents('signed_up', 4, shippedAt.getTime() + 2 * DAY),
    ]);
  }

  it('attributes a shipped fix once the settle window has elapsed', async () => {
    const store = new InMemoryLearningStore();
    await seedShipped(store);
    const clock = { now: () => new Date(shippedAt.getTime() + 8 * DAY) }; // window elapsed

    const summary = await runAttribution({ manifest, sensor: improvedSensor(), learning: store, clock });

    expect(summary.evaluated).toBe(1);
    expect(summary.attributed).toBe(1);
    expect(summary.outcomes[0]).toMatchObject({ ruleId: 'capture-broken', verdict: 'improved' });

    // The outcome is now readable by the policy layer.
    const last = await store.lastOutcomeForRule(loopId, 'capture-broken');
    expect(last?.verdict).toBe('improved');
    expect(last?.metricBefore).toBeCloseTo(0.1);
    expect(last?.metricAfter).toBeCloseTo(0.4);
  });

  it('does NOT attribute before the settle window elapses', async () => {
    const store = new InMemoryLearningStore();
    await seedShipped(store);
    const clock = { now: () => new Date(shippedAt.getTime() + 1 * DAY) }; // too early

    const summary = await runAttribution({ manifest, sensor: improvedSensor(), learning: store, clock });
    expect(summary.evaluated).toBe(0);
    expect(summary.attributed).toBe(0);
  });

  it('is idempotent — a second run attributes nothing new', async () => {
    const store = new InMemoryLearningStore();
    await seedShipped(store);
    const clock = { now: () => new Date(shippedAt.getTime() + 8 * DAY) };

    const first = await runAttribution({ manifest, sensor: improvedSensor(), learning: store, clock });
    expect(first.attributed).toBe(1);
    const second = await runAttribution({ manifest, sensor: improvedSensor(), learning: store, clock });
    expect(second.evaluated).toBe(0);
    expect(second.attributed).toBe(0);
  });
});
