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
  BURN_IN_POST_RELEASE_WINDOW_LIMIT,
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

function pairedSnap(
  date: string,
  over24h: Partial<ReliabilitySnapshot> = {},
): ReliabilitySnapshot[] {
  return [
    snap(date, over24h),
    snap(date, {
      ...over24h,
      windowLabel: '7d',
      windowStart: `${date}T00:00:00.000Z`,
      windowEnd: `${date}T23:59:59.999Z`,
    }),
  ];
}

const REPLAY_RELEASE_AT = new Date('2026-07-30T12:00:00.000Z');
const REPLAY_DATES = [
  '2026-07-28',
  '2026-07-29',
  '2026-07-30',
  '2026-07-31',
  '2026-08-01',
  '2026-08-02',
  '2026-08-03',
  '2026-08-04',
  '2026-08-05',
  '2026-08-06',
];

function replaySnapshots(
  overrides: Record<string, Partial<ReliabilitySnapshot>> = {},
): ReliabilitySnapshot[] {
  return REPLAY_DATES.flatMap((date) => pairedSnap(date, overrides[date]));
}

describe('evaluateBurnIn — attributed replay policy (ENG-938)', () => {
  it('fixture guard: every replay date carries separate 24h and 7d rows', () => {
    const snapshots = replaySnapshots();

    for (const date of REPLAY_DATES) {
      expect(
        snapshots.filter((snapshot) => snapshot.date === date).map((snapshot) => snapshot.windowLabel),
      ).toEqual(['24h', '7d']);
    }
  });

  it('replays ENG-759 clean when the latest spike belongs to unrelated ENG-836', () => {
    const snapshots = replaySnapshots({
      '2026-08-06': { failedRunRate: 0.8 },
    });

    const assessment = evaluateBurnIn({
      snapshots,
      releaseAt: REPLAY_RELEASE_AT,
      releaseIssueId: 'ENG-759',
      incidentAttributions: [
        { date: '2026-08-06', issueId: 'ENG-836', reason: 'unrelated production incident' },
      ],
    });

    expect(assessment.verdict).toBe('clean');
    expect(assessment.passesClosureCheck4).toBe(true);
    expect(assessment.excludedIncidents).toEqual([
      { date: '2026-08-06', issueId: 'ENG-836', reason: 'unrelated production incident' },
    ]);
  });

  it('replays ENG-745 clean against the same unrelated incident', () => {
    const assessment = evaluateBurnIn({
      snapshots: replaySnapshots({
        '2026-08-06': { degradedRunRate: 0.75 },
      }),
      releaseAt: REPLAY_RELEASE_AT,
      releaseIssueId: 'ENG-745',
      incidentAttributions: [{ date: '2026-08-06', issueId: 'ENG-836' }],
    });

    expect(assessment.verdict).toBe('clean');
    expect(assessment.passesClosureCheck4).toBe(true);
  });

  it('fails a genuine release regression even when a later window recovers', () => {
    const assessment = evaluateBurnIn({
      snapshots: replaySnapshots({
        '2026-08-03': { failedRunRate: 0.9 },
      }),
      releaseAt: REPLAY_RELEASE_AT,
      releaseIssueId: 'ENG-SYNTHETIC',
    });

    expect(assessment.verdict).toBe('regressed');
    expect(assessment.passesClosureCheck4).toBe(false);
    expect(assessment.postRelease?.date).toBe('2026-08-03');
  });

  it('fails closed when a replay date lacks either authoritative window row', () => {
    const snapshots = replaySnapshots().filter(
      (snapshot) => !(snapshot.date === '2026-08-02' && snapshot.windowLabel === '7d'),
    );

    const assessment = evaluateBurnIn({
      snapshots,
      releaseAt: REPLAY_RELEASE_AT,
      releaseIssueId: 'ENG-759',
    });

    expect(assessment.verdict).toBe('insufficient_data');
    expect(assessment.passesClosureCheck4).toBe(false);
    expect(assessment.reason).toMatch(/24h.*7d|7d.*24h/i);
  });

  // The pairing rule protects the verdict from blended window lines. Applied to
  // the whole horizon it instead bricks the gate on a row the verdict never
  // reads — and it cannot self-heal, because snapshot catch-up runs 14 days
  // back while the endpoint reads 30.
  it('still evaluates when a pre-release date the verdict never reads lacks its 7d row', () => {
    const snapshots = replaySnapshots().filter(
      (snapshot) => !(snapshot.date === '2026-07-28' && snapshot.windowLabel === '7d'),
    );

    const assessment = evaluateBurnIn({
      snapshots,
      releaseAt: REPLAY_RELEASE_AT,
      releaseIssueId: 'ENG-759',
    });

    // 2026-07-29 is the baseline; 2026-07-28 is behind it and unread.
    expect(assessment.baseline?.date).toBe('2026-07-29');
    expect(assessment.verdict).toBe('clean');
    expect(assessment.passesClosureCheck4).toBe(true);
  });

  it('fails closed when the BASELINE date lacks its 7d row', () => {
    const snapshots = replaySnapshots().filter(
      (snapshot) => !(snapshot.date === '2026-07-29' && snapshot.windowLabel === '7d'),
    );

    const assessment = evaluateBurnIn({
      snapshots,
      releaseAt: REPLAY_RELEASE_AT,
      releaseIssueId: 'ENG-759',
    });

    expect(assessment.verdict).toBe('insufficient_data');
    expect(assessment.passesClosureCheck4).toBe(false);
    expect(assessment.reason).toMatch(/24h.*7d|7d.*24h/i);
  });

  it('excludes an unrelated incident whatever the case of the attributed issue id', () => {
    const assessment = evaluateBurnIn({
      snapshots: replaySnapshots({ '2026-08-06': { failedRunRate: 0.8 } }),
      releaseAt: REPLAY_RELEASE_AT,
      releaseIssueId: 'eng-759',
      incidentAttributions: [{ date: '2026-08-06', issueId: 'eng-836' }],
    });

    expect(assessment.verdict).toBe('clean');
    expect(assessment.passesClosureCheck4).toBe(true);
  });

  // The inverse, and the dangerous one: a release must never exclude its OWN
  // incident window because the two ids differ only in case.
  it('does NOT let a release exclude its own incident on a case mismatch', () => {
    const assessment = evaluateBurnIn({
      snapshots: replaySnapshots({ '2026-08-06': { failedRunRate: 0.8 } }),
      releaseAt: REPLAY_RELEASE_AT,
      releaseIssueId: 'eng-836',
      incidentAttributions: [{ date: '2026-08-06', issueId: 'ENG-836' }],
    });

    expect(assessment.verdict).toBe('regressed');
    expect(assessment.passesClosureCheck4).toBe(false);
    expect(assessment.excludedIncidents).toEqual([]);
  });
});

describe('evaluateBurnIn — the burn-in period is a fixed window count (ENG-938)', () => {
  const EXTENDED_REPLAY_DATES = [...REPLAY_DATES, '2026-08-07', '2026-08-08', '2026-08-09'];

  function extendedSnapshots(
    overrides: Record<string, Partial<ReliabilitySnapshot>> = {},
  ): ReliabilitySnapshot[] {
    return EXTENDED_REPLAY_DATES.flatMap((date) => pairedSnap(date, overrides[date]));
  }

  it('exposes the limit as a named constant rather than the caller history horizon', () => {
    expect(BURN_IN_POST_RELEASE_WINDOW_LIMIT).toBe(7);
  });

  it('fails a regression inside the fixed burn-in window count', () => {
    // 2026-08-06 is the 7th qualifying post-release window (07-31 … 08-06).
    const assessment = evaluateBurnIn({
      snapshots: extendedSnapshots({ '2026-08-06': { failedRunRate: 0.9 } }),
      releaseAt: REPLAY_RELEASE_AT,
      releaseIssueId: 'ENG-SYNTHETIC',
    });

    expect(assessment.verdict).toBe('regressed');
    expect(assessment.postRelease?.date).toBe('2026-08-06');
  });

  it('does not fail a release on a regression past the burn-in period', () => {
    // 2026-08-08 is the 9th post-release window — ten days after the release,
    // and no longer this release's burn-in evidence.
    const assessment = evaluateBurnIn({
      snapshots: extendedSnapshots({ '2026-08-08': { failedRunRate: 0.9 } }),
      releaseAt: REPLAY_RELEASE_AT,
      releaseIssueId: 'ENG-SYNTHETIC',
    });

    expect(assessment.verdict).toBe('clean');
    expect(assessment.passesClosureCheck4).toBe(true);
    expect(assessment.postRelease?.date).toBe('2026-08-06');
  });
});

/**
 * The ENG-938 incident days pass on TOLERANCE, not on attribution: 08-01's real
 * 24h failedRunRate of 0.02062 against the 0.00107 baseline is a delta of
 * 0.01955 — 0.00045 under the 0.02 tolerance, which at ~175 runs/day is less
 * than ONE additional failed run (0.00571 per run). So the exclusion branch is
 * never even reached on the real series, and a slightly worse incident day
 * would fail these releases unless the incident is attributed. These tests pin
 * both halves so the margin is visible rather than lucky.
 */
describe('evaluateBurnIn — ENG-938 incident-day margin is thin', () => {
  const INCIDENT_RELEASE_AT = new Date('2026-07-31T00:00:00.000Z');
  const BASELINE_RATE = 0.00107;

  function incidentSeries(incidentRate: number): ReliabilitySnapshot[] {
    return ['2026-07-30', '2026-07-31', '2026-08-01', '2026-08-02'].flatMap((date) =>
      pairedSnap(date, {
        runCount: 175,
        degradedRunRate: 0,
        failedRunRate: date === '2026-08-01' ? incidentRate : BASELINE_RATE,
      }),
    );
  }

  it('passes on tolerance alone at the real 08-01 rate — nothing is excluded', () => {
    const a = evaluateBurnIn({
      snapshots: incidentSeries(0.02062),
      releaseAt: INCIDENT_RELEASE_AT,
      releaseIssueId: 'ENG-759',
      incidentAttributions: [{ date: '2026-08-01', issueId: 'ENG-836' }],
    });

    expect(a.verdict).toBe('clean');
    expect(a.passesClosureCheck4).toBe(true);
    // The incident day never tripped the tolerance, so exclusion never fired.
    expect(a.excludedIncidents).toEqual([]);
    expect(0.02062 - BASELINE_RATE).toBeLessThan(BURN_IN_DEFAULT_TOLERANCE);
  });

  it('one more failed run on that day regresses it without attribution…', () => {
    const a = evaluateBurnIn({
      snapshots: incidentSeries(0.02062 + 1 / 175),
      releaseAt: INCIDENT_RELEASE_AT,
      releaseIssueId: 'ENG-759',
    });

    expect(a.verdict).toBe('regressed');
    expect(a.passesClosureCheck4).toBe(false);
  });

  it('…and the incident attribution is what rescues it', () => {
    const a = evaluateBurnIn({
      snapshots: incidentSeries(0.02062 + 1 / 175),
      releaseAt: INCIDENT_RELEASE_AT,
      releaseIssueId: 'ENG-759',
      incidentAttributions: [{ date: '2026-08-01', issueId: 'ENG-836' }],
    });

    expect(a.verdict).toBe('clean');
    expect(a.passesClosureCheck4).toBe(true);
    expect(a.excludedIncidents).toEqual([{ date: '2026-08-01', issueId: 'ENG-836' }]);
  });
});

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
