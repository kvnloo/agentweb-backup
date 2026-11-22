/**
 * ENG-592 (ENG-286 / ENG-312 class): Google Ads answered a campaign UPDATE with success
 * while the field stayed unchanged, and Emma reported it done. updateCampaign must read
 * the campaign back and throw `unsupported_field` for anything that did not land.
 * Zero live network: mutate/search/credentials are stubbed fixtures.
 */
import { GoogleAdsService, GoogleAdsReadBackError } from '../services/googleAdsService';

const CAMPAIGN = 'customers/123/campaigns/9';

function setup(readBack: Record<string, unknown> | null) {
  const svc = new GoogleAdsService();
  jest.spyOn(svc, 'getAccountCredentials').mockResolvedValue({ accessToken: 't', loginCustomerId: undefined } as any);
  const mutate = jest.spyOn(svc, 'mutate').mockResolvedValue({ results: [{ resourceName: CAMPAIGN }] });
  const search = jest.spyOn(svc, 'search').mockResolvedValue(readBack ? [{ campaign: { resourceName: CAMPAIGN, ...readBack } }] : []);
  return { svc, mutate, search };
}

beforeAll(() => jest.spyOn(console, 'error').mockImplementation(() => {}));

describe('updateCampaign read-back', () => {
  it('ENG-312: final_url_suffix success-but-unchanged throws unsupported_field', async () => {
    const { svc, mutate } = setup({ finalUrlSuffix: 'utm_source=old' });
    const p = svc.updateCampaign('u', '123', CAMPAIGN, { finalUrlSuffix: 'utm_source=google&utm_medium=cpc' });
    await expect(p).rejects.toBeInstanceOf(GoogleAdsReadBackError);
    await expect(p).rejects.toMatchObject({ code: 'unsupported_field', fields: ['final_url_suffix'] });
    expect(mutate).toHaveBeenCalledTimes(1);
  });

  it('ENG-286: bidding strategy success-but-unchanged throws unsupported_field', async () => {
    const { svc } = setup({ biddingStrategyType: 'MANUAL_CPC' });
    await expect(
      svc.updateCampaign('u', '123', CAMPAIGN, { biddingStrategy: 'MAXIMIZE_CONVERSIONS' }),
    ).rejects.toMatchObject({ code: 'unsupported_field', fields: ['bidding_strategy_type'] });
  });

  it('returns true when every requested field reads back as written', async () => {
    const { svc, search } = setup({
      name: 'New', status: 'PAUSED', finalUrlSuffix: 'a=b', biddingStrategyType: 'TARGET_SPEND',
      networkSettings: { targetGoogleSearch: true, targetSearchNetwork: false },
    });
    await expect(svc.updateCampaign('u', '123', CAMPAIGN, {
      name: 'New', status: 'PAUSED', finalUrlSuffix: 'a=b', biddingStrategy: 'TARGET_SPEND', cpcBidCeilingMicros: 9_000_000,
      targetGoogleSearch: true, targetSearchNetwork: false,
    })).resolves.toBe(true);
    expect(search).toHaveBeenCalledTimes(1);
  });

  it('clearing final_url_suffix to empty verifies against a missing field', async () => {
    const { svc } = setup({});
    await expect(svc.updateCampaign('u', '123', CAMPAIGN, { finalUrlSuffix: '' })).resolves.toBe(true);
  });

  it('missing campaign on read-back is a loud failure, not success', async () => {
    const { svc } = setup(null);
    await expect(svc.updateCampaign('u', '123', CAMPAIGN, { status: 'PAUSED' })).rejects.toBeInstanceOf(GoogleAdsReadBackError);
  });

  it('no-op request sends nothing and reads nothing', async () => {
    const { svc, mutate, search } = setup({});
    await expect(svc.updateCampaign('u', '123', CAMPAIGN, {})).resolves.toBe(false);
    expect(mutate).not.toHaveBeenCalled();
    expect(search).not.toHaveBeenCalled();
  });
});

describe('agent tool surface', () => {
  it('relays a read-back mismatch as success:false with errorType unsupported_field', async () => {
    jest.resetModules();
    jest.doMock('../services/googleAdsService', () => {
      const actual = jest.requireActual('../services/googleAdsService');
      return {
        ...actual,
        googleAdsService: {
          updateCampaign: jest.fn().mockRejectedValue(new actual.GoogleAdsReadBackError(CAMPAIGN, ['final_url_suffix'])),
        },
      };
    });
    const { handleCallGoogleAdsApi } = require('../emma/impl/adsCrmApis');
    const res = await handleCallGoogleAdsApi('u', {
      customer_id: '123', entity_type: 'CAMPAIGN', action: 'UPDATE',
      campaign_resource_name: CAMPAIGN, final_url_suffix: 'a=b',
    });
    expect(res).toMatchObject({ success: false, errorType: 'unsupported_field', fields: ['final_url_suffix'] });
  });
});
