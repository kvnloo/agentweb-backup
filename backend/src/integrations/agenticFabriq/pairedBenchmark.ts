/** Below-LLM experiment runner. No credentials, network clients, or result payloads in its report. */
import { performance } from 'node:perf_hooks';

type Action = 'search' | 'list' | 'get';
type Arm = 'direct' | 'vendor';
type Cache = 'cold' | 'warm';
type Stage = 'prepare' | 'authorize' | 'token' | 'discovery' | 'transport' | 'normalize';
const STAGES: Stage[] = ['prepare', 'authorize', 'token', 'discovery', 'transport', 'normalize'];
export interface BenchmarkContext {
  /** Await every stage. Arbitrary labels are refused to keep identifiers out of telemetry. */
  stage<T>(name: Stage, work: () => Promise<T>): Promise<T>;
}
export interface BenchmarkAdapter {
  /** Reset all caches for this arm and fixture. Must not call an LLM or perform writes. */
  prepare(action: Action): Promise<void>;
  /** Fixed read-only fixture inputs live in the adapter closure, never in output. */
  execute(action: Action, context: BenchmarkContext): Promise<unknown>;
}
export interface BenchmarkOptions {
  samples: number;
  actions: Action[];
  adapters: Record<Arm, BenchmarkAdapter>;
  /** Compare canonical read semantics in memory; never persist values or hashes of content. */
  equivalent(direct: unknown, vendor: unknown, action: Action): boolean;
  now?: () => number;
}
interface Attempt {
  pair: number;
  action: Action;
  cache: Cache;
  arm: Arm;
  phase: 'warmup' | 'measured';
  status: 'ok' | 'failed';
  failedStage?: Stage | 'execute' | 'warmup';
  executed: boolean;
  durationMs: number;
  stages: Partial<Record<Stage, number>>;
}
interface Pair {
  pair: number;
  action: Action;
  cache: Cache;
  order: 'AB' | 'BA';
  equivalence: 'equivalent' | 'different' | 'inconclusive';
}

/** Nearest-rank percentiles. 100 observations is only a minimum resolution for p99, not confidence. */
export function summarizeDurations(durations: number[]) {
  const values = [...durations].sort((a, b) => a - b);
  const percentile = (p: number) => values.length ? values[Math.ceil(p * values.length) - 1] : null;
  return {
    attempts: values.length,
    p50: percentile(0.5),
    p95: percentile(0.95),
    p99: values.length >= 100
      ? { status: 'measured' as const, value: percentile(0.99) }
      : { status: 'inconclusive' as const, minimumSamples: 100 },
  };
}

export async function runPairedBenchmark(options: BenchmarkOptions) {
  if (!Number.isInteger(options.samples) || options.samples < 1 || options.samples > 10_000 ||
      !Array.isArray(options.actions) || !options.actions.length || options.actions.length > 3 ||
      new Set(options.actions).size !== options.actions.length ||
      options.actions.some(action => !['search', 'list', 'get'].includes(action)) ||
      typeof options.equivalent !== 'function') throw new Error('Invalid benchmark configuration');
  const now = options.now ?? (() => performance.now());
  const attempts: Attempt[] = [];
  const pairs: Pair[] = [];
  let pairId = 0;
  for (const action of options.actions) for (const cache of ['cold', 'warm'] as const) {
    for (let sample = 0; sample < options.samples; sample++) {
      const pair = pairId++;
      const order: Arm[] = sample % 2 === 0 ? ['direct', 'vendor'] : ['vendor', 'direct'];
      const values: Partial<Record<Arm, { ok: boolean; value?: unknown }>> = {};
      for (const arm of order) {
        const adapter = options.adapters[arm];
        let prepared = true;
        for (const phase of cache === 'warm' ? ['warmup', 'measured'] as const : ['measured'] as const) {
          const started = now();
          const record: Attempt = { pair, action, cache, arm, phase, status: 'failed', executed: false, durationMs: 0, stages: {} };
          const context: BenchmarkContext = {
            async stage<T>(name: Stage, work: () => Promise<T>): Promise<T> {
              if (!STAGES.includes(name)) throw new Error('Invalid benchmark stage');
              const start = now();
              try { return await work(); }
              catch (error) { record.failedStage = name; throw error; }
              finally { record.stages[name] = (record.stages[name] ?? 0) + Math.max(0, now() - start); }
            },
          };
          try {
            // Each cold attempt starts reset; each warm attempt follows a recorded primer.
            if (phase === 'warmup' || cache === 'cold') await context.stage('prepare', () => adapter.prepare(action));
            if (!prepared) { record.failedStage = 'warmup'; throw new Error('Preparation failed'); }
            record.executed = true;
            const value = await adapter.execute(action, context);
            record.status = 'ok';
            if (phase === 'measured') values[arm] = { ok: true, value };
          } catch {
            record.failedStage ??= 'execute';
            if (phase === 'warmup') prepared = false;
            if (phase === 'measured') values[arm] = { ok: false };
          } finally {
            record.durationMs = Math.max(0, now() - started);
            attempts.push(record);
          }
        }
      }
      let equivalence: Pair['equivalence'] = 'inconclusive';
      if (values.direct?.ok && values.vendor?.ok) {
        try {
          const equivalent = options.equivalent(values.direct.value, values.vendor.value, action);
          if (typeof equivalent === 'boolean') equivalence = equivalent ? 'equivalent' : 'different';
        } catch { /* Comparator failures cannot manufacture successful semantic evidence. */ }
      }
      pairs.push({ pair, action, cache, order: sample % 2 === 0 ? 'AB' : 'BA', equivalence });
    }
  }
  const summaries = options.actions.flatMap(action => (['cold', 'warm'] as const).flatMap(cache =>
    (['direct', 'vendor'] as const).map(arm => {
      const selected = attempts.filter(a => a.phase === 'measured' && a.action === action && a.cache === cache && a.arm === arm);
      const executionAttempts = selected.filter(a => a.executed).length;
      const distribution = summarizeDurations(selected.map(a => a.durationMs));
      return { action, cache, arm, failures: selected.filter(a => a.status === 'failed').length,
        executionAttempts, ...distribution, p99: executionAttempts >= 100 ? distribution.p99
          : { status: 'inconclusive' as const, minimumSamples: 100 } };
    })));
  return { samplesPerStratum: options.samples, attempts, pairs, summaries };
}
