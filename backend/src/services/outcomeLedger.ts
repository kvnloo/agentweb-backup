/**
 * ENG-1550 — outcome ledger: pure half.
 *
 * Records what the agent predicted a recommendation would do, and later scores whether it was
 * right. `backend/src/loops`'s `LearningStore` was evaluated as a reuse candidate first: its
 * `LearningEvent`/`HistoryFilter` types carry no per-account dimension (only `loopId`), and
 * neither does its DynamoDB schema (PK=`loopId` alone) — unusable as-is for a store whose whole
 * job is scoring per AD ACCOUNT. Patterns worth copying: idempotent recording, cooldown-style
 * lookback. Key convention copied from `adsThresholds.ts`: `entityKey = platform#accountId`.
 * Storage lives in `outcomeLedgerDb.ts`.
 *
 * ─── Why a third `unscoreable` verdict, not just correct/incorrect ────────────────────────
 *
 * A recommendation can fail to be scoreable for reasons that have nothing to do with whether the
 * prediction was right: the settling window hasn't elapsed yet, or the actual-metric read came
 * back with zero volume (a real, previously-observed condition on dormant/low-traffic accounts —
 * see the brain doc's cold-start note). Collapsing either case into "incorrect" would make the
 * ledger's own accuracy stats lie about the agent's hit rate. `unscoreable` always carries a
 * `verdictReason` — a verdict with no stated reason cannot be reviewed later.
 *
 * ─── Why direction, not magnitude, is the pass/fail criterion ─────────────────────────────
 *
 * The brain doc's own noise-floor findings (median-zero-lead-days, multi-x weekly swings) mean
 * scoring on exact predicted magnitude would fail almost every real prediction regardless of
 * whether the underlying call was right. Direction-correctness is the claim this ledger can
 * actually defend; magnitude is recorded for calibration but is not part of the verdict.
 */

export type OutcomePlatform = 'meta' | 'google_ads';

export type PredictedDirection = 'increase' | 'decrease';
export type ActualDirection = 'increase' | 'decrease' | 'flat';
export type OutcomeVerdict = 'correct' | 'incorrect' | 'inconclusive' | 'unscoreable';

/** Optional, additive capture contract. Legacy/manual recommendations remain readable.
 * A shadow proposal is not an adopted intervention or a calibrated prediction. */
export interface RecommendationContext {
  execution?: import('./adsOutcomeEvaluator').ExecutionReceipt;
  version: 1;
  clientUserId: string;
  campaignId: string;
  adId: string;
  metricScope: 'ad' | 'campaign';
  mode: 'shadow';
  source: 'assess_client_health';
  sourceWindow: { since: string; until: string };
  rationale: string;
  evidence: Array<{ reference: string; metric: string; value: number }>;
  assumptions: string[];
  confidence: 'uncalibrated';
  reviewState: 'unreviewed';
  reviewAfter: string;
}

/** Validate at BOTH persistence boundaries; never trust a cast of external data. */
export function validateRecommendationContext(value: unknown): asserts value is RecommendationContext {
  const c = value as RecommendationContext | null;
  const text = (s: unknown): s is string => typeof s === 'string' && s.trim().length > 0 && s.length <= 2000;
  const date = (s: unknown): boolean => text(s) && Number.isFinite(Date.parse(s));
  if (c?.execution !== undefined) {
    const e = c.execution;
    if (!e || typeof e !== 'object' || ![e.reference, e.clientUserId, e.platform, e.accountId, e.campaignId, e.recommendationId].every(text) ||
      !date(e.executedAt) || !((e.status === 'succeeded' && e.adopted === true) || (e.status === 'declined' && e.adopted === false)) ||
      e.clientUserId !== c.clientUserId || e.campaignId !== c.campaignId) throw new Error('outcomeLedger: invalid execution receipt');
  }

  if (!c || typeof c !== 'object' || c.version !== 1 || c.mode !== 'shadow' || !['ad', 'campaign'].includes(c.metricScope) ||
      c.source !== 'assess_client_health' || c.confidence !== 'uncalibrated' || c.reviewState !== 'unreviewed' ||
      ![c.clientUserId, c.campaignId, c.adId, c.rationale].every(text) ||
      !date(c.sourceWindow?.since) || !date(c.sourceWindow?.until) ||
      Date.parse(c.sourceWindow.since) > Date.parse(c.sourceWindow.until) || !date(c.reviewAfter) ||
      !Array.isArray(c.assumptions) || c.assumptions.length < 1 || c.assumptions.length > 20 || !c.assumptions.every(text) ||
      !Array.isArray(c.evidence) || c.evidence.length < 1 || c.evidence.length > 20 ||
      !c.evidence.every(e => e && typeof e === 'object' && text(e.reference) && text(e.metric) && typeof e.value === 'number' && Number.isFinite(e.value))) {
    throw new Error('outcomeLedger: invalid recommendation context');
  }
}

/** Only the validated ENG-502 capture contract opts a row into automatic evaluation.
 * Missing attribution is not permission to terminally score a legacy/manual record. */
export function hasLearningContext(r: Recommendation): r is Recommendation & { context: RecommendationContext } {
  try { validateRecommendationContext(r.context); return true; }
  catch { return false; }
}

/** Below this relative change, an actual is treated as `flat` rather than a direction — avoids
 * scoring predictions "wrong" on noise no reasonable prediction could have avoided. */
const FLAT_BAND_PCT = 1;

/** Days after `evaluationDate` before an outcome may be scored, per platform. Meta's 28d matches
 * the value already used by the Creative Fatigue Detector's cooldown; Google's reporting lag is
 * longer, so it gets a longer window. No LinkedIn entry: the brain doc has not established that
 * number yet, and guessing one would let a real prediction get scored against a made-up rule. */
const SETTLING_WINDOW_DAYS: Readonly<Record<OutcomePlatform, number>> = {
  meta: 28,
  google_ads: 90,
};

export function getSettlingWindowDays(platform: OutcomePlatform): number {
  const days = SETTLING_WINDOW_DAYS[platform];
  if (days == null) {
    throw new Error(`outcomeLedger: no settling window defined for platform '${platform}'`);
  }
  return days;
}

export interface Recommendation {
  context?: RecommendationContext;
  accountId: string;
  platform: OutcomePlatform;
  recommendationId: string;
  hypothesis: string;
  predictedMetric: string;
  predictedDirection: PredictedDirection;
  predictedMagnitudePct: number;
  evaluationDate: string; // ISO date the prediction should be judged against
  createdAt: string;
  createdBy: string;
  adopted: boolean | null;
  status: 'pending' | 'scored';
  scoredAt: string | null;
  actualDirection: ActualDirection | null;
  actualMagnitudePct: number | null;
  verdict: OutcomeVerdict | null;
  verdictReason: string | null;
}

export function buildOutcomeEntityKey(platform: OutcomePlatform, accountId: string): string {
  return `${platform}#${accountId}`;
}

export function parseOutcomeEntityKey(
  entityKey: string,
): { platform: OutcomePlatform; accountId: string } | null {
  const separatorIndex = entityKey.indexOf('#');
  if (separatorIndex < 0) return null;
  const platform = entityKey.slice(0, separatorIndex);
  const accountId = entityKey.slice(separatorIndex + 1);
  if (!accountId) return null;
  if (platform !== 'meta' && platform !== 'google_ads') return null;
  return { platform, accountId };
}

export interface CreateRecommendationInput {
  context?: RecommendationContext;
  accountId: string;
  platform: OutcomePlatform;
  recommendationId: string;
  hypothesis: string;
  predictedMetric: string;
  predictedDirection: PredictedDirection;
  predictedMagnitudePct: number;
  evaluationDate: string;
  createdAt: string;
  createdBy: string;
}

/** Builds a new pending recommendation record. Adoption is unknown at creation time — it is set
 * later, by whatever surface acts on (or ignores) the recommendation. */
export function createRecommendation(input: CreateRecommendationInput): Recommendation {
  if (input.context !== undefined) validateRecommendationContext(input.context);
  if (!input.hypothesis || !input.hypothesis.trim()) {
    throw new Error('outcomeLedger: hypothesis must not be empty — an unscoreable-by-design prediction is not a prediction');
  }
  if (!input.predictedMetric || !String(input.predictedMetric).trim()) {
    throw new Error('outcomeLedger: predictedMetric must not be empty');
  }
  if (input.predictedDirection !== 'increase' && input.predictedDirection !== 'decrease') {
    throw new Error(`outcomeLedger: predictedDirection must be 'increase' or 'decrease' (got ${String(input.predictedDirection)})`);
  }
  if (!Number.isFinite(input.predictedMagnitudePct) || input.predictedMagnitudePct < 0) {
    throw new Error(`outcomeLedger: predictedMagnitudePct must be a finite, non-negative number (got ${input.predictedMagnitudePct})`);
  }
  // Validated here, not left to `scoreRecommendation`'s Date arithmetic: `new Date(badString)` is
  // an Invalid Date, and every comparison against one (`x < invalidDate`) evaluates to `false` —
  // so a garbage evaluationDate would silently fall THROUGH the settling-window guard instead of
  // being blocked by it, defeating the one guarantee that guard exists to provide.
  if (Number.isNaN(new Date(input.evaluationDate).getTime())) {
    throw new Error(`outcomeLedger: evaluationDate must be a valid ISO date (got ${String(input.evaluationDate)})`);
  }

  return {
    ...(input.context === undefined ? {} : { context: input.context }),
    accountId: input.accountId,
    platform: input.platform,
    recommendationId: input.recommendationId,
    hypothesis: input.hypothesis,
    predictedMetric: input.predictedMetric,
    predictedDirection: input.predictedDirection,
    predictedMagnitudePct: input.predictedMagnitudePct,
    evaluationDate: input.evaluationDate,
    createdAt: input.createdAt,
    createdBy: input.createdBy,
    adopted: null,
    status: 'pending',
    scoredAt: null,
    actualDirection: null,
    actualMagnitudePct: null,
    verdict: null,
    verdictReason: null,
  };
}

export interface ScoreInput {
  recommendation: Recommendation;
  now: string; // ISO — caller-supplied so scoring stays pure and testable
  adopted: boolean;
  /** Actual metric value observed in the after-window, or null if the read came back with no
   * usable data (e.g. zero-volume account) — the caller distinguishes "no data" from "data was
   * zero" by passing null only for the former. */
  actualValue: number | null;
  /** Baseline the actual is compared against, to derive direction/magnitude. */
  baselineValue: number | null;
}

export interface ScoreResult {
  scoredAt: string;
  adopted: boolean;
  actualDirection: ActualDirection | null;
  actualMagnitudePct: number | null;
  verdict: OutcomeVerdict;
  verdictReason: string | null;
}

/**
 * Scores a pending recommendation against an observed actual. Pure: takes `now` and the actual
 * data as arguments rather than reading a clock or a metrics store itself, so every branch —
 * settling-window-not-elapsed, no-adoption, no-data, flat, correct, incorrect — is directly
 * unit-testable without mocking AWS or Date.
 */
export function scoreRecommendation(input: ScoreInput): ScoreResult {
  const { recommendation, now, adopted, actualValue, baselineValue } = input;

  const windowDays = getSettlingWindowDays(recommendation.platform);
  const settleBy = new Date(recommendation.evaluationDate);
  settleBy.setUTCDate(settleBy.getUTCDate() + windowDays);
  if (new Date(now) < settleBy) {
    return {
      scoredAt: now,
      adopted,
      actualDirection: null,
      actualMagnitudePct: null,
      verdict: 'unscoreable',
      verdictReason: `settling window (${windowDays}d) has not elapsed since evaluationDate`,
    };
  }

  if (!adopted) {
    return {
      scoredAt: now,
      adopted,
      actualDirection: null,
      actualMagnitudePct: null,
      verdict: 'unscoreable',
      verdictReason: 'recommendation was not adopted — no intervention to score',
    };
  }

  // Guarded here, not only at the HTTP route: JSON cannot represent NaN/Infinity (they serialize
  // to `null`), so an HTTP caller can never actually trigger this — but a future direct,
  // non-HTTP caller (e.g. a loop calling this function programmatically once one exists) could.
  // NaN would otherwise silently satisfy neither `> 0` comparison below and fall through to
  // 'decrease' — a wrong verdict, not an obviously-failed one — and Infinity would produce an
  // 'increase' verdict with an infinite, unreviewable magnitude.
  const actualUnusable = actualValue == null || !Number.isFinite(actualValue);
  const baselineUnusable = baselineValue == null || !Number.isFinite(baselineValue);
  if (actualUnusable || baselineUnusable || baselineValue === 0) {
    return {
      scoredAt: now,
      adopted,
      actualDirection: null,
      actualMagnitudePct: null,
      verdict: 'unscoreable',
      verdictReason:
        baselineValue === 0
          ? 'baseline value is zero — percentage change is undefined'
          : 'actual or baseline metric value unavailable',
    };
  }

  const changePct = ((actualValue - baselineValue) / Math.abs(baselineValue)) * 100;
  const actualDirection: ActualDirection =
    Math.abs(changePct) < FLAT_BAND_PCT ? 'flat' : changePct > 0 ? 'increase' : 'decrease';

  if (actualDirection === 'flat') {
    return {
      scoredAt: now,
      adopted,
      actualDirection,
      actualMagnitudePct: changePct,
      verdict: 'unscoreable',
      verdictReason: `actual change (${changePct.toFixed(2)}%) is within the flat band — no direction to score against`,
    };
  }

  const verdict: OutcomeVerdict = actualDirection === recommendation.predictedDirection ? 'correct' : 'incorrect';

  return {
    scoredAt: now,
    adopted,
    actualDirection,
    actualMagnitudePct: changePct,
    verdict,
    verdictReason: null,
  };
}

/** Applies a `ScoreResult` onto a `Recommendation`, producing the scored record to persist. */
export function applyScore(recommendation: Recommendation, score: ScoreResult): Recommendation {
  return {
    ...recommendation,
    status: 'scored',
    adopted: score.adopted,
    scoredAt: score.scoredAt,
    actualDirection: score.actualDirection,
    actualMagnitudePct: score.actualMagnitudePct,
    verdict: score.verdict,
    verdictReason: score.verdictReason,
  };
}
