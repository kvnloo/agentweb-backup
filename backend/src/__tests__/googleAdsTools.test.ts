jest.mock('../services/googleAdsService', () => ({
  googleAdsService: {
    listCampaigns: jest.fn().mockResolvedValue([
      { id: '1', name: 'Test', status: 'ENABLED', type: 'SEARCH', resourceName: 'customers/123/campaigns/1' },
    ]),
    createBudget: jest.fn().mockResolvedValue({ resourceName: 'customers/123/campaignBudgets/1' }),
    createCampaign: jest.fn().mockResolvedValue({ resourceName: 'customers/123/campaigns/1' }),
    pauseCampaign: jest.fn().mockResolvedValue(undefined),
    resumeCampaign: jest.fn().mockResolvedValue(undefined),
    addKeywords: jest.fn().mockResolvedValue(undefined),
    searchLocations: jest.fn().mockResolvedValue([
      { id: '2840', name: 'United States', countryCode: 'US', targetType: 'Country' },
    ]),
    listAdGroups: jest.fn().mockResolvedValue([]),
    createAdGroup: jest.fn().mockResolvedValue({ resourceName: 'customers/123/adGroups/1' }),
    queryReporting: jest.fn().mockResolvedValue([
      { campaign: { id: '1' }, metrics: { clicks: '100' } },
    ]),
    getQuickMetrics: jest.fn().mockResolvedValue({
      campaigns: [{ id: '1', name: 'Test', impressions: 5000, clicks: 200, ctr: 4.0, spendFormatted: '100.00', conversions: 5, avgCpc: '0.50' }],
      totals: { impressions: 5000, clicks: 200, spend: 100, conversions: 5 },
      currency: 'USD',
    }),
  },
}));

import { AgentModeService } from '../services/agentModeService';

let service: AgentModeService;
beforeEach(() => {
  jest.clearAllMocks();
  service = new AgentModeService();
});

describe('handleCallGoogleAdsApi', () => {
  it('handles CAMPAIGN LIST action', async () => {
    const result = await service.handleCallGoogleAdsApi('user-123', {
      customer_id: '1234567890',
      entity_type: 'CAMPAIGN',
      action: 'LIST',
    });
    expect(result.success).toBe(true);
    expect(result.campaigns).toHaveLength(1);
  });

  it('handles CAMPAIGN PAUSE action', async () => {
    const result = await service.handleCallGoogleAdsApi('user-123', {
      customer_id: '1234567890',
      entity_type: 'CAMPAIGN',
      action: 'PAUSE',
      campaign_resource_name: 'customers/123/campaigns/1',
    });
    expect(result.success).toBe(true);
  });

  it('returns error for PAUSE without campaign_resource_name', async () => {
    const result = await service.handleCallGoogleAdsApi('user-123', {
      customer_id: '1234567890',
      entity_type: 'CAMPAIGN',
      action: 'PAUSE',
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/campaign_resource_name/i);
  });

  it('handles BUDGET CREATE action', async () => {
    const result = await service.handleCallGoogleAdsApi('user-123', {
      customer_id: '1234567890',
      entity_type: 'BUDGET',
      action: 'CREATE',
      name: 'My Budget',
      amount_micros: 10_000_000,
    });
    expect(result.success).toBe(true);
    expect(result.budgetResourceName).toBeDefined();
  });

  it('handles LOCATION SEARCH action', async () => {
    const result = await service.handleCallGoogleAdsApi('user-123', {
      customer_id: '1234567890',
      entity_type: 'LOCATION',
      action: 'SEARCH',
      query: 'United States',
    });
    expect(result.success).toBe(true);
    expect(result.locations).toHaveLength(1);
    expect(result.locations[0].name).toBe('United States');
  });
});

describe('handleCallGoogleAdsReportingApi', () => {
  it('handles dashboard mode', async () => {
    const result = await service.handleCallGoogleAdsReportingApi('user-123', {
      customer_id: '1234567890',
      mode: 'dashboard',
    });
    expect(result.success).toBe(true);
    expect(result.formattedMarkdown).toContain('Test');
    expect(result.formattedMarkdown).toContain('Google Ads');
  });

  it('handles raw mode with GAQL query', async () => {
    const result = await service.handleCallGoogleAdsReportingApi('user-123', {
      customer_id: '1234567890',
      mode: 'raw',
      query: 'SELECT campaign.id FROM campaign',
    });
    expect(result.success).toBe(true);
    expect(result.results).toBeDefined();
    expect(result.totalRows).toBe(1);
  });

  it('returns error for raw mode without query', async () => {
    const result = await service.handleCallGoogleAdsReportingApi('user-123', {
      customer_id: '1234567890',
      mode: 'raw',
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/query/i);
  });
});
