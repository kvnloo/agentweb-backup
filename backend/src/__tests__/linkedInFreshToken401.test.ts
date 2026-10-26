import { retryOnceIfFreshToken401 } from '../services/adapters/linkedInAdapter';

const err401 = () => new Error('LinkedIn access token expired or invalid');

describe('ENG-2663 retryOnceIfFreshToken401', () => {
  it('retries once after a 401 on a just-refreshed token and returns the retry result', async () => {
    const call = jest.fn().mockRejectedValueOnce(err401()).mockResolvedValueOnce('urn:li:share:1');
    await expect(retryOnceIfFreshToken401(true, call, 0)).resolves.toBe('urn:li:share:1');
    expect(call).toHaveBeenCalledTimes(2);
  });
  it('also recognises axios-shaped 401 errors', async () => {
    const e: any = new Error('x'); e.response = { status: 401 };
    const call = jest.fn().mockRejectedValueOnce(e).mockResolvedValueOnce('ok');
    await expect(retryOnceIfFreshToken401(true, call, 0)).resolves.toBe('ok');
  });
  it('does not retry when the token was not refreshed (genuine revocation path)', async () => {
    const call = jest.fn().mockRejectedValue(err401());
    await expect(retryOnceIfFreshToken401(false, call, 0)).rejects.toThrow('expired or invalid');
    expect(call).toHaveBeenCalledTimes(1);
  });
  it('does not retry non-401 errors', async () => {
    const call = jest.fn().mockRejectedValue(new Error('LinkedIn rate limit exceeded'));
    await expect(retryOnceIfFreshToken401(true, call, 0)).rejects.toThrow('rate limit');
    expect(call).toHaveBeenCalledTimes(1);
  });
  it('retries only once, surfacing a persistent 401', async () => {
    const call = jest.fn().mockRejectedValue(err401());
    await expect(retryOnceIfFreshToken401(true, call, 0)).rejects.toThrow('expired or invalid');
    expect(call).toHaveBeenCalledTimes(2);
  });
});
