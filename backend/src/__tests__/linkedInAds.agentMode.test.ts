/**
 * Tests for LinkedIn Ads methods in AgentModeService:
 *   - getLinkedInAdsCredentials (private)
 *   - callLinkedInMarketingApi
 *   - callLinkedInAdsInsightsApi
 */

jest.mock('../mcp/client/mcpClientService', () => ({
  McpClientService: jest.fn().mockImplementation(() => ({ isReady: jest.fn().mockReturnValue(true) })),
}));

jest.mock('../services/linkedInAdsService', () => ({
  // resolveTargetingCriteria is a pure param-shaping helper — use the real implementation
  // so the dispatcher's targeting resolution is exercised end-to-end.
  resolveTargetingCriteria: jest.requireActual('../services/linkedInAdsService').resolveTargetingCriteria,
  refreshAccessToken: jest.fn(),
  listAdAccounts: jest.fn(),
  listCampaignGroups: jest.fn(),
  createCampaignGroup: jest.fn(),
  updateCampaignGroup: jest.fn(),
  listCampaigns: jest.fn(),
  createCampaign: jest.fn(),
  updateCampaign: jest.fn(),
  createCreative: jest.fn(),
  createCreativeInline: jest.fn(),
  createDynamicCreative: jest.fn(),
  listCreatives: jest.fn(),
  createPost: jest.fn(),
  listTargetingFacets: jest.fn(),
  searchTargetingEntities: jest.fn(),
  getAudienceCount: jest.fn(),
  initializeImageUpload: jest.fn(),
  uploadImageBinary: jest.fn(),
  initializeVideoUpload: jest.fn(),
  uploadVideoPart: jest.fn(),
  finalizeVideoUpload: jest.fn(),
  initializeDocumentUpload: jest.fn(),
  uploadDocumentBinary: jest.fn(),
  getAdAnalytics: jest.fn(),
  createInMailContent: jest.fn(),
  sendTestInMail: jest.fn(),
  createConversationAd: jest.fn(),
  createConversationAdContent: jest.fn(),
  setConversationAdFirstContent: jest.fn(),
}));

jest.mock('../services/db', () => ({ userDb: { getUserById: jest.fn() } }));

jest.mock('../config/integrations', () => ({
  // INTEGRATION_CONFIG is read at module-load time by linkedInAdsService (via requireActual below)
  INTEGRATION_CONFIG: {
    linkedinAds: { apiVersion: '202603', tokenUrl: 'https://www.linkedin.com/oauth/v2/accessToken' },
  },
  getLinkedInAdsConfig: jest.fn().mockResolvedValue({
    clientId: 'test-client-id',
    clientSecret: 'test-client-secret',
    tokenUrl: 'https://www.linkedin.com/oauth/v2/accessToken',
  }),
}));

jest.mock('../services/connectedAccountsDb', () => ({
  updateAccountTokens: jest.fn().mockResolvedValue(undefined),
  // getLinkedInAdsCredentials now sources accounts via the org-aware helper. The mock
  // delegates to the same userDb.getUserById the tests already drive, tagging each
  // account with the caller's userId (the owner, for these single-user scenarios).
  getAccountsWithOwnerIncludingOrgShared: jest.fn(async (userId: string) => {
    const { userDb } = require('../services/db');
    const user = await userDb.getUserById(userId);
    if (!user) return [];
    const accounts = Array.isArray(user.connected_accounts) ? user.connected_accounts : [];
    return accounts.map((a: any) => ({ ...a, userId }));
  }),
}));

import { AgentModeService } from '../services/agentModeService';
import * as linkedInAdsService from '../services/linkedInAdsService';
import { userDb } from '../services/db';

const USER_ID = 'user-123';
const ACCOUNT_ID = 'urn:li:sponsoredAccount:987654321';
const NUMERIC_ACCOUNT_ID = '987654321';
const ACCESS_TOKEN = 'li-access-token';

const ORG_URN = 'urn:li:organization:test-org';
const PERSON_URN = 'urn:li:person:test-person';

const makeUser = (overrides: any = {}) => ({
  id: USER_ID,
  connected_accounts: [
    {
      platform: 'linkedin_ads',
      account_id: ACCOUNT_ID,
      account_name: 'Test LI Ads',
      config: {
        account_type: 'ad_account',
        access_token: ACCESS_TOKEN,
        refresh_token: 'li-refresh-token',
        token_expires_at: Date.now() + 60 * 60 * 1000, // 1 hour from now
        currency: 'USD',
        status: 'ACTIVE',
        organization_urn: ORG_URN,
        person_urn: PERSON_URN,
      },
    },
  ],
  ...overrides,
});

let service: AgentModeService;

beforeEach(() => {
  jest.clearAllMocks();
  (userDb.getUserById as jest.Mock).mockResolvedValue(makeUser());
  (linkedInAdsService.listAdAccounts as jest.Mock).mockResolvedValue({ success: true, data: { elements: [{ id: ACCOUNT_ID }] } });
  (linkedInAdsService.listCampaignGroups as jest.Mock).mockResolvedValue({ success: true, data: { elements: [] } });
  (linkedInAdsService.createCampaignGroup as jest.Mock).mockResolvedValue({ success: true, data: { id: 'cg-1' } });
  (linkedInAdsService.updateCampaignGroup as jest.Mock).mockResolvedValue({ success: true, data: {} });
  (linkedInAdsService.listCampaigns as jest.Mock).mockResolvedValue({ success: true, data: { elements: [] } });
  (linkedInAdsService.createCampaign as jest.Mock).mockResolvedValue({ success: true, data: { id: 'camp-1' } });
  (linkedInAdsService.updateCampaign as jest.Mock).mockResolvedValue({ success: true, data: {} });
  (linkedInAdsService.listCreatives as jest.Mock).mockResolvedValue({ success: true, data: { elements: [] } });
  (linkedInAdsService.createCreative as jest.Mock).mockResolvedValue({ success: true, data: { id: 'cr-1' } });
  (linkedInAdsService.createPost as jest.Mock).mockResolvedValue({ success: true, data: { id: 'post-1' } });
  (linkedInAdsService.listTargetingFacets as jest.Mock).mockResolvedValue({ success: true, data: { elements: [] } });
  (linkedInAdsService.searchTargetingEntities as jest.Mock).mockResolvedValue({ success: true, data: { elements: [] } });
  (linkedInAdsService.getAudienceCount as jest.Mock).mockResolvedValue({ success: true, data: { count: 50000 } });
  (linkedInAdsService.initializeImageUpload as jest.Mock).mockResolvedValue({ success: true, data: { value: { uploadUrl: 'https://upload.example.com', image: 'urn:li:image:img-1' } } });
  (linkedInAdsService.uploadImageBinary as jest.Mock).mockResolvedValue(undefined);
  (linkedInAdsService.initializeVideoUpload as jest.Mock).mockResolvedValue({ success: true, data: { uploadToken: 'tok' } });
  (linkedInAdsService.finalizeVideoUpload as jest.Mock).mockResolvedValue({ success: true, data: {} });
  (linkedInAdsService.getAdAnalytics as jest.Mock).mockResolvedValue({ success: true, data: { elements: [{ impressions: 1000 }] } });
  (linkedInAdsService.createCreativeInline as jest.Mock).mockResolvedValue({ success: true, data: { id: 'cr-inline-1' } });
  (linkedInAdsService.createDynamicCreative as jest.Mock).mockResolvedValue({ success: true, data: { id: 'cr-dynamic-1' } });
  (linkedInAdsService.createInMailContent as jest.Mock).mockResolvedValue({ success: true, data: { id: 'urn:li:inMailContent:123' } });
  (linkedInAdsService.sendTestInMail as jest.Mock).mockResolvedValue({ success: true, data: {} });
  (linkedInAdsService.initializeVideoUpload as jest.Mock).mockResolvedValue({ success: true, data: { value: { uploadInstructions: [{ uploadUrl: 'https://video-upload.example.com', firstByte: 0, lastByte: 99 }], video: 'urn:li:video:vid-1' } } });
  (linkedInAdsService.uploadVideoPart as jest.Mock).mockResolvedValue('etag-part-1');
  (linkedInAdsService.finalizeVideoUpload as jest.Mock).mockResolvedValue({ success: true, data: {} });
  (linkedInAdsService.initializeDocumentUpload as jest.Mock).mockResolvedValue({ success: true, data: { value: { uploadUrl: 'https://doc-upload.example.com', document: 'urn:li:document:doc-1' } } });
  (linkedInAdsService.uploadDocumentBinary as jest.Mock).mockResolvedValue(undefined);
  (linkedInAdsService.createConversationAd as jest.Mock).mockResolvedValue({ success: true, data: { id: 'urn:li:conversationAd:ca-1' } });
  (linkedInAdsService.createConversationAdContent as jest.Mock).mockResolvedValue({ success: true, data: { id: 'urn:li:conversationAdContent:cc-1' } });
  (linkedInAdsService.setConversationAdFirstContent as jest.Mock).mockResolvedValue({ success: true, data: {} });

  service = new AgentModeService();
});

// ── Credential retrieval ──────────────────────────────────────────────────────

describe('getLinkedInAdsCredentials (via callLinkedInMarketingApi)', () => {
  it('throws when user has no linkedin_ads accounts', async () => {
    (userDb.getUserById as jest.Mock).mockResolvedValue({ id: USER_ID, connected_accounts: [] });
    await expect(
      service.callLinkedInMarketingApi(USER_ID, 'AD_ACCOUNT', 'LIST', ACCOUNT_ID)
    ).rejects.toThrow('LinkedIn Ads account not connected');
  });

  it('throws when user not found (no accessible accounts)', async () => {
    // Credentials now resolve via the org-aware helper, which returns an empty
    // list when the user doesn't exist — so this surfaces as "not connected".
    (userDb.getUserById as jest.Mock).mockResolvedValue(null);
    await expect(
      service.callLinkedInMarketingApi(USER_ID, 'AD_ACCOUNT', 'LIST', ACCOUNT_ID)
    ).rejects.toThrow('LinkedIn Ads account not connected');
  });

  it('throws when specified account_id not found', async () => {
    await expect(
      service.callLinkedInMarketingApi(USER_ID, 'AD_ACCOUNT', 'LIST', 'non-existent-account')
    ).rejects.toThrow('not found');
  });

  it('throws when multiple accounts and no account_id specified', async () => {
    (userDb.getUserById as jest.Mock).mockResolvedValue({
      id: USER_ID,
      connected_accounts: [
        { platform: 'linkedin_ads', account_id: 'acc-1', account_name: 'Acc 1', config: { account_type: 'ad_account', access_token: 'tok1', token_expires_at: Date.now() + 3600000 } },
        { platform: 'linkedin_ads', account_id: 'acc-2', account_name: 'Acc 2', config: { account_type: 'ad_account', access_token: 'tok2', token_expires_at: Date.now() + 3600000 } },
      ],
    });
    await expect(
      service.callLinkedInMarketingApi(USER_ID, 'AD_ACCOUNT', 'LIST', '')
    ).rejects.toThrow('Multiple LinkedIn Ads accounts found');
  });

  it('refreshes token when expired', async () => {
    (userDb.getUserById as jest.Mock).mockResolvedValue(makeUser({
      connected_accounts: [{
        platform: 'linkedin_ads',
        account_id: ACCOUNT_ID,
        account_name: 'Test LI Ads',
        config: {
          account_type: 'ad_account',
          access_token: 'old-token',
          refresh_token: 'li-refresh',
          token_expires_at: Date.now() - 1000, // expired
        },
      }],
    }));
    (linkedInAdsService.refreshAccessToken as jest.Mock).mockResolvedValue({
      access_token: 'new-token',
      refresh_token: 'new-refresh',
      expires_in: 5183944,
    });

    await service.callLinkedInMarketingApi(USER_ID, 'AD_ACCOUNT', 'LIST', ACCOUNT_ID);

    expect(linkedInAdsService.refreshAccessToken).toHaveBeenCalledWith('li-refresh', 'test-client-id', 'test-client-secret');
    expect(linkedInAdsService.listAdAccounts).toHaveBeenCalledWith('new-token');
  });

  it('throws when token expired and no refresh_token', async () => {
    (userDb.getUserById as jest.Mock).mockResolvedValue(makeUser({
      connected_accounts: [{
        platform: 'linkedin_ads',
        account_id: ACCOUNT_ID,
        account_name: 'Test',
        config: { account_type: 'ad_account', access_token: 'old', token_expires_at: Date.now() - 1000 },
      }],
    }));
    await expect(
      service.callLinkedInMarketingApi(USER_ID, 'AD_ACCOUNT', 'LIST', ACCOUNT_ID)
    ).rejects.toThrow('no refresh token');
  });
});

// ── callLinkedInMarketingApi — AD_ACCOUNT ────────────────────────────────────

describe('callLinkedInMarketingApi — AD_ACCOUNT', () => {
  it('LIST calls listAdAccounts with access token', async () => {
    const result = await service.callLinkedInMarketingApi(USER_ID, 'AD_ACCOUNT', 'LIST', ACCOUNT_ID);
    expect(linkedInAdsService.listAdAccounts).toHaveBeenCalledWith(ACCESS_TOKEN);
    expect(result.success).toBe(true);
    expect(result.adAccounts).toBeDefined();
  });

  it('throws on unknown action', async () => {
    await expect(
      service.callLinkedInMarketingApi(USER_ID, 'AD_ACCOUNT', 'CREATE', ACCOUNT_ID)
    ).rejects.toThrow('Unknown action');
  });
});

// ── callLinkedInMarketingApi — CAMPAIGN_GROUP ────────────────────────────────

describe('callLinkedInMarketingApi — CAMPAIGN_GROUP', () => {
  it('LIST calls listCampaignGroups', async () => {
    const result = await service.callLinkedInMarketingApi(USER_ID, 'CAMPAIGN_GROUP', 'LIST', ACCOUNT_ID);
    expect(linkedInAdsService.listCampaignGroups).toHaveBeenCalledWith(ACCESS_TOKEN, ACCOUNT_ID, {});
    expect(result.success).toBe(true);
  });

  it('CREATE calls createCampaignGroup', async () => {
    const result = await service.callLinkedInMarketingApi(USER_ID, 'CAMPAIGN_GROUP', 'CREATE', ACCOUNT_ID, { name: 'My Group' });
    expect(linkedInAdsService.createCampaignGroup).toHaveBeenCalledWith(ACCESS_TOKEN, ACCOUNT_ID, { name: 'My Group' });
    expect(result.success).toBe(true);
  });

  it('UPDATE calls updateCampaignGroup with correct args', async () => {
    const result = await service.callLinkedInMarketingApi(USER_ID, 'CAMPAIGN_GROUP', 'UPDATE', ACCOUNT_ID, {
      campaign_group_id: 'cg-99',
      status: 'PAUSED',
    });
    expect(linkedInAdsService.updateCampaignGroup).toHaveBeenCalledWith(
      ACCESS_TOKEN,
      ACCOUNT_ID,
      'cg-99',
      expect.objectContaining({ status: 'PAUSED' })
    );
    expect(result.success).toBe(true);
  });

  it('UPDATE throws when campaign_group_id missing', async () => {
    await expect(
      service.callLinkedInMarketingApi(USER_ID, 'CAMPAIGN_GROUP', 'UPDATE', ACCOUNT_ID, {})
    ).rejects.toThrow('campaign_group_id');
  });
});

// ── callLinkedInMarketingApi — CAMPAIGN ──────────────────────────────────────

describe('callLinkedInMarketingApi — CAMPAIGN', () => {
  it('LIST calls listCampaigns', async () => {
    await service.callLinkedInMarketingApi(USER_ID, 'CAMPAIGN', 'LIST', ACCOUNT_ID);
    expect(linkedInAdsService.listCampaigns).toHaveBeenCalledWith(ACCESS_TOKEN, ACCOUNT_ID, {});
  });

  it('CREATE calls createCampaign', async () => {
    await service.callLinkedInMarketingApi(USER_ID, 'CAMPAIGN', 'CREATE', ACCOUNT_ID, { name: 'Camp' });
    expect(linkedInAdsService.createCampaign).toHaveBeenCalledWith(ACCESS_TOKEN, ACCOUNT_ID, { name: 'Camp' });
  });

  it('UPDATE calls updateCampaign with account and campaign id', async () => {
    await service.callLinkedInMarketingApi(USER_ID, 'CAMPAIGN', 'UPDATE', ACCOUNT_ID, {
      campaign_id: 'camp-55',
      status: 'PAUSED',
    });
    expect(linkedInAdsService.updateCampaign).toHaveBeenCalledWith(
      ACCESS_TOKEN,
      ACCOUNT_ID,
      'camp-55',
      expect.any(Object)
    );
  });

  it('UPDATE throws when campaign_id missing', async () => {
    await expect(
      service.callLinkedInMarketingApi(USER_ID, 'CAMPAIGN', 'UPDATE', ACCOUNT_ID, {})
    ).rejects.toThrow('campaign_id');
  });
});

// ── callLinkedInMarketingApi — CREATIVE ──────────────────────────────────────

describe('callLinkedInMarketingApi — CREATIVE', () => {
  it('LIST throws when campaign_id missing', async () => {
    await expect(
      service.callLinkedInMarketingApi(USER_ID, 'CREATIVE', 'LIST', ACCOUNT_ID, {})
    ).rejects.toThrow('campaign_id');
  });

  it('LIST calls listCreatives with accountId and campaign_id', async () => {
    await service.callLinkedInMarketingApi(USER_ID, 'CREATIVE', 'LIST', ACCOUNT_ID, { campaign_id: 'camp-1' });
    expect(linkedInAdsService.listCreatives).toHaveBeenCalledWith(ACCESS_TOKEN, ACCOUNT_ID, 'camp-1');
  });

  it('CREATE calls createCreative passing full params', async () => {
    await service.callLinkedInMarketingApi(USER_ID, 'CREATIVE', 'CREATE', ACCOUNT_ID, {
      campaign_id: 'camp-1',
      post_urn: 'urn:li:share:999',
    });
    expect(linkedInAdsService.createCreative).toHaveBeenCalledWith(
      ACCESS_TOKEN,
      expect.objectContaining({ campaign_id: 'camp-1', post_urn: 'urn:li:share:999' })
    );
  });

  it('CREATE_INLINE calls createCreativeInline with organizationUrn as author_urn', async () => {
    const result = await service.callLinkedInMarketingApi(USER_ID, 'CREATIVE', 'CREATE_INLINE', ACCOUNT_ID, {
      campaign_id: 'camp-1',
      commentary: 'Ad copy',
    });
    expect(linkedInAdsService.createCreativeInline).toHaveBeenCalledWith(
      ACCESS_TOKEN,
      expect.objectContaining({
        campaign_id: 'camp-1',
        ad_account_id: ACCOUNT_ID,
        author_urn: ORG_URN,
      })
    );
    expect(result.success).toBe(true);
  });

  it('CREATE_INLINE throws when campaign_id missing', async () => {
    await expect(
      service.callLinkedInMarketingApi(USER_ID, 'CREATIVE', 'CREATE_INLINE', ACCOUNT_ID, {})
    ).rejects.toThrow('campaign_id');
  });

  it('CREATE_INLINE throws when organization URN not in account config', async () => {
    (userDb.getUserById as jest.Mock).mockResolvedValue({
      id: USER_ID,
      connected_accounts: [{
        platform: 'linkedin_ads',
        account_id: ACCOUNT_ID,
        account_name: 'Test',
        config: { account_type: 'ad_account', access_token: ACCESS_TOKEN, token_expires_at: Date.now() + 3600000 },
      }],
    });
    await expect(
      service.callLinkedInMarketingApi(USER_ID, 'CREATIVE', 'CREATE_INLINE', ACCOUNT_ID, { campaign_id: 'camp-1' })
    ).rejects.toThrow('organization URN');
  });
});

// ── callLinkedInMarketingApi — POST ──────────────────────────────────────────

describe('callLinkedInMarketingApi — POST', () => {
  it('CREATE calls createPost with organizationUrn as author_urn', async () => {
    const result = await service.callLinkedInMarketingApi(USER_ID, 'POST', 'CREATE', ACCOUNT_ID, {
      commentary: 'Hello',
    });
    expect(linkedInAdsService.createPost).toHaveBeenCalledWith(
      ACCESS_TOKEN,
      expect.objectContaining({ author_urn: ORG_URN, ad_account_id: ACCOUNT_ID })
    );
    expect(result.success).toBe(true);
    expect(result.post_urn).toBe('post-1');
  });

  it('CREATE throws when organization URN not in account config', async () => {
    (userDb.getUserById as jest.Mock).mockResolvedValue({
      id: USER_ID,
      connected_accounts: [{
        platform: 'linkedin_ads',
        account_id: ACCOUNT_ID,
        account_name: 'Test',
        config: { account_type: 'ad_account', access_token: ACCESS_TOKEN, token_expires_at: Date.now() + 3600000 },
      }],
    });
    await expect(
      service.callLinkedInMarketingApi(USER_ID, 'POST', 'CREATE', ACCOUNT_ID, { commentary: 'Hi' })
    ).rejects.toThrow('author_urn');
  });
});

// ── callLinkedInMarketingApi — TARGETING ─────────────────────────────────────

describe('callLinkedInMarketingApi — TARGETING', () => {
  it('LIST_FACETS calls listTargetingFacets', async () => {
    await service.callLinkedInMarketingApi(USER_ID, 'TARGETING', 'LIST_FACETS', ACCOUNT_ID);
    expect(linkedInAdsService.listTargetingFacets).toHaveBeenCalledWith(ACCESS_TOKEN);
  });

  it('SEARCH calls searchTargetingEntities with facet_urn', async () => {
    await service.callLinkedInMarketingApi(USER_ID, 'TARGETING', 'SEARCH', ACCOUNT_ID, {
      facet: 'urn:li:adTargetingFacet:locations',
      query: 'New York',
    });
    expect(linkedInAdsService.searchTargetingEntities).toHaveBeenCalledWith(
      ACCESS_TOKEN,
      { facet_urn: 'urn:li:adTargetingFacet:locations', query: 'New York' }
    );
  });

  it('SEARCH throws when facet is missing', async () => {
    await expect(
      service.callLinkedInMarketingApi(USER_ID, 'TARGETING', 'SEARCH', ACCOUNT_ID, {})
    ).rejects.toThrow('facet');
  });

  it('ESTIMATE_REACH calls getAudienceCount with a raw targeting_criteria object', async () => {
    await service.callLinkedInMarketingApi(USER_ID, 'TARGETING', 'ESTIMATE_REACH', ACCOUNT_ID, {
      targeting_criteria: { include: { and: [{ or: { 'urn:li:adTargetingFacet:locations': ['urn:li:geo:1'] } }] } },
    });
    expect(linkedInAdsService.getAudienceCount).toHaveBeenCalledWith(
      ACCESS_TOKEN,
      { include: { and: [{ or: { 'urn:li:adTargetingFacet:locations': ['urn:li:geo:1'] } }] } }
    );
  });

  it('ESTIMATE_REACH accepts the same targeting_include array shape as CAMPAIGN CREATE', async () => {
    await service.callLinkedInMarketingApi(USER_ID, 'TARGETING', 'ESTIMATE_REACH', ACCOUNT_ID, {
      targeting_include: [
        { facet_urn: 'urn:li:adTargetingFacet:locations', values: ['urn:li:geo:103644278'] },
        { facet_urn: 'urn:li:adTargetingFacet:titles', values: ['urn:li:title:68'] },
      ],
    });
    expect(linkedInAdsService.getAudienceCount).toHaveBeenCalledWith(
      ACCESS_TOKEN,
      {
        include: {
          and: [
            { or: { 'urn:li:adTargetingFacet:locations': ['urn:li:geo:103644278'] } },
            { or: { 'urn:li:adTargetingFacet:titles': ['urn:li:title:68'] } },
          ],
        },
      }
    );
  });

  it('ESTIMATE_REACH applies targeting_exclude alongside targeting_include', async () => {
    await service.callLinkedInMarketingApi(USER_ID, 'TARGETING', 'ESTIMATE_REACH', ACCOUNT_ID, {
      targeting_include: [{ facet_urn: 'urn:li:adTargetingFacet:locations', values: ['urn:li:geo:103644278'] }],
      targeting_exclude: [{ facet_urn: 'urn:li:adTargetingFacet:seniorities', values: ['urn:li:seniority:1'] }],
    });
    const passed = (linkedInAdsService.getAudienceCount as jest.Mock).mock.calls[0][1];
    expect(passed.exclude).toEqual({ or: { 'urn:li:adTargetingFacet:seniorities': ['urn:li:seniority:1'] } });
  });

  it('ESTIMATE_REACH throws when no targeting is provided', async () => {
    await expect(
      service.callLinkedInMarketingApi(USER_ID, 'TARGETING', 'ESTIMATE_REACH', ACCOUNT_ID, {})
    ).rejects.toThrow(/targeting/i);
  });
});

// ── callLinkedInMarketingApi — MEDIA ─────────────────────────────────────────

describe('callLinkedInMarketingApi — MEDIA', () => {
  it('INIT_IMAGE_UPLOAD calls initializeImageUpload with organizationUrn', async () => {
    await service.callLinkedInMarketingApi(USER_ID, 'MEDIA', 'INIT_IMAGE_UPLOAD', ACCOUNT_ID, {});
    expect(linkedInAdsService.initializeImageUpload).toHaveBeenCalledWith(ACCESS_TOKEN, ORG_URN);
  });

  it('INIT_IMAGE_UPLOAD falls back to account URN when no organizationUrn', async () => {
    (userDb.getUserById as jest.Mock).mockResolvedValue({
      id: USER_ID,
      connected_accounts: [{
        platform: 'linkedin_ads',
        account_id: ACCOUNT_ID,
        account_name: 'Test',
        config: { account_type: 'ad_account', access_token: ACCESS_TOKEN, token_expires_at: Date.now() + 3600000 },
      }],
    });
    await service.callLinkedInMarketingApi(USER_ID, 'MEDIA', 'INIT_IMAGE_UPLOAD', ACCOUNT_ID, {});
    expect(linkedInAdsService.initializeImageUpload).toHaveBeenCalledWith(
      ACCESS_TOKEN,
      `urn:li:sponsoredAccount:${ACCOUNT_ID}`
    );
  });

  it('UPLOAD_IMAGE downloads and uploads image, returns image_urn', async () => {
    const mockAxios = require('axios');
    mockAxios.get = jest.fn().mockResolvedValue({
      data: Buffer.from('image-bytes'),
      headers: { 'content-type': 'image/png' },
    });
    const result = await service.callLinkedInMarketingApi(USER_ID, 'MEDIA', 'UPLOAD_IMAGE', ACCOUNT_ID, {
      image_url: 'https://example.com/image.png',
    });
    expect(linkedInAdsService.initializeImageUpload).toHaveBeenCalledWith(ACCESS_TOKEN, ORG_URN);
    expect(linkedInAdsService.uploadImageBinary).toHaveBeenCalledWith(
      'https://upload.example.com',
      expect.any(Buffer),
      'image/png'
    );
    expect(result.success).toBe(true);
    expect(result.image_urn).toBe('urn:li:image:img-1');
  });

  it('UPLOAD_IMAGE throws when image_url missing', async () => {
    await expect(
      service.callLinkedInMarketingApi(USER_ID, 'MEDIA', 'UPLOAD_IMAGE', ACCOUNT_ID, {})
    ).rejects.toThrow('image_url');
  });

  it('INIT_VIDEO_UPLOAD calls initializeVideoUpload with organizationUrn', async () => {
    await service.callLinkedInMarketingApi(USER_ID, 'MEDIA', 'INIT_VIDEO_UPLOAD', ACCOUNT_ID, {
      file_size: 10485760,
    });
    expect(linkedInAdsService.initializeVideoUpload).toHaveBeenCalledWith(ACCESS_TOKEN, ORG_URN, 10485760);
  });

  it('FINALIZE_VIDEO calls finalizeVideoUpload', async () => {
    await service.callLinkedInMarketingApi(USER_ID, 'MEDIA', 'FINALIZE_VIDEO', ACCOUNT_ID, {
      video_urn: 'urn:li:video:123',
    });
    // Legacy FINALIZE_VIDEO passes video_urn only; uploadToken and uploadedPartIds use defaults
    expect(linkedInAdsService.finalizeVideoUpload).toHaveBeenCalledWith(ACCESS_TOKEN, 'urn:li:video:123');
  });
});

// ── callLinkedInMarketingApi — invalid entity_type ───────────────────────────

describe('callLinkedInMarketingApi — invalid entity_type', () => {
  it('throws on unknown entity_type', async () => {
    await expect(
      (service as any).callLinkedInMarketingApi(USER_ID, 'UNKNOWN_ENTITY', 'LIST', ACCOUNT_ID)
    ).rejects.toThrow('Invalid entity_type');
  });
});

// ── callLinkedInMarketingApi — INMAIL ─────────────────────────────────────────

describe('callLinkedInMarketingApi — INMAIL', () => {
  it('CREATE_CONTENT calls createInMailContent with personUrn as sender', async () => {
    const result = await service.callLinkedInMarketingApi(USER_ID, 'INMAIL', 'CREATE_CONTENT', ACCOUNT_ID, {
      name: 'Test InMail',
      subject: 'Hello',
      htmlBody: '<p>Hi</p>',
      callToActionText: 'Learn More',
      callToActionLandingPageUrl: 'https://example.com',
    });
    expect(linkedInAdsService.createInMailContent).toHaveBeenCalledWith(
      ACCESS_TOKEN,
      expect.objectContaining({
        sender: PERSON_URN,
        ad_account_id: ACCOUNT_ID,
        subject: 'Hello',
      })
    );
    expect(result.success).toBe(true);
    expect(result.inmail_content_urn).toBe('urn:li:inMailContent:123');
  });

  it('CREATE_CONTENT throws when no sender and no person_urn in config', async () => {
    (userDb.getUserById as jest.Mock).mockResolvedValue({
      id: USER_ID,
      connected_accounts: [{
        platform: 'linkedin_ads',
        account_id: ACCOUNT_ID,
        account_name: 'Test',
        config: { account_type: 'ad_account', access_token: ACCESS_TOKEN, token_expires_at: Date.now() + 3600000 },
      }],
    });
    await expect(
      service.callLinkedInMarketingApi(USER_ID, 'INMAIL', 'CREATE_CONTENT', ACCOUNT_ID, {
        name: 'Test', subject: 'Hi', htmlBody: '<p>Hi</p>', callToActionText: 'CTA', callToActionLandingPageUrl: 'https://example.com',
      })
    ).rejects.toThrow('sender');
  });

  it('CREATE_CONTENT accepts explicit sender param overriding person_urn', async () => {
    await service.callLinkedInMarketingApi(USER_ID, 'INMAIL', 'CREATE_CONTENT', ACCOUNT_ID, {
      sender: 'urn:li:person:custom-sender',
      name: 'Test', subject: 'Hi', htmlBody: '<p>Hi</p>', callToActionText: 'CTA', callToActionLandingPageUrl: 'https://example.com',
    });
    expect(linkedInAdsService.createInMailContent).toHaveBeenCalledWith(
      ACCESS_TOKEN,
      expect.objectContaining({ sender: 'urn:li:person:custom-sender' })
    );
  });

  it('SEND_TEST calls sendTestInMail', async () => {
    const result = await service.callLinkedInMarketingApi(USER_ID, 'INMAIL', 'SEND_TEST', ACCOUNT_ID, {
      inmail_content_urn: 'urn:li:inMailContent:123',
      recipient_email: 'test@example.com',
    });
    expect(linkedInAdsService.sendTestInMail).toHaveBeenCalledWith(
      ACCESS_TOKEN,
      'urn:li:inMailContent:123',
      'test@example.com'
    );
    expect(result.success).toBe(true);
  });

  it('SEND_TEST throws when inmail_content_urn missing', async () => {
    await expect(
      service.callLinkedInMarketingApi(USER_ID, 'INMAIL', 'SEND_TEST', ACCOUNT_ID, { recipient_email: 'a@b.com' })
    ).rejects.toThrow('inmail_content_urn');
  });

  it('SEND_TEST throws when recipient_email missing', async () => {
    await expect(
      service.callLinkedInMarketingApi(USER_ID, 'INMAIL', 'SEND_TEST', ACCOUNT_ID, { inmail_content_urn: 'urn:li:inMailContent:123' })
    ).rejects.toThrow('recipient_email');
  });

  it('throws on unknown INMAIL action', async () => {
    await expect(
      service.callLinkedInMarketingApi(USER_ID, 'INMAIL', 'UNKNOWN_ACTION', ACCOUNT_ID, {})
    ).rejects.toThrow('INMAIL');
  });
});

// ── callLinkedInAdsInsightsApi ────────────────────────────────────────────────

describe('callLinkedInAdsInsightsApi', () => {
  const dateRange = { start: { year: 2024, month: 1, day: 1 }, end: { year: 2024, month: 12, day: 31 } };

  it('calls getAdAnalytics with correct params', async () => {
    const result = await service.callLinkedInAdsInsightsApi(USER_ID, ACCOUNT_ID, {
      pivot: 'CAMPAIGN',
      dateRange,
      timeGranularity: 'MONTHLY',
      fields: ['impressions', 'clicks'],
      campaigns: ['camp-1'],
    });
    expect(linkedInAdsService.getAdAnalytics).toHaveBeenCalledWith(
      ACCESS_TOKEN,
      ACCOUNT_ID,
      'CAMPAIGN',
      'MONTHLY',
      dateRange,
      ['impressions', 'clicks'],
      expect.objectContaining({ campaign_ids: ['camp-1'] })
    );
    expect(result.success).toBe(true);
    expect(result.analytics).toBeDefined();
  });

  it('defaults timeGranularity to ALL when not provided', async () => {
    await service.callLinkedInAdsInsightsApi(USER_ID, ACCOUNT_ID, { pivot: 'CAMPAIGN', dateRange });
    expect(linkedInAdsService.getAdAnalytics).toHaveBeenCalledWith(
      ACCESS_TOKEN,
      ACCOUNT_ID,
      'CAMPAIGN',
      'ALL',
      dateRange,
      expect.any(Array),
      expect.any(Object)
    );
  });

  it('defaults fields when not provided', async () => {
    await service.callLinkedInAdsInsightsApi(USER_ID, ACCOUNT_ID, { pivot: 'CAMPAIGN', dateRange });
    const call = (linkedInAdsService.getAdAnalytics as jest.Mock).mock.calls[0];
    expect(call[5]).toContain('impressions');
  });

  it('returns analytics from service', async () => {
    const result = await service.callLinkedInAdsInsightsApi(USER_ID, ACCOUNT_ID, { pivot: 'CAMPAIGN', dateRange });
    expect(result.analytics).toEqual([{ impressions: 1000 }]);
  });
});

// ── callLinkedInMarketingApi — MEDIA/UPLOAD_VIDEO ────────────────────────────

describe('callLinkedInMarketingApi — MEDIA/UPLOAD_VIDEO', () => {
  beforeEach(() => {
    const mockAxios = require('axios');
    mockAxios.get = jest.fn().mockResolvedValue({
      data: Buffer.alloc(100, 'x'),
      headers: { 'content-type': 'video/mp4' },
    });
  });

  it('UPLOAD_VIDEO auto-downloads, inits upload, uploads parts, finalizes, returns video_urn', async () => {
    const result = await service.callLinkedInMarketingApi(USER_ID, 'MEDIA', 'UPLOAD_VIDEO', ACCOUNT_ID, {
      video_url: 'https://example.com/video.mp4',
    });
    expect(linkedInAdsService.initializeVideoUpload).toHaveBeenCalledWith(ACCESS_TOKEN, ORG_URN, 100);
    expect(linkedInAdsService.uploadVideoPart).toHaveBeenCalledWith(
      'https://video-upload.example.com',
      expect.any(Buffer)
    );
    expect(linkedInAdsService.finalizeVideoUpload).toHaveBeenCalledWith(ACCESS_TOKEN, 'urn:li:video:vid-1', '', ['etag-part-1']);
    expect(result.success).toBe(true);
    expect(result.video_urn).toBe('urn:li:video:vid-1');
  });

  it('UPLOAD_VIDEO throws when video_url missing', async () => {
    await expect(
      service.callLinkedInMarketingApi(USER_ID, 'MEDIA', 'UPLOAD_VIDEO', ACCOUNT_ID, {})
    ).rejects.toThrow('video_url');
  });
});

// ── callLinkedInMarketingApi — MEDIA/UPLOAD_DOCUMENT ────────────────────────

describe('callLinkedInMarketingApi — MEDIA/UPLOAD_DOCUMENT', () => {
  beforeEach(() => {
    const mockAxios = require('axios');
    mockAxios.get = jest.fn().mockResolvedValue({
      data: Buffer.alloc(200, 'y'),
      headers: { 'content-type': 'application/pdf' },
    });
  });

  it('UPLOAD_DOCUMENT auto-downloads, inits upload, uploads binary, returns document_urn', async () => {
    const result = await service.callLinkedInMarketingApi(USER_ID, 'MEDIA', 'UPLOAD_DOCUMENT', ACCOUNT_ID, {
      document_url: 'https://example.com/brochure.pdf',
    });
    expect(linkedInAdsService.initializeDocumentUpload).toHaveBeenCalledWith(ACCESS_TOKEN, ORG_URN);
    expect(linkedInAdsService.uploadDocumentBinary).toHaveBeenCalledWith(
      'https://doc-upload.example.com',
      expect.any(Buffer),
      'application/pdf'
    );
    expect(result.success).toBe(true);
    expect(result.document_urn).toBe('urn:li:document:doc-1');
  });

  it('UPLOAD_DOCUMENT throws when document_url missing', async () => {
    await expect(
      service.callLinkedInMarketingApi(USER_ID, 'MEDIA', 'UPLOAD_DOCUMENT', ACCOUNT_ID, {})
    ).rejects.toThrow('document_url');
  });
});

// ── callLinkedInMarketingApi — CREATIVE/CREATE_DYNAMIC ───────────────────────

describe('callLinkedInMarketingApi — CREATIVE/CREATE_DYNAMIC', () => {
  it('CREATE_DYNAMIC calls createDynamicCreative with correct params', async () => {
    const result = await service.callLinkedInMarketingApi(USER_ID, 'CREATIVE', 'CREATE_DYNAMIC', ACCOUNT_ID, {
      campaign_id: 'camp-1',
      format: 'SPOTLIGHT',
      headline: 'Check us out',
      call_to_action: 'Learn More',
      landing_page: 'https://example.com',
    });
    expect(linkedInAdsService.createDynamicCreative).toHaveBeenCalledWith(
      ACCESS_TOKEN,
      ACCOUNT_ID,
      expect.objectContaining({ campaign_id: 'camp-1', format: 'SPOTLIGHT' })
    );
    expect(result.success).toBe(true);
    expect(result.creative).toBeDefined();
  });

  it('CREATE_DYNAMIC throws when campaign_id missing', async () => {
    await expect(
      service.callLinkedInMarketingApi(USER_ID, 'CREATIVE', 'CREATE_DYNAMIC', ACCOUNT_ID, { format: 'JOBS' })
    ).rejects.toThrow('campaign_id');
  });

  it('CREATE_DYNAMIC throws when format missing', async () => {
    await expect(
      service.callLinkedInMarketingApi(USER_ID, 'CREATIVE', 'CREATE_DYNAMIC', ACCOUNT_ID, { campaign_id: 'camp-1' })
    ).rejects.toThrow('format');
  });
});

// ── callLinkedInMarketingApi — CONVERSATION_AD ───────────────────────────────

describe('callLinkedInMarketingApi — CONVERSATION_AD', () => {
  it('CREATE creates conversation ad and returns urn', async () => {
    const result = await service.callLinkedInMarketingApi(USER_ID, 'CONVERSATION_AD', 'CREATE', ACCOUNT_ID, {
      name: 'My Conversation Ad',
    });
    expect(linkedInAdsService.createConversationAd).toHaveBeenCalledWith(
      ACCESS_TOKEN,
      ACCOUNT_ID,
      expect.objectContaining({ name: 'My Conversation Ad' })
    );
    expect(result.success).toBe(true);
    expect(result.conversation_ad_urn).toBe('urn:li:conversationAd:ca-1');
  });

  it('CREATE throws when name missing', async () => {
    await expect(
      service.callLinkedInMarketingApi(USER_ID, 'CONVERSATION_AD', 'CREATE', ACCOUNT_ID, {})
    ).rejects.toThrow('name');
  });

  it('CREATE_CONTENT adds message node and returns content_urn', async () => {
    const result = await service.callLinkedInMarketingApi(USER_ID, 'CONVERSATION_AD', 'CREATE_CONTENT', ACCOUNT_ID, {
      conversation_ad_urn: 'urn:li:conversationAd:ca-1',
      body: 'Hello! How can we help?',
      buttons: [{ text: 'Learn More', action: 'OPEN_URL', url: 'https://example.com' }],
    });
    expect(linkedInAdsService.createConversationAdContent).toHaveBeenCalledWith(
      ACCESS_TOKEN,
      'urn:li:conversationAd:ca-1',
      expect.objectContaining({ body: 'Hello! How can we help?' })
    );
    expect(result.success).toBe(true);
    expect(result.content_urn).toBe('urn:li:conversationAdContent:cc-1');
  });

  it('CREATE_CONTENT throws when conversation_ad_urn missing', async () => {
    await expect(
      service.callLinkedInMarketingApi(USER_ID, 'CONVERSATION_AD', 'CREATE_CONTENT', ACCOUNT_ID, {
        body: 'Hi', buttons: [{ text: 'OK', action: 'OPEN_URL' }],
      })
    ).rejects.toThrow('conversation_ad_urn');
  });

  it('SET_FIRST_CONTENT sets first content node', async () => {
    const result = await service.callLinkedInMarketingApi(USER_ID, 'CONVERSATION_AD', 'SET_FIRST_CONTENT', ACCOUNT_ID, {
      conversation_ad_urn: 'urn:li:conversationAd:ca-1',
      first_content_urn: 'urn:li:conversationAdContent:cc-1',
    });
    expect(linkedInAdsService.setConversationAdFirstContent).toHaveBeenCalledWith(
      ACCESS_TOKEN,
      'urn:li:conversationAd:ca-1',
      'urn:li:conversationAdContent:cc-1'
    );
    expect(result.success).toBe(true);
  });

  it('SET_FIRST_CONTENT throws when first_content_urn missing', async () => {
    await expect(
      service.callLinkedInMarketingApi(USER_ID, 'CONVERSATION_AD', 'SET_FIRST_CONTENT', ACCOUNT_ID, {
        conversation_ad_urn: 'urn:li:conversationAd:ca-1',
      })
    ).rejects.toThrow('first_content_urn');
  });

  it('throws on unknown CONVERSATION_AD action', async () => {
    await expect(
      (service as any).callLinkedInMarketingApi(USER_ID, 'CONVERSATION_AD', 'UNKNOWN', ACCOUNT_ID, {})
    ).rejects.toThrow('CONVERSATION_AD');
  });
});
