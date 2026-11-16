/**
 * ENG-2649: the router A/B's spend control. One budget file is shared by every run of the experiment (the no-tier
 * run, the Free run, the pilot and any resume), so its caps are global, not per output directory.
 *
 * Every paid LLM call is reserved BEFORE it is sent, at an upper bound (max of the call's own estimate and the
 * largest cost seen for that model), and settled after with what OpenRouter reported (prompt caching included). A
 * call whose reservation would pass the cap is never sent. A process that dies mid-call leaves its reservation
 * charged in full, so a crash can only over-count spend, never under-count it. A call that failed is charged its
 * reservation (what it was billed is unknown); a call that reports no cost is charged its reservation and stops the
 * run, because the cap cannot work blind.
 *
 * Only one process may hold a budget file at a time (`<file>.lock`).
 */
import { AsyncLocalStorage } from 'async_hooks';
import { randomUUID } from 'crypto';
import { appendFileSync, closeSync, existsSync, openSync, readFileSync, truncateSync, unlinkSync, writeSync } from 'fs';

export type BudgetKind = 'generation' | 'judge';

export class BudgetExceededError extends Error {
  readonly code = 'ROUTER_AB_BUDGET_EXCEEDED';
}

export class CostUnreportedError extends Error {
  readonly code = 'ROUTER_AB_COST_UNREPORTED';
}

/**
 * Reads a JSONL file written one line per append. A last line with no trailing newline that does not parse is the
 * remains of an interrupted write: it is cut off the file (so the next append starts on a clean line) and ignored.
 * A malformed line anywhere else is corruption and throws.
 */
export function readJsonlRepairing<T>(file: string, warn: (line: string) => void = (l) => console.warn(l)): T[] {
  if (!existsSync(file)) return [];
  const text = readFileSync(file, 'utf8');
  const lines = text.split('\n');
  const out: T[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      const isTail = i === lines.length - 1 && !text.endsWith('\n');
      if (!isTail) throw new Error(`${file}: line ${i + 1} is not valid JSON`);
      truncateSync(file, Buffer.byteLength(text, 'utf8') - Buffer.byteLength(line, 'utf8'));
      warn(`${file}: dropped a truncated last line (an interrupted write)`);
    }
  }
  return out;
}

interface CapsLine { t: 'caps'; generationUsd: number; judgeUsd: number; createdAt: string }
interface ReserveLine { t: 'reserve'; id: string; kind: BudgetKind; usd: number; label: string; outDir: string; at: string }
interface SettleLine { t: 'settle'; id: string; usd: number; outcome: 'reported' | 'error' | 'unreported'; at: string }
type Line = CapsLine | ReserveLine | SettleLine;

export class BudgetLedger {
  private readonly reservations = new Map<string, { kind: BudgetKind; reserved: number; settled?: number }>();

  private constructor(readonly file: string, readonly caps: { generationUsd: number; judgeUsd: number }, private lockFile?: string) {}

  /** Creates the budget file with its two global caps. Refuses to overwrite an existing one. */
  static init(file: string, caps: { generationUsd: number; judgeUsd: number }): void {
    for (const v of [caps.generationUsd, caps.judgeUsd]) {
      if (!Number.isFinite(v) || v <= 0) throw new Error('budget caps must be positive USD amounts');
    }
    const fd = openSync(file, 'wx');
    try {
      const line: CapsLine = { t: 'caps', ...caps, createdAt: new Date().toISOString() };
      writeSync(fd, `${JSON.stringify(line)}\n`);
    } finally {
      closeSync(fd);
    }
  }

  /** Opens an existing budget file. `lock` (default true) takes `<file>.lock` so no second process can spend from it. */
  static open(file: string, { lock = true }: { lock?: boolean } = {}): BudgetLedger {
    if (!existsSync(file)) throw new Error(`${file} not found: create it with the budget command first`);
    let lockFile: string | undefined;
    if (lock) {
      lockFile = `${file}.lock`;
      let fd: number;
      try {
        fd = openSync(lockFile, 'wx');
      } catch {
        throw new Error(`${lockFile} exists: another run holds this budget. If no run is active, delete the lock file.`);
      }
      writeSync(fd, String(process.pid));
      closeSync(fd);
    }
    try {
      const lines = readJsonlRepairing<Line>(file);
      const caps = lines[0];
      if (!caps || caps.t !== 'caps') throw new Error(`${file} does not start with a caps line`);
      const ledger = new BudgetLedger(file, { generationUsd: caps.generationUsd, judgeUsd: caps.judgeUsd }, lockFile);
      for (const line of lines.slice(1)) ledger.apply(line);
      return ledger;
    } catch (error) {
      if (lockFile) unlinkSync(lockFile);
      throw error;
    }
  }

  private apply(line: Line): void {
    if (line.t === 'reserve') this.reservations.set(line.id, { kind: line.kind, reserved: line.usd });
    else if (line.t === 'settle') {
      const r = this.reservations.get(line.id);
      if (r) r.settled = line.usd;
    }
  }

  private append(line: Line): void {
    appendFileSync(this.file, `${JSON.stringify(line)}\n`);
    this.apply(line);
  }

  cap(kind: BudgetKind): number {
    return kind === 'generation' ? this.caps.generationUsd : this.caps.judgeUsd;
  }

  /** Settled calls at what they cost, unsettled reservations at their full reservation. */
  spent(kind: BudgetKind): number {
    let sum = 0;
    for (const r of this.reservations.values()) if (r.kind === kind) sum += r.settled ?? r.reserved;
    return sum;
  }

  remaining(kind: BudgetKind): number {
    return this.cap(kind) - this.spent(kind);
  }

  /** Records a reservation, or throws BudgetExceededError (writing nothing) when it would pass the cap. */
  reserve(kind: BudgetKind, usd: number, label: string, outDir: string): string {
    if (!(usd >= 0)) throw new Error(`invalid reservation ${usd}`);
    if (this.spent(kind) + usd > this.cap(kind)) {
      throw new BudgetExceededError(
        `${kind} budget: reserving $${usd.toFixed(4)} for ${label} would pass the cap ($${this.spent(kind).toFixed(2)} of $${this.cap(kind).toFixed(2)} spent)`,
      );
    }
    const id = randomUUID();
    this.append({ t: 'reserve', id, kind, usd, label, outDir, at: new Date().toISOString() });
    return id;
  }

  settle(id: string, usd: number, outcome: SettleLine['outcome']): void {
    if (!this.reservations.has(id)) throw new Error(`unknown reservation ${id}`);
    this.append({ t: 'settle', id, usd, outcome, at: new Date().toISOString() });
  }

  close(): void {
    if (this.lockFile && existsSync(this.lockFile)) unlinkSync(this.lockFile);
    this.lockFile = undefined;
  }
}

export interface MeteredCall {
  model: string;
  costUsd: number;
  outcome: 'reported' | 'error' | 'unreported';
  feature?: string;
}

interface Scope {
  label: string;
  calls: MeteredCall[];
  pending: Set<Promise<unknown>>;
}

/**
 * Meters every paid call through one ledger. `scoped` attributes the calls made inside it (including ones started
 * inside but still running when it returns: it waits for them) to one run or judged pair.
 */
export class CostMeter {
  private readonly als = new AsyncLocalStorage<Scope>();
  private readonly largest = new Map<string, number>();
  /** Set once spending must stop (cap reached or a cost not reported); every later call is refused. */
  fatal?: BudgetExceededError | CostUnreportedError;

  constructor(
    private readonly ledger: BudgetLedger,
    private readonly kind: BudgetKind,
    private readonly outDir: string,
    private readonly costOf: (response: any) => number | undefined,
  ) {}

  /** The largest cost seen so far for a model (0 before the first call). */
  largestSeen(model: string): number {
    return this.largest.get(model) ?? 0;
  }

  meter<T>(model: string, upperBoundUsd: number, send: () => Promise<T>, feature?: string): Promise<T> {
    if (this.fatal) return Promise.reject(this.fatal);
    const scope = this.als.getStore();
    const reserveUsd = Math.max(upperBoundUsd, this.largestSeen(model));
    let id: string;
    try {
      id = this.ledger.reserve(this.kind, reserveUsd, `${scope?.label ?? 'unscoped'} ${model}`, this.outDir);
    } catch (error) {
      if (error instanceof BudgetExceededError) this.fatal = error;
      return Promise.reject(error);
    }
    const record = (call: MeteredCall) => scope?.calls.push(call);
    const promise = (async () => {
      let response: T;
      try {
        response = await send();
      } catch (error) {
        this.ledger.settle(id, reserveUsd, 'error');
        record({ model, costUsd: reserveUsd, outcome: 'error', ...(feature ? { feature } : {}) });
        throw error;
      }
      const usd = this.costOf(response);
      if (usd === undefined) {
        this.ledger.settle(id, reserveUsd, 'unreported');
        record({ model, costUsd: reserveUsd, outcome: 'unreported', ...(feature ? { feature } : {}) });
        this.fatal = new CostUnreportedError(`OpenRouter reported no cost for a ${model} call; stopping, since the cap cannot work blind`);
        throw this.fatal;
      }
      this.ledger.settle(id, usd, 'reported');
      this.largest.set(model, Math.max(this.largestSeen(model), usd));
      record({ model, costUsd: usd, outcome: 'reported', ...(feature ? { feature } : {}) });
      return response;
    })();
    if (scope) {
      scope.pending.add(promise);
      promise.then(() => scope.pending.delete(promise), () => scope.pending.delete(promise));
    }
    return promise;
  }

  async scoped<T>(label: string, fn: () => Promise<T>): Promise<{ result?: T; error?: unknown; calls: MeteredCall[] }> {
    const scope: Scope = { label, calls: [], pending: new Set() };
    let result: T | undefined;
    let error: unknown;
    try {
      result = await this.als.run(scope, fn);
    } catch (e) {
      error = e;
    }
    while (scope.pending.size > 0) await Promise.allSettled([...scope.pending]);
    return { ...(error === undefined ? { result } : { error }), calls: scope.calls };
  }
}

/** What a run cost: its calls with a reported cost (a failed call's reservation is budget, not a price). */
export function reportedCostUsd(calls: readonly MeteredCall[]): number {
  return calls.filter((c) => c.outcome === 'reported').reduce((s, c) => s + c.costUsd, 0);
}
