/**
 * Tests for adImageVariantRatingService — the IMAGE-side analogue of the
 * copy-side adVariantRatingService. Closes the onboarding image feedback
 * loop (WS1b): ♥/✕ on ad IMAGES is stored on the User record under
 * `adImageVariantsRated` and the last N rejects are injected as negative
 * visual directions into the next image generation.
 *
 * Mirrors adVariantRatingService.test.ts. Pure functions, no network.
 */

import {
  appendImageRatingPatch,
  recentRejectedImageRatings,
  sanitizeAdImageVariantsRated,
  imageRatingSummary,
  buildNegativeExamplesBlockForImages,
  MAX_AD_IMAGE_VARIANT_RATINGS,
  type AdImageVariantRatingFields,
} from '../services/adImageVariantRatingService';

describe('adImageVariantRatingService — sanitize', () => {
  it('returns [] for non-array garbage', () => {
    expect(sanitizeAdImageVariantsRated(undefined)).toEqual([]);
    expect(sanitizeAdImageVariantsRated(null)).toEqual([]);
    expect(sanitizeAdImageVariantsRated('nope' as unknown)).toEqual([]);
    expect(sanitizeAdImageVariantsRated(42 as unknown)).toEqual([]);
  });

  it('drops entries with invalid rating / variantId / ratedAt', () => {
    const raw = [
      { variantId: 'a', rating: 'like', ratedAt: '2026-06-14T00:00:00.000Z' },
      { variantId: 'b', rating: 'maybe', ratedAt: '2026-06-14T00:00:00.000Z' }, // bad rating
      { variantId: '', rating: 'reject', ratedAt: '2026-06-14T00:00:00.000Z' }, // bad id
      { variantId: 'c', rating: 'reject', ratedAt: '' }, // bad ts
      { rating: 'like', ratedAt: '2026-06-14T00:00:00.000Z' }, // missing id
    ];
    const out = sanitizeAdImageVariantsRated(raw);
    expect(out).toHaveLength(1);
    expect(out[0].variantId).toBe('a');
  });
});

describe('adImageVariantRatingService — appendImageRatingPatch', () => {
  const now = new Date('2026-06-14T12:00:00.000Z');

  it('appends a first rating when the field is undefined', () => {
    const patch = appendImageRatingPatch({}, 'v1', 'like', now);
    expect(patch.adImageVariantsRated).toEqual([
      { variantId: 'v1', rating: 'like', ratedAt: now.toISOString() },
    ]);
  });

  it('dedups by variantId — re-rating flips the stored rating, no growth', () => {
    let fields: AdImageVariantRatingFields = appendImageRatingPatch({}, 'v1', 'like', now);
    fields = appendImageRatingPatch(fields, 'v1', 'reject', now);
    expect(fields.adImageVariantsRated).toHaveLength(1);
    expect(fields.adImageVariantsRated![0].rating).toBe('reject');
  });

  it('caps the list at MAX_AD_IMAGE_VARIANT_RATINGS, dropping oldest', () => {
    let fields: AdImageVariantRatingFields = {};
    for (let i = 0; i < MAX_AD_IMAGE_VARIANT_RATINGS + 10; i++) {
      fields = appendImageRatingPatch(fields, `v${i}`, 'like', now);
    }
    expect(fields.adImageVariantsRated).toHaveLength(MAX_AD_IMAGE_VARIANT_RATINGS);
    // oldest (v0..v9) dropped; newest retained
    const ids = fields.adImageVariantsRated!.map((e) => e.variantId);
    expect(ids).toContain(`v${MAX_AD_IMAGE_VARIANT_RATINGS + 9}`);
    expect(ids).not.toContain('v0');
  });
});

describe('adImageVariantRatingService — recentRejectedImageRatings', () => {
  const now = new Date('2026-06-14T12:00:00.000Z');

  it('returns [] when limit <= 0 or no rejects', () => {
    const fields = appendImageRatingPatch({}, 'v1', 'like', now);
    expect(recentRejectedImageRatings(fields, 0)).toEqual([]);
    expect(recentRejectedImageRatings(fields, 5)).toEqual([]);
  });

  it('returns the latest N rejects, most recent first', () => {
    let fields: AdImageVariantRatingFields = {};
    fields = appendImageRatingPatch(fields, 'a', 'reject', now);
    fields = appendImageRatingPatch(fields, 'b', 'like', now);
    fields = appendImageRatingPatch(fields, 'c', 'reject', now);
    fields = appendImageRatingPatch(fields, 'd', 'reject', now);
    const out = recentRejectedImageRatings(fields, 2);
    expect(out.map((e) => e.variantId)).toEqual(['d', 'c']);
  });
});

describe('adImageVariantRatingService — buildNegativeExamplesBlockForImages', () => {
  const now = new Date('2026-06-14T12:00:00.000Z');

  it('returns "" when there are no rejects', () => {
    const fields = appendImageRatingPatch({}, 'v1', 'like', now);
    expect(buildNegativeExamplesBlockForImages(fields, [{ id: 'v1', conceptLabel: 'x' }])).toBe('');
  });

  it('returns "" when rejects do not match any previous variant', () => {
    const fields = appendImageRatingPatch({}, 'gone', 'reject', now);
    expect(buildNegativeExamplesBlockForImages(fields, [{ id: 'other', conceptLabel: 'x' }])).toBe('');
  });

  it('builds a visual-direction block referencing concept + archetype of rejects', () => {
    let fields: AdImageVariantRatingFields = {};
    fields = appendImageRatingPatch(fields, 'v1', 'reject', now);
    fields = appendImageRatingPatch(fields, 'v2', 'reject', now);
    const block = buildNegativeExamplesBlockForImages(fields, [
      { id: 'v1', conceptLabel: 'neon gradient hero', archetype: 'A' },
      { id: 'v2', conceptLabel: 'flat lay product', archetype: 'C' },
    ]);
    expect(block).toContain('REJECTED');
    expect(block).toContain('neon gradient hero');
    expect(block).toContain('flat lay product');
    // most-recent-first ordering
    expect(block.indexOf('flat lay product')).toBeLessThan(block.indexOf('neon gradient hero'));
  });
});

describe('adImageVariantRatingService — imageRatingSummary', () => {
  const now = new Date('2026-06-14T12:00:00.000Z');
  it('counts likes / rejects / total', () => {
    let fields: AdImageVariantRatingFields = {};
    fields = appendImageRatingPatch(fields, 'a', 'like', now);
    fields = appendImageRatingPatch(fields, 'b', 'reject', now);
    fields = appendImageRatingPatch(fields, 'c', 'like', now);
    expect(imageRatingSummary(fields)).toEqual({ likes: 2, rejects: 1, total: 3 });
  });
});
