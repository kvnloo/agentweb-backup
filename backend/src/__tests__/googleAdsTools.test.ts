jest.mock('../services/googleAdsService', () => ({
  googleAdsService: {
    listCampaigns: jest.fn().mockResolvedValue([
      { id: '1', name: 'Test', status: 'ENABLED', type: 'SEARCH', resourceName: 'customers/123/campaigns/1' },
    ]),
    listBudgets: jest.fn().mockResolvedValue([{ resourceName: 'customers/123/campaignBudgets/1', name: 'Test Budget', amountMicros: '10000000', explicitlyShared: false, referenceCount: 1 }]),
    listBiddingStrategies: jest.fn().mockResolvedValue([{ resourceName: 'customers/123/biddingStrategies/555', id: '555', name: 'Portfolio tCPA', type: 'TARGET_CPA', status: 'ENABLED' }]),
    createBudget: jest.fn().mockResolvedValue({ resourceName: 'customers/123/campaignBudgets/1' }),
    updateBudget: jest.fn().mockResolvedValue(undefined),
    createCampaign: jest.fn().mockResolvedValue({ resourceName: 'customers/123/campaigns/1' }),
    pauseCampaign: jest.fn().mockResolvedValue(undefined),
    resumeCampaign: jest.fn().mockResolvedValue(undefined),
    updateCampaign: jest.fn().mockResolvedValue(true),
    addProximityCriterion: jest.fn().mockResolvedValue({ resourceName: 'customers/123/campaignCriteria/1~1' }),
    removeCampaignCriterion: jest.fn().mockResolvedValue(undefined),
    // ENG-335 launch gate: default to no serving URLs and a PAUSED parent so the
    // gate (and the ad/asset-group creative-addition gate) are no-ops here — these
    // tests cover the underlying create paths, not the launch gate itself.
    getCampaignFinalUrls: jest.fn().mockResolvedValue([]),
    getCampaignStatus: jest.fn().mockResolvedValue('PAUSED'),
    getAdGroupCampaign: jest.fn().mockResolvedValue({ campaignResourceName: 'customers/123/campaigns/1', campaignStatus: 'PAUSED' }),
    addKeywords: jest.fn().mockResolvedValue(undefined),
    addNegativeKeywords: jest.fn().mockResolvedValue(undefined),
    addNegativeCampaignCriteria: jest.fn().mockResolvedValue(undefined),
    setDeviceBidAdjustments: jest.fn().mockResolvedValue(undefined),
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
    getServingChainStatus: jest.fn(),
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
import { toolResultError } from '../utils/toolResultError';
import { classifyToolErrorClass } from '../utils/toolErrorClassifier';
import { classifyToolFailureType } from '../utils/toolFailureType';
import { emmaToolRegistry } from '../emma/registry';
import '../emma/tools';

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

  it('handles BUDGET UPDATE action', async () => {
    const result = await service.handleCallGoogleAdsApi('user-123', {
      customer_id: '1234567890',
      entity_type: 'BUDGET',
      action: 'UPDATE',
      budget_resource_name: 'customers/123/campaignBudgets/1',
      amount_micros: 20_000_000,
    });
    expect(result.success).toBe(true);
    expect(googleAdsService.updateBudget).toHaveBeenCalledWith('user-123', '1234567890', 'customers/123/campaignBudgets/1', 20_000_000);
  });

  it('returns error for BUDGET UPDATE without budget_resource_name', async () => {
    const result = await service.handleCallGoogleAdsApi('user-123', {
      customer_id: '1234567890',
      entity_type: 'BUDGET',
      action: 'UPDATE',
      amount_micros: 20_000_000,
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/budget_resource_name/i);
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

  it('forwards false campaign network settings instead of dropping them', async () => {
    const result = await service.handleCallGoogleAdsApi('user-123', {
      customer_id: '1234567890',
      entity_type: 'CAMPAIGN',
      action: 'UPDATE',
      campaign_resource_name: 'customers/123/campaigns/1',
      target_google_search: true,
      target_search_network: false,
      target_content_network: false,
      target_partner_search_network: false,
    });
    expect(result.success).toBe(true);
    expect(googleAdsService.updateCampaign).toHaveBeenCalledWith(
      'user-123',
      '1234567890',
      'customers/123/campaigns/1',
      expect.objectContaining({
        targetGoogleSearch: true,
        targetSearchNetwork: false,
        targetContentNetwork: false,
        targetPartnerSearchNetwork: false,
      }),
    );
  });

  it('handles CAMPAIGN ADD_PROXIMITY action (ENG-487)', async () => {
    const result = await service.handleCallGoogleAdsApi('user-123', {
      customer_id: '1234567890',
      entity_type: 'CAMPAIGN',
      action: 'ADD_PROXIMITY',
      campaign_resource_name: 'customers/123/campaigns/1',
      radius: 25,
      radius_units: 'MILES',
      address: { street_address: '123 Main St', city_name: 'Tacoma', province_code: 'WA', country_code: 'US' },
    });
    expect(result.success).toBe(true);
    expect(result.criterionResourceName).toBe('customers/123/campaignCriteria/1~1');
    expect(googleAdsService.addProximityCriterion).toHaveBeenCalledWith(
      'user-123',
      '1234567890',
      'customers/123/campaigns/1',
      expect.objectContaining({
        radius: 25,
        radiusUnits: 'MILES',
        address: expect.objectContaining({ streetAddress: '123 Main St', cityName: 'Tacoma', provinceCode: 'WA', countryCode: 'US' }),
      })
    );
  });

  it('returns error for ADD_PROXIMITY without required fields', async () => {
    const result = await service.handleCallGoogleAdsApi('user-123', {
      customer_id: '1234567890',
      entity_type: 'CAMPAIGN',
      action: 'ADD_PROXIMITY',
      campaign_resource_name: 'customers/123/campaigns/1',
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/radius|address/i);
  });

  it('passes lat/long center through for ADD_PROXIMITY without address (ENG-486)', async () => {
    const result = await service.handleCallGoogleAdsApi('user-123', {
      customer_id: '1234567890', entity_type: 'CAMPAIGN', action: 'ADD_PROXIMITY',
      campaign_resource_name: 'customers/123/campaigns/1', radius: 30, latitude: 47.6588, longitude: -117.426,
    });
    expect(result.success).toBe(true);
    expect(googleAdsService.addProximityCriterion).toHaveBeenCalledWith('user-123', '1234567890', 'customers/123/campaigns/1',
      expect.objectContaining({ radius: 30, geoPoint: { latitude: 47.6588, longitude: -117.426 } }));
  });

  it('rejects ADD_PROXIMITY with only one coordinate (ENG-486)', async () => {
    const result = await service.handleCallGoogleAdsApi('user-123', {
      customer_id: '1234567890', entity_type: 'CAMPAIGN', action: 'ADD_PROXIMITY',
      campaign_resource_name: 'customers/123/campaigns/1', radius: 30, latitude: 47.6,
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/latitude and longitude/);
    expect(googleAdsService.addProximityCriterion).not.toHaveBeenCalled();
  });

  it('handles CAMPAIGN REMOVE_PROXIMITY action (ENG-487)', async () => {
    const result = await service.handleCallGoogleAdsApi('user-123', {
      customer_id: '1234567890',
      entity_type: 'CAMPAIGN',
      action: 'REMOVE_PROXIMITY',
      criterion_resource_name: 'customers/123/campaignCriteria/1~1',
    });
    expect(result.success).toBe(true);
    expect(googleAdsService.removeCampaignCriterion).toHaveBeenCalledWith('user-123', '1234567890', 'customers/123/campaignCriteria/1~1', ['PROXIMITY']);
  });

  it('returns error for REMOVE_PROXIMITY without criterion_resource_name', async () => {
    const result = await service.handleCallGoogleAdsApi('user-123', {
      customer_id: '1234567890',
      entity_type: 'CAMPAIGN',
      action: 'REMOVE_PROXIMITY',
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/criterion_resource_name/i);
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
  it('preserves blocked serving-chain evidence at the tool-error boundary', async () => {
    const report = {
      state: 'BLOCKED_BY_AD',
      checkedAt: '2026-09-17T02:00:00.000Z',
      blockers: [{ state: 'BLOCKED_BY_AD', entityId: '3' }],
    };
    (googleAdsService.getServingChainStatus as jest.Mock).mockResolvedValueOnce(report);

    const result = await service.handleCallGoogleAdsReportingApi('user-123', {
      customer_id: '1234567890',
      mode: 'serving_chain',
    });

    expect(result).toEqual({ success: false, report, error: JSON.stringify(report) });
    expect(toolResultError(result)?.message).toBe(JSON.stringify(report));
  });

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

describe('handleCallGoogleAdsApi — CAMPAIGN_CRITERION ADD', () => {
  it('adds negative placement URLs at campaign scope', async () => {
    const result = await service.handleCallGoogleAdsApi('user-123', {
      customer_id: '1234567890',
      entity_type: 'CAMPAIGN_CRITERION',
      action: 'ADD',
      campaign_resource_name: 'customers/1234567890/campaigns/24056663695',
      placement_urls: ['coeurdazur.com', 'https://viraltemy.com/games'],
    });

    expect(result).toEqual({
      success: true,
      message: 'Added 2 negative campaign criteria',
    });
    expect(googleAdsService.addNegativeCampaignCriteria).toHaveBeenCalledWith(
      'user-123',
      '1234567890',
      'customers/1234567890/campaigns/24056663695',
      {
        placementUrls: ['coeurdazur.com', 'https://viraltemy.com/games'],
        mobileAppCategoryResourceNames: [],
      },
    );
  });

  it('adds negative mobile-app-category constants at campaign scope', async () => {
    const result = await service.handleCallGoogleAdsApi('user-123', {
      customer_id: '1234567890',
      entity_type: 'CAMPAIGN_CRITERION',
      action: 'ADD',
      campaign_resource_name: 'customers/1234567890/campaigns/24056663695',
      mobile_app_category_resource_names: [
        'mobileAppCategoryConstants/60000',
        'mobileAppCategoryConstants/60001',
      ],
    });

    expect(result.success).toBe(true);
    expect(googleAdsService.addNegativeCampaignCriteria).toHaveBeenCalledWith(
      'user-123',
      '1234567890',
      'customers/1234567890/campaigns/24056663695',
      {
        placementUrls: [],
        mobileAppCategoryResourceNames: [
          'mobileAppCategoryConstants/60000',
          'mobileAppCategoryConstants/60001',
        ],
      },
    );
  });

  it('rejects missing campaign/customer identifiers before any mutation', async () => {
    const result = await service.handleCallGoogleAdsApi('user-123', {
      customer_id: '',
      entity_type: 'CAMPAIGN_CRITERION',
      action: 'ADD',
      placement_urls: ['coeurdazur.com'],
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/customer_id.*campaign_resource_name/i);
    expect(googleAdsService.addNegativeCampaignCriteria).not.toHaveBeenCalled();
  });

  it('returns a typed validation error for a malformed campaign resource without mutating', async () => {
    const result = await service.handleCallGoogleAdsApi('user-123', {
      customer_id: '1234567890',
      entity_type: 'CAMPAIGN_CRITERION',
      action: 'ADD',
      campaign_resource_name: 'campaigns/not-canonical',
      placement_urls: ['coeurdazur.com'],
    });

    expect(result).toMatchObject({
      success: false,
      errorType: 'VALIDATION_ERROR',
      errorCode: 'INVALID_CAMPAIGN_RESOURCE_NAME',
    });
    expect(googleAdsService.addNegativeCampaignCriteria).not.toHaveBeenCalled();
  });

  it('returns a typed validation error when the campaign belongs to another customer', async () => {
    const result = await service.handleCallGoogleAdsApi('user-123', {
      customer_id: '1234567890',
      entity_type: 'CAMPAIGN_CRITERION',
      action: 'ADD',
      campaign_resource_name: 'customers/9999999999/campaigns/24056663695',
      placement_urls: ['coeurdazur.com'],
    });

    expect(result).toMatchObject({
      success: false,
      errorType: 'VALIDATION_ERROR',
      errorCode: 'CAMPAIGN_CUSTOMER_MISMATCH',
    });
    expect(googleAdsService.addNegativeCampaignCriteria).not.toHaveBeenCalled();
  });

  it('returns a typed criterion error for YouTube URLs without mutating', async () => {
    const result = await service.handleCallGoogleAdsApi('user-123', {
      customer_id: '1234567890',
      entity_type: 'CAMPAIGN_CRITERION',
      action: 'ADD',
      campaign_resource_name: 'customers/1234567890/campaigns/24056663695',
      placement_urls: ['https://www.youtube.com/watch?v=abc123'],
    });

    expect(result).toMatchObject({
      success: false,
      errorType: 'VALIDATION_ERROR',
      errorCode: 'UNSUPPORTED_PLACEMENT_CRITERION_TYPE',
      error: expect.stringMatching(/dedicated YouTube video or channel criterion/i),
    });
    expect(googleAdsService.addNegativeCampaignCriteria).not.toHaveBeenCalled();
  });

  it('returns the typed Google Ads permission error from the single atomic mutation', async () => {
    (googleAdsService.addNegativeCampaignCriteria as jest.Mock).mockRejectedValueOnce({
      response: {
        data: {
          error: {
            details: [{
              errors: [{
                errorCode: { authorizationError: 'USER_PERMISSION_DENIED' },
                message: 'User does not have permission to access customer.',
              }],
            }],
          },
        },
      },
    });

    const result = await service.handleCallGoogleAdsApi('user-123', {
      customer_id: '1234567890',
      entity_type: 'CAMPAIGN_CRITERION',
      action: 'ADD',
      campaign_resource_name: 'customers/1234567890/campaigns/24056663695',
      placement_urls: ['coeurdazur.com'],
    });

    expect(result).toMatchObject({
      success: false,
      errorType: 'GOOGLE_ADS_API_ERROR',
      errorCode: 'USER_PERMISSION_DENIED',
      error: expect.stringMatching(/USER_PERMISSION_DENIED.*permission/i),
    });
    expect(googleAdsService.addNegativeCampaignCriteria).toHaveBeenCalledTimes(1);
  });

  it('preserves the existing negative-keyword path', async () => {
    const result = await service.handleCallGoogleAdsApi('user-123', {
      customer_id: '1234567890',
      entity_type: 'KEYWORD',
      action: 'ADD_NEGATIVE',
      campaign_resource_name: 'customers/1234567890/campaigns/24056663695',
      keywords: [{ text: 'free', matchType: 'BROAD' }],
    });

    expect(result.success).toBe(true);
    expect(googleAdsService.addNegativeKeywords).toHaveBeenCalled();
    expect(googleAdsService.addNegativeCampaignCriteria).not.toHaveBeenCalled();
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

  // ENG-487 — adversarial inputs, confirmed against the live Google Ads API (v24):
  // an ungeocodable address and an invalid radius (0/negative/huge) all come back
  // as INVALID_PROXIMITY_ADDRESS / INVALID_PROXIMITY_RADIUS criterionErrors, which
  // the existing "CODE: message" formatter above already renders cleanly — no new
  // formatting code needed, just locking the behavior in with a mock.
  it('formats an ungeocodable-address error from ADD_PROXIMITY as "CODE: message"', async () => {
    (googleAdsService.addProximityCriterion as jest.Mock).mockRejectedValueOnce({
      response: { data: { error: { details: [{ errors: [
        { errorCode: { criterionError: 'INVALID_PROXIMITY_ADDRESS' }, message: 'The Proximity address cannot be geocoded to a valid lat/long.' },
      ] }] } } },
    });
    const result = await service.handleCallGoogleAdsApi('user-123', {
      customer_id: '1234567890',
      entity_type: 'CAMPAIGN',
      action: 'ADD_PROXIMITY',
      campaign_resource_name: 'customers/123/campaigns/1',
      radius: 10,
      address: { street_address: 'near the mall lol' },
    });
    expect(result).toEqual({ success: false, error: 'INVALID_PROXIMITY_ADDRESS: The Proximity address cannot be geocoded to a valid lat/long.' });
  });

  it('formats an invalid-radius error from ADD_PROXIMITY as "CODE: message"', async () => {
    (googleAdsService.addProximityCriterion as jest.Mock).mockRejectedValueOnce({
      response: { data: { error: { details: [{ errors: [
        { errorCode: { criterionError: 'INVALID_PROXIMITY_RADIUS' }, message: 'Distance for the radius for the proximity criterion is invalid.' },
      ] }] } } },
    });
    const result = await service.handleCallGoogleAdsApi('user-123', {
      customer_id: '1234567890',
      entity_type: 'CAMPAIGN',
      action: 'ADD_PROXIMITY',
      campaign_resource_name: 'customers/123/campaigns/1',
      radius: 0,
      address: { city_name: 'Austin', country_code: 'US' },
    });
    expect(result).toEqual({ success: false, error: 'INVALID_PROXIMITY_RADIUS: Distance for the radius for the proximity criterion is invalid.' });
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

  // ENG-1300: the "CODE: message" formatter above renders Google Ads' own
  // business error codes (e.g. "BAD_FIELD") into the message text — that is
  // NOT an HTTP status and classifyToolErrorClass would misclassify if it were
  // used for `code`. The real HTTP status is error.response.status, and
  // googleAdsService.callApi rethrows the SAME axios error unchanged, so it's
  // still there for the taking.
  it('ENG-1300: a 403 (error.response.status) classifies as auth/config end-to-end, distinct from the Google Ads business error code in the message', async () => {
    (googleAdsService.listCampaigns as jest.Mock).mockRejectedValueOnce({
      response: {
        status: 403,
        data: { error: { details: [{ errors: [
          { errorCode: { authorizationError: 'USER_PERMISSION_DENIED' }, message: 'User does not have permission to access customer.' },
        ] }] } },
      },
    });
    const result = await service.handleCallGoogleAdsApi('user-123', {
      customer_id: '1234567890',
      entity_type: 'CAMPAIGN',
      action: 'LIST',
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('USER_PERMISSION_DENIED');
    const classified = toolResultError(result);
    expect(classifyToolErrorClass(classified)).toBe('auth');
    expect(classifyToolFailureType(classifyToolErrorClass(classified))).toBe('config');
  });

  it('ENG-1300: a 429 (error.response.status) classifies as rate_limit, not conflated with a Google Ads QUOTA_ERROR business code', async () => {
    (googleAdsService.listCampaigns as jest.Mock).mockRejectedValueOnce({
      response: {
        status: 429,
        data: { error: { details: [{ errors: [
          { errorCode: { quotaError: 'RESOURCE_EXHAUSTED' }, message: 'Too many requests.' },
        ] }] } },
      },
    });
    const result = await service.handleCallGoogleAdsApi('user-123', {
      customer_id: '1234567890',
      entity_type: 'CAMPAIGN',
      action: 'LIST',
    });
    const classified = toolResultError(result);
    expect(classifyToolErrorClass(classified)).toBe('rate_limit');
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
    expect(result.error).toBe('mode must be "raw", "dashboard", or "serving_chain"');
  });

  it('ENG-1300: a 403 (error.response.status) classifies as auth/config end-to-end', async () => {
    (googleAdsService.getQuickMetrics as jest.Mock).mockRejectedValueOnce({
      response: { status: 403, data: { error: { details: [{ errors: [{ message: 'Permission denied.' }] }] } } },
    });
    const result = await service.handleCallGoogleAdsReportingApi('user-123', {
      customer_id: '1234567890',
      mode: 'dashboard',
    });
    const classified = toolResultError(result);
    expect(classifyToolErrorClass(classified)).toBe('auth');
    expect(classifyToolFailureType(classifyToolErrorClass(classified))).toBe('config');
  });
});

// ENG-1514. A PAUSED create must round-trip as PAUSED.
//
// ENG-1293 fixed googleAdsService.createAdGroup/createAd to ACCEPT a status and
// apply `status: params.status ?? 'ENABLED'`. That fix is real, and it is also
// unreachable: these two dispatcher call sites never passed `status` through, so
// params.status was always undefined, the ENABLED default fired, and an explicit
// PAUSED request was discarded silently behind `success: true`.
//
// Caught live on 2026-08-24 (account 2883029950, ENG-1157 closing E2E): ad group
// 201029416233 and ad 821954276361 were both submitted PAUSED and both stored
// ENABLED. Nothing served only because the parent campaign was PAUSED — the
// hierarchy contained it, not the API.
//
// These assert on the ARGS HANDED TO THE SERVICE, not on the mock's return value:
// the whole failure mode is a success response that describes a request the
// backend did not make.
describe('handleCallGoogleAdsApi — a PAUSED create must not come back ENABLED (ENG-1514)', () => {
  it('forwards status PAUSED to createAdGroup instead of dropping it', async () => {
    const result = await service.handleCallGoogleAdsApi('user-123', {
      customer_id: '1234567890',
      entity_type: 'AD_GROUP',
      action: 'CREATE',
      name: 'Staged Ad Group',
      campaign_resource_name: 'customers/123/campaigns/1',
      type: 'SEARCH_STANDARD',
      status: 'PAUSED',
    });
    expect(result.success).toBe(true);
    expect(googleAdsService.createAdGroup).toHaveBeenCalledWith(
      'user-123',
      '1234567890',
      expect.objectContaining({ status: 'PAUSED' }),
    );
  });

  it('forwards status PAUSED to createAd instead of dropping it', async () => {
    const result = await service.handleCallGoogleAdsApi('user-123', {
      customer_id: '1234567890',
      entity_type: 'AD',
      action: 'CREATE',
      ad_group_resource_name: 'customers/123/adGroups/1',
      type: 'SEARCH',
      headlines: ['H1', 'H2', 'H3'],
      descriptions: ['D1', 'D2'],
      final_url: 'https://example.com',
      status: 'PAUSED',
    });
    expect(result.success).toBe(true);
    expect(googleAdsService.createAd).toHaveBeenCalledWith(
      'user-123',
      '1234567890',
      expect.objectContaining({ status: 'PAUSED' }),
    );
  });

  // Management RULE 11 (safe defaults) and the CAMPAIGN CREATE path already in
  // this dispatcher both say a create with no stated status is PAUSED, not live.
  it('defaults an unstated status to PAUSED, matching CAMPAIGN CREATE', async () => {
    await service.handleCallGoogleAdsApi('user-123', {
      customer_id: '1234567890',
      entity_type: 'AD_GROUP',
      action: 'CREATE',
      name: 'Unstated Ad Group',
      campaign_resource_name: 'customers/123/campaigns/1',
      type: 'SEARCH_STANDARD',
    });
    expect(googleAdsService.createAdGroup).toHaveBeenCalledWith(
      'user-123',
      '1234567890',
      expect.objectContaining({ status: 'PAUSED' }),
    );
  });

  it('still honours an explicit ENABLED create', async () => {
    await service.handleCallGoogleAdsApi('user-123', {
      customer_id: '1234567890',
      entity_type: 'AD_GROUP',
      action: 'CREATE',
      name: 'Live Ad Group',
      campaign_resource_name: 'customers/123/campaigns/1',
      type: 'SEARCH_STANDARD',
      status: 'ENABLED',
    });
    expect(googleAdsService.createAdGroup).toHaveBeenCalledWith(
      'user-123',
      '1234567890',
      expect.objectContaining({ status: 'ENABLED' }),
    );
  });
});

// ENG-1668. Production session 87334a61-2e06-4018-960e-9e7759403423 showed
// gemini-3.7-flash calling KEYWORD UPDATE, KEYWORD ADD_NEGATIVE, and BUDGET
// UPDATE without the resource-name argument each one requires, even though
// the top-of-tool ACTION MATRIX names it. The per-field `description` for
// budget_resource_name, campaign_resource_name, and criterion_resource_name
// — the text a model leans on when scanning an individual parameter — did
// not mention these three action combos at all, only ones it does NOT gate
// (CAMPAIGN CREATE, ADD_PROXIMITY/AD_GROUP LIST, KEYWORD REMOVE). Assert the
// field descriptions name every write action that actually requires them, so
// a future edit to the ACTION MATRIX can't drift out of sync with the
// per-field docs again.
describe('call_google_ads_api tool schema — per-field description coverage (ENG-1668)', () => {
  const properties = emmaToolRegistry.getTool('call_google_ads_api')!.definition.inputSchema.properties as Record<string, { description?: string }>;

  it('documents budget_resource_name as required for BUDGET UPDATE', () => {
    expect(properties.budget_resource_name.description).toMatch(/BUDGET UPDATE/);
  });

  it('documents campaign_resource_name as usable for KEYWORD ADD_NEGATIVE', () => {
    expect(properties.campaign_resource_name.description).toMatch(/ADD_NEGATIVE/);
  });

  it('documents criterion_resource_name as required for KEYWORD UPDATE', () => {
    expect(properties.criterion_resource_name.description).toMatch(/KEYWORD UPDATE/);
  });
});

// ENG-1922: the registered Emma tool must preserve verifier evidence, including
// refusal to certify incomplete data, rather than falling back to raw metrics.
describe('Search serving-chain Emma dispatch', () => {
  it.each(['BLOCKED_BY_AD', 'READY', 'DELIVERING', 'UNVERIFIED'])('preserves %s without inventing a live/spending claim', async state => {
    const report = { state, campaigns: [{ campaignId: '1', state, adGroups: [{ adGroupId: '2', state }] }] };
    (googleAdsService.getServingChainStatus as jest.Mock).mockResolvedValue(report);
    const tool = emmaToolRegistry.getTool('call_google_ads_reporting_api')!;
    const result = await tool.execute({ customer_id: '123', mode: 'serving_chain', campaign_ids: ['1'] }, { userId: 'user-123' });
    expect(googleAdsService.getServingChainStatus).toHaveBeenCalledWith('user-123', '123', ['1']);
    expect(googleAdsService.queryReporting).not.toHaveBeenCalled();
    expect(googleAdsService.getQuickMetrics).not.toHaveBeenCalled();
    const success = state === 'READY' || state === 'DELIVERING';
    expect(result).toEqual({ success, report, ...(success ? {} : { error: JSON.stringify(report) }) });
    expect(toolResultError(result)?.message).toBe(success ? undefined : JSON.stringify(report));
    expect(tool.definition.inputSchema.properties!.mode.enum).toContain('serving_chain');
    expect(tool.definition.description).toContain('READY is not evidence of delivery');
  });
});

describe('handleCallGoogleAdsApi — CAMPAIGN_CRITERION SET_DEVICE_BID_ADJUSTMENT (ENG-2036)', () => {
  const base = { customer_id: '1234567890', entity_type: 'CAMPAIGN_CRITERION' as const, action: 'SET_DEVICE_BID_ADJUSTMENT' };

  it('excludes mobile and tablet at campaign level (-100% => modifier 0)', async () => {
    const result = await service.handleCallGoogleAdsApi('user-123', {
      ...base,
      campaign_resource_name: 'customers/1234567890/campaigns/555',
      device_bid_adjustments: [
        { device: 'MOBILE', bid_modifier_percent: -100 },
        { device: 'tablet', bid_modifier_percent: -100 },
      ],
    } as any);
    expect(result).toMatchObject({ success: true, scope: 'CAMPAIGN' });
    expect(googleAdsService.setDeviceBidAdjustments).toHaveBeenCalledWith('user-123', {
      scope: 'CAMPAIGN',
      customerId: '1234567890',
      campaignId: '555',
      adjustments: [
        { device: 'MOBILE', bidModifier: 0 },
        { device: 'TABLET', bidModifier: 0 },
      ],
    });
  });

  it('supports ad-group scope', async () => {
    const result = await service.handleCallGoogleAdsApi('user-123', {
      ...base,
      ad_group_resource_name: 'customers/1234567890/adGroups/77',
      device_bid_adjustments: [{ device: 'DESKTOP', bid_modifier_percent: 25 }],
    } as any);
    expect(result.success).toBe(true);
    expect(googleAdsService.setDeviceBidAdjustments).toHaveBeenCalledWith('user-123', {
      scope: 'AD_GROUP',
      customerId: '1234567890',
      adGroupResourceName: 'customers/1234567890/adGroups/77',
      adjustments: [{ device: 'DESKTOP', bidModifier: 1.25 }],
    });
  });

  it.each([
    ['out-of-range percent', { campaign_resource_name: 'customers/1234567890/campaigns/555', device_bid_adjustments: [{ device: 'MOBILE', bid_modifier_percent: -101 }] }, 'INVALID_BID_MODIFIER'],
    ['above max percent', { campaign_resource_name: 'customers/1234567890/campaigns/555', device_bid_adjustments: [{ device: 'MOBILE', bid_modifier_percent: 901 }] }, 'INVALID_BID_MODIFIER'],
    ['near-exclusion percent that rounds to opt-out', { campaign_resource_name: 'customers/1234567890/campaigns/555', device_bid_adjustments: [{ device: 'MOBILE', bid_modifier_percent: -99.999 }] }, 'INVALID_BID_MODIFIER'],
    ['unknown device', { campaign_resource_name: 'customers/1234567890/campaigns/555', device_bid_adjustments: [{ device: 'WATCH', bid_modifier_percent: 0 }] }, 'INVALID_DEVICE'],
    ['duplicate device', { campaign_resource_name: 'customers/1234567890/campaigns/555', device_bid_adjustments: [{ device: 'MOBILE', bid_modifier_percent: 0 }, { device: 'MOBILE', bid_modifier_percent: 10 }] }, 'INVALID_DEVICE'],
    ['empty adjustments', { campaign_resource_name: 'customers/1234567890/campaigns/555', device_bid_adjustments: [] }, 'MISSING_CRITERIA'],
    ['both scopes', { campaign_resource_name: 'customers/1234567890/campaigns/555', ad_group_resource_name: 'customers/1234567890/adGroups/77', device_bid_adjustments: [{ device: 'MOBILE', bid_modifier_percent: 0 }] }, 'MISSING_IDENTIFIERS'],
    ['foreign campaign', { campaign_resource_name: 'customers/9999999999/campaigns/555', device_bid_adjustments: [{ device: 'MOBILE', bid_modifier_percent: 0 }] }, 'CAMPAIGN_CUSTOMER_MISMATCH'],
    ['malformed ad group', { ad_group_resource_name: 'adGroups/77', device_bid_adjustments: [{ device: 'MOBILE', bid_modifier_percent: 0 }] }, 'INVALID_AD_GROUP_RESOURCE_NAME'],
  ])('rejects %s with a typed validation error and no mutation', async (_label, extra, code) => {
    const result = await service.handleCallGoogleAdsApi('user-123', { ...base, ...extra } as any);
    expect(result).toMatchObject({ success: false, errorType: 'VALIDATION_ERROR', errorCode: code });
    expect(googleAdsService.setDeviceBidAdjustments).not.toHaveBeenCalled();
  });
});
