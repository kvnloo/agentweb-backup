import { resolveMetaActivationCampaignId } from '../metaCampaignResolution';

const base = {
  entityType: 'AD',
  adId: 'ad-1',
  accessToken: 'token',
  accountId: 'account-1',
};

describe('resolveMetaActivationCampaignId', () => {
  it('reuses a supplied campaign without reading Meta', async () => {
    const resolver = { getAdCampaignIdForAccount: jest.fn() };
    await expect(resolveMetaActivationCampaignId({ ...base, campaignId: 'campaign-1', resolver }))
      .resolves.toBe('campaign-1');
    expect(resolver.getAdCampaignIdForAccount).not.toHaveBeenCalled();
  });

  it('resolves an AD parent through the selected account', async () => {
    const resolver = { getAdCampaignIdForAccount: jest.fn().mockResolvedValue('campaign-1') };
    await expect(resolveMetaActivationCampaignId({ ...base, resolver })).resolves.toBe('campaign-1');
    expect(resolver.getAdCampaignIdForAccount).toHaveBeenCalledWith('token', 'account-1', 'ad-1');
  });

  it('leaves the campaign unset when the lookup fails', async () => {
    const resolver = { getAdCampaignIdForAccount: jest.fn().mockRejectedValue(new Error('timeout')) };
    await expect(resolveMetaActivationCampaignId({ ...base, resolver })).resolves.toBeUndefined();
  });
});
