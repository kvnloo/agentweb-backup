// ENG-2364 — a CBO (campaign-budget) Meta campaign created without a campaign-level
// bid_strategy makes Meta reject EVERY ad set under it with error_subcode 1815857
// ("Bid amount required"), even when the ad set itself asks for LOWEST_COST_WITHOUT_CAP:
// under CBO the bid strategy lives on the campaign. Prod 2026-10-08 (Every.io): master
// campaign created, all 7 ad sets rejected. createCampaign must send the no-cap default
// whenever it sets a campaign budget, and must not send it when it does not.

import { MetaService } from '../services/metaService';
import { AdAccount } from 'facebook-nodejs-business-sdk';

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
