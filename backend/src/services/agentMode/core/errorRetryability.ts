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
 *   rate_limit / timeout / network / upstream_5xx → transient → retryable
 *   auth / upstream_rejected / invalid_args (schema reject) / tool_unavailable /
 *   invalid_output / policy_blocked                → terminal  → NOT retryable
 *   anything else (legacy/unknown classes)         → conservative: NOT retryable
 *                                                    as an identical call
 *
 * The FAST_TRIP subset additionally lowers the per-run circuit-breaker
 * threshold in agentToolGatewayService (2 identical failures instead of 3):
 * for those classes a retry is KNOWN-pointless, so the gateway stops the
 * spiral one attempt earlier. empty_result / not_found / invalid_args are
 * deliberately NOT fast-tripped — their error text is identical across
 * different arguments ("No search results found", "Invalid parameters"), so two
 * legitimate different-args attempts would otherwise trip the breaker (ENG-197).
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
]);

/**
 * Terminal classes where an identical retry is KNOWN-pointless — these lower
 * the per-run repeated-failure breaker threshold to 2 (see
 * agentToolGatewayService). Deliberately excludes empty_result / not_found
 * (same error text across different, legitimate arguments).
 *
 * ENG-197: invalid_args is also excluded. Schema-reject invalid_args is caught
 * PRE-dispatch (AgentToolContractValidationError) and never reaches the breaker,
 * so the only invalid_args the breaker ever counts are EXECUTION-time refusals
 * (e.g. LinkedIn's generic "Invalid parameters" for an over-limit invite note).
 * That error text is identical across legitimately different arguments — a
 * send-invite batch to five distinct profiles — so fast-tripping it at 2 locked
 * the whole run out of send-invite after two per-note failures, blocking even
 * corrected notes and unrelated profiles. Keep it at the default threshold (3),
 * exactly like empty_result / not_found. This does NOT change the model-facing
 * verdict: invalid_args stays NON-retryable-as-identical (see
 * RETRYABLE_ERROR_CLASSES / NEXT_STEP_BY_CLASS), so the "fix the arguments
 * first" guidance is unchanged.
 */
export const FAST_TRIP_ERROR_CLASSES: ReadonlySet<string> = new Set([
  'auth',
  'upstream_rejected',
  'tool_unavailable',
  'invalid_output',
  'policy_blocked',
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
  tool_unavailable: 'this tool is not available in this session. Do NOT retry it — install the required skill via install_skills or use a different tool.',
  invalid_output: 'the tool ran but produced no usable output. Do NOT repeat the identical call — change the arguments/approach or use a different tool.',
  policy_blocked: 'the tool gateway policy blocked this call. Do NOT retry it — follow the policy guidance or tell the user what is blocked.',
  not_found: 'the target was not found. Do NOT repeat the identical call — verify the identifier/name first or ask the user.',
  empty_result: 'the call succeeded but returned nothing. Do NOT repeat the identical call — broaden the query or try a different source.',
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
