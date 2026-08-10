// ENG-398 — call_meta_marketing_api AD_SET/CAMPAIGN LIST must expose the config
// fields that define what a campaign optimizes for (optimization_goal, billing_event,
// destination_type, promoted_object, bid_strategy, budgets), honor an explicit `fields`
// selection and a campaign_id/ad_set_id filter, and reject an unsupported requested
// field LOUDLY instead of silently returning a reduced payload (feedback-avoid-fallbacks).
//
// These assertions pin the metaService (Graph API wrapper) half of the fix, with the
// facebook-nodejs-business-sdk mocked.

import { MetaService } from '../services/metaService';
import { FacebookAdsApi, AdAccount, Campaign, AdSet } from 'facebook-nodejs-business-sdk';

jest.mock('facebook-nodejs-business-sdk', () => {
  return {
    FacebookAdsApi: { init: jest.fn() },
    AdAccount: jest.fn().mockImplementation(() => ({
      getCampaigns: jest.fn(),
      getAdSets: jest.fn(),
    })),
    Campaign: jest.fn().mockImplementation(() => ({ get: jest.fn() })),
    AdSet: jest.fn().mockImplementation(() => ({ get: jest.fn() })),
    AdCreative: Object.assign(jest.fn(), { Fields: {} }),
    Ad: Object.assign(jest.fn(), { Fields: {}, Status: {} }),
    CustomAudience: jest.fn(),
    User: jest.fn(),
  };
});

jest.mock('../utils/secretsManager', () => ({
  getMetaCredentials: jest.fn(),
}));

describe('MetaService config-field reads (ENG-398)', () => {
  let service: MetaService;
  const token = 'mock_token';
  const accountId = '1234567890';

  beforeEach(() => {
    service = MetaService.getInstance();
    jest.clearAllMocks();
  });

  // ---------------- CAMPAIGN ----------------

  it('CAMPAIGN LIST default: requests budget + bid config fields from Graph', async () => {
    const getCampaigns = jest.fn().mockResolvedValue([{ _data: { id: 'c1' } }]);
    (AdAccount as unknown as jest.Mock).mockImplementation(() => ({ getCampaigns }));

    await service.listCampaigns(accountId, token);

    const requestedFields = getCampaigns.mock.calls[0][0] as string[];
    expect(requestedFields).toEqual(
      expect.arrayContaining(['daily_budget', 'lifetime_budget', 'budget_remaining', 'bid_strategy', 'objective'])
    );
  });

  it('CAMPAIGN LIST honors campaign_id: fetches the single campaign, returns a one-element list', async () => {
    const getCampaigns = jest.fn();
    (AdAccount as unknown as jest.Mock).mockImplementation(() => ({ getCampaigns }));
    const get = jest.fn().mockResolvedValue({ _data: { id: 'camp_9', bid_strategy: 'LOWEST_COST_WITHOUT_CAP' } });
    (Campaign as unknown as jest.Mock).mockImplementation(() => ({ get }));

    const result = await service.listCampaigns(accountId, token, { campaignId: 'camp_9' });

    expect(Campaign).toHaveBeenCalledWith('camp_9');
    expect(get).toHaveBeenCalled();
    expect(getCampaigns).not.toHaveBeenCalled(); // did not list the whole account
    expect(result).toEqual([{ id: 'camp_9', bid_strategy: 'LOWEST_COST_WITHOUT_CAP' }]);
  });

  it('CAMPAIGN LIST honors an explicit supported fields selection verbatim', async () => {
    const getCampaigns = jest.fn().mockResolvedValue([]);
    (AdAccount as unknown as jest.Mock).mockImplementation(() => ({ getCampaigns }));

    await service.listCampaigns(accountId, token, { fields: 'daily_budget,bid_strategy' });

    expect(getCampaigns).toHaveBeenCalledWith(['daily_budget', 'bid_strategy']);
  });

  it('CAMPAIGN LIST rejects an unsupported field LOUDLY and never calls Graph', async () => {
    const getCampaigns = jest.fn().mockResolvedValue([]);
    (AdAccount as unknown as jest.Mock).mockImplementation(() => ({ getCampaigns }));

    await expect(
      service.listCampaigns(accountId, token, { fields: 'daily_budget,not_a_real_field' })
    ).rejects.toThrow(/Unsupported campaign field\(s\): not_a_real_field/);
    expect(getCampaigns).not.toHaveBeenCalled();
  });

  // ---------------- AD_SET ----------------

  it('AD_SET LIST default: requests optimization/config fields from Graph', async () => {
    const getAdSets = jest.fn().mockResolvedValue([{ _data: { id: 'as1' } }]);
    (AdAccount as unknown as jest.Mock).mockImplementation(() => ({ getAdSets }));

    await service.listAdSets(accountId, token);

    const requestedFields = getAdSets.mock.calls[0][0] as string[];
    expect(requestedFields).toEqual(
      expect.arrayContaining([
        'optimization_goal', 'billing_event', 'destination_type', 'promoted_object', 'bid_strategy',
      ])
    );
  });

  it('AD_SET LIST honors ad_set_id: fetches the single ad set, returns a one-element list', async () => {
    const getAdSets = jest.fn();
    (AdAccount as unknown as jest.Mock).mockImplementation(() => ({ getAdSets }));
    const get = jest.fn().mockResolvedValue({
      _data: { id: 'as_9', optimization_goal: 'OFFSITE_CONVERSIONS', promoted_object: { pixel_id: 'px1', custom_event_type: 'LEAD' } },
    });
    (AdSet as unknown as jest.Mock).mockImplementation(() => ({ get }));

    const result = await service.listAdSets(accountId, token, undefined, { adSetId: 'as_9' });

    expect(AdSet).toHaveBeenCalledWith('as_9');
    expect(get).toHaveBeenCalled();
    expect(getAdSets).not.toHaveBeenCalled();
    expect(result).toEqual([
      { id: 'as_9', optimization_goal: 'OFFSITE_CONVERSIONS', promoted_object: { pixel_id: 'px1', custom_event_type: 'LEAD' } },
    ]);
  });

  it('AD_SET LIST honors an explicit supported fields selection verbatim', async () => {
    const getAdSets = jest.fn().mockResolvedValue([]);
    (AdAccount as unknown as jest.Mock).mockImplementation(() => ({ getAdSets }));

    await service.listAdSets(accountId, token, undefined, { fields: 'optimization_goal,promoted_object' });

    expect(getAdSets).toHaveBeenCalledWith(['optimization_goal', 'promoted_object'], {});
  });

  it('AD_SET LIST still forwards the campaign_id filter to Graph', async () => {
    const getAdSets = jest.fn().mockResolvedValue([]);
    (AdAccount as unknown as jest.Mock).mockImplementation(() => ({ getAdSets }));

    await service.listAdSets(accountId, token, 'camp_123');

    expect(getAdSets).toHaveBeenCalledWith(expect.any(Array), { campaign_id: 'camp_123' });
  });

  it('AD_SET LIST rejects an unsupported field LOUDLY and never calls Graph', async () => {
    const getAdSets = jest.fn().mockResolvedValue([]);
    (AdAccount as unknown as jest.Mock).mockImplementation(() => ({ getAdSets }));

    await expect(
      service.listAdSets(accountId, token, undefined, { fields: 'optimization_goal,bogus_field' })
    ).rejects.toThrow(/Unsupported ad set field\(s\): bogus_field/);
    expect(getAdSets).not.toHaveBeenCalled();
  });
});

// ENG-785 — spend_cap was missed in the ENG-398 widening: same defect class, same
// file, same fix shape. CAMPAIGN LIST must surface spend_cap by default, honor it in
// an explicit selection, and keep rejecting unknown fields loudly.
describe('MetaService CAMPAIGN spend_cap read (ENG-785)', () => {
  let service: MetaService;
  const token = 'mock_token';
  const accountId = '1234567890';

  beforeEach(() => {
    service = MetaService.getInstance();
    jest.clearAllMocks();
  });

  it('CAMPAIGN LIST default: requests spend_cap (and budget_remaining) from Graph', async () => {
    const getCampaigns = jest.fn().mockResolvedValue([{ _data: { id: 'c1' } }]);
    (AdAccount as unknown as jest.Mock).mockImplementation(() => ({ getCampaigns }));

    await service.listCampaigns(accountId, token);

    const requestedFields = getCampaigns.mock.calls[0][0] as string[];
    expect(requestedFields).toEqual(expect.arrayContaining(['spend_cap', 'budget_remaining']));
  });

  it('CAMPAIGN LIST honors an explicit fields selection including spend_cap', async () => {
    const getCampaigns = jest.fn().mockResolvedValue([]);
    (AdAccount as unknown as jest.Mock).mockImplementation(() => ({ getCampaigns }));

    await service.listCampaigns(accountId, token, { fields: 'spend_cap,budget_remaining' });

    expect(getCampaigns).toHaveBeenCalledWith(['spend_cap', 'budget_remaining']);
  });

  it('CAMPAIGN LIST passes spend_cap through from the Graph response unmodified', async () => {
    const getCampaigns = jest.fn().mockResolvedValue([
      { _data: { id: 'c1', spend_cap: '92200', budget_remaining: '150' } },
    ]);
    (AdAccount as unknown as jest.Mock).mockImplementation(() => ({ getCampaigns }));

    const result = await service.listCampaigns(accountId, token);

    expect(result).toEqual([{ id: 'c1', spend_cap: '92200', budget_remaining: '150' }]);
  });

  it('CAMPAIGN LIST single-campaign read (campaign_id) includes spend_cap in the requested fields', async () => {
    const get = jest.fn().mockResolvedValue({ _data: { id: 'camp_9', spend_cap: '5000' } });
    (Campaign as unknown as jest.Mock).mockImplementation(() => ({ get }));

    const result = await service.listCampaigns(accountId, token, { campaignId: 'camp_9' });

    expect(get.mock.calls[0][0]).toEqual(expect.arrayContaining(['spend_cap']));
    expect(result).toEqual([{ id: 'camp_9', spend_cap: '5000' }]);
  });

  it('CAMPAIGN LIST still rejects unknown fields LOUDLY after the widening (ENG-398 regression pin)', async () => {
    const getCampaigns = jest.fn().mockResolvedValue([]);
    (AdAccount as unknown as jest.Mock).mockImplementation(() => ({ getCampaigns }));

    await expect(
      service.listCampaigns(accountId, token, { fields: 'spend_cap,not_a_real_field' })
    ).rejects.toThrow(/Unsupported campaign field\(s\): not_a_real_field/);
    expect(getCampaigns).not.toHaveBeenCalled();
  });
});
