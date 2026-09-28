/**
 * Offline eval suite and regression gate (ENG-2145, ENG-2128 principle 3; ENG-782 contract).
 *
 * Sources (offlineSuiteSources.ts, okareoClient.ts) turn a suite run into per-metric pass counts.
 * This module compares those counts with a versioned baseline file (baselines/*.json) and returns
 * one verdict — pass | regression | unavailable — with the evidence behind it.
 *
 * The ENG-782 contract (Harsha, 2026-08-31), as implemented here:
 * - Regression is measured against the baseline, never an absolute score. The baseline id, metric,
 *   threshold, n and grader version of every metric are in the output.
 * - A probabilistic metric regresses only when its drop exceeds the threshold AND the 95% interval
 *   of the difference (Newcombe, from Wilson intervals) lies wholly below zero, so a point dip
 *   inside sampling noise is not a regression. A deterministic metric has no noise: any drop past
 *   its threshold (normally 0) is one.
 * - Fail closed: a source that is unavailable, times out, is unauthenticated or returns malformed
 *   results, a baseline metric with no result, a stale grader version or too small a sample all
 *   make the verdict `unavailable`, never `pass`.
 * - A block can be lifted only by an explicitly recorded human bypass (who, why, which ticket,
 *   when). The bypass is written into the result; it never changes the verdict.
 * - Only a grader that passes evalRegistry.mayGate may block, never a security metric judged by an
 *   LLM, and never a metric whose inputs are synthetic placeholders. Blocking also needs the
 *   explicit EVAL_GATE_BLOCKING=true switch. Until both hold the gate is report-only: it computes
 *   and prints the verdict and blocks nothing.
 * - Runs target staging or a local deterministic run; production is refused.
 */

import { wilsonInterval, type Interval } from './agreement';
import { getGrader, mayGate, type GraderType } from './evalRegistry';

/** Bump when the comparison rules or the result shape change. */
export const OFFLINE_SUITE_VERSION = 1;
export const BASELINE_SCHEMA_VERSION = 1;
export const EVAL_GATE_BLOCKING_FLAG = 'EVAL_GATE_BLOCKING';
export const DEFAULT_SOURCE_TIMEOUT_MS = 10 * 60 * 1000;
export const DEFAULT_PROBABILISTIC_THRESHOLD = 0.05;

const EPSILON = 1e-9;

export type MetricKind = 'deterministic' | 'probabilistic';
export type MetricCategory = 'quality' | 'security';
export type EvalTarget = 'local' | 'staging';
export type Verdict = 'pass' | 'regression' | 'unavailable';
export type GateMode = 'report_only' | 'blocking';
export type EvaluatorFailure = 'unavailable' | 'timeout' | 'unauthenticated' | 'malformed';

/** One metric from one suite run: how many cases the grader passed out of how many it decided. */
export interface MetricObservation {
  metricId: string;
  graderId: string;
  /** Version of the grader logic (or external check) that produced the counts. */
  graderVersion: string;
  kind: MetricKind;
  category: MetricCategory;
  n: number;
  passes: number;
  /** Every case behind the metric is a synthetic placeholder: reported, never evidence to block on. */
  placeholder: boolean;
  /** Ids of the failing cases (never content). */
  failures: string[];
}

export type SourceResult =
  | { source: string; status: 'ok'; observations: MetricObservation[]; notes: string[] }
  | { source: string; status: 'not_configured'; reason: string }
  | { source: string; status: 'failed'; failure: EvaluatorFailure; message: string };

export interface SuiteSource {
  id: string;
  run(): Promise<SourceResult>;
}

export interface BaselineMetric {
  metricId: string;
  graderId: string;
  graderVersion: string;
  kind: MetricKind;
  category: MetricCategory;
  n: number;
  passes: number;
  /** Largest drop in pass rate (0-1) that is not a regression. */
  threshold: number;
  /** A run with fewer decided cases than this cannot be compared (unavailable). */
  minN: number;
  placeholder: boolean;
}

export interface Baseline {
  schemaVersion: number;
  baselineId: string;
  suiteVersion: number;
  createdAt: string;
  target: EvalTarget;
  /** Where the baseline run came from: commit, Okareo run id, operator. */
  source: string;
  metrics: BaselineMetric[];
}

export class BaselineValidationError extends Error {
  constructor(message: string) {
    super(`Invalid eval baseline: ${message}`);
    this.name = 'BaselineValidationError';
  }
}

export class EvalTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EvalTargetError';
  }
}

export class BypassValidationError extends Error {
  constructor(message: string) {
    super(`Invalid eval-gate bypass: ${message}`);
    this.name = 'BypassValidationError';
  }
}

// ---------------------------------------------------------------------------
// Target
// ---------------------------------------------------------------------------

/** `local` (deterministic, no credentials) or `staging`. Production is refused (ENG-782). */
export function resolveTarget(raw: string | undefined): EvalTarget {
  const value = (raw ?? '').trim().toLowerCase();
  if (value === 'local' || value === 'staging') return value;
  if (value === 'production' || value === 'prod') {
    throw new EvalTargetError('The eval gate runs against staging (or a local deterministic run), never production (ENG-782).');
  }
  throw new EvalTargetError(`target must be local or staging, got "${raw ?? ''}"`);
}

// ---------------------------------------------------------------------------
// Baseline file
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new BaselineValidationError(`${field} must be a non-empty string`);
  return value;
}

function int(value: unknown, field: string, min: number): number {
  if (!Number.isInteger(value) || (value as number) < min) throw new BaselineValidationError(`${field} must be an integer >= ${min}`);
  return value as number;
}

function parseBaselineMetric(value: unknown, index: number): BaselineMetric {
  const at = `metrics[${index}]`;
  if (!isRecord(value)) throw new BaselineValidationError(`${at} must be an object`);
  const kind = value.kind;
  if (kind !== 'deterministic' && kind !== 'probabilistic') throw new BaselineValidationError(`${at}.kind must be deterministic or probabilistic`);
  const category = value.category;
  if (category !== 'quality' && category !== 'security') throw new BaselineValidationError(`${at}.category must be quality or security`);
  const n = int(value.n, `${at}.n`, 1);
  const passes = int(value.passes, `${at}.passes`, 0);
  if (passes > n) throw new BaselineValidationError(`${at}.passes must not exceed n`);
  const threshold = value.threshold;
  if (typeof threshold !== 'number' || !Number.isFinite(threshold) || threshold < 0 || threshold >= 1) {
    throw new BaselineValidationError(`${at}.threshold must be a number in [0, 1)`);
  }
  if (typeof value.placeholder !== 'boolean') throw new BaselineValidationError(`${at}.placeholder must be a boolean`);
  return {
    metricId: str(value.metricId, `${at}.metricId`),
    graderId: str(value.graderId, `${at}.graderId`),
    graderVersion: str(value.graderVersion, `${at}.graderVersion`),
    kind,
    category,
    n,
    passes,
    threshold,
    minN: int(value.minN, `${at}.minN`, 1),
    placeholder: value.placeholder,
  };
}

/** Validates a parsed baseline file. Throws BaselineValidationError naming the first bad field. */
export function parseBaseline(value: unknown): Baseline {
  if (!isRecord(value)) throw new BaselineValidationError('file must hold a JSON object');
  if (value.schemaVersion !== BASELINE_SCHEMA_VERSION) {
    throw new BaselineValidationError(`schemaVersion must be ${BASELINE_SCHEMA_VERSION}`);
  }
  let target: EvalTarget;
  try {
    target = resolveTarget(typeof value.target === 'string' ? value.target : undefined);
  } catch (error) {
    throw new BaselineValidationError(`target: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Array.isArray(value.metrics) || value.metrics.length === 0) throw new BaselineValidationError('metrics must be a non-empty array');
  const metrics = value.metrics.map(parseBaselineMetric);
  const ids = new Set<string>();
  for (const m of metrics) {
    if (ids.has(m.metricId)) throw new BaselineValidationError(`duplicate metricId ${m.metricId}`);
    ids.add(m.metricId);
  }
  const createdAt = str(value.createdAt, 'createdAt');
  if (Number.isNaN(Date.parse(createdAt))) throw new BaselineValidationError('createdAt must be an ISO date');
  return {
    schemaVersion: BASELINE_SCHEMA_VERSION,
    baselineId: str(value.baselineId, 'baselineId'),
    suiteVersion: int(value.suiteVersion, 'suiteVersion', 1),
    createdAt,
    target,
    source: str(value.source, 'source'),
    metrics,
  };
}

/**
 * A baseline from a clean run, for review and commit. Deterministic metrics default to threshold 0
 * and must run every case again; probabilistic ones allow DEFAULT_PROBABILISTIC_THRESHOLD and at
 * least 80% of the baseline sample.
 */
export function baselineFromObservations(
  observations: readonly MetricObservation[],
  meta: { baselineId: string; target: EvalTarget; source: string; now: Date; probabilisticThreshold?: number },
): Baseline {
  if (observations.length === 0) throw new BaselineValidationError('a baseline needs at least one metric');
  return parseBaseline({
    schemaVersion: BASELINE_SCHEMA_VERSION,
    baselineId: meta.baselineId,
    suiteVersion: OFFLINE_SUITE_VERSION,
    createdAt: meta.now.toISOString(),
    target: meta.target,
    source: meta.source,
    metrics: observations.map((o) => ({
      metricId: o.metricId,
      graderId: o.graderId,
      graderVersion: o.graderVersion,
      kind: o.kind,
      category: o.category,
      n: o.n,
      passes: o.passes,
      threshold: o.kind === 'deterministic' ? 0 : meta.probabilisticThreshold ?? DEFAULT_PROBABILISTIC_THRESHOLD,
      minN: o.kind === 'deterministic' ? o.n : Math.max(1, Math.ceil(o.n * 0.8)),
      placeholder: o.placeholder,
    })),
  });
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

/**
 * Newcombe's hybrid score interval (method 10) for p1 - p2, built from each proportion's 95%
 * Wilson interval. Both n must be positive.
 */
export function differenceInterval(a: { passes: number; n: number }, b: { passes: number; n: number }): Interval {
  const p1 = a.passes / a.n;
  const p2 = b.passes / b.n;
  const w1 = wilsonInterval(a.passes, a.n);
  const w2 = wilsonInterval(b.passes, b.n);
  const d = p1 - p2;
  return {
    low: d - Math.sqrt((p1 - w1.low) ** 2 + (w2.high - p2) ** 2),
    high: d + Math.sqrt((w1.high - p1) ** 2 + (p2 - w2.low) ** 2),
  };
}

export interface GateConfig {
  /** EVAL_GATE_BLOCKING=true. Blocking needs this AND a metric whose grader passes mayGate. */
  blockingFlag: boolean;
  /** Defaults to the eval registry; injectable so tests can prove blocking follows it. */
  mayGate?: (graderId: string) => boolean;
  graderType?: (graderId: string) => GraderType | undefined;
}

export function gateConfigFromEnv(env: NodeJS.ProcessEnv = process.env): GateConfig {
  return { blockingFlag: env[EVAL_GATE_BLOCKING_FLAG] === 'true' };
}

/** Whether a regression on this metric may block, and why not when it may not. */
export function metricMayBlock(
  metric: Pick<BaselineMetric, 'graderId' | 'category' | 'placeholder'>,
  config: GateConfig,
): { mayBlock: boolean; reason: string } {
  const gate = config.mayGate ?? mayGate;
  const typeOf = config.graderType ?? ((id: string) => getGrader(id)?.graderType);
  if (metric.placeholder) return { mayBlock: false, reason: 'synthetic placeholder inputs are not evidence' };
  if (metric.category === 'security' && typeOf(metric.graderId) !== 'code') {
    return { mayBlock: false, reason: 'security is never gated on an LLM judge (ENG-782)' };
  }
  if (!gate(metric.graderId)) return { mayBlock: false, reason: 'grader not validated against human labels (evalRegistry.mayGate is false)' };
  return { mayBlock: true, reason: 'validated grader' };
}

export interface RateSummary {
  n: number;
  passes: number;
  rate: number;
}

export interface MetricComparison {
  metricId: string;
  graderId: string;
  kind: MetricKind;
  category: MetricCategory;
  baseline: RateSummary & { graderVersion: string };
  current: (RateSummary & { graderVersion: string; ci: Interval; failures: string[] }) | null;
  threshold: number;
  minN: number;
  /** baseline rate - current rate; positive is worse. */
  drop: number | null;
  /** 95% interval of current - baseline (probabilistic metrics only). */
  diffCI: Interval | null;
  status: Verdict;
  reason: string;
  placeholder: boolean;
  mayBlock: boolean;
  mayBlockReason: string;
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

export function compareMetric(
  baseline: BaselineMetric,
  observation: MetricObservation | undefined,
  config: GateConfig,
  missingReason = 'no result for this metric',
): MetricComparison {
  const block = metricMayBlock(baseline, config);
  const base: MetricComparison = {
    metricId: baseline.metricId,
    graderId: baseline.graderId,
    kind: baseline.kind,
    category: baseline.category,
    baseline: { n: baseline.n, passes: baseline.passes, rate: baseline.passes / baseline.n, graderVersion: baseline.graderVersion },
    current: null,
    threshold: baseline.threshold,
    minN: baseline.minN,
    drop: null,
    diffCI: null,
    status: 'unavailable',
    reason: missingReason,
    placeholder: baseline.placeholder,
    mayBlock: block.mayBlock,
    mayBlockReason: block.reason,
  };
  if (!observation) return base;
  if (observation.n > 0) {
    base.current = {
      n: observation.n,
      passes: observation.passes,
      rate: observation.passes / observation.n,
      graderVersion: observation.graderVersion,
      ci: wilsonInterval(observation.passes, observation.n),
      failures: observation.failures,
    };
  }
  // A current run on placeholders is never evidence, even against a real baseline.
  if (observation.placeholder && !base.placeholder) {
    const placeholderBlock = metricMayBlock({ ...baseline, placeholder: true }, config);
    Object.assign(base, { placeholder: true, mayBlock: placeholderBlock.mayBlock, mayBlockReason: placeholderBlock.reason });
  }
  if (observation.kind !== baseline.kind || observation.graderId !== baseline.graderId) {
    return { ...base, reason: `baseline is ${baseline.graderId} (${baseline.kind}) but the run produced ${observation.graderId} (${observation.kind})` };
  }
  if (observation.graderVersion !== baseline.graderVersion) {
    return {
      ...base,
      reason: `grader version changed (baseline ${baseline.graderVersion}, run ${observation.graderVersion}): record a new baseline before comparing`,
    };
  }
  if (!base.current || observation.n < baseline.minN) {
    return { ...base, reason: `run decided ${observation.n} cases, below the baseline minimum of ${baseline.minN}` };
  }

  const current = base.current;
  const drop = base.baseline.rate - current.rate;
  base.drop = drop;
  if (baseline.kind === 'deterministic') {
    const regressed = drop > baseline.threshold + EPSILON;
    return {
      ...base,
      status: regressed ? 'regression' : 'pass',
      reason: regressed
        ? `${current.n - current.passes} of ${current.n} deterministic cases failed (baseline ${pct(base.baseline.rate)}, now ${pct(current.rate)}): ${current.failures.join(', ')}`
        : `${current.passes}/${current.n} (baseline ${base.baseline.passes}/${base.baseline.n})`,
    };
  }

  const diffCI = differenceInterval(current, base.baseline);
  base.diffCI = diffCI;
  const beyondThreshold = drop > baseline.threshold + EPSILON;
  const significant = diffCI.high < 0;
  const regressed = beyondThreshold && significant;
  let reason: string;
  if (regressed) {
    reason = `rate fell ${pct(drop)} (threshold ${pct(baseline.threshold)}); 95% CI of the change [${pct(diffCI.low)}, ${pct(diffCI.high)}] excludes 0`;
  } else if (beyondThreshold) {
    reason = `rate fell ${pct(drop)} but the 95% CI of the change [${pct(diffCI.low)}, ${pct(diffCI.high)}] includes 0: within sampling noise at n=${current.n}`;
  } else {
    reason = `change ${pct(-drop)} is within the ${pct(baseline.threshold)} threshold`;
  }
  return { ...base, status: regressed ? 'regression' : 'pass', reason };
}

// ---------------------------------------------------------------------------
// Bypass
// ---------------------------------------------------------------------------

export interface BypassRecord {
  /** The human who authorized it (a name or email; not an automation identity). */
  by: string;
  reason: string;
  /** The Linear issue that records the decision, e.g. ENG-2145. */
  ticket: string;
  at: string;
}

const AUTOMATION_IDENTITY = /(\[bot\]|\bbot\b|github-actions|\bclaude\b|\bcodex\b|\bswarm|\bci\b|automation|\bcron\b)/i;
const TICKET = /^[A-Z][A-Z0-9]*-\d+$/;
const MIN_BYPASS_REASON = 10;

/** null when no bypass was asked for. All three fields together, or it throws. */
export function parseBypass(
  input: { by?: string; reason?: string; ticket?: string },
  now: Date = new Date(),
): BypassRecord | null {
  const by = input.by?.trim() ?? '';
  const reason = input.reason?.trim() ?? '';
  const ticket = input.ticket?.trim() ?? '';
  if (!by && !reason && !ticket) return null;
  if (!by || !reason || !ticket) throw new BypassValidationError('by, reason and ticket are all required');
  if (AUTOMATION_IDENTITY.test(by)) throw new BypassValidationError(`"${by}" looks like an automation identity; a bypass must name the human who authorized it`);
  if (reason.length < MIN_BYPASS_REASON) throw new BypassValidationError(`reason must be at least ${MIN_BYPASS_REASON} characters`);
  if (!TICKET.test(ticket)) throw new BypassValidationError(`ticket must be an issue key like ENG-2145, got "${ticket}"`);
  return { by, reason, ticket, at: now.toISOString() };
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

export interface SourceSummary {
  source: string;
  status: 'ok' | 'not_configured' | 'failed';
  detail: string;
  notes?: string[];
}

export interface OfflineSuiteResult {
  suiteVersion: number;
  verdict: Verdict;
  mode: GateMode;
  modeReason: string;
  /** True when the calling check should fail. Only ever true in blocking mode without a bypass. */
  blocks: boolean;
  target: EvalTarget;
  baseline: { baselineId: string; file: string; createdAt: string; source: string; target: EvalTarget; suiteVersion: number };
  comparisons: MetricComparison[];
  sources: SourceSummary[];
  /** Metrics the run produced that the baseline does not track (reported, not compared). */
  untracked: MetricObservation[];
  /** Why the verdict is unavailable, one line per cause. */
  unavailable: string[];
  bypass: (BypassRecord & { applied: boolean; note: string }) | null;
  startedAt: string;
  finishedAt: string;
}

async function runSource(source: SuiteSource, timeoutMs: number): Promise<SourceResult> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<SourceResult>((resolve) => {
    timer = setTimeout(
      () => resolve({ source: source.id, status: 'failed', failure: 'timeout', message: `no result within ${Math.round(timeoutMs / 1000)}s` }),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([
      source.run().catch((error: unknown): SourceResult => ({
        source: source.id,
        status: 'failed',
        failure: 'unavailable',
        message: error instanceof Error ? error.message : String(error),
      })),
      timeout,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** A result is malformed when a count is not a whole number in range. */
function malformedObservation(o: MetricObservation): string | null {
  if (!o.metricId || !o.graderId || !o.graderVersion) return 'missing metricId, graderId or graderVersion';
  if (!Number.isInteger(o.n) || !Number.isInteger(o.passes) || o.n < 0 || o.passes < 0 || o.passes > o.n) {
    return `counts out of range (passes ${o.passes}, n ${o.n})`;
  }
  return null;
}

export async function runOfflineSuite(opts: {
  baseline: Baseline;
  baselineFile: string;
  target: EvalTarget;
  sources: readonly SuiteSource[];
  gate: GateConfig;
  bypass?: BypassRecord | null;
  sourceTimeoutMs?: number;
  now?: () => Date;
}): Promise<OfflineSuiteResult> {
  const now = opts.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const results = await Promise.all(opts.sources.map((s) => runSource(s, opts.sourceTimeoutMs ?? DEFAULT_SOURCE_TIMEOUT_MS)));

  const unavailable: string[] = [];
  const sources: SourceSummary[] = [];
  const observations = new Map<string, MetricObservation>();
  const producedBy = new Map<string, string>();
  const missingBecause = new Map<string, string>();
  for (const r of results) {
    if (r.status === 'failed') {
      unavailable.push(`${r.source}: ${r.failure} — ${r.message}`);
      sources.push({ source: r.source, status: 'failed', detail: `${r.failure}: ${r.message}` });
      missingBecause.set(r.source, `source ${r.source} failed (${r.failure})`);
      continue;
    }
    if (r.status === 'not_configured') {
      sources.push({ source: r.source, status: 'not_configured', detail: r.reason });
      missingBecause.set(r.source, `source ${r.source} not configured: ${r.reason}`);
      continue;
    }
    const bad = r.observations.map((o) => [o, malformedObservation(o)] as const).filter(([, why]) => why !== null);
    if (bad.length > 0) {
      const detail = bad.map(([o, why]) => `${o.metricId || '?'}: ${why}`).join('; ');
      unavailable.push(`${r.source}: malformed — ${detail}`);
      sources.push({ source: r.source, status: 'failed', detail: `malformed: ${detail}` });
      continue;
    }
    for (const o of r.observations) {
      if (observations.has(o.metricId)) {
        unavailable.push(`${r.source}: malformed — metric ${o.metricId} also produced by ${producedBy.get(o.metricId)}`);
        continue;
      }
      observations.set(o.metricId, o);
      producedBy.set(o.metricId, r.source);
    }
    sources.push({ source: r.source, status: 'ok', detail: `${r.observations.length} metric(s)`, ...(r.notes.length ? { notes: r.notes } : {}) });
  }

  if (opts.baseline.target !== opts.target) {
    unavailable.push(`baseline ${opts.baseline.baselineId} was recorded on ${opts.baseline.target}, this run targets ${opts.target}`);
  }
  if (opts.baseline.suiteVersion !== OFFLINE_SUITE_VERSION) {
    unavailable.push(`baseline suiteVersion ${opts.baseline.suiteVersion} != suite version ${OFFLINE_SUITE_VERSION}: record a new baseline`);
  }

  const missingReason = [...missingBecause.values()].join('; ') || 'no source produced this metric';
  const comparisons = opts.baseline.metrics.map((m) => compareMetric(m, observations.get(m.metricId), opts.gate, missingReason));
  for (const c of comparisons.filter((x) => x.status === 'unavailable')) unavailable.push(`${c.metricId}: ${c.reason}`);
  const tracked = new Set(opts.baseline.metrics.map((m) => m.metricId));
  const untracked = [...observations.values()].filter((o) => !tracked.has(o.metricId));

  const regressions = comparisons.filter((c) => c.status === 'regression');
  const verdict: Verdict = regressions.length > 0 ? 'regression' : unavailable.length > 0 ? 'unavailable' : 'pass';

  const eligible = comparisons.filter((c) => c.mayBlock);
  let mode: GateMode = 'report_only';
  let modeReason: string;
  if (!opts.gate.blockingFlag) {
    modeReason = `${EVAL_GATE_BLOCKING_FLAG} is not true`;
  } else if (eligible.length === 0) {
    modeReason = 'no compared metric has a validated grader (evalRegistry.mayGate), so nothing may block';
  } else {
    mode = 'blocking';
    modeReason = `blocking on ${eligible.map((c) => c.metricId).join(', ')}`;
  }

  // Fail closed: in blocking mode an unavailable result blocks exactly like a regression on a
  // validated grader. A regression on an unvalidated grader is reported, never blocking.
  const wouldBlock = mode === 'blocking' && (verdict === 'unavailable' || unavailable.length > 0 || regressions.some((c) => c.mayBlock));
  let blocks = wouldBlock;
  let bypass: OfflineSuiteResult['bypass'] = null;
  if (opts.bypass) {
    if (wouldBlock) {
      blocks = false;
      bypass = { ...opts.bypass, applied: true, note: `lifted a ${verdict} block; the verdict stands` };
    } else {
      bypass = { ...opts.bypass, applied: false, note: mode === 'report_only' ? 'nothing to bypass: gate is report-only' : 'nothing to bypass: the gate did not block' };
    }
  }

  const b = opts.baseline;
  return {
    suiteVersion: OFFLINE_SUITE_VERSION,
    verdict,
    mode,
    modeReason,
    blocks,
    target: opts.target,
    baseline: { baselineId: b.baselineId, file: opts.baselineFile, createdAt: b.createdAt, source: b.source, target: b.target, suiteVersion: b.suiteVersion },
    comparisons,
    sources,
    untracked,
    unavailable,
    bypass,
    startedAt,
    finishedAt: now().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

/** Process exit code for a result: 0 unless it blocks (1 regression, 2 unavailable). */
export function exitCodeFor(result: OfflineSuiteResult): number {
  if (!result.blocks) return 0;
  return result.verdict === 'regression' ? 1 : 2;
}

/** Markdown summary for a PR comment or run log: verdict, mode, baseline and every metric. */
export function renderReport(result: OfflineSuiteResult): string {
  const lines: string[] = [];
  const headline = result.verdict === 'pass' ? 'PASS' : result.verdict === 'regression' ? 'REGRESSION' : 'UNAVAILABLE (fail-closed: not a pass)';
  lines.push(`## Offline eval suite v${result.suiteVersion}: ${headline}`);
  lines.push('');
  lines.push(`- Mode: **${result.mode}** (${result.modeReason})${result.blocks ? ' — this check FAILS' : ''}`);
  lines.push(`- Target: ${result.target}`);
  lines.push(`- Baseline: \`${result.baseline.baselineId}\` (${result.baseline.file}, ${result.baseline.target}, recorded ${result.baseline.createdAt} from ${result.baseline.source})`);
  if (result.bypass) {
    lines.push(`- Bypass: ${result.bypass.applied ? 'APPLIED' : 'not applied'} — by ${result.bypass.by} at ${result.bypass.at}, ${result.bypass.ticket}: ${result.bypass.reason} (${result.bypass.note})`);
  }
  lines.push('');
  lines.push('| Metric | Grader@version | Kind | Baseline (n) | Now (n, 95% CI) | Threshold | Status | May block |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const c of result.comparisons) {
    const now = c.current ? `${pct(c.current.rate)} (${c.current.passes}/${c.current.n}, ${pct(c.current.ci.low)}–${pct(c.current.ci.high)})` : '—';
    lines.push(
      `| ${c.metricId}${c.placeholder ? ' (placeholder)' : ''} | ${c.graderId}@${c.baseline.graderVersion} | ${c.kind} | ${pct(c.baseline.rate)} (${c.baseline.passes}/${c.baseline.n}) | ${now} | ${pct(c.threshold)}, minN ${c.minN} | ${c.status}: ${c.reason} | ${c.mayBlock ? 'yes' : `no — ${c.mayBlockReason}`} |`,
    );
  }
  if (result.unavailable.length > 0) {
    lines.push('');
    lines.push('Unavailable (each one keeps the verdict from being a pass):');
    for (const u of result.unavailable) lines.push(`- ${u}`);
  }
  lines.push('');
  lines.push('Sources:');
  for (const s of result.sources) {
    lines.push(`- ${s.source}: ${s.status} — ${s.detail}`);
    for (const n of s.notes ?? []) lines.push(`  - ${n}`);
  }
  if (result.untracked.length > 0) {
    lines.push('');
    lines.push(`Not in the baseline (reported only): ${result.untracked.map((o) => `${o.metricId} ${o.passes}/${o.n}`).join(', ')}`);
  }
  return lines.join('\n');
}
