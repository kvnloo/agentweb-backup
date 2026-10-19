/**
 * ENG-2540 (ENG-2167 slice): pure per-step drip-sequence performance aggregator.
 *
 * Turns a sequence definition plus raw engagement events into per-step and
 * whole-sequence counts and rates. Pure: no persistence, API, or Resend calls.
 */

import type { ClassifyResult } from './dripEngagementClassifier';
import type { SequenceDefinition } from './dripSequenceEvaluator';

export const SEQUENCE_EVENT_TYPES = [
  'sent',
  'delivered',
  'opened',
  'clicked',
  'replied',
  'unsubscribed',
  'bounced',
  'complained',
] as const;

export type SequenceStatsEventType = (typeof SEQUENCE_EVENT_TYPES)[number];

export interface SequenceStatsEvent {
  enrollmentId: string;
  stepIndex: number;
  type: SequenceStatsEventType;
  at: string | number | Date;
  /** `ClassifyResult.human` from dripEngagementClassifier; only `false` excludes an open/click. */
  isHuman?: ClassifyResult['human'];
}

export type StepCounts = Record<SequenceStatsEventType, number>;

export interface StepRates {
  deliveryRate: number | null;
  openRate: number | null;
  clickRate: number | null;
  replyRate: number | null;
  unsubscribeRate: number | null;
  bounceRate: number | null;
  complaintRate: number | null;
}

export interface StepStats {
  stepIndex: number;
  counts: StepCounts;
  rates: StepRates;
}

export interface SequenceStats {
  steps: StepStats[];
  total: { counts: StepCounts; rates: StepRates };
  /** Events whose stepIndex is not a step in the definition (never dropped silently). */
  orphanEvents: number;
}

/** Engagement types deduplicated per (enrollmentId, stepIndex) and filtered for bots. */
const DEDUPED_HUMAN_TYPES: ReadonlySet<SequenceStatsEventType> = new Set(['opened', 'clicked']);

function zeroCounts(): StepCounts {
  return {
    sent: 0,
    delivered: 0,
    opened: 0,
    clicked: 0,
    replied: 0,
    unsubscribed: 0,
    bounced: 0,
    complained: 0,
  };
}

function ratio(n: number, d: number): number | null {
  return d > 0 ? n / d : null;
}

export function computeRates(counts: StepCounts): StepRates {
  const denom = counts.delivered > 0 ? counts.delivered : counts.sent;
  return {
    deliveryRate: ratio(counts.delivered, counts.sent),
    openRate: ratio(counts.opened, denom),
    clickRate: ratio(counts.clicked, denom),
    replyRate: ratio(counts.replied, denom),
    unsubscribeRate: ratio(counts.unsubscribed, denom),
    bounceRate: ratio(counts.bounced, counts.sent),
    complaintRate: ratio(counts.complained, denom),
  };
}

export function aggregateSequenceStats(
  definition: Pick<SequenceDefinition, 'steps'>,
  events: readonly SequenceStatsEvent[],
): SequenceStats {
  const stepCount = definition.steps.length;
  const perStep: StepCounts[] = Array.from({ length: stepCount }, zeroCounts);
  const seen = new Set<string>();
  let orphanEvents = 0;

  for (const e of events) {
    if (!Number.isInteger(e.stepIndex) || e.stepIndex < 0 || e.stepIndex >= stepCount) {
      orphanEvents++;
      continue;
    }
    if (DEDUPED_HUMAN_TYPES.has(e.type)) {
      if (e.isHuman === false) continue;
      const key = JSON.stringify([e.type, e.enrollmentId, e.stepIndex]);
      if (seen.has(key)) continue;
      seen.add(key);
    }
    perStep[e.stepIndex][e.type]++;
  }

  const totalCounts = zeroCounts();
  for (const c of perStep) {
    for (const t of SEQUENCE_EVENT_TYPES) totalCounts[t] += c[t];
  }

  return {
    steps: perStep.map((counts, stepIndex) => ({ stepIndex, counts, rates: computeRates(counts) })),
    total: { counts: totalCounts, rates: computeRates(totalCounts) },
    orphanEvents,
  };
}
