import {
  SESSION_LIMIT_ERROR_CODES,
  isSessionLimitError,
  isContextLimitError,
  isTransientLLMError
} from '../../utils/agentModeErrors';

describe('agentModeErrors utils', () => {
  describe('SESSION_LIMIT_ERROR_CODES', () => {
    it('should contain expected error codes', () => {
      expect(SESSION_LIMIT_ERROR_CODES).toContain('SESSION_MESSAGE_LIMIT_EXCEEDED');
      expect(SESSION_LIMIT_ERROR_CODES).toContain('SESSION_SIZE_LIMIT_EXCEEDED');
    });
  });

  describe('isSessionLimitError', () => {
    it('should return false for null/undefined', () => {
      expect(isSessionLimitError(null)).toBe(false);
      expect(isSessionLimitError(undefined)).toBe(false);
    });

    it('should return true for Error with session limit message', () => {
      const error = new Error('SESSION_MESSAGE_LIMIT_EXCEEDED: Too many messages');
      expect(isSessionLimitError(error)).toBe(true);
    });

    it('should return true for Error with session size message', () => {
      const error = new Error('SESSION_SIZE_LIMIT_EXCEEDED: Session too large');
      expect(isSessionLimitError(error)).toBe(true);
    });

    it('should return false for unrelated errors', () => {
      const error = new Error('Some other error');
      expect(isSessionLimitError(error)).toBe(false);
    });

    it('should handle string errors', () => {
      expect(isSessionLimitError('SESSION_MESSAGE_LIMIT_EXCEEDED')).toBe(true);
      expect(isSessionLimitError('random string')).toBe(false);
    });

    it('should return false for empty string', () => {
      expect(isSessionLimitError('')).toBe(false);
    });
  });

  describe('isContextLimitError', () => {
    it('should return false for null/undefined', () => {
      expect(isContextLimitError(null)).toBe(false);
      expect(isContextLimitError(undefined)).toBe(false);
    });

    it('should detect "context length" errors', () => {
      const error = new Error('context length exceeded');
      expect(isContextLimitError(error)).toBe(true);
    });

    it('should detect "maximum context" errors', () => {
      const error = new Error('maximum context window reached');
      expect(isContextLimitError(error)).toBe(true);
    });

    it('should detect "context window" errors', () => {
      const error = new Error('context window exceeded');
      expect(isContextLimitError(error)).toBe(true);
    });

    it('should detect "token limit" errors', () => {
      const error = new Error('token limit reached');
      expect(isContextLimitError(error)).toBe(true);
    });

    it('should detect "too many tokens" errors', () => {
      const error = new Error('too many tokens');
      expect(isContextLimitError(error)).toBe(true);
    });

    it('should detect "prompt is too long" errors', () => {
      const error = new Error('prompt is too long');
      expect(isContextLimitError(error)).toBe(true);
    });

    it('should detect "input is too long" errors', () => {
      const error = new Error('input is too long');
      expect(isContextLimitError(error)).toBe(true);
    });

    it('should detect "exceeds context" errors', () => {
      const error = new Error('request exceeds maximum context');
      expect(isContextLimitError(error)).toBe(true);
    });

    it('should detect "exceeded tokens" errors', () => {
      const error = new Error('exceeded maximum tokens');
      expect(isContextLimitError(error)).toBe(true);
    });

    it('should detect "maximum tokens" errors', () => {
      const error = new Error('maximum tokens allowed');
      expect(isContextLimitError(error)).toBe(true);
    });

    it('should detect "messages exceed" errors', () => {
      const error = new Error('messages exceed limit');
      expect(isContextLimitError(error)).toBe(true);
    });

    it('should detect "request too large" errors', () => {
      const error = new Error('request too large');
      expect(isContextLimitError(error)).toBe(true);
    });

    it('should be case insensitive', () => {
      expect(isContextLimitError(new Error('CONTEXT LENGTH exceeded'))).toBe(true);
      expect(isContextLimitError(new Error('Token Limit Reached'))).toBe(true);
    });

    it('should return false for unrelated errors', () => {
      const error = new Error('Network timeout');
      expect(isContextLimitError(error)).toBe(false);
    });

    it('should handle string errors', () => {
      expect(isContextLimitError('context length exceeded')).toBe(true);
      expect(isContextLimitError('random error')).toBe(false);
    });
  });

  describe('isTransientLLMError', () => {
    it('should return false for falsy errors', () => {
      expect(isTransientLLMError(null)).toBe(false);
      expect(isTransientLLMError(undefined)).toBe(false);
    });

    it('should detect transient status via .status property', () => {
      const error = Object.assign(new Error('Server error'), { status: 503 });
      expect(isTransientLLMError(error)).toBe(true);
    });

    it('should detect transient status via .code when .status is absent', () => {
      const error = { code: 429, message: 'Rate limited' };
      expect(isTransientLLMError(error)).toBe(true);
    });

    it('should detect transient status via .response.status when .status and .code are absent', () => {
      const error = { response: { status: 502 }, message: 'Bad gateway' };
      expect(isTransientLLMError(error)).toBe(true);
    });

    it('should return false for non-transient status codes', () => {
      const error = Object.assign(new Error('Bad request'), { status: 400 });
      expect(isTransientLLMError(error)).toBe(false);
    });

    it('should detect transient errors by message pattern', () => {
      expect(isTransientLLMError(new Error('ECONNRESET'))).toBe(true);
      expect(isTransientLLMError(new Error('socket hang up'))).toBe(true);
    });

    it('should return false for context limit errors (not retryable)', () => {
      expect(isTransientLLMError(new Error('context length exceeded'))).toBe(false);
    });

    it('should handle error with status: 0 (falsy but not nullish)', () => {
      // 0 is not nullish for ??, so statusCode = 0, which is not in transient list
      const error = { status: 0, message: 'some error' };
      expect(isTransientLLMError(error)).toBe(false);
    });

    it('should fallback to response.status when status is null and code is null', () => {
      const error = { status: null, code: null, response: { status: 500 }, message: 'error' };
      expect(isTransientLLMError(error)).toBe(true);
    });

    it('should handle error with response object but no status inside', () => {
      const error = { response: {}, message: 'some non-transient error' };
      expect(isTransientLLMError(error)).toBe(false);
    });

    it('should handle error with status: undefined explicitly', () => {
      // Use Error so message is extracted via instanceof check, not String(error)
      const error = Object.assign(new Error('throttled'), { status: undefined, code: undefined });
      expect(isTransientLLMError(error)).toBe(true);
    });

    it('should handle string statusCode (not a number)', () => {
      const error = Object.assign(new Error('non-matching'), { status: '503' });
      // typeof '503' !== 'number', so statusCode check fails, falls to pattern matching
      expect(isTransientLLMError(error)).toBe(false);
    });
  });
});
