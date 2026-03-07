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
  return CONTEXT_LIMIT_PATTERNS.some((pattern) => pattern.test(message));
}

const TRANSIENT_STATUS_CODES = [429, 500, 502, 503, 504];

const TRANSIENT_MESSAGE_PATTERNS = [
  /throttl/i,
  /too many requests/i,
  /rate.?limit/i,
  /rate exceeded/i,
  /temporarily unavailable/i,
  /econnreset/i,
  /etimedout/i,
  /socket hang up/i,
  /500/,
  /502/,
  /503/,
  /internal.?server.?error/i,
];

export function isTransientLLMError(error: unknown): boolean {
  if (!error) return false;

  // Don't retry context-limit errors — they need message trimming, not retries
  if (isContextLimitError(error)) return false;

  const message = error instanceof Error ? error.message : String(error);
  const statusCode = (error as any)?.status ?? (error as any)?.code ?? (error as any)?.response?.status;

  if (typeof statusCode === 'number' && TRANSIENT_STATUS_CODES.includes(statusCode)) {
    return true;
  }

  return TRANSIENT_MESSAGE_PATTERNS.some((pattern) => pattern.test(message));
}
