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

  it("never evicts an actively-blocked key to let it bypass its window during a distinct-key flood", () => {
    const limiter = new RateLimiter(60000, 10);
    try {
      const key = "blocked-target";
      // Exhaust the key's own window so it is now actively blocked.
      for (let i = 0; i < 5; i++) {
        limiter.check(key, 5);
      }
      expect(limiter.check(key, 5).allowed).toBe(false);

      // Flood with many distinct new keys — far more than maxEntries — while
      // the blocked key's timestamps are still within its window.
      for (let i = 0; i < 100; i++) {
        limiter.check(`flood-${i}`, 5);
      }

      // The blocked key must still be blocked: it must not have been evicted
      // and silently reset to a fresh, allowed state.
      expect(limiter.check(key, 5).allowed).toBe(false);
    } finally {
      limiter.destroy();
    }
  });

  it("falls back to the default cap for an invalid maxEntries (non-integer/non-positive)", () => {
    const invalidValues = [0, -5, NaN, Infinity, 1.5];
    for (const value of invalidValues) {
      const limiter = new RateLimiter(60000, value);
      try {
        // @ts-expect-error accessing private field for test verification
        expect(limiter.maxEntries).toBe(50000);
      } finally {
        limiter.destroy();
      }
    }
  });
});
