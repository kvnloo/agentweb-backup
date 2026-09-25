/**
 * Judge-vs-human agreement metrics (ENG-2136, ENG-2128 principles 2 and 4).
 *
 * Pure functions: callers pass paired labels (human truth, grader prediction) from a golden set
 * and get back Cohen's kappa, per-class precision/recall, and confidence intervals with n.
 * `toGraderValidation` turns a result into the `validation` record the eval registry
 * (evalRegistry.ts) reads through `mayGate`.
 */

/** Same shape as the eval registry's `GraderValidation` (evalRegistry.ts), kept structural so this
 * module has no dependency on the registry. */
export interface ValidationRecord {
  kappa: number;
  n: number;
  date: string;
  evidence: string;
}

export interface LabelPair<L extends string | number = string> {
  truth: L;
  predicted: L;
}

export interface Interval {
  low: number;
  high: number;
}

export interface ClassMetrics {
  precision: number | null;
  recall: number | null;
  f1: number | null;
  /** Cases whose human label is this class. */
  support: number;
}

export interface AgreementReport {
  n: number;
  observedAgreement: number;
  kappa: number;
  kappaCI: Interval;
  perClass: Record<string, ClassMetrics>;
}

const Z_95 = 1.959963984540054;

/** Wilson score interval for a proportion (default 95%). */
export function wilsonInterval(successes: number, n: number, z: number = Z_95): Interval {
  if (!Number.isInteger(n) || n <= 0) throw new Error('wilsonInterval: n must be a positive integer');
  if (successes < 0 || successes > n) throw new Error('wilsonInterval: successes must be within [0, n]');
  const p = successes / n;
  const denom = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const half = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return { low: Math.max(0, (centre - half) / denom), high: Math.min(1, (centre + half) / denom) };
}

function assertPairs<L extends string | number>(pairs: ReadonlyArray<LabelPair<L>>): void {
  if (pairs.length === 0) throw new Error('agreement: at least one labelled pair is required');
}

/** Unweighted Cohen's kappa for nominal labels. Returns 1 when both raters use a single identical class. */
export function cohensKappa<L extends string | number>(pairs: ReadonlyArray<LabelPair<L>>): number {
  assertPairs(pairs);
  const n = pairs.length;
  const truthCounts = new Map<L, number>();
  const predCounts = new Map<L, number>();
  let agree = 0;
  for (const { truth, predicted } of pairs) {
    if (truth === predicted) agree++;
    truthCounts.set(truth, (truthCounts.get(truth) ?? 0) + 1);
    predCounts.set(predicted, (predCounts.get(predicted) ?? 0) + 1);
  }
  const po = agree / n;
  let pe = 0;
  for (const [label, count] of truthCounts) pe += (count / n) * ((predCounts.get(label) ?? 0) / n);
  if (pe === 1) return po === 1 ? 1 : 0;
  return (po - pe) / (1 - pe);
}

/**
 * Weighted kappa for ordinal labels on an integer scale [min, max] (e.g. 1-5 judge scores).
 * `quadratic` penalises large disagreements more than `linear`.
 */
export function weightedKappa(
  pairs: ReadonlyArray<LabelPair<number>>,
  scale: { min: number; max: number },
  weights: 'linear' | 'quadratic' = 'quadratic',
): number {
  assertPairs(pairs);
  const k = scale.max - scale.min + 1;
  if (!Number.isInteger(scale.min) || !Number.isInteger(scale.max) || k < 2) {
    throw new Error('weightedKappa: scale must be integers with max > min');
  }
  const n = pairs.length;
  const observed = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  const rowTotals = new Array<number>(k).fill(0);
  const colTotals = new Array<number>(k).fill(0);
  for (const { truth, predicted } of pairs) {
    const i = truth - scale.min;
    const j = predicted - scale.min;
    if (!Number.isInteger(i) || !Number.isInteger(j) || i < 0 || j < 0 || i >= k || j >= k) {
      throw new Error(`weightedKappa: label out of scale (${truth}, ${predicted})`);
    }
    observed[i][j]++;
    rowTotals[i]++;
    colTotals[j]++;
  }
  const w = (i: number, j: number) => {
    const d = Math.abs(i - j) / (k - 1);
    return weights === 'quadratic' ? d * d : d;
  };
  let num = 0;
  let den = 0;
  for (let i = 0; i < k; i++) {
    for (let j = 0; j < k; j++) {
      num += w(i, j) * observed[i][j];
      den += (w(i, j) * rowTotals[i] * colTotals[j]) / n;
    }
  }
  if (den === 0) return num === 0 ? 1 : 0;
  return 1 - num / den;
}

/** Precision/recall/F1 per class, treating the human label as truth. null when undefined (0/0). */
export function perClassMetrics<L extends string | number>(
  pairs: ReadonlyArray<LabelPair<L>>,
): Record<string, ClassMetrics> {
  assertPairs(pairs);
  const classes = new Set<L>();
  for (const { truth, predicted } of pairs) {
    classes.add(truth);
    classes.add(predicted);
  }
  const out: Record<string, ClassMetrics> = {};
  for (const c of classes) {
    let tp = 0;
    let fp = 0;
    let fn = 0;
    for (const { truth, predicted } of pairs) {
      if (predicted === c && truth === c) tp++;
      else if (predicted === c) fp++;
      else if (truth === c) fn++;
    }
    const precision = tp + fp === 0 ? null : tp / (tp + fp);
    const recall = tp + fn === 0 ? null : tp / (tp + fn);
    // Count form: defined whenever the class occurs at all, so a class the grader always gets
    // wrong scores 0 rather than looking like "no data".
    const f1 = 2 * tp + fp + fn === 0 ? null : (2 * tp) / (2 * tp + fp + fn);
    out[String(c)] = { precision, recall, f1, support: tp + fn };
  }
  return out;
}

/** Deterministic PRNG so a reported CI is reproducible from the same data and seed. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Percentile bootstrap CI for any pair statistic (default: Cohen's kappa). */
export function bootstrapCI<L extends string | number>(
  pairs: ReadonlyArray<LabelPair<L>>,
  statistic: (sample: ReadonlyArray<LabelPair<L>>) => number = cohensKappa,
  opts: { iterations?: number; seed?: number; level?: number } = {},
): Interval {
  assertPairs(pairs);
  const iterations = opts.iterations ?? 2000;
  const level = opts.level ?? 0.95;
  if (!Number.isInteger(iterations) || iterations <= 0) {
    throw new Error('bootstrapCI: iterations must be a positive integer');
  }
  if (!(level > 0 && level < 1)) throw new Error('bootstrapCI: level must be strictly between 0 and 1');
  const rand = mulberry32(opts.seed ?? 2128);
  const stats: number[] = [];
  for (let it = 0; it < iterations; it++) {
    const sample: LabelPair<L>[] = [];
    for (let i = 0; i < pairs.length; i++) sample.push(pairs[Math.floor(rand() * pairs.length)]);
    stats.push(statistic(sample));
  }
  stats.sort((x, y) => x - y);
  const tail = (1 - level) / 2;
  const at = (q: number) => stats[Math.min(stats.length - 1, Math.max(0, Math.floor(q * stats.length)))];
  return { low: at(tail), high: at(1 - tail) };
}

/** Full agreement report for nominal labels: kappa with bootstrap CI, observed agreement, per class, n. */
export function agreementReport<L extends string | number>(
  pairs: ReadonlyArray<LabelPair<L>>,
  opts: { iterations?: number; seed?: number } = {},
): AgreementReport {
  assertPairs(pairs);
  const agree = pairs.filter((p) => p.truth === p.predicted).length;
  return {
    n: pairs.length,
    observedAgreement: agree / pairs.length,
    kappa: cohensKappa(pairs),
    kappaCI: bootstrapCI(pairs, cohensKappa, opts),
    perClass: perClassMetrics(pairs),
  };
}

export type PairwiseChoice = 'A' | 'B' | 'tie';

/** Win rate of variant A over B (ties count half) with a Wilson CI on decisive comparisons. */
export function pairwiseWinRate(choices: ReadonlyArray<PairwiseChoice>): {
  n: number;
  winRateA: number;
  ties: number;
  decisiveCI: Interval | null;
} {
  if (choices.length === 0) throw new Error('pairwiseWinRate: at least one comparison is required');
  const a = choices.filter((c) => c === 'A').length;
  const b = choices.filter((c) => c === 'B').length;
  const ties = choices.length - a - b;
  return {
    n: choices.length,
    winRateA: (a + ties / 2) / choices.length,
    ties,
    decisiveCI: a + b > 0 ? wilsonInterval(a, a + b) : null,
  };
}

/** The registry `validation` record for a finished agreement run. */
export function toGraderValidation(report: AgreementReport, evidence: string, date: Date = new Date()): ValidationRecord {
  return { kappa: report.kappa, n: report.n, date: date.toISOString().slice(0, 10), evidence };
}
