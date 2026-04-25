/**
 * Ad-variant rating service — Onboarding Phase 4 "Ads Tinder".
 *
 * Pure state-transition logic for capturing per-variant user preferences
 * (like / reject) on the Phase 4 reveal screen. The Tinder-style swipe UI
 * fires `POST /api/onboarding/ad-variant/rate` for every commit, which
 * appends one entry to `adVariantsRated` on the User record. The list is
 * capped at MAX_AD_VARIANT_RATINGS to mirror the precedent set by
 * `MAX_ONBOARDING_EVENTS` and prevent unbounded write amplification.
 *
 * Ratings feed two downstream uses:
 *   1. LLM regen prompts — the last 5 `reject` entries are injected as
 *      negative examples so the regenerated variants steer away from
 *      directions the user has already rejected.
 *   2. Lifecycle drip personalization (out of scope for this PR).
 *
 * Design notes:
 *   - Idempotent on (variantId, rating) — we de-dup the latest entry for
 *     the same variantId so the user can re-swipe without exploding the
 *     log.
 *   - Sanitization caps strings to defend against client-injected garbage
 *     bleeding into LLM prompts.
 */

export type AdVariantRating = "like" | "reject";

export interface AdVariantRatingEntry {
  variantId: string;
  rating: AdVariantRating;
  ratedAt: string;
}

export interface AdVariantRatingFields {
  adVariantsRated?: AdVariantRatingEntry[];
}

/**
 * Hard cap on stored ratings. 50 is plenty — the onboarding flow only
 * generates 3 variants, and even with regens a real session shouldn't
 * exceed ~30 entries. Mirror `MAX_ONBOARDING_EVENTS = 50` precedent.
 */
export const MAX_AD_VARIANT_RATINGS = 50;

const MAX_VARIANT_ID_LEN = 64;

/**
 * Validate a candidate `rating` value. Used by both the route handler and
 * the `appendRating` helper so the contract is enforced once.
 */
export function isAdVariantRating(value: unknown): value is AdVariantRating {
  return value === "like" || value === "reject";
}

/**
 * Validate a candidate `variantId` value. Strings only, non-empty after
 * trim, capped at MAX_VARIANT_ID_LEN.
 */
export function isValidVariantId(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= MAX_VARIANT_ID_LEN;
}

/**
 * Sanitize an existing list of rating entries pulled off the User record.
 * Defensively skips entries that fail the schema in case the table got
 * touched outside this service. Caps to MAX_AD_VARIANT_RATINGS.
 */
export function sanitizeAdVariantsRated(
  raw: unknown
): AdVariantRatingEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: AdVariantRatingEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const v = item as Partial<AdVariantRatingEntry>;
    if (!isValidVariantId(v.variantId)) continue;
    if (!isAdVariantRating(v.rating)) continue;
    if (typeof v.ratedAt !== "string" || v.ratedAt.length === 0) continue;
    out.push({
      variantId: v.variantId.trim().slice(0, MAX_VARIANT_ID_LEN),
      rating: v.rating,
      ratedAt: v.ratedAt,
    });
    if (out.length >= MAX_AD_VARIANT_RATINGS) break;
  }
  return out;
}

/**
 * Append a new rating entry to the existing list. De-duplicates by
 * `variantId` (latest rating wins) so re-swiping the same variant flips
 * the recorded rating instead of growing the log. Caps the list to
 * MAX_AD_VARIANT_RATINGS by dropping the oldest entries first.
 *
 * Pure function — returns the patch object for the User update. Safe to
 * call when `current.adVariantsRated` is undefined.
 */
export function appendRatingPatch(
  current: AdVariantRatingFields,
  variantId: string,
  rating: AdVariantRating,
  now: Date = new Date()
): AdVariantRatingFields {
  const trimmedId = variantId.trim().slice(0, MAX_VARIANT_ID_LEN);
  const existing = sanitizeAdVariantsRated(current.adVariantsRated);
  // Drop any prior rating for the same variant — we always keep one entry
  // per variant, with the latest rating.
  const deduped = existing.filter((e) => e.variantId !== trimmedId);
  const next: AdVariantRatingEntry = {
    variantId: trimmedId,
    rating,
    ratedAt: now.toISOString(),
  };
  const combined = [...deduped, next];
  // Cap by dropping oldest. The list is in append order — slice from the
  // end. This is symmetrical with the MAX_ONBOARDING_EVENTS pattern.
  const capped =
    combined.length > MAX_AD_VARIANT_RATINGS
      ? combined.slice(combined.length - MAX_AD_VARIANT_RATINGS)
      : combined;
  return { adVariantsRated: capped };
}

/**
 * Pull the most recent N entries with `rating === "reject"`. Used by the
 * regen prompt extension to inject negative examples without dragging the
 * full history into the system prompt.
 */
export function recentRejectedRatings(
  current: AdVariantRatingFields,
  limit: number
): AdVariantRatingEntry[] {
  if (!Number.isFinite(limit) || limit <= 0) return [];
  const list = sanitizeAdVariantsRated(current.adVariantsRated);
  const rejects = list.filter((e) => e.rating === "reject");
  // Latest first so the prompt shows the most recent rejection at the top.
  // The list is append-ordered, so reverse and take the head.
  return rejects.slice(-limit).reverse();
}

/**
 * Compact summary metric for telemetry. Cheap to compute and useful for
 * eyeballing how the swipe UI is performing in aggregate.
 */
export function ratingSummary(
  current: AdVariantRatingFields
): { likes: number; rejects: number; total: number } {
  const list = sanitizeAdVariantsRated(current.adVariantsRated);
  let likes = 0;
  let rejects = 0;
  for (const r of list) {
    if (r.rating === "like") likes++;
    else if (r.rating === "reject") rejects++;
  }
  return { likes, rejects, total: list.length };
}
