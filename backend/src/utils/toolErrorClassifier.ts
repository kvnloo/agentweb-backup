/**
 * classifyToolErrorClass — semantic taxonomy for agent tool failures.
 *
 * The June 9-12 runtime-spine telemetry recorded errorClass "Error" on every
 * one of the 60+ tool failures: most tools throw plain `new Error(message)`,
 * so the constructor-name fallback carried zero signal. The failure policy
 * could only cluster by tool name, and the model could not tell a retryable
 * timeout from a terminal auth failure.
 *
 * Classes are intentionally coarse and stable — they feed the agent-mode
 * loop's failure clustering and the inspector UI, so renaming one is a
 * breaking change for historical queries:
 *   timeout | auth | rate_limit | invalid_args | not_found | network |
 *   upstream_5xx | policy_blocked | repeated_failure |
 *   tool_unavailable | upstream_rejected | empty_result | invalid_output
 *
 * The three trailing classes were added 2026-06-14 after a 7-day production
 * sweep of Dev-AW-LoopEvents `agent_tool_failed` events: re-classifying the
 * 283 real failures with the prior patterns still left 63% in the generic
 * `Error` fallback (dev.md target was <20%). The real residual clusters were:
 *   - tool_unavailable  (~41) "Tool \"X\" is not available. You must install
 *                        the required skill first using install_skills." — the
 *                        model called an uninstalled skill; not a bug, a config
 *                        gap. Largest single missed cluster.
 *   - invalid_args      (~45 newly caught) "...arguments failed schema
 *                        validation...", "has the wrong type", "Missing
 *                        required argument/variable" — model emitted bad args.
 *   - upstream_rejected (~28) LinkedIn business-rule refusals: "Cannot resend
 *                        yet", "Should delay new invitation to this recipient",
 *                        "not a 1st-degree connection". The provider accepted
 *                        the call and deliberately refused the action —
 *                        terminal + actionable, distinct from a 5xx or a bug.
 *   - empty_result      (~9) "No search results found", "Unable to retrieve a
 *                        Summarizer summary.", "No analysis results received
 *                        from Gemini" — the call succeeded but yielded nothing.
 * New fallback rate on the same 283-failure set: ~10%. The ~29 residual are
 * genuinely idiosyncratic one-offs ("Unknown error", "success=false", file
 * hash mismatch) that do not form a clusterable class.
 *
 * Unrecognized errors fall back to the legacy name-based class (explicit
 * `.name`, else constructor name) so named custom errors lose nothing.
 */

const GATEWAY_NAME_CLASSES: Record<string, string> = {
  AgentToolBudgetExceededError: 'repeated_failure',
  AgentToolPolicyBlockedError: 'policy_blocked',
  AgentToolRepeatedFailureError: 'repeated_failure',
  AgentToolContractValidationError: 'invalid_args',
  // A tool returned without throwing but produced no usable output (ENG-105).
  // Distinct from an execution failure so telemetry can separate "tool ran and
  // gave us nothing" from "tool errored".
  ToolOutputContractError: 'invalid_output',
  TimeoutError: 'timeout',
  AbortError: 'timeout',
};

function classFromStatus(status: number): string | null {
  if (status === 401 || status === 403) return 'auth';
  if (status === 404) return 'not_found';
  if (status === 408 || status === 504) return 'timeout';
  if (status === 429) return 'rate_limit';
  if (status === 400 || status === 422) return 'invalid_args';
  if (status >= 500) return 'upstream_5xx';
  return null;
}

function classFromMessage(message: string): string | null {
  const m = message.toLowerCase();

  // HTTP status embedded in the message ("status code 429", "503 Service…").
  const statusMatch = m.match(/(?:status(?:\s+code)?\s+|^|\s)([45]\d{2})(?:\s|$|[^\d])/);
  if (statusMatch) {
    const byStatus = classFromStatus(Number(statusMatch[1]));
    if (byStatus) return byStatus;
  }

  // Uninstalled-skill calls — checked first so "install the required skill"
  // text never gets misread by a later branch. The model invoked a tool the
  // user has not enabled; a config gap, not a failure of the tool itself.
  if (/is not available\. you must install the required skill|install_skills/.test(m)) return 'tool_unavailable';

  if (/etimedout|timed?\s*out|deadline exceeded|operation was aborted/.test(m)) return 'timeout';
  if (/too many requests|rate limit|quota exceeded/.test(m)) return 'rate_limit';

  // Bad arguments the model emitted — schema-validation rejections (the
  // contract layer rejects before execution) plus classic validation phrasing.
  if (/arguments failed schema validation|has the wrong type|missing required (argument|variable)|invalid parameters?|invalid argument|validation (failed|error)|(is|are) required|must be|is too long|too long \(|is too short/.test(m)) return 'invalid_args';

  if (/unauthorized|forbidden|invalid (access |api )?token|invalid api key|authentication|missing credentials|not authorized|do not have permission|permission to|no secrets configured|not a member of channel|account connected|account not configured|not configured to access/.test(m)) return 'auth';
  if (/enotfound|econnrefused|econnreset|eai_again|socket hang up|network error|fetch failed/.test(m)) return 'network';
  if (/does not exist|not found/.test(m)) return 'not_found';
  if (/internal server error|bad gateway|service unavailable|upstream/.test(m)) return 'upstream_5xx';
  // Meta Graph transient (codes 1/2): the SDK/campaign path surfaces Meta's generic
  // body verbatim with NO HTTP status in the string, so the status-regex above misses
  // it. Meta classifies these as "temporary, wait & retry" (metaService codes 1/2/4/17
  // → RETRYABLE_ERROR); treat as retryable upstream instead of a terminal legacy class.
  if (/an unexpected error has occurred\.?\s*please retry/.test(m)) return 'upstream_5xx';

  // Upstream accepted the call and deliberately refused the action (provider
  // business rules — LinkedIn invite/message cadence + connection-degree
  // gates). Terminal + actionable, distinct from a transport 5xx or a bug.
  if (/cannot resend yet|should delay new invitation|recipient cannot be reached|already connected with this person|not a 1st-degree connection|not a \d.{0,4}degree connection|cannot send (invite|message)/.test(m)) return 'upstream_rejected';

  // Call succeeded but produced nothing usable — distinct from a hard error;
  // the model should broaden/retry the query rather than treat it as broken.
  if (/no (search )?results? (found|received)|unable to retrieve|no analysis results|returned no results/.test(m)) return 'empty_result';

  return null;
}

/** Legacy fallback — what errorClassOf in the run recorder produced before. */
function legacyNameClass(error: unknown): string {
  if (error instanceof Error) {
    if (error.name && error.name !== 'Error') return error.name;
    return error.constructor?.name || 'Error';
  }
  if (typeof error === 'string') return 'StringError';
  return 'UnknownError';
}

export function classifyToolErrorClass(error: unknown): string {
  if (error instanceof Error) {
    // Check both the explicit .name and the constructor name — `class
    // TimeoutError extends Error {}` inherits .name === 'Error'.
    const byName = GATEWAY_NAME_CLASSES[error.name]
      ?? GATEWAY_NAME_CLASSES[error.constructor?.name ?? ''];
    if (byName) return byName;

    const statusProp = (error as { status?: unknown }).status
      ?? (error as { statusCode?: unknown }).statusCode;
    if (typeof statusProp === 'number') {
      const byStatus = classFromStatus(statusProp);
      if (byStatus) return byStatus;
    }

    const byMessage = classFromMessage(error.message ?? '');
    if (byMessage) return byMessage;
  } else if (typeof error === 'string') {
    const byMessage = classFromMessage(error);
    if (byMessage) return byMessage;
  }

  return legacyNameClass(error);
}
