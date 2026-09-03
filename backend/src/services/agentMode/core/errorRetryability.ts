/**
 * Instructive-error retryability at the gateway edge (ENG-124 — the
 * retry-spiral half).
 *
 * Every tool error fed back to the model already says WHAT failed
 * (formatToolError names the tool + reason, with per-tool fix guidance for the
 * known repeat offenders). What it did NOT say is whether retrying the same
 * call can possibly help. The June telemetry retry-spirals (linkedin_outreach
 * 15× in 16s against the same two errors) happened because the model got no
 * explicit stop signal for terminal failures.
 *
 * This module derives an explicit `Retryable: yes/no` verdict + actionable next
 * step from the toolErrorClassifier classes (utils/toolErrorClassifier.ts):
 *
 *   rate_limit / timeout / network / upstream_5xx / truncated_response → transient → retryable
 *   auth / upstream_rejected / invalid_args (schema reject) / tool_unavailable /
 *   invalid_output / policy_blocked / subscription_blocked
 *                                                  → terminal  → NOT retryable
 *   anything else (legacy/unknown classes)         → conservative: NOT retryable
 *                                                    as an identical call
 *
 * The FAST_TRIP subset additionally lowers the per-run circuit-breaker
 * threshold in agentToolGatewayService (2 identical failures instead of 3):
 * for those classes a retry is KNOWN-pointless, so the gateway stops the
 * spiral one attempt earlier. empty_result / not_found are deliberately NOT
 * fast-tripped — their error text is identical across different arguments
 * ("No search results found"), so two legitimate different-args attempts would
 * otherwise trip the breaker.
 *
 * PURE: no imports from the monolith, no I/O. Used by core/toolDispatch.ts
 * (model-visible guidance) and agentToolGatewayService.ts (breaker threshold).
 */

/** Transient classes — an identical retry can plausibly succeed. */
export const RETRYABLE_ERROR_CLASSES: ReadonlySet<string> = new Set([
  'rate_limit',
  'timeout',
  'network',
  'upstream_5xx',
  /*
   * Retryable because the common causes (a throttle, a transient page failure) clear on their
   * own, and because the alternative verdict is worse: a "do NOT retry" on a read that was
   * merely rate-limited leaves the model with no way to finish and every incentive to report
   * the thing it was looking for as missing. The next step below tells it which sub-case it is.
   */
  'read_incomplete',
  // A tool call's arguments were a clean-but-incomplete JSON prefix (the
  // stream got cut off, not a bad-args mistake) — retrying the identical
  // call can plausibly produce a complete response next time (ENG-1477
  // follow-up).
  'truncated_response',
]);

/**
 * Terminal classes where an identical retry is KNOWN-pointless — these lower
 * the per-run repeated-failure breaker threshold to 2 (see
 * agentToolGatewayService). Deliberately excludes empty_result / not_found
 * (same error text across different, legitimate arguments).
 */
export const FAST_TRIP_ERROR_CLASSES: ReadonlySet<string> = new Set([
  'auth',
  'upstream_rejected',
  'invalid_args',
  'tool_unavailable',
  'invalid_output',
  'policy_blocked',
  'subscription_blocked',
  'scope_refused',
  // finding 8: the one non-retryable class that was missing, on the class whose whole meaning is
  // "an identical retry is known-pointless".
  'read_bounded',
]);

export function isRetryableErrorClass(errorClass: string): boolean {
  return RETRYABLE_ERROR_CLASSES.has(errorClass);
}

export function isFastTripErrorClass(errorClass: string): boolean {
  return FAST_TRIP_ERROR_CLASSES.has(errorClass);
}

/** Per-class actionable next step. Keyed by classifier class; the default is
 * the conservative no-blind-retry instruction for unknown/legacy classes. */
const NEXT_STEP_BY_CLASS: Record<string, string> = {
  rate_limit: 'the service is rate-limiting. Wait (e.g. 60s, or use wait_seconds) before ONE retry, or reduce request volume.',
  timeout: 'the operation timed out. Wait briefly, then retry ONCE; if it times out again, stop and report the blocker to the user.',
  network: 'transient network failure. Retry ONCE; if it fails again, stop and report the blocker to the user.',
  upstream_5xx: 'the upstream service errored. Wait briefly, then retry ONCE; if it fails again, stop and report the blocker to the user.',
  auth: 'authentication/permission problem. Do NOT retry — the same call will keep failing. Tell the user to (re)connect the account or fix permissions.',
  upstream_rejected: 'the provider deliberately refused this action (business rule). Do NOT retry the same call — explain the refusal to the user and follow its guidance.',
  invalid_args: 'the arguments were invalid. Do NOT repeat the identical call — fix the arguments to exactly match the tool schema first, then retry with the corrected arguments.',
  tool_unavailable: 'this tool is not available in this session. Do NOT retry it — install the required skill via install_skills, or tell the user the capability is not enabled. Do NOT present another tool\'s output as this tool\'s result.',
  /*
   * The plan does not include the skill. The ONLY correct next move is to tell the user; there
   * is no alternative tool that produces this tool's result, and saying "use a different tool"
   * here is what turns a refusal into a fabricated answer (ENG-1625).
   */
  scope_refused: 'the requested object is not in the selected ad account. Do NOT retry it, and do NOT fall back to an account-wide or unscoped list — widening the read is precisely what this refusal prevents. Select the ad account that owns the object, or tell the user it is not available in the one they are using.',
  read_bounded: 'the read stopped at a fixed scope or time bound and will stop in the same place every time, so retrying the identical call cannot help — and it is NOT evidence that anything is absent; never report an item as missing based on it. Narrow the scope instead: a specific sub-folder, campaign or ad set, or ask the user for a direct link.',
  read_incomplete: 'the read did not finish, so it is NOT evidence that anything is absent — never report an item as missing based on this result. If it was throttled or failed transiently, wait briefly and retry ONCE; if it stopped at a scope or budget bound, narrow the scope (a specific folder, campaign or ad set, or ask the user for a direct link) rather than repeating the identical call.',
  subscription_blocked: 'the required skill is not included in the user\'s subscription. Do NOT retry it and do NOT substitute another tool — tell the user plainly that this capability is not on their plan.',
  invalid_output: 'the tool ran but produced no usable output. Do NOT repeat the identical call — change the arguments/approach or use a different tool.',
  policy_blocked: 'the tool gateway policy blocked this call. Do NOT retry it — follow the policy guidance or tell the user what is blocked.',
  not_found: 'the target was not found. Do NOT repeat the identical call — verify the identifier/name first or ask the user.',
  empty_result: 'the call succeeded but returned nothing. Do NOT repeat the identical call — broaden the query or try a different source.',
  truncated_response: 'your previous response for this call was cut off mid-generation — there is nothing wrong with the arguments themselves. Retry the SAME tool call and emit the complete arguments in one go, including every required field.',
};

const DEFAULT_NEXT_STEP =
  'do NOT retry the identical call. Change the arguments or approach, use a different tool, or report the blocker to the user.';

/** The model-visible verdict line, e.g. `[Retryable: no — Do NOT retry …]`. */
export function retryabilityLine(errorClass: string): string {
  const retryable = isRetryableErrorClass(errorClass);
  const nextStep = NEXT_STEP_BY_CLASS[errorClass] ?? DEFAULT_NEXT_STEP;
  // Non-retryable next steps must carry the literal stop signal the model keys on.
  const decorated = retryable || /do not retry/i.test(nextStep) ? nextStep : `Do NOT retry as-is — ${nextStep}`;
  return `[Retryable: ${retryable ? 'yes' : 'no'} — ${decorated}]`;
}

/** Append the retryability verdict on its own line after the formatted error,
 * preserving the formatted error (what failed + per-tool fix text) verbatim. */
export function appendRetryabilityGuidance(formattedError: string, errorClass: string): string {
  return `${formattedError}\n${retryabilityLine(errorClass)}`;
}
