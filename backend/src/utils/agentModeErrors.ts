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
