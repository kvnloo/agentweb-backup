/**
 * Burn-in evaluation for closure-gate check 4 (ENG-746).
 *
 * The closure gate says a change may be closed only when "its burn-in window is
 * clean (`failedRunRate` / `degradedRunRate` no worse than the pre-release
 * snapshot)". Until now that was prose: there was no code that turned two
 * snapshots into a verdict, so every caller had to eyeball
 * `GET /api/admin/loops/reliability-trend` and decide for itself. An empty
 * response — which is what production returned, because the snapshot cron had
 * never run — was indistinguishable from a clean one.
 *
 * This module is the missing computation, and its single most important
 * property is:
 *
 *     passesClosureCheck4 === (verdict === 'clean')
 *
 * There is no other way to obtain a pass. Absence of data, a missing baseline,
 * a missing post-release reading, a window with too few runs, and an
 * unparseable release timestamp all resolve to `insufficient_data`, which fails
 * closed to Harsha. This is deliberate: the failure class that produced
 * ENG-734, ENG-743, ENG-754 and ENG-777 is a control reporting a value it
 * cannot substantiate, and the cheapest way to reproduce it here would be to
 * let "no data" fall through to a boolean that happens to be true.
 *
 * The sharpest trap is specific to this data. `computeReliabilitySnapshot`
 * guards its zero denominators by emitting `0` — so a window in which NOTHING
 * RAN reports `failedRunRate: 0, degradedRunRate: 0`, a perfect score, strictly
 * better than any real baseline. A naive comparison would read a dead window as
 * the best possible result. `minRunCount` exists to reject exactly that, on
 * both sides of the comparison.
 *
 * Pure: no IO, deterministic, unit-testable with plain snapshot arrays.
 */

import type { ReliabilitySnapshot } from './agentReliabilitySnapshot';

/**
 * Three explicit outcomes. There is no boolean-only form of this result, and no
 * fourth "unknown" that a caller could coerce.
 */
export type BurnInVerdict = 'clean' | 'regressed' | 'insufficient_data';

/**
 * Minimum verdicts a window needs before its rates count as evidence. A rate
 * derived from one or two runs is noise, and a rate derived from zero runs is
 * the false-green trap described above.
 */
export const BURN_IN_DEFAULT_MIN_RUN_COUNT = 5;

/**
 * Absolute slack (in rate points, so 0.02 = 2 percentage points) allowed before
 * an increase counts as a regression.
 *
 * Why not a strict `<=`: daily rates move by a point or two on ordinary
 * variance, so a zero-tolerance comparison would mark healthy days `regressed`
 * and rebuild the ENG-746 deadlock in a new shape. The tolerance only ever
 * decides `clean` vs `regressed` — it can never turn missing data into a pass,
 * because that path is gated by run counts before any comparison happens.
 */
export const BURN_IN_DEFAULT_TOLERANCE = 0.02;

/** The subset of a snapshot the verdict is actually computed from. */
export interface BurnInRates {
  date: string;
  windowLabel: string;
  windowStart: string;
  windowEnd: string;
  failedRunRate: number;
  degradedRunRate: number;
  runCount: number;
}

export interface BurnInAssessment {
  verdict: BurnInVerdict;
  /**
   * Closure-gate check 4. True if and only if `verdict === 'clean'`. Callers
   * should read THIS rather than re-deriving a pass from the rates.
   */
  passesClosureCheck4: boolean;
  /** Human-readable justification. Never empty, whatever the verdict. */
  reason: string;
  /** The pre-release snapshot used, or null when none qualified. */
  baseline: BurnInRates | null;
  /** The post-release snapshot used, or null when none qualified. */
  postRelease: BurnInRates | null;
  releaseAt: string | null;
  windowLabel: string;
  minRunCount: number;
  tolerance: number;
}

export interface EvaluateBurnInInput {
  snapshots: readonly ReliabilitySnapshot[];
  releaseAt: Date;
  /** Rolling window to evaluate. Defaults to the daily '24h' line. */
  windowLabel?: string;
  minRunCount?: number;
  tolerance?: number;
}

function toRates(s: ReliabilitySnapshot): BurnInRates {
  return {
    date: s.date,
    windowLabel: s.windowLabel,
    windowStart: s.windowStart,
    windowEnd: s.windowEnd,
    failedRunRate: s.failedRunRate,
    degradedRunRate: s.degradedRunRate,
    runCount: s.runCount,
  };
}

/** Epoch ms of a snapshot boundary, or NaN if the row is malformed. */
function boundaryMs(iso: string | undefined): number {
  if (typeof iso !== 'string') return NaN;
  return new Date(iso).getTime();
}

function fmtPct(rate: number): string {
  return `${(rate * 100).toFixed(2)}%`;
}

/** Build a failing assessment. Every early exit funnels through here so no path
 * can accidentally return a pass. */
function insufficient(
  reason: string,
  ctx: {
    releaseAt: string | null;
    windowLabel: string;
    minRunCount: number;
    tolerance: number;
    baseline?: BurnInRates | null;
    postRelease?: BurnInRates | null;
  },
): BurnInAssessment {
  return {
    verdict: 'insufficient_data',
    passesClosureCheck4: false,
    reason,
    baseline: ctx.baseline ?? null,
    postRelease: ctx.postRelease ?? null,
    releaseAt: ctx.releaseAt,
    windowLabel: ctx.windowLabel,
    minRunCount: ctx.minRunCount,
    tolerance: ctx.tolerance,
  };
}

/**
 * Decide whether a release's burn-in window is clean, regressed, or simply not
 * evidenced yet.
 *
 * Both sides are chosen by the snapshot's real window boundaries, never by its
 * date label. The baseline is the LATEST snapshot whose window CLOSED at or
 * before `releaseAt`; the post-release reading is the LATEST snapshot whose
 * window OPENED at or after it. A window straddling the release contains both
 * pre- and post-release traffic and is used as neither side.
 *
 * Using the nearest pre-release window (rather than the oldest available) keeps
 * the comparison against how the system actually behaved just before shipping.
 */
export function evaluateBurnIn(input: EvaluateBurnInInput): BurnInAssessment {
  const windowLabel = input.windowLabel ?? '24h';
  const minRunCount = input.minRunCount ?? BURN_IN_DEFAULT_MIN_RUN_COUNT;
  const tolerance = input.tolerance ?? BURN_IN_DEFAULT_TOLERANCE;

  const releaseMs = input.releaseAt?.getTime?.();
  if (releaseMs == null || !Number.isFinite(releaseMs)) {
    return insufficient(
      'Cannot evaluate burn-in: the release timestamp is missing or unparseable, so there is no point to compare against.',
      { releaseAt: null, windowLabel, minRunCount, tolerance },
    );
  }
  const releaseAtIso = input.releaseAt.toISOString();
  const ctx = { releaseAt: releaseAtIso, windowLabel, minRunCount, tolerance };

  const relevant = input.snapshots
    .filter((s) => s.windowLabel === windowLabel)
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date));

  if (relevant.length === 0) {
    return insufficient(
      `Cannot evaluate burn-in: no snapshot exists for the '${windowLabel}' window. ` +
        'This is missing evidence, not a clean run — the reliability snapshot may not be reaching the store.',
      ctx,
    );
  }

  // Select on the snapshot's ACTUAL window, not its date label. A snapshot
  // dated the release day spans hours either side of the release, so treating
  // the whole row as post-release lets pre-release traffic dilute or inflate
  // the measured rates — a false clean or a false regression. A window is
  // usable as evidence only when it lies wholly on one side of the release;
  // anything straddling it is contaminated and is used as neither. The cost is
  // that check 4 needs one full window after the release, which is what
  // "burned in" is supposed to mean.
  const priorAll = relevant.filter((s) => {
    const end = boundaryMs(s.windowEnd);
    return Number.isFinite(end) && end <= releaseMs;
  });
  const afterAll = relevant.filter((s) => {
    const start = boundaryMs(s.windowStart);
    return Number.isFinite(start) && start >= releaseMs;
  });

  // Baseline: nearest qualifying day before the release.
  const baselineSnap = [...priorAll].reverse().find((s) => s.runCount >= minRunCount);
  if (!baselineSnap) {
    const nearest = priorAll.length > 0 ? toRates(priorAll[priorAll.length - 1]) : null;
    return insufficient(
      priorAll.length === 0
        ? `Cannot evaluate burn-in: no pre-release baseline window closes at or before ${releaseAtIso}, ` +
            'so "no worse than the pre-release snapshot" has nothing uncontaminated to compare against.'
        : `Cannot evaluate burn-in: every pre-release snapshot window closing before ${releaseAtIso} recorded ` +
            `fewer than ${minRunCount} runs, so its rates are not evidence of anything.`,
      { ...ctx, baseline: nearest },
    );
  }

  // Post-release: latest qualifying day on or after the release.
  const latestAfter = afterAll.length > 0 ? toRates(afterAll[afterAll.length - 1]) : null;
  if (afterAll.length === 0) {
    return insufficient(
      `Cannot evaluate burn-in: no snapshot window begins at or after the release (${releaseAtIso}). ` +
        'A window straddling the release mixes pre- and post-release traffic, so it is not burn-in ' +
        'evidence; the first clean post-release window has not closed yet.',
      { ...ctx, baseline: toRates(baselineSnap) },
    );
  }

  const postSnap = [...afterAll].reverse().find((s) => s.runCount >= minRunCount);
  if (!postSnap) {
    return insufficient(
      `Cannot evaluate burn-in: the post-release window recorded ` +
        `${latestAfter?.runCount ?? 0} runs, below the ${minRunCount} required for the rates to mean anything. ` +
        'A window with no runs reports a 0% failure rate, which is absence of data — not a clean burn-in.',
      { ...ctx, baseline: toRates(baselineSnap), postRelease: latestAfter },
    );
  }

  const baseline = toRates(baselineSnap);
  const postRelease = toRates(postSnap);

  const failedDelta = postRelease.failedRunRate - baseline.failedRunRate;
  const degradedDelta = postRelease.degradedRunRate - baseline.degradedRunRate;

  const regressions: string[] = [];
  if (failedDelta > tolerance) {
    regressions.push(
      `failedRunRate rose ${fmtPct(baseline.failedRunRate)} → ${fmtPct(postRelease.failedRunRate)} ` +
        `(+${fmtPct(failedDelta)}, tolerance ${fmtPct(tolerance)})`,
    );
  }
  if (degradedDelta > tolerance) {
    regressions.push(
      `degradedRunRate rose ${fmtPct(baseline.degradedRunRate)} → ${fmtPct(postRelease.degradedRunRate)} ` +
        `(+${fmtPct(degradedDelta)}, tolerance ${fmtPct(tolerance)})`,
    );
  }

  if (regressions.length > 0) {
    return {
      verdict: 'regressed',
      passesClosureCheck4: false,
      reason:
        `Burn-in regressed against the ${baseline.date} baseline: ${regressions.join('; ')}.`,
      baseline,
      postRelease,
      releaseAt: releaseAtIso,
      windowLabel,
      minRunCount,
      tolerance,
    };
  }

  return {
    verdict: 'clean',
    passesClosureCheck4: true,
    reason:
      `Burn-in clean: over ${postRelease.runCount} runs on ${postRelease.date}, ` +
      `failedRunRate ${fmtPct(postRelease.failedRunRate)} and degradedRunRate ` +
      `${fmtPct(postRelease.degradedRunRate)} are no worse than the ${baseline.date} ` +
      `pre-release baseline (${fmtPct(baseline.failedRunRate)} / ` +
      `${fmtPct(baseline.degradedRunRate)}) within a ${fmtPct(tolerance)} tolerance.`,
    baseline,
    postRelease,
    releaseAt: releaseAtIso,
    windowLabel,
    minRunCount,
    tolerance,
  };
}
