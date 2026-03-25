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
  refreshAccessToken: jest.fn(),
  listAdAccounts: jest.fn(),
  listCampaignGroups: jest.fn(),
  createCampaignGroup: jest.fn(),
  updateCampaignGroup: jest.fn(),
  listCampaigns: jest.fn(),
  createCampaign: jest.fn(),
  updateCampaign: jest.fn(),
  createCreative: jest.fn(),
  listCreatives: jest.fn(),
  createPost: jest.fn(),
  listTargetingFacets: jest.fn(),
  searchTargetingEntities: jest.fn(),
  getAudienceCount: jest.fn(),
  initializeImageUpload: jest.fn(),
  initializeVideoUpload: jest.fn(),
  finalizeVideoUpload: jest.fn(),
  getAdAnalytics: jest.fn(),
}));

jest.mock('../services/db', () => ({ userDb: { getUserById: jest.fn() } }));

jest.mock('../config/integrations', () => ({
  getLinkedInAdsConfig: jest.fn().mockResolvedValue({
    clientId: 'test-client-id',
    clientSecret: 'test-client-secret',
    tokenUrl: 'https://www.linkedin.com/oauth/v2/accessToken',
  }),
}));

jest.mock('../services/connectedAccountsDb', () => ({
  updateAccountTokens: jest.fn().mockResolvedValue(undefined),
}));

import { AgentModeService } from '../services/agentModeService';
import * as linkedInAdsService from '../services/linkedInAdsService';
import { userDb } from '../services/db';

const USER_ID = 'user-123';
const ACCOUNT_ID = 'urn:li:sponsoredAccount:987654321';
const NUMERIC_ACCOUNT_ID = '987654321';
const ACCESS_TOKEN = 'li-access-token';

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
  (linkedInAdsService.initializeImageUpload as jest.Mock).mockResolvedValue({ success: true, data: { uploadUrl: 'https://upload.example.com' } });
  (linkedInAdsService.initializeVideoUpload as jest.Mock).mockResolvedValue({ success: true, data: { uploadToken: 'tok' } });
  (linkedInAdsService.finalizeVideoUpload as jest.Mock).mockResolvedValue({ success: true, data: {} });
  (linkedInAdsService.getAdAnalytics as jest.Mock).mockResolvedValue({ success: true, data: { elements: [{ impressions: 1000 }] } });

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

  it('throws when user not found', async () => {
    (userDb.getUserById as jest.Mock).mockResolvedValue(null);
    await expect(
      service.callLinkedInMarketingApi(USER_ID, 'AD_ACCOUNT', 'LIST', ACCOUNT_ID)
    ).rejects.toThrow('User not found');
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
    expect(linkedInAdsService.listCampaignGroups).toHaveBeenCalledWith(ACCESS_TOKEN, ACCOUNT_ID);
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

  it('LIST calls listCreatives with campaign_id', async () => {
    await service.callLinkedInMarketingApi(USER_ID, 'CREATIVE', 'LIST', ACCOUNT_ID, { campaign_id: 'camp-1' });
    expect(linkedInAdsService.listCreatives).toHaveBeenCalledWith(ACCESS_TOKEN, 'camp-1');
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
});

// ── callLinkedInMarketingApi — POST ──────────────────────────────────────────

describe('callLinkedInMarketingApi — POST', () => {
  it('CREATE calls createPost', async () => {
    await service.callLinkedInMarketingApi(USER_ID, 'POST', 'CREATE', ACCOUNT_ID, {
      author_urn: 'urn:li:person:abc',
      commentary: 'Hello',
    });
    expect(linkedInAdsService.createPost).toHaveBeenCalledWith(
      ACCESS_TOKEN,
      expect.objectContaining({ author_urn: 'urn:li:person:abc' })
    );
  });

  it('CREATE throws when author_urn missing', async () => {
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

  it('SEARCH throws when facet or query missing', async () => {
    await expect(
      service.callLinkedInMarketingApi(USER_ID, 'TARGETING', 'SEARCH', ACCOUNT_ID, { facet: 'urn:...' })
    ).rejects.toThrow('facet and query');
  });

  it('ESTIMATE_REACH calls getAudienceCount', async () => {
    await service.callLinkedInMarketingApi(USER_ID, 'TARGETING', 'ESTIMATE_REACH', ACCOUNT_ID, {
      targeting_criteria: { include: { and: [] } },
    });
    expect(linkedInAdsService.getAudienceCount).toHaveBeenCalledWith(
      ACCESS_TOKEN,
      { include: { and: [] } }
    );
  });

  it('ESTIMATE_REACH throws when targeting_criteria missing', async () => {
    await expect(
      service.callLinkedInMarketingApi(USER_ID, 'TARGETING', 'ESTIMATE_REACH', ACCOUNT_ID, {})
    ).rejects.toThrow('targeting_criteria');
  });
});

// ── callLinkedInMarketingApi — MEDIA ─────────────────────────────────────────

describe('callLinkedInMarketingApi — MEDIA', () => {
  it('INIT_IMAGE_UPLOAD calls initializeImageUpload', async () => {
    await service.callLinkedInMarketingApi(USER_ID, 'MEDIA', 'INIT_IMAGE_UPLOAD', ACCOUNT_ID, {
      author_urn: 'urn:li:person:abc',
    });
    expect(linkedInAdsService.initializeImageUpload).toHaveBeenCalledWith(ACCESS_TOKEN, 'urn:li:person:abc');
  });

  it('INIT_VIDEO_UPLOAD calls initializeVideoUpload', async () => {
    await service.callLinkedInMarketingApi(USER_ID, 'MEDIA', 'INIT_VIDEO_UPLOAD', ACCOUNT_ID, {
      author_urn: 'urn:li:person:abc',
      file_size: 10485760,
    });
    expect(linkedInAdsService.initializeVideoUpload).toHaveBeenCalledWith(ACCESS_TOKEN, 'urn:li:person:abc', 10485760);
  });

  it('FINALIZE_VIDEO calls finalizeVideoUpload', async () => {
    await service.callLinkedInMarketingApi(USER_ID, 'MEDIA', 'FINALIZE_VIDEO', ACCOUNT_ID, {
      video_urn: 'urn:li:video:123',
    });
    expect(linkedInAdsService.finalizeVideoUpload).toHaveBeenCalledWith(ACCESS_TOKEN, 'urn:li:video:123');
  });

  it('INIT_IMAGE_UPLOAD throws when author_urn missing', async () => {
    await expect(
      service.callLinkedInMarketingApi(USER_ID, 'MEDIA', 'INIT_IMAGE_UPLOAD', ACCOUNT_ID, {})
    ).rejects.toThrow('author_urn');
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
    expect(call[4]).toContain('impressions');
  });

  it('returns analytics from service', async () => {
    const result = await service.callLinkedInAdsInsightsApi(USER_ID, ACCOUNT_ID, { pivot: 'CAMPAIGN', dateRange });
    expect(result.analytics).toEqual([{ impressions: 1000 }]);
  });
});
