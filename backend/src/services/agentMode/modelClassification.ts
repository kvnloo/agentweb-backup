import type { ModelTier } from './llmModelRegistry';

/**
 * Cost-score band boundaries backing the picker's tier buckets (Harsha's
 * exact thresholds, revised 2026-08-19 after reviewing the live numbers, and
 * re-cut 2026-09-05 (ENG-1784): "low should have everything 52 and below
 * (very low is fine as it is now), then medium should be 57-53, then pro
 * should be 63-58, frontier is everything above" — so Flagship/"frontier"
 * (≥64) holds Fable 5.1 and GPT-6 Astra (79), GPT-5.6 Sol (71) and Claude
 * Opus 5 (70) together, Pro (58–63) starts at Sonnet 5 / Terra / Kimi K3,
 * Medium (53–57) is Grok 4.6 / Qwen3.8 Max, Cheap (31–52) Luna / Haiku /
 * the Gemini Flash line, Very Cheap (≤30) unchanged) —
 * inclusive lower bound, ordered highest band first. costScore is 0-100 and
 * higher = more expensive (see costScoreFromPrice), so a model's tier is
 * simply whichever band its own cost score falls in. Tier IDs (ultra_premium/
 * ultra_cheap) are unchanged from earlier — only the numeric boundaries and
 * the frontend's DISPLAY labels moved ("Flagship"/"Very Cheap", see
 * modelTiers.ts TIER_LABELS); no backend API contract change.
 */
export const TIER_COST_SCORE_BANDS: ReadonlyArray<{ tier: ModelTier; minCostScore: number }> = [
  { tier: 'ultra_premium', minCostScore: 64 },
  { tier: 'pro', minCostScore: 58 },
  { tier: 'medium', minCostScore: 53 },
  { tier: 'cheap', minCostScore: 31 },
  { tier: 'ultra_cheap', minCostScore: 0 },
];

/** Derives a model's picker tier bucket from its cost score. */
export function tierFromCostScore(costScore: number): ModelTier {
  const band = TIER_COST_SCORE_BANDS.find((b) => costScore >= b.minCostScore);
  // TIER_COST_SCORE_BANDS' last band has minCostScore: 0, which matches any
  // costScore >= 0 — so `band` is only undefined for a negative/NaN input.
  return band?.tier ?? 'ultra_cheap';
}

/**
 * Quality-score band boundaries backing the picker's quality tier grouping
 * (ENG-1789, 2026-09-06). Independent axis from TIER_COST_SCORE_BANDS above:
 * that one groups by costScore (what we charge), this one groups by
 * qualityScore (AA Intelligence Index v4.3.2, re-snapshotted 2026-09-22).
 * Harsha's directive: "fable + astra are flagship, opus + 5.6 sol are pro,
 * sonnet + 5.6 terra are mid, haiku + 5.6 luna are low." Re-solved against
 * the v4.3.2 scores (Fable 53, Astra 53, Opus 5 51, Sol 47, Terra 42,
 * Sonnet 5 38, Luna 38, Haiku 15), which run ~5-8 points below v4.2. One
 * conflict is unavoidable: Sonnet 5 and GPT-5.6 Luna now tie at 38, so ties
 * resolve to the higher band (Harsha, 2026-09-06) and Luna moves up to mid.
 * ultra_premium >=53, pro >=47, medium >=38, cheap >=15, ultra_cheap below.
 * Same ModelTier union and >= / highest-band-first shape as the cost bands.
 */
export const QUALITY_SCORE_BANDS: ReadonlyArray<{ tier: ModelTier; minQualityScore: number }> = [
  { tier: 'ultra_premium', minQualityScore: 53 },
  { tier: 'pro', minQualityScore: 47 },
  { tier: 'medium', minQualityScore: 38 },
  { tier: 'cheap', minQualityScore: 15 },
  { tier: 'ultra_cheap', minQualityScore: 0 },
];

/** Derives a model's quality-tier bucket from its qualityScore (independent of cost tier). */
export function tierFromQualityScore(qualityScore: number): ModelTier {
  const band = QUALITY_SCORE_BANDS.find((b) => qualityScore >= b.minQualityScore);
  // Last band has minQualityScore: 0, matching any qualityScore >= 0 — so
  // `band` is only undefined for a negative/NaN input.
  return band?.tier ?? 'ultra_cheap';
}
