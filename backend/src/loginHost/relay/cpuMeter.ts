/**
 * ENG-2113 (final security review): the login host is ONE event loop shared by every customer, and a hostile unit spends it through whatever it controls: bytes,
 * lines, values, reads, events, frames. Accounting per vector (one bucket each) kept leaving the next vector open. This is the unified accounting: a token bucket
 * measured in MILLISECONDS OF EVENT-LOOP TIME, per turn. Everything that processes a hostile unit's bytes or events on the host runs inside `meter.time(...)`, and the
 * real elapsed time of that synchronous section is what is charged, whatever made it expensive.
 *
 * Numbers. Burst 2,000 ms, refill 50 ms per second (5% of the loop):
 *  - an honest turn is a few thousand tiny events (about 0.05-0.2 ms each) over minutes plus the odd big tool result echoed once (an 8-12 MB line costs roughly
 *    100-300 ms to scan, parse and normalize): a few of those fit the burst, and the refill covers the small events many times over;
 *  - a hostile turn can therefore take 2 s of loop once and 5% of it afterwards before it is killed (`cpu_budget`). CAPACITY: it takes 20 concurrent hostile turns,
 *    each running flat out at its allowance, to use the whole loop, and every one of them is killed once its burst is spent (about 2 s at full speed, longer when it
 *    paces itself at the refill). The per-vector buckets stay as cheap early filters in front of this; they are no longer the only line of defence.
 *
 * `time()` nests safely: only the OUTERMOST call charges, so a section measured around `push()` (which synchronously runs readline, the runner's JSON.parse and the
 * session's callbacks) is not charged again by the callbacks it contains.
 */
import { performance } from "perf_hooks";

/** A refilling token bucket. `take(n)` is false when the bucket cannot pay (and then pays nothing). The clock is read per call (tests mock it). */
export class TokenBucket {
  private tokens: number;
  private last: number;
  constructor(
    private readonly burst: number,
    private readonly perSec: number,
    private readonly now: () => number = () => performance.now(),
  ) {
    this.tokens = burst;
    this.last = this.now();
  }
  private refill(): void {
    const t = this.now();
    this.tokens = Math.min(this.burst, this.tokens + (Math.max(0, t - this.last) / 1000) * this.perSec);
    this.last = t;
  }
  take(n = 1): boolean {
    this.refill();
    if (this.tokens < n) return false;
    this.tokens -= n;
    return true;
  }
}

export const CPU_BURST_MS = 2000;
export const CPU_REFILL_MS_PER_SEC = 50;

export class CpuMeter {
  private tokens: number;
  private last: number;
  private depth = 0;
  private spent = false;
  private readonly listeners: Array<() => void> = [];
  constructor(
    private readonly burstMs = CPU_BURST_MS,
    private readonly refillMsPerSec = CPU_REFILL_MS_PER_SEC,
    readonly now: () => number = () => performance.now(),
  ) {
    this.tokens = burstMs;
    this.last = this.now();
  }
  /** Milliseconds left (for tests and diagnostics). */
  get remaining(): number {
    return this.tokens;
  }
  /** True once the budget has run out (stays true: a turn that spent it is over). */
  get exhausted(): boolean {
    return this.spent;
  }
  /** Called once, when the budget runs out. */
  onExhausted(fn: () => void): void {
    this.listeners.push(fn);
  }
  /** Charges `ms` of loop time directly (for work measured elsewhere, and for tests). */
  charge(ms: number): void {
    if (this.spent) return;
    const t = this.now();
    this.tokens = Math.min(this.burstMs, this.tokens + (Math.max(0, t - this.last) / 1000) * this.refillMsPerSec) - Math.max(0, ms);
    this.last = t;
    if (this.tokens < 0) {
      this.spent = true;
      for (const fn of this.listeners.splice(0)) {
        try {
          fn();
        } catch {
          /* a failing listener must not stop the others (or become an uncaught exception) */
        }
      }
    }
  }
  /** Runs `fn` and charges the real elapsed time of the OUTERMOST call. The result and any exception pass through. */
  time<T>(fn: () => T): T {
    if (this.depth > 0) return fn();
    this.depth++;
    const t0 = this.now();
    try {
      return fn();
    } finally {
      this.depth--;
      this.charge(this.now() - t0);
    }
  }
}
