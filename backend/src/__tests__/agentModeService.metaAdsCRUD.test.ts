jest.mock('../services/agentMode/adsLearning', () => ({ recordCreativeLearningReceipt: jest.fn().mockResolvedValue(undefined) }));
// Mock MCP client service first
jest.mock('../mcp/client/mcpClientService', () => ({
  McpClientService: jest.fn().mockImplementation(() => ({
    isReady: jest.fn().mockReturnValue(true)
  }))
}));

// Mock the dependencies
jest.mock('../services/metaService', () => ({
  normalizeMetaMoney: jest.requireActual('../services/metaService').normalizeMetaMoney,
  metaService: {
    getAdAccountCurrency: jest.fn().mockResolvedValue('USD'),
    listAdSets: jest.fn(),
    createAdSet: jest.fn(),
    updateAdSet: jest.fn(),
    deleteAdSet: jest.fn(),
    getAdSet: jest.fn(), // ENG-3065: ad set updates and deletes are read back
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

jest.mock('../services/landerUtmStore', () => ({
  getCustomerUtmDefault: jest.fn(),
  getLanderUtmOverride: jest.fn(),
}));

jest.mock('../utils/secretsManager', () => ({
  getMetaAccessToken: jest.fn().mockResolvedValue('mock-access-token')
}));

import { AgentModeService } from '../services/agentModeService';
import { metaService } from '../services/metaService';
import { userDb } from '../services/db';
import { getCustomerUtmDefault, getLanderUtmOverride } from '../services/landerUtmStore';

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
        (metaService.listAdSets as jest.Mock).mockResolvedValue({
          adSets: mockAdSets,
          truncated: false,
          pagesFetched: 1,
          scope: {},
        });

        const result = await agentModeService.listMetaAdsAdSets('user123');

        expect(result.success).toBe(true);
        // ENG-1625: bare "Found N ad set(s)" was the ENG-1476/ENG-1584 sentence shape — the
        // message now names scope and completeness explicitly.
        expect(result.message).toBe('Found 2 ad set(s) in this ad account (complete list).');
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
        // ENG-3065 added getAdSet to this file's mock, so the ENG-838 create read-back now runs here.
        (metaService.getAdSet as jest.Mock).mockResolvedValue({
          id: 'adset_123', name: 'New Ad Set', bid_strategy: 'LOWEST_COST_WITH_BID_CAP', bid_amount: '200', daily_budget: '100000',
        });

        const result = await agentModeService.createMetaAdsAdSet('user123', params);

        expect(result.success).toBe(true);
        expect(result.message).toBe('Ad set "New Ad Set" created successfully (money submitted: daily_budget: 100000 (= $1,000.00); bid_amount: 200 (= $2.00))');
        expect(result.adSet).toEqual(mockAdSetData);
      });

      // ENG-600 regression lock: targeting.custom_audiences/excluded_custom_audiences
      // must pass through to metaService.createAdSet verbatim (no whitelist/strip),
      // since the new audience-sourced campaign-launch workflows rely on this being
      // a true passthrough with zero service-layer changes.
      it('passes targeting.custom_audiences through to metaService.createAdSet verbatim', async () => {
        const mockAdSetData = { id: 'adset_456', name: 'Targeted Ad Set' };
        const params = {
          name: 'Targeted Ad Set',
          campaign_id: 'camp_123',
          billing_event: 'IMPRESSIONS',
          optimization_goal: 'REACH',
          targeting: {
            geo_locations: { countries: ['US'] },
            custom_audiences: [{ id: 'aud_seed_1' }],
          },
          daily_budget: 1000,
          bid_strategy: 'LOWEST_COST_WITH_BID_CAP',
          bid_amount: 2.00,
        };

        (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
        (metaService.getCampaign as jest.Mock).mockResolvedValue({ id: 'camp_123', objective: 'OUTCOME_AWARENESS' });
        (metaService.createAdSet as jest.Mock).mockResolvedValue(mockAdSetData);

        await agentModeService.createMetaAdsAdSet('user123', params);

        const [, , calledParams] = (metaService.createAdSet as jest.Mock).mock.calls[0];
        expect(calledParams.targeting.custom_audiences).toEqual([{ id: 'aud_seed_1' }]);
      });

      it('passes targeting.excluded_custom_audiences through to metaService.createAdSet verbatim', async () => {
        const mockAdSetData = { id: 'adset_789', name: 'Retargeting Ad Set' };
        const params = {
          name: 'Retargeting Ad Set',
          campaign_id: 'camp_123',
          billing_event: 'IMPRESSIONS',
          optimization_goal: 'REACH',
          targeting: {
            geo_locations: { countries: ['US'] },
            custom_audiences: [{ id: 'aud_seed_2' }],
            excluded_custom_audiences: [{ id: 'aud_broad_control' }],
          },
          daily_budget: 1000,
          bid_strategy: 'LOWEST_COST_WITH_BID_CAP',
          bid_amount: 2.00,
        };

        (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
        (metaService.getCampaign as jest.Mock).mockResolvedValue({ id: 'camp_123', objective: 'OUTCOME_AWARENESS' });
        (metaService.createAdSet as jest.Mock).mockResolvedValue(mockAdSetData);

        await agentModeService.createMetaAdsAdSet('user123', params);

        const [, , calledParams] = (metaService.createAdSet as jest.Mock).mock.calls[0];
        expect(calledParams.targeting.excluded_custom_audiences).toEqual([{ id: 'aud_broad_control' }]);
        expect(calledParams.targeting.custom_audiences).toEqual([{ id: 'aud_seed_2' }]);
      });
    });

    describe('updateMetaAdsAdSet', () => {
      it('should successfully update an ad set', async () => {
        const params = { status: 'PAUSED' };

        (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
        (metaService.updateAdSet as jest.Mock).mockResolvedValue({ success: true });
        (metaService.getAdSet as jest.Mock).mockResolvedValue({ id: 'adset_123', status: 'PAUSED' }); // ENG-3065 read-back

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
          expect.objectContaining({ daily_budget: 15000 }),
          '123456789'
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
          expect.objectContaining({ lifetime_budget: 50000 }),
          '123456789'
        );
      });

      it('should convert bid_amount from dollars to cents before calling metaService', async () => {
        const params = { bid_amount: 2.5 };

        (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
        (metaService.updateAdSet as jest.Mock).mockResolvedValue({ success: true });
        (metaService.getAdSet as jest.Mock).mockResolvedValue({ id: 'adset_123', bid_amount: '250' }); // ENG-3065 read-back

        await agentModeService.updateMetaAdsAdSet('user123', 'adset_123', params);

        expect(metaService.updateAdSet).toHaveBeenCalledWith(
          'mock-access-token',
          'adset_123',
          expect.objectContaining({ bid_amount: 250 }),
          '123456789'
        );
      });

      it('should not modify params without budget fields', async () => {
        const params = { name: 'Renamed Ad Set', status: 'ACTIVE' };

        (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
        (metaService.updateAdSet as jest.Mock).mockResolvedValue({ success: true });
        (metaService.getAdSet as jest.Mock).mockResolvedValue({ id: 'adset_123', ...params }); // ENG-3065 read-back

        await agentModeService.updateMetaAdsAdSet('user123', 'adset_123', params);

        expect(metaService.updateAdSet).toHaveBeenCalledWith(
          'mock-access-token',
          'adset_123',
          expect.objectContaining({ name: 'Renamed Ad Set', status: 'ACTIVE' }),
          '123456789'
        );
      });
    });

    describe('deleteMetaAdsAdSet', () => {
      it('should successfully delete an ad set', async () => {
        (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
        (metaService.deleteAdSet as jest.Mock).mockResolvedValue({ success: true });
        (metaService.getAdSet as jest.Mock).mockResolvedValue({ id: 'adset_123', status: 'DELETED' }); // ENG-3065 read-back

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
        (metaService.listAdCreatives as jest.Mock).mockResolvedValue({
          creatives: mockCreatives, truncated: false, pagesFetched: 1, scope: {}
        });

        const result = await agentModeService.listMetaAdsAdCreatives('user123');

        expect(result.success).toBe(true);
        expect(result.message).toBe('Found 2 ad creative(s) in this ad account (complete list).');
        expect(result.creatives).toEqual(mockCreatives);
        expect(result.totalCount).toBe(2);
        expect(result.complete).toBe(true);
      });

      it('should handle empty results', async () => {
        (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
        (metaService.listAdCreatives as jest.Mock).mockResolvedValue({
          creatives: [], truncated: false, pagesFetched: 1, scope: {}
        });

        const result = await agentModeService.listMetaAdsAdCreatives('user123');

        expect(result.success).toBe(true);
        expect(result.totalCount).toBe(0);
      });
    });

    describe('createMetaAdsAdCreative', () => {
      const utmParams = {
        name: 'UTM Creative',
        page_id: 'page_123',
        image_hash: 'hash_123',
        body: 'Body',
        title: 'Title',
        link_url: 'https://example.com/lander',
        lander_id: 'lander_123',
      };

      it('emits customer defaults through the shared lander resolver', async () => {
        (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
        (getCustomerUtmDefault as jest.Mock).mockResolvedValue({ utm_source: 'customer', utm_medium: 'paid' });
        (getLanderUtmOverride as jest.Mock).mockResolvedValue(null);
        (metaService.createAdCreative as jest.Mock).mockResolvedValue({ id: 'creative_utm', name: 'UTM Creative' });

        await agentModeService.createMetaAdsAdCreative('user123', utmParams);

        expect(metaService.createAdCreative).toHaveBeenCalledWith(
          '123456789',
          'mock-access-token',
          expect.objectContaining({
            url_tags: 'utm_source=customer&utm_medium=paid&aw_lander=1',
          }),
        );
      });

      it('keeps Meta macros unencoded in configured UTM values', async () => {
        (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
        (getCustomerUtmDefault as jest.Mock).mockResolvedValue({ utm_campaign: '{{campaign.id}}' });
        (getLanderUtmOverride as jest.Mock).mockResolvedValue(null);
        (metaService.createAdCreative as jest.Mock).mockResolvedValue({ id: 'creative_utm', name: 'UTM Creative' });

        await agentModeService.createMetaAdsAdCreative('user123', utmParams);

        expect(metaService.createAdCreative).toHaveBeenCalledWith(
          '123456789',
          'mock-access-token',
          expect.objectContaining({ url_tags: 'utm_campaign={{campaign.id}}&aw_lander=1' }),
        );
      });

      it('lets a per-lander override win and preserves click ids', async () => {
        (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
        (getCustomerUtmDefault as jest.Mock).mockResolvedValue({ utm_source: 'customer', utm_campaign: 'default' });
        (getLanderUtmOverride as jest.Mock).mockResolvedValue({ utm_source: 'lander', utm_campaign: 'override' });
        (metaService.createAdCreative as jest.Mock).mockResolvedValue({ id: 'creative_utm', name: 'UTM Creative' });

        await agentModeService.createMetaAdsAdCreative('user123', {
          ...utmParams,
          url_tags: 'gclid=google-click&fbclid=meta-click',
        });

        expect(metaService.createAdCreative).toHaveBeenCalledWith(
          '123456789',
          'mock-access-token',
          expect.objectContaining({
            url_tags: 'utm_source=lander&utm_campaign=override&gclid=google-click&fbclid=meta-click&aw_lander=1',
          }),
        );
      });

      it('keeps url_tags absent when no default or override exists', async () => {
        (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
        (getCustomerUtmDefault as jest.Mock).mockResolvedValue(null);
        (getLanderUtmOverride as jest.Mock).mockResolvedValue(null);
        (metaService.createAdCreative as jest.Mock).mockResolvedValue({ id: 'creative_utm', name: 'UTM Creative' });

        await agentModeService.createMetaAdsAdCreative('user123', utmParams);

        expect(metaService.createAdCreative).toHaveBeenCalledWith(
          '123456789',
          'mock-access-token',
          expect.not.objectContaining({ url_tags: expect.anything() }),
        );
      });

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

      describe('ENG-2596 read-back of description / instagram_user_id', () => {
        const base = {
          name: 'RB Creative', page_id: 'page_123', image_hash: 'h', body: 'B', title: 'T',
          link_url: 'https://example.com', description: 'The marketing OS', instagram_user_id: 'ig_1',
        };
        beforeEach(() => {
          (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
          (metaService.createAdCreative as jest.Mock).mockResolvedValue({ id: 'c1', name: 'RB Creative' });
        });

        it('returns verified:false with unapplied_fields and the creative id when Meta stored neither', async () => {
          (metaService.getAdCreative as jest.Mock).mockResolvedValue({ object_story_spec: { link_data: {} } });
          const result = await agentModeService.createMetaAdsAdCreative('user123', base);
          expect(result.success).toBe(true);
          expect(result.verified).toBe(false);
          expect(result.unapplied_fields).toEqual(['instagram_user_id', 'description']);
          expect(result.message).toContain('id c1');
          expect(result.message).toContain('rather than creating another');
        });

        it('names the creative from the request when Meta\'s create response carries only the id (ENG-2624)', async () => {
          (metaService.createAdCreative as jest.Mock).mockResolvedValue({ id: 'c1' });
          (metaService.getAdCreative as jest.Mock).mockResolvedValue({ object_story_spec: { link_data: {} } });
          const flagged = await agentModeService.createMetaAdsAdCreative('user123', base);
          expect(flagged.message).toContain('"RB Creative"');
          expect(flagged.message).not.toContain('undefined');

          (metaService.getAdCreative as jest.Mock).mockResolvedValue({
            object_story_spec: { instagram_user_id: 'ig_1', link_data: { description: 'The marketing OS' } },
          });
          const ok = await agentModeService.createMetaAdsAdCreative('user123', base);
          expect(ok.message).toBe('Ad creative "RB Creative" created successfully');
          expect(ok.creative.name).toBe('RB Creative');
        });

        it('is a plain success when Meta stored both', async () => {
          (metaService.getAdCreative as jest.Mock).mockResolvedValue({
            object_story_spec: { instagram_user_id: 'ig_1', link_data: { description: 'The marketing OS' } },
          });
          const result = await agentModeService.createMetaAdsAdCreative('user123', base);
          expect(result.verified).toBeUndefined();
          expect(result.message).toBe('Ad creative "RB Creative" created successfully');
        });

        it('tells the model a carousel description cannot be applied and not to recreate', async () => {
          (metaService.getAdCreative as jest.Mock).mockResolvedValue({ object_story_spec: { link_data: {} } });
          const result = await agentModeService.createMetaAdsAdCreative('user123', {
            ...base, instagram_user_id: undefined, image_hash: undefined,
            carousel_cards: [{ image_hash: 'a' }, { image_hash: 'b' }],
          });
          expect(result.unapplied_fields).toEqual(['description']);
          expect(result.message).toContain('carousel_cards[].description');
          expect(result.message).toContain('Do not recreate');
        });

        it('reports readback_unavailable (still success) when the read-back throws', async () => {
          (metaService.getAdCreative as jest.Mock).mockRejectedValue(new Error('timeout'));
          const result = await agentModeService.createMetaAdsAdCreative('user123', base);
          expect(result.success).toBe(true);
          expect(result.verified).toBeUndefined();
          expect(result.readback_unavailable).toBe(true);
        });

        it('does not read back, or check, an auto-resolved instagram_user_id the caller never asked for', async () => {
          (metaService.getPageInstagramActor as jest.Mock).mockResolvedValue('auto_ig');
          const { description: _d, instagram_user_id: _i, image_hash: _h, ...rest } = base;
          const result = await agentModeService.createMetaAdsAdCreative('user123', {
            ...rest, placement_assets: [{ image_hash: 'a', is_default: true }, { image_hash: 'b', placements: ['story'] }],
          });
          expect(metaService.createAdCreative).toHaveBeenCalledWith('123456789', 'mock-access-token',
            expect.objectContaining({ instagram_user_id: 'auto_ig' }));
          expect(metaService.getAdCreative).not.toHaveBeenCalled();
          expect(result.verified).toBeUndefined();
        });
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
        (metaService.listAds as jest.Mock).mockResolvedValue({
          ads: mockAds, truncated: false, pagesFetched: 1, scope: {}
        });

        const result = await agentModeService.listMetaAdsAds('user123');

        expect(result.success).toBe(true);
        expect(result.message).toBe('Found 2 ad(s) in this ad account (complete list).');
        expect(result.ads).toEqual(mockAds);
        expect(result.totalCount).toBe(2);
        expect(result.complete).toBe(true);
      });

      it('should filter by adSetId when provided', async () => {
        const mockAds = [{ id: 'ad_1', name: 'Ad 1' }];

        (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
        (metaService.listAds as jest.Mock).mockResolvedValue({
          ads: mockAds, truncated: false, pagesFetched: 1, scope: { adSetId: 'adset_123' }
        });

        await agentModeService.listMetaAdsAds('user123', 'adset_123');

        expect(metaService.listAds).toHaveBeenCalledWith(
          '123456789', 'mock-access-token', 'adset_123', { campaignId: undefined }
        );
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
        (metaService.getAd as jest.Mock).mockResolvedValue({ id: 'ad_123', status: 'ACTIVE' });

        const result = await agentModeService.updateMetaAdsAd('user123', 'ad_123', params);

        expect(result.success).toBe(true);
        expect(result.message).toBe('Ad updated successfully');
        expect(metaService.updateAd).toHaveBeenCalledWith('mock-access-token', 'ad_123', params, '123456789');
        // ENG-3065: one getAd read-back for the ad-level fields; still no creative read.
        expect(metaService.getAd).toHaveBeenCalledTimes(1);
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
          { creative: { creative_id: 'new_creative_B' } },
          '123456789'
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
          status: 'ACTIVE', // ENG-3065: the ad-level status is read back too
          creative: { creative_id: 'new_creative_B' }
        });

        const result = await agentModeService.updateMetaAdsAd('user123', 'ad_123', params);

        expect(result.success).toBe(true);
        expect(result.new_creative_id).toBe('new_creative_B');
        // The creative swap is issued as a nested creative param
        expect(metaService.updateAd).toHaveBeenCalledWith(
          'mock-access-token',
          'ad_123',
          { creative: { creative_id: 'new_creative_B' } },
          '123456789'
        );
        // The ad-level status change is issued separately, without the creative_id
        expect(metaService.updateAd).toHaveBeenCalledWith(
          'mock-access-token',
          'ad_123',
          { status: 'ACTIVE' },
          '123456789'
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

      // ENG-3065: an ad-level field sent alongside creative content is read back before the swap.
      it('stops before attaching the new creative when the ad-level status did not land', async () => {
        jest.spyOn(agentModeService as any, 'sleep').mockResolvedValue(undefined);
        (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
        (metaService.getAd as jest.Mock).mockResolvedValue({ id: 'ad_123', status: 'ACTIVE', creative: { creative_id: 'old_creative_123' } });
        (metaService.getAdCreative as jest.Mock).mockResolvedValue({
          id: 'old_creative_123',
          name: 'My Creative',
          object_story_spec: {
            page_id: 'page_123',
            link_data: { message: 'Hi', link: 'https://old-page.com', name: 'T', image_hash: 'abc123' }
          }
        });
        (metaService.createAdCreative as jest.Mock).mockResolvedValue({ id: 'new_creative_456' });
        (metaService.updateAd as jest.Mock).mockResolvedValue({ success: true });

        const result = await agentModeService.updateMetaAdsAd('user123', 'ad_123', { link_url: 'https://new-landing-page.com', status: 'PAUSED' });

        expect(result).toMatchObject({ success: false, errorType: 'unsupported_field', fields: ['status'] });
        expect(metaService.updateAd).toHaveBeenCalledTimes(1);
        expect(metaService.updateAd).toHaveBeenCalledWith('mock-access-token', 'ad_123', { status: 'PAUSED' }, '123456789');
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
          { creative: { creative_id: 'new_creative_456' } },
          '123456789'
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

      describe('image swap (ENG-2169)', () => {
        const OLD_LINK_SPEC = {
          page_id: 'page_123',
          link_data: { message: 'Hi', link: 'https://old.com', name: 'T', image_hash: 'old_hash', picture: 'https://cdn/old.jpg' }
        };
        const OLD_VIDEO_SPEC = {
          page_id: 'page_123',
          video_data: { video_id: 'vid_1', image_hash: 'old_thumb_hash', message: 'Hi', title: 'T' }
        };

        // getAdCreative: first call reads the old creative, second reads back the created one.
        const mockSwap = (oldSpec: object, createdSpec: object) => {
          jest.mocked(userDb.getUserById).mockResolvedValue(mockUser as never);
          jest.mocked(metaService.getAd)
            .mockResolvedValueOnce({ id: 'ad_123', creative: { creative_id: 'old_creative_123' } } as never)
            .mockResolvedValue({ id: 'ad_123', creative: { creative_id: 'new_creative_456' } } as never);
          jest.mocked(metaService.getAdCreative)
            .mockResolvedValueOnce({ id: 'old_creative_123', name: 'My Creative', object_story_spec: oldSpec } as never)
            .mockResolvedValue({ id: 'new_creative_456', object_story_spec: createdSpec } as never);
          jest.mocked(metaService.createAdCreative).mockResolvedValue({ id: 'new_creative_456' } as never);
          jest.mocked(metaService.updateAd).mockResolvedValue({ success: true } as never);
        };
        const sentCreative = () => jest.mocked(metaService.createAdCreative).mock.calls[0][2];
        const attachCalls = () => jest.mocked(metaService.updateAd).mock.calls
          .filter(c => (c[2] as { creative?: unknown }).creative !== undefined);

        it('drops the old image_hash when only a new image_url is given (single image)', async () => {
          mockSwap(OLD_LINK_SPEC, { page_id: 'page_123', link_data: { image_hash: 'fresh_hash' } });

          const result = await agentModeService.updateMetaAdsAd('user123', 'ad_123', { image_url: 'https://cdn/new.jpg' });

          expect(sentCreative().image_hash).toBeUndefined();
          expect(sentCreative().image_url).toBe('https://cdn/new.jpg');
          expect(result.success).toBe(true);
          expect(result.verified).toBe(true);
          expect(result.image_verified).toBe(true);
        });

        it('drops the old thumbnail hash when only a new image_url is given (video)', async () => {
          mockSwap(OLD_VIDEO_SPEC, { page_id: 'page_123', video_data: { video_id: 'vid_1', image_hash: 'fresh_hash' } });

          const result = await agentModeService.updateMetaAdsAd('user123', 'ad_123', { image_url: 'https://cdn/thumb.jpg' });

          expect(sentCreative().image_hash).toBeUndefined();
          expect(sentCreative().image_url).toBe('https://cdn/thumb.jpg');
          expect(sentCreative().video_id).toBe('vid_1');
          expect(result.success).toBe(true);
        });

        it('uses a new image_hash when one is given', async () => {
          mockSwap(OLD_LINK_SPEC, { page_id: 'page_123', link_data: { image_hash: 'new_hash' } });

          const result = await agentModeService.updateMetaAdsAd('user123', 'ad_123', { image_hash: 'new_hash' });

          expect(sentCreative().image_hash).toBe('new_hash');
          expect(result.success).toBe(true);
        });

        it('carries the old image over unchanged when no image is given', async () => {
          mockSwap(OLD_LINK_SPEC, OLD_LINK_SPEC);
          jest.mocked(metaService.getAd).mockReset()
            .mockResolvedValueOnce({ id: 'ad_123', creative: { creative_id: 'old_creative_123' } } as never)
            .mockResolvedValue({
              id: 'ad_123',
              creative: { creative_id: 'new_creative_456', object_story_spec: { link_data: { link: 'https://new.com' } } }
            } as never);

          const result = await agentModeService.updateMetaAdsAd('user123', 'ad_123', { link_url: 'https://new.com' });

          expect(sentCreative().image_hash).toBe('old_hash');
          expect(sentCreative().image_url).toBe('https://cdn/old.jpg');
          expect(result.success).toBe(true);
          // No image was requested, so the created creative is not re-read for its image.
          expect(metaService.getAdCreative).toHaveBeenCalledTimes(1);
        });

        it('carries the old link description and instagram_user_id over on a swap (ENG-2609)', async () => {
          const spec = { ...OLD_LINK_SPEC, instagram_user_id: 'ig_old', link_data: { ...OLD_LINK_SPEC.link_data, description: 'Old desc' } };
          mockSwap(spec, spec);

          await agentModeService.updateMetaAdsAd('user123', 'ad_123', { link_url: 'https://new.com' });

          expect(sentCreative().description).toBe('Old desc');
          expect(sentCreative().instagram_user_id).toBe('ig_old');
        });

        it('treats description / instagram_user_id as creative content: swaps and keeps them off the ad-level update (ENG-2609)', async () => {
          mockSwap(OLD_LINK_SPEC, OLD_LINK_SPEC);

          await agentModeService.updateMetaAdsAd('user123', 'ad_123', { description: 'New desc', instagram_user_id: 'ig_new' });

          expect(sentCreative().description).toBe('New desc');
          expect(sentCreative().instagram_user_id).toBe('ig_new');
          for (const call of jest.mocked(metaService.updateAd).mock.calls) {
            expect(call[2]).not.toHaveProperty('description');
            expect(call[2]).not.toHaveProperty('instagram_user_id');
          }
        });

        it('refuses a carousel description update before creating a creative (ENG-2609)', async () => {
          const carousel = { page_id: 'page_123', link_data: { message: 'm', link: 'https://old.com', child_attachments: [{ image_hash: 'a' }, { image_hash: 'b' }] } };
          mockSwap(carousel, carousel);
          jest.mocked(metaService.createAdCreative).mockClear();

          const result = await agentModeService.updateMetaAdsAd('user123', 'ad_123', { description: 'x' });

          expect(result.success).toBe(false);
          expect(result.error).toBe('CAROUSEL_DESCRIPTION_UNSUPPORTED');
          expect(metaService.createAdCreative).not.toHaveBeenCalled();
        });

        it('carries the asset_feed_spec description when only placement_assets change (ENG-2609)', async () => {
          mockSwap(OLD_LINK_SPEC, OLD_LINK_SPEC);
          jest.mocked(metaService.getAdCreative).mockReset().mockResolvedValue({
            id: 'old_creative_123', name: 'Old', object_story_spec: { page_id: 'page_123', link_data: { link: 'https://old.com' } },
            asset_feed_spec: { descriptions: [{ text: 'Feed desc' }] },
          } as never);

          await agentModeService.updateMetaAdsAd('user123', 'ad_123', { placement_assets: [{ image_hash: 'a', is_default: true }, { image_hash: 'b', placements: ['story'] }] });

          expect(sentCreative().description).toBe('Feed desc');
        });

        it('carries link, body, title and CTA from asset_feed_spec when swapping a placement creative (ENG-2623)', async () => {
          mockSwap(OLD_LINK_SPEC, OLD_LINK_SPEC);
          jest.mocked(metaService.getAdCreative).mockReset().mockResolvedValue({
            id: 'old_creative_123', name: 'Old', object_story_spec: { page_id: 'page_123' },
            asset_feed_spec: {
              bodies: [{ text: 'AFS body' }], titles: [{ text: 'AFS title' }],
              link_urls: [{ website_url: 'https://afs.example/' }], call_to_action_types: ['LEARN_MORE'],
            },
          } as never);

          await agentModeService.updateMetaAdsAd('user123', 'ad_123', { placement_assets: [{ image_hash: 'a', is_default: true }, { image_hash: 'b', placements: ['story'] }] });

          expect(sentCreative()).toEqual(expect.objectContaining({
            link_url: 'https://afs.example/', body: 'AFS body', title: 'AFS title', call_to_action_type: 'LEARN_MORE',
          }));
        });

        it('retries the attach while Meta still answers 1772103 for a just-created creative, but not other errors (ENG-2623)', async () => {
          mockSwap(OLD_LINK_SPEC, OLD_LINK_SPEC);
          const sleep = jest.spyOn(agentModeService as any, 'sleep').mockResolvedValue(undefined);
          const notReady = Object.assign(new Error('Invalid parameter'), { structuredError: { error_subcode: 1772103 } });
          jest.mocked(metaService.updateAd).mockRejectedValueOnce(notReady).mockRejectedValueOnce(notReady);

          const result = await agentModeService.updateMetaAdsAd('user123', 'ad_123', { title: 'New title' });

          expect(result.success).toBe(true);
          expect(attachCalls().length).toBeGreaterThanOrEqual(3);
          expect(sleep).toHaveBeenCalledWith(30_000);

          jest.mocked(metaService.updateAd).mockReset();
          mockSwap(OLD_LINK_SPEC, OLD_LINK_SPEC);
          sleep.mockClear();
          jest.mocked(metaService.updateAd).mockRejectedValueOnce(new Error('Permissions error'));
          const other = await agentModeService.updateMetaAdsAd('user123', 'ad_123', { title: 'New title' });
          expect(other.success).toBe(false);
          expect(sleep).not.toHaveBeenCalledWith(30_000);
          sleep.mockRestore();
        });

        it('fails with SWAP_NOT_REFLECTED and does not attach when the new creative still has the old image', async () => {
          mockSwap(OLD_LINK_SPEC, OLD_LINK_SPEC);

          const result = await agentModeService.updateMetaAdsAd('user123', 'ad_123', { image_url: 'https://cdn/new.jpg' });

          expect(result.success).toBe(false);
          expect(result.error).toBe('SWAP_NOT_REFLECTED');
          expect(result.live_image_hash).toBe('old_hash');
          expect(result.new_creative_id).toBe('new_creative_456');
          expect(attachCalls()).toHaveLength(0);
        });

        it('fails with SWAP_NOT_REFLECTED when a hash-less read-back still shows the old picture URL', async () => {
          mockSwap(OLD_LINK_SPEC, { page_id: 'page_123', link_data: { picture: 'https://cdn/old.jpg' } });

          const result = await agentModeService.updateMetaAdsAd('user123', 'ad_123', { image_url: 'https://cdn/new.jpg' });

          expect(result.success).toBe(false);
          expect(result.error).toBe('SWAP_NOT_REFLECTED');
          expect(result.live_image_url).toBe('https://cdn/old.jpg');
          expect(attachCalls()).toHaveLength(0);
        });

        it('attaches but reports image_verified:false when the read-back identifies no image', async () => {
          mockSwap(OLD_LINK_SPEC, { page_id: 'page_123', link_data: { link: 'https://old.com' } });

          const result = await agentModeService.updateMetaAdsAd('user123', 'ad_123', { image_url: 'https://cdn/new.jpg' });

          expect(result.success).toBe(true);
          expect(result.image_verified).toBe(false);
          expect(result.message).toContain('image could not be confirmed');
          expect(attachCalls()).toHaveLength(1);
        });

        it('fails with SWAP_NOT_REFLECTED when the new creative does not carry the requested image_hash', async () => {
          mockSwap(OLD_VIDEO_SPEC, { page_id: 'page_123', video_data: { video_id: 'vid_1', image_hash: 'other_hash' } });

          const result = await agentModeService.updateMetaAdsAd('user123', 'ad_123', { image_hash: 'new_thumb_hash' });

          expect(result.success).toBe(false);
          expect(result.error).toBe('SWAP_NOT_REFLECTED');
          expect(result.requested_image_hash).toBe('new_thumb_hash');
          expect(result.live_image_hash).toBe('other_hash');
          expect(attachCalls()).toHaveLength(0);
        });
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
          { creative: { creative_id: 'new_placement_creative' } },
          '123456789'
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

      it('carries link description and instagram_user_id from the source creative (ENG-2609)', async () => {
        (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
        (metaService.getAd as jest.Mock).mockResolvedValue({ id: 'src_ad', name: 'Source Ad', adset_id: 'as_1', creative: { creative_id: 'src_creative' } });
        (metaService.getAdCreative as jest.Mock).mockResolvedValue({
          id: 'src_creative', name: 'Source Creative',
          object_story_spec: {
            page_id: 'page_123', instagram_user_id: 'ig_src',
            link_data: { message: 'Hi', link: 'https://src.com', name: 'T', image_hash: 'abc', description: 'Line under headline' },
          },
        });
        (metaService.createAdCreative as jest.Mock).mockResolvedValue({ id: 'copy_creative' });
        (metaService.createAd as jest.Mock).mockResolvedValue({ id: 'copy_ad' });

        await agentModeService.copyMetaAdsAd('user123', 'src_ad', {});

        expect(metaService.createAdCreative).toHaveBeenCalledWith('123456789', 'mock-access-token',
          expect.objectContaining({ description: 'Line under headline', instagram_user_id: 'ig_src' }));
      });

      it('carries the video link_description, and only the instagram id for a carousel (ENG-2609)', async () => {
        (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
        (metaService.getAd as jest.Mock).mockResolvedValue({ id: 'src_ad', name: 'Source Ad', adset_id: 'as_1', creative: { creative_id: 'src_creative' } });
        (metaService.createAdCreative as jest.Mock).mockResolvedValue({ id: 'copy_creative' });
        (metaService.createAd as jest.Mock).mockResolvedValue({ id: 'copy_ad' });

        (metaService.getAdCreative as jest.Mock).mockResolvedValueOnce({
          id: 'src_creative', name: 'V',
          object_story_spec: { page_id: 'page_123', instagram_user_id: 'ig_src',
            video_data: { video_id: 'v1', image_hash: 'h', link_description: 'Vid desc' } },
        });
        await agentModeService.copyMetaAdsAd('user123', 'src_ad', {});
        expect(metaService.createAdCreative).toHaveBeenLastCalledWith('123456789', 'mock-access-token',
          expect.objectContaining({ video_id: 'v1', description: 'Vid desc', instagram_user_id: 'ig_src' }));

        (metaService.getAdCreative as jest.Mock).mockResolvedValueOnce({
          id: 'src_creative', name: 'C',
          object_story_spec: { page_id: 'page_123', instagram_user_id: 'ig_src',
            link_data: { message: 'm', link: 'https://src.com', description: 'ignored', child_attachments: [{ image_hash: 'a' }, { image_hash: 'b' }] } },
        });
        await agentModeService.copyMetaAdsAd('user123', 'src_ad', {});
        const carouselArg = (metaService.createAdCreative as jest.Mock).mock.calls.at(-1)![2];
        expect(carouselArg.instagram_user_id).toBe('ig_src');
        expect(carouselArg).not.toHaveProperty('description');
      });
    });

    describe('deleteMetaAdsAd', () => {
      it('should successfully delete an ad', async () => {
        (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
        (metaService.deleteAd as jest.Mock).mockResolvedValue({ success: true });
        (metaService.getAd as jest.Mock).mockResolvedValue({ id: 'ad_123', status: 'DELETED' }); // ENG-3065 read-back

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

      it('reports an error rather than alreadyTagged when a destination link is unparseable (Greptile)', async () => {
        // computeRetagUrlTags returns changed:false for BOTH "genuinely already
        // tagged" and "a link URL couldn't be read" -- collapsing them into the
        // same alreadyTagged:true response would give an operator false
        // confirmation that a malformed-destination ad is fully covered.
        (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
        (metaService.getAd as jest.Mock).mockResolvedValue({ id: 'ad_123', creative: { creative_id: 'creative_1' } });
        (metaService.getAdCreative as jest.Mock).mockResolvedValue({
          id: 'creative_1',
          object_story_spec: { page_id: 'page_1', link_data: { link: 'not a url' } },
        });

        const result = await agentModeService.retagMetaAdUtm('user123', 'ad_123');

        expect(result.success).toBe(false);
        expect((result as any).alreadyTagged).toBeUndefined();
        expect(metaService.createAdCreative).not.toHaveBeenCalled();
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
          expect.objectContaining({ daily_budget: 15000 }),
          '123456789'
        );
        const call = (metaService.updateCampaign as jest.Mock).mock.calls[0][2];
        expect(call.budget_amount).toBeUndefined();
      });

      it('should not modify params without budget_amount', async () => {
        (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
        (metaService.updateCampaign as jest.Mock).mockResolvedValue({ success: true });
        (metaService.getCampaign as jest.Mock).mockResolvedValue({ id: 'camp_123', name: 'New Name', status: 'PAUSED' }); // ENG-3065 read-back

        await agentModeService.updateMetaAdsCampaign('user123', 'camp_123', { name: 'New Name', status: 'PAUSED' });

        expect(metaService.updateCampaign).toHaveBeenCalledWith(
          'mock-access-token',
          'camp_123',
          expect.objectContaining({ name: 'New Name', status: 'PAUSED' }),
          '123456789'
        );
      });

      it('should return success after updating campaign', async () => {
        (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
        (metaService.updateCampaign as jest.Mock).mockResolvedValue({ success: true });
        (metaService.getCampaign as jest.Mock).mockResolvedValue({ id: 'camp_123', status: 'PAUSED' }); // ENG-3065 read-back

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
