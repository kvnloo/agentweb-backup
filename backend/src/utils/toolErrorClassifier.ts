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
 *   upstream_5xx | policy_blocked | repeated_failure
 *
 * Unrecognized errors fall back to the legacy name-based class (explicit
 * `.name`, else constructor name) so named custom errors lose nothing.
 */

const GATEWAY_NAME_CLASSES: Record<string, string> = {
  AgentToolPolicyBlockedError: 'policy_blocked',
  AgentToolRepeatedFailureError: 'repeated_failure',
  AgentToolContractValidationError: 'invalid_args',
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

  if (/etimedout|timed?\s*out|deadline exceeded/.test(m)) return 'timeout';
  if (/too many requests|rate limit|quota exceeded/.test(m)) return 'rate_limit';
  if (/unauthorized|forbidden|invalid (access |api )?token|invalid api key|authentication|missing credentials/.test(m)) return 'auth';
  if (/enotfound|econnrefused|econnreset|eai_again|socket hang up|network error|fetch failed/.test(m)) return 'network';
  if (/not found/.test(m)) return 'not_found';
  if (/invalid parameters?|invalid argument|validation (failed|error)|is required|must be|is too long|too long \(|is too short/.test(m)) return 'invalid_args';
  if (/internal server error|bad gateway|service unavailable|upstream/.test(m)) return 'upstream_5xx';

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
