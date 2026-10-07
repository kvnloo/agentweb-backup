jest.mock('../mcp/client/mcpClientService', () => ({
  McpClientService: jest.fn().mockImplementation(() => ({ isReady: jest.fn().mockReturnValue(true) }))
}));
jest.mock('../services/metaService', () => ({
  ...jest.requireActual('../services/metaService'),
  metaService: {
    getAdAccountCurrency: jest.fn(), createCampaign: jest.fn(), updateCampaign: jest.fn(),
    getCampaign: jest.fn(), createAdSet: jest.fn(), updateAdSet: jest.fn(), getAdSet: jest.fn(),
  }
}));
import { AgentModeService } from '../services/agentModeService';
import { metaService } from '../services/metaService';

const meta = metaService as any;
describe('ENG-2277 currency-aware Meta money writes', () => {
  let service: AgentModeService;
  beforeEach(() => {
    jest.clearAllMocks();
    service = new AgentModeService();
    jest.spyOn(service as any, 'getMetaCredentials').mockResolvedValue({ accountId: '123', accessToken: 'token' });
    meta.getAdAccountCurrency.mockResolvedValue('TWD');
    meta.createCampaign.mockResolvedValue({ id: 'campaign' });
    meta.getCampaign.mockResolvedValue({ id: 'campaign', objective: 'OUTCOME_TRAFFIC', spend_cap: '300000' });
    meta.createAdSet.mockResolvedValue({ id: 'adset', name: 'Daily' });
    meta.getAdSet.mockResolvedValue({ daily_budget: '300', bid_strategy: 'LOWEST_COST_WITHOUT_CAP' });
  });

  it.each(['create', 'update'])('TWD NT$300/day stays 300 on campaign %s and echoes both units', async action => {
    const params = { name: 'Daily', objective: 'OUTCOME_TRAFFIC', advantage_campaign_budget: true, budget_amount: 300 };
    const result = action === 'create'
      ? await service.createMetaAdsCampaign('user', params)
      : await service.updateMetaAdsCampaign('user', 'campaign', params);
    const sent = meta[action === 'create' ? 'createCampaign' : 'updateCampaign'].mock.calls[0][2];
    expect(sent.daily_budget).toBe(300);
    expect(sent.daily_budget).not.toBe(30000);
    expect(result.message).toContain('300 (= NT$300.00)');
  });

  it.each(['create', 'update'])('USD $3,000 cap becomes 300000 on %s, never a $30 cap', async action => {
    meta.getAdAccountCurrency.mockResolvedValue('USD');
    const params = { name: 'Capped', objective: 'OUTCOME_TRAFFIC', spend_cap: 3000 };
    const result = action === 'create'
      ? await service.createMetaAdsCampaign('user', params)
      : await service.updateMetaAdsCampaign('user', 'campaign', params);
    expect(meta[action === 'create' ? 'createCampaign' : 'updateCampaign'].mock.calls[0][2].spend_cap).toBe(300000);
    expect(result.spend_cap_verified).toBe(true);
    expect(result.message).toContain('300000 (= $3,000.00)');
    expect(result.message).not.toContain('= $30.00');
  });

  it('preserves a USD fractional major-unit cap', async () => {
    meta.getAdAccountCurrency.mockResolvedValue('USD');
    meta.getCampaign.mockResolvedValue({ spend_cap: '300050' });
    const result = await service.updateMetaAdsCampaign('user', 'campaign', { spend_cap: 3000.50 });
    expect(meta.updateCampaign.mock.calls[0][2].spend_cap).toBe(300050);
    expect(result.message).toContain('300050 (= $3,000.50)');
    expect(result.spend_cap_verified).toBe(true);
  });

  it.each(['daily_budget', 'lifetime_budget', 'bid_amount'])('normalizes and describes ad-set %s', async field => {
    // ENG-2343: read-back must echo the field actually written so ENG-2278's confirmation can succeed.
    meta.getAdSet.mockResolvedValue({ [field]: '300', bid_strategy: 'LOWEST_COST_WITHOUT_CAP' });
    const result = await service.updateMetaAdsAdSet('user', 'adset', { [field]: 300 });
    expect(meta.updateAdSet.mock.calls[0][2][field]).toBe(300);
    expect(result.message).toContain(`${field}: 300 (= NT$300.00)`);
  });

  it('normalizes ad-set creation without multiplying TWD by 100', async () => {
    const result = await service.createMetaAdsAdSet('user', {
      name: 'Daily', campaign_id: 'campaign', daily_budget: 300,
      billing_event: 'IMPRESSIONS', optimization_goal: 'LINK_CLICKS',
      targeting: { geo_locations: { countries: ['TW'] } },
    });
    expect(meta.createAdSet.mock.calls[0][2].daily_budget).toBe(300);
    expect(result.message).toContain('300 (= NT$300.00)');
  });

  it.each(['ZZZ', undefined, 123])('rejects unsupported/malformed currency %s before a write', async currency => {
    meta.getAdAccountCurrency.mockResolvedValue(currency);
    const result = await service.updateMetaAdsAdSet('user', 'adset', { daily_budget: 300 });
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/currency/i);
    expect(meta.updateAdSet).not.toHaveBeenCalled();
  });

  it('leaves status-only writes independent of currency lookup', async () => {
    const result = await service.updateMetaAdsCampaign('user', 'campaign', { status: 'PAUSED' });
    expect(result.success).toBe(true);
    expect(meta.getAdAccountCurrency).not.toHaveBeenCalled();
  });
});

describe('ENG-2277 fail-closed money write paths', () => {
  let service: AgentModeService;
  beforeEach(() => {
    jest.clearAllMocks();
    service = new AgentModeService();
    jest.spyOn(service as any, 'getMetaCredentials').mockResolvedValue({ accountId: '123', accessToken: 'token' });
    meta.getAdAccountCurrency.mockResolvedValue('ZZZ');
    meta.getCampaign.mockResolvedValue({ objective: 'OUTCOME_TRAFFIC' });
  });
  it.each(['createCampaign', 'updateCampaign', 'createAdSet', 'updateAdSet'])('rejects unknown currency before %s', async method => {
    const results: Record<string, () => Promise<any>> = {
      createCampaign: () => service.createMetaAdsCampaign('user', { name: 'C', objective: 'OUTCOME_TRAFFIC', spend_cap: 3000 }),
      updateCampaign: () => service.updateMetaAdsCampaign('user', 'c', { spend_cap: 3000 }),
      createAdSet: () => service.createMetaAdsAdSet('user', {
        name: 'A', campaign_id: 'c', daily_budget: 300, billing_event: 'IMPRESSIONS',
        optimization_goal: 'LINK_CLICKS', targeting: { geo_locations: { countries: ['TW'] } },
      }),
      updateAdSet: () => service.updateMetaAdsAdSet('user', 'a', { bid_amount: 3 }),
    };
    const result = await results[method]();
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/currency/);
    expect(meta[method]).not.toHaveBeenCalled();
  });
  it('keeps all money descriptions and major-unit retry input when cap verification fails', async () => {
    jest.useFakeTimers();
    try {
      meta.getAdAccountCurrency.mockResolvedValue('USD');
      meta.createCampaign.mockResolvedValue({ id: 'c' });
      const pending = service.createMetaAdsCampaign('user', {
        name: 'C', objective: 'OUTCOME_TRAFFIC', spend_cap: 3000,
        advantage_campaign_budget: true, budget_amount: 20,
      } as any);
      await jest.advanceTimersByTimeAsync(15000);
      const result = await pending;
      expect(result.success).toBe(true);
      expect(result.spend_cap_verified).toBe(false);
      expect(result.message).toContain('300000 (= $3,000.00)');
      expect(result.message).toContain('2000 (= $20.00)');
      expect(result.message).toContain('params.spend_cap=3000)');
    } finally {
      jest.useRealTimers();
    }
  });
});
