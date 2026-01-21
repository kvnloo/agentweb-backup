import {
  SESSION_LIMIT_ERROR_CODES,
  isSessionLimitError,
  isContextLimitError
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
});
