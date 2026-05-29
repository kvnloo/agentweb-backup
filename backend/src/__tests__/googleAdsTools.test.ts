jest.mock('../services/googleAdsService', () => ({
  googleAdsService: {
    listCampaigns: jest.fn().mockResolvedValue([
      { id: '1', name: 'Test', status: 'ENABLED', type: 'SEARCH', resourceName: 'customers/123/campaigns/1' },
    ]),
    createBudget: jest.fn().mockResolvedValue({ resourceName: 'customers/123/campaignBudgets/1' }),
    createCampaign: jest.fn().mockResolvedValue({ resourceName: 'customers/123/campaigns/1' }),
    pauseCampaign: jest.fn().mockResolvedValue(undefined),
    resumeCampaign: jest.fn().mockResolvedValue(undefined),
    updateCampaign: jest.fn().mockResolvedValue(undefined),
    addKeywords: jest.fn().mockResolvedValue(undefined),
    addNegativeKeywords: jest.fn().mockResolvedValue(undefined),
    searchLocations: jest.fn().mockResolvedValue([
      { id: '2840', name: 'United States', countryCode: 'US', targetType: 'Country' },
    ]),
    listAdGroups: jest.fn().mockResolvedValue([]),
    createAdGroup: jest.fn().mockResolvedValue({ resourceName: 'customers/123/adGroups/1' }),
    updateAdGroup: jest.fn().mockResolvedValue(undefined),
    listAds: jest.fn().mockResolvedValue([
      { id: '1', adGroup: 'customers/123/adGroups/1', type: 'RESPONSIVE_SEARCH_AD', status: 'PAUSED' },
    ]),
    createAd: jest.fn().mockResolvedValue({ resourceName: 'customers/123/adGroupAds/1' }),
    uploadAsset: jest.fn().mockResolvedValue('customers/123/assets/1'),
    createAssetGroup: jest.fn().mockResolvedValue({ resourceName: 'customers/123/assetGroups/1' }),
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

  it('handles CAMPAIGN RESUME action', async () => {
    const result = await service.handleCallGoogleAdsApi('user-123', {
      customer_id: '1234567890',
      entity_type: 'CAMPAIGN',
      action: 'RESUME',
      campaign_resource_name: 'customers/123/campaigns/1',
    });
    expect(result.success).toBe(true);
  });

  it('returns error for RESUME without campaign_resource_name', async () => {
    const result = await service.handleCallGoogleAdsApi('user-123', {
      customer_id: '1234567890',
      entity_type: 'CAMPAIGN',
      action: 'RESUME',
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/campaign_resource_name/i);
  });

  it('handles CAMPAIGN CREATE action', async () => {
    const result = await service.handleCallGoogleAdsApi('user-123', {
      customer_id: '1234567890',
      entity_type: 'CAMPAIGN',
      action: 'CREATE',
      name: 'New Campaign',
      type: 'SEARCH',
      budget_resource_name: 'customers/123/campaignBudgets/1',
      bidding_strategy: 'MAXIMIZE_CONVERSIONS',
    });
    expect(result.success).toBe(true);
    expect(result.campaignResourceName).toBeDefined();
  });

  it('returns error for CAMPAIGN CREATE without required fields', async () => {
    const result = await service.handleCallGoogleAdsApi('user-123', {
      customer_id: '1234567890',
      entity_type: 'CAMPAIGN',
      action: 'CREATE',
      name: 'New Campaign',
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/name|budget_resource_name|bidding_strategy/i);
  });

  it('handles CAMPAIGN UPDATE action', async () => {
    const result = await service.handleCallGoogleAdsApi('user-123', {
      customer_id: '1234567890',
      entity_type: 'CAMPAIGN',
      action: 'UPDATE',
      campaign_resource_name: 'customers/123/campaigns/1',
      name: 'Updated Name',
    });
    expect(result.success).toBe(true);
  });

  it('returns error for CAMPAIGN UPDATE without campaign_resource_name', async () => {
    const result = await service.handleCallGoogleAdsApi('user-123', {
      customer_id: '1234567890',
      entity_type: 'CAMPAIGN',
      action: 'UPDATE',
      name: 'Updated Name',
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/campaign_resource_name/i);
  });

  it('handles AD_GROUP LIST action', async () => {
    const result = await service.handleCallGoogleAdsApi('user-123', {
      customer_id: '1234567890',
      entity_type: 'AD_GROUP',
      action: 'LIST',
      campaign_resource_name: 'customers/123/campaigns/1',
    });
    expect(result.success).toBe(true);
    expect(result.adGroups).toBeDefined();
  });

  it('handles AD_GROUP CREATE action', async () => {
    const result = await service.handleCallGoogleAdsApi('user-123', {
      customer_id: '1234567890',
      entity_type: 'AD_GROUP',
      action: 'CREATE',
      name: 'New Ad Group',
      campaign_resource_name: 'customers/123/campaigns/1',
      type: 'SEARCH_STANDARD',
    });
    expect(result.success).toBe(true);
    expect(result.adGroupResourceName).toBeDefined();
  });

  it('returns error for AD_GROUP CREATE without campaign_resource_name', async () => {
    const result = await service.handleCallGoogleAdsApi('user-123', {
      customer_id: '1234567890',
      entity_type: 'AD_GROUP',
      action: 'CREATE',
      name: 'New Ad Group',
      type: 'SEARCH_STANDARD',
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/campaign_resource_name/i);
  });

  it('handles AD_GROUP UPDATE action', async () => {
    const result = await service.handleCallGoogleAdsApi('user-123', {
      customer_id: '1234567890',
      entity_type: 'AD_GROUP',
      action: 'UPDATE',
      ad_group_resource_name: 'customers/123/adGroups/1',
      status: 'PAUSED',
    });
    expect(result.success).toBe(true);
  });

  it('returns error for AD_GROUP UPDATE without ad_group_resource_name', async () => {
    const result = await service.handleCallGoogleAdsApi('user-123', {
      customer_id: '1234567890',
      entity_type: 'AD_GROUP',
      action: 'UPDATE',
      status: 'PAUSED',
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/ad_group_resource_name/i);
  });

  it('handles KEYWORD ADD action', async () => {
    const result = await service.handleCallGoogleAdsApi('user-123', {
      customer_id: '1234567890',
      entity_type: 'KEYWORD',
      action: 'ADD',
      ad_group_resource_name: 'customers/123/adGroups/1',
      keywords: [{ text: 'buy shoes', matchType: 'BROAD' }],
    });
    expect(result.success).toBe(true);
  });

  it('returns error for KEYWORD ADD without ad_group_resource_name', async () => {
    const result = await service.handleCallGoogleAdsApi('user-123', {
      customer_id: '1234567890',
      entity_type: 'KEYWORD',
      action: 'ADD',
      keywords: [{ text: 'buy shoes', matchType: 'BROAD' }],
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/ad_group_resource_name/i);
  });

  it('handles KEYWORD ADD_NEGATIVE action with campaign_resource_name', async () => {
    const result = await service.handleCallGoogleAdsApi('user-123', {
      customer_id: '1234567890',
      entity_type: 'KEYWORD',
      action: 'ADD_NEGATIVE',
      campaign_resource_name: 'customers/123/campaigns/1',
      keywords: [{ text: 'free', matchType: 'BROAD' }],
    });
    expect(result.success).toBe(true);
  });

  it('handles AD LIST action', async () => {
    const result = await service.handleCallGoogleAdsApi('user-123', {
      customer_id: '1234567890',
      entity_type: 'AD',
      action: 'LIST',
      ad_group_resource_name: 'customers/123/adGroups/1',
    });
    expect(result.success).toBe(true);
    expect(result.ads).toBeDefined();
  });

  it('returns error for AD LIST without ad_group_resource_name', async () => {
    const result = await service.handleCallGoogleAdsApi('user-123', {
      customer_id: '1234567890',
      entity_type: 'AD',
      action: 'LIST',
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/ad_group_resource_name/i);
  });

  it('handles AD CREATE action', async () => {
    const result = await service.handleCallGoogleAdsApi('user-123', {
      customer_id: '1234567890',
      entity_type: 'AD',
      action: 'CREATE',
      ad_group_resource_name: 'customers/123/adGroups/1',
      type: 'RESPONSIVE_SEARCH_AD',
      headlines: ['Headline 1', 'Headline 2', 'Headline 3'],
      descriptions: ['Description 1', 'Description 2'],
      final_url: 'https://example.com',
    });
    expect(result.success).toBe(true);
    expect(result.adResourceName).toBeDefined();
  });

  it('returns error for AD CREATE without ad_group_resource_name', async () => {
    const result = await service.handleCallGoogleAdsApi('user-123', {
      customer_id: '1234567890',
      entity_type: 'AD',
      action: 'CREATE',
      type: 'RESPONSIVE_SEARCH_AD',
      headlines: ['H1'],
      descriptions: ['D1'],
      final_url: 'https://example.com',
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/ad_group_resource_name/i);
  });

  it('handles ASSET UPLOAD action', async () => {
    const result = await service.handleCallGoogleAdsApi('user-123', {
      customer_id: '1234567890',
      entity_type: 'ASSET',
      action: 'UPLOAD',
      asset_type: 'IMAGE',
      name: 'hero.jpg',
      data: 'base64encodeddata',
    });
    expect(result.success).toBe(true);
    expect(result.assetResourceName).toBeDefined();
  });

  it('handles ASSET_GROUP CREATE action', async () => {
    const result = await service.handleCallGoogleAdsApi('user-123', {
      customer_id: '1234567890',
      entity_type: 'ASSET_GROUP',
      action: 'CREATE',
      name: 'My Asset Group',
      campaign_resource_name: 'customers/123/campaigns/1',
      headlines: ['H1', 'H2', 'H3'],
      long_headlines: ['Long H1'],
      descriptions: ['D1', 'D2'],
      square_image_assets: ['customers/123/assets/1'],
      landscape_image_assets: ['customers/123/assets/2'],
      logo_assets: ['customers/123/assets/3'],
      final_url: 'https://example.com',
    });
    expect(result.success).toBe(true);
    expect(result.assetGroupResourceName).toBeDefined();
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
