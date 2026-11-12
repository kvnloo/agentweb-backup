/**
 * ENG-2946: PublicRateLimitStore port for anonymous public endpoints
 * (lead-magnet execute today). The in-memory implementation reproduces the
 * pre-port module-scoped Maps exactly. A durable cross-instance implementation
 * (conditional `ADD count`) is the parent ENG-1755 and is data-plane gated —
 * it must only need to implement this interface.
 */
import { createHash } from 'crypto';

export interface RateLimitResult {
  allowed: boolean;
  /** Events counted in the window after this call. */
  count: number;
}

export interface PublicRateLimitStore {
  /** Atomic check-and-increment: records an event only when under `cap`. */
  consume(key: string, cap: number, windowMs: number): Promise<RateLimitResult>;
  /** Non-mutating check: would another event be allowed? */
  check(key: string, cap: number, windowMs: number): Promise<RateLimitResult>;
  /** Unconditionally record one event for `key`. */
  record(key: string, windowMs: number): Promise<void>;
}

/** Hash an email so rate-limit keys never carry raw PII. */
export function emailRateLimitKey(email: string): string {
  return `email:${createHash('sha256').update(email.trim().toLowerCase()).digest('hex')}`;
}

export function ipRateLimitKey(ip: string): string {
  return `ip:${ip}`;
}

export class InMemoryPublicRateLimitStore implements PublicRateLimitStore {
  private readonly events = new Map<string, number[]>();

  constructor(private readonly now: () => number = Date.now) {}

  private recent(key: string, windowMs: number): number[] {
    const cutoff = this.now() - windowMs;
    const recent = (this.events.get(key) || []).filter((t) => t > cutoff);
    if (recent.length) this.events.set(key, recent);
    else this.events.delete(key);
    return recent;
  }

  async check(key: string, cap: number, windowMs: number): Promise<RateLimitResult> {
    const count = this.recent(key, windowMs).length;
    return { allowed: count < cap, count };
  }

  async record(key: string, windowMs: number): Promise<void> {
    const recent = this.recent(key, windowMs);
    recent.push(this.now());
    this.events.set(key, recent);
  }

  async consume(key: string, cap: number, windowMs: number): Promise<RateLimitResult> {
    // Synchronous body: no await between read and write, so this is atomic in-process.
    const recent = this.recent(key, windowMs);
    if (recent.length >= cap) return { allowed: false, count: recent.length };
    recent.push(this.now());
    this.events.set(key, recent);
    return { allowed: true, count: recent.length };
  }

  /** Drop expired events for every key (bounded memory). */
  prune(windowMs: number): void {
    for (const key of Array.from(this.events.keys())) this.recent(key, windowMs);
  }

  clear(): void {
    this.events.clear();
  }

  keys(): string[] {
    return Array.from(this.events.keys());
  }
}
