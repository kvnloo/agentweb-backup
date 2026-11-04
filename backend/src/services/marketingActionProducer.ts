/**
 * ENG-1094 slice 1: the canonical marketing-action PRODUCER.
 *
 * ENG-445 shipped the contract + deterministic top-3 selector and ENG-446 the
 * envelope carrier, but nothing produced `MarketingActionCandidate[]`, so every
 * envelope carried an empty list. This module is that producer's mapping half.
 *
 * Source: the outcome ledger's structured `Recommendation` rows (ENG-502
 * shadow captures from the existing client-health fatigue detector). They are
 * already typed, validated, and evidence-backed — so this maps fields, it never
 * parses prose and never invents a recommendation.
 *
 * Only rows that pass `hasLearningContext` (the validated ENG-502 contract) are
 * eligible; legacy/manual rows and already-scored rows map to nothing. Ids
 * come from `marketingActionId(actionType, scopeId)` inside the selector, so
 * the same ledger rows always yield the same actions in the same order.
 *
 * PURE: no I/O. Persisting the result (`attachMarketingActions` before
 * `scheduleDb.addRunResult`) is a separate, data-plane-gated slice.
 */
import type { MarketingActionCandidate, MarketingActionTier } from './marketingActionContract';
import {
  classifyMarketingActionRisk,
  type MarketingActionRiskClassification,
} from './marketingActionRisk';
import { hasLearningContext, type Recommendation } from './outcomeLedger';

/** ENG-2775 shadow observer: receives each candidate's risk classification.
 *  Observation only — the returned candidates are identical with or without it. */
export type MarketingActionRiskObserver = (
  candidate: MarketingActionCandidate,
  risk: MarketingActionRiskClassification,
) => void;

export const CREATIVE_REFRESH_ACTION = 'refresh_creative';

/** Deep link: an existing CUSTOMER_PORTAL_PAGES path (ENG-502 rows are Meta). */
export const RECOMMENDATION_REVIEW_PATH = '/meta-campaigns';

function impactTier(magnitudePct: number): MarketingActionTier {
  if (magnitudePct >= 50) return 'high';
  if (magnitudePct >= 20) return 'medium';
  return 'low';
}

function scopeFor(rec: Recommendation & { context: NonNullable<Recommendation['context']> }): string {
  const c = rec.context;
  return c.metricScope === 'ad'
    ? `${rec.platform}:${rec.accountId}:${c.campaignId}:${c.adId}`
    : `${rec.platform}:${rec.accountId}:${c.campaignId}`;
}

/**
 * Map ledger recommendations produced by a report/run into contract candidates.
 * Pending (unscored) rows only: a scored prediction is history, not a move.
 */
export function candidatesFromRecommendations(
  recommendations: readonly Recommendation[] | null | undefined,
  source: { sourceKind: 'report' | 'run'; sourceId: string },
  onRiskClassified?: MarketingActionRiskObserver,
): MarketingActionCandidate[] {
  if (!Array.isArray(recommendations) || recommendations.length === 0) return [];
  if (typeof source?.sourceId !== 'string' || source.sourceId.trim() === '') {
    throw new Error('marketingActionProducer: sourceId is required');
  }

  const out: MarketingActionCandidate[] = [];
  for (const rec of recommendations) {
    if (!rec || rec.status !== 'pending' || !hasLearningContext(rec)) continue;
    const c = rec.context;
    const candidate: MarketingActionCandidate = {
      actionType: CREATIVE_REFRESH_ACTION,
      recommendation: rec.hypothesis,
      scopeId: scopeFor(rec),
      evidence: c.evidence.map((e) => `${e.reference} ${e.metric}=${e.value}`),
      expectedImpact: `${rec.predictedDirection} ${rec.predictedMetric} ~${Math.round(rec.predictedMagnitudePct)}% (uncalibrated)`,
      sourceKind: source.sourceKind,
      sourceId: source.sourceId,
      priority: {
        businessImpact: impactTier(rec.predictedMagnitudePct),
        campaignPriority: 'medium',
        urgency: 'medium',
        // ENG-502 rows are explicitly uncalibrated shadow hypotheses.
        confidence: 'low',
        easeOfExecution: 'medium',
      },
      ctaType: 'review',
      deepLink: RECOMMENDATION_REVIEW_PATH,
    };
    out.push(candidate);
    if (onRiskClassified) {
      const objectLevel = c.metricScope === 'ad' ? 'ad' : 'campaign';
      // Ownership is not proven from ledger rows, so this never classifies as auto.
      const classification = classifyMarketingActionRisk({ actionType: candidate.actionType, objectLevel });
      // Shadow observer gets a snapshot and cannot mutate output or abort generation.
      const snapshot: MarketingActionCandidate = {
        ...candidate,
        evidence: [...candidate.evidence],
        priority: { ...candidate.priority },
      };
      try {
        // An async observer returns a promise; swallow its rejection too.
        const ret: unknown = onRiskClassified(snapshot, classification);
        if (ret && typeof (ret as Promise<unknown>).then === 'function') {
          (ret as Promise<unknown>).then(undefined, () => undefined);
        }
      } catch {
        // Observer failures are ignored: shadow-only, must not affect candidates.
      }
    }
  }
  return out;
}
