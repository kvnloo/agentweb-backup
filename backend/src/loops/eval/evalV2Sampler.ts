/**
 * Online eval sampler, pure half (ENG-2144, ENG-2128 slice 6).
 *
 * Scoring today is lazy: a session is judged only when an admin opens it on the dashboard or a
 * backfill touches it, so any rate built on existing scores inherits that selection. The sampler
 * instead takes a seeded uniform random sample of the sessions whose last activity fell on one
 * UTC day, grades them with the deterministic ENG-2137 graders (agentGraders.ts, no LLM) and
 * stores one `eval_v2_scored` row per session in Dev-AW-LoopEvents. A daily snapshot then
 * aggregates those rows per surface × task type × model with n and a 95% Wilson interval.
 *
 * This file holds the sampling, the row shapes and the aggregate math, with no I/O. The cron
 * (cron/evalV2SamplerCron.ts) does the reads and writes.
 *
 * No grader here passes `mayGate` (evalRegistry.ts), so nothing built on these rates may alert or
 * gate: every metric carries its `mayGate` value, and no alert path exists.
 */

import type { DynamoAttributeMap } from '../core/ports';
import type { LoopId } from '../core/types';
import { asLoopId } from '../core/types';
import { AGENT_GRADER_VERSIONS, type AgentGraderId, type AgentLoopEvent, type GradedSession, type TaskVerdict } from './agentGraders';
import type { SpendStatus } from './agentGraderLoader';
import { wilsonInterval, type Interval } from './agreement';
import { mayGate } from './evalRegistry';

/** Partition of the per-session scores and the per-day sample-run rows. */
export const EVAL_V2_LOOP_ID: LoopId = asLoopId('eval-v2');
/** Partition of the daily aggregate snapshots (kept apart so trend reads never page the scores). */
export const EVAL_V2_DAILY_LOOP_ID: LoopId = asLoopId('eval-v2-daily');

export const EVT_EVAL_V2_SCORED = 'eval_v2_scored';
export const EVT_EVAL_V2_SAMPLE_RUN = 'eval_v2_sample_run';
export const EVT_EVAL_V2_SNAPSHOT = 'eval_v2_snapshot';

/** Bump when the sampling frame or the row shape changes. 2: spend and run latency per score (ENG-2196). */
export const EVAL_V2_SAMPLER_VERSION = 2;

export const EVAL_V2_WINDOWS = { '1d': 1, '7d': 7 } as const;
export type EvalV2WindowLabel = keyof typeof EVAL_V2_WINDOWS;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Sampling
// ---------------------------------------------------------------------------

/** xmur3 string hash → mulberry32 generator: a small, well-mixed PRNG seeded by a string. */
export function seededRandom(seed: string): () => number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  let a = (h ^= h >>> 16) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A uniform random sample of `k` items without replacement (partial Fisher–Yates), or every item
 * when there are no more than `k`. Items are put in `keyOf` order first, so the result depends
 * only on the set of items and the seed, never on the order a query returned them in.
 */
export function sampleUniform<T>(items: readonly T[], k: number, seed: string, keyOf: (item: T) => string): T[] {
  const pool = [...items].sort((a, b) => keyOf(a).localeCompare(keyOf(b)));
  const take = Math.max(0, Math.min(Math.floor(k), pool.length));
  const random = seededRandom(seed);
  for (let i = 0; i < take; i++) {
    const j = i + Math.floor(random() * (pool.length - i));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, take);
}

/** Seed for one day's sample: a re-run of the same day draws the same sessions from the same frame. */
export function sampleSeed(sampleDate: string): string {
  return `eval-v2:${sampleDate}`;
}

/** [start, end] of a UTC calendar day, ISO. */
export function utcDayWindow(date: string): { from: string; to: string } {
  return { from: `${date}T00:00:00.000Z`, to: `${date}T23:59:59.999Z` };
}

/** `YYYY-MM-DD` of the UTC day `days` before `date`. */
export function shiftDate(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) + days * MS_PER_DAY).toISOString().slice(0, 10);
}

/** Where the session ran: portal × session type (e.g. `agent/scheduled`, `emma-sidebar/regular`). */
export function surfaceOf(session: { portalType?: unknown; sessionType?: unknown }): string {
  const part = (v: unknown) => (typeof v === 'string' && v ? v : 'unknown');
  return `${part(session.portalType)}/${part(session.sessionType)}`;
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

export function scoredEventSortKey(sampleDate: string, sessionId: string): string {
  return `${EVT_EVAL_V2_SCORED}#${sampleDate}#${sessionId}`;
}

export function sampleRunSortKey(sampleDate: string): string {
  return `${EVT_EVAL_V2_SAMPLE_RUN}#${sampleDate}`;
}

export function snapshotSortKey(date: string, windowLabel: EvalV2WindowLabel): string {
  return `${date}#${windowLabel}`;
}

/** `agent-task-success@1,agent-tool-correctness@1,…` — the graders and versions behind a score. */
export function graderVersionTag(versions: Readonly<Record<AgentGraderId, number>> = AGENT_GRADER_VERSIONS): string {
  return (Object.keys(versions) as AgentGraderId[]).map((id) => `${id}@${versions[id]}`).join(',');
}

function parseGraderVersionTag(tag: string): Partial<Record<AgentGraderId, number>> {
  const out: Partial<Record<AgentGraderId, number>> = {};
  for (const part of tag.split(',')) {
    const [id, version] = part.split('@');
    if (id in AGENT_GRADER_VERSIONS && Number.isInteger(Number(version))) out[id as AgentGraderId] = Number(version);
  }
  return out;
}

export interface ScoreContext {
  sampleDate: string;
  surface: string;
  /** Sessions in the day's frame, and how many were drawn from it. */
  frameSize: number;
  sampleSize: number;
  userTurns: number;
  /** What the bounded AW-SpendEvents read found for the session (ENG-2196); absent when spend was not read. */
  spendStatus?: SpendStatus;
  /** Wall time of the session's runs; absent when no run has both a start and a verdict. */
  runLatencyMs?: number;
}

/**
 * Wall time of a session's agent runs: for each run with both an `agent_run_started` and an
 * `agent_run_verdict` event, verdict ts - start ts, summed. Undefined when no run has both.
 */
export function sessionRunLatencyMs(events: readonly AgentLoopEvent[]): number | undefined {
  const starts = new Map<string, number>();
  const ends = new Map<string, number>();
  for (const e of events) {
    const at = Date.parse(e.ts);
    if (Number.isNaN(at)) continue;
    if (e.eventType === 'agent_run_started') starts.set(e.runId, Math.min(starts.get(e.runId) ?? at, at));
    else if (e.eventType === 'agent_run_verdict') ends.set(e.runId, Math.max(ends.get(e.runId) ?? at, at));
  }
  let total = 0;
  let runs = 0;
  for (const [runId, start] of starts) {
    const end = ends.get(runId);
    if (end === undefined || end < start) continue;
    total += end - start;
    runs++;
  }
  return runs > 0 ? total : undefined;
}

/**
 * One `eval_v2_scored` row. The sort key is deterministic per (day, session), so writing it with
 * a conditional put makes the write idempotent. Dimensions are flat scalars, like every other
 * Dev-AW-LoopEvents row, and carry verdicts, reasons and counts only — never message text.
 */
export function buildScoredEventItem(graded: GradedSession, ctx: ScoreContext, scoredAt: Date): DynamoAttributeMap {
  const findingKinds = [...new Set(graded.tools.findings.map((f) => f.kind))].sort();
  return {
    loopId: EVAL_V2_LOOP_ID,
    tsSession: scoredEventSortKey(ctx.sampleDate, graded.sessionId),
    eventType: EVT_EVAL_V2_SCORED,
    subjectId: graded.sessionId,
    ts: scoredAt.toISOString(),
    dimensions: {
      sessionId: graded.sessionId,
      sampleDate: ctx.sampleDate,
      surface: ctx.surface,
      model: graded.model,
      taskType: graded.taskType,
      taskVerdict: graded.task.verdict,
      taskReason: graded.task.reason,
      toolVerdict: graded.tools.verdict,
      toolCalls: graded.tools.toolCalls,
      toolMutations: graded.tools.mutations,
      toolFindingKinds: findingKinds.join(','),
      groundednessVerdict: graded.groundedness.verdict,
      unbackedClaimClasses: graded.groundedness.unbackedClaimClasses.join(','),
      userTurns: ctx.userTurns,
      ...(ctx.spendStatus ? { spendStatus: ctx.spendStatus } : {}),
      ...(ctx.spendStatus === 'attributed' && graded.efficiency.spend
        ? { costMicroUsd: graded.efficiency.spend.costMicroUsd, tokens: graded.efficiency.spend.tokens }
        : {}),
      ...(ctx.runLatencyMs !== undefined ? { runLatencyMs: ctx.runLatencyMs } : {}),
      frameSize: ctx.frameSize,
      sampleSize: ctx.sampleSize,
      graders: graderVersionTag(),
      samplerVersion: EVAL_V2_SAMPLER_VERSION,
    },
  };
}

export interface EvalV2Score {
  sessionId: string;
  sampleDate: string;
  surface: string;
  model: string;
  taskType: string;
  taskVerdict: TaskVerdict;
  toolVerdict: 'pass' | 'fail';
  toolCalls: number;
  groundednessVerdict: 'grounded' | 'ungrounded' | 'no_claims';
  graderVersions: Partial<Record<AgentGraderId, number>>;
  /** Absent when spend was not read (e.g. a row from sampler version 1). */
  spendStatus?: SpendStatus;
  /** Present only when spendStatus is `attributed`. */
  costMicroUsd?: number;
  runLatencyMs?: number;
}

const SPEND_STATUSES: ReadonlySet<string> = new Set<SpendStatus>(['attributed', 'none', 'truncated']);

const TASK_VERDICTS: ReadonlySet<string> = new Set<TaskVerdict>(['success', 'failure', 'excluded']);
const GROUNDEDNESS_VERDICTS: ReadonlySet<string> = new Set(['grounded', 'ungrounded', 'no_claims']);

/** A stored `eval_v2_scored` row back into a score, or null for any other or malformed row. */
export function parseScoredEvent(item: Record<string, unknown>): EvalV2Score | null {
  if (item.eventType !== EVT_EVAL_V2_SCORED) return null;
  const d = item.dimensions && typeof item.dimensions === 'object' ? (item.dimensions as Record<string, unknown>) : {};
  const str = (k: string) => (typeof d[k] === 'string' ? (d[k] as string) : '');
  const taskVerdict = str('taskVerdict');
  const toolVerdict = str('toolVerdict');
  const groundednessVerdict = str('groundednessVerdict');
  if (!str('sessionId') || !str('sampleDate') || !TASK_VERDICTS.has(taskVerdict)) return null;
  if ((toolVerdict !== 'pass' && toolVerdict !== 'fail') || !GROUNDEDNESS_VERDICTS.has(groundednessVerdict)) return null;
  return {
    sessionId: str('sessionId'),
    sampleDate: str('sampleDate'),
    surface: str('surface') || 'unknown/unknown',
    model: str('model') || 'unknown',
    taskType: str('taskType') || 'other',
    taskVerdict: taskVerdict as TaskVerdict,
    toolVerdict,
    toolCalls: typeof d.toolCalls === 'number' ? d.toolCalls : 0,
    groundednessVerdict: groundednessVerdict as EvalV2Score['groundednessVerdict'],
    graderVersions: parseGraderVersionTag(str('graders')),
    ...(SPEND_STATUSES.has(str('spendStatus')) ? { spendStatus: str('spendStatus') as SpendStatus } : {}),
    ...(str('spendStatus') === 'attributed' && typeof d.costMicroUsd === 'number' ? { costMicroUsd: d.costMicroUsd } : {}),
    ...(typeof d.runLatencyMs === 'number' ? { runLatencyMs: d.runLatencyMs } : {}),
  };
}

export interface SampleRun {
  sampleDate: string;
  status: 'sampling' | 'complete';
  seed: string;
  frameSize: number;
  sampleSize: number;
  sessionIds: string[];
  startedAt: string;
  completedAt?: string;
  /** Rows written by this run, and rows that already existed (a resumed run). */
  written?: number;
  alreadyScored?: number;
}

export function buildSampleRunItem(run: SampleRun): DynamoAttributeMap {
  return {
    loopId: EVAL_V2_LOOP_ID,
    tsSession: sampleRunSortKey(run.sampleDate),
    eventType: EVT_EVAL_V2_SAMPLE_RUN,
    subjectId: run.sampleDate,
    ts: run.completedAt ?? run.startedAt,
    run: { ...run, samplerVersion: EVAL_V2_SAMPLER_VERSION } as unknown as DynamoAttributeMap,
  };
}

export function parseSampleRun(item: Record<string, unknown> | null): SampleRun | null {
  if (!item || item.eventType !== EVT_EVAL_V2_SAMPLE_RUN) return null;
  const run = item.run;
  if (!run || typeof run !== 'object') return null;
  const r = run as Partial<SampleRun>;
  if (typeof r.sampleDate !== 'string' || !Array.isArray(r.sessionIds)) return null;
  return r as SampleRun;
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

type Outcome = 'pass' | 'fail' | 'not_applicable';

/**
 * How each grader's verdict becomes a rate. Sessions a grader cannot label (task success
 * `excluded`, no tool calls, no completion claims) are counted as not applicable and left out of
 * n, so they never dilute or inflate the rate.
 */
const METRIC_OUTCOMES: ReadonlyArray<{ graderId: AgentGraderId; outcome: (s: EvalV2Score) => Outcome }> = [
  {
    graderId: 'agent-task-success',
    outcome: (s) => (s.taskVerdict === 'excluded' ? 'not_applicable' : s.taskVerdict === 'success' ? 'pass' : 'fail'),
  },
  {
    graderId: 'agent-tool-correctness',
    outcome: (s) => (s.toolCalls === 0 ? 'not_applicable' : s.toolVerdict === 'pass' ? 'pass' : 'fail'),
  },
  {
    graderId: 'agent-groundedness-offline',
    outcome: (s) => (s.groundednessVerdict === 'no_claims' ? 'not_applicable' : s.groundednessVerdict === 'grounded' ? 'pass' : 'fail'),
  },
];

export interface EvalV2Metric {
  graderId: AgentGraderId;
  /** Grader versions behind the scores in this cell (more than one means the logic changed mid-window). */
  versions: number[];
  /** Sessions the grader labelled pass or fail. */
  n: number;
  passes: number;
  rate: number | null;
  /** 95% Wilson score interval; null when n is 0. */
  ci: Interval | null;
  notApplicable: number;
  /** evalRegistry.mayGate: false means unvalidated, so the metric may not alert, gate or headline. */
  mayGate: boolean;
}

/**
 * Cost and latency per successful task (ENG-2196), over sessions with a success or failure label.
 * Cost follows agentGraders.efficiencyMetrics: the spend of every labelled session that has spend
 * data, divided by its successes, so failures are charged to successes. Sessions whose spend is
 * unknown (`truncated`, or not read) or unattributed (`none`) are counted, never read as $0.
 */
export interface EvalV2Efficiency {
  graded: number;
  successes: number;
  /** Labelled sessions with attributed spend, and the successes among them. */
  withSpend: number;
  successesWithSpend: number;
  /** Labelled sessions with no spend row carrying their session id. */
  spendNone: number;
  /** Labelled sessions whose spend was not read, or overflowed the bounded read. */
  spendUnknown: number;
  costPerSuccessUsd: number | null;
  medianSuccessCostUsd: number | null;
  /** Successes with a measured run wall time. */
  successesWithLatency: number;
  latencyPerSuccessP50Ms: number | null;
  latencyPerSuccessP95Ms: number | null;
}

export interface EvalV2Group {
  surface: string;
  taskType: string;
  model: string;
  sessions: number;
  metrics: EvalV2Metric[];
  efficiency: EvalV2Efficiency;
}

/** How much of the sample's spend could be tied to its sessions (the audit found 43% of rows without a session id). */
export interface EvalV2SpendAttribution {
  sessions: number;
  attributed: number;
  none: number;
  truncated: number;
  notRead: number;
}

export interface EvalV2DayCoverage {
  date: string;
  frameSize: number;
  sampleSize: number;
  scored: number;
}

export interface EvalV2Snapshot {
  /** Last sample day in the window, `YYYY-MM-DD`. */
  date: string;
  windowLabel: EvalV2WindowLabel;
  windowStartDate: string;
  windowEndDate: string;
  sessions: number;
  /** Frame and sample size per sampled day in the window. */
  coverage: EvalV2DayCoverage[];
  /** First the whole window (`all`), then each surface × task type × model, largest first. */
  groups: EvalV2Group[];
  spendAttribution: EvalV2SpendAttribution;
  computedAt: string;
}

export const ALL = 'all';

function metricsFor(scores: readonly EvalV2Score[], gate: (graderId: string) => boolean): EvalV2Metric[] {
  return METRIC_OUTCOMES.map(({ graderId, outcome }) => {
    let passes = 0;
    let fails = 0;
    const versions = new Set<number>();
    for (const s of scores) {
      const o = outcome(s);
      if (o === 'pass') passes++;
      else if (o === 'fail') fails++;
      const v = s.graderVersions[graderId];
      if (v !== undefined) versions.add(v);
    }
    const n = passes + fails;
    return {
      graderId,
      versions: [...versions].sort((a, b) => a - b),
      n,
      passes,
      rate: n > 0 ? passes / n : null,
      ci: n > 0 ? wilsonInterval(passes, n) : null,
      notApplicable: scores.length - n,
      mayGate: gate(graderId),
    };
  });
}

/** Nearest-rank percentile. */
function percentile(xs: readonly number[], p: number): number | null {
  if (!xs.length) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
}

export function efficiencyFor(scores: readonly EvalV2Score[]): EvalV2Efficiency {
  const graded = scores.filter((s) => s.taskVerdict !== 'excluded');
  const wins = graded.filter((s) => s.taskVerdict === 'success');
  const withSpend = graded.filter((s) => s.spendStatus === 'attributed' && s.costMicroUsd !== undefined);
  const winsWithSpend = withSpend.filter((s) => s.taskVerdict === 'success');
  const usd = (s: EvalV2Score) => (s.costMicroUsd ?? 0) / 1e6;
  const latencies = wins.flatMap((s) => (s.runLatencyMs !== undefined ? [s.runLatencyMs] : []));
  return {
    graded: graded.length,
    successes: wins.length,
    withSpend: withSpend.length,
    successesWithSpend: winsWithSpend.length,
    spendNone: graded.filter((s) => s.spendStatus === 'none').length,
    spendUnknown: graded.filter((s) => s.spendStatus !== 'attributed' && s.spendStatus !== 'none').length,
    costPerSuccessUsd: winsWithSpend.length ? withSpend.reduce((a, s) => a + usd(s), 0) / winsWithSpend.length : null,
    medianSuccessCostUsd: percentile(winsWithSpend.map(usd), 0.5),
    successesWithLatency: latencies.length,
    latencyPerSuccessP50Ms: percentile(latencies, 0.5),
    latencyPerSuccessP95Ms: percentile(latencies, 0.95),
  };
}

function spendAttributionOf(scores: readonly EvalV2Score[]): EvalV2SpendAttribution {
  const count = (status: SpendStatus) => scores.filter((s) => s.spendStatus === status).length;
  const attributed = count('attributed');
  const none = count('none');
  const truncated = count('truncated');
  return { sessions: scores.length, attributed, none, truncated, notRead: scores.length - attributed - none - truncated };
}

export interface AggregateOptions {
  date: string;
  windowLabel: EvalV2WindowLabel;
  now: Date;
  runs?: readonly SampleRun[];
  /** Defaults to the eval registry; injectable so tests can prove the flag follows it. */
  gate?: (graderId: string) => boolean;
}

/** Aggregate the scores whose sample day falls in the window ending on `date`. Pure. */
export function aggregateEvalV2(scores: readonly EvalV2Score[], opts: AggregateOptions): EvalV2Snapshot {
  const gate = opts.gate ?? mayGate;
  const windowStartDate = shiftDate(opts.date, 1 - EVAL_V2_WINDOWS[opts.windowLabel]);
  const inWindow = scores.filter((s) => s.sampleDate >= windowStartDate && s.sampleDate <= opts.date);

  const groups = new Map<string, EvalV2Score[]>();
  for (const s of inWindow) {
    const key = JSON.stringify([s.surface, s.taskType, s.model]);
    const list = groups.get(key) ?? [];
    list.push(s);
    groups.set(key, list);
  }
  const cells: EvalV2Group[] = [...groups.values()]
    .map((list) => ({
      surface: list[0].surface,
      taskType: list[0].taskType,
      model: list[0].model,
      sessions: list.length,
      metrics: metricsFor(list, gate),
      efficiency: efficiencyFor(list),
    }))
    .sort((a, b) =>
      b.sessions - a.sessions ||
      a.surface.localeCompare(b.surface) ||
      a.taskType.localeCompare(b.taskType) ||
      a.model.localeCompare(b.model));

  const scoredPerDay = new Map<string, number>();
  for (const s of inWindow) scoredPerDay.set(s.sampleDate, (scoredPerDay.get(s.sampleDate) ?? 0) + 1);
  const coverage = (opts.runs ?? [])
    .filter((r) => r.sampleDate >= windowStartDate && r.sampleDate <= opts.date)
    .map((r) => ({ date: r.sampleDate, frameSize: r.frameSize, sampleSize: r.sessionIds.length, scored: scoredPerDay.get(r.sampleDate) ?? 0 }))
    .sort((a, b) => a.date.localeCompare(b.date));

  return {
    date: opts.date,
    windowLabel: opts.windowLabel,
    windowStartDate,
    windowEndDate: opts.date,
    sessions: inWindow.length,
    coverage,
    groups: [{ surface: ALL, taskType: ALL, model: ALL, sessions: inWindow.length, metrics: metricsFor(inWindow, gate), efficiency: efficiencyFor(inWindow) }, ...cells],
    spendAttribution: spendAttributionOf(inWindow),
    computedAt: opts.now.toISOString(),
  };
}

export function buildSnapshotItem(snap: EvalV2Snapshot): DynamoAttributeMap {
  return {
    loopId: EVAL_V2_DAILY_LOOP_ID,
    tsSession: snapshotSortKey(snap.date, snap.windowLabel),
    eventType: EVT_EVAL_V2_SNAPSHOT,
    subjectId: snap.date,
    ts: snap.computedAt,
    date: snap.date,
    windowLabel: snap.windowLabel,
    sessions: snap.sessions,
    snapshot: snap as unknown as DynamoAttributeMap,
  };
}

export function parseSnapshotItem(item: Record<string, unknown>): EvalV2Snapshot | null {
  if (item.eventType !== EVT_EVAL_V2_SNAPSHOT) return null;
  const snap = item.snapshot;
  return snap && typeof snap === 'object' ? (snap as EvalV2Snapshot) : null;
}
