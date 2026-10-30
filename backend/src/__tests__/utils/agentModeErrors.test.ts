import {
  SESSION_LIMIT_ERROR_CODES,
  isSessionLimitError,
  isContextLimitError,
  isTransientLLMError,
  isWorkerShutdownError,
  isProviderNoEndpointsError,
  extractAffordableTokens
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

  describe('isWorkerShutdownError', () => {
    it('should return false for null/undefined', () => {
      expect(isWorkerShutdownError(null)).toBe(false);
      expect(isWorkerShutdownError(undefined)).toBe(false);
    });

    it('should detect graceful worker shutdown errors', () => {
      expect(isWorkerShutdownError(new Error('Worker shutdown'))).toBe(true);
      // ENG-2750: drain-ceiling shutdown is the same deploy-timing class
      expect(isWorkerShutdownError(new Error('Worker shutdown — drain ceiling exceeded'))).toBe(true);
    });

    it('should detect worker process exit errors', () => {
      expect(isWorkerShutdownError(new Error('Worker process exited with code 1 and signal null'))).toBe(true);
      expect(isWorkerShutdownError('Worker process exited with code null and signal SIGKILL')).toBe(true);
    });

    it('should return false for unrelated worker strings', () => {
      expect(isWorkerShutdownError(new Error('Worker shutdown unexpectedly'))).toBe(false);
      expect(isWorkerShutdownError('ordinary failure')).toBe(false);
    });
  });

  describe('isProviderNoEndpointsError', () => {
    it('should return false for null/undefined', () => {
      expect(isProviderNoEndpointsError(null)).toBe(false);
      expect(isProviderNoEndpointsError(undefined)).toBe(false);
    });

    it('should detect the real OpenRouter 404 message (ENG-2293 Opslane finding)', () => {
      expect(isProviderNoEndpointsError(new Error('404 No endpoints found that can handle the requested parameters'))).toBe(true);
    });

    it('should check originalMessage on a wrapped error', () => {
      const wrapped = new Error('Unknown Error');
      (wrapped as any).originalMessage = 'No endpoints found that can handle the requested parameters';
      expect(isProviderNoEndpointsError(wrapped)).toBe(true);
    });

    it('should return false for unrelated errors', () => {
      expect(isProviderNoEndpointsError(new Error('high demand'))).toBe(false);
      expect(isProviderNoEndpointsError('ordinary failure')).toBe(false);
    });

    it('should tolerate case and "available" wording drift', () => {
      expect(isProviderNoEndpointsError(new Error('no endpoints found'))).toBe(true);
      expect(isProviderNoEndpointsError(new Error('No endpoints available for this model'))).toBe(true);
    });

    it('should find the message on the nested original error', () => {
      const wrapped: any = new Error('Unknown Error');
      wrapped.originalError = new Error('404 No endpoints found that can handle the requested parameters');
      expect(isProviderNoEndpointsError(wrapped)).toBe(true);
    });

    it('should match a reworded 404 that still names the requested parameters', () => {
      const wrapped: any = new Error('Unknown Error');
      wrapped.status = 404;
      wrapped.originalMessage = 'No routable provider for the requested parameters';
      expect(isProviderNoEndpointsError(wrapped)).toBe(true);
    });

    it('should NOT treat a bare 404 as a routing failure (wrong slug/URL must stay loud)', () => {
      const wrapped: any = new Error('Unknown Error');
      wrapped.status = 404;
      wrapped.originalMessage = 'Not Found';
      expect(isProviderNoEndpointsError(wrapped)).toBe(false);
      const wording: any = new Error('Unknown Error');
      wording.originalMessage = 'the requested parameters were invalid';
      expect(isProviderNoEndpointsError(wording)).toBe(false);
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

    it('should detect 500 status code as transient', () => {
      const error = Object.assign(new Error('Internal error'), { status: 500 });
      expect(isTransientLLMError(error)).toBe(true);
    });

    it('should detect 504 status code as transient', () => {
      const error = Object.assign(new Error('Gateway timeout'), { status: 504 });
      expect(isTransientLLMError(error)).toBe(true);
    });

    it('should detect "internal server error" message pattern', () => {
      expect(isTransientLLMError(new Error('Internal Server Error occurred'))).toBe(true);
    });

    it('should detect "internal_server_error" message pattern', () => {
      expect(isTransientLLMError(new Error('internal_server_error'))).toBe(true);
    });

    it('should detect "500" in message as transient', () => {
      expect(isTransientLLMError(new Error('HTTP 500 response'))).toBe(true);
    });

    it('should detect throttling errors', () => {
      expect(isTransientLLMError(new Error('Request throttled'))).toBe(true);
    });

    it('should detect too many requests errors', () => {
      expect(isTransientLLMError(new Error('too many requests'))).toBe(true);
    });

    it('should detect rate limit errors', () => {
      expect(isTransientLLMError(new Error('rate limit exceeded'))).toBe(true);
      expect(isTransientLLMError(new Error('rate_limit reached'))).toBe(true);
    });

    it('should detect rate exceeded errors', () => {
      expect(isTransientLLMError(new Error('rate exceeded'))).toBe(true);
    });

    it('should detect temporarily unavailable errors', () => {
      expect(isTransientLLMError(new Error('service temporarily unavailable'))).toBe(true);
    });

    it('should detect ETIMEDOUT errors', () => {
      expect(isTransientLLMError(new Error('ETIMEDOUT'))).toBe(true);
    });

    it('should detect "503" in message as transient', () => {
      expect(isTransientLLMError(new Error('Error 503'))).toBe(true);
    });

    it('should return false when statusCode is a string (non-number)', () => {
      const error = { code: 'ENOTFOUND', message: 'some error' };
      expect(isTransientLLMError(error)).toBe(false);
    });

    it('should handle error with no status, code, or response properties', () => {
      const error = { message: 'generic error' };
      expect(isTransientLLMError(error)).toBe(false);
    });

    it('should handle string errors for transient patterns', () => {
      expect(isTransientLLMError('ECONNRESET')).toBe(true);
      expect(isTransientLLMError('some normal error')).toBe(false);
    });

    it('should detect AbortSignal timeout errors', () => {
      expect(isTransientLLMError(new Error('The operation was aborted due to timeout'))).toBe(true);
    });

    it('should detect TimeoutError by name in message', () => {
      expect(isTransientLLMError(new Error('TimeoutError: signal timed out'))).toBe(true);
    });

    it('should handle non-Error object with status code and use String() for message', () => {
      // This exercises the String(error) branch on line 58 combined with numeric status check
      const error = { status: 503, toString: () => 'service unavailable' };
      expect(isTransientLLMError(error)).toBe(true);
    });

    it('should return false for non-Error object with non-transient status and non-matching message', () => {
      const error = { status: 401, toString: () => 'unauthorized' };
      expect(isTransientLLMError(error)).toBe(false);
    });

    it('should return false for zero/falsy error value', () => {
      expect(isTransientLLMError(0)).toBe(false);
      expect(isTransientLLMError(false)).toBe(false);
    });

    it('should handle number error via String()', () => {
      // Number is not instanceof Error, exercises String(error) path
      expect(isTransientLLMError(503)).toBe(true); // String(503) = "503" matches pattern
      expect(isTransientLLMError(200)).toBe(false);
    });

    it('should detect transient error via originalMessage on wrapped error', () => {
      const wrappedError = Object.assign(new Error('wrapped'), {
        originalMessage: 'service temporarily unavailable',
      });
      expect(isTransientLLMError(wrappedError)).toBe(true);
    });

    it('should detect TimeoutError by error.name (smithy requestTimeout)', () => {
      // @smithy/node-http-handler sets name="TimeoutError" on requestTimeout errors
      const err = Object.assign(new Error('@smithy/node-http-handler - [ERROR] a request has exceeded the configured 300000 ms requestTimeout.'), {
        name: 'TimeoutError',
        code: 'ETIMEDOUT',
      });
      expect(isTransientLLMError(err)).toBe(true);
    });

    it('should detect AbortError by error.name (AbortSignal.timeout)', () => {
      // AWS SDK builds AbortError with name="AbortError" when AbortSignal fires
      const err = Object.assign(new Error('Request aborted'), { name: 'AbortError' });
      expect(isTransientLLMError(err)).toBe(true);
    });

    it('should detect ModelTimeoutException by error.name (Bedrock model timeout)', () => {
      const err = Object.assign(new Error('Model request timed out'), { name: 'ModelTimeoutException' });
      expect(isTransientLLMError(err)).toBe(true);
    });

    it('should detect ETIMEDOUT by string code property', () => {
      const err = Object.assign(new Error('connection timed out'), { code: 'ETIMEDOUT' });
      expect(isTransientLLMError(err)).toBe(true);
    });

    it('should detect ECONNRESET by string code property', () => {
      const err = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
      expect(isTransientLLMError(err)).toBe(true);
    });

    it('should detect transient errors via Bedrock $metadata.httpStatusCode', () => {
      const err = Object.assign(new Error('Service unavailable'), {
        $metadata: { httpStatusCode: 503 },
      });
      expect(isTransientLLMError(err)).toBe(true);
    });

    it('should not treat non-transient $metadata.httpStatusCode as transient', () => {
      const err = Object.assign(new Error('Bad request'), {
        $metadata: { httpStatusCode: 400 },
      });
      expect(isTransientLLMError(err)).toBe(false);
    });

    it('should treat "400 status code (no body)" as transient — Bedrock infrastructure error', () => {
      // AWS SDK emits this when Bedrock returns a 400 HTTP response with no parseable body,
      // indicating a transient infrastructure issue rather than a client validation error.
      const err = new Error('400 status code (no body)');
      expect(isTransientLLMError(err)).toBe(true);
    });

    it('should treat other "N status code (no body)" variants as transient', () => {
      expect(isTransientLLMError(new Error('503 status code (no body)'))).toBe(true);
      expect(isTransientLLMError(new Error('502 status code (no body)'))).toBe(true);
    });
  });

  describe('isContextLimitError — originalMessage path', () => {
    it('should detect context limit via originalMessage on wrapped error', () => {
      const wrappedError = Object.assign(new Error('wrapped'), {
        originalMessage: 'context length exceeded',
      });
      expect(isContextLimitError(wrappedError)).toBe(true);
    });
  });

  // ENG-2185: prod session f6c882d0… (2026-09-25) — a spend-limited OpenRouter
  // key rejected a request with this exact message; the affordable-tokens
  // number is what a capped retry needs to turn the failure into a success.
  describe('extractAffordableTokens', () => {
    it('should return null for falsy/unrelated errors', () => {
      expect(extractAffordableTokens(null)).toBeNull();
      expect(extractAffordableTokens(undefined)).toBeNull();
      expect(extractAffordableTokens(new Error('some other error'))).toBeNull();
    });

    it('should extract the affordable token count from the real production message', () => {
      const err = new Error(
        'This request requires more credits, or fewer max_tokens. You requested up to 32000 tokens, but can only afford 24420. To increase, visit https://openrouter.ai/workspaces/default/keys/abc123 and adjust the key\'s monthly limit',
      );
      expect(extractAffordableTokens(err)).toBe(24420);
    });

    it('should be case-insensitive', () => {
      const err = new Error('REQUIRES MORE CREDITS. YOU REQUESTED... BUT CAN ONLY AFFORD 100');
      expect(extractAffordableTokens(err)).toBe(100);
    });

    it('should detect the pattern via originalMessage on a wrapped error', () => {
      const wrappedError = Object.assign(new Error('wrapped'), {
        originalMessage: 'requires more credits, or fewer max_tokens... can only afford 500',
      });
      expect(extractAffordableTokens(wrappedError)).toBe(500);
    });

    it('should return null when the message names credits but not an affordable count', () => {
      expect(extractAffordableTokens(new Error('requires more credits, please upgrade your plan'))).toBeNull();
    });

    // CodeRabbit (PR #3117): an earlier version matched both markers with a single
    // regex and an unbounded greedy `.*` between them — quadratic on a long
    // non-matching message (benchmarked at ~1.43s for 160KB). Pins that a large,
    // adversarial-shaped message that never actually matches still resolves
    // near-instantly, on both the primary message and the originalMessage path.
    it('should resolve near-instantly on a large non-matching message (no catastrophic backtracking)', () => {
      const huge = 'requires more credits, '.repeat(20_000); // ~480KB, never contains the second marker
      const start = Date.now();
      expect(extractAffordableTokens(new Error(huge))).toBeNull();
      expect(extractAffordableTokens(Object.assign(new Error('wrapped'), { originalMessage: huge }))).toBeNull();
      expect(Date.now() - start).toBeLessThan(200);
    });
  });
});
