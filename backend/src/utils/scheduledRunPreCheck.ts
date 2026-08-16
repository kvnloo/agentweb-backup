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
 *   3. `shouldForceProceedAfterSkipStreak` — a hard ceiling on the gate's OWN
 *      risk. The classifier only ever reasons from static history, so a
 *      confidently-wrong verdict (or a genuine change in circumstance the
 *      history-only signal cannot see) could otherwise repeat forever. Once
 *      the trailing streak of THIS GATE's own skips reaches a small cap, the
 *      next due run is forced through the full flow, guaranteeing a real
 *      check-in no matter what the classifier would say. A genuine full-flow
 *      decline (a real "ran and had nothing to publish" result) does not
 *      count toward this — only skips this gate itself caused do.
 *
 * `wasNoActionableOutputRun` — the trigger's core predicate — deliberately
 * requires more than a bare `status: 'failure'`: that status also covers
 * pre-flight blocks that never reached the model (an entitlement check, a
 * token-limit cap, an orphaned schedule owner, a generic exception before any
 * turn ran), all of which this codebase records with `attempt: 0`. Folding
 * those into "no actionable output" would suppress the retry those failures
 * are supposed to get on the schedule's next fire — so a `'failure'` only
 * counts when the run actually spent at least one real attempt against the
 * model (`attempt >= 1`).
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
  /**
   * runVerifiedChat's attempt counter. Every genuine full-flow completion
   * (success, conditionalSkip, or a real "ran and didn't meet requirements"
   * failure) sets this to the number of attempts actually spent (>= 1). Every
   * pre-flight block that never reaches the model — an entitlement check, a
   * token-limit cap, an orphaned schedule owner, a disallowed-function check,
   * or a generic exception caught before any turn ran — hardcodes this to 0.
   * `wasNoActionableOutputRun` uses this to tell the two apart (Greptile P1).
   */
  attempt?: number;
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
 *  - genuinely RAN — at least one real turn against the model — and still
 *    failed to meet its requirements (`status: 'failure'` AND `attempt >= 1`)
 *    — the shape every one of the LUCAS "Schedule skipped" / "Nothing
 *    Published" runs in the evidence actually took, since the model
 *    correctly declined to publish but that decline did not match ENG-844's
 *    narrow cadence-skip carve-out.
 *
 * A bare `status: 'failure'` is deliberately NOT enough on its own (Greptile
 * P1, ENG-1259): the same status also covers pre-flight blocks that never
 * reached the model at all — a subscription/entitlement check, a token-limit
 * cap, an orphaned schedule owner, a disallowed-function check, or a generic
 * exception caught before any turn ran — every one of which this codebase
 * records with `attempt: 0`. Those are NOT evidence of "nothing to publish";
 * they are evidence the run never got a fair shot, and the schedule's next
 * fire is supposed to retry, not have this gate reason from a history entry
 * that was never a real judgment. Requiring `attempt >= 1` excludes all of
 * them without having to enumerate each failure shape by name.
 *
 * A genuine success or a parked `pending_user_input` run is NOT no-actionable-
 * output — both represent real progress (a publish, or a run waiting on a
 * human), and must never be folded into this gate's trigger.
 */
export function wasNoActionableOutputRun(result: ScheduledRunResultLike | null | undefined): boolean {
  if (!result || typeof result !== 'object') return false;
  if (result.conditionalSkip === true) return true;
  if (result.status === 'skipped_no_content') return true;
  if (result.status === 'failure' && typeof result.attempt === 'number' && result.attempt >= 1) {
    return true;
  }
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
 * How many runs, counted back from the most recent, were consecutively a
 * pre-check SKIP specifically (`status: 'skipped_no_content'`) — narrower
 * than `countTrailingNoActionableOutputRuns`, which also counts genuine
 * full-flow runs that had nothing to publish. This narrower count is what
 * bounds the gate's OWN risk of silently starving a schedule of real runs
 * (Greptile P1, ENG-1259): a genuine decline (conditionalSkip / a real
 * unmet-requirements failure) is information gathered by actually running
 * the task; a chain of pre-check skips is not — the cheap classifier never
 * checks live reality, it only reasons from the same static history each
 * time, so a confidently-wrong verdict (or a genuine change in circumstance
 * the history-only signal cannot see) could otherwise repeat forever.
 */
export function countTrailingGateSkips(runResults: ScheduledRunResultLike[] | null | undefined): number {
  const results = Array.isArray(runResults) ? runResults : [];
  let count = 0;
  for (let i = results.length - 1; i >= 0; i--) {
    if (results[i]?.status === 'skipped_no_content') count++;
    else break;
  }
  return count;
}

/**
 * After this many consecutive pre-check skips, the next due run is forced to
 * proceed through the full flow — bypassing the classifier entirely — rather
 * than asking it again. A periodic real check-in, sized small deliberately:
 * this still captures the large majority of the waste in the evidence (three
 * of LUCAS's four occurrences would have been caught) while guaranteeing the
 * schedule cannot go silent for more than this many fires in a row.
 */
export const MAX_CONSECUTIVE_GATE_SKIPS = 2;

/**
 * True when the trailing pre-check-skip streak has reached the cap and this
 * due run must be forced through the full flow, skipping the classifier call
 * entirely (saving even that small cost on the forced-proceed run).
 */
export function shouldForceProceedAfterSkipStreak(
  runResults: ScheduledRunResultLike[] | null | undefined,
  maxConsecutiveSkips: number = MAX_CONSECUTIVE_GATE_SKIPS
): boolean {
  return countTrailingGateSkips(runResults) >= maxConsecutiveSkips;
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
