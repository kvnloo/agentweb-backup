/**
 * ENG-2427: a scheduled chat died with zero assistant output on
 * "Invalid response body while trying to fetch https://openrouter.ai/api/v1/chat/completions: Premature close"
 * — the stream was cut mid-body. That message matched neither the network
 * classifier nor isTransientLLMError, so callLLM's in-call retry never fired.
 */
import { classifyToolErrorClass } from '../utils/toolErrorClassifier';
import { isTransientLLMError } from '../utils/agentModeErrors';
import { OpenRouterPlatformTransport } from '../services/funding/transport/openRouterPlatformTransport';

const PROD_MESSAGE =
  'Invalid response body while trying to fetch https://openrouter.ai/api/v1/chat/completions: Premature close';

function prematureClose(): Error {
  const err = new Error(PROD_MESSAGE);
  (err as any).type = 'system';
  (err as any).code = 'ERR_STREAM_PREMATURE_CLOSE';
  return err;
}

// Mirrors agentModeService's isRetryableLlmCallError network branch.
const isRetryable = (e: unknown) => {
  const c = classifyToolErrorClass(e);
  return c === 'rate_limit' || c === 'network' || c === 'upstream_5xx';
};

function makeClient(create: jest.Mock): any {
  return { chat: { completions: { create } } };
}

const okResponse = { choices: [{ message: { role: 'assistant', content: 'hi' } }] };

function sendOpts(maxAttempts: number, sleep: jest.Mock) {
  return {
    timeoutMs: 1000,
    maxAttempts,
    isRetryableError: isRetryable,
    computeBackoff: (_e: unknown, attempt: number) => ({ ms: 1500 * Math.pow(2, attempt - 1), honoredRetryAfter: false }),
    sleep,
  } as any;
}

describe('ENG-2427 premature-close stream failures', () => {
  beforeEach(() => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('classifies the production message as a transient network error', () => {
    expect(classifyToolErrorClass(prematureClose())).toBe('network');
    expect(isTransientLLMError(prematureClose())).toBe(true);
  });

  it('recognises it when wrapped with originalMessage (generateMarketingResponse shape)', () => {
    const wrapped = new Error('I apologize, but I encountered an error processing your request. Please try again.');
    (wrapped as any).originalMessage = PROD_MESSAGE;
    expect(isTransientLLMError(wrapped)).toBe(true);
  });

  it('does not widen to unrelated invalid-input errors', () => {
    expect(isTransientLLMError(new Error('invalid parameters: model'))).toBe(false);
  });

  it('retries in-turn with backoff and succeeds when the stream recovers', async () => {
    const create = jest.fn().mockRejectedValueOnce(prematureClose()).mockResolvedValueOnce(okResponse);
    const sleep = jest.fn().mockResolvedValue(undefined);
    const res = await new OpenRouterPlatformTransport().send(makeClient(create), 'm', {}, sendOpts(3, sleep));
    expect(res).toBe(okResponse);
    expect(create).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(1500);
  });

  it('stops after the bounded attempts and rethrows the original error', async () => {
    const create = jest.fn().mockImplementation(() => Promise.reject(prematureClose()));
    const sleep = jest.fn().mockResolvedValue(undefined);
    await expect(
      new OpenRouterPlatformTransport().send(makeClient(create), 'm', {}, sendOpts(3, sleep)),
    ).rejects.toThrow('Premature close');
    expect(create).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([1500, 3000]);
  });
});
