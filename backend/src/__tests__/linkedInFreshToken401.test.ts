import { retryIfFreshToken401, FRESH_TOKEN_RETRY_DELAYS_MS, FreshTokenRejectedError } from '../services/adapters/linkedInAdapter';
import { toolResultError } from '../utils/toolResultError';
import { classifyToolErrorClass } from '../utils/toolErrorClassifier';
import { retryabilityLine } from '../services/agentMode/core/errorRetryability';

const err401 = () => new Error('LinkedIn access token expired or invalid');

describe('ENG-2663 retryIfFreshToken401', () => {
  it('retries once after a 401 on a just-refreshed token and returns the retry result', async () => {
    const call = jest.fn().mockRejectedValueOnce(err401()).mockResolvedValueOnce('urn:li:share:1');
    await expect(retryIfFreshToken401(true, call, [0])).resolves.toBe('urn:li:share:1');
    expect(call).toHaveBeenCalledTimes(2);
  });
  it('also recognises axios-shaped 401 errors', async () => {
    const e: any = new Error('x'); e.response = { status: 401 };
    const call = jest.fn().mockRejectedValueOnce(e).mockResolvedValueOnce('ok');
    await expect(retryIfFreshToken401(true, call, [0])).resolves.toBe('ok');
  });
  it('does not retry when the token was not refreshed (genuine revocation path)', async () => {
    const call = jest.fn().mockRejectedValue(err401());
    await expect(retryIfFreshToken401(false, call, [0])).rejects.toThrow('expired or invalid');
    expect(call).toHaveBeenCalledTimes(1);
  });
  it('does not retry non-401 errors', async () => {
    const call = jest.fn().mockRejectedValue(new Error('LinkedIn rate limit exceeded'));
    await expect(retryIfFreshToken401(true, call, [0])).rejects.toThrow('rate limit');
    expect(call).toHaveBeenCalledTimes(1);
  });
  it('retries once per delay, then throws FreshTokenRejectedError (not the reconnect error)', async () => {
    const call = jest.fn().mockRejectedValue(err401());
    const rejected = await retryIfFreshToken401(true, call, [0, 0, 0]).catch((e) => e);
    expect(rejected).toBeInstanceOf(FreshTokenRejectedError);
    expect(call).toHaveBeenCalledTimes(4);
  });
  it('a persistent 401 on a stored token keeps the original error so the user is told to reconnect', async () => {
    const call = jest.fn().mockRejectedValue(err401());
    const e: any = await retryIfFreshToken401(false, call, [0]).catch((x) => x);
    expect(e).not.toBeInstanceOf(FreshTokenRejectedError);
    expect(e.message).toContain('expired or invalid');
  });
  it('recovers on a later retry', async () => {
    const call = jest.fn().mockRejectedValueOnce(err401()).mockRejectedValueOnce(err401()).mockResolvedValueOnce('ok');
    await expect(retryIfFreshToken401(true, call, [0, 0, 0])).resolves.toBe('ok');
    expect(call).toHaveBeenCalledTimes(3);
  });
  it('defaults to a single 10s wait so an interactive user is never blocked long', () => {
    expect(FRESH_TOKEN_RETRY_DELAYS_MS).toEqual([10_000]);
  });
});

describe('ENG-2663 FreshTokenRejectedError reaches the model as retryable, not "reconnect"', () => {
  const err = new FreshTokenRejectedError();
  // Same shape the emma/impl/linkedin.ts handlers return from their catch block.
  const handlerResult = { success: false, message: `Failed to post: ${err.message}`, code: (err as any).code, errorClass: err.toolErrorClass };

  it('classifies as upstream_5xx and carries Retryable: yes', () => {
    const asError = toolResultError(handlerResult)!;
    const cls = classifyToolErrorClass(asError);
    expect(cls).toBe('upstream_5xx');
    expect(retryabilityLine(cls)).toMatch(/^\[Retryable: yes/);
  });
  it('never tells the user to reconnect, and avoids the handlers\' "access token expired" remap', () => {
    expect(err.message).not.toMatch(/access token expired|please reconnect|settings/i);
    expect(err.message).toMatch(/do not ask the user to reconnect/i);
  });
});
