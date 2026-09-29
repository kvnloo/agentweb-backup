/**
 * task_verified feed (ENG-2190, ENG-2128 slice A): the wiring `llmUsageDriversResolverService.ts`
 * has reserved a type slot for since ENG-1563 (`RecommendationQuality.status === 'task_verified'`,
 * `source: 'task_eval'`) but never populated — see ENG-1564, which owns the full Okareo-backed
 * harness and canary/promotion rollout this is deliberately NOT. That is still Backlog, pending a
 * product decision on the exact promotion bar (ENG-1564 AC1).
 *
 * What this ships instead, in scope for ENG-2190: a feed from data that already exists — the
 * eval-v2 online sampler's daily rates per model x task type (evalV2Sampler.ts /
 * cron/evalV2SamplerCron.ts, ENG-2144) — gated the same way every eval-v2 metric already is:
 * `evalRegistry.mayGate(graderId)`. As of this change no grader is validated (§0 of the ENG-2128
 * brain), so `mayGate` is false for all of them and this feed is provably inert — it does not even
 * read the eval-v2 snapshot, let alone set `task_verified`, until a grader clears that bar.
 *
 * `agent-task-success` is the grader used: it is the one eval-v2 metric that answers the question
 * `task_verified` exists to answer ("was the task actually completed"), as opposed to
 * tool-correctness or groundedness, which answer a narrower question.
 *
 * Deliberately conservative about what counts as verified: both the incumbent (`fromModel`) and
 * the candidate (`toModel`) need a sampled rate with at least MIN_VALIDATION_N sessions (the same
 * bar the registry uses to validate a grader at all — see evalRegistry.ts), and the candidate's
 * rate must not run meaningfully below the incumbent's. A pair with no data, or too little of it,
 * or a genuinely worse candidate, gets no claim here and falls back to whatever
 * llmUsageDriversResolverService's AA-benchmark tier (ENG-1563) would otherwise show — never a
 * blended value (ENG-1564 requirement 4).
 */

import type { DynamoPort } from '../core/ports';
import { awsDynamoAdapter } from '../adapters/awsAdapters';
import { readEvalV2Trend } from '../../cron/evalV2SamplerCron';
import { MIN_VALIDATION_N, mayGate as defaultMayGate } from './evalRegistry';
import type { AgentGraderId } from './agentGraders';
import type { EvalV2Snapshot, EvalV2WindowLabel } from './evalV2Sampler';

/** The eval-v2 grader whose sampled rate answers "was the task actually completed". */
export const TASK_VERIFIED_GRADER_ID: AgentGraderId = 'agent-task-success';

/** How much lower a candidate model's sampled rate may run vs the incumbent's and still count as "not degraded". */
export const TASK_VERIFIED_RATE_TOLERANCE = 0.03;

export interface TaskVerifiedQuality {
  status: 'task_verified';
  source: 'task_eval';
  reason: string;
}

interface CombinedRate {
  n: number;
  passes: number;
  rate: number | null;
}

/**
 * One model's rate for `graderId`, combined across every (surface, task type) cell in the
 * snapshot — usage-driver recommendations are not yet task-type-scoped (there is no task type on
 * a billing driver, only a model), so this rolls the per-task-type rates the sampler actually
 * records up to the one granularity a model-switch recommendation can use today. The literal
 * "all models, all task types" summary row (`ALL`) is excluded by construction: it never equals a
 * real model id.
 */
function combinedRate(snapshot: EvalV2Snapshot, model: string, graderId: AgentGraderId): CombinedRate {
  let n = 0;
  let passes = 0;
  for (const group of snapshot.groups) {
    if (group.model !== model) continue;
    const metric = group.metrics.find((m) => m.graderId === graderId);
    if (!metric) continue;
    n += metric.n;
    passes += metric.passes;
  }
  return { n, passes, rate: n > 0 ? passes / n : null };
}

export interface TaskVerifiedOptions {
  graderId?: AgentGraderId;
  /** Defaults to evalRegistry.mayGate; injectable so tests can prove the feed follows it without mutating the real registry. */
  gate?: (graderId: string) => boolean;
  minN?: number;
  tolerance?: number;
}

/**
 * Pure: given an already-fetched snapshot (or none), decide whether `toModel` is task_verified
 * relative to `fromModel`. Returns undefined whenever the grader isn't gated, there is no
 * snapshot, either side lacks enough sampled sessions, or the candidate is meaningfully worse —
 * every one of those is "no claim", never a claim built on partial evidence.
 */
export function taskVerifiedQuality(
  fromModel: string,
  toModel: string,
  snapshot: EvalV2Snapshot | undefined,
  opts: TaskVerifiedOptions = {},
): TaskVerifiedQuality | undefined {
  const graderId = opts.graderId ?? TASK_VERIFIED_GRADER_ID;
  const gate = opts.gate ?? defaultMayGate;
  if (!gate(graderId) || !snapshot) return undefined;

  const minN = opts.minN ?? MIN_VALIDATION_N;
  const tolerance = opts.tolerance ?? TASK_VERIFIED_RATE_TOLERANCE;
  const from = combinedRate(snapshot, fromModel, graderId);
  const to = combinedRate(snapshot, toModel, graderId);
  if (from.n < minN || to.n < minN || from.rate === null || to.rate === null) return undefined;
  if (to.rate < from.rate - tolerance) return undefined;

  return {
    status: 'task_verified',
    source: 'task_eval',
    reason:
      `Sampled production task-success rate is ${Math.round(to.rate * 100)}% on ${to.n} scored sessions ` +
      `for this model, vs ${Math.round(from.rate * 100)}% on ${from.n} for your current one — measured, not a general benchmark.`,
  };
}

/** The most recent eval-v2 daily snapshot, or undefined on any read failure (never throws). */
export async function readTaskVerifiedSnapshot(
  dynamo: DynamoPort = awsDynamoAdapter(),
  windowLabel: EvalV2WindowLabel = '7d',
): Promise<EvalV2Snapshot | undefined> {
  try {
    const [snapshot] = await readEvalV2Trend(dynamo, { limit: 1, windowLabel });
    return snapshot;
  } catch (err) {
    console.error('[taskVerifiedFeed] failed to read the eval-v2 trend:', err);
    return undefined;
  }
}

export type TaskVerifiedLookup = (fromModel: string, toModel: string) => Promise<TaskVerifiedQuality | undefined>;

/**
 * Build a lookup for one resolveUsageDrivers call: checks the gate (no I/O) on every call, and
 * reads the eval-v2 snapshot at most once — lazily, and only once some grader actually mayGate,
 * so a resolver call never pays for a snapshot read while every grader stays unvalidated (today,
 * always).
 */
export function taskVerifiedQualityLookup(
  opts: TaskVerifiedOptions & { readSnapshot?: () => Promise<EvalV2Snapshot | undefined> } = {},
): TaskVerifiedLookup {
  const graderId = opts.graderId ?? TASK_VERIFIED_GRADER_ID;
  const gate = opts.gate ?? defaultMayGate;
  let snapshotPromise: Promise<EvalV2Snapshot | undefined> | undefined;
  return async (fromModel, toModel) => {
    if (!gate(graderId)) return undefined;
    snapshotPromise ??= (opts.readSnapshot ?? (() => readTaskVerifiedSnapshot()))();
    const snapshot = await snapshotPromise;
    return taskVerifiedQuality(fromModel, toModel, snapshot, opts);
  };
}
