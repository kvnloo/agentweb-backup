/**
 * ENG-503: a truncated provider body ("Unterminated string in JSON ... Deserialization
 * error") surfaced as an Unknown Error with no retry. It is now classified as
 * transient, retried once in-call, and alerted under one stable class.
 */
import {
  isProviderDeserializationError,
  isTransientLLMError,
  PROVIDER_DESERIALIZATION_ERROR_CLASS,
} from '../utils/agentModeErrors';
import { OpenRouterPlatformTransport } from '../services/funding/transport/openRouterPlatformTransport';

const PROD_MESSAGE =
  'Unterminated string in JSON at position 8735 (line 1 column 8736)\n'
  + '  Deserialization error: to see the raw response, inspect the hidden field {error}.$response on this object.';

const truncated = () => new Error(PROD_MESSAGE);
const okResponse = { choices: [{ message: { role: 'assistant', content: 'hi' } }] };

function send(create: jest.Mock, sleep: jest.Mock) {
  return new OpenRouterPlatformTransport().send({ chat: { completions: { create } } } as any, 'm', {}, {
    timeoutMs: 1000,
    maxAttempts: 2,
    isRetryableError: isProviderDeserializationError,
    computeBackoff: () => ({ ms: 1500, honoredRetryAfter: false }),
    sleep,
  } as any);
}

describe('ENG-503 provider deserialization errors', () => {
  beforeEach(() => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('classifies the production message (raw and wrapped) as transient', () => {
    expect(PROVIDER_DESERIALIZATION_ERROR_CLASS).toBe('provider_deserialization');
    expect(isProviderDeserializationError(truncated())).toBe(true);
    expect(isTransientLLMError(truncated())).toBe(true);
    const wrapped: any = new Error('I apologize, but I encountered an error processing your request. Please try again.');
    wrapped.originalMessage = PROD_MESSAGE;
    expect(isProviderDeserializationError(wrapped)).toBe(true);
  });

  it('leaves non-deserialization errors unchanged', () => {
    expect(isProviderDeserializationError(new Error('invalid tool schema'))).toBe(false);
    expect(isTransientLLMError(new Error('invalid tool schema'))).toBe(false);
  });

  it('retries once and succeeds when the next body is complete', async () => {
    const create = jest.fn().mockRejectedValueOnce(truncated()).mockResolvedValueOnce(okResponse);
    const sleep = jest.fn().mockResolvedValue(undefined);
    await expect(send(create, sleep)).resolves.toBe(okResponse);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('surfaces the original error after the single bounded retry', async () => {
    const create = jest.fn().mockImplementation(() => Promise.reject(truncated()));
    const sleep = jest.fn().mockResolvedValue(undefined);
    await expect(send(create, sleep)).rejects.toThrow('Deserialization error');
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('does not retry a non-deserialization failure', async () => {
    const create = jest.fn().mockRejectedValue(Object.assign(new Error('invalid tool schema'), { status: 400 }));
    const sleep = jest.fn().mockResolvedValue(undefined);
    await expect(send(create, sleep)).rejects.toThrow('invalid tool schema');
    expect(create).toHaveBeenCalledTimes(1);
  });
});
