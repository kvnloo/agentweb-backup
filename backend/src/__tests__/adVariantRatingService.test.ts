/**
 * Unit tests for adVariantRatingService.
 *
 * Pure-function service — no DB, no LLM, no network. Covers:
 *   - rating + variantId validation
 *   - append + de-dup behaviour
 *   - 50-entry cap (MAX_AD_VARIANT_RATINGS) drops oldest first
 *   - sanitization of malformed array entries
 *   - recentRejectedRatings ordering + limit
 *   - ratingSummary counts
 */

import {
  appendRatingPatch,
  isAdVariantRating,
  isValidVariantId,
  MAX_AD_VARIANT_RATINGS,
  ratingSummary,
  recentRejectedRatings,
  sanitizeAdVariantsRated,
} from "../services/adVariantRatingService";

describe("adVariantRatingService", () => {
  describe("isAdVariantRating", () => {
    it('accepts "like" and "reject"', () => {
      expect(isAdVariantRating("like")).toBe(true);
      expect(isAdVariantRating("reject")).toBe(true);
    });

    it("rejects anything else", () => {
      expect(isAdVariantRating("LIKE")).toBe(false);
      expect(isAdVariantRating("dislike")).toBe(false);
      expect(isAdVariantRating(undefined)).toBe(false);
      expect(isAdVariantRating(null)).toBe(false);
      expect(isAdVariantRating(1)).toBe(false);
      expect(isAdVariantRating({})).toBe(false);
    });
  });

  describe("isValidVariantId", () => {
    it("accepts non-empty strings up to 64 chars", () => {
      expect(isValidVariantId("variant-1")).toBe(true);
      expect(isValidVariantId("a".repeat(64))).toBe(true);
    });

    it("rejects empty / whitespace-only / oversized / non-string", () => {
      expect(isValidVariantId("")).toBe(false);
      expect(isValidVariantId("   ")).toBe(false);
      expect(isValidVariantId("a".repeat(65))).toBe(false);
      expect(isValidVariantId(undefined)).toBe(false);
      expect(isValidVariantId(123)).toBe(false);
    });
  });

  describe("sanitizeAdVariantsRated", () => {
    it("returns empty array for non-array input", () => {
      expect(sanitizeAdVariantsRated(null)).toEqual([]);
      expect(sanitizeAdVariantsRated(undefined)).toEqual([]);
      expect(sanitizeAdVariantsRated({} as unknown)).toEqual([]);
      expect(sanitizeAdVariantsRated("nope")).toEqual([]);
    });

    it("drops entries with bad shape", () => {
      const out = sanitizeAdVariantsRated([
        { variantId: "good", rating: "like", ratedAt: "2026-04-24T00:00:00Z" },
        { variantId: "", rating: "like", ratedAt: "2026-04-24T00:00:00Z" }, // bad id
        { variantId: "x", rating: "love", ratedAt: "2026-04-24T00:00:00Z" }, // bad rating
        { variantId: "x", rating: "like" }, // missing ratedAt
        null,
        "string",
      ]);
      expect(out).toEqual([
        { variantId: "good", rating: "like", ratedAt: "2026-04-24T00:00:00Z" },
      ]);
    });

    it("caps at MAX_AD_VARIANT_RATINGS entries", () => {
      const big = Array.from({ length: MAX_AD_VARIANT_RATINGS + 10 }).map(
        (_, i) => ({
          variantId: `v${i}`,
          rating: "like" as const,
          ratedAt: "2026-04-24T00:00:00Z",
        })
      );
      const out = sanitizeAdVariantsRated(big);
      expect(out.length).toBe(MAX_AD_VARIANT_RATINGS);
    });
  });

  describe("appendRatingPatch", () => {
    it("appends a new entry when none exists", () => {
      const patch = appendRatingPatch(
        {},
        "v1",
        "like",
        new Date("2026-04-24T12:00:00Z")
      );
      expect(patch.adVariantsRated).toEqual([
        { variantId: "v1", rating: "like", ratedAt: "2026-04-24T12:00:00.000Z" },
      ]);
    });

    it("trims and caps the variantId", () => {
      const patch = appendRatingPatch(
        {},
        "  spaced-id  ",
        "reject",
        new Date("2026-04-24T12:00:00Z")
      );
      expect(patch.adVariantsRated?.[0].variantId).toBe("spaced-id");
    });

    it("de-dupes the same variantId — keeps the latest rating", () => {
      const initial = appendRatingPatch(
        {},
        "v1",
        "like",
        new Date("2026-04-24T12:00:00Z")
      );
      const flipped = appendRatingPatch(
        initial,
        "v1",
        "reject",
        new Date("2026-04-24T12:05:00Z")
      );
      expect(flipped.adVariantsRated).toEqual([
        {
          variantId: "v1",
          rating: "reject",
          ratedAt: "2026-04-24T12:05:00.000Z",
        },
      ]);
    });

    it("appends second variant alongside first", () => {
      const a = appendRatingPatch(
        {},
        "v1",
        "like",
        new Date("2026-04-24T12:00:00Z")
      );
      const b = appendRatingPatch(
        a,
        "v2",
        "reject",
        new Date("2026-04-24T12:01:00Z")
      );
      expect(b.adVariantsRated?.length).toBe(2);
      expect(b.adVariantsRated?.[0].variantId).toBe("v1");
      expect(b.adVariantsRated?.[1].variantId).toBe("v2");
    });

    it("caps at MAX_AD_VARIANT_RATINGS entries by dropping oldest", () => {
      let acc: { adVariantsRated?: ReturnType<typeof appendRatingPatch>["adVariantsRated"] } = {};
      for (let i = 0; i < MAX_AD_VARIANT_RATINGS + 5; i++) {
        acc = appendRatingPatch(
          acc,
          `v${i}`,
          "like",
          new Date(`2026-04-24T12:00:${String(i).padStart(2, "0")}Z`)
        );
      }
      expect(acc.adVariantsRated?.length).toBe(MAX_AD_VARIANT_RATINGS);
      // The oldest (`v0..v4`) should be dropped; the newest (`v54`) should remain.
      const ids = acc.adVariantsRated!.map((e) => e.variantId);
      expect(ids).not.toContain("v0");
      expect(ids).not.toContain("v4");
      expect(ids).toContain(`v${MAX_AD_VARIANT_RATINGS + 4}`);
    });

    it("does not mutate the input", () => {
      const initial = appendRatingPatch({}, "v1", "like");
      const before = JSON.stringify(initial);
      appendRatingPatch(initial, "v2", "reject");
      expect(JSON.stringify(initial)).toBe(before);
    });
  });

  describe("recentRejectedRatings", () => {
    it("returns only `reject` entries, latest first, up to limit", () => {
      let acc: { adVariantsRated?: ReturnType<typeof appendRatingPatch>["adVariantsRated"] } = {};
      acc = appendRatingPatch(acc, "v1", "like", new Date("2026-04-24T12:00:00Z"));
      acc = appendRatingPatch(acc, "v2", "reject", new Date("2026-04-24T12:01:00Z"));
      acc = appendRatingPatch(acc, "v3", "reject", new Date("2026-04-24T12:02:00Z"));
      acc = appendRatingPatch(acc, "v4", "like", new Date("2026-04-24T12:03:00Z"));
      acc = appendRatingPatch(acc, "v5", "reject", new Date("2026-04-24T12:04:00Z"));

      const out = recentRejectedRatings(acc, 2);
      expect(out.length).toBe(2);
      expect(out[0].variantId).toBe("v5");
      expect(out[1].variantId).toBe("v3");
    });

    it("returns empty array for limit <= 0 or non-finite", () => {
      const acc = appendRatingPatch({}, "v1", "reject");
      expect(recentRejectedRatings(acc, 0)).toEqual([]);
      expect(recentRejectedRatings(acc, -3)).toEqual([]);
      expect(recentRejectedRatings(acc, NaN)).toEqual([]);
    });

    it("returns empty when no rejects exist", () => {
      const acc = appendRatingPatch({}, "v1", "like");
      expect(recentRejectedRatings(acc, 5)).toEqual([]);
    });
  });

  describe("ratingSummary", () => {
    it("counts likes / rejects / total", () => {
      let acc: { adVariantsRated?: ReturnType<typeof appendRatingPatch>["adVariantsRated"] } = {};
      acc = appendRatingPatch(acc, "v1", "like");
      acc = appendRatingPatch(acc, "v2", "reject");
      acc = appendRatingPatch(acc, "v3", "like");
      expect(ratingSummary(acc)).toEqual({ likes: 2, rejects: 1, total: 3 });
    });

    it("zeros for empty input", () => {
      expect(ratingSummary({})).toEqual({ likes: 0, rejects: 0, total: 0 });
    });
  });
});
