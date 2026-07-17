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
    deleteAd: jest.fn(),
    getPageInstagramActor: jest.fn()
  },
  // Static helper used by the agent layer to decide whether IG actor resolution is needed.
  // extractCreativeDestinationUrls is the real (pure) implementation, same reasoning as
  // computeRetagUrlTags below — it's already unit-tested elsewhere, and stubbing it here
  // would defeat the point of testing retagMetaAdUtm's actual link-extraction coverage.
  MetaService: {
    placementTokenTargetsInstagram: (token: string) =>
      ['feed', 'story', 'stories', 'reels', 'instagram_feed', 'instagram_story', 'instagram_reels', 'explore'].includes(String(token).toLowerCase()),
    extractCreativeDestinationUrls: jest.requireActual('../services/metaService').MetaService.extractCreativeDestinationUrls,
  },
  // Real (pure) implementation — already unit-tested in metaService.utmTags.test.ts.
  // Using the real thing here tests retagMetaAdUtm's actual decision logic, not a stub.
  computeRetagUrlTags: jest.requireActual('../services/metaService').computeRetagUrlTags,
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

      it('should pass placement_assets through with hashes untouched', async () => {
        const params = {
          name: 'Placement Creative',
          page_id: 'page_123',
          body: 'Ad Body',
          title: 'Ad Title',
          link_url: 'https://example.com',
          placement_assets: [
            { image_hash: 'square_hash', is_default: true },
            { image_hash: 'vertical_hash', placements: ['story', 'reels'] }
          ]
        };

        (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
        const uploadSpy = jest.spyOn(agentModeService, 'uploadMetaAdsImage');
        (metaService.createAdCreative as jest.Mock).mockResolvedValue({ id: 'creative_pc', name: 'Placement Creative' });

        const result = await agentModeService.createMetaAdsAdCreative('user123', params);

        expect(result.success).toBe(true);
        // No upload needed when hashes are already supplied
        expect(uploadSpy).not.toHaveBeenCalled();
        expect(metaService.createAdCreative).toHaveBeenCalledWith(
          '123456789',
          'mock-access-token',
          expect.objectContaining({
            placement_assets: [
              { image_hash: 'square_hash', is_default: true },
              { image_hash: 'vertical_hash', placements: ['story', 'reels'] }
            ]
          })
        );
      });

      it('auto-resolves instagram_user_id from the page when placement_assets target Instagram', async () => {
        const params = {
          name: 'Placement Creative',
          page_id: 'page_123',
          body: 'Ad Body',
          title: 'Ad Title',
          link_url: 'https://example.com',
          placement_assets: [
            { image_hash: 'square_hash', is_default: true },
            { image_hash: 'vertical_hash', placements: ['story', 'reels'] }
          ]
        };

        (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
        (metaService.getPageInstagramActor as jest.Mock).mockResolvedValue('17841469032554858');
        (metaService.createAdCreative as jest.Mock).mockResolvedValue({ id: 'creative_pc' });

        const result = await agentModeService.createMetaAdsAdCreative('user123', params);

        expect(result.success).toBe(true);
        expect(metaService.getPageInstagramActor).toHaveBeenCalledWith('mock-access-token', 'page_123');
        // The resolved IG actor is passed to the builder so the creative can serve IG placements
        expect(metaService.createAdCreative).toHaveBeenCalledWith(
          '123456789',
          'mock-access-token',
          expect.objectContaining({ instagram_user_id: '17841469032554858' })
        );
      });

      it('does NOT resolve instagram_user_id when placements are Facebook-only', async () => {
        const params = {
          name: 'Placement Creative',
          page_id: 'page_123',
          body: 'Ad Body',
          title: 'Ad Title',
          link_url: 'https://example.com',
          placement_assets: [
            { image_hash: 'square_hash', is_default: true },
            { image_hash: 'vertical_hash', placements: ['facebook_reels'] }
          ]
        };

        (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
        (metaService.createAdCreative as jest.Mock).mockResolvedValue({ id: 'creative_pc' });

        const result = await agentModeService.createMetaAdsAdCreative('user123', params);

        expect(result.success).toBe(true);
        expect(metaService.getPageInstagramActor).not.toHaveBeenCalled();
      });

      it('respects an explicitly-supplied instagram_user_id (no auto-resolution)', async () => {
        const params = {
          name: 'Placement Creative',
          page_id: 'page_123',
          instagram_user_id: 'explicit_ig',
          body: 'Ad Body',
          title: 'Ad Title',
          link_url: 'https://example.com',
          placement_assets: [
            { image_hash: 'square_hash', is_default: true },
            { image_hash: 'vertical_hash', placements: ['reels'] }
          ]
        };

        (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
        (metaService.createAdCreative as jest.Mock).mockResolvedValue({ id: 'creative_pc' });

        const result = await agentModeService.createMetaAdsAdCreative('user123', params);

        expect(result.success).toBe(true);
        expect(metaService.getPageInstagramActor).not.toHaveBeenCalled();
        expect(metaService.createAdCreative).toHaveBeenCalledWith(
          '123456789',
          'mock-access-token',
          expect.objectContaining({ instagram_user_id: 'explicit_ig' })
        );
      });

      it('should upload placement_assets given as image_url and resolve them to hashes', async () => {
        const params = {
          name: 'Placement Creative',
          page_id: 'page_123',
          body: 'Ad Body',
          title: 'Ad Title',
          link_url: 'https://example.com',
          placement_assets: [
            { image_hash: 'square_hash', is_default: true },
            { image_url: 'https://cdn.example.com/vertical.jpg', placements: ['reels'] }
          ]
        };

        (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
        const uploadSpy = jest.spyOn(agentModeService, 'uploadMetaAdsImage')
          .mockResolvedValue({ success: true, image_hash: 'uploaded_vertical_hash', image_url: 'https://cdn/x' });
        (metaService.createAdCreative as jest.Mock).mockResolvedValue({ id: 'creative_pc' });

        const result = await agentModeService.createMetaAdsAdCreative('user123', params);

        expect(result.success).toBe(true);
        expect(uploadSpy).toHaveBeenCalledTimes(1);
        // The URL asset is replaced with the uploaded hash and image_url is dropped
        expect(metaService.createAdCreative).toHaveBeenCalledWith(
          '123456789',
          'mock-access-token',
          expect.objectContaining({
            placement_assets: [
              { image_hash: 'square_hash', is_default: true },
              { placements: ['reels'], image_hash: 'uploaded_vertical_hash' }
            ]
          })
        );
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

      it('should nest a directly-supplied creative_id (Meta ignores a top-level creative_id)', async () => {
        const params = { creative_id: 'new_creative_B' };

        (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
        (metaService.updateAd as jest.Mock).mockResolvedValue({ success: true });
        // Post-swap verification read-back shows the new creative attached.
        (metaService.getAd as jest.Mock).mockResolvedValue({
          id: 'ad_123',
          creative: { creative_id: 'new_creative_B' }
        });

        const result = await agentModeService.updateMetaAdsAd('user123', 'ad_123', params);

        expect(result.success).toBe(true);
        expect(result.new_creative_id).toBe('new_creative_B');
        // Must nest as { creative: { creative_id } } — a top-level creative_id is silently
        // dropped by Meta (the API returns success but the ad keeps its old creative).
        expect(metaService.updateAd).toHaveBeenCalledWith(
          'mock-access-token',
          'ad_123',
          { creative: { creative_id: 'new_creative_B' } }
        );
        // Must NOT pass a bare top-level creative_id to Meta
        expect(metaService.updateAd).not.toHaveBeenCalledWith(
          'mock-access-token',
          'ad_123',
          { creative_id: 'new_creative_B' }
        );
        // A pre-built creative_id needs no rebuild from the old creative — getAd is only
        // called once, for the post-swap verification read-back.
        expect(metaService.getAd).toHaveBeenCalledTimes(1);
        expect(metaService.getAdCreative).not.toHaveBeenCalled();
        expect(metaService.createAdCreative).not.toHaveBeenCalled();
      });

      it('should apply ad-level params (status) alongside a direct creative_id swap', async () => {
        const params = { creative_id: 'new_creative_B', status: 'ACTIVE' };

        (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
        (metaService.updateAd as jest.Mock).mockResolvedValue({ success: true });
        // Post-swap verification read-back shows the new creative attached.
        (metaService.getAd as jest.Mock).mockResolvedValue({
          id: 'ad_123',
          creative: { creative_id: 'new_creative_B' }
        });

        const result = await agentModeService.updateMetaAdsAd('user123', 'ad_123', params);

        expect(result.success).toBe(true);
        expect(result.new_creative_id).toBe('new_creative_B');
        // The creative swap is issued as a nested creative param
        expect(metaService.updateAd).toHaveBeenCalledWith(
          'mock-access-token',
          'ad_123',
          { creative: { creative_id: 'new_creative_B' } }
        );
        // The ad-level status change is issued separately, without the creative_id
        expect(metaService.updateAd).toHaveBeenCalledWith(
          'mock-access-token',
          'ad_123',
          { status: 'ACTIVE' }
        );
      });

      it('verifies a direct creative_id swap via read-back and reports verified:true', async () => {
        const params = { creative_id: 'new_creative_B' };

        (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
        (metaService.updateAd as jest.Mock).mockResolvedValue({ success: true });
        // Read-back shows the new creative attached.
        (metaService.getAd as jest.Mock).mockResolvedValue({
          id: 'ad_123',
          creative: { creative_id: 'new_creative_B' }
        });

        const result = await agentModeService.updateMetaAdsAd('user123', 'ad_123', params);

        expect(result.success).toBe(true);
        expect(result.new_creative_id).toBe('new_creative_B');
        expect(result.verified).toBe(true);
      });

      it('fails with SWAP_NOT_REFLECTED when a direct creative_id swap is not reflected on read-back', async () => {
        // The same silent-success trap as the auto-build path: POST /{ad-id} returns 200
        // but the ad keeps its old creative.
        const params = { creative_id: 'new_creative_B' };

        (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
        (metaService.updateAd as jest.Mock).mockResolvedValue({ success: true });
        // Read-back: ad STILL on the old creative.
        (metaService.getAd as jest.Mock).mockResolvedValue({
          id: 'ad_123',
          creative: { creative_id: 'old_creative_A' }
        });

        const result = await agentModeService.updateMetaAdsAd('user123', 'ad_123', params);

        expect(result.success).toBe(false);
        expect(result.error).toBe('SWAP_NOT_REFLECTED');
        expect(result.new_creative_id).toBe('new_creative_B');
        expect(result.live_creative_id).toBe('old_creative_A');
      });

      it('should use creative swap when link_url is in params', async () => {
        const params = { link_url: 'https://new-landing-page.com' };

        (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
        // First getAd: initial fetch (old creative). Second getAd: post-swap read-back (new creative + new URL).
        (metaService.getAd as jest.Mock)
          .mockResolvedValueOnce({ id: 'ad_123', creative: { creative_id: 'old_creative_123' } })
          .mockResolvedValue({
            id: 'ad_123',
            creative: {
              creative_id: 'new_creative_456',
              object_story_spec: { page_id: 'page_123', link_data: { link: 'https://new-landing-page.com' } }
            }
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
        expect(result.verified).toBe(true);
        expect(result.live_link_url).toBe('https://new-landing-page.com');
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
        (metaService.getAd as jest.Mock)
          .mockResolvedValueOnce({ id: 'ad_123', creative: { creative_id: 'old_creative_123' } })
          .mockResolvedValue({
            id: 'ad_123',
            creative: {
              creative_id: 'new_creative_789',
              object_story_spec: { page_id: 'page_123', link_data: { link: 'https://new-landing-page.com' } }
            }
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
        (metaService.getAd as jest.Mock)
          .mockResolvedValueOnce({ id: 'ad_123', creative: { creative_id: 'video_creative_123' } })
          .mockResolvedValue({
            id: 'ad_123',
            creative: {
              creative_id: 'new_video_creative_789',
              object_story_spec: {
                page_id: 'page_123',
                video_data: { call_to_action: { value: { link: 'https://new-video-landing.com' } } }
              }
            }
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

      it('carries existing url_tags (UTMs) onto the new creative when not overridden', async () => {
        const params = { link_url: 'https://new-landing-page.com' };

        (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
        (metaService.getAd as jest.Mock)
          .mockResolvedValueOnce({ id: 'ad_123', creative: { creative_id: 'old_creative_123' } })
          .mockResolvedValue({
            id: 'ad_123',
            creative: {
              creative_id: 'new_creative_456',
              object_story_spec: { page_id: 'page_123', link_data: { link: 'https://new-landing-page.com' } }
            }
          });
        (metaService.getAdCreative as jest.Mock).mockResolvedValue({
          id: 'old_creative_123',
          name: 'My Creative',
          url_tags: 'utm_source=meta&utm_medium=paid',
          object_story_spec: {
            page_id: 'page_123',
            link_data: { message: 'Hi', link: 'https://old.com', name: 'T', image_hash: 'abc123' }
          }
        });
        (metaService.createAdCreative as jest.Mock).mockResolvedValue({ id: 'new_creative_456' });
        (metaService.updateAd as jest.Mock).mockResolvedValue({ success: true });

        const result = await agentModeService.updateMetaAdsAd('user123', 'ad_123', params);

        expect(result.success).toBe(true);
        expect(metaService.createAdCreative).toHaveBeenCalledWith(
          '123456789',
          'mock-access-token',
          expect.objectContaining({ url_tags: 'utm_source=meta&utm_medium=paid' })
        );
      });

      it('clears url_tags when the caller explicitly overrides them with an empty string', async () => {
        const params = { link_url: 'https://new-landing-page.com', url_tags: '' };

        (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
        (metaService.getAd as jest.Mock)
          .mockResolvedValueOnce({ id: 'ad_123', creative: { creative_id: 'old_creative_123' } })
          .mockResolvedValue({
            id: 'ad_123',
            creative: {
              creative_id: 'new_creative_456',
              object_story_spec: { page_id: 'page_123', link_data: { link: 'https://new-landing-page.com' } }
            }
          });
        (metaService.getAdCreative as jest.Mock).mockResolvedValue({
          id: 'old_creative_123',
          name: 'My Creative',
          url_tags: 'utm_source=meta&utm_medium=paid',
          object_story_spec: {
            page_id: 'page_123',
            link_data: { message: 'Hi', link: 'https://old.com', name: 'T', image_hash: 'abc123' }
          }
        });
        (metaService.createAdCreative as jest.Mock).mockResolvedValue({ id: 'new_creative_456' });
        (metaService.updateAd as jest.Mock).mockResolvedValue({ success: true });

        const result = await agentModeService.updateMetaAdsAd('user123', 'ad_123', params);

        expect(result.success).toBe(true);
        // The old creative's tags must NOT be carried over when explicitly cleared.
        expect(metaService.createAdCreative).toHaveBeenCalledWith(
          '123456789',
          'mock-access-token',
          expect.not.objectContaining({ url_tags: 'utm_source=meta&utm_medium=paid' })
        );
      });

      it('surfaces effective_status and review feedback on a verified swap', async () => {
        const params = { link_url: 'https://new-landing-page.com' };

        (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
        (metaService.getAd as jest.Mock)
          .mockResolvedValueOnce({ id: 'ad_123', creative: { creative_id: 'old_creative_123' } })
          .mockResolvedValue({
            id: 'ad_123',
            effective_status: 'PENDING_REVIEW',
            ad_review_feedback: { global: { LANDING_PAGE: 'Landing page is still being reviewed' } },
            creative: {
              creative_id: 'new_creative_456',
              object_story_spec: { page_id: 'page_123', link_data: { link: 'https://new-landing-page.com' } }
            }
          });
        (metaService.getAdCreative as jest.Mock).mockResolvedValue({
          id: 'old_creative_123',
          name: 'My Creative',
          object_story_spec: {
            page_id: 'page_123',
            link_data: { message: 'Hi', link: 'https://old.com', name: 'T', image_hash: 'abc123' }
          }
        });
        (metaService.createAdCreative as jest.Mock).mockResolvedValue({ id: 'new_creative_456' });
        (metaService.updateAd as jest.Mock).mockResolvedValue({ success: true });

        const result = await agentModeService.updateMetaAdsAd('user123', 'ad_123', params);

        expect(result.success).toBe(true);
        expect(result.verified).toBe(true);
        expect(result.effective_status).toBe('PENDING_REVIEW');
        expect(result.review_feedback).toBe('Landing page is still being reviewed');
        expect(result.message).toContain('PENDING_REVIEW');
      });

      it('returns SWAP_PENDING when, after all retries, the ad still shows the old creative', async () => {
        // Meta's POST /{ad-id} returned 200 but the ad kept its old creative (silent-success trap).
        // After 3 attempts it is reported as pending (transient Meta propagation), not a hard error.
        const params = { link_url: 'https://new-landing-page.com' };

        (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
        jest.spyOn(agentModeService as any, 'sleep').mockResolvedValue(undefined); // skip backoff delays
        (metaService.getAd as jest.Mock)
          .mockResolvedValueOnce({ id: 'ad_123', creative: { creative_id: 'old_creative_123' } })
          // Read-back (every retry): ad STILL on the old creative → swap did not take.
          .mockResolvedValue({ id: 'ad_123', effective_status: 'PENDING_REVIEW', creative: { creative_id: 'old_creative_123' } });
        (metaService.getAdCreative as jest.Mock).mockResolvedValue({
          id: 'old_creative_123',
          name: 'My Creative',
          object_story_spec: {
            page_id: 'page_123',
            link_data: { message: 'Hi', link: 'https://old.com', name: 'T', image_hash: 'abc123' }
          }
        });
        (metaService.createAdCreative as jest.Mock).mockResolvedValue({ id: 'new_creative_456' });
        (metaService.updateAd as jest.Mock).mockResolvedValue({ success: true });

        const result = await agentModeService.updateMetaAdsAd('user123', 'ad_123', params);

        expect(result.success).toBe(false);
        expect(result.pending).toBe(true);
        expect(result.error).toBe('SWAP_PENDING');
        expect(result.new_creative_id).toBe('new_creative_456');
        expect(result.live_creative_id).toBe('old_creative_123');
        expect(result.effective_status).toBe('PENDING_REVIEW');
        // Re-attach was attempted 3 times (plus 0 ad-level updates).
        expect((metaService.updateAd as jest.Mock).mock.calls.filter(
          (c: any[]) => c[2]?.creative?.creative_id === 'new_creative_456'
        ).length).toBe(3);
      });

      it('returns DESTINATION_PENDING when the live URL never matches after retries', async () => {
        const params = { link_url: 'https://new-landing-page.com' };

        (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
        jest.spyOn(agentModeService as any, 'sleep').mockResolvedValue(undefined); // skip backoff delays
        (metaService.getAd as jest.Mock)
          .mockResolvedValueOnce({ id: 'ad_123', creative: { creative_id: 'old_creative_123' } })
          // Read-back: new creative attached, but its live link stays the OLD url on every retry.
          .mockResolvedValue({
            id: 'ad_123',
            creative: {
              creative_id: 'new_creative_456',
              object_story_spec: { page_id: 'page_123', link_data: { link: 'https://old.com' } }
            }
          });
        (metaService.getAdCreative as jest.Mock).mockResolvedValue({
          id: 'old_creative_123',
          name: 'My Creative',
          object_story_spec: {
            page_id: 'page_123',
            link_data: { message: 'Hi', link: 'https://old.com', name: 'T', image_hash: 'abc123' }
          }
        });
        (metaService.createAdCreative as jest.Mock).mockResolvedValue({ id: 'new_creative_456' });
        (metaService.updateAd as jest.Mock).mockResolvedValue({ success: true });

        const result = await agentModeService.updateMetaAdsAd('user123', 'ad_123', params);

        expect(result.success).toBe(false);
        expect(result.pending).toBe(true);
        expect(result.error).toBe('DESTINATION_PENDING');
        expect(result.requested_link_url).toBe('https://new-landing-page.com');
        expect(result.live_link_url).toBe('https://old.com');
      });

      it('recovers on a later retry when Meta reflects the swap on the 2nd attempt', async () => {
        // First read-back shows old creative (propagation lag); second shows the new one → success.
        const params = { link_url: 'https://new-landing-page.com' };

        (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
        jest.spyOn(agentModeService as any, 'sleep').mockResolvedValue(undefined);
        (metaService.getAd as jest.Mock)
          .mockResolvedValueOnce({ id: 'ad_123', creative: { creative_id: 'old_creative_123' } }) // initial fetch
          .mockResolvedValueOnce({ id: 'ad_123', creative: { creative_id: 'old_creative_123' } }) // attempt 1 read-back: lag
          .mockResolvedValue({ // attempt 2 read-back: reflected
            id: 'ad_123',
            creative: {
              creative_id: 'new_creative_456',
              object_story_spec: { page_id: 'page_123', link_data: { link: 'https://new-landing-page.com' } }
            }
          });
        (metaService.getAdCreative as jest.Mock).mockResolvedValue({
          id: 'old_creative_123',
          name: 'My Creative',
          object_story_spec: {
            page_id: 'page_123',
            link_data: { message: 'Hi', link: 'https://old.com', name: 'T', image_hash: 'abc123' }
          }
        });
        (metaService.createAdCreative as jest.Mock).mockResolvedValue({ id: 'new_creative_456' });
        (metaService.updateAd as jest.Mock).mockResolvedValue({ success: true });

        const result = await agentModeService.updateMetaAdsAd('user123', 'ad_123', params);

        expect(result.success).toBe(true);
        expect(result.verified).toBe(true);
        expect(result.live_link_url).toBe('https://new-landing-page.com');
      });

      it('treats a trailing-slash / case difference as a matching destination (Meta normalization)', async () => {
        const params = { link_url: 'https://new-landing-page.com' };

        (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
        (metaService.getAd as jest.Mock)
          .mockResolvedValueOnce({ id: 'ad_123', creative: { creative_id: 'old_creative_123' } })
          .mockResolvedValue({
            id: 'ad_123',
            creative: {
              creative_id: 'new_creative_456',
              // Meta normalized the URL: added trailing slash.
              object_story_spec: { page_id: 'page_123', link_data: { link: 'https://new-landing-page.com/' } }
            }
          });
        (metaService.getAdCreative as jest.Mock).mockResolvedValue({
          id: 'old_creative_123',
          name: 'My Creative',
          object_story_spec: {
            page_id: 'page_123',
            link_data: { message: 'Hi', link: 'https://old.com', name: 'T', image_hash: 'abc123' }
          }
        });
        (metaService.createAdCreative as jest.Mock).mockResolvedValue({ id: 'new_creative_456' });
        (metaService.updateAd as jest.Mock).mockResolvedValue({ success: true });

        const result = await agentModeService.updateMetaAdsAd('user123', 'ad_123', params);

        expect(result.success).toBe(true);
        expect(result.verified).toBe(true);
      });

      it('treats appended query parameters on the live URL as a matching destination (Meta url_tags)', async () => {
        const params = { link_url: 'https://everyio.agentwebforms.com/icp1' };

        (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
        (metaService.getAd as jest.Mock)
          .mockResolvedValueOnce({ id: 'ad_123', creative: { creative_id: 'old_creative_123' } })
          .mockResolvedValue({
            id: 'ad_123',
            creative: {
              creative_id: 'new_creative_456',
              // Meta appended the creative's url_tags to the link.
              object_story_spec: {
                page_id: 'page_123',
                link_data: { link: 'https://everyio.agentwebforms.com/icp1?utm_source=meta&utm_medium=paid' }
              }
            }
          });
        (metaService.getAdCreative as jest.Mock).mockResolvedValue({
          id: 'old_creative_123',
          name: 'My Creative',
          object_story_spec: {
            page_id: 'page_123',
            link_data: { message: 'Hi', link: 'https://old.com', name: 'T', image_hash: 'abc123' }
          }
        });
        (metaService.createAdCreative as jest.Mock).mockResolvedValue({ id: 'new_creative_456' });
        (metaService.updateAd as jest.Mock).mockResolvedValue({ success: true });

        const result = await agentModeService.updateMetaAdsAd('user123', 'ad_123', params);

        expect(result.success).toBe(true);
        expect(result.verified).toBe(true);
      });

      it('returns DESTINATION_PENDING when the live URL is only the bare domain of the requested page', async () => {
        // A live URL that is merely a prefix of the requested one (missing the landing-page path)
        // must NOT count as verified — this is exactly the wrong-destination bug class. After retries
        // it is reported as pending (Meta still propagating), not a confirmed success.
        const params = { link_url: 'https://everyio.agentwebforms.com/icp1?utm_source=meta' };

        (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
        jest.spyOn(agentModeService as any, 'sleep').mockResolvedValue(undefined); // skip backoff delays
        (metaService.getAd as jest.Mock)
          .mockResolvedValueOnce({ id: 'ad_123', creative: { creative_id: 'old_creative_123' } })
          .mockResolvedValue({
            id: 'ad_123',
            creative: {
              creative_id: 'new_creative_456',
              object_story_spec: { page_id: 'page_123', link_data: { link: 'https://everyio.agentwebforms.com' } }
            }
          });
        (metaService.getAdCreative as jest.Mock).mockResolvedValue({
          id: 'old_creative_123',
          name: 'My Creative',
          object_story_spec: {
            page_id: 'page_123',
            link_data: { message: 'Hi', link: 'https://old.com', name: 'T', image_hash: 'abc123' }
          }
        });
        (metaService.createAdCreative as jest.Mock).mockResolvedValue({ id: 'new_creative_456' });
        (metaService.updateAd as jest.Mock).mockResolvedValue({ success: true });

        const result = await agentModeService.updateMetaAdsAd('user123', 'ad_123', params);

        expect(result.success).toBe(false);
        expect(result.pending).toBe(true);
        expect(result.error).toBe('DESTINATION_PENDING');
      });

      it('returns DESTINATION_PENDING when the live path merely shares a prefix (/icp1 vs /icp10)', async () => {
        const params = { link_url: 'https://everyio.agentwebforms.com/icp1' };

        (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
        jest.spyOn(agentModeService as any, 'sleep').mockResolvedValue(undefined); // skip backoff delays
        (metaService.getAd as jest.Mock)
          .mockResolvedValueOnce({ id: 'ad_123', creative: { creative_id: 'old_creative_123' } })
          .mockResolvedValue({
            id: 'ad_123',
            creative: {
              creative_id: 'new_creative_456',
              object_story_spec: { page_id: 'page_123', link_data: { link: 'https://everyio.agentwebforms.com/icp10' } }
            }
          });
        (metaService.getAdCreative as jest.Mock).mockResolvedValue({
          id: 'old_creative_123',
          name: 'My Creative',
          object_story_spec: {
            page_id: 'page_123',
            link_data: { message: 'Hi', link: 'https://old.com', name: 'T', image_hash: 'abc123' }
          }
        });
        (metaService.createAdCreative as jest.Mock).mockResolvedValue({ id: 'new_creative_456' });
        (metaService.updateAd as jest.Mock).mockResolvedValue({ success: true });

        const result = await agentModeService.updateMetaAdsAd('user123', 'ad_123', params);

        expect(result.success).toBe(false);
        expect(result.pending).toBe(true);
        expect(result.error).toBe('DESTINATION_PENDING');
      });

      it('still succeeds when the post-swap read-back itself throws (best-effort verification)', async () => {
        const params = { link_url: 'https://new-landing-page.com' };

        (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
        (metaService.getAd as jest.Mock)
          .mockResolvedValueOnce({ id: 'ad_123', creative: { creative_id: 'old_creative_123' } })
          .mockRejectedValue(new Error('transient network error'));
        (metaService.getAdCreative as jest.Mock).mockResolvedValue({
          id: 'old_creative_123',
          name: 'My Creative',
          object_story_spec: {
            page_id: 'page_123',
            link_data: { message: 'Hi', link: 'https://old.com', name: 'T', image_hash: 'abc123' }
          }
        });
        (metaService.createAdCreative as jest.Mock).mockResolvedValue({ id: 'new_creative_456' });
        (metaService.updateAd as jest.Mock).mockResolvedValue({ success: true });

        const result = await agentModeService.updateMetaAdsAd('user123', 'ad_123', params);

        expect(result.success).toBe(true);
        expect(result.new_creative_id).toBe('new_creative_456');
        // The swap was sent but never confirmed — the result must NOT claim it was verified,
        // since the tool doc tells the agent verified:true means the URL is live in Ads Manager.
        expect(result.verified).toBe(false);
        expect(result.live_link_url).toBeUndefined();
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

      it('should swap to a placement-customized creative, carrying over copy from the old creative', async () => {
        // Repro: an ad with a single square Feed image is rejected on Stories/Reels placements.
        // Fix: AD UPDATE with placement_assets builds a multi-placement creative and swaps it in.
        const params = {
          placement_assets: [
            { image_hash: 'square_hash', is_default: true },
            { image_hash: 'vertical_9x16_hash', placements: ['story', 'reels'] }
          ]
        };

        (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
        (metaService.getAd as jest.Mock)
          .mockResolvedValueOnce({ id: 'ad_123', creative: { creative_id: 'old_square_creative' } })
          .mockResolvedValue({ id: 'ad_123', creative: { creative_id: 'new_placement_creative' } });
        (metaService.getAdCreative as jest.Mock).mockResolvedValue({
          id: 'old_square_creative',
          name: 'Maint-05 - 24/7 Coverage',
          object_story_spec: {
            page_id: 'page_123',
            link_data: {
              message: '24/7 coverage you can count on',
              link: 'https://usehaven.ai',
              name: 'Always-on Maintenance',
              image_hash: 'square_hash',
              call_to_action: { type: 'LEARN_MORE', value: { link: 'https://usehaven.ai' } }
            }
          }
        });
        (metaService.createAdCreative as jest.Mock).mockResolvedValue({ id: 'new_placement_creative' });
        (metaService.updateAd as jest.Mock).mockResolvedValue({ success: true });

        const result = await agentModeService.updateMetaAdsAd('user123', 'ad_123', params);

        expect(result.success).toBe(true);
        expect(result.old_creative_id).toBe('old_square_creative');
        expect(result.new_creative_id).toBe('new_placement_creative');

        // New creative carries over body/title/link/CTA from the old creative + the placement assets
        expect(metaService.createAdCreative).toHaveBeenCalledWith(
          '123456789',
          'mock-access-token',
          expect.objectContaining({
            page_id: 'page_123',
            body: '24/7 coverage you can count on',
            title: 'Always-on Maintenance',
            link_url: 'https://usehaven.ai',
            call_to_action_type: 'LEARN_MORE',
            placement_assets: [
              { image_hash: 'square_hash', is_default: true },
              { image_hash: 'vertical_9x16_hash', placements: ['story', 'reels'] }
            ]
          })
        );

        // Same ad_id is pointed at the new creative (nested) — no UI, no recreate
        expect(metaService.updateAd).toHaveBeenCalledWith(
          'mock-access-token',
          'ad_123',
          { creative: { creative_id: 'new_placement_creative' } }
        );
      });

      it('auto-resolves instagram_user_id during a placement-asset AD UPDATE swap (IG placements)', async () => {
        const params = {
          placement_assets: [
            { image_hash: 'square_hash', is_default: true },
            { image_hash: 'vertical_9x16_hash', placements: ['story', 'reels'] }
          ]
        };

        (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
        (metaService.getAd as jest.Mock)
          .mockResolvedValueOnce({ id: 'ad_123', creative: { creative_id: 'old_square_creative' } })
          .mockResolvedValue({ id: 'ad_123', creative: { creative_id: 'new_placement_creative' } });
        (metaService.getAdCreative as jest.Mock).mockResolvedValue({
          id: 'old_square_creative',
          name: 'Maint-05',
          object_story_spec: {
            page_id: 'page_123',
            link_data: { message: 'Hi', link: 'https://usehaven.ai', name: 'T', image_hash: 'square_hash' }
          }
        });
        (metaService.getPageInstagramActor as jest.Mock).mockResolvedValue('17841469032554858');
        (metaService.createAdCreative as jest.Mock).mockResolvedValue({ id: 'new_placement_creative' });
        (metaService.updateAd as jest.Mock).mockResolvedValue({ success: true });

        const result = await agentModeService.updateMetaAdsAd('user123', 'ad_123', params);

        expect(result.success).toBe(true);
        expect(metaService.getPageInstagramActor).toHaveBeenCalledWith('mock-access-token', 'page_123');
        expect(metaService.createAdCreative).toHaveBeenCalledWith(
          '123456789',
          'mock-access-token',
          expect.objectContaining({ instagram_user_id: '17841469032554858' })
        );
      });

      it('should upload placement_assets URLs to hashes during an AD UPDATE swap', async () => {
        const params = {
          placement_assets: [
            { image_hash: 'square_hash', is_default: true },
            { image_url: 'https://cdn.example.com/vertical.jpg', placements: ['reels'] }
          ]
        };

        (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
        (metaService.getAd as jest.Mock)
          .mockResolvedValueOnce({ id: 'ad_123', creative: { creative_id: 'old_creative' } })
          .mockResolvedValue({ id: 'ad_123', creative: { creative_id: 'new_creative' } });
        (metaService.getAdCreative as jest.Mock).mockResolvedValue({
          id: 'old_creative',
          name: 'My Creative',
          object_story_spec: {
            page_id: 'page_123',
            link_data: { message: 'Hi', link: 'https://old.com', name: 'T', image_hash: 'square_hash' }
          }
        });
        const uploadSpy = jest.spyOn(agentModeService, 'uploadMetaAdsImage')
          .mockResolvedValue({ success: true, image_hash: 'uploaded_hash', image_url: 'https://cdn/x' });
        (metaService.createAdCreative as jest.Mock).mockResolvedValue({ id: 'new_creative' });
        (metaService.updateAd as jest.Mock).mockResolvedValue({ success: true });

        const result = await agentModeService.updateMetaAdsAd('user123', 'ad_123', params);

        expect(result.success).toBe(true);
        expect(uploadSpy).toHaveBeenCalledTimes(1);
        expect(metaService.createAdCreative).toHaveBeenCalledWith(
          '123456789',
          'mock-access-token',
          expect.objectContaining({
            placement_assets: [
              { image_hash: 'square_hash', is_default: true },
              { placements: ['reels'], image_hash: 'uploaded_hash' }
            ]
          })
        );
      });
    });

    describe('copyMetaAdsAd', () => {
      it('carries existing url_tags (UTMs) from the source creative onto the copy', async () => {
        (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
        (metaService.getAd as jest.Mock).mockResolvedValue({
          id: 'src_ad',
          name: 'Source Ad',
          adset_id: 'as_1',
          creative: { creative_id: 'src_creative' }
        });
        (metaService.getAdCreative as jest.Mock).mockResolvedValue({
          id: 'src_creative',
          name: 'Source Creative',
          url_tags: 'utm_source=meta&utm_campaign=spring',
          object_story_spec: {
            page_id: 'page_123',
            link_data: { message: 'Hi', link: 'https://src.com', name: 'T', image_hash: 'abc' }
          }
        });
        (metaService.createAdCreative as jest.Mock).mockResolvedValue({ id: 'copy_creative' });
        (metaService.createAd as jest.Mock).mockResolvedValue({ id: 'copy_ad' });

        const result = await agentModeService.copyMetaAdsAd('user123', 'src_ad', {});

        expect(result.success).toBe(true);
        expect(metaService.createAdCreative).toHaveBeenCalledWith(
          '123456789',
          'mock-access-token',
          expect.objectContaining({ url_tags: 'utm_source=meta&utm_campaign=spring' })
        );
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

    describe('retagMetaAdUtm — single existing ad retrofit (Harsha\'s ask)', () => {
      it('errors when the ad has no creative assigned', async () => {
        (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
        (metaService.getAd as jest.Mock).mockResolvedValue({ id: 'ad_123' });

        const result = await agentModeService.retagMetaAdUtm('user123', 'ad_123');

        expect(result.success).toBe(false);
        expect(result.error).toBe('MISSING_CREATIVE');
        expect(metaService.getAdCreative).not.toHaveBeenCalled();
      });

      it('errors when the creative has no object_story_spec (unsupported/deleted creative)', async () => {
        (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
        (metaService.getAd as jest.Mock).mockResolvedValue({ id: 'ad_123', creative: { creative_id: 'creative_1' } });
        (metaService.getAdCreative as jest.Mock).mockResolvedValue({ id: 'creative_1' });

        const result = await agentModeService.retagMetaAdUtm('user123', 'ad_123');

        expect(result.success).toBe(false);
        expect(result.error).toBe('MISSING_OBJECT_STORY_SPEC');
      });

      it('is a no-op when the ad already carries every UTM key (boundary)', async () => {
        (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
        (metaService.getAd as jest.Mock).mockResolvedValue({ id: 'ad_123', creative: { creative_id: 'creative_1' } });
        (metaService.getAdCreative as jest.Mock).mockResolvedValue({
          id: 'creative_1',
          url_tags: 'utm_source=meta&utm_medium=paid&utm_campaign={{campaign.id}}&utm_content={{ad.id}}',
          object_story_spec: { page_id: 'page_1', link_data: { link: 'https://acme.com/' } },
        });

        const result = await agentModeService.retagMetaAdUtm('user123', 'ad_123');

        expect(result).toEqual({ success: true, alreadyTagged: true });
        expect(metaService.createAdCreative).not.toHaveBeenCalled();
        expect(metaService.updateAd).not.toHaveBeenCalled();
      });

      it('does not duplicate utm_source when the only existing UTM is on a per-card CTA link (Greptile)', async () => {
        // A carousel card's destination can live on card.call_to_action.value.link
        // instead of card.link — extractCreativeDestinationUrls (the audit's own
        // reader) covers this path; the retag's omit-set computation must too, or
        // it will add utm_source=meta on top of the utm_source already baked into
        // this card's real destination link, producing a duplicate at delivery.
        (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
        (metaService.getAd as jest.Mock).mockResolvedValue({ id: 'ad_123', creative: { creative_id: 'creative_1' } });
        (metaService.getAdCreative as jest.Mock).mockResolvedValue({
          id: 'creative_1',
          object_story_spec: {
            page_id: 'page_1',
            link_data: {
              child_attachments: [
                { call_to_action: { value: { link: 'https://acme.com/card1?utm_source=existing&utm_medium=paid&utm_campaign={{campaign.id}}&utm_content={{ad.id}}' } } },
              ],
            },
          },
        });

        const result = await agentModeService.retagMetaAdUtm('user123', 'ad_123');

        expect(result).toEqual({ success: true, alreadyTagged: true });
        expect(metaService.createAdCreative).not.toHaveBeenCalled();
      });

      it('retags an untagged ad by swapping in a new creative with the merged url_tags (happy path)', async () => {
        (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
        (metaService.getAd as jest.Mock)
          .mockResolvedValueOnce({ id: 'ad_123', creative: { creative_id: 'creative_1' } })
          .mockResolvedValue({
            id: 'ad_123',
            creative: { creative_id: 'creative_2', object_story_spec: { page_id: 'page_1', link_data: { link: 'https://acme.com/' } } },
          });
        (metaService.getAdCreative as jest.Mock).mockResolvedValue({
          id: 'creative_1',
          name: 'My Creative',
          object_story_spec: { page_id: 'page_1', link_data: { link: 'https://acme.com/', message: 'Hi', name: 'Title' } },
        });
        (metaService.createAdCreative as jest.Mock).mockResolvedValue({ id: 'creative_2' });
        (metaService.updateAd as jest.Mock).mockResolvedValue({ success: true });

        const result = await agentModeService.retagMetaAdUtm('user123', 'ad_123');

        expect(result.success).toBe(true);
        expect(metaService.createAdCreative).toHaveBeenCalledWith(
          '123456789',
          'mock-access-token',
          expect.objectContaining({
            url_tags: 'utm_source=meta&utm_medium=paid&utm_campaign={{campaign.id}}&utm_content={{ad.id}}',
            link_url: 'https://acme.com/', // destination untouched — only url_tags changes
          }),
        );
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
