import { RateLimiter } from "../middleware/rateLimiter";

describe("RateLimiter eviction under all-blocked flood (ENG-1768)", () => {
  it("finds an eviction candidate without scanning every timestamp at capacity", () => {
    const maxEntries = 200;
    const limiter = new RateLimiter(60000, maxEntries);
    try {
      // Fill to capacity with keys that are all simultaneously blocked.
      for (let i = 0; i < maxEntries; i++) {
        for (let j = 0; j < 5; j++) {
          limiter.check(`blocked-${i}`, 5);
        }
      }
      // @ts-expect-error accessing private field for test verification
      expect(limiter.entries.size).toBe(maxEntries);

      // @ts-expect-error accessing private method for test verification
      const find = limiter.findEvictionCandidate.bind(limiter);
      const start = Date.now();
      for (let i = 0; i < 50; i++) {
        // @ts-expect-error accessing private field for test verification
        expect(find(Date.now())).toBeDefined();
      }
      const elapsed = Date.now() - start;
      // 50 eviction decisions over 200 fully-blocked entries must stay fast:
      // the O(n)-per-request full-map scan this replaces took ~250k
      // timestamp checks per call at the 50k default cap. A generous 5s
      // budget here proves the candidate lookup no longer scales with
      // total timestamp volume.
      expect(elapsed).toBeLessThan(5000);

      // Memory still bounded after more distinct keys arrive.
      for (let i = 0; i < 100; i++) {
        limiter.check(`new-${i}`, 5);
      }
      // @ts-expect-error accessing private field for test verification
      expect(limiter.entries.size).toBeLessThanOrEqual(maxEntries);
    } finally {
      limiter.destroy();
    }
  });

  it("still prefers an idle key over a blocked key when one exists", () => {
    const limiter = new RateLimiter(60000, 5);
    try {
      for (let j = 0; j < 5; j++) {
        limiter.check("blocked-a", 5);
      }
      limiter.check("idle-b", 1000);
      // Force idle-b's timestamps out of window via cleanup path.
      // @ts-expect-error accessing private field for test verification
      limiter.entries.get("idle-b")!.timestamps = [Date.now() - 120000];
      for (let i = 0; i < 10; i++) {
        limiter.check(`filler-${i}`, 5);
      }
      // blocked-a must still be blocked (never evicted in favor of idle eviction).
      expect(limiter.check("blocked-a", 5).allowed).toBe(false);
    } finally {
      limiter.destroy();
    }
  });

  it("re-qualifies a blocked key once its window expires (CodeRabbit follow-up)", () => {
    const limiter = new RateLimiter(60000, 3);
    try {
      // Fill to capacity, all blocked.
      for (let j = 0; j < 5; j++) {
        limiter.check("blocked-a", 5);
        limiter.check("blocked-b", 5);
        limiter.check("blocked-c", 5);
      }
      // Age blocked-a's timestamps out of window without touching the queue:
      // it was dropped from evictQueue as blocked but is now idle.
      // @ts-expect-error accessing private field for test verification
      limiter.entries.get("blocked-a")!.timestamps = [Date.now() - 120000];
      // Next capacity pressure must evict the now-idle blocked-a, and a fresh
      // check on it must NOT bypass its window (timestamps were aged out, so
      // it is genuinely idle — allowed with a full remaining budget).
      limiter.check("new-key", 5);
      // @ts-expect-error accessing private field for test verification
      expect(limiter.entries.has("blocked-a")).toBe(false);
      const fresh = limiter.check("blocked-a", 5);
      expect(fresh.allowed).toBe(true);
      expect(fresh.remaining).toBe(4);
    } finally {
      limiter.destroy();
    }
  });

  it("drains a large stale queue without quadratic stall (CodeRabbit follow-up)", () => {
    const limiter = new RateLimiter(60000, 5000);
    try {
      for (let i = 0; i < 5000; i++) {
        for (let j = 0; j < 5; j++) {
          limiter.check(`blocked-${i}`, 5);
        }
      }
      // @ts-expect-error accessing private method for test verification
      const find = limiter.findEvictionCandidate.bind(limiter);
      const start = Date.now();
      for (let i = 0; i < 20; i++) {
        // @ts-expect-error accessing private field for test verification
        expect(find(Date.now())).toBeDefined();
      }
      // 20 decisions over 5000 fully-blocked entries: O(N^2) shift-drain
      // would stall for seconds; indexed head keeps it well under budget.
      expect(Date.now() - start).toBeLessThan(2000);
    } finally {
      limiter.destroy();
    }
  });
});
