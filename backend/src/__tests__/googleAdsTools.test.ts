jest.mock('../services/googleAdsService', () => ({
  googleAdsService: {
    listCampaigns: jest.fn().mockResolvedValue([
      { id: '1', name: 'Test', status: 'ENABLED', type: 'SEARCH', resourceName: 'customers/123/campaigns/1' },
    ]),
    listBudgets: jest.fn().mockResolvedValue([{ resourceName: 'customers/123/campaignBudgets/1', name: 'Test Budget', amountMicros: '10000000', explicitlyShared: false, referenceCount: 1 }]),
    listBiddingStrategies: jest.fn().mockResolvedValue([{ resourceName: 'customers/123/biddingStrategies/555', id: '555', name: 'Portfolio tCPA', type: 'TARGET_CPA', status: 'ENABLED' }]),
    createBudget: jest.fn().mockResolvedValue({ resourceName: 'customers/123/campaignBudgets/1' }),
    createCampaign: jest.fn().mockResolvedValue({ resourceName: 'customers/123/campaigns/1' }),
    pauseCampaign: jest.fn().mockResolvedValue(undefined),
    resumeCampaign: jest.fn().mockResolvedValue(undefined),
    updateCampaign: jest.fn().mockResolvedValue(true),
    // ENG-335 launch gate: default to no serving URLs and a PAUSED parent so the
    // gate (and the ad/asset-group creative-addition gate) are no-ops here — these
    // tests cover the underlying create paths, not the launch gate itself.
    getCampaignFinalUrls: jest.fn().mockResolvedValue([]),
    getCampaignStatus: jest.fn().mockResolvedValue('PAUSED'),
    getAdGroupCampaign: jest.fn().mockResolvedValue({ campaignResourceName: 'customers/123/campaigns/1', campaignStatus: 'PAUSED' }),
    addKeywords: jest.fn().mockResolvedValue(undefined),
    addNegativeKeywords: jest.fn().mockResolvedValue(undefined),
    searchLocations: jest.fn().mockResolvedValue([
      { id: '2840', name: 'United States', countryCode: 'US', targetType: 'Country' },
    ]),
    listAdGroups: jest.fn().mockResolvedValue([]),
    createAdGroup: jest.fn().mockResolvedValue({ resourceName: 'customers/123/adGroups/1' }),
    updateAdGroup: jest.fn().mockResolvedValue(true),
    listKeywords: jest.fn().mockResolvedValue([
      { resourceName: 'customers/123/adGroupCriteria/789~1', text: 'running shoes', matchType: 'BROAD', status: 'ENABLED', negative: false },
    ]),
    updateKeyword: jest.fn().mockResolvedValue(true),
    removeKeyword: jest.fn().mockResolvedValue(undefined),
    listAds: jest.fn().mockResolvedValue([
      { id: '1', adGroup: 'customers/123/adGroups/1', type: 'RESPONSIVE_SEARCH_AD', status: 'PAUSED' },
    ]),
    updateAd: jest.fn().mockResolvedValue(true),
    removeAd: jest.fn().mockResolvedValue(undefined),
    createAd: jest.fn().mockResolvedValue({ resourceName: 'customers/123/adGroupAds/1' }),
    uploadAsset: jest.fn().mockResolvedValue('customers/123/assets/1'),
    attachCampaignAssets: jest.fn().mockResolvedValue(undefined),
    createAssetGroup: jest.fn().mockResolvedValue({ resourceName: 'customers/123/assetGroups/1' }),
    retagAdUtm: jest.fn().mockResolvedValue({ success: true }),
    retagAssetGroupUtm: jest.fn().mockResolvedValue({ success: true }),
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
import { googleAdsService } from '../services/googleAdsService';

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

  it('handles BUDGET LIST action via listBudgets service method', async () => {
    const result = await service.handleCallGoogleAdsApi('user-123', {
      customer_id: '1234567890',
      entity_type: 'BUDGET',
      action: 'LIST',
    });
    expect(result.success).toBe(true);
    expect(result.budgets).toHaveLength(1);
    expect(result.budgets[0].resourceName).toBe('customers/123/campaignBudgets/1');
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

  it('forwards final_url_suffix on CAMPAIGN UPDATE', async () => {
    const result = await service.handleCallGoogleAdsApi('user-123', {
      customer_id: '1234567890',
      entity_type: 'CAMPAIGN',
      action: 'UPDATE',
      campaign_resource_name: 'customers/123/campaigns/1',
      final_url_suffix: 'utm_source=google&utm_medium=cpc',
    });
    expect(result.success).toBe(true);
    expect(googleAdsService.updateCampaign).toHaveBeenCalledWith(
      'user-123',
      '1234567890',
      'customers/123/campaigns/1',
      expect.objectContaining({ finalUrlSuffix: 'utm_source=google&utm_medium=cpc' })
    );
  });

  it('handles BIDDING_STRATEGY LIST via listBiddingStrategies service method', async () => {
    const result = await service.handleCallGoogleAdsApi('user-123', {
      customer_id: '1234567890',
      entity_type: 'BIDDING_STRATEGY',
      action: 'LIST',
    });
    expect(result.success).toBe(true);
    expect(result.biddingStrategies).toHaveLength(1);
    expect(result.biddingStrategies[0].resourceName).toBe('customers/123/biddingStrategies/555');
  });

  it('forwards bidding_strategy_resource_name (portfolio) on CAMPAIGN CREATE', async () => {
    const result = await service.handleCallGoogleAdsApi('user-123', {
      customer_id: '1234567890',
      entity_type: 'CAMPAIGN',
      action: 'CREATE',
      name: 'Portfolio Campaign',
      type: 'SEARCH',
      budget_resource_name: 'customers/123/campaignBudgets/1',
      bidding_strategy_resource_name: 'customers/123/biddingStrategies/555',
    });
    expect(result.success).toBe(true);
    expect(googleAdsService.createCampaign).toHaveBeenCalledWith(
      'user-123',
      '1234567890',
      expect.objectContaining({ biddingStrategyResourceName: 'customers/123/biddingStrategies/555' }),
    );
  });

  it('rejects CAMPAIGN CREATE with both bidding_strategy and bidding_strategy_resource_name', async () => {
    const result = await service.handleCallGoogleAdsApi('user-123', {
      customer_id: '1234567890',
      entity_type: 'CAMPAIGN',
      action: 'CREATE',
      name: 'Conflicting Campaign',
      type: 'SEARCH',
      budget_resource_name: 'customers/123/campaignBudgets/1',
      bidding_strategy: 'MANUAL_CPC',
      bidding_strategy_resource_name: 'customers/123/biddingStrategies/555',
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not both/i);
    expect(googleAdsService.createCampaign).not.toHaveBeenCalled();
  });

  it('forwards bidding_strategy_resource_name (portfolio) on CAMPAIGN UPDATE', async () => {
    const result = await service.handleCallGoogleAdsApi('user-123', {
      customer_id: '1234567890',
      entity_type: 'CAMPAIGN',
      action: 'UPDATE',
      campaign_resource_name: 'customers/123/campaigns/1',
      bidding_strategy_resource_name: 'customers/123/biddingStrategies/555',
    });
    expect(result.success).toBe(true);
    expect(googleAdsService.updateCampaign).toHaveBeenCalledWith(
      'user-123',
      '1234567890',
      'customers/123/campaigns/1',
      expect.objectContaining({ biddingStrategyResourceName: 'customers/123/biddingStrategies/555' }),
    );
  });

  it('returns an honest failure for CAMPAIGN UPDATE when no recognized fields were updated', async () => {
    (googleAdsService.updateCampaign as jest.Mock).mockResolvedValueOnce(false);
    const result = await service.handleCallGoogleAdsApi('user-123', {
      customer_id: '1234567890',
      entity_type: 'CAMPAIGN',
      action: 'UPDATE',
      campaign_resource_name: 'customers/123/campaigns/1',
      some_unsupported_field: 'value',
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/does not support/i);
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

  it('returns an honest failure for AD_GROUP UPDATE when no recognized fields were updated', async () => {
    (googleAdsService.updateAdGroup as jest.Mock).mockResolvedValueOnce(false);
    const result = await service.handleCallGoogleAdsApi('user-123', {
      customer_id: '1234567890',
      entity_type: 'AD_GROUP',
      action: 'UPDATE',
      ad_group_resource_name: 'customers/123/adGroups/1',
      some_unsupported_field: 'value',
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/does not support/i);
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

  it('handles AD RETAG_UTM action', async () => {
    const result = await service.handleCallGoogleAdsApi('user-123', {
      customer_id: '1234567890',
      entity_type: 'AD',
      action: 'RETAG_UTM',
      ad_resource_name: 'customers/1234567890/adGroupAds/1~1',
    });
    expect(result.success).toBe(true);
    expect(googleAdsService.retagAdUtm).toHaveBeenCalledWith('user-123', '1234567890', 'customers/1234567890/adGroupAds/1~1');
  });

  it('AD RETAG_UTM requires ad_resource_name', async () => {
    const result = await service.handleCallGoogleAdsApi('user-123', {
      customer_id: '1234567890',
      entity_type: 'AD',
      action: 'RETAG_UTM',
    });
    expect(result.success).toBe(false);
  });

  it('AD RETAG_UTM surfaces a no_destination_url reason distinctly', async () => {
    (googleAdsService.retagAdUtm as jest.Mock).mockResolvedValueOnce({ success: false, reason: 'no_destination_url' });
    const result = await service.handleCallGoogleAdsApi('user-123', {
      customer_id: '1234567890',
      entity_type: 'AD',
      action: 'RETAG_UTM',
      ad_resource_name: 'customers/1234567890/adGroupAds/1~1',
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('no destination URL');
  });

  it('handles ASSET_GROUP RETAG_UTM action', async () => {
    const result = await service.handleCallGoogleAdsApi('user-123', {
      customer_id: '1234567890',
      entity_type: 'ASSET_GROUP',
      action: 'RETAG_UTM',
      asset_group_resource_name: 'customers/1234567890/assetGroups/1',
    });
    expect(result.success).toBe(true);
    expect(googleAdsService.retagAssetGroupUtm).toHaveBeenCalledWith('user-123', '1234567890', 'customers/1234567890/assetGroups/1');
  });

  it('ASSET_GROUP RETAG_UTM requires asset_group_resource_name', async () => {
    const result = await service.handleCallGoogleAdsApi('user-123', {
      customer_id: '1234567890',
      entity_type: 'ASSET_GROUP',
      action: 'RETAG_UTM',
    });
    expect(result.success).toBe(false);
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

describe('handleCallGoogleAdsApi — KEYWORD actions', () => {
  it('handles KEYWORD LIST action', async () => {
    const result = await service.handleCallGoogleAdsApi('user-123', {
      customer_id: '1234567890',
      entity_type: 'KEYWORD',
      action: 'LIST',
      ad_group_resource_name: 'customers/123/adGroups/789',
    });
    expect(result.success).toBe(true);
    expect(result.keywords).toBeDefined();
    expect(result.keywords).toHaveLength(1);
  });

  it('returns error for KEYWORD LIST without ad_group_resource_name', async () => {
    const result = await service.handleCallGoogleAdsApi('user-123', {
      customer_id: '1234567890',
      entity_type: 'KEYWORD',
      action: 'LIST',
    });
    expect(result.success).toBe(false);
  });

  it('handles KEYWORD UPDATE action', async () => {
    const result = await service.handleCallGoogleAdsApi('user-123', {
      customer_id: '1234567890',
      entity_type: 'KEYWORD',
      action: 'UPDATE',
      criterion_resource_name: 'customers/123/adGroupCriteria/789~1',
      status: 'PAUSED',
    });
    expect(result.success).toBe(true);
  });

  it('returns an honest failure for KEYWORD UPDATE when no recognized fields were updated', async () => {
    (googleAdsService.updateKeyword as jest.Mock).mockResolvedValueOnce(false);
    const result = await service.handleCallGoogleAdsApi('user-123', {
      customer_id: '1234567890',
      entity_type: 'KEYWORD',
      action: 'UPDATE',
      criterion_resource_name: 'customers/123/adGroupCriteria/789~1',
      some_unsupported_field: 'value',
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/does not support/i);
  });

  it('returns error for KEYWORD UPDATE without criterion_resource_name', async () => {
    const result = await service.handleCallGoogleAdsApi('user-123', {
      customer_id: '1234567890',
      entity_type: 'KEYWORD',
      action: 'UPDATE',
      status: 'PAUSED',
    });
    expect(result.success).toBe(false);
  });

  it('handles KEYWORD REMOVE action', async () => {
    const result = await service.handleCallGoogleAdsApi('user-123', {
      customer_id: '1234567890',
      entity_type: 'KEYWORD',
      action: 'REMOVE',
      criterion_resource_name: 'customers/123/adGroupCriteria/789~1',
    });
    expect(result.success).toBe(true);
  });

  it('returns error for KEYWORD REMOVE without criterion_resource_name', async () => {
    const result = await service.handleCallGoogleAdsApi('user-123', {
      customer_id: '1234567890',
      entity_type: 'KEYWORD',
      action: 'REMOVE',
    });
    expect(result.success).toBe(false);
  });
});

describe('handleCallGoogleAdsApi — AD UPDATE/REMOVE actions', () => {
  it('handles AD UPDATE action', async () => {
    const result = await service.handleCallGoogleAdsApi('user-123', {
      customer_id: '1234567890',
      entity_type: 'AD',
      action: 'UPDATE',
      ad_resource_name: 'customers/123/adGroupAds/1',
      status: 'PAUSED',
    });
    expect(result.success).toBe(true);
  });

  it('returns error for AD UPDATE without ad_resource_name', async () => {
    const result = await service.handleCallGoogleAdsApi('user-123', {
      customer_id: '1234567890',
      entity_type: 'AD',
      action: 'UPDATE',
      status: 'PAUSED',
    });
    expect(result.success).toBe(false);
  });

  it('returns an honest failure for AD UPDATE when no recognized fields were updated', async () => {
    (googleAdsService.updateAd as jest.Mock).mockResolvedValueOnce(false);
    const result = await service.handleCallGoogleAdsApi('user-123', {
      customer_id: '1234567890',
      entity_type: 'AD',
      action: 'UPDATE',
      ad_resource_name: 'customers/123/adGroupAds/1',
      some_unsupported_field: 'value',
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/does not support/i);
  });

  it('handles AD REMOVE action', async () => {
    const result = await service.handleCallGoogleAdsApi('user-123', {
      customer_id: '1234567890',
      entity_type: 'AD',
      action: 'REMOVE',
      ad_resource_name: 'customers/123/adGroupAds/1',
    });
    expect(result.success).toBe(true);
  });

  it('returns error for AD REMOVE without ad_resource_name', async () => {
    const result = await service.handleCallGoogleAdsApi('user-123', {
      customer_id: '1234567890',
      entity_type: 'AD',
      action: 'REMOVE',
    });
    expect(result.success).toBe(false);
  });
});

describe('handleCallGoogleAdsApi — CAMPAIGN_ASSET ATTACH', () => {
  it('handles CAMPAIGN_ASSET ATTACH action', async () => {
    const result = await service.handleCallGoogleAdsApi('user-123', {
      customer_id: '1234567890',
      entity_type: 'CAMPAIGN_ASSET',
      action: 'ATTACH',
      campaign_resource_name: 'customers/123/campaigns/1',
      assets: [{ fieldType: 'BUSINESS_NAME', text: 'My Brand' }],
    });
    expect(result.success).toBe(true);
  });

  it('returns error for CAMPAIGN_ASSET ATTACH without campaign_resource_name', async () => {
    const result = await service.handleCallGoogleAdsApi('user-123', {
      customer_id: '1234567890',
      entity_type: 'CAMPAIGN_ASSET',
      action: 'ATTACH',
      assets: [{ fieldType: 'BUSINESS_NAME', text: 'My Brand' }],
    });
    expect(result.success).toBe(false);
  });

  it('returns error for CAMPAIGN_ASSET ATTACH without assets', async () => {
    const result = await service.handleCallGoogleAdsApi('user-123', {
      customer_id: '1234567890',
      entity_type: 'CAMPAIGN_ASSET',
      action: 'ATTACH',
      campaign_resource_name: 'customers/123/campaigns/1',
    });
    expect(result.success).toBe(false);
  });
});

describe('handleCallGoogleAdsApi — error handling', () => {
  it('short-circuits auth errors with authError flag', async () => {
    (googleAdsService.listCampaigns as jest.Mock).mockRejectedValueOnce(
      Object.assign(new Error('Google Ads account not found'), { isGoogleAdsAuthError: true })
    );
    const result = await service.handleCallGoogleAdsApi('user-123', {
      customer_id: '1234567890',
      entity_type: 'CAMPAIGN',
      action: 'LIST',
    });
    expect(result).toEqual({ success: false, error: 'Google Ads account not found', authError: true });
  });

  it('formats Google Ads API error details as "CODE: message"', async () => {
    (googleAdsService.listCampaigns as jest.Mock).mockRejectedValueOnce({
      response: { data: { error: { details: [{ errors: [
        { errorCode: { queryError: 'BAD_FIELD' }, message: 'Unrecognized field.' },
        { errorCode: { queryError: 'BAD_VALUE' }, message: 'Bad value.' },
      ] }] } } },
    });
    const result = await service.handleCallGoogleAdsApi('user-123', {
      customer_id: '1234567890',
      entity_type: 'CAMPAIGN',
      action: 'LIST',
    });
    expect(result.success).toBe(false);
    expect(result.error).toBe('BAD_FIELD: Unrecognized field.; BAD_VALUE: Bad value.');
  });

  it('falls back to error.message for non-Google-Ads errors', async () => {
    (googleAdsService.listCampaigns as jest.Mock).mockRejectedValueOnce(new Error('socket hang up'));
    const result = await service.handleCallGoogleAdsApi('user-123', {
      customer_id: '1234567890',
      entity_type: 'CAMPAIGN',
      action: 'LIST',
    });
    expect(result).toEqual({ success: false, error: 'socket hang up' });
  });

  it('falls back to "Unknown error" when no message is present', async () => {
    (googleAdsService.listCampaigns as jest.Mock).mockRejectedValueOnce({});
    const result = await service.handleCallGoogleAdsApi('user-123', {
      customer_id: '1234567890',
      entity_type: 'CAMPAIGN',
      action: 'LIST',
    });
    expect(result).toEqual({ success: false, error: 'Unknown error' });
  });

  it('returns a structured error for an unsupported entity_type/action', async () => {
    const result = await service.handleCallGoogleAdsApi('user-123', {
      customer_id: '1234567890',
      entity_type: 'AD',
      action: 'FROBNICATE',
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Unsupported entity_type/);
  });
});

describe('handleCallGoogleAdsReportingApi — error handling', () => {
  it('short-circuits auth errors with authError flag', async () => {
    (googleAdsService.getQuickMetrics as jest.Mock).mockRejectedValueOnce(
      Object.assign(new Error('Reconnect Google Ads in Settings.'), { isGoogleAdsAuthError: true })
    );
    const result = await service.handleCallGoogleAdsReportingApi('user-123', {
      customer_id: '1234567890',
      mode: 'dashboard',
    });
    expect(result).toEqual({ success: false, error: 'Reconnect Google Ads in Settings.', authError: true });
  });

  it('formats Google Ads API error details from the reporting path', async () => {
    (googleAdsService.queryReporting as jest.Mock).mockRejectedValueOnce({
      response: { data: { error: { details: [{ errors: [{ message: 'Invalid GAQL.' }] }] } } },
    });
    const result = await service.handleCallGoogleAdsReportingApi('user-123', {
      customer_id: '1234567890',
      mode: 'raw',
      query: 'SELECT bogus FROM nowhere',
    });
    expect(result.success).toBe(false);
    expect(result.error).toBe('Invalid GAQL.');
  });

  it('rejects an invalid mode', async () => {
    const result = await service.handleCallGoogleAdsReportingApi('user-123', {
      customer_id: '1234567890',
      mode: 'sideways' as any,
    });
    expect(result.success).toBe(false);
    expect(result.error).toBe('mode must be "raw" or "dashboard"');
  });
});
