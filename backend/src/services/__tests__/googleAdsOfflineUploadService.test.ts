/**
 * ENG-1325 — the service boundary for offline conversion upload.
 *
 * Failure paths first. The case that matters most is partial failure: a batch where one
 * row is rejected must still upload the rest AND report which row failed, because this
 * runs from a background sweep where "uploaded" quietly meaning "some of them" is
 * indistinguishable from the tracking gap this feature exists to close.
 */
import { googleAdsService } from '../googleAdsService';

describe('uploadClickConversions', () => {
  let callSpy: jest.SpyInstance;
  let credSpy: jest.SpyInstance;
  const CUSTOMER = '2883029950';
  const conv = {
    gclid: 'Cj0KCQ',
    conversionAction: `customers/${CUSTOMER}/conversionActions/7724987234`,
    conversionDateTime: '2026-06-15 12:34:05+05:30',
  };

  beforeEach(() => {
    jest.restoreAllMocks();
    credSpy = jest.spyOn(googleAdsService as any, 'getAccountCredentials')
      .mockResolvedValue({ accessToken: 'tok', loginCustomerId: '5331614095' });
    callSpy = jest.spyOn(googleAdsService as any, 'callApiPublic').mockResolvedValue({ results: [{}] });
  });

  it('refuses an empty batch without calling Google', async () => {
    await expect(googleAdsService.uploadClickConversions('u', CUSTOMER, []))
      .rejects.toThrow(/At least one conversion/);
    expect(callSpy).not.toHaveBeenCalled();
  });

  it('refuses a non-array batch', async () => {
    await expect(googleAdsService.uploadClickConversions('u', CUSTOMER, null as any)).rejects.toThrow();
    expect(callSpy).not.toHaveBeenCalled();
  });

  it('posts to the conversionUploads endpoint with partialFailure on', async () => {
    await googleAdsService.uploadClickConversions('u', CUSTOMER, [conv]);
    const [method, path, , body] = callSpy.mock.calls[0];
    expect(method).toBe('POST');
    expect(path).toBe(`/customers/${CUSTOMER}/conversionUploads:uploadClickConversions`);
    expect(body.partialFailure).toBe(true);
    expect(body.conversions).toEqual([conv]);
  });

  it('defaults validateOnly to false rather than leaving it undefined', async () => {
    // An undefined validateOnly is a live upload either way; stating it makes the
    // rehearse-vs-commit distinction explicit at the call site.
    await googleAdsService.uploadClickConversions('u', CUSTOMER, [conv]);
    expect(callSpy.mock.calls[0][3].validateOnly).toBe(false);
  });

  it('passes validateOnly through so a batch can be rehearsed', async () => {
    await googleAdsService.uploadClickConversions('u', CUSTOMER, [conv], { validateOnly: true });
    expect(callSpy.mock.calls[0][3].validateOnly).toBe(true);
  });

  it('reports every row uploaded when nothing failed', async () => {
    const out = await googleAdsService.uploadClickConversions('u', CUSTOMER, [conv, conv]);
    expect(out.uploaded).toBe(2);
    expect(out.failures).toEqual([]);
  });

  it('uploads the survivors and names the row that failed', async () => {
    callSpy.mockResolvedValue({
      results: [{}, {}],
      partialFailureError: { details: [{ errors: [{
        message: 'The click is too old to be imported.',
        errorCode: { conversionUploadError: 'EXPIRED_CLICK' },
        location: { fieldPathElements: [{ fieldName: 'conversions', index: 1 }] },
      }] }] },
    });
    const out = await googleAdsService.uploadClickConversions('u', CUSTOMER, [conv, conv]);
    expect(out.uploaded).toBe(1);
    expect(out.failures[0]).toMatchObject({ index: 1, errorCode: 'EXPIRED_CLICK' });
  });

  it('never reports a negative uploaded count', async () => {
    // Defensive: more failures than rows would otherwise produce a nonsense number that
    // reads as a successful upload of "-1".
    callSpy.mockResolvedValue({
      partialFailureError: { details: [{ errors: [{ message: 'a' }, { message: 'b' }] }] },
    });
    const out = await googleAdsService.uploadClickConversions('u', CUSTOMER, [conv]);
    expect(out.uploaded).toBe(0);
  });

  it('returns the raw response so a caller can inspect what Google actually said', async () => {
    const out = await googleAdsService.uploadClickConversions('u', CUSTOMER, [conv]);
    expect(out.raw).toEqual({ results: [{}] });
  });

  it('resolves credentials for the named customer, not a default', async () => {
    await googleAdsService.uploadClickConversions('u', CUSTOMER, [conv]);
    expect(credSpy).toHaveBeenCalledWith('u', CUSTOMER);
  });
});
