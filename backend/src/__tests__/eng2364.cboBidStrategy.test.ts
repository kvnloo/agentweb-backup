// ENG-2364 — a CBO (campaign-budget) Meta campaign created without a campaign-level
// bid_strategy makes Meta reject EVERY ad set under it with error_subcode 1815857
// ("Bid amount required"), even when the ad set itself asks for LOWEST_COST_WITHOUT_CAP:
// under CBO the bid strategy lives on the campaign. Prod 2026-10-08 (Every.io): master
// campaign created, all 7 ad sets rejected. createCampaign must send the no-cap default
// whenever it sets a campaign budget, and must not send it when it does not.

import { MetaService } from '../services/metaService';
import { AdAccount, Campaign } from 'facebook-nodejs-business-sdk';

jest.mock('facebook-nodejs-business-sdk', () => ({
  FacebookAdsApi: { init: jest.fn() },
  AdAccount: jest.fn(),
  Campaign: Object.assign(jest.fn(), { Fields: {} }),
  AdSet: jest.fn(),
  AdCreative: Object.assign(jest.fn(), { Fields: {} }),
  Ad: Object.assign(jest.fn(), { Fields: {}, Status: {} }),
  CustomAudience: jest.fn(),
  User: jest.fn(),
}));

jest.mock('../utils/secretsManager', () => ({ getMetaCredentials: jest.fn() }));

describe('MetaService.createCampaign CBO bid strategy (ENG-2364)', () => {
  let createCampaign: jest.Mock;
  const service = MetaService.getInstance();

  beforeEach(() => {
    jest.clearAllMocks();
    createCampaign = jest.fn().mockResolvedValue({ _data: { id: 'c1' } });
    (AdAccount as unknown as jest.Mock).mockImplementation(() => ({ createCampaign }));
  });

  const sent = () => createCampaign.mock.calls[0][1];

  it('sends bid_strategy LOWEST_COST_WITHOUT_CAP with a CBO daily_budget', async () => {
    await service.createCampaign('123', 't', {
      name: 'ACB', objective: 'OUTCOME_LEADS', daily_budget: 25000,
    } as any);
    expect(sent()).toMatchObject({ daily_budget: 25000, bid_strategy: 'LOWEST_COST_WITHOUT_CAP' });
  });

  it('sends the default for the advantage_campaign_budget + budget_amount path too', async () => {
    jest.spyOn(service as any, 'getAdAccountCurrency').mockResolvedValue('USD');
    await service.createCampaign('123', 't', {
      name: 'ACB', objective: 'OUTCOME_LEADS', advantage_campaign_budget: true, budget_amount: 250,
    } as any);
    expect(sent()).toMatchObject({ daily_budget: 25000, bid_strategy: 'LOWEST_COST_WITHOUT_CAP' });
  });

  it('does not send a campaign bid_strategy when there is no campaign budget (ABO)', async () => {
    await service.createCampaign('123', 't', { name: 'ABO', objective: 'OUTCOME_LEADS' } as any);
    expect(sent()).not.toHaveProperty('bid_strategy');
    expect(sent()).not.toHaveProperty('daily_budget');
  });

  it('sends is_adset_budget_sharing_enabled only without a campaign budget (it describes ad-set budgets)', async () => {
    await service.createCampaign('123', 't', { name: 'ABO', objective: 'OUTCOME_LEADS' } as any);
    expect(sent()).toMatchObject({ is_adset_budget_sharing_enabled: false });
    createCampaign.mockClear();
    await service.createCampaign('123', 't', { name: 'ACB', objective: 'OUTCOME_LEADS', daily_budget: 5000 } as any);
    expect(sent()).not.toHaveProperty('is_adset_budget_sharing_enabled');
  });
});

// Same failure on UPDATE: giving an existing campaign a budget without a bid strategy leaves
// Meta on LOWEST_COST_WITH_BID_CAP, and ad set create/copy then fails with subcode 1815857.
describe('MetaService.updateCampaign CBO bid strategy (ENG-2364)', () => {
  let update: jest.Mock;
  let get: jest.Mock;
  const service = MetaService.getInstance();

  const mockCampaign = (data: Record<string, any>) => {
    update = jest.fn().mockResolvedValue({});
    get = jest.fn().mockResolvedValue({ _data: { account_id: 'act_123', ...data } });
    (Campaign as unknown as jest.Mock).mockImplementation(() => ({ get, update }));
  };
  const sent = () => update.mock.calls[0][1];

  beforeEach(() => jest.clearAllMocks());

  it('sends LOWEST_COST_WITHOUT_CAP when a daily_budget is added and no bid_strategy is given', async () => {
    mockCampaign({});
    await expect(service.updateCampaign('t', 'c1', { daily_budget: 5000 }, '123')).resolves.toEqual({ success: true });
    expect(sent()).toEqual({ daily_budget: 5000, bid_strategy: 'LOWEST_COST_WITHOUT_CAP' });
  });

  it('does the same for lifetime_budget', async () => {
    mockCampaign({});
    await service.updateCampaign('t', 'c1', { lifetime_budget: 90000 }, '123');
    expect(sent()).toEqual({ lifetime_budget: 90000, bid_strategy: 'LOWEST_COST_WITHOUT_CAP' });
  });

  it('never overrides an explicit bid_strategy', async () => {
    mockCampaign({});
    await service.updateCampaign('t', 'c1', { daily_budget: 5000, bid_strategy: 'COST_CAP' }, '123');
    expect(sent()).toEqual({ daily_budget: 5000, bid_strategy: 'COST_CAP' });
  });

  it('does not add a bid_strategy when no budget is set', async () => {
    mockCampaign({});
    await service.updateCampaign('t', 'c1', { name: 'Renamed' }, '123');
    expect(sent()).toEqual({ name: 'Renamed' });
  });

  it('leaves the strategy of a campaign that already has a budget alone on a budget change', async () => {
    mockCampaign({ daily_budget: '3000' });
    await service.updateCampaign('t', 'c1', { daily_budget: 5000 }, '123');
    expect(sent()).toEqual({ daily_budget: 5000 });
  });

  it('keeps a COST_CAP campaign on COST_CAP on a budget-only update (sends no bid_strategy)', async () => {
    mockCampaign({ bid_strategy: 'COST_CAP' });
    await service.updateCampaign('t', 'c1', { daily_budget: 5000 }, '123');
    expect(sent()).toEqual({ daily_budget: 5000 });
  });

  it('reads the current bid_strategy in the pre-write ownership read', async () => {
    mockCampaign({});
    await service.updateCampaign('t', 'c1', { daily_budget: 5000 }, '123');
    expect(get.mock.calls[0][0]).toEqual(expect.arrayContaining(['daily_budget', 'lifetime_budget', 'bid_strategy']));
  });
});
