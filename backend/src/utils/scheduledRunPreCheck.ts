/**
 * ENG-1259 — cheap pre-check gate for scheduled chat runs.
 *
 * Recurring scheduled chats were running the ENTIRE multi-step generative
 * flow before determining whether there was anything worth doing, and the
 * full attempt is billed regardless of outcome. PMPS's `LUCAS — LinkedIn
 * Thought Leadership (Mon/Wed/Fri)` scheduled chat is the schedule the waste
 * was found on: four real occurrences that each ran the full flow (41-129
 * messages) before concluding there was nothing to publish —
 * "Schedule skipped" x3 ($21.61 / $12.36 / $12.32) and "Nothing Published"
 * x1 ($11.35). The "is this worth doing" determination was happening at the
 * END of the expensive path, not the start.
 *
 * This module is the PURE decision logic for a cheap gate inserted BEFORE
 * the expensive path in `runScheduledChat` (agentModeController.ts):
 *
 *   1. `shouldRunPreCheckGate` — a free, deterministic trigger. The gate only
 *      even considers spending a cheap classification call when the run
 *      immediately preceding this one had no actionable output — exactly the
 *      repeat-waste pattern in the evidence above. A healthy schedule (last
 *      run produced real output, or this is its first-ever run) pays nothing
 *      extra: this returns false and the caller proceeds exactly as today.
 *   2. `resolvePreCheckDecision` — folds the cheap model's classification
 *      (see agentModeService.evaluateScheduledRunPreCheck) into a final
 *      proceed/skip decision. Fails TOWARD running, always: only an explicit
 *      "skip" at "high" confidence short-circuits the expensive flow.
 *      Anything else — proceed, ambiguous, low confidence, a malformed
 *      value, or the model call itself failing — resolves to "proceed". A
 *      gate that silently skips real, value-producing work because it
 *      guessed wrong is a worse failure than occasionally spending a bit
 *      more on an unnecessary full run (ENG-1259 acceptance criterion 4).
 *
 * No I/O, no network, no LLM call — fully unit-testable without mocks. The
 * LLM call itself is a separate, thin wrapper on agentModeService so the
 * decision logic here stays pure.
 */

/** A stored run-result entry from `AW-TaskSchedules.runResults` (shape is intentionally loose — see scheduleDb.addRunResult). */
export interface ScheduledRunResultLike {
  status?: string;
  passed?: boolean;
  conditionalSkip?: boolean;
  actualResponse?: string;
  summary?: string;
  createdAt?: string;
  [key: string]: unknown;
}

/** Raw classification from the cheap pre-check LLM call (agentModeService.evaluateScheduledRunPreCheck). Deliberately loose-typed on decision/confidence — the model's output is untrusted input and validated here, not assumed. */
export interface ScheduledRunPreCheckLLMResult {
  decision: string;
  confidence: string;
  reason: string;
}

export type PreCheckDecision = 'proceed' | 'skip';

export interface ScheduledRunPreCheckOutcome {
  decision: PreCheckDecision;
  reason: string;
}

/**
 * A stored run result counts as "no actionable output" when the run either:
 *  - legitimately short-circuited on a conditional CADENCE guard (ENG-844,
 *    `conditionalSkip: true` — status is 'success' but zero write calls were
 *    made by design), or
 *  - is this gate's own prior skip (`status: 'skipped_no_content'`), or
 *  - failed to meet its requirements (`status: 'failure'`) — the shape every
 *    one of the LUCAS "Schedule skipped" / "Nothing Published" runs in the
 *    evidence actually took, since the model correctly declined to publish
 *    but that decline did not match ENG-844's narrow cadence-skip carve-out.
 *
 * A genuine success or a parked `pending_user_input` run is NOT no-actionable-
 * output — both represent real progress (a publish, or a run waiting on a
 * human), and must never be folded into this gate's trigger.
 */
export function wasNoActionableOutputRun(result: ScheduledRunResultLike | null | undefined): boolean {
  if (!result || typeof result !== 'object') return false;
  if (result.conditionalSkip === true) return true;
  if (result.status === 'skipped_no_content') return true;
  if (result.status === 'failure') return true;
  return false;
}

/**
 * How many runs, counted back from the most recent, were consecutively
 * "no actionable output". Stops at the first productive run (success or
 * pending_user_input) walking backwards, mirroring
 * `computeScheduleRunHealth`'s consecutiveFailures pattern in
 * agentModeController.ts but scoped to this gate's broader "no output"
 * definition (which also covers conditionalSkip and skipped_no_content).
 */
export function countTrailingNoActionableOutputRuns(
  runResults: ScheduledRunResultLike[] | null | undefined
): number {
  const results = Array.isArray(runResults) ? runResults : [];
  let count = 0;
  for (let i = results.length - 1; i >= 0; i--) {
    if (wasNoActionableOutputRun(results[i])) count++;
    else break;
  }
  return count;
}

/**
 * Free, deterministic trigger for the cheap pre-check gate. Only the
 * immediately preceding run matters — not any deeper streak — because a
 * single productive run is proof the schedule is currently healthy and the
 * gate has nothing to catch. Returns false (no LLM call, zero added cost)
 * when there is no run history yet or the last run was productive.
 */
export function shouldRunPreCheckGate(runResults: ScheduledRunResultLike[] | null | undefined): boolean {
  const results = Array.isArray(runResults) ? runResults : [];
  if (results.length === 0) return false;
  return wasNoActionableOutputRun(results[results.length - 1]);
}

/**
 * Fold the cheap model's classification into a final gate decision.
 * FAILS TOWARD RUNNING, always (ENG-1259 AC4): a skip requires BOTH an
 * explicit "skip" decision AND "high" confidence. Everything else —
 * "proceed", "ambiguous", "skip" at "low" confidence, a malformed/unexpected
 * value, or `null` (the LLM call itself errored, timed out, or returned
 * unparseable output) — resolves to "proceed".
 */
export function resolvePreCheckDecision(
  llmResult: ScheduledRunPreCheckLLMResult | null
): ScheduledRunPreCheckOutcome {
  if (!llmResult) {
    return { decision: 'proceed', reason: 'precheck_unavailable_fail_open' };
  }
  if (llmResult.decision === 'skip' && llmResult.confidence === 'high') {
    return { decision: 'skip', reason: llmResult.reason || 'precheck_confident_no_new_content' };
  }
  return { decision: 'proceed', reason: llmResult.reason || 'precheck_ambiguous_fail_toward_running' };
}
