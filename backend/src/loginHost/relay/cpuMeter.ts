/**
 * ENG-2113 (final security review): the login host is ONE event loop shared by every customer, and a hostile unit spends it through whatever it controls: bytes,
 * lines, values, reads, events, frames. Accounting per vector (one bucket each) kept leaving the next vector open. This is the unified accounting: a token bucket
 * measured in MILLISECONDS OF EVENT-LOOP CPU TIME, per turn. Everything that processes a hostile unit's bytes or events on the host runs inside `meter.time(...)`, and the
 * real elapsed time of that synchronous section is what is charged, whatever made it expensive.
 *
 * Numbers. Burst 1000 ms, refill 50 ms per second (5% of the loop). History: 2,000 ms until eight concurrent turns each spent their burst on expensive-but-valid lines and
 * pinned the loop for 26 s; 500 ms after that, charged by WALL time, which a busy machine inflates (descheduling counts as time spent): under CPU contention honest
 * 12 MB echoes were charged 2-3x their CPU time and 5 of them in a row were killed. Now a section is charged min(wall, the thread's CPU time) and the burst is 1000 ms.
 * Measured with real child processes on a loaded 12-core machine (load average 3-22): a 12 MB echo is ~50-110 ms of CPU, five in a row ~300 ms (23-55% of the burst, the
 * high end with a CPU-hungry process pinned to the same core), three 15 MB echoes ~250-370 ms, ten 6 MB echoes ~300-430 ms.
 * The worst legal string, 12 MiB where every other character is escaped (a body of quote characters), is ~520 ms of CPU: one is survived (41-67% of the burst, idle or
 * with 1-3 pinned competitors), two in a row are not (the old wall-clock 500 ms meter killed even one). The real CLI cannot produce it (`--tools ""`, MCP output cap).
 *  - an honest turn is a few thousand tiny events (about 0.05-0.2 ms each) over minutes plus the odd big tool result echoed once: a few of those fit the burst, and the
 *    refill covers the small events many times over;
 *  - a hostile turn can take 1 s of loop once and 5% of it afterwards before it is killed (`cpu_budget`). CAPACITY: it takes 20 concurrent hostile turns, each running
 *    flat out at its allowance, to use the whole loop. The per-vector buckets stay as cheap early filters in front of this.
 *  - cost of metering itself: ~1 us per empty section, plus ~3 us for the thread-CPU reading taken at the start of a section (the end reading is skipped for sections of
 *    FAST_SECTION_MS or less), measured; at most a few hundred sections a second per stream are admitted by the read buckets.
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

export const CPU_BURST_MS = 1000;
export const CPU_REFILL_MS_PER_SEC = 50;
/** A section shorter than this is charged its wall time without a CPU reading (a reading costs ~6.5 us; tiny events and one-byte reads are the hot path). */
export const FAST_SECTION_MS = 1;

const DEFAULT_NOW = (): number => performance.now();
/**
 * CPU time of the thread that runs the event loop, in ms. A section is charged min(wall, this): wall time includes the time the thread was not running (descheduled by a
 * busy machine, preempted), which is not the unit's doing and used to double the charge of an honest 12 MB echo under CPU contention. (process.threadCpuUsage exists on
 * Node 22.19+; before that, the whole process's CPU time, which can only be larger, so the charge is then never lower than the thread's.)
 */
const REAL_CPU_MS: () => number = (() => {
  const p = process as unknown as { threadCpuUsage?: () => { user: number; system: number } };
  const read = typeof p.threadCpuUsage === "function" ? () => p.threadCpuUsage!() : () => process.cpuUsage();
  return () => {
    const u = read();
    return (u.user + u.system) / 1000;
  };
})();

export class CpuMeter {
  private tokens: number;
  private last: number;
  private depth = 0;
  private spent = false;
  private readonly listeners: Array<() => void> = [];
  constructor(
    private readonly burstMs = CPU_BURST_MS,
    private readonly refillMsPerSec = CPU_REFILL_MS_PER_SEC,
    readonly now: () => number = DEFAULT_NOW,
    /** CPU time in ms. Default: the real thread CPU time with the real clock, and the clock itself (so wall = CPU, deterministic) when a custom clock is given. */
    cpu?: () => number,
  ) {
    this.tokens = burstMs;
    this.last = this.now();
    this.cpu = cpu ?? (now === DEFAULT_NOW ? REAL_CPU_MS : now);
  }
  private readonly cpu: () => number;
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
  /**
   * Runs `fn` and charges the OUTERMOST call: min(wall time, CPU time of the thread) of the section. The result and any exception pass through. Never more than the
   * wall time (what it charged before), and no more than the CPU the section really used: a loop descheduled by a busy machine is not charged for the wait.
   */
  time<T>(fn: () => T): T {
    if (this.depth > 0) return fn();
    this.depth++;
    const t0 = this.now();
    const c0 = this.cpu();
    try {
      return fn();
    } finally {
      this.depth--;
      const wall = this.now() - t0;
      this.charge(wall <= FAST_SECTION_MS ? wall : Math.min(wall, Math.max(0, this.cpu() - c0)));
    }
  }
}
