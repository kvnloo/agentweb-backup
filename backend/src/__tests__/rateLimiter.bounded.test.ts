import { RateLimiter } from "../middleware/rateLimiter";

describe("RateLimiter bounded capacity", () => {
  it("never grows the internal entry map past maxEntries under a distinct-key flood", () => {
    const limiter = new RateLimiter(60000, 100);
    try {
      for (let i = 0; i < 1000; i++) {
        limiter.check(`ip-${i}`, 5);
      }
      // @ts-expect-error accessing private field for test verification
      expect(limiter.entries.size).toBeLessThanOrEqual(100);
    } finally {
      limiter.destroy();
    }
  });

  it("still enforces the per-key limit after evictions occur", () => {
    const limiter = new RateLimiter(60000, 10);
    try {
      for (let i = 0; i < 50; i++) {
        limiter.check(`flood-${i}`, 5);
      }
      const key = "target";
      for (let i = 0; i < 5; i++) {
        expect(limiter.check(key, 5).allowed).toBe(true);
      }
      expect(limiter.check(key, 5).allowed).toBe(false);
    } finally {
      limiter.destroy();
    }
  });
});
