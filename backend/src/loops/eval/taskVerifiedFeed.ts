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
 * Deliberately conservative about what counts as verified: rates are compared only over the
 * (surface, task type) cells BOTH the incumbent (`fromModel`) and the candidate (`toModel`) were
 * actually sampled on — pooling each model's rate independently across whatever cells it happens
 * to have data for is a Simpson's-paradox trap (a candidate sampled on an easier task mix would
 * pool higher than the incumbent despite being worse on every task type they share), so a cell
 * only one side sampled is excluded from both totals rather than left to skew either one. Over
 * that shared basis, both sides need at least MIN_VALIDATION_N sessions (the same bar the
 * registry uses to validate a grader at all — see evalRegistry.ts), and the candidate's rate must
 * not run meaningfully below the incumbent's. A pair with no data, too little of it, no
 * meaningful cell overlap, or a genuinely worse candidate, gets no claim here and falls back to
 * whatever llmUsageDriversResolverService's AA-benchmark tier (ENG-1563) would otherwise show —
 * never a blended value (ENG-1564 requirement 4).
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

/** One model's per-(surface, task type) cells for `graderId`, keyed so two models' cells can be matched. Cells with n === 0 are dropped: a group can exist with no labelled sessions for this grader (e.g. every session excluded), and that is not "sampled" for this purpose. */
function cellsOf(snapshot: EvalV2Snapshot, model: string, graderId: AgentGraderId): Map<string, { n: number; passes: number }> {
  const cells = new Map<string, { n: number; passes: number }>();
  for (const group of snapshot.groups) {
    if (group.model !== model) continue;
    const metric = group.metrics.find((m) => m.graderId === graderId);
    if (!metric || metric.n === 0) continue;
    // The literal "all models, all task types" summary row never reaches here: its
    // model is the string 'all', which never equals a real model id.
    cells.set(`${group.surface}\u0000${group.taskType}`, { n: metric.n, passes: metric.passes });
  }
  return cells;
}

/**
 * `fromModel` and `toModel`'s rates for `graderId`, restricted to the (surface, task type) cells
 * BOTH models were actually sampled on. Pooling each model's rate independently across every cell
 * it happens to have data for is a Simpson's-paradox trap: two models sampled on different task
 * mixes can have their pooled rates ranked in the OPPOSITE order from their rate on every task
 * type they actually share (a candidate skewed toward easier, unshared task types would pool
 * higher despite being worse on every type in common). Restricting both sides to the same cells
 * before summing is what makes the resulting rate an apples-to-apples comparison; a cell only one
 * side sampled contributes to neither total.
 *
 * Usage-driver recommendations are not yet task-type-scoped (there is no task type on a billing
 * driver, only a model), so the shared cells are still combined into one rate per model — this
 * fixes what gets pooled, not the fact that this caller pools at all.
 */
function sharedCellRates(
  snapshot: EvalV2Snapshot,
  fromModel: string,
  toModel: string,
  graderId: AgentGraderId,
): { from: CombinedRate; to: CombinedRate } {
  const fromCells = cellsOf(snapshot, fromModel, graderId);
  const toCells = cellsOf(snapshot, toModel, graderId);
  let fromN = 0;
  let fromPasses = 0;
  let toN = 0;
  let toPasses = 0;
  for (const [key, fromCell] of fromCells) {
    const toCell = toCells.get(key);
    if (!toCell) continue; // fromModel sampled this cell, toModel didn't: not shared, excluded from both totals.
    fromN += fromCell.n;
    fromPasses += fromCell.passes;
    toN += toCell.n;
    toPasses += toCell.passes;
  }
  return {
    from: { n: fromN, passes: fromPasses, rate: fromN > 0 ? fromPasses / fromN : null },
    to: { n: toN, passes: toPasses, rate: toN > 0 ? toPasses / toN : null },
  };
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
 * snapshot, the two models don't share enough sampled (surface, task type) cells, or the
 * candidate is meaningfully worse over the cells they do share — every one of those is "no
 * claim", never a claim built on partial or mismatched evidence. A pair with no meaningful cell
 * overlap (e.g. one model only ever ran outreach tasks, the other only landing pages) is "not
 * comparable", the same as a pair with too little data outright — see sharedCellRates.
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
  const { from, to } = sharedCellRates(snapshot, fromModel, toModel, graderId);
  // minN applies to the SHARED-cell totals, not each model's independently pooled total: a model
  // can have plenty of overall data and still share almost none of it with this particular
  // candidate, and that thin overlap is exactly the case that must not read as validated.
  if (from.n < minN || to.n < minN || from.rate === null || to.rate === null) return undefined;
  if (to.rate < from.rate - tolerance) return undefined;

  return {
    status: 'task_verified',
    source: 'task_eval',
    reason:
      `Sampled production task-success rate is ${Math.round(to.rate * 100)}% on ${to.n} scored sessions ` +
      `for this model, vs ${Math.round(from.rate * 100)}% on ${from.n} for your current one, over the task types you both ran — measured, not a general benchmark.`,
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
