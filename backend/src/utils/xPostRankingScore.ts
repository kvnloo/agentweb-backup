import { extractJson } from '../services/util/extractJson';

/**
 * ENG-56 — score an X (Twitter) post against the signal categories X's own
 * ranking algorithm optimizes for, so a draft can be assessed before posting
 * and a published post's actual performance can be compared against it.
 *
 * Weights below are the default values of the tunable runtime feature-switch
 * params in xai-org/x-algorithm's home-mixer/params/param.rs (public repo,
 * Apache-2.0), pulled directly from source on 2026-09-09 — NOT from secondary
 * blog summaries, several of which quote stale/incorrect numbers. X can retune
 * these via flag flip without a new commit, so treat this as a dated snapshot
 * to re-pull periodically, not a permanent constant.
 */
export const X_RANKING_SIGNAL_WEIGHTS = {
  favorite: 0.5,
  reply: 5.0,
  retweet: 1.0,
  quote: 5.0,
  share: 2.0,
  report: -234.0,
} as const;

export type XRankingSignal = keyof typeof X_RANKING_SIGNAL_WEIGHTS;

/** Probability (0-1) that a typical viewer performs each action after seeing the post. */
export type XPostSignalProbabilities = Record<XRankingSignal, number>;

/** Real per-post counts as returned by X API v2 `public_metrics` (via twitterService.getTweetMetrics). */
export interface XPostActualMetrics {
  likeCount: number;
  replyCount: number;
  retweetCount: number;
  quoteCount: number;
  impressionCount: number;
}

function clampProbability(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

/** Weighted expected-engagement score from per-view probabilities. Pure, no I/O. */
export function computeWeightedXScore(probs: XPostSignalProbabilities): number {
  return (Object.keys(X_RANKING_SIGNAL_WEIGHTS) as XRankingSignal[]).reduce(
    (sum, signal) => sum + X_RANKING_SIGNAL_WEIGHTS[signal] * clampProbability(probs[signal]),
    0,
  );
}

/**
 * Heuristic starting-point thresholds — NOT calibrated against real X ranking
 * percentiles (we have no ground truth for those). Re-derive once enough
 * predicted-vs-actual pairs exist via computeActualXScore.
 */
export function scoreTier(raw: number): 'low' | 'medium' | 'high' {
  if (raw >= 0.5) return 'high';
  if (raw >= 0.15) return 'medium';
  return 'low';
}

export function buildXAssessmentPrompt(text: string): { system: string; user: string } {
  const signals = (Object.keys(X_RANKING_SIGNAL_WEIGHTS) as XRankingSignal[]).join(', ');
  const system =
    `You assess how a draft X (Twitter) post is likely to perform, using the same signal ` +
    `categories X's own ranking algorithm scores posts on: ${signals}. For each category, ` +
    `estimate the probability (0 to 1) that a TYPICAL viewer in the post's likely audience ` +
    `performs that action after seeing it. "report" is the probability the post gets reported ` +
    `(policy violations, spam, harassment) — near 0 for ordinary content. ` +
    `Respond with ONLY JSON: {"favorite": <0-1>, "reply": <0-1>, "retweet": <0-1>, "quote": <0-1>, "share": <0-1>, "report": <0-1>}.`;
  const user = `Draft X post:\n${text}`;
  return { system, user };
}

/** Parses and clamps a Grok assessment response. Fails closed (throws) on unparsable input. */
export function parseXAssessmentResponse(raw: string): XPostSignalProbabilities {
  const parsed = extractJson<Partial<Record<XRankingSignal, unknown>>>(raw);
  const result = {} as XPostSignalProbabilities;
  for (const signal of Object.keys(X_RANKING_SIGNAL_WEIGHTS) as XRankingSignal[]) {
    result[signal] = clampProbability(parsed?.[signal]);
  }
  return result;
}

/**
 * Actual weighted score from real per-post metrics, as an engagement RATE
 * (count / impressions) so it's on the same scale as the predicted per-view
 * probabilities above. Limited to favorite/reply/retweet/quote — the only
 * categories X's public API actually exposes counts for; "share" and "report"
 * have no public per-post count, so they're never fabricated here.
 * Returns null (fails closed) when impressions are missing or zero rather
 * than dividing by zero or guessing a rate.
 */
export function computeActualXScore(metrics: XPostActualMetrics): number | null {
  if (!metrics.impressionCount || metrics.impressionCount <= 0) return null;
  const rate = (count: number) => count / metrics.impressionCount;
  return (
    X_RANKING_SIGNAL_WEIGHTS.favorite * rate(metrics.likeCount) +
    X_RANKING_SIGNAL_WEIGHTS.reply * rate(metrics.replyCount) +
    X_RANKING_SIGNAL_WEIGHTS.retweet * rate(metrics.retweetCount) +
    X_RANKING_SIGNAL_WEIGHTS.quote * rate(metrics.quoteCount)
  );
}
