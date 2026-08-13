/**
 * ENG-1158 — settle ads capability by attempting a read, not by reading scopes.
 *
 * Two independent grants must line up before an ads read works: the USER
 * granting our app `ads_read`, and the AD ACCOUNT's owner granting that user
 * access to that ad account. A token's scopes only ever show the first.
 *
 * Verified live against production account 922903076601160: `/me/permissions`
 * reports `ads_read` and `ads_management` granted with nothing declined, while
 * the very same token gets "(#200) Ad account owner has NOT grant
 * ads_management or ads_read permission" from that ad account. A scope-derived
 * answer says "capable" for exactly the account that cannot read.
 *
 * The HTTP boundary is mocked here; the two payloads below are the real
 * responses observed from a working and a broken account.
 */

import { metaService } from '../services/metaService';

const mockFetch = (payload: any) => {
  (global as any).fetch = jest.fn().mockResolvedValue({ json: async () => payload });
};

/** The live refusal from account 922903076601160. */
const ADS_REFUSAL = {
  error: {
    message:
      '(#200) Ad account owner has NOT grant ads_management or ads_read permission, refer to ' +
      'https://developers.facebook.com/docs/marketing-api/get-started/authorization/ for details.',
    type: 'OAuthException',
    code: 200,
  },
};

describe('metaService.probeAdsAccountAccess (ENG-1158)', () => {
  afterEach(() => {
    jest.clearAllMocks();
    delete (global as any).fetch;
  });

  it('reports accessible when the ad account node returns', async () => {
    mockFetch({ id: 'act_1339414687604223' });

    await expect(
      metaService.probeAdsAccountAccess('EAA-token', '1339414687604223')
    ).resolves.toBe('accessible');
  });

  it('reports denied on the live (#200) ads refusal', async () => {
    mockFetch(ADS_REFUSAL);

    await expect(
      metaService.probeAdsAccountAccess('EAA-token', '922903076601160')
    ).resolves.toBe('denied');
  });

  it('asks the ad account node with the user token', async () => {
    mockFetch({ id: 'act_1' });

    await metaService.probeAdsAccountAccess('EAA-token', '1');

    const url = ((global as any).fetch as jest.Mock).mock.calls[0][0] as string;
    expect(url).toContain('/act_1?');
    expect(url).toContain('access_token=EAA-token');
  });

  it('normalises an id that already carries the act_ prefix', async () => {
    mockFetch({ id: 'act_1' });

    await metaService.probeAdsAccountAccess('EAA-token', 'act_1');

    expect(((global as any).fetch as jest.Mock).mock.calls[0][0]).toContain('/act_1?');
  });

  describe('anything that is not a clear answer is unknown', () => {
    it('does not read a rate limit as incapability', async () => {
      // Reporting 'denied' here would revoke a healthy connection and email its
      // owner, twice a day, for the duration of a Meta incident.
      mockFetch({ error: { message: 'User request limit reached', code: 17 } });

      await expect(metaService.probeAdsAccountAccess('t', '1')).resolves.toBe('unknown');
    });

    it('does not read an expired token as incapability', async () => {
      // Code 190 has its own remedy and its own message.
      mockFetch({ error: { message: 'Error validating access token', code: 190 } });

      await expect(metaService.probeAdsAccountAccess('t', '1')).resolves.toBe('unknown');
    });

    it('does not read an unrelated permission error as an ads refusal', async () => {
      mockFetch({ error: { message: '(#200) Requires business_management permission', code: 200 } });

      await expect(metaService.probeAdsAccountAccess('t', '1')).resolves.toBe('unknown');
    });

    it('returns unknown on an empty or unrecognised payload', async () => {
      mockFetch({});

      await expect(metaService.probeAdsAccountAccess('t', '1')).resolves.toBe('unknown');
    });

    it('never throws when the request itself fails', async () => {
      (global as any).fetch = jest.fn().mockRejectedValue(new Error('ECONNRESET'));

      await expect(metaService.probeAdsAccountAccess('t', '1')).resolves.toBe('unknown');
    });
  });
});
