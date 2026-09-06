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

/**
 * ENG-1476 follow-up: a single-entity CAMPAIGN/AD_SET fetch verifies ownership because a node id
 * is global and is not bounded by the selected ad account. It requests `account_id` alongside the
 * caller's fields, so Graph answers both in ONE response — mock it that way rather than omitting
 * the field, which would let a fixture fail a check no real account would.
 */
function mockNodeGet(accountId: string, data: Record<string, any>) {
  // The single-entity read asks for `account_id` ALONGSIDE the caller's fields and checks
  // ownership from that same response, so Graph answers both in one payload.
  return jest.fn().mockImplementation(() =>
    Promise.resolve({ _data: { ...data, account_id: accountId } }),
  );
}

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
    const get = mockNodeGet(accountId, { id: 'camp_9', bid_strategy: 'LOWEST_COST_WITHOUT_CAP' });
    (Campaign as unknown as jest.Mock).mockImplementation(() => ({ get }));

    const result = await service.listCampaigns(accountId, token, { campaignId: 'camp_9' });

    expect(Campaign).toHaveBeenCalledWith('camp_9');
    expect(get).toHaveBeenCalled();
    expect(getCampaigns).not.toHaveBeenCalled(); // did not list the whole account
    expect(result).toEqual({
      campaigns: [{ id: 'camp_9', bid_strategy: 'LOWEST_COST_WITHOUT_CAP' }],
      truncated: false,
      pagesFetched: 1,
    });
  });

  it('CAMPAIGN LIST honors an explicit supported fields selection verbatim', async () => {
    const getCampaigns = jest.fn().mockResolvedValue([]);
    (AdAccount as unknown as jest.Mock).mockImplementation(() => ({ getCampaigns }));

    await service.listCampaigns(accountId, token, { fields: 'daily_budget,bid_strategy' });

    // ENG-1625: LIST now paginates, so every account-edge call also carries a page-size limit.
    expect(getCampaigns).toHaveBeenCalledWith(['daily_budget', 'bid_strategy'], { limit: 100 });
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
    const get = mockNodeGet(accountId, { id: 'as_9', optimization_goal: 'OFFSITE_CONVERSIONS', promoted_object: { pixel_id: 'px1', custom_event_type: 'LEAD' } });
    (AdSet as unknown as jest.Mock).mockImplementation(() => ({ get }));

    const result = await service.listAdSets(accountId, token, undefined, { adSetId: 'as_9' });

    expect(AdSet).toHaveBeenCalledWith('as_9');
    expect(get).toHaveBeenCalled();
    expect(getAdSets).not.toHaveBeenCalled();
    expect(result).toEqual({
      adSets: [
        { id: 'as_9', optimization_goal: 'OFFSITE_CONVERSIONS', promoted_object: { pixel_id: 'px1', custom_event_type: 'LEAD' } },
      ],
      truncated: false,
      pagesFetched: 1,
      scope: { adSetId: 'as_9' },
    });
  });

  it('AD_SET LIST honors an explicit supported fields selection verbatim', async () => {
    const getAdSets = jest.fn().mockResolvedValue([]);
    (AdAccount as unknown as jest.Mock).mockImplementation(() => ({ getAdSets }));

    await service.listAdSets(accountId, token, undefined, { fields: 'optimization_goal,promoted_object' });

    // ENG-1625: LIST now paginates, so every account-edge call also carries a page-size limit.
    expect(getAdSets).toHaveBeenCalledWith(['optimization_goal', 'promoted_object'], { limit: 100 });
  });

  /*
   * ENG-1625 — this pinned the exact ENG-1476 defect shape for ad sets: Meta's own docs for
   * the account-level adsets edge list only date_preset/effective_status/is_completed/
   * time_range as supported params, campaign_id is not among them, so a bare `campaign_id`
   * param here is likely silently ignored the same way a bare adset_id/campaign_id was on
   * the ads edge. Scoping now goes through the campaign NODE edge instead (the same fix
   * listAds already applies), which makes the scope structurally impossible to ignore.
   */
  it('AD_SET LIST scopes a campaign_id through the campaign NODE edge, never a bare param on the account edge', async () => {
    const accountGetAdSets = jest.fn();
    const campaignGetAdSets = jest.fn().mockResolvedValue([]);
    (AdAccount as unknown as jest.Mock).mockImplementation(() => ({ getAdSets: accountGetAdSets }));
    (Campaign as unknown as jest.Mock).mockImplementation(() => ({
      getAdSets: campaignGetAdSets,
      get: jest.fn().mockResolvedValue({ _data: { account_id: accountId } }),
    }));

    const result = await service.listAdSets(accountId, token, 'camp_123');

    expect(Campaign).toHaveBeenCalledWith('camp_123');
    expect(campaignGetAdSets).toHaveBeenCalled();
    // The exact regression: campaign scope used to fall through to an account-wide list via
    // a bare, silently-ignored campaign_id param.
    expect(accountGetAdSets).not.toHaveBeenCalled();
    const params = campaignGetAdSets.mock.calls[0][1];
    expect(params).not.toHaveProperty('campaign_id');
    expect(result.scope).toEqual({ campaignId: 'camp_123' });
  });

  it('AD_SET LIST refuses a campaign that belongs to a different ad account', async () => {
    (AdAccount as unknown as jest.Mock).mockImplementation(() => ({ getAdSets: jest.fn() }));
    const campaignGetAdSets = jest.fn();
    (Campaign as unknown as jest.Mock).mockImplementation(() => ({
      getAdSets: campaignGetAdSets,
      get: jest.fn().mockResolvedValue({ _data: { account_id: '999_other' } }),
    }));

    await expect(service.listAdSets(accountId, token, 'camp_from_B'))
      .rejects.toThrow(/The requested campaign is not available in the selected ad account/);
    expect(campaignGetAdSets).not.toHaveBeenCalled();
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

    // ENG-1625: LIST now paginates, so every account-edge call also carries a page-size limit.
    expect(getCampaigns).toHaveBeenCalledWith(['spend_cap', 'budget_remaining'], { limit: 100 });
  });

  it('CAMPAIGN LIST passes spend_cap through from the Graph response unmodified', async () => {
    const getCampaigns = jest.fn().mockResolvedValue([
      { _data: { id: 'c1', spend_cap: '92200', budget_remaining: '150' } },
    ]);
    (AdAccount as unknown as jest.Mock).mockImplementation(() => ({ getCampaigns }));

    const result = await service.listCampaigns(accountId, token);

    expect(result).toEqual({
      campaigns: [{ id: 'c1', spend_cap: '92200', budget_remaining: '150' }],
      truncated: false,
      pagesFetched: 1,
    });
  });

  it('CAMPAIGN LIST single-campaign read (campaign_id) includes spend_cap in the requested fields', async () => {
    const get = mockNodeGet(accountId, { id: 'camp_9', spend_cap: '5000' });
    (Campaign as unknown as jest.Mock).mockImplementation(() => ({ get }));

    const result = await service.listCampaigns(accountId, token, { campaignId: 'camp_9' });

    // The single-entity read asks for `account_id` alongside the caller's fields in ONE call,
    // so there is no separate probe; select the call that carries the field selection rather
    // than relying on call order. The invariant pinned here is unchanged.
    const fieldCall = get.mock.calls.find(
      (c: any[]) => !(Array.isArray(c[0]) && c[0].length === 1 && c[0][0] === 'account_id'),
    );
    expect(fieldCall?.[0]).toEqual(expect.arrayContaining(['spend_cap']));
    expect(result).toEqual({
      campaigns: [{ id: 'camp_9', spend_cap: '5000' }],
      truncated: false,
      pagesFetched: 1,
    });
  });

  it('CAMPAIGN LIST still rejects unknown fields LOUDLY after the widening (ENG-398 regression pin)', async () => {
    const getCampaigns = jest.fn().mockResolvedValue([]);
    (AdAccount as unknown as jest.Mock).mockImplementation(() => ({ getCampaigns }));

    await expect(
      service.listCampaigns(accountId, token, { fields: 'spend_cap,not_a_real_field' })
    ).rejects.toThrow(/Unsupported campaign field\(s\): not_a_real_field/);
    expect(getCampaigns).not.toHaveBeenCalled();
  });

  it('CAMPAIGN LIST treats an empty fields selection as the default boundary', async () => {
    const getCampaigns = jest.fn().mockResolvedValue([]);
    (AdAccount as unknown as jest.Mock).mockImplementation(() => ({ getCampaigns }));

    await service.listCampaigns(accountId, token, { fields: ' , ' });

    expect(getCampaigns.mock.calls[0][0]).toEqual(expect.arrayContaining(['spend_cap', 'budget_remaining']));
  });

  it('CAMPAIGN LIST propagates Graph errors with structured context', async () => {
    const graphError = Object.assign(new Error('Graph unavailable'), { code: 2 });
    const getCampaigns = jest.fn().mockRejectedValue(graphError);
    (AdAccount as unknown as jest.Mock).mockImplementation(() => ({ getCampaigns }));

    await expect(service.listCampaigns(accountId, token)).rejects.toMatchObject({
      message: 'Graph unavailable',
      structuredError: expect.objectContaining({ classification: 'RETRYABLE_ERROR', code: 2 }),
    });
  });
});

// ENG-1625 — a live post-deploy read-back requested effective_status and
// special_ad_categories (both real Campaign GET fields — effective_status was already
// allow-listed for ads) and was rejected LOUDLY because CAMPAIGN_READ_FIELDS hadn't been
// widened to include them, the same defect shape as ENG-398/ENG-785. Same fix: widen the
// allow-list so the verification read succeeds instead of throwing.
describe('MetaService CAMPAIGN effective_status / special_ad_categories read (ENG-1625)', () => {
  let service: MetaService;
  const token = 'mock_token';
  const accountId = '1234567890';

  beforeEach(() => {
    service = MetaService.getInstance();
    jest.clearAllMocks();
  });

  it('CAMPAIGN LIST honors an explicit fields selection including effective_status and special_ad_categories', async () => {
    const getCampaigns = jest.fn().mockResolvedValue([]);
    (AdAccount as unknown as jest.Mock).mockImplementation(() => ({ getCampaigns }));

    await service.listCampaigns(accountId, token, { fields: 'effective_status,special_ad_categories' });

    // ENG-1625: LIST now paginates, so every account-edge call also carries a page-size limit.
    expect(getCampaigns).toHaveBeenCalledWith(['effective_status', 'special_ad_categories'], { limit: 100 });
  });

  it('CAMPAIGN LIST default now includes effective_status and special_ad_categories', async () => {
    const getCampaigns = jest.fn().mockResolvedValue([{ _data: { id: 'c1' } }]);
    (AdAccount as unknown as jest.Mock).mockImplementation(() => ({ getCampaigns }));

    await service.listCampaigns(accountId, token);

    const requestedFields = getCampaigns.mock.calls[0][0] as string[];
    expect(requestedFields).toEqual(
      expect.arrayContaining(['effective_status', 'special_ad_categories'])
    );
  });

  it('CAMPAIGN LIST single-campaign read (campaign_id) honors effective_status and special_ad_categories', async () => {
    const get = mockNodeGet(accountId, { id: 'camp_9', effective_status: 'CAMPAIGN_PAUSED', special_ad_categories: ['NONE'] });
    (Campaign as unknown as jest.Mock).mockImplementation(() => ({ get }));

    const result = await service.listCampaigns(accountId, token, {
      campaignId: 'camp_9',
      fields: 'effective_status,special_ad_categories',
    });

    // The single-entity read also asks for `account_id` to verify ownership in the same call.
    // What this pins is that the caller's selection is honoured, not the exact array.
    expect(get).toHaveBeenCalledWith(expect.arrayContaining(['effective_status', 'special_ad_categories']));
    expect(result).toEqual({
      campaigns: [{ id: 'camp_9', effective_status: 'CAMPAIGN_PAUSED', special_ad_categories: ['NONE'] }],
      truncated: false,
      pagesFetched: 1,
    });
  });

  it('CAMPAIGN LIST still rejects unknown fields LOUDLY after the widening (ENG-398 regression pin)', async () => {
    const getCampaigns = jest.fn().mockResolvedValue([]);
    (AdAccount as unknown as jest.Mock).mockImplementation(() => ({ getCampaigns }));

    await expect(
      service.listCampaigns(accountId, token, { fields: 'effective_status,not_a_real_field' })
    ).rejects.toThrow(/Unsupported campaign field\(s\): not_a_real_field/);
    expect(getCampaigns).not.toHaveBeenCalled();
  });
});
