/**
 * ENG-2721: failure/retry log lines must carry provider + upstream_error on the SAME
 * line as the message, so line-based log sinks (CloudWatch) keep the root cause.
 */
import { OpenRouterPlatformTransport } from '../transport/openRouterPlatformTransport';

function providerError(raw: string) {
  const err: any = new Error('400 Provider returned error');
  err.error = { metadata: { provider_name: 'Google AI Studio', raw } };
  return err;
}

describe('OpenRouterPlatformTransport failure logging (ENG-2721)', () => {
  let warn: jest.SpyInstance;
  let error: jest.SpyInstance;
  beforeEach(() => {
    warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('logs provider and upstream_error on one line for retry and final failure', async () => {
    const create = jest
      .fn()
      .mockRejectedValueOnce(providerError('provider saturated'))
      .mockRejectedValueOnce(providerError('bad function_declarations schema'));
    const client: any = { chat: { completions: { create } } };

    await expect(
      new OpenRouterPlatformTransport().send(client, 'gemini-3.8-flash', {}, {
        timeoutMs: 1000,
        maxAttempts: 2,
        isRetryableError: () => true,
        computeBackoff: () => ({ ms: 0, honoredRetryAfter: false }),
        sleep: async () => undefined,
      }),
    ).rejects.toThrow('Provider returned error');

    const warnLine = warn.mock.calls[0].join(' ');
    expect(warnLine).not.toContain('\n');
    expect(warnLine).toContain('Google AI Studio');
    expect(warnLine).toContain('provider saturated');

    const failLine = error.mock.calls[0].join(' ');
    expect(failLine).toContain('OpenRouter call failed for model');
    expect(failLine).not.toContain('\n');
    expect(failLine).toContain('Google AI Studio');
    expect(failLine).toContain('function_declarations');
  });
});
