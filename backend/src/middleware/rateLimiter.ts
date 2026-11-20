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
  // Incremental eviction state (ENG-1768): the full-map scan in
  // findEvictionCandidate filtered every entry's timestamps on each
  // over-capacity request — O(n) timestamp checks per call, ~250k at the
  // 50k default cap under an all-blocked flood. Instead, check() maintains
  // an insertion-ordered queue of non-blocked keys; the head is always a
  // safe eviction candidate, so the all-blocked case only needs a cheap
  // head-validity walk instead of a full timestamp filter.
  // Invariant: every key in evictQueue is present in entries (stale heads
  // are skipped lazily at eviction time).
  private evictQueue: string[] = [];
  private evictQueueHeads: Set<string> = new Set();
  // Head offset into evictQueue (ENG-1768 follow-up): heads are removed by
  // advancing this index instead of Array.shift(), which would reindex the
  // whole array per removal — O(N^2) to drain N heads under flood. The
  // consumed prefix is compacted away once it grows large (amortized O(1)).
  private evictQueueHead = 0;
  // Block-expiry records (ENG-1768 CodeRabbit follow-up): when check()
  // rejects a key as blocked, its window-expiry (oldest in-window timestamp
  // + windowMs) is recorded here. findEvictionCandidate promotes only keys
  // whose recorded expiry has passed instead of scanning every entry's
  // timestamps per eviction — a full-map sweep here restored O(n) work per
  // request under a sustained distinct-key flood at capacity. A watermark
  // (nextUnblockAt) skips the promotion scan entirely until some recorded
  // key can actually have expired, so the common case stays O(1).
  private blockedUntil: Map<string, number> = new Map();
  private nextUnblockAt = Infinity;

  // Removes the current queue head, compacting the consumed prefix when it
  // grows large enough that slicing pays for itself. Callers must also
  // evictQueueHeads.delete(key) for the removed head.
  private shiftEvictQueue(): void {
    this.evictQueueHead++;
    if (this.evictQueueHead >= this.evictQueue.length) {
      this.evictQueue = [];
      this.evictQueueHead = 0;
    } else if (
      this.evictQueueHead >= 1024 &&
      this.evictQueueHead * 2 >= this.evictQueue.length
    ) {
      this.evictQueue = this.evictQueue.slice(this.evictQueueHead);
      this.evictQueueHead = 0;
    }
  }

  // `windowMs` defaults to one minute, so every existing caller keeps its
  // per-minute meaning. A caller that needs a longer window (ENG-3163: sends
  // per hour) passes it here; the `maxPerMinute` argument of check() is then
  // the maximum per that window.
  constructor(cleanupIntervalMs: number = 60000, maxEntries: number = 50000, windowMs: number = 60000) {
    if (Number.isFinite(windowMs) && windowMs > 0) this.windowMs = windowMs;
    this.cleanupInterval = setInterval(() => this.cleanup(), cleanupIntervalMs);
    // Only enable bounded storage for a valid positive integer cap; an
    // invalid value (non-finite, non-integer, <= 0) falls back to the
    // default rather than silently disabling or corrupting eviction.
    this.maxEntries =
      Number.isInteger(maxEntries) && maxEntries > 0 ? maxEntries : 50000;
  }

  /**
   * Picks a key safe to evict at capacity, in priority order:
   *   1. The head of the incremental non-blocked queue (a key that was
   *      idle or under-limit when last checked) — O(1) amortized, with a
   *      cheap lazy skip over stale/already-evicted heads.
   *   2. Blocked keys whose recorded window-expiry has passed are promoted
   *      back into the queue first (no timestamp filtering — expiry was
   *      recorded when the key was last rejected). Only keys in
   *      `blockedUntil` are ever examined, and only once the `nextUnblockAt`
   *      watermark says at least one can have expired.
   *   3. Only if no unblocked key is known (every tracked key currently
   *      blocked) fall back to the oldest insertion — still bounds memory,
   *      and this case requires >= maxEntries simultaneously-blocked
   *      distinct keys, an extreme flood scenario where evicting one
   *      blocked key slightly early is an acceptable trade against
   *      unbounded growth.
   * The caller re-queues keys that transition back to non-blocked, so the
   * queue never goes permanently stale while non-blocked keys exist.
   */
  private findEvictionCandidate(now: number): string | undefined {
    // Cheap promotion: only recorded-blocked keys can re-qualify, and only
    // once the watermark says at least one expiry may have passed. No
    // full-map scan of entries — under a sustained distinct-key flood this
    // path runs per request at capacity.
    if (now >= this.nextUnblockAt && this.blockedUntil.size > 0) {
      let next = Infinity;
      for (const [key, unblockAt] of this.blockedUntil) {
        if (now < unblockAt) {
          if (unblockAt < next) next = unblockAt;
          continue;
        }
        this.blockedUntil.delete(key);
        if (!this.evictQueueHeads.has(key) && this.entries.has(key)) {
          this.evictQueue.push(key);
          this.evictQueueHeads.add(key);
        }
      }
      this.nextUnblockAt = next;
    }
    while (this.evictQueueHead < this.evictQueue.length) {
      const key = this.evictQueue[this.evictQueueHead];
      const entry = this.entries.get(key);
      if (!entry) {
        // Stale head: key already evicted — drop and continue.
        this.shiftEvictQueue();
        this.evictQueueHeads.delete(key);
        continue;
      }
      const windowStart = now - this.windowMs;
      const activeCount = entry.timestamps.filter((t) => t > windowStart).length;
      if (activeCount === 0 || activeCount < entry.lastMax) {
        return key; // idle or under-limit — safe to evict immediately
      }
      // Head is currently blocked; drop it from the queue (promotion above
      // re-queues it once its recorded expiry passes) and keep walking —
      // this walk only visits keys once per state change, never the full
      // timestamp volume per call.
      this.shiftEvictQueue();
      this.evictQueueHeads.delete(key);
    }
    // Every tracked key is currently blocked: fall back to oldest insertion.
    const oldest = this.entries.keys().next();
    return oldest.done ? undefined : oldest.value;
  }

  private trackEvictable(key: string): void {
    if (!this.evictQueueHeads.has(key)) {
      this.evictQueue.push(key);
      this.evictQueueHeads.add(key);
    }
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
          this.evictQueueHeads.delete(evictKey);
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
      // Record when this key's current window expires so eviction can
      // promote it back as a candidate without scanning all entries'
      // timestamps on each at-capacity request. Only recorded keys are
      // ever scanned, gated by the nextUnblockAt watermark.
      const unblockAt = oldestInWindow + this.windowMs;
      this.blockedUntil.set(key, unblockAt);
      if (unblockAt < this.nextUnblockAt) this.nextUnblockAt = unblockAt;
      return {
        allowed: false,
        remaining: 0,
        resetInMs: Math.max(resetInMs, 0),
      };
    }

    entry.timestamps.push(now);
    // Key just proved itself non-blocked — keep it available as a future
    // eviction candidate so the queue never drains while such keys exist.
    // Any stale block-expiry record for it is now wrong; drop it so the
    // promotion pass never re-queues a key that just changed state.
    this.blockedUntil.delete(key);
    this.trackEvictable(key);
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
        this.blockedUntil.delete(key);
      }
    }
  }

  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.entries.clear();
    this.evictQueue = [];
    this.evictQueueHead = 0;
    this.evictQueueHeads.clear();
    this.blockedUntil.clear();
    this.nextUnblockAt = Infinity;
  }
}

export const rateLimiter = new RateLimiter();
