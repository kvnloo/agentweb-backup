/**
 * attribution — layer 5's "did it actually work?" engine.
 *
 * The loop ships fixes (gate → tools). On its own that is *self-proposing*, not
 * *self-improving*: nothing measures whether a shipped fix moved the metric, so
 * the loop can keep re-shipping things that don't help. This module closes that
 * gap, generically for any loop:
 *
 *   1. computeVerdict — pure: given the target metric before vs after a ship
 *      (+ the loop's thresholds), decide improved / no_change / regressed /
 *      inconclusive.
 *   2. runAttribution — for every shipped mutation whose settle window has
 *      elapsed, compute before/after via the sensor, write the outcome back to
 *      the learning store, and (optionally) DM a one-line summary.
 *
 * The recorded outcome is then read back by the policy layer
 * (`LearningStore.lastOutcomeForRule`) to apply a failure-driven cooldown —
 * don't re-propose a fix whose last shipped version regressed or did nothing.
 *
 * Everything here is driven by `manifest.targetMetric` + `manifest.thresholds`,
 * so it works unchanged for the ai-eval loop, the onboarding loop, and any
 * future loop instance.
 */

import type { ClockPort, LoggerPort, SlackPort } from '../ports';
import type {
  EventSource,
  LearningRecord,
  LearningStore,
  LoopId,
  OutcomeVerdict,
} from '../types';
import { computeTargetMetric, type MetricResult, type TargetMetricSpec } from './metricEvaluator';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface VerdictThresholds {
  /** observedLiftPct >= this → improved. */
  promoteLiftPct: number;
  /** observedLiftPct <= this (a negative number) → regressed. */
  retireLiftPct: number;
  /** Fewer than this many denominator events in the after-window → inconclusive
   * (not enough data to trust any verdict). */
  minSampleN: number;
}

export interface VerdictResult {
  verdict: OutcomeVerdict;
  observedLiftPct: number | null;
  sampleN: number;
}

/**
 * Pure verdict computation. Conservative by design — when the data can't
 * support a conclusion (too few samples, no baseline) it returns `inconclusive`
 * rather than guessing, so the loop never retires a fix on noise.
 */
export function computeVerdict(
  before: MetricResult,
  after: MetricResult,
  t: VerdictThresholds,
): VerdictResult {
  const sampleN = after.denominator;

  // Not enough post-ship data to trust any conclusion.
  if (sampleN < t.minSampleN) {
    return { verdict: 'inconclusive', observedLiftPct: null, sampleN };
  }
  // No baseline to compare against.
  if (before.ratio === null) {
    return { verdict: 'inconclusive', observedLiftPct: null, sampleN };
  }

  const afterRatio = after.ratio ?? 0;

  // From a zero baseline, percentage lift is undefined — judge by direction.
  if (before.ratio === 0) {
    return afterRatio > 0
      ? { verdict: 'improved', observedLiftPct: null, sampleN }
      : { verdict: 'no_change', observedLiftPct: 0, sampleN };
  }

  const observedLiftPct = ((afterRatio - before.ratio) / before.ratio) * 100;
  let verdict: OutcomeVerdict;
  if (observedLiftPct >= t.promoteLiftPct) verdict = 'improved';
  else if (observedLiftPct <= t.retireLiftPct) verdict = 'regressed';
  else verdict = 'no_change';

  return { verdict, observedLiftPct, sampleN };
}

export interface AttributionInput {
  manifest: {
    loopId: LoopId;
    targetMetric: TargetMetricSpec;
    thresholds: { promoteLiftPct: number; retireLiftPct: number; promoteMinNPerArm: number };
  };
  sensor: EventSource;
  learning: LearningStore;
  clock: ClockPort;
  logger?: LoggerPort;
  /** When provided, post a one-line outcome summary per attributed fix. */
  slack?: SlackPort;
  slackChannelOrUserId?: string;
}

export interface AttributionOutcome {
  ruleId: string;
  mutationId: string;
  verdict: OutcomeVerdict;
  observedLiftPct: number | null;
}

export interface AttributionSummary {
  /** Shipped records whose settle window elapsed and were evaluated this run. */
  evaluated: number;
  /** Outcomes written this run. */
  attributed: number;
  outcomes: AttributionOutcome[];
}

/** Stable identity for a shipped mutation, used to dedup attribution. */
function recordKey(r: LearningRecord): string | null {
  const m = r.mutation?.mutationId as string | undefined;
  const p = r.proposal?.proposalId as string | undefined;
  return m ?? p ?? null;
}

/**
 * For each shipped mutation whose settle window (`windowDays`) has elapsed and
 * which has not yet been attributed, compute the before/after target metric,
 * derive a verdict, and append an outcome record to the learning store.
 * Idempotent — a mutation that already has a verdict is skipped, so this is safe
 * to run on every cron tick.
 */
export async function runAttribution(input: AttributionInput): Promise<AttributionSummary> {
  const { manifest, sensor, learning, clock } = input;
  const now = clock.now();
  const windowMs = manifest.targetMetric.windowDays * DAY_MS;

  const history = await learning.queryHistory({
    loopId: manifest.loopId,
    status: ['approved', 'auto_shipped'],
  });

  // Mutations already attributed (carry a verdict) — never double-count.
  const attributed = new Set<string>();
  for (const r of history) {
    if (r.verdict != null) {
      const id = recordKey(r);
      if (id) attributed.add(id);
    }
  }

  const outcomes: AttributionOutcome[] = [];
  let evaluated = 0;

  for (const rec of history) {
    if (rec.verdict != null) continue; // already an outcome row
    if (!rec.shippedAt) continue; // not actually shipped
    const id = recordKey(rec);
    if (!id || attributed.has(id)) continue; // dedup

    const shippedAt = rec.shippedAt instanceof Date ? rec.shippedAt : new Date(rec.shippedAt);
    if (now.getTime() < shippedAt.getTime() + windowMs) continue; // settle window not elapsed

    evaluated++;
    const before = await computeTargetMetric(sensor, manifest.targetMetric, {
      start: new Date(shippedAt.getTime() - windowMs),
      end: shippedAt,
    });
    const after = await computeTargetMetric(sensor, manifest.targetMetric, {
      start: shippedAt,
      end: new Date(shippedAt.getTime() + windowMs),
    });

    const { verdict, observedLiftPct, sampleN } = computeVerdict(before, after, {
      promoteLiftPct: manifest.thresholds.promoteLiftPct,
      retireLiftPct: manifest.thresholds.retireLiftPct,
      minSampleN: manifest.thresholds.promoteMinNPerArm,
    });

    await learning.record({
      loopId: rec.loopId,
      runId: rec.runId,
      ts: now,
      proposal: rec.proposal,
      mutation: rec.mutation,
      decision: rec.decision,
      shippedAt,
      metricBefore: before.ratio,
      metricAfter: after.ratio,
      observedLiftPct,
      sampleN,
      verdict,
    });
    attributed.add(id);

    const ruleId = rec.proposal?.sourceRuleId ?? 'unknown';
    outcomes.push({ ruleId, mutationId: id, verdict, observedLiftPct });
    input.logger?.log('info', `[attribution] ${manifest.loopId} ${ruleId}: ${verdict}`, {
      observedLiftPct,
      sampleN,
    });
  }

  if (input.slack && input.slackChannelOrUserId && outcomes.length > 0) {
    const lines = outcomes.map((o) => {
      const pct =
        o.observedLiftPct == null
          ? 'n/a'
          : `${o.observedLiftPct >= 0 ? '+' : ''}${o.observedLiftPct.toFixed(1)}%`;
      return `• \`${o.ruleId}\` → *${o.verdict}* (${manifest.targetMetric.name} ${pct})`;
    });
    await input.slack.postMessage(
      input.slackChannelOrUserId,
      `📈 *Loop learning — ${manifest.loopId}*\nOutcome of shipped fixes (settle window elapsed):\n${lines.join('\n')}`,
    );
  }

  return { evaluated, attributed: outcomes.length, outcomes };
}
