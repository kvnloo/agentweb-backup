import { retryIfFreshToken401, FRESH_TOKEN_RETRY_DELAYS_MS } from '../services/adapters/linkedInAdapter';

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
  it('retries once per delay, then surfaces a persistent 401', async () => {
    const call = jest.fn().mockRejectedValue(err401());
    await expect(retryIfFreshToken401(true, call, [0, 0, 0])).rejects.toThrow('expired or invalid');
    expect(call).toHaveBeenCalledTimes(4);
  });
  it('recovers on a later retry', async () => {
    const call = jest.fn().mockRejectedValueOnce(err401()).mockRejectedValueOnce(err401()).mockResolvedValueOnce('ok');
    await expect(retryIfFreshToken401(true, call, [0, 0, 0])).resolves.toBe('ok');
    expect(call).toHaveBeenCalledTimes(3);
  });
  it('defaults to a 10s, 30s, 60s schedule', () => {
    expect(FRESH_TOKEN_RETRY_DELAYS_MS).toEqual([10_000, 30_000, 60_000]);
  });
});
