// ENG-1018 — campaign spend_cap is a money-affecting hard stop, so it must be
// (a) actually forwarded to Meta on CREATE (it was silently dropped by
// createCampaign's literal-key allow-list), and (b) readable back through
// CAMPAIGN LIST (it was not in CAMPAIGN_READ_FIELDS, so a read-back request was
// rejected as an unsupported field). Together those two gaps made a spend cap
// requestable, reported as successful, never applied, and unverifiable.
//
// These assertions pin the metaService (Graph API wrapper) half of the fix, with
// the facebook-nodejs-business-sdk mocked.

import { MetaService } from '../services/metaService';
import { AdAccount, Campaign } from 'facebook-nodejs-business-sdk';

jest.mock('facebook-nodejs-business-sdk', () => {
  return {
    FacebookAdsApi: { init: jest.fn() },
    AdAccount: jest.fn().mockImplementation(() => ({
      getCampaigns: jest.fn(),
      createCampaign: jest.fn(),
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

describe('MetaService campaign spend_cap (ENG-1018)', () => {
  let service: MetaService;
  const token = 'mock_token';
  const accountId = '1234567890';

  beforeEach(() => {
    service = MetaService.getInstance();
    jest.clearAllMocks();
  });

  // ---------------- READ BACK ----------------

  it('CAMPAIGN LIST default: requests spend_cap from Graph', async () => {
    const getCampaigns = jest.fn().mockResolvedValue([{ _data: { id: 'c1', spend_cap: '300000' } }]);
    (AdAccount as unknown as jest.Mock).mockImplementation(() => ({ getCampaigns }));

    const result = await service.listCampaigns(accountId, token);

    expect(getCampaigns.mock.calls[0][0] as string[]).toEqual(expect.arrayContaining(['spend_cap']));
    expect(result).toEqual([{ id: 'c1', spend_cap: '300000' }]);
  });

  it('CAMPAIGN LIST accepts an explicit spend_cap fields selection instead of rejecting it', async () => {
    const getCampaigns = jest.fn().mockResolvedValue([]);
    (AdAccount as unknown as jest.Mock).mockImplementation(() => ({ getCampaigns }));

    await service.listCampaigns(accountId, token, { fields: 'id,name,spend_cap' });

    expect(getCampaigns).toHaveBeenCalledWith(['id', 'name', 'spend_cap']);
  });

  it('getCampaign reads spend_cap back so a write can be verified', async () => {
    const get = jest.fn().mockResolvedValue({ _data: { id: 'camp_9', spend_cap: '300000' } });
    (Campaign as unknown as jest.Mock).mockImplementation(() => ({ get }));

    const result = await service.getCampaign(accountId, token, 'camp_9');

    expect(get.mock.calls[0][0] as string[]).toEqual(expect.arrayContaining(['spend_cap']));
    expect(result).toEqual({ id: 'camp_9', spend_cap: '300000' });
  });

  // ---------------- WRITE ON CREATE ----------------

  it('createCampaign forwards spend_cap to Meta instead of silently dropping it', async () => {
    const createCampaign = jest.fn().mockResolvedValue({ _data: { id: 'camp_new' } });
    (AdAccount as unknown as jest.Mock).mockImplementation(() => ({ createCampaign }));

    await service.createCampaign(accountId, token, {
      name: 'Capped campaign',
      objective: 'OUTCOME_TRAFFIC',
      special_ad_categories: ['NONE'],
      spend_cap: 100000,
    });

    const finalParams = createCampaign.mock.calls[0][1];
    expect(finalParams.spend_cap).toBe(100000);
  });

  it('createCampaign omits spend_cap entirely when the caller did not ask for one', async () => {
    const createCampaign = jest.fn().mockResolvedValue({ _data: { id: 'camp_new' } });
    (AdAccount as unknown as jest.Mock).mockImplementation(() => ({ createCampaign }));

    await service.createCampaign(accountId, token, {
      name: 'Uncapped campaign',
      objective: 'OUTCOME_TRAFFIC',
      special_ad_categories: ['NONE'],
    });

    expect('spend_cap' in createCampaign.mock.calls[0][1]).toBe(false);
  });

  // ---------------- NO SILENT DROPS ----------------

  it('rejects a CAMPAIGN CREATE param the create path would silently drop', () => {
    expect(() =>
      MetaService.validateCampaignParamsExceptObjective('CREATE', {
        name: 'C',
        // Campaign-level budget must go through advantage_campaign_budget + budget_amount;
        // a bare daily_budget never reaches Meta on CAMPAIGN CREATE.
        daily_budget: 5000,
      } as any)
    ).toThrow(/daily_budget/);
  });

  it('accepts every documented CAMPAIGN CREATE param (including spend_cap and gate-only keys)', () => {
    expect(() =>
      MetaService.validateCampaignParamsExceptObjective('CREATE', {
        name: 'C',
        objective: 'OUTCOME_TRAFFIC',
        objective_quote: 'traffic campaign',
        status: 'PAUSED',
        special_ad_categories: ['NONE'],
        spend_cap: 100000,
        advantage_campaign_budget: true,
        budget_amount: 50,
        account_id: '1234567890',
        confirm: true,
      } as any)
    ).not.toThrow();
  });

  it('does not police params on UPDATE (pass-through is real there)', () => {
    expect(() =>
      MetaService.validateCampaignParamsExceptObjective('UPDATE', { spend_cap: 300000, anything: 1 } as any)
    ).not.toThrow();
  });
});
