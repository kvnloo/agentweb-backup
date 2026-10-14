/**
 * ENG-2475 — Google Ads rejects a whole mutate with CONCURRENT_MODIFICATION when parallel
 * writes touch the same resource ("Retry the request."). Prod session 273a9b41 (2026-10-13)
 * lost 4 parallel keyword UPDATEs this way; they surfaced as invalid_args and fed the
 * maxSameToolFailures degrade. mutate/batchMutate retry that one code; nothing else.
 */
jest.mock('../utils/secretsManager', () => ({
  getGoogleAdsCredentials: jest.fn().mockResolvedValue({ developerToken: 'd', clientId: 'c', clientSecret: 's' }),
}));

import { GoogleAdsService } from '../services/googleAdsService';

function gadsError(code: Record<string, string>): any {
  const err: any = new Error('Request failed with status code 409');
  err.response = { status: 409, data: { error: { status: 'ABORTED', details: [{ errors: [{ errorCode: code, message: 'x' }] }] } } };
  return err;
}
const concurrent = () => gadsError({ databaseError: 'CONCURRENT_MODIFICATION' });

function svc(callApi: jest.Mock): any {
  const s = new GoogleAdsService() as any;
  s.callApi = callApi;
  s.concurrentRetryDelayMs = () => 0;
  return s;
}

describe('ENG-2475 CONCURRENT_MODIFICATION retry', () => {
  it('mutate retries and returns the later success', async () => {
    const callApi = jest.fn().mockRejectedValueOnce(concurrent()).mockResolvedValueOnce({ results: [{ resourceName: 'r' }] });
    await expect(svc(callApi).mutate('1', 't', 'adGroupCriteria', [{}])).resolves.toEqual({ results: [{ resourceName: 'r' }] });
    expect(callApi).toHaveBeenCalledTimes(2);
  });

  it('batchMutate retries too', async () => {
    const callApi = jest.fn().mockRejectedValueOnce(concurrent()).mockRejectedValueOnce(concurrent()).mockResolvedValueOnce({ ok: 1 });
    await expect(svc(callApi).batchMutate('1', 't', [{}])).resolves.toEqual({ ok: 1 });
    expect(callApi).toHaveBeenCalledTimes(3);
  });

  it('rethrows the last original error after 3 attempts', async () => {
    const last = concurrent();
    const callApi = jest.fn().mockRejectedValueOnce(concurrent()).mockRejectedValueOnce(concurrent()).mockRejectedValueOnce(last);
    await expect(svc(callApi).mutate('1', 't', 'campaigns', [{}])).rejects.toBe(last);
    expect(callApi).toHaveBeenCalledTimes(3);
  });

  it('does not retry other Google Ads errors', async () => {
    const other = gadsError({ fieldError: 'REQUIRED' });
    const callApi = jest.fn().mockRejectedValue(other);
    await expect(svc(callApi).mutate('1', 't', 'campaigns', [{}])).rejects.toBe(other);
    expect(callApi).toHaveBeenCalledTimes(1);
  });

  it('does not retry non-HTTP errors', async () => {
    const plain = new Error('boom');
    const callApi = jest.fn().mockRejectedValue(plain);
    await expect(svc(callApi).batchMutate('1', 't', [{}])).rejects.toBe(plain);
    expect(callApi).toHaveBeenCalledTimes(1);
  });
});
