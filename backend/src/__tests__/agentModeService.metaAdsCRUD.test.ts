// Mock MCP client service first
jest.mock('../mcp/client/mcpClientService', () => ({
  McpClientService: jest.fn().mockImplementation(() => ({
    isReady: jest.fn().mockReturnValue(true)
  }))
}));

// Mock the dependencies
jest.mock('../services/metaService', () => ({
  metaService: {
    listAdSets: jest.fn(),
    createAdSet: jest.fn(),
    updateAdSet: jest.fn(),
    deleteAdSet: jest.fn(),
    getCampaign: jest.fn(),
    updateCampaign: jest.fn(),
    deleteCampaign: jest.fn(),
    listAdCreatives: jest.fn(),
    createAdCreative: jest.fn(),
    listAds: jest.fn(),
    createAd: jest.fn(),
    getAd: jest.fn(),
    getAdCreative: jest.fn(),
    updateAd: jest.fn(),
    deleteAd: jest.fn()
  }
}));

jest.mock('../services/db', () => ({
  userDb: {
    getUserById: jest.fn()
  }
}));

jest.mock('../utils/secretsManager', () => ({
  getMetaAccessToken: jest.fn().mockResolvedValue('mock-access-token')
}));

import { AgentModeService } from '../services/agentModeService';
import { metaService } from '../services/metaService';
import { userDb } from '../services/db';

describe('AgentModeService - Meta Ads Complete CRUD', () => {
  let agentModeService: AgentModeService;

  beforeEach(() => {
    agentModeService = new AgentModeService();
    jest.clearAllMocks();
  });

  const mockUser = {
    id: 'user123',
    connected_accounts: [
      {
        platform: 'meta',
        account_id: '123456789',
        account_name: 'Test Business',
        config: {
          account_type: 'ad_account',
          access_token: 'mock-access-token',
          ad_account_id: '123456789'
        }
      }
    ]
  };

  // ==================== AD SET OPERATIONS ====================
  describe('Ad Set Operations', () => {
    describe('listMetaAdsAdSets', () => {
      it('should successfully list ad sets', async () => {
        const mockAdSets = [
          { id: 'adset_1', name: 'Ad Set 1', campaign_id: 'camp_123' },
          { id: 'adset_2', name: 'Ad Set 2', campaign_id: 'camp_123' }
        ];

        (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
        (metaService.listAdSets as jest.Mock).mockResolvedValue(mockAdSets);

        const result = await agentModeService.listMetaAdsAdSets('user123');

        expect(result.success).toBe(true);
        expect(result.message).toBe('Found 2 ad set(s)');
        expect(result.adSets).toEqual(mockAdSets);
        expect(result.totalCount).toBe(2);
      });

      it('should filter by campaign_id when provided', async () => {
        const mockAdSets = [{ id: 'adset_1', name: 'Ad Set 1' }];

        (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
        (metaService.listAdSets as jest.Mock).mockResolvedValue(mockAdSets);

        await agentModeService.listMetaAdsAdSets('user123', 'camp_123');

        expect(metaService.listAdSets).toHaveBeenCalledWith('123456789', 'mock-access-token', 'camp_123');
      });
    });

    describe('createMetaAdsAdSet', () => {
      it('should successfully create an ad set', async () => {
        const mockAdSetData = { id: 'adset_123', name: 'New Ad Set' };
        const params = {
          name: 'New Ad Set',
          campaign_id: 'camp_123',
          billing_event: 'IMPRESSIONS',
          optimization_goal: 'REACH',
          targeting: { geo_locations: { countries: ['US'] } },
          daily_budget: 1000,
          bid_strategy: 'LOWEST_COST_WITH_BID_CAP',
          bid_amount: 2.00
        };

        (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
        (metaService.getCampaign as jest.Mock).mockResolvedValue({ id: 'camp_123', objective: 'OUTCOME_AWARENESS' });
        (metaService.createAdSet as jest.Mock).mockResolvedValue(mockAdSetData);

        const result = await agentModeService.createMetaAdsAdSet('user123', params);

        expect(result.success).toBe(true);
        expect(result.message).toBe('Ad set "New Ad Set" created successfully');
        expect(result.adSet).toEqual(mockAdSetData);
      });
    });

    describe('updateMetaAdsAdSet', () => {
      it('should successfully update an ad set', async () => {
        const params = { status: 'PAUSED' };

        (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
        (metaService.updateAdSet as jest.Mock).mockResolvedValue({ success: true });

        const result = await agentModeService.updateMetaAdsAdSet('user123', 'adset_123', params);

        expect(result.success).toBe(true);
        expect(result.message).toBe('Ad set updated successfully');
      });

      it('should convert daily_budget from dollars to cents before calling metaService', async () => {
        const params = { daily_budget: 150 };

        (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
        (metaService.updateAdSet as jest.Mock).mockResolvedValue({ success: true });

        await agentModeService.updateMetaAdsAdSet('user123', 'adset_123', params);

        expect(metaService.updateAdSet).toHaveBeenCalledWith(
          'mock-access-token',
          'adset_123',
          expect.objectContaining({ daily_budget: 15000 })
        );
      });

      it('should convert lifetime_budget from dollars to cents before calling metaService', async () => {
        const params = { lifetime_budget: 500 };

        (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
        (metaService.updateAdSet as jest.Mock).mockResolvedValue({ success: true });

        await agentModeService.updateMetaAdsAdSet('user123', 'adset_123', params);

        expect(metaService.updateAdSet).toHaveBeenCalledWith(
          'mock-access-token',
          'adset_123',
          expect.objectContaining({ lifetime_budget: 50000 })
        );
      });

      it('should convert bid_amount from dollars to cents before calling metaService', async () => {
        const params = { bid_amount: 2.5 };

        (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
        (metaService.updateAdSet as jest.Mock).mockResolvedValue({ success: true });

        await agentModeService.updateMetaAdsAdSet('user123', 'adset_123', params);

        expect(metaService.updateAdSet).toHaveBeenCalledWith(
          'mock-access-token',
          'adset_123',
          expect.objectContaining({ bid_amount: 250 })
        );
      });

      it('should not modify params without budget fields', async () => {
        const params = { name: 'Renamed Ad Set', status: 'ACTIVE' };

        (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
        (metaService.updateAdSet as jest.Mock).mockResolvedValue({ success: true });

        await agentModeService.updateMetaAdsAdSet('user123', 'adset_123', params);

        expect(metaService.updateAdSet).toHaveBeenCalledWith(
          'mock-access-token',
          'adset_123',
          expect.objectContaining({ name: 'Renamed Ad Set', status: 'ACTIVE' })
        );
      });
    });

    describe('deleteMetaAdsAdSet', () => {
      it('should successfully delete an ad set', async () => {
        (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
        (metaService.deleteAdSet as jest.Mock).mockResolvedValue({ success: true });

        const result = await agentModeService.deleteMetaAdsAdSet('user123', 'adset_123');

        expect(result.success).toBe(true);
        expect(result.message).toBe('Ad set deleted successfully');
      });
    });
  });

  // ==================== AD CREATIVE OPERATIONS ====================
  describe('Ad Creative Operations', () => {
    describe('listMetaAdsAdCreatives', () => {
      it('should successfully list ad creatives', async () => {
        const mockCreatives = [
          { id: 'creative_1', name: 'Creative 1' },
          { id: 'creative_2', name: 'Creative 2' }
        ];

        (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
        (metaService.listAdCreatives as jest.Mock).mockResolvedValue(mockCreatives);

        const result = await agentModeService.listMetaAdsAdCreatives('user123');

        expect(result.success).toBe(true);
        expect(result.message).toBe('Found 2 ad creative(s)');
        expect(result.creatives).toEqual(mockCreatives);
        expect(result.totalCount).toBe(2);
      });

      it('should handle empty results', async () => {
        (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
        (metaService.listAdCreatives as jest.Mock).mockResolvedValue([]);

        const result = await agentModeService.listMetaAdsAdCreatives('user123');

        expect(result.success).toBe(true);
        expect(result.totalCount).toBe(0);
      });
    });

    describe('createMetaAdsAdCreative', () => {
      it('should successfully create an ad creative', async () => {
        const mockCreativeData = { id: 'creative_123', name: 'New Creative' };
        const params = {
          name: 'New Creative',
          page_id: 'page_123',
          image_url: 'https://example.com/image.jpg',
          body: 'Ad Body',
          title: 'Ad Title',
          link_url: 'https://example.com',
          call_to_action_type: 'LEARN_MORE'
        };

        (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
        (metaService.createAdCreative as jest.Mock).mockResolvedValue(mockCreativeData);

        const result = await agentModeService.createMetaAdsAdCreative('user123', params);

        expect(result.success).toBe(true);
        expect(result.message).toBe('Ad creative "New Creative" created successfully');
        expect(result.creative).toEqual(mockCreativeData);
      });
    });
  });

  // ==================== AD OPERATIONS ====================
  describe('Ad Operations', () => {
    describe('listMetaAdsAds', () => {
      it('should successfully list ads', async () => {
        const mockAds = [
          { id: 'ad_1', name: 'Ad 1', adset_id: 'adset_123' },
          { id: 'ad_2', name: 'Ad 2', adset_id: 'adset_123' }
        ];

        (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
        (metaService.listAds as jest.Mock).mockResolvedValue(mockAds);

        const result = await agentModeService.listMetaAdsAds('user123');

        expect(result.success).toBe(true);
        expect(result.message).toBe('Found 2 ad(s)');
        expect(result.ads).toEqual(mockAds);
        expect(result.totalCount).toBe(2);
      });

      it('should filter by adSetId when provided', async () => {
        const mockAds = [{ id: 'ad_1', name: 'Ad 1' }];

        (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
        (metaService.listAds as jest.Mock).mockResolvedValue(mockAds);

        await agentModeService.listMetaAdsAds('user123', 'adset_123');

        expect(metaService.listAds).toHaveBeenCalledWith('123456789', 'mock-access-token', 'adset_123');
      });
    });

    describe('createMetaAdsAd', () => {
      it('should successfully create an ad', async () => {
        const mockAdData = { id: 'ad_123', name: 'New Ad' };
        const params = {
          name: 'New Ad',
          adset_id: 'adset_123',
          creative_id: 'creative_123',
          status: 'PAUSED'
        };

        (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
        (metaService.createAd as jest.Mock).mockResolvedValue(mockAdData);

        const result = await agentModeService.createMetaAdsAd('user123', params);

        expect(result.success).toBe(true);
        expect(result.message).toBe('Ad "New Ad" created successfully');
        expect(result.ad).toEqual(mockAdData);
      });
    });

    describe('updateMetaAdsAd', () => {
      it('should do a standard update for ad-level params (status, name)', async () => {
        const params = { status: 'ACTIVE' };

        (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
        (metaService.updateAd as jest.Mock).mockResolvedValue({ success: true });

        const result = await agentModeService.updateMetaAdsAd('user123', 'ad_123', params);

        expect(result.success).toBe(true);
        expect(result.message).toBe('Ad updated successfully');
        expect(metaService.updateAd).toHaveBeenCalledWith('mock-access-token', 'ad_123', params);
        // Should NOT call getAd or getAdCreative for ad-level updates
        expect(metaService.getAd).not.toHaveBeenCalled();
        expect(metaService.getAdCreative).not.toHaveBeenCalled();
      });

      it('should use creative swap when link_url is in params', async () => {
        const params = { link_url: 'https://new-landing-page.com' };

        (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
        (metaService.getAd as jest.Mock).mockResolvedValue({
          id: 'ad_123',
          creative: { creative_id: 'old_creative_123' }
        });
        (metaService.getAdCreative as jest.Mock).mockResolvedValue({
          id: 'old_creative_123',
          name: 'My Creative',
          body: 'Check this out!',
          title: 'Great Product',
          object_story_spec: {
            page_id: 'page_123',
            link_data: {
              message: 'Check this out!',
              link: 'https://old-page.com',
              name: 'Great Product',
              image_hash: 'abc123',
              call_to_action: { type: 'LEARN_MORE', value: { link: 'https://old-page.com' } }
            }
          }
        });
        (metaService.createAdCreative as jest.Mock).mockResolvedValue({ id: 'new_creative_456' });
        (metaService.updateAd as jest.Mock).mockResolvedValue({ success: true });

        const result = await agentModeService.updateMetaAdsAd('user123', 'ad_123', params);

        expect(result.success).toBe(true);
        expect(result.old_creative_id).toBe('old_creative_123');
        expect(result.new_creative_id).toBe('new_creative_456');
        // Should create a new creative with updated link_url
        expect(metaService.createAdCreative).toHaveBeenCalledWith(
          '123456789',
          'mock-access-token',
          expect.objectContaining({
            page_id: 'page_123',
            link_url: 'https://new-landing-page.com',
            body: 'Check this out!',
            image_hash: 'abc123'
          })
        );
        // Should update ad with new creative_id
        expect(metaService.updateAd).toHaveBeenCalledWith(
          'mock-access-token',
          'ad_123',
          { creative: { creative_id: 'new_creative_456' } }
        );
      });

      it('should use creative swap when destination param is used', async () => {
        const params = { destination: 'https://new-landing-page.com' };

        (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
        (metaService.getAd as jest.Mock).mockResolvedValue({
          id: 'ad_123',
          creative: { creative_id: 'old_creative_123' }
        });
        (metaService.getAdCreative as jest.Mock).mockResolvedValue({
          id: 'old_creative_123',
          name: 'My Creative',
          object_story_spec: {
            page_id: 'page_123',
            link_data: {
              message: 'Hello',
              link: 'https://old-page.com',
              name: 'Title',
              image_hash: 'abc123'
            }
          }
        });
        (metaService.createAdCreative as jest.Mock).mockResolvedValue({ id: 'new_creative_789' });
        (metaService.updateAd as jest.Mock).mockResolvedValue({ success: true });

        const result = await agentModeService.updateMetaAdsAd('user123', 'ad_123', params);

        expect(result.success).toBe(true);
        expect(metaService.createAdCreative).toHaveBeenCalledWith(
          '123456789',
          'mock-access-token',
          expect.objectContaining({
            link_url: 'https://new-landing-page.com'
          })
        );
      });

      it('should handle video creative swap with link_url update', async () => {
        const params = { link_url: 'https://new-video-landing.com' };

        (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
        (metaService.getAd as jest.Mock).mockResolvedValue({
          id: 'ad_123',
          creative: { creative_id: 'video_creative_123' }
        });
        (metaService.getAdCreative as jest.Mock).mockResolvedValue({
          id: 'video_creative_123',
          name: 'Video Creative',
          object_story_spec: {
            page_id: 'page_123',
            video_data: {
              video_id: 'vid_456',
              image_hash: 'thumb_abc',
              message: 'Watch this!',
              title: 'Video Title',
              call_to_action: { type: 'SHOP_NOW', value: { link: 'https://old-video-page.com' } }
            }
          }
        });
        (metaService.createAdCreative as jest.Mock).mockResolvedValue({ id: 'new_video_creative_789' });
        (metaService.updateAd as jest.Mock).mockResolvedValue({ success: true });

        const result = await agentModeService.updateMetaAdsAd('user123', 'ad_123', params);

        expect(result.success).toBe(true);
        expect(metaService.createAdCreative).toHaveBeenCalledWith(
          '123456789',
          'mock-access-token',
          expect.objectContaining({
            page_id: 'page_123',
            video_id: 'vid_456',
            image_hash: 'thumb_abc',
            link_url: 'https://new-video-landing.com',
            call_to_action_type: 'SHOP_NOW'
          })
        );
      });

      it('should return error when ad has no creative', async () => {
        const params = { link_url: 'https://new-page.com' };

        (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
        (metaService.getAd as jest.Mock).mockResolvedValue({ id: 'ad_123' });

        const result = await agentModeService.updateMetaAdsAd('user123', 'ad_123', params);

        expect(result.success).toBe(false);
        expect(result.error).toBe('MISSING_CREATIVE');
      });

      it('should return error when creative has no object_story_spec', async () => {
        const params = { link_url: 'https://new-page.com' };

        (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
        (metaService.getAd as jest.Mock).mockResolvedValue({
          id: 'ad_123',
          creative: { creative_id: 'creative_123' }
        });
        (metaService.getAdCreative as jest.Mock).mockResolvedValue({
          id: 'creative_123',
          name: 'My Creative'
        });

        const result = await agentModeService.updateMetaAdsAd('user123', 'ad_123', params);

        expect(result.success).toBe(false);
        expect(result.error).toBe('MISSING_OBJECT_STORY_SPEC');
      });

      it('should return error when new creative creation fails', async () => {
        const params = { link_url: 'https://new-page.com' };

        (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
        (metaService.getAd as jest.Mock).mockResolvedValue({
          id: 'ad_123',
          creative: { creative_id: 'creative_123' }
        });
        (metaService.getAdCreative as jest.Mock).mockResolvedValue({
          id: 'creative_123',
          name: 'My Creative',
          object_story_spec: {
            page_id: 'page_123',
            link_data: { message: 'Hello', link: 'https://old.com', name: 'Title', image_hash: 'abc' }
          }
        });
        (metaService.createAdCreative as jest.Mock).mockResolvedValue({});

        const result = await agentModeService.updateMetaAdsAd('user123', 'ad_123', params);

        expect(result.success).toBe(false);
        expect(result.error).toBe('CREATIVE_CREATE_FAILED');
      });
    });

    describe('deleteMetaAdsAd', () => {
      it('should successfully delete an ad', async () => {
        (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
        (metaService.deleteAd as jest.Mock).mockResolvedValue({ success: true });

        const result = await agentModeService.deleteMetaAdsAd('user123', 'ad_123');

        expect(result.success).toBe(true);
        expect(result.message).toBe('Ad deleted successfully');
      });

      it('should handle errors', async () => {
        (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
        (metaService.deleteAd as jest.Mock).mockRejectedValue(new Error('Ad not found'));

        const result = await agentModeService.deleteMetaAdsAd('user123', 'ad_123');

        expect(result.success).toBe(false);
        expect(result.message).toBe('Ad not found');
      });
    });
  });

  // ==================== CAMPAIGN UPDATE BUDGET CONVERSION ====================
  describe('Campaign Update Budget Conversion', () => {
    describe('updateMetaAdsCampaign', () => {
      it('should convert budget_amount from dollars to cents when updating a campaign', async () => {
        (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
        (metaService.updateCampaign as jest.Mock).mockResolvedValue({ success: true });

        await agentModeService.updateMetaAdsCampaign('user123', 'camp_123', { budget_amount: 150 });

        expect(metaService.updateCampaign).toHaveBeenCalledWith(
          'mock-access-token',
          'camp_123',
          expect.objectContaining({ daily_budget: 15000 })
        );
        const call = (metaService.updateCampaign as jest.Mock).mock.calls[0][2];
        expect(call.budget_amount).toBeUndefined();
      });

      it('should not modify params without budget_amount', async () => {
        (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
        (metaService.updateCampaign as jest.Mock).mockResolvedValue({ success: true });

        await agentModeService.updateMetaAdsCampaign('user123', 'camp_123', { name: 'New Name', status: 'PAUSED' });

        expect(metaService.updateCampaign).toHaveBeenCalledWith(
          'mock-access-token',
          'camp_123',
          expect.objectContaining({ name: 'New Name', status: 'PAUSED' })
        );
      });

      it('should return success after updating campaign', async () => {
        (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
        (metaService.updateCampaign as jest.Mock).mockResolvedValue({ success: true });

        const result = await agentModeService.updateMetaAdsCampaign('user123', 'camp_123', { status: 'PAUSED' });

        expect(result.success).toBe(true);
        expect(result.message).toBe('Campaign updated successfully');
      });

      it('should handle errors gracefully', async () => {
        (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
        (metaService.updateCampaign as jest.Mock).mockRejectedValue(new Error('Campaign not found'));

        const result = await agentModeService.updateMetaAdsCampaign('user123', 'camp_123', { status: 'PAUSED' });

        expect(result.success).toBe(false);
        expect(result.message).toBe('Campaign not found');
      });
    });
  });
});
