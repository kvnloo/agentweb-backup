import { extractJson } from '../services/util/extractJson';

/**
 * ENG-56 — score an X (Twitter) post against the signal categories and
 * combination formula X's own ranking algorithm ("weighted" ValueModelMode —
 * confirmed the live DEFAULT via ValueModelMode's param default) actually
 * uses, ported from xai-org/x-algorithm's source (public repo, Apache-2.0),
 * pulled directly on 2026-09-09:
 *   - home-mixer/params/param.rs        — every weight constant below
 *   - home-mixer/scorers/ranking_scorer.rs — RankingScorer::compute_weighted_score
 *     / compute_weighted_parts / offset_score (the actual pos/neg/offset math)
 *   - home-mixer/params/config.rs       — NEGATIVE_SCORES_OFFSET
 *
 * NOT from secondary blog summaries — several of those quote stale/incorrect
 * numbers (verified by diffing against this source). X can retune every
 * weight below via flag flip without a new commit, so treat this as a dated
 * snapshot to re-pull periodically, not a permanent constant.
 *
 * ============================================================================
 * WHAT THIS DOES AND DOES NOT REPRODUCE — read before trusting a score
 * ============================================================================
 *
 * Reproduced faithfully:
 *  - The real weight VALUES for every signal category a viewer's reaction to
 *    a post can be judged on from text/context alone (see TEXT_ESTIMABLE_SIGNALS).
 *  - The real nonlinear combination: candidates are NOT a flat weighted sum.
 *    Terms split into positive/negative buckets, then `offsetScore` applies a
 *    different transform depending on whether the net (pos - neg) is negative
 *    (normalized against total negative-feedback capacity) or non-negative
 *    (a flat additive offset). Ported as `offsetScore` below, not approximated.
 *
 * Cannot be reproduced, and this file does not pretend to:
 *  - Telemetry-only signals: dwell time, click-dwell time (with X's own
 *    nonlinear low-favorite-rate penalty), active-seconds residual norm,
 *    "not dwelled". These come from actual serving telemetry on a real
 *    impression — there is no way to predict them for a draft that has never
 *    been shown to anyone, by an LLM or otherwise.
 *  - Media-view signals: photo_expand, video_open, vqv (video quality view),
 *    quoted_click, quoted_vqv. Meaningful only when a post carries media and
 *    someone actually views it; this tool takes text only.
 *  - Per-request, per-viewer ranking adjustments: author cold-start rules,
 *    in-network/out-of-network author diversity, the out-of-network discount,
 *    and PER-REQUEST weight perturbation (`ScoringWeights::perturbed`, salted
 *    by user_id — X does not even use one fixed weight set per request). A
 *    post has no single "the" X ranking score outside a specific viewer, a
 *    specific candidate pool, and a specific request. What this file computes
 *    is the "weighted_score" component X computes BEFORE those adjustments —
 *    a real, named intermediate value in their own code, not our invention —
 *    but still one step short of final placement in any actual feed.
 *
 * Net effect: use the output to compare draft A vs draft B, or a post's
 * predicted score against its own later actual score — not as an absolute
 * percentile on X's real ranking.
 */

/** Every named weight in RankingScorer's `ScoringWeights`, real defaults from param.rs. */
export const X_RANKING_WEIGHTS = {
  favorite: 0.5,
  reply: 5.0,
  retweet: 1.0,
  photoExpand: 0.05, // telemetry/media — excluded, see TEXT_ESTIMABLE_SIGNALS
  videoOpen: 0.07, // telemetry/media — excluded
  click: 0.4,
  openLink: 0.2,
  profileClick: 0.0, // live default is literally 0 — included for structural fidelity, contributes nothing today
  vqv: 0.0, // telemetry/media — excluded
  share: 2.0,
  shareViaDm: 5.0,
  shareViaCopyLink: 20.0,
  dwell: 0.05, // telemetry — excluded
  quote: 5.0,
  quotedClick: 0.05, // telemetry/media — excluded
  quotedVqv: 0.0, // telemetry/media — excluded
  followAuthor: 4.0,
  notInterested: -43.2,
  blockAuthor: -31.2,
  muteAuthor: -58.8,
  report: -234.0,
  notDwelled: -0.02, // telemetry — excluded
} as const;

export type XRankingSignal = keyof typeof X_RANKING_WEIGHTS;

/** config.rs: NEGATIVE_SCORES_OFFSET — the real additive/normalization constant in offsetScore. */
export const NEGATIVE_SCORES_OFFSET = 0.001;

/**
 * Signals a viewer's reaction to can plausibly be judged from post TEXT alone —
 * everything except the telemetry-only and media-view categories above.
 * `reply`'s real bidirectional-mutual-follow boost is intentionally omitted:
 * we have no generic "typical viewer" follow-relationship to apply it to.
 */
export const TEXT_ESTIMABLE_SIGNALS: XRankingSignal[] = [
  'favorite', 'reply', 'retweet', 'quote',
  'click', 'openLink', 'profileClick', 'followAuthor',
  'share', 'shareViaDm', 'shareViaCopyLink',
  'notInterested', 'blockAuthor', 'muteAuthor', 'report',
];

/**
 * Signals X's public API v2 actually returns a per-post COUNT for. X never
 * exposes block/mute/report/not_interested counts for other users' actions
 * on your post (privacy/anti-abuse) — those can only ever be predicted, not
 * measured, no matter how good the API access.
 */
export const API_MEASURABLE_SIGNALS: XRankingSignal[] = ['favorite', 'reply', 'retweet', 'quote'];

export type XSignalProbabilities = Partial<Record<XRankingSignal, number>>;

function clampProbability(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

/**
 * Ported from RankingScorer::offset_score (ranking_scorer.rs). `positiveSum`/
 * `negativeSum` are the sum of raw WEIGHT values (not weight*probability) for
 * the positive/negative signals actually included — the real per-candidate
 * normalization denominator, computed once for a given signal subset.
 */
function offsetScore(combined: number, positiveSum: number, negativeSum: number): number {
  const totalSum = positiveSum + negativeSum;
  if (totalSum === 0) return Math.max(combined, 0);
  if (combined < 0) return ((combined + negativeSum) / totalSum) * NEGATIVE_SCORES_OFFSET;
  return combined + NEGATIVE_SCORES_OFFSET;
}

/**
 * Ported from RankingScorer::compute_weighted_parts + compute_weighted_score.
 * `probs` need only cover `includedSignals`; anything else defaults to 0.
 */
export function computeXRankingScore(probs: XSignalProbabilities, includedSignals: XRankingSignal[]): number {
  let pos = 0;
  let neg = 0;
  let positiveSum = 0;
  let negativeSum = 0;
  for (const signal of includedSignals) {
    const weight = X_RANKING_WEIGHTS[signal];
    if (weight >= 0) positiveSum += weight;
    else negativeSum += -weight;

    const term = weight * clampProbability(probs[signal]);
    if (term >= 0) pos += term;
    else neg += -term;
  }
  return offsetScore(pos - neg, positiveSum, negativeSum);
}

/**
 * A real, source-derived threshold — not a heuristic bucket. offsetScore's two
 * branches guarantee every net-positive (pos - neg >= 0) candidate scores
 * >= NEGATIVE_SCORES_OFFSET, and every net-negative candidate scores strictly
 * less: the negative branch is (something < negativeSum) / totalSum * OFFSET,
 * which is always < 1 * OFFSET since totalSum > negativeSum whenever there is
 * at least one positive-weighted signal. So this boundary is exactly
 * "did predicted positive engagement outweigh predicted negative feedback."
 */
export function isNetPositive(score: number): boolean {
  return score >= NEGATIVE_SCORES_OFFSET;
}

export function buildXAssessmentPrompt(text: string): { system: string; user: string } {
  const hasLink = /https?:\/\/\S+/i.test(text);
  const fields = TEXT_ESTIMABLE_SIGNALS.map((s) => `"${s}"`).join(', ');
  const system =
    `You assess how a draft X (Twitter) post is likely to perform, using the same signal ` +
    `categories X's own ranking algorithm scores posts on. For each of these, estimate the ` +
    `probability (0 to 1) that a TYPICAL viewer in the post's likely audience performs that ` +
    `action after seeing it: ${fields}. "notInterested"/"blockAuthor"/"muteAuthor"/"report" are ` +
    `negative-feedback probabilities — near 0 for ordinary content, higher for spammy/offensive/` +
    `repetitive content. "openLink" must be 0 if the post has no link.${hasLink ? '' : ' This post has no link.'} ` +
    `Respond with ONLY JSON mapping each field name above to its probability.`;
  const user = `Draft X post:\n${text}`;
  return { system, user };
}

/** Parses and clamps a Grok assessment response. Fails closed (throws) on unparsable input. */
export function parseXAssessmentResponse(raw: string, text: string): XSignalProbabilities {
  const parsed = extractJson<Partial<Record<XRankingSignal, unknown>>>(raw);
  const result: XSignalProbabilities = {};
  const hasLink = /https?:\/\/\S+/i.test(text);
  for (const signal of TEXT_ESTIMABLE_SIGNALS) {
    result[signal] = signal === 'openLink' && !hasLink ? 0 : clampProbability(parsed?.[signal]);
  }
  return result;
}

/** Real per-post counts as returned by X API v2 `public_metrics` (via twitterService.getTweetMetrics). */
export interface XPostActualMetrics {
  likeCount: number;
  replyCount: number;
  retweetCount: number;
  quoteCount: number;
  impressionCount: number;
}

/**
 * Actual score from real per-post metrics, using engagement RATE (count /
 * impressions) as the empirical estimate of "predicted probability" — the
 * same quantity offsetScore's weights are defined against (see the
 * `RankingScorer` weights doc comment in source: "weights multiply the
 * *predicted* probability... not raw counts"). Limited to
 * API_MEASURABLE_SIGNALS — the only categories X's public API exposes counts
 * for. Returns null (fails closed) when impressions are missing or zero
 * rather than dividing by zero or guessing a rate.
 */
export function computeActualXScore(metrics: XPostActualMetrics): number | null {
  if (!metrics.impressionCount || metrics.impressionCount <= 0) return null;
  const rate = (count: number) => count / metrics.impressionCount;
  const probs: XSignalProbabilities = {
    favorite: rate(metrics.likeCount),
    reply: rate(metrics.replyCount),
    retweet: rate(metrics.retweetCount),
    quote: rate(metrics.quoteCount),
  };
  return computeXRankingScore(probs, API_MEASURABLE_SIGNALS);
}

/** Convenience wrapper: predicted score from Grok's estimated text-estimable signal probabilities. */
export function computePredictedXScore(probs: XSignalProbabilities): number {
  return computeXRankingScore(probs, TEXT_ESTIMABLE_SIGNALS);
}
