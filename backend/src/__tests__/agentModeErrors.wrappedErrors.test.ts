/**
 * Tests for error classification functions working with wrapped errors
 * from generateMarketingResponse's catch block (Fix B).
 */
import { isContextLimitError, isTransientLLMError, isWorkerShutdownError } from '../utils/agentModeErrors';

describe('isContextLimitError - wrapped errors', () => {
  it('should detect context limit from originalMessage', () => {
    const wrapped: any = new Error('I encountered an issue processing your request. Please try rephrasing your question.');
    wrapped.originalMessage = 'This model maximum context length is 200000 tokens';
    wrapped.status = 400;

    expect(isContextLimitError(wrapped)).toBe(true);
  });

  it('should detect context limit from direct message (unchanged behavior)', () => {
    const error = new Error('prompt is too long for this model');
    expect(isContextLimitError(error)).toBe(true);
  });

  it('should detect "input is too long" from originalMessage', () => {
    const wrapped: any = new Error('Generic user message');
    wrapped.originalMessage = 'input is too long for the model';
    expect(isContextLimitError(wrapped)).toBe(true);
  });

  it('should NOT match unrelated errors', () => {
    const wrapped: any = new Error('Generic error');
    wrapped.originalMessage = 'some random timeout error';
    expect(isContextLimitError(wrapped)).toBe(false);
  });

  it('should handle missing originalMessage', () => {
    const error = new Error('Generic error with no original');
    expect(isContextLimitError(error)).toBe(false);
  });
});

describe('isTransientLLMError - wrapped errors', () => {
  it('should detect TimeoutError from originalMessage', () => {
    const wrapped: any = new Error('I apologize, but I encountered an error processing your request. Please try again.');
    wrapped.originalMessage = 'TimeoutError: The operation was aborted due to timeout';

    expect(isTransientLLMError(wrapped)).toBe(true);
  });

  it('should detect throttling from originalMessage', () => {
    const wrapped: any = new Error('Generic user message');
    wrapped.originalMessage = 'Request was throttled by the server';
    expect(isTransientLLMError(wrapped)).toBe(true);
  });

  it('should NOT classify context limit errors as transient even with originalMessage', () => {
    const wrapped: any = new Error('Generic');
    wrapped.originalMessage = 'This model maximum context length is 200000 tokens';
    wrapped.status = 400;

    expect(isTransientLLMError(wrapped)).toBe(false);
  });

  it('should detect transient via status code on wrapped errors', () => {
    const wrapped: any = new Error('Generic user message');
    wrapped.status = 429;
    wrapped.originalMessage = '';
    expect(isTransientLLMError(wrapped)).toBe(true);
  });
});

describe('isWorkerShutdownError', () => {
  it('should return true for exact Worker shutdown message', () => {
    expect(isWorkerShutdownError(new Error('Worker shutdown'))).toBe(true);
  });

  it('should return false for unrelated errors', () => {
    expect(isWorkerShutdownError(new Error('some other error'))).toBe(false);
  });

  it('should return false for null/undefined', () => {
    expect(isWorkerShutdownError(null)).toBe(false);
    expect(isWorkerShutdownError(undefined)).toBe(false);
  });

  it('should return false for partial match', () => {
    expect(isWorkerShutdownError(new Error('Worker shutdown unexpectedly'))).toBe(false);
  });

  it('should return false for a non-Error string value', () => {
    expect(isWorkerShutdownError('some error string')).toBe(false);
  });

  it('should return true for unexpected worker crash with exit code', () => {
    expect(isWorkerShutdownError(new Error('Worker process exited with code 1 and signal null'))).toBe(true);
  });

  it('should return true for unexpected worker crash with signal', () => {
    expect(isWorkerShutdownError(new Error('Worker process exited with code null and signal SIGKILL'))).toBe(true);
  });

  it('should return true for worker crash with code 0', () => {
    expect(isWorkerShutdownError(new Error('Worker process exited with code 0 and signal null'))).toBe(true);
  });
});
