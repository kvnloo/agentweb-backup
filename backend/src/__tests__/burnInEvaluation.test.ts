/**
 * ENG-746 — burn-in evaluation for closure-gate check 4.
 *
 * The acceptance criteria that matter most here are #3 and #4: an empty result
 * must be EXPLICITLY distinguishable from a clean burn-in, and an agent must
 * never be able to read "no data" as "passed". Every test below that asserts
 * `passesClosureCheck4 === false` is guarding that property.
 */

import {
  evaluateBurnIn,
  BURN_IN_DEFAULT_MIN_RUN_COUNT,
  BURN_IN_DEFAULT_TOLERANCE,
  type BurnInAssessment,
} from '../cron/burnInEvaluation';
import type { ReliabilitySnapshot } from '../cron/agentReliabilitySnapshot';

/** Minimal snapshot factory — only the fields the evaluator reads matter. */
function snap(
  date: string,
  over: Partial<ReliabilitySnapshot> = {},
): ReliabilitySnapshot {
  return {
    date,
    windowStart: `${date}T00:00:00.000Z`,
    windowEnd: `${date}T23:59:59.999Z`,
    windowLabel: '24h',
    toolInvoked: 100,
    toolSucceeded: 95,
    toolFailed: 5,
    toolSuccessRate: 0.95,
    runCount: 50,
    okRuns: 45,
    degradedRuns: 3,
    failedRuns: 2,
    degradedRunRate: 0.06,
    failedRunRate: 0.04,
    medianIterations: 4,
    p90Iterations: 9,
    topClusters: [],
    computedAt: `${date}T17:45:00.000Z`,
    ...over,
  };
}

const RELEASE_AT = new Date('2026-07-20T12:00:00.000Z');

describe('evaluateBurnIn — empty is never a pass (ENG-746 AC3)', () => {
  it('returns insufficient_data, not clean, when there are no snapshots at all', () => {
    const a = evaluateBurnIn({ snapshots: [], releaseAt: RELEASE_AT });

    expect(a.verdict).toBe('insufficient_data');
    expect(a.passesClosureCheck4).toBe(false);
    expect(a.baseline).toBeNull();
    expect(a.postRelease).toBeNull();
    // The reason must name the absence explicitly — not an empty string an
    // agent could skim past.
    expect(a.reason).toMatch(/no snapshot/i);
  });

  it('is verdict-distinguishable from a clean run (the two must never collide)', () => {
    const empty = evaluateBurnIn({ snapshots: [], releaseAt: RELEASE_AT });
    const clean = evaluateBurnIn({
      snapshots: [snap('2026-07-19'), snap('2026-07-21')],
      releaseAt: RELEASE_AT,
    });

    expect(empty.verdict).not.toBe(clean.verdict);
    expect(empty.passesClosureCheck4).toBe(false);
    expect(clean.passesClosureCheck4).toBe(true);
  });

  it('fails closed when a pre-release baseline is missing (only post-release data)', () => {
    const a = evaluateBurnIn({
      snapshots: [snap('2026-07-21'), snap('2026-07-22')],
      releaseAt: RELEASE_AT,
    });

    expect(a.verdict).toBe('insufficient_data');
    expect(a.passesClosureCheck4).toBe(false);
    expect(a.baseline).toBeNull();
    expect(a.reason).toMatch(/baseline/i);
  });

  it('fails closed when nothing has been recorded since the release', () => {
    const a = evaluateBurnIn({
      snapshots: [snap('2026-07-18'), snap('2026-07-19')],
      releaseAt: RELEASE_AT,
    });

    expect(a.verdict).toBe('insufficient_data');
    expect(a.passesClosureCheck4).toBe(false);
    expect(a.postRelease).toBeNull();
    expect(a.reason).toMatch(/since the release|post-release/i);
  });

  it('AC3 the false-green trap: a zero-run post-release window is NOT clean', () => {
    // computeReliabilitySnapshot emits rate 0 when the denominator is 0, so a
    // dead window reads as a flawless 0% failure rate. It must not pass.
    const deadWindow = snap('2026-07-21', {
      runCount: 0,
      okRuns: 0,
      degradedRuns: 0,
      failedRuns: 0,
      degradedRunRate: 0,
      failedRunRate: 0,
    });

    const a = evaluateBurnIn({
      snapshots: [snap('2026-07-19'), deadWindow],
      releaseAt: RELEASE_AT,
    });

    expect(a.verdict).toBe('insufficient_data');
    expect(a.passesClosureCheck4).toBe(false);
    expect(a.reason).toMatch(/run/i);
  });

  it('AC3: a zero-run BASELINE is not a usable comparison either', () => {
    const deadBaseline = snap('2026-07-19', {
      runCount: 0,
      degradedRunRate: 0,
      failedRunRate: 0,
    });

    const a = evaluateBurnIn({
      snapshots: [deadBaseline, snap('2026-07-21')],
      releaseAt: RELEASE_AT,
    });

    expect(a.verdict).toBe('insufficient_data');
    expect(a.passesClosureCheck4).toBe(false);
  });

  it('a post-release window below the minimum run count fails closed', () => {
    const thin = snap('2026-07-21', {
      runCount: BURN_IN_DEFAULT_MIN_RUN_COUNT - 1,
      failedRunRate: 0,
      degradedRunRate: 0,
    });

    const a = evaluateBurnIn({
      snapshots: [snap('2026-07-19'), thin],
      releaseAt: RELEASE_AT,
    });

    expect(a.verdict).toBe('insufficient_data');
    expect(a.passesClosureCheck4).toBe(false);
  });
});

describe('evaluateBurnIn — real comparison against the pre-release baseline (AC1/AC2)', () => {
  it('passes when both rates are no worse than the baseline', () => {
    const baseline = snap('2026-07-19', { failedRunRate: 0.1, degradedRunRate: 0.2 });
    const after = snap('2026-07-21', { failedRunRate: 0.05, degradedRunRate: 0.1 });

    const a = evaluateBurnIn({ snapshots: [baseline, after], releaseAt: RELEASE_AT });

    expect(a.verdict).toBe('clean');
    expect(a.passesClosureCheck4).toBe(true);
    // AC2: the baseline actually used must be reported back, so "no worse than
    // the pre-release snapshot" is an auditable computation.
    expect(a.baseline?.date).toBe('2026-07-19');
    expect(a.baseline?.failedRunRate).toBe(0.1);
    expect(a.postRelease?.date).toBe('2026-07-21');
  });

  it('flags a regression when failedRunRate rises beyond tolerance', () => {
    const baseline = snap('2026-07-19', { failedRunRate: 0.02, degradedRunRate: 0.05 });
    const after = snap('2026-07-21', { failedRunRate: 0.4, degradedRunRate: 0.05 });

    const a = evaluateBurnIn({ snapshots: [baseline, after], releaseAt: RELEASE_AT });

    expect(a.verdict).toBe('regressed');
    expect(a.passesClosureCheck4).toBe(false);
    expect(a.reason).toMatch(/failedRunRate/i);
  });

  it('flags a regression when degradedRunRate rises beyond tolerance', () => {
    const baseline = snap('2026-07-19', { failedRunRate: 0.02, degradedRunRate: 0.05 });
    const after = snap('2026-07-21', { failedRunRate: 0.02, degradedRunRate: 0.5 });

    const a = evaluateBurnIn({ snapshots: [baseline, after], releaseAt: RELEASE_AT });

    expect(a.verdict).toBe('regressed');
    expect(a.passesClosureCheck4).toBe(false);
    expect(a.reason).toMatch(/degradedRunRate/i);
  });

  it('absorbs sub-tolerance noise rather than failing closed forever', () => {
    const baseline = snap('2026-07-19', { failedRunRate: 0.03, degradedRunRate: 0.05 });
    const after = snap('2026-07-21', {
      failedRunRate: 0.03 + BURN_IN_DEFAULT_TOLERANCE / 2,
      degradedRunRate: 0.05,
    });

    const a = evaluateBurnIn({ snapshots: [baseline, after], releaseAt: RELEASE_AT });

    expect(a.verdict).toBe('clean');
    expect(a.passesClosureCheck4).toBe(true);
  });

  it('picks the NEAREST pre-release snapshot as the baseline, not the oldest', () => {
    const old = snap('2026-07-10', { failedRunRate: 0.9 });
    const nearest = snap('2026-07-19', { failedRunRate: 0.02 });
    const after = snap('2026-07-21', { failedRunRate: 0.5 });

    const a = evaluateBurnIn({
      snapshots: [old, nearest, after],
      releaseAt: RELEASE_AT,
    });

    expect(a.baseline?.date).toBe('2026-07-19');
    // Against the nearest baseline this is a regression; against the stale one
    // it would have looked like an improvement.
    expect(a.verdict).toBe('regressed');
    expect(a.passesClosureCheck4).toBe(false);
  });

  it('uses the LATEST post-release snapshot when several exist', () => {
    const baseline = snap('2026-07-19', { failedRunRate: 0.02 });
    const a = evaluateBurnIn({
      snapshots: [
        baseline,
        snap('2026-07-21', { failedRunRate: 0.02 }),
        snap('2026-07-23', { failedRunRate: 0.02 }),
      ],
      releaseAt: RELEASE_AT,
    });

    expect(a.postRelease?.date).toBe('2026-07-23');
    expect(a.verdict).toBe('clean');
  });

  // The release-day window straddles releaseAt (00:00 → 23:59 around a 12:00
  // release), so it holds both pre- and post-release traffic. Counting it as
  // post-release evidence lets pre-release traffic dilute or inflate the rates
  // and produce a false clean or a false regression.
  it('refuses a straddling release-day window as post-release evidence', () => {
    const a = evaluateBurnIn({
      snapshots: [snap('2026-07-19'), snap('2026-07-20')],
      releaseAt: RELEASE_AT,
    });

    expect(a.baseline?.date).toBe('2026-07-19');
    expect(a.postRelease).toBeNull();
    expect(a.verdict).toBe('insufficient_data');
    expect(a.passesClosureCheck4).toBe(false);
  });

  it('refuses a straddling window as the baseline either', () => {
    // Only the release-day row exists before the first clean post-release day.
    const a = evaluateBurnIn({
      snapshots: [snap('2026-07-20'), snap('2026-07-21')],
      releaseAt: RELEASE_AT,
    });

    expect(a.baseline).toBeNull();
    expect(a.verdict).toBe('insufficient_data');
    expect(a.passesClosureCheck4).toBe(false);
  });

  it('accepts the first window that opens after the release', () => {
    const a = evaluateBurnIn({
      snapshots: [snap('2026-07-19'), snap('2026-07-20'), snap('2026-07-21')],
      releaseAt: RELEASE_AT,
    });

    expect(a.baseline?.date).toBe('2026-07-19');
    expect(a.postRelease?.date).toBe('2026-07-21');
    expect(a.verdict).toBe('clean');
    expect(a.passesClosureCheck4).toBe(true);
  });

  it('reports the window boundaries it selected, so the choice is auditable', () => {
    const a = evaluateBurnIn({
      snapshots: [snap('2026-07-19'), snap('2026-07-21')],
      releaseAt: RELEASE_AT,
    });

    expect(new Date(a.baseline!.windowEnd).getTime()).toBeLessThanOrEqual(RELEASE_AT.getTime());
    expect(new Date(a.postRelease!.windowStart).getTime()).toBeGreaterThanOrEqual(
      RELEASE_AT.getTime(),
    );
  });

  it('is order-independent (input need not be sorted)', () => {
    const unsorted = [
      snap('2026-07-21', { failedRunRate: 0.02 }),
      snap('2026-07-10', { failedRunRate: 0.9 }),
      snap('2026-07-19', { failedRunRate: 0.03 }),
    ];

    const a = evaluateBurnIn({ snapshots: unsorted, releaseAt: RELEASE_AT });

    expect(a.baseline?.date).toBe('2026-07-19');
    expect(a.postRelease?.date).toBe('2026-07-21');
    expect(a.verdict).toBe('clean');
  });
});

describe('evaluateBurnIn — invariants (AC5: no weakening of fail-closed)', () => {
  it('passesClosureCheck4 is true if and only if the verdict is clean', () => {
    const cases: BurnInAssessment[] = [
      evaluateBurnIn({ snapshots: [], releaseAt: RELEASE_AT }),
      evaluateBurnIn({ snapshots: [snap('2026-07-19')], releaseAt: RELEASE_AT }),
      evaluateBurnIn({ snapshots: [snap('2026-07-21')], releaseAt: RELEASE_AT }),
      evaluateBurnIn({
        snapshots: [snap('2026-07-19', { failedRunRate: 0 }), snap('2026-07-21', { failedRunRate: 1 })],
        releaseAt: RELEASE_AT,
      }),
      evaluateBurnIn({
        snapshots: [snap('2026-07-19'), snap('2026-07-21')],
        releaseAt: RELEASE_AT,
      }),
    ];

    for (const a of cases) {
      expect(a.passesClosureCheck4).toBe(a.verdict === 'clean');
    }
  });

  it('always reports a non-empty reason, whatever the verdict', () => {
    const a = evaluateBurnIn({ snapshots: [], releaseAt: RELEASE_AT });
    const b = evaluateBurnIn({
      snapshots: [snap('2026-07-19'), snap('2026-07-21')],
      releaseAt: RELEASE_AT,
    });

    expect(a.reason.length).toBeGreaterThan(0);
    expect(b.reason.length).toBeGreaterThan(0);
  });

  it('an invalid releaseAt fails closed instead of throwing', () => {
    const a = evaluateBurnIn({
      snapshots: [snap('2026-07-19'), snap('2026-07-21')],
      releaseAt: new Date('not-a-date'),
    });

    expect(a.verdict).toBe('insufficient_data');
    expect(a.passesClosureCheck4).toBe(false);
    expect(a.reason).toMatch(/release/i);
  });

  it('only considers snapshots from the requested window label', () => {
    const weekly = snap('2026-07-21', { windowLabel: '7d' });
    const a = evaluateBurnIn({
      snapshots: [snap('2026-07-19'), weekly],
      releaseAt: RELEASE_AT,
      windowLabel: '24h',
    });

    // The only post-release row is a 7d row, so for the 24h line there is none.
    expect(a.verdict).toBe('insufficient_data');
    expect(a.passesClosureCheck4).toBe(false);
  });
});
