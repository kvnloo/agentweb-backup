export const SESSION_LIMIT_ERROR_CODES = [
  'SESSION_MESSAGE_LIMIT_EXCEEDED',
  'SESSION_SIZE_LIMIT_EXCEEDED'
];

export function isSessionLimitError(error: unknown): error is Error {
  if (!error) return false;
  const message = error instanceof Error ? error.message : String(error);
  return SESSION_LIMIT_ERROR_CODES.some((code) => message.includes(code));
}

const CONTEXT_LIMIT_PATTERNS = [
  /context length/i,
  /maximum context/i,
  /context window/i,
  /token limit/i,
  /too many tokens/i,
  /prompt is too long/i,
  /input is too long/i,
  /exceeds.*context/i,
  /exceeded.*tokens/i,
  /maximum.*tokens/i,
  /messages.*exceed/i,
  /request too large/i
];

export function isContextLimitError(error: unknown): boolean {
  if (!error) return false;
  const message = error instanceof Error ? error.message : String(error);
  // Also check originalMessage from wrapped errors (generateMarketingResponse preserves it)
  const originalMessage = (error as any)?.originalMessage || '';
  return CONTEXT_LIMIT_PATTERNS.some((pattern) => pattern.test(message) || pattern.test(originalMessage));
}

// ENG-2185: OpenRouter's admission control on a spend-limited key rejects a
// request whose WORST-CASE cost (input tokens + requested max_tokens) exceeds
// the remaining balance — even though actual usage is normally far less (see
// AGENT_MODE_MAX_OUTPUT_TOKENS's own comment: "Models only emit what they
// need"). The message names exactly how many tokens the remaining balance
// covers, so capping max_tokens to that and retrying can still succeed
// instead of hard-failing while the key sits well short of its configured
// limit. This does not request any additional spend — it only avoids
// over-asking against a budget that was already there.
const REQUIRES_MORE_CREDITS_MARKER = 'requires more credits';
const CAN_ONLY_AFFORD_MARKER = 'can only afford';
// Anchored, no backtracking: only ever scans the whitespace/digits immediately
// after the marker, regardless of how long the rest of the message is.
const LEADING_DIGITS_PATTERN = /^\s*(\d+)/;
// Real OpenRouter messages are a few hundred chars; this is ample headroom
// without doing unbounded toLowerCase/slice work on a pathological input
// (CodeRabbit follow-up on PR #3117 — the backtracking regex was the real
// risk and is fixed below, but the linear scan itself should still be capped
// rather than proportional to an attacker- or provider-controlled length).
const MAX_ERROR_MESSAGE_SCAN_LENGTH = 2000;

/**
 * Bounded (`indexOf`, not backtracking regex) so an attacker- or
 * provider-controlled error message can't cost more than a couple of linear
 * scans of its length. A prior version used a single regex with an unbounded
 * greedy `.*` between the two markers — CodeRabbit's own benchmark on PR #3117
 * measured that at ~1.43s for a 160KB non-matching message on this exact
 * request path, worth fixing before it ever reaches production traffic.
 */
function parseAffordableTokens(text: string): number | null {
  const bounded = text.length > MAX_ERROR_MESSAGE_SCAN_LENGTH ? text.slice(0, MAX_ERROR_MESSAGE_SCAN_LENGTH) : text;
  const lowered = bounded.toLowerCase();
  const creditsIndex = lowered.indexOf(REQUIRES_MORE_CREDITS_MARKER);
  if (creditsIndex === -1) return null;
  const affordIndex = lowered.indexOf(CAN_ONLY_AFFORD_MARKER, creditsIndex);
  if (affordIndex === -1) return null;
  const digitsMatch = bounded.slice(affordIndex + CAN_ONLY_AFFORD_MARKER.length).match(LEADING_DIGITS_PATTERN);
  if (!digitsMatch) return null;
  const affordable = Number(digitsMatch[1]);
  return Number.isFinite(affordable) && affordable >= 0 ? affordable : null;
}

/** The max_tokens value OpenRouter says the remaining balance affords, or null
 * if `error` isn't this specific insufficient-credits shape. */
export function extractAffordableTokens(error: unknown): number | null {
  if (!error) return null;
  const message = error instanceof Error ? error.message : String(error);
  // Only a genuine string originalMessage — never coerce an arbitrary wrapped
  // value (a large object's `.toString()` could itself be unbounded work).
  const rawOriginalMessage = typeof error === 'object' && error !== null
    ? (error as { originalMessage?: unknown }).originalMessage
    : undefined;
  const originalMessage = typeof rawOriginalMessage === 'string' ? rawOriginalMessage : '';
  return parseAffordableTokens(message) ?? parseAffordableTokens(originalMessage);
}

export function isWorkerShutdownError(error: unknown): boolean {
  if (!error) return false;
  const message = error instanceof Error ? error.message : String(error);
  // Graceful shutdown (server stopping)
  if (message === 'Worker shutdown') return true;
  // Unexpected worker subprocess crash (e.g. OOM kill, EB instance replacement)
  if (message.startsWith('Worker process exited with code')) return true;
  // Dispatch raced a graceful-shutdown drain window (deploy/restart) — same
  // deploy-timing class as the two patterns above (ENG-1166).
  if (message === 'Worker is draining — no new requests accepted') return true;
  return false;
}

/**
 * ENG-2293 (Opslane finding on PR #3276): `require_parameters: true` means a
 * single requested parameter unsupported by every eligible provider leaves no
 * routable endpoint at all — OpenRouter's 404 reads literally "No endpoints
 * found that can handle the requested parameters" (see
 * openRouterRequestParams.ts, same failure class as ENG-199). That's a
 * provider-routing condition, not an unknown server error, and deserves its
 * own handled, user-readable outcome instead of falling through to a generic
 * 500.
 */
export function isProviderNoEndpointsError(error: unknown): boolean {
  if (!error) return false;
  const e = error as any;
  const text = [error instanceof Error ? error.message : String(error), e.originalMessage, e.originalError?.message]
    .filter((part): part is string => typeof part === 'string')
    .join(' ')
    .toLowerCase();
  // Primary signal: OpenRouter's own wording, case-insensitive and tolerant of
  // "found"/"available". Fallback for a reworded message: a 404 whose text still
  // names the unmet "requested parameters". A bare 404 deliberately does NOT
  // match — that could be a wrong slug or URL, which must stay a loud 500.
  if (/no (?:allowed )?endpoints? (?:found|available)/.test(text)) return true;
  const is404 = e.status === 404 || e.code === 404 || e.originalError?.status === 404;
  return is404 && text.includes('requested parameters');
}

const TRANSIENT_STATUS_CODES = [429, 500, 502, 503, 504];

// Bedrock also returns ModelTimeoutException with a 500-class status — treat any
// numeric httpStatusCode (from $metadata) that maps to a transient code as transient.
const TRANSIENT_ERROR_NAMES = new Set(['TimeoutError', 'AbortError', 'ModelTimeoutException']);

// String error codes (e.g. ETIMEDOUT from node-http-handler) treated as transient.
const TRANSIENT_STRING_CODES = new Set(['ETIMEDOUT', 'ECONNRESET', 'EPIPE', 'ECONNABORTED']);

const TRANSIENT_MESSAGE_PATTERNS = [
  /throttl/i,
  /too many requests/i,
  /rate.?limit/i,
  /rate exceeded/i,
  /temporarily unavailable/i,
  /econnreset/i,
  /etimedout/i,
  /socket hang up/i,
  // ENG-2427: node-fetch/undici stream cut mid-body — "Invalid response body while
  // trying to fetch <url>: Premature close". Same class as a socket hang up.
  /premature close/i,
  /invalid response body/i,
  /aborted.*timeout/i,
  /TimeoutError/i,
  /request aborted/i,
  /exceeded.*requestTimeout/i,
  /500/,
  /502/,
  /503/,
  /internal.?server.?error/i,
  // AWS SDK emits "X status code (no body)" when Bedrock returns an HTTP error with
  // no parseable response body — this indicates a transient infrastructure error
  // (e.g. API Gateway timeout or Bedrock cold-start) rather than a client mistake.
  /status code \(no body\)/i,
];

export function isTransientLLMError(error: unknown): boolean {
  if (!error) return false;

  // Don't retry context-limit errors — they need message trimming, not retries
  if (isContextLimitError(error)) return false;

  const e = error as any;
  const message = error instanceof Error ? error.message : String(error);
  // Also check originalMessage from wrapped errors (generateMarketingResponse preserves it)
  const originalMessage = e?.originalMessage || '';

  // Check by error name (TimeoutError from smithy requestTimeout, AbortError from AbortSignal,
  // ModelTimeoutException from Bedrock)
  if (e?.name && TRANSIENT_ERROR_NAMES.has(e.name)) return true;

  // Check numeric HTTP status (standard status property, numeric code, Bedrock $metadata.httpStatusCode)
  const httpStatus = e?.status ?? (typeof e?.code === 'number' ? e.code : undefined) ?? e?.$metadata?.httpStatusCode ?? e?.response?.status;
  if (typeof httpStatus === 'number' && TRANSIENT_STATUS_CODES.includes(httpStatus)) return true;

  // Check string error codes (ETIMEDOUT, ECONNRESET, etc.)
  if (typeof e?.code === 'string' && TRANSIENT_STRING_CODES.has(e.code)) return true;

  return TRANSIENT_MESSAGE_PATTERNS.some((pattern) => pattern.test(message) || pattern.test(originalMessage));
}

/**
 * ENG-2381: user-facing message for a final upstream 5xx from the LLM provider.
 * agentModeService wraps such errors with this message; the controller matches it
 * via isProviderUnavailableError to answer 503 instead of an "Unknown Error" page.
 */
export const PROVIDER_UNAVAILABLE_USER_MESSAGE =
  'The AI provider is temporarily unavailable. Please try again in a moment.';

export function isProviderUnavailableError(error: unknown): boolean {
  return error instanceof Error && error.message === PROVIDER_UNAVAILABLE_USER_MESSAGE;
}
