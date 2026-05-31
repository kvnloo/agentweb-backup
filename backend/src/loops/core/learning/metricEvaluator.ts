/**
 * metricEvaluator — computes a loop's north-star target metric over a time
 * window, straight from the sensor.
 *
 * Loop-agnostic by construction: everything it needs is described on the
 * manifest's `targetMetric` (a numerator event, a denominator event, a window).
 * The same function computes `eval_to_signup_rate` (signed_up / form_submitted)
 * for the ai-eval loop, `onboarding_completion_rate` for the onboarding loop,
 * or any future loop's ratio — no per-loop code.
 *
 * This is the measurement primitive layer 5 was missing: you cannot tell
 * whether a shipped fix helped without being able to compute the metric
 * before vs after the ship.
 */

import type { EventSource, TimeWindow } from '../types';

/** The subset of `LoopManifest.targetMetric` this evaluator needs. */
export interface TargetMetricSpec {
  name: string;
  numeratorEvent: string;
  denominatorEvent: string;
  windowDays: number;
}

export interface MetricResult {
  /** numerator / denominator, or null when there is no denominator (no signal). */
  ratio: number | null;
  numerator: number;
  denominator: number;
}

/**
 * Count numerator + denominator events of the target metric within `window`
 * and return the ratio. A null ratio means "no denominator events in the
 * window" — i.e. there is no signal to interpret, not a zero rate.
 */
export async function computeTargetMetric(
  sensor: EventSource,
  metric: TargetMetricSpec,
  window: TimeWindow,
): Promise<MetricResult> {
  const events = await sensor.fetchEvents(window, {
    eventTypes: [metric.numeratorEvent, metric.denominatorEvent],
  });

  let numerator = 0;
  let denominator = 0;
  for (const e of events) {
    if (e.eventType === metric.numeratorEvent) numerator++;
    if (e.eventType === metric.denominatorEvent) denominator++;
  }

  return {
    ratio: denominator > 0 ? numerator / denominator : null,
    numerator,
    denominator,
  };
}
