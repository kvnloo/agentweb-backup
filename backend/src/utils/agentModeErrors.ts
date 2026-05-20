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

export function isWorkerShutdownError(error: unknown): boolean {
  if (!error) return false;
  const message = error instanceof Error ? error.message : String(error);
  // Graceful shutdown (server stopping)
  if (message === 'Worker shutdown') return true;
  // Unexpected worker subprocess crash (e.g. OOM kill, EB instance replacement)
  if (message.startsWith('Worker process exited with code')) return true;
  return false;
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
