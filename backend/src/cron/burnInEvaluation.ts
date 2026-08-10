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

/** Closure check 4 has one authoritative line; callers cannot choose it. */
export const BURN_IN_AUTHORITATIVE_WINDOW_LABEL = '24h' as const;

/**
 * How many qualifying post-release 24h windows the attributed replay inspects.
 *
 * The burn-in period has to be a fixed, named length, because the scan decides
 * how long a release can be failed by a later day. Bounding it by the caller's
 * history horizon instead (`?days=30`) means a regression three weeks after the
 * release still fails that release — a 30-day freeze, which is a worse version
 * of the exact 7-day freeze ENG-938 was filed about. Seven windows matches the
 * burn-in period named in the issue and is independent of how much trend
 * history is read.
 */
export const BURN_IN_POST_RELEASE_WINDOW_LIMIT = 7;

/**
 * Length of one authoritative burn-in window, in ms. The authoritative label is
 * `24h`, so the period bound below is arithmetic on real time rather than a
 * count of however many rows the store happens to hold.
 */
const BURN_IN_WINDOW_MS = 24 * 60 * 60 * 1000;

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
  /** Explicitly attributed, unrelated incident windows omitted from the verdict. */
  excludedIncidents?: readonly BurnInIncidentAttribution[];
}

export interface BurnInIncidentAttribution {
  date: string;
  issueId: string;
  reason?: string;
}

export interface EvaluateBurnInInput {
  snapshots: readonly ReliabilitySnapshot[];
  releaseAt: Date;
  /** Rolling window to evaluate. Defaults to the daily '24h' line. */
  windowLabel?: string;
  minRunCount?: number;
  tolerance?: number;
  /** Release whose burn-in is being evaluated (enables attributed replay policy). */
  releaseIssueId?: string;
  /** Explicit incident ownership by snapshot date. */
  incidentAttributions?: readonly BurnInIncidentAttribution[];
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

/**
 * Canonical form of an ENG issue id for comparison.
 *
 * Incident exclusion turns on `incident.issueId !== releaseIssueId`, so a bare
 * string comparison makes `eng-836` and `ENG-836` two different issues: a
 * release could exclude its OWN incident window purely on a case mismatch, and
 * the endpoint would report `clean` for a release that regressed. That is the
 * contamination this evaluator exists to prevent, inverted.
 */
function normalizeIssueId(id: string | undefined): string {
  return typeof id === 'string' ? id.trim().toUpperCase() : '';
}

/**
 * Dates (of those the verdict actually reads) that lack either authoritative
 * window row. AC3 forbids blending the 24h and 7d lines, so a date the verdict
 * consumes must carry both.
 */
function unpairedWindowDates(
  snapshots: readonly ReliabilitySnapshot[],
  consumedDates: readonly string[],
): string[] {
  const labelsByDate = new Map<string, Set<string>>();
  for (const snapshot of snapshots) {
    if (snapshot.windowLabel !== '24h' && snapshot.windowLabel !== '7d') continue;
    const labels = labelsByDate.get(snapshot.date) ?? new Set<string>();
    labels.add(snapshot.windowLabel);
    labelsByDate.set(snapshot.date, labels);
  }
  return [...new Set(consumedDates)]
    .filter((date) => {
      const labels = labelsByDate.get(date);
      return !labels || !labels.has('24h') || !labels.has('7d');
    })
    .sort();
}

/** Epoch ms of a snapshot boundary, or NaN if the row is malformed. */
function boundaryMs(iso: string | undefined): number {
  if (typeof iso !== 'string') return NaN;
  return new Date(iso).getTime();
}

/**
 * UTC day index (days since epoch) on which a snapshot window CLOSES, or NaN if
 * the row is malformed. This is the period's unit of position: exactly one
 * authoritative window closes per day, and unlike `windowStart` it does not
 * depend on the time of day the producer happened to close the row.
 */
function closingDayIndex(snapshot: ReliabilitySnapshot): number {
  const end = boundaryMs(snapshot.windowEnd);
  return Number.isFinite(end) ? Math.floor(end / BURN_IN_WINDOW_MS) : NaN;
}

function fmtPct(rate: number): string {
  return `${(rate * 100).toFixed(2)}%`;
}

function regressionDescriptions(
  baseline: BurnInRates,
  candidate: BurnInRates,
  tolerance: number,
): string[] {
  const failedDelta = candidate.failedRunRate - baseline.failedRunRate;
  const degradedDelta = candidate.degradedRunRate - baseline.degradedRunRate;
  const regressions: string[] = [];

  if (failedDelta > tolerance) {
    regressions.push(
      `failedRunRate rose ${fmtPct(baseline.failedRunRate)} → ${fmtPct(candidate.failedRunRate)} ` +
        `(+${fmtPct(failedDelta)}, tolerance ${fmtPct(tolerance)})`,
    );
  }
  if (degradedDelta > tolerance) {
    regressions.push(
      `degradedRunRate rose ${fmtPct(baseline.degradedRunRate)} → ${fmtPct(candidate.degradedRunRate)} ` +
        `(+${fmtPct(degradedDelta)}, tolerance ${fmtPct(tolerance)})`,
    );
  }

  return regressions;
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
  const attributableReplay = Boolean(input.releaseIssueId);
  const releaseIssueKey = normalizeIssueId(input.releaseIssueId);
  const windowLabel = attributableReplay
    ? BURN_IN_AUTHORITATIVE_WINDOW_LABEL
    : input.windowLabel ?? BURN_IN_AUTHORITATIVE_WINDOW_LABEL;
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

  if (
    attributableReplay &&
    input.windowLabel !== undefined &&
    input.windowLabel !== BURN_IN_AUTHORITATIVE_WINDOW_LABEL
  ) {
    return insufficient(
      `Cannot evaluate burn-in: closure check 4 uses the fixed '${BURN_IN_AUTHORITATIVE_WINDOW_LABEL}' ` +
        `window, not requester-selected '${input.windowLabel}'.`,
      ctx,
    );
  }

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

  if (attributableReplay) {
    // The burn-in period is a fixed span of real time, NOT however much history
    // the caller happened to read and NOT a count of rows that happen to exist.
    // See BURN_IN_POST_RELEASE_WINDOW_LIMIT.
    //
    // Bound the period by the CLOCK, not by array position. Taking the first N
    // elements assumes every day inside the period produced a snapshot row; when
    // a date is missing entirely (the snapshot cron skipped a run, a day of the
    // store was never written), a row from outside the period slides into the
    // freed slot and the boundary walks forward. A regression on day 12 could
    // then block closure for a burn-in that was only ever meant to cover days
    // 1-7, and evidence from outside the period could produce a clean verdict.
    // Comparing `windowStart` against a computed end instant makes an absent day
    // simply absent — the period keeps its length either way.
    //
    // The anchor is the FIRST post-release window, not the first row that
    // happens to exist. `afterAll[0]` is only the earliest row we were handed;
    // when day 1's snapshot was never written, anchoring there starts the period
    // on day 2 and walks its end out to day 8, so an out-of-period regression
    // gets scanned. Snapshot windows are 24h wide on a daily cadence but are NOT
    // midnight-aligned (they close whenever the snapshot cron runs), so the
    // boundary cannot be computed from the release instant alone. Instead, walk
    // the earliest surviving window start back a day at a time for as long as
    // the earlier slot would still be post-release: that reconstructs the first
    // window the period should have contained, whether or not its row exists.
    // The period is indexed by the UTC DAY each window closes on, not by the
    // exact `windowStart` instant. Snapshot rows are 24h wide on a daily
    // cadence, but they are not all written on the same time-of-day grid: the
    // producer closes a completed day at `T23:59:59.999Z` and the CURRENT day
    // at `now`, so today's row starts at an arbitrary time of day. An exact
    // timestamp comparison reads that legitimate row as off-grid and reports
    // the period as missing a window — `insufficient_data` on contiguous, clean
    // evidence, blocking closure check 4 for every burn-in still in progress.
    // One window closes per UTC day either way, so the day of `windowEnd` is
    // the stable index: it survives both alignments and still makes an absent
    // day absent rather than letting a later row slide into its slot.
    let periodStartMs = boundaryMs(afterAll[0].windowStart);
    let stepsBack = 0;
    while (Number.isFinite(periodStartMs) && periodStartMs - BURN_IN_WINDOW_MS >= releaseMs) {
      periodStartMs -= BURN_IN_WINDOW_MS;
      stepsBack += 1;
    }
    const firstPeriodDay = closingDayIndex(afterAll[0]) - stepsBack;
    // Exactly one authoritative window closes per UTC day, but the store can
    // briefly hold two rows that close on the same day — the current-day row
    // written at `now` and the completed-day row that later closes the same day
    // at `T23:59:59.999Z`. Two rows sharing an index would push every later row
    // one slot forward and read as a missing window, so collapse a shared day
    // to its LAST (latest-closing, most complete) row before positioning.
    const byClosingDay = new Map<number, ReliabilitySnapshot>();
    for (const snapshot of afterAll) {
      const day = closingDayIndex(snapshot);
      if (!Number.isFinite(day)) continue;
      if (day < firstPeriodDay || day >= firstPeriodDay + BURN_IN_POST_RELEASE_WINDOW_LIMIT) continue;
      const existing = byClosingDay.get(day);
      if (!existing || boundaryMs(snapshot.windowEnd) >= boundaryMs(existing.windowEnd)) {
        byClosingDay.set(day, snapshot);
      }
    }
    const inPeriod = [...byClosingDay.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, snapshot]) => snapshot);

    // Evidence must be CONTIGUOUS from the start of the period AND unbroken up
    // to the last window read. Two weaker rules were tried and both produce a
    // false green:
    //
    //   - dropping thin rows and crediting whatever clean row survives lets a
    //     later clean day paper over an earlier unreadable one;
    //   - truncating at the first thin day and crediting the clean prefix still
    //     returns `clean` for a period that contains a day nobody could read.
    //     "Days 1-2 were fine, day 3 was unreadable" is not evidence that the
    //     release burned in — it is missing evidence, and closure check 4 must
    //     fail closed on it.
    //
    // So an unreadable window inside the period — too few runs, or a row that
    // was never written between two rows that were — makes the whole period
    // unevaluable. Windows at the END of the period that have not happened yet
    // are simply absent, not a gap: the period is still running, and the
    // elapsed part of it remains fully readable.
    const firstThin = inPeriod.findIndex((snapshot) => snapshot.runCount < minRunCount);
    if (firstThin !== -1) {
      return insufficient(
        `Cannot evaluate burn-in for ${input.releaseIssueId}: ${inPeriod[firstThin].date} lies inside the ` +
          `burn-in period but recorded ${inPeriod[firstThin].runCount} runs, below the ${minRunCount} ` +
          'required for its rates to mean anything. A period containing a day nobody can read is missing ' +
          'evidence, not a clean burn-in — earlier clean days do not cover for it.',
        { ...ctx, baseline },
      );
    }

    const gapIndex = inPeriod.findIndex(
      (snapshot, i) => closingDayIndex(snapshot) !== firstPeriodDay + i,
    );
    if (gapIndex !== -1) {
      return insufficient(
        `Cannot evaluate burn-in for ${input.releaseIssueId}: the burn-in period is missing the snapshot ` +
          `window that should precede ${inPeriod[gapIndex].date}. A day of the period with no row at all is ` +
          'unread, so the windows after it cannot stand in for it.',
        { ...ctx, baseline },
      );
    }

    const scanned = inPeriod;

    // AC3's no-blending rule applies to the rows this verdict READS: the
    // baseline and the scanned burn-in windows. Demanding a 24h/7d pair across
    // the whole horizon instead bricks the gate on a single missing 7d row for
    // a pre-release date the verdict never looks at — and it cannot self-heal,
    // because the snapshot catch-up horizon (14 days) is shorter than the read
    // horizon the endpoint asks for (30).
    const unpairedDates = unpairedWindowDates(input.snapshots, [
      baseline.date,
      ...scanned.map((snapshot) => snapshot.date),
    ]);
    if (unpairedDates.length > 0) {
      return insufficient(
        `Cannot evaluate burn-in: every date this verdict reads must contain separate 24h and 7d ` +
          `rows; missing a pair for ${unpairedDates.join(', ')}. The evaluator never blends window lines.`,
        { ...ctx, baseline },
      );
    }

    const excludedIncidents: BurnInIncidentAttribution[] = [];
    let latestClean: BurnInRates | null = null;

    for (const candidateSnap of scanned) {
      const candidate = toRates(candidateSnap);
      const regressions = regressionDescriptions(baseline, candidate, tolerance);
      if (regressions.length === 0) {
        latestClean = candidate;
        continue;
      }

      const unrelatedIncident = input.incidentAttributions?.find(
        (incident) =>
          incident.date === candidate.date &&
          normalizeIssueId(incident.issueId) !== releaseIssueKey,
      );
      if (unrelatedIncident) {
        excludedIncidents.push(unrelatedIncident);
        continue;
      }

      return {
        verdict: 'regressed',
        passesClosureCheck4: false,
        reason:
          `Burn-in for ${input.releaseIssueId} regressed on ${candidate.date} against the ` +
          `${baseline.date} baseline: ${regressions.join('; ')}.`,
        baseline,
        postRelease: candidate,
        releaseAt: releaseAtIso,
        windowLabel,
        minRunCount,
        tolerance,
        excludedIncidents,
      };
    }

    if (!latestClean) {
      return {
        ...insufficient(
          `Cannot evaluate burn-in for ${input.releaseIssueId}: every qualifying post-release ` +
            'regression belongs to an explicitly unrelated incident, leaving no clean release window.',
          { ...ctx, baseline },
        ),
        excludedIncidents,
      };
    }

    return {
      verdict: 'clean',
      passesClosureCheck4: true,
      reason:
        `Burn-in clean for ${input.releaseIssueId}: ${latestClean.date} is no worse than the ` +
        `${baseline.date} baseline within a ${fmtPct(tolerance)} tolerance` +
        (excludedIncidents.length > 0
          ? `; excluded ${excludedIncidents.length} explicitly attributed unrelated incident window(s).`
          : '.'),
      baseline,
      postRelease: latestClean,
      releaseAt: releaseAtIso,
      windowLabel,
      minRunCount,
      tolerance,
      excludedIncidents,
    };
  }

  const regressions = regressionDescriptions(baseline, postRelease, tolerance);

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
