/**
 * Unit tests for the X (Twitter) API pay-per-use rate card (ENG-664).
 *
 * Rates are X's published pay-per-use pricing (docs.x.com/x-api/getting-started/pricing,
 * effective April 2026). Every figure is ALLOCATED — we apply X's rate to a call /
 * resource count; X does not report a per-call price back to us. So these are an
 * allocated estimate, always an upper bound (X dedups repeat reads within a UTC day).
 */

import {
  computeTwitterCost,
  TWITTER_PROVIDER,
  isTwitterOperation,
  TwitterOperation,
} from "../utils/twitterPricing";

describe("computeTwitterCost", () => {
  // ── FAIL / invalid-input cases ────────────────────────────────────────────
  it("clamps negative units to 0 (never a negative charge)", () => {
    const c = computeTwitterCost("search_tweets", -5);
    expect(c.quantity).toBe(0);
    expect(c.costUsd).toBe(0);
  });

  it("treats a non-finite unit count as 0", () => {
    const c = computeTwitterCost("get_profile", Number.NaN);
    expect(c.quantity).toBe(0);
    expect(c.costUsd).toBe(0);
  });

  it("throws on an unknown operation (no silent $0 attribution)", () => {
    expect(() => computeTwitterCost("not_a_real_op" as TwitterOperation, 1)).toThrow(
      /unknown x operation/i
    );
  });

  // ── Boundary cases ────────────────────────────────────────────────────────
  it("0 resources read costs $0 but is still a recordable call", () => {
    const c = computeTwitterCost("search_tweets", 0);
    expect(c.quantity).toBe(0);
    expect(c.costUsd).toBe(0);
    expect(c.unit).toBe("post");
  });

  it("rounds fractional unit counts down to whole resources", () => {
    const c = computeTwitterCost("search_tweets", 3.9);
    expect(c.quantity).toBe(3);
  });

  // ── SUCCESS / happy-path rate cases ───────────────────────────────────────
  it("prices post reads at $0.005 per resource", () => {
    const c = computeTwitterCost("search_tweets", 10);
    expect(c.unit).toBe("post");
    expect(c.quantity).toBe(10);
    expect(c.costUsd).toBeCloseTo(0.05, 6);
  });

  it("prices user reads at $0.010 per resource", () => {
    const c = computeTwitterCost("get_liking_users", 4);
    expect(c.unit).toBe("user");
    expect(c.costUsd).toBeCloseTo(0.04, 6);
  });

  it("prices owned reads at $0.001 per resource", () => {
    const c = computeTwitterCost("get_bookmarks", 7);
    expect(c.unit).toBe("resource");
    expect(c.costUsd).toBeCloseTo(0.007, 6);
  });

  it("prices DM reads at $0.010 per resource", () => {
    const c = computeTwitterCost("list_dms", 3);
    expect(c.unit).toBe("dm");
    expect(c.costUsd).toBeCloseTo(0.03, 6);
  });

  it("prices a plain post at $0.015", () => {
    const c = computeTwitterCost("post", 1);
    expect(c.unit).toBe("post");
    expect(c.costUsd).toBeCloseTo(0.015, 6);
  });

  it("prices a post that contains a link at $0.200", () => {
    const c = computeTwitterCost("post", 1, { hasLink: true });
    expect(c.costUsd).toBeCloseTo(0.2, 6);
  });

  it("prices a DM create at $0.015 per request", () => {
    const c = computeTwitterCost("send_dm", 1);
    expect(c.unit).toBe("request");
    expect(c.costUsd).toBeCloseTo(0.015, 6);
  });

  it("records interaction writes (like/follow/delete/block/mute) at $0 (X publishes no price)", () => {
    for (const op of ["like", "follow", "delete_tweet", "block", "mute", "retweet"] as TwitterOperation[]) {
      const c = computeTwitterCost(op, 1);
      expect(c.costUsd).toBe(0);
      expect(c.unit).toBe("request");
    }
  });
});

describe("isTwitterOperation", () => {
  it("accepts a known operation and rejects junk", () => {
    expect(isTwitterOperation("search_tweets")).toBe(true);
    expect(isTwitterOperation("nope")).toBe(false);
  });
});

describe("provider constant", () => {
  it("is the stable ledger provider id 'twitter'", () => {
    expect(TWITTER_PROVIDER).toBe("twitter");
  });
});
