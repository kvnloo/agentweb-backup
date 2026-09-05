interface RateLimitEntry {
  timestamps: number[];
  // The maxPerMinute this key was last checked against — needed at eviction
  // time to tell whether a key is currently *blocked* (at/over its own
  // limit) vs merely active, since eviction must never free up a blocked
  // key's slot (that would let it bypass its window early).
  lastMax: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetInMs: number;
}

export class RateLimiter {
  private entries: Map<string, RateLimitEntry> = new Map();
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;
  private windowMs = 60000; // 1 minute
  // Bounds in-memory growth against a flood of distinct keys (e.g. many
  // source IPs hitting a public endpoint). Cap chosen generously above any
  // realistic legitimate per-minute unique-caller count for this process.
  private maxEntries: number;

  constructor(cleanupIntervalMs: number = 60000, maxEntries: number = 50000) {
    this.cleanupInterval = setInterval(() => this.cleanup(), cleanupIntervalMs);
    // Only enable bounded storage for a valid positive integer cap; an
    // invalid value (non-finite, non-integer, <= 0) falls back to the
    // default rather than silently disabling or corrupting eviction.
    this.maxEntries =
      Number.isInteger(maxEntries) && maxEntries > 0 ? maxEntries : 50000;
  }

  /**
   * Picks a key safe to evict at capacity, in priority order:
   *   1. A key with no timestamps left in the window (fully idle) — freeing
   *      it changes nothing observable.
   *   2. A key that is tracked but NOT currently at/over its own limit
   *      (i.e. not blocked) — evicting it just means its next request looks
   *      "fresh", which is the same relaxation the old oldest-insertion
   *      eviction already accepted for non-blocked keys.
   *   3. Only if every single tracked key is currently blocked, fall back to
   *      the oldest insertion — still bounds memory, and this case requires
   *      >= maxEntries simultaneously-blocked distinct keys, an extreme
   *      flood scenario where evicting one blocked key slightly early is an
   *      acceptable trade against unbounded growth.
   */
  private findEvictionCandidate(now: number): string | undefined {
    const windowStart = now - this.windowMs;
    let blockedFallback: string | undefined;

    for (const [key, entry] of this.entries.entries()) {
      const activeCount = entry.timestamps.filter((t) => t > windowStart).length;

      if (activeCount === 0) {
        return key; // fully idle — safe to evict immediately
      }

      const isBlocked = activeCount >= entry.lastMax;
      if (!isBlocked) {
        return key; // active but under its own limit — safe to evict
      }

      if (blockedFallback === undefined) {
        blockedFallback = key;
      }
    }

    return blockedFallback;
  }

  check(key: string, maxPerMinute: number): RateLimitResult {
    const now = Date.now();
    const windowStart = now - this.windowMs;

    let entry = this.entries.get(key);
    if (!entry) {
      if (this.entries.size >= this.maxEntries) {
        // At capacity: evict a safe key (see findEvictionCandidate) rather
        // than let the table grow unbounded.
        const evictKey = this.findEvictionCandidate(now);
        if (evictKey !== undefined) {
          this.entries.delete(evictKey);
        }
      }
      entry = { timestamps: [], lastMax: maxPerMinute };
      this.entries.set(key, entry);
    }

    entry.lastMax = maxPerMinute;

    // Remove timestamps outside the window
    entry.timestamps = entry.timestamps.filter((t) => t > windowStart);

    if (entry.timestamps.length >= maxPerMinute) {
      const oldestInWindow = entry.timestamps[0];
      const resetInMs = oldestInWindow + this.windowMs - now;
      return {
        allowed: false,
        remaining: 0,
        resetInMs: Math.max(resetInMs, 0),
      };
    }

    entry.timestamps.push(now);
    const remaining = maxPerMinute - entry.timestamps.length;
    const resetInMs = entry.timestamps[0] + this.windowMs - now;

    return {
      allowed: true,
      remaining,
      resetInMs: Math.max(resetInMs, 0),
    };
  }

  cleanup(): void {
    const now = Date.now();
    const windowStart = now - this.windowMs;

    for (const [key, entry] of this.entries.entries()) {
      entry.timestamps = entry.timestamps.filter((t) => t > windowStart);
      if (entry.timestamps.length === 0) {
        this.entries.delete(key);
      }
    }
  }

  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.entries.clear();
  }
}

export const rateLimiter = new RateLimiter();
