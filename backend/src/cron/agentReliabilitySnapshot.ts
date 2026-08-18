/**
 * Pure snapshot computation for the agent-mode daily reliability trend line.
 *
 * All metric math lives here, free of DynamoDB, so it is unit-testable with
 * plain event arrays. The cron (agentReliabilitySnapshotCron.ts) reads
 * Dev-AW-LoopEvents, hands the events to `computeReliabilitySnapshot`, and
 * persists the result. The read path (show-reliability-trend.ts / the snapshot
 * endpoint) reads the persisted rows back.
 *
 * The snapshot is telemetry only — it summarizes events the AgentRunRecorder
 * already wrote on the chat hot path. It never touches the chat path itself, so
 * it is chat-behavior-preserving by construction.
 *
 * Metric definitions (mirrors the runRecorder + failureRuleSet vocabulary):
 *   tool_success_rate  = agent_tool_succeeded / agent_tool_invoked
 *   degraded_run_rate  = (verdicts where verdict='degraded') / total verdicts
 *   failed_run_rate    = (verdicts where verdict='failed')   / total verdicts
 *   run_count          = distinct runs that emitted a verdict in the window
 *   median/p90 iters   = per-run max `iteration` seen on agent_decision events
 *   top 5 clusters     = toolName×errorClass on agent_tool_failed, by count
 */

import type { NormalizedEvent } from '../loops/core/types';
import {
  EVT_DECISION,
  EVT_RUN_VERDICT,
  EVT_TOOL_FAILED,
  EVT_TOOL_INVOKED,
  EVT_TOOL_SUCCEEDED,
} from '../loops/instances/agent-mode/eventTypes';

export interface FailureCluster {
  toolName: string;
  errorClass: string;
  count: number;
}

/**
 * ENG-1312: one satisfaction-judge dimension reading, timestamped so it can be
 * windowed the same way every other metric in this file is. Sourced from
 * ChatSession.satisfactionScore/judgeScores.dimensions by the caller — this
 * file stays free of any DB dependency, pure and unit-testable with plain
 * arrays like everything else here.
 *
 * Each field is independently optional: a session scored before ENG-1312
 * shipped, or by a stale custom judge prompt, may carry some fields and not
 * others. A missing field is excluded from that field's aggregate rather than
 * counted as a zero/false, so partial data never silently drags an average
 * toward the missing value.
 */
export interface SatisfactionDimensionSample {
  ts: Date;
  concision?: number;
  instructionCompliance?: number;
  unnecessaryPermissionRequest?: boolean;
}

export interface ReliabilitySnapshot {
  /** UTC calendar date this snapshot summarizes, `YYYY-MM-DD`. */
  date: string;
  /** Window the metrics were computed over (ISO). */
  windowStart: string;
  windowEnd: string;
  /** Rolling window label, e.g. '24h' or '7d'. */
  windowLabel: string;
  toolInvoked: number;
  toolSucceeded: number;
  toolFailed: number;
  /** succeeded / invoked. 0 when no invocations. */
  toolSuccessRate: number;
  runCount: number;
  okRuns: number;
  degradedRuns: number;
  failedRuns: number;
  /** degraded / total verdicts. 0 when no verdicts. */
  degradedRunRate: number;
  /** failed / total verdicts. 0 when no verdicts. */
  failedRunRate: number;
  medianIterations: number;
  p90Iterations: number;
  topClusters: FailureCluster[];
  /**
   * ENG-1312: fleet-wide judge-dimension aggregates for the same window, so a
   * verbosity/permission-asking regression is visible in one daily snapshot
   * instead of requiring a per-session audit two weeks later. Averages are
   * computed only over samples that carry the given field (see
   * SatisfactionDimensionSample); all four default to 0 when
   * satisfactionDimensionSampleCount is 0, mirroring toolSuccessRate's
   * existing "0 when no denominator" convention in this file — the count is
   * what disambiguates "no data" from "a real 0".
   */
  concisionAvg: number;
  instructionComplianceAvg: number;
  unnecessaryPermissionRequestRate: number;
  satisfactionDimensionSampleCount: number;
  /** Wall-clock time the snapshot was computed (ISO). */
  computedAt: string;
}

export interface ComputeSnapshotInput {
  events: readonly NormalizedEvent[];
  date: string;
  windowStart: Date;
  windowEnd: Date;
  windowLabel: string;
  now: Date;
  /** How many top clusters to keep. Default 5. */
  topN?: number;
  /** ENG-1312: satisfaction-judge dimension samples for the same window.
   * Omitted (or empty) => the four aggregate fields default to zero-with-
   * zero-count, so every existing caller is unaffected. */
  satisfactionSamples?: readonly SatisfactionDimensionSample[];
}

/** Arithmetic mean, or 0 for an empty list (matches this file's existing
 * "0 when no denominator" convention — see toolSuccessRate). */
function average(values: number[]): number {
  return values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}

/**
 * Aggregate satisfaction-judge dimension samples within [start, end]. Pure —
 * no IO, deterministic. Each field is averaged/rated only over the samples
 * that actually carry it, so a partially-populated sample (e.g. concision but
 * no instructionCompliance) never drags an unrelated average toward zero.
 */
function aggregateSatisfactionDimensions(
  samples: readonly SatisfactionDimensionSample[],
  start: number,
  end: number,
): Pick<
  ReliabilitySnapshot,
  'concisionAvg' | 'instructionComplianceAvg' | 'unnecessaryPermissionRequestRate' | 'satisfactionDimensionSampleCount'
> {
  const inWindow = samples.filter((s) => {
    const t = s.ts.getTime();
    return t >= start && t <= end;
  });

  const concisionValues = inWindow
    .map((s) => s.concision)
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  const complianceValues = inWindow
    .map((s) => s.instructionCompliance)
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  const permissionFlags = inWindow
    .map((s) => s.unnecessaryPermissionRequest)
    .filter((v): v is boolean => typeof v === 'boolean');

  return {
    concisionAvg: average(concisionValues),
    instructionComplianceAvg: average(complianceValues),
    unnecessaryPermissionRequestRate:
      permissionFlags.length > 0 ? permissionFlags.filter(Boolean).length / permissionFlags.length : 0,
    satisfactionDimensionSampleCount: inWindow.length,
  };
}

function strDim(v: string | number | boolean | null | undefined): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function numDim(v: string | number | boolean | null | undefined): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

/** Largest value <= the percentile rank (nearest-rank method on a sorted asc list). */
function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  if (sortedAsc.length === 1) return sortedAsc[0];
  // rank in [1..n]; nearest-rank, clamp to bounds.
  const rank = Math.ceil((p / 100) * sortedAsc.length);
  const idx = Math.min(Math.max(rank - 1, 0), sortedAsc.length - 1);
  return sortedAsc[idx];
}

function median(sortedAsc: number[]): number {
  if (sortedAsc.length === 0) return 0;
  const mid = Math.floor(sortedAsc.length / 2);
  if (sortedAsc.length % 2 === 1) return sortedAsc[mid];
  return (sortedAsc[mid - 1] + sortedAsc[mid]) / 2;
}

/**
 * Compute one reliability snapshot from a window of agent-mode events.
 * Pure: no IO, deterministic for a given input. Events outside [windowStart,
 * windowEnd] are ignored so the caller can hand in a slightly wider query.
 */
export function computeReliabilitySnapshot(input: ComputeSnapshotInput): ReliabilitySnapshot {
  const topN = input.topN ?? 5;
  const start = input.windowStart.getTime();
  const end = input.windowEnd.getTime();

  let toolInvoked = 0;
  let toolSucceeded = 0;
  let toolFailed = 0;
  let okRuns = 0;
  let degradedRuns = 0;
  let failedRuns = 0;

  // per-run max iteration (from agent_decision events)
  const runMaxIteration = new Map<string, number>();
  // toolName×errorClass cluster counts
  const clusterCounts = new Map<string, FailureCluster>();

  for (const e of input.events) {
    const ts = e.ts.getTime();
    if (ts < start || ts > end) continue;

    switch (e.eventType) {
      case EVT_TOOL_INVOKED:
        toolInvoked++;
        break;
      case EVT_TOOL_SUCCEEDED:
        toolSucceeded++;
        break;
      case EVT_TOOL_FAILED: {
        toolFailed++;
        const toolName = strDim(e.dimensions?.toolName) ?? 'unknown';
        const errorClass = strDim(e.dimensions?.errorClass) ?? 'UnknownError';
        // Unambiguous encoding — a plain `${toolName} ${errorClass}` join lets
        // ("alpha beta", "gamma") and ("alpha", "beta gamma") collide onto the
        // same key and silently merge two unrelated failure clusters
        // (CodeRabbit, PR #2443).
        const key = JSON.stringify([toolName, errorClass]);
        const existing = clusterCounts.get(key);
        if (existing) existing.count++;
        else clusterCounts.set(key, { toolName, errorClass, count: 1 });
        break;
      }
      case EVT_RUN_VERDICT: {
        const verdict = strDim(e.dimensions?.verdict);
        if (verdict === 'ok') okRuns++;
        else if (verdict === 'degraded') degradedRuns++;
        else if (verdict === 'failed') failedRuns++;
        break;
      }
      case EVT_DECISION: {
        const iteration = numDim(e.dimensions?.iteration);
        if (iteration != null) {
          const runId = String(e.subjectId);
          const prev = runMaxIteration.get(runId) ?? 0;
          if (iteration > prev) runMaxIteration.set(runId, iteration);
        }
        break;
      }
      default:
        break;
    }
  }

  const totalVerdicts = okRuns + degradedRuns + failedRuns;
  const iterations = Array.from(runMaxIteration.values()).sort((a, b) => a - b);

  const topClusters = Array.from(clusterCounts.values())
    .sort((a, b) =>
      b.count - a.count ||
      a.toolName.localeCompare(b.toolName) ||
      a.errorClass.localeCompare(b.errorClass),
    )
    .slice(0, topN);

  const satisfactionAgg = aggregateSatisfactionDimensions(input.satisfactionSamples ?? [], start, end);

  return {
    date: input.date,
    windowStart: input.windowStart.toISOString(),
    windowEnd: input.windowEnd.toISOString(),
    windowLabel: input.windowLabel,
    toolInvoked,
    toolSucceeded,
    toolFailed,
    toolSuccessRate: toolInvoked > 0 ? toolSucceeded / toolInvoked : 0,
    runCount: totalVerdicts,
    okRuns,
    degradedRuns,
    failedRuns,
    degradedRunRate: totalVerdicts > 0 ? degradedRuns / totalVerdicts : 0,
    failedRunRate: totalVerdicts > 0 ? failedRuns / totalVerdicts : 0,
    medianIterations: median(iterations),
    p90Iterations: percentile(iterations, 90),
    topClusters,
    ...satisfactionAgg,
    computedAt: input.now.toISOString(),
  };
}
