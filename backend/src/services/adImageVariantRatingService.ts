/**
 * Ad-image-variant rating service — Onboarding Phase 4 "Ads Tinder", IMAGE side.
 *
 * The copy side (adVariantRatingService) already captures ♥/✕ on ad COPY and
 * feeds the last 5 rejects back into the copy regen prompt as negative
 * examples. Image ♥/✕ had no equivalent — the signal dead-ended into the
 * generic favorite/archive endpoints and never influenced the next image
 * generation. This service closes that gap (WS1b): image ratings are stored
 * on the User record under `adImageVariantsRated` and the recent rejects are
 * injected as negative VISUAL directions into the next image gen.
 *
 * Symmetrical with adVariantRatingService by design — same cap/dedup/sanitize
 * semantics — but bound to a separate field so copy and image preferences
 * never collide. Validators are reused from the copy service to avoid drift.
 *
 * Pure functions, no network. Unit-tested in adImageVariantRatingService.test.ts.
 */

import {
  type AdVariantRating,
  isAdVariantRating,
  isValidVariantId,
} from './adVariantRatingService';

export type { AdVariantRating };

export interface AdImageVariantRatingEntry {
  variantId: string;
  rating: AdVariantRating;
  ratedAt: string;
}

export interface AdImageVariantRatingFields {
  adImageVariantsRated?: AdImageVariantRatingEntry[];
}

/** Hard cap — mirrors MAX_AD_VARIANT_RATINGS on the copy side. */
export const MAX_AD_IMAGE_VARIANT_RATINGS = 50;

const MAX_VARIANT_ID_LEN = 64;

/**
 * Sanitize an existing list of image-rating entries pulled off the User
 * record. Defensively skips entries that fail the schema. Caps to
 * MAX_AD_IMAGE_VARIANT_RATINGS.
 */
export function sanitizeAdImageVariantsRated(
  raw: unknown,
): AdImageVariantRatingEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: AdImageVariantRatingEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const v = item as Partial<AdImageVariantRatingEntry>;
    if (!isValidVariantId(v.variantId)) continue;
    if (!isAdVariantRating(v.rating)) continue;
    if (typeof v.ratedAt !== 'string' || v.ratedAt.length === 0) continue;
    out.push({
      variantId: v.variantId.trim().slice(0, MAX_VARIANT_ID_LEN),
      rating: v.rating,
      ratedAt: v.ratedAt,
    });
    if (out.length >= MAX_AD_IMAGE_VARIANT_RATINGS) break;
  }
  return out;
}

/**
 * Append a new image rating, deduping by variantId (latest rating wins) and
 * capping at MAX_AD_IMAGE_VARIANT_RATINGS by dropping the oldest. Pure.
 */
export function appendImageRatingPatch(
  current: AdImageVariantRatingFields,
  variantId: string,
  rating: AdVariantRating,
  now: Date = new Date(),
): AdImageVariantRatingFields {
  const trimmedId = variantId.trim().slice(0, MAX_VARIANT_ID_LEN);
  const existing = sanitizeAdImageVariantsRated(current.adImageVariantsRated);
  const deduped = existing.filter((e) => e.variantId !== trimmedId);
  const next: AdImageVariantRatingEntry = {
    variantId: trimmedId,
    rating,
    ratedAt: now.toISOString(),
  };
  const combined = [...deduped, next];
  const capped =
    combined.length > MAX_AD_IMAGE_VARIANT_RATINGS
      ? combined.slice(combined.length - MAX_AD_IMAGE_VARIANT_RATINGS)
      : combined;
  return { adImageVariantsRated: capped };
}

/**
 * Pull the most recent N rejected image variants, latest first. Used by the
 * negative-examples builder to steer the next image gen away from rejected
 * visual directions.
 */
export function recentRejectedImageRatings(
  current: AdImageVariantRatingFields,
  limit: number,
): AdImageVariantRatingEntry[] {
  if (!Number.isFinite(limit) || limit <= 0) return [];
  const list = sanitizeAdImageVariantsRated(current.adImageVariantsRated);
  const rejects = list.filter((e) => e.rating === 'reject');
  return rejects.slice(-limit).reverse();
}

/**
 * Build the "User has rejected these visual directions" negative-example
 * block for the image-generation prompt. Reads the latest rejects and looks
 * up the matching concept/archetype on the previous image variants. Variants
 * no longer present (re-rolled) are silently dropped. Returns "" when there
 * is nothing to add, so the prompt stays clean on the first run.
 *
 * Unlike copy (where we can quote the rejected text), an image can't be
 * pasted into a text prompt — so we describe the rejected DIRECTION (concept
 * label + archetype) and tell the model to avoid that visual approach.
 */
export function buildNegativeExamplesBlockForImages(
  ratings: AdImageVariantRatingFields,
  previousVariants: Array<{ id: string; conceptLabel?: string; archetype?: string }>,
  limit = 5,
): string {
  const rejects = recentRejectedImageRatings(ratings, limit);
  if (rejects.length === 0) return '';
  const lines: string[] = [];
  for (const r of rejects) {
    const prev = previousVariants.find((v) => v.id === r.variantId);
    if (!prev) continue;
    const concept = (prev.conceptLabel || '').slice(0, 160);
    if (!concept) continue;
    const tag = prev.archetype ? ` [archetype ${prev.archetype}]` : '';
    lines.push(`-${tag} ${concept}`);
  }
  if (lines.length === 0) return '';
  return [
    'User REJECTED these recent ad image directions — avoid this visual concept, layout, and overall style:',
    ...lines,
    'Steer toward a clearly different visual concept and composition.',
  ].join('\n');
}

/** Compact aggregate for telemetry / response payloads. */
export function imageRatingSummary(
  current: AdImageVariantRatingFields,
): { likes: number; rejects: number; total: number } {
  const list = sanitizeAdImageVariantsRated(current.adImageVariantsRated);
  let likes = 0;
  let rejects = 0;
  for (const r of list) {
    if (r.rating === 'like') likes++;
    else if (r.rating === 'reject') rejects++;
  }
  return { likes, rejects, total: list.length };
}
