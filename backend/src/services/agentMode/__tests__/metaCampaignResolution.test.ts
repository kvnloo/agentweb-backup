import { resolveMetaActivationCampaignId } from '../metaCampaignResolution';

const base = {
  entityType: 'AD',
  adId: 'ad-1',
  accessToken: 'token',
  accountId: 'account-1',
};

const resolverWith = (overrides: Partial<Record<'getAdCampaignIdForAccount' | 'getAdSetCampaignIdForAccount', jest.Mock>> = {}) => ({
  getAdCampaignIdForAccount: jest.fn(),
  getAdSetCampaignIdForAccount: jest.fn(),
  ...overrides,
});

describe('resolveMetaActivationCampaignId', () => {
  it('reuses a supplied campaign without reading Meta', async () => {
    const resolver = resolverWith();
    await expect(resolveMetaActivationCampaignId({ ...base, campaignId: 'campaign-1', resolver }))
      .resolves.toBe('campaign-1');
    await expect(resolveMetaActivationCampaignId({ ...base, entityType: 'AD_SET', adSetId: 'as-1', campaignId: 'campaign-1', resolver }))
      .resolves.toBe('campaign-1');
    expect(resolver.getAdCampaignIdForAccount).not.toHaveBeenCalled();
    expect(resolver.getAdSetCampaignIdForAccount).not.toHaveBeenCalled();
  });

  it('resolves an AD parent through the selected account', async () => {
    const resolver = resolverWith({ getAdCampaignIdForAccount: jest.fn().mockResolvedValue('campaign-1') });
    await expect(resolveMetaActivationCampaignId({ ...base, resolver })).resolves.toBe('campaign-1');
    expect(resolver.getAdCampaignIdForAccount).toHaveBeenCalledWith('token', 'account-1', 'ad-1');
  });

  it('leaves the campaign unset when the lookup fails', async () => {
    const resolver = resolverWith({ getAdCampaignIdForAccount: jest.fn().mockRejectedValue(new Error('timeout')) });
    await expect(resolveMetaActivationCampaignId({ ...base, resolver })).resolves.toBeUndefined();
  });

  it('resolves an AD_SET parent through the selected account (ENG-01 live run)', async () => {
    const resolver = resolverWith({ getAdSetCampaignIdForAccount: jest.fn().mockResolvedValue('campaign-1') });
    await expect(resolveMetaActivationCampaignId({ ...base, entityType: 'AD_SET', adId: undefined, adSetId: 'as-1', resolver }))
      .resolves.toBe('campaign-1');
    expect(resolver.getAdSetCampaignIdForAccount).toHaveBeenCalledWith('token', 'account-1', 'as-1');
    expect(resolver.getAdCampaignIdForAccount).not.toHaveBeenCalled();
  });

  it('leaves an AD_SET campaign unset when the lookup fails or finds no owned parent', async () => {
    const failing = resolverWith({ getAdSetCampaignIdForAccount: jest.fn().mockRejectedValue(new Error('timeout')) });
    await expect(resolveMetaActivationCampaignId({ ...base, entityType: 'AD_SET', adSetId: 'as-1', resolver: failing }))
      .resolves.toBeUndefined();
    const foreign = resolverWith({ getAdSetCampaignIdForAccount: jest.fn().mockResolvedValue(undefined) });
    await expect(resolveMetaActivationCampaignId({ ...base, entityType: 'AD_SET', adSetId: 'as-1', resolver: foreign }))
      .resolves.toBeUndefined();
  });

  it('never resolves for a CAMPAIGN entity or an entity without its own id', async () => {
    const resolver = resolverWith();
    await expect(resolveMetaActivationCampaignId({ ...base, entityType: 'CAMPAIGN', resolver })).resolves.toBeUndefined();
    await expect(resolveMetaActivationCampaignId({ ...base, entityType: 'AD_SET', resolver })).resolves.toBeUndefined();
    expect(resolver.getAdCampaignIdForAccount).not.toHaveBeenCalled();
    expect(resolver.getAdSetCampaignIdForAccount).not.toHaveBeenCalled();
  });
});
