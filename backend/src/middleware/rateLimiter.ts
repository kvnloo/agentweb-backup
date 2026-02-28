interface RateLimitEntry {
  timestamps: number[];
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

  constructor(cleanupIntervalMs: number = 60000) {
    this.cleanupInterval = setInterval(() => this.cleanup(), cleanupIntervalMs);
  }

  check(key: string, maxPerMinute: number): RateLimitResult {
    const now = Date.now();
    const windowStart = now - this.windowMs;

    let entry = this.entries.get(key);
    if (!entry) {
      entry = { timestamps: [] };
      this.entries.set(key, entry);
    }

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
