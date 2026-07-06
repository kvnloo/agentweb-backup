/**
 * waitSecondsBudget — a pure helper that caps a requested `wait_seconds` sleep to
 * the run's remaining wall-clock budget (ENG-124).
 *
 * The agent-mode generation is wrapped in a hard wall-clock timeout
 * (`withGenerationTimeout`) that force-rejects the whole run. `wait_seconds` is
 * the only tool that deliberately `await`s a timer, so a long sleep still in
 * progress when that ceiling fires is rejected from the outside and recorded as a
 * spurious `wait_seconds` FAILURE (seen in the ENG-124 repro: while polling a
 * not-yet-ready scheduled-chat test run the model inserted several long waits, and
 * one was guillotined by the timeout → `failedFunctions.wait_seconds`).
 *
 * Clamping the sleep to the remaining budget (minus a safety margin) means the
 * wait always returns gracefully — the model is told the run is near its limit and
 * to check the result now instead of waiting again — rather than being killed.
 *
 * Pure and dependency-free so it can be unit-tested directly and wired into the
 * `wait_seconds` tool without loading the agent-mode monolith.
 */

/**
 * Input schema for the `wait_seconds` tool. Extracted here so the tool definition
 * and its contract test share ONE source of truth.
 *
 * `reason` is intentionally NOT in `required`: the model (gemini/opus) routinely
 * omits this cosmetic, user-facing label, and marking it required made
 * validateAndRepairToolArgs reject the call BEFORE execution — recorded as a
 * spurious wait_seconds failure on its very first call (ENG-124). Only `seconds`
 * is required.
 */
export const WAIT_SECONDS_PARAMETERS = {
  type: 'object',
  properties: {
    seconds: {
      type: 'number',
      description: 'Number of seconds to wait (max 300)',
    },
    reason: {
      type: 'string',
      description: 'Brief explanation of what you are waiting for (shown to the user)',
    },
  },
  required: ['seconds'],
} as const;

export interface WaitBudgetInput {
  /** Seconds the model asked to wait. */
  requestedSeconds: unknown;
  /** Absolute epoch-ms deadline by which the run should wrap up. Omit/undefined to disable capping. */
  deadlineMs?: number;
  /** Current epoch ms (injectable for tests). Defaults to Date.now(). */
  nowMs?: number;
  /** Safety margin (seconds) to stop short of the deadline. Default 5. */
  marginSeconds?: number;
  /** Hard upper bound on a single wait (seconds). Default 300. */
  maxSeconds?: number;
}

export interface WaitBudgetResult {
  /** Actual seconds to sleep (>= 0). */
  seconds: number;
  /** The normalized requested value (clamped to [1, maxSeconds]). */
  requestedSeconds: number;
  /** True when the run deadline forced a shorter (or zero) wait. */
  deadlineReached: boolean;
}

/**
 * Normalize the model-supplied `seconds` to an integer in [1, maxSeconds]. A
 * non-finite value (missing/NaN) falls back to 1 — the previous inline logic let
 * NaN flow into setTimeout (an effective 0-length wait); 1s is the closest sane,
 * schema-honoring floor.
 */
function normalizeRequested(requestedSeconds: unknown, maxSeconds: number): number {
  const rounded = Math.round(Number(requestedSeconds));
  if (!Number.isFinite(rounded)) return 1;
  return Math.min(Math.max(1, rounded), maxSeconds);
}

export function computeWaitSeconds(input: WaitBudgetInput): WaitBudgetResult {
  const maxSeconds = Number.isFinite(input.maxSeconds as number) ? (input.maxSeconds as number) : 300;
  const marginSeconds = Number.isFinite(input.marginSeconds as number) ? (input.marginSeconds as number) : 5;
  const requested = normalizeRequested(input.requestedSeconds, maxSeconds);

  // No usable deadline → behave exactly as before (sleep the full requested time).
  if (!Number.isFinite(input.deadlineMs as number)) {
    return { seconds: requested, requestedSeconds: requested, deadlineReached: false };
  }

  const now = Number.isFinite(input.nowMs as number) ? (input.nowMs as number) : Date.now();
  const remaining = Math.floor(((input.deadlineMs as number) - now) / 1000) - marginSeconds;

  if (remaining >= requested) {
    return { seconds: requested, requestedSeconds: requested, deadlineReached: false };
  }

  return { seconds: Math.max(0, remaining), requestedSeconds: requested, deadlineReached: true };
}
