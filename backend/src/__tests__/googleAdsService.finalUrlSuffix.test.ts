/**
 * ENG-239 — Google slice. Verifies Emma auto-appends UTM tracking to the
 * destination URLs of the ads/asset groups it deploys via googleAdsService.
 *
 * createAd / updateAd use the ad's native `final_url_suffix` field (Google
 * resolves it at click time and shows it in the ad's URL settings). The PMax
 * asset-group resource has no `final_url_suffix` field, so UTMs are merged
 * straight into its `final_urls` instead. All paths honour AC4 (never duplicate
 * a UTM key the user already put on the destination URL) and pass ValueTrack
 * macros (`{campaignid}`, `{creative}`) through un-encoded.
 */

const mockAxiosPost = jest.fn();
const mockAxiosGet = jest.fn();
jest.mock('axios', () => ({
  post: (...args: any[]) => mockAxiosPost(...args),
  get: (...args: any[]) => mockAxiosGet(...args),
}));

jest.mock('../utils/secretsManager', () => ({
  getGoogleAdsCredentials: jest.fn().mockResolvedValue({
    clientId: 'test-client-id',
    clientSecret: 'test-secret',
    developerToken: 'test-dev-token',
  }),
}));

jest.mock('../services/db', () => ({
  userDb: {
    getUserById: jest.fn().mockResolvedValue({
      userId: 'user-123',
      connected_accounts: [
        {
          platform: 'google_ads',
          account_id: '1234567890',
          account_name: 'Test Account',
          config: {
            customer_id: '1234567890',
            currency: 'USD',
            access_token: 'valid-token',
            refresh_token: 'refresh-token',
            token_expires_at: Date.now() + 3600 * 1000,
          },
        },
      ],
    }),
  },
}));

jest.mock('../services/connectedAccountsDb', () => ({
  updateAccountTokens: jest.fn().mockResolvedValue(undefined),
  getAccountsWithOwnerIncludingOrgShared: jest.fn(async (userId: string) => {
    const { userDb } = require('../services/db');
    const user = await userDb.getUserById(userId);
    if (!user) return [];
    const accounts = Array.isArray(user.connected_accounts) ? user.connected_accounts : [];
    return accounts.map((a: any) => ({ ...a, userId: user.userId ?? userId }));
  }),
}));

jest.mock('../utils/ssrfGuard', () => ({
  assertPublicHostname: jest.fn().mockResolvedValue(undefined),
  SsrfBlockedError: class SsrfBlockedError extends Error {},
}));

import { GoogleAdsService } from '../services/googleAdsService';

// The suffix Emma generates for a Google ad whose destination URL carries no UTMs.
// Macros are un-encoded; utm_source/medium/campaign/content in UTM_KEYS order.
const FULL_SUFFIX =
  'utm_source=google&utm_medium=paid&utm_campaign={campaignid}&utm_content={creative}';

let service: GoogleAdsService;
beforeEach(() => {
  // mockReset (not just clearMocks) so an unconsumed mockResolvedValueOnce from a
  // prior test can never leak into the next one's first axios call.
  mockAxiosPost.mockReset();
  mockAxiosGet.mockReset();
  service = new GoogleAdsService();
});

function adGroupAdCreate(): any {
  return mockAxiosPost.mock.calls[0][1].operations[0].create;
}

describe('createAd — final_url_suffix generation (AC1)', () => {
  it('sets ad.finalUrlSuffix when the finalUrl has no UTMs', async () => {
    mockAxiosPost.mockResolvedValueOnce({ data: { results: [{ resourceName: 'customers/123/adGroupAds/1' }] } });
    await service.createAd('user-123', '1234567890', {
      adGroupResourceName: 'customers/123/adGroups/789',
      type: 'RESPONSIVE_SEARCH_AD',
      headlines: ['H1', 'H2', 'H3'],
      descriptions: ['D1', 'D2'],
      finalUrl: 'https://example.com/',
    });
    const ad = adGroupAdCreate().ad;
    expect(ad.finalUrlSuffix).toBe(FULL_SUFFIX);
    // The destination URL itself is untouched.
    expect(ad.finalUrls).toEqual(['https://example.com/']);
  });

  it('omits a UTM key the finalUrl already carries (AC4)', async () => {
    mockAxiosPost.mockResolvedValueOnce({ data: { results: [{ resourceName: 'customers/123/adGroupAds/1' }] } });
    await service.createAd('user-123', '1234567890', {
      adGroupResourceName: 'customers/123/adGroups/789',
      type: 'RESPONSIVE_SEARCH_AD',
      headlines: ['H1'],
      descriptions: ['D1'],
      finalUrl: 'https://example.com/?utm_source=newsletter',
    });
    const ad = adGroupAdCreate().ad;
    expect(ad.finalUrlSuffix).toBe('utm_medium=paid&utm_campaign={campaignid}&utm_content={creative}');
    expect(ad.finalUrlSuffix).not.toContain('utm_source');
  });

  it('emits NO finalUrlSuffix field when the finalUrl already has all five UTMs', async () => {
    mockAxiosPost.mockResolvedValueOnce({ data: { results: [{ resourceName: 'customers/123/adGroupAds/1' }] } });
    await service.createAd('user-123', '1234567890', {
      adGroupResourceName: 'customers/123/adGroups/789',
      type: 'RESPONSIVE_SEARCH_AD',
      headlines: ['H1'],
      descriptions: ['D1'],
      finalUrl: 'https://example.com/?utm_source=a&utm_medium=b&utm_campaign=c&utm_content=d&utm_term=e',
    });
    expect(adGroupAdCreate().ad).not.toHaveProperty('finalUrlSuffix');
  });

  it('lets an explicit finalUrlSuffix win over the generated one', async () => {
    mockAxiosPost.mockResolvedValueOnce({ data: { results: [{ resourceName: 'customers/123/adGroupAds/1' }] } });
    await service.createAd('user-123', '1234567890', {
      adGroupResourceName: 'customers/123/adGroups/789',
      type: 'RESPONSIVE_SEARCH_AD',
      headlines: ['H1'],
      descriptions: ['D1'],
      finalUrl: 'https://example.com/',
      finalUrlSuffix: 'utm_source=custom&utm_medium=paid',
    });
    expect(adGroupAdCreate().ad.finalUrlSuffix).toBe('utm_source=custom&utm_medium=paid');
  });

  it('also tags Responsive Display Ads', async () => {
    mockAxiosPost.mockResolvedValueOnce({ data: { results: [{ resourceName: 'customers/123/adGroupAds/2' }] } });
    await service.createAd('user-123', '1234567890', {
      adGroupResourceName: 'customers/123/adGroups/789',
      type: 'RESPONSIVE_DISPLAY_AD',
      headlines: ['H1'],
      descriptions: ['D1'],
      finalUrl: 'https://example.com/',
    });
    expect(adGroupAdCreate().ad.finalUrlSuffix).toBe(FULL_SUFFIX);
  });
});

describe('updateAd — final_url_suffix (AC1: an edited ad keeps/gains its suffix)', () => {
  it('sets ad.final_url_suffix (with mask) generated from a supplied finalUrl', async () => {
    mockAxiosPost.mockResolvedValueOnce({ data: { results: [{}] } });
    await service.updateAd('user-123', '1234567890', 'customers/123/adGroupAds/1', {
      finalUrl: 'https://example.com/',
    });
    const op = mockAxiosPost.mock.calls[0][1].operations[0];
    expect(op.update.resourceName).toBe('customers/123/adGroupAds/1');
    expect(op.update.ad.finalUrlSuffix).toBe(FULL_SUFFIX);
    expect(op.updateMask).toContain('ad.final_url_suffix');
  });

  it('lets an explicit finalUrlSuffix win on update', async () => {
    mockAxiosPost.mockResolvedValueOnce({ data: { results: [{}] } });
    await service.updateAd('user-123', '1234567890', 'customers/123/adGroupAds/1', {
      finalUrlSuffix: 'utm_source=explicit',
    });
    const op = mockAxiosPost.mock.calls[0][1].operations[0];
    expect(op.update.ad.finalUrlSuffix).toBe('utm_source=explicit');
    expect(op.updateMask).toContain('ad.final_url_suffix');
  });

  it('updates status and suffix together', async () => {
    mockAxiosPost.mockResolvedValueOnce({ data: { results: [{}] } });
    await service.updateAd('user-123', '1234567890', 'customers/123/adGroupAds/1', {
      status: 'PAUSED',
      finalUrl: 'https://example.com/',
    });
    const op = mockAxiosPost.mock.calls[0][1].operations[0];
    expect(op.update.status).toBe('PAUSED');
    expect(op.update.ad.finalUrlSuffix).toBe(FULL_SUFFIX);
    expect(op.updateMask).toContain('status');
    expect(op.updateMask).toContain('ad.final_url_suffix');
  });

  it('emits no ad field when the finalUrl already has every UTM', async () => {
    mockAxiosPost.mockResolvedValueOnce({ data: { results: [{}] } });
    await service.updateAd('user-123', '1234567890', 'customers/123/adGroupAds/1', {
      status: 'ENABLED',
      finalUrl: 'https://example.com/?utm_source=a&utm_medium=b&utm_campaign=c&utm_content=d&utm_term=e',
    });
    const op = mockAxiosPost.mock.calls[0][1].operations[0];
    expect(op.update).not.toHaveProperty('ad');
    expect(op.updateMask).not.toContain('ad.final_url_suffix');
  });

  it('still no-ops when neither status nor any URL info is provided', async () => {
    await service.updateAd('user-123', '1234567890', 'customers/123/adGroupAds/1', {});
    expect(mockAxiosPost).not.toHaveBeenCalled();
  });
});

describe('createAssetGroup — asset_group has no suffix field, so UTMs merge into final_urls', () => {
  function assetGroupBatchResponse() {
    return {
      data: {
        mutateOperationResponses: [
          { assetResult: { resourceName: 'customers/123/assets/-2' } },
          { assetResult: { resourceName: 'customers/123/assets/-3' } },
          { assetResult: { resourceName: 'customers/123/assets/-4' } },
          { assetGroupResult: { resourceName: 'customers/123/assetGroups/1' } },
          { assetGroupAssetResult: {} },
          { assetGroupAssetResult: {} },
          { assetGroupAssetResult: {} },
          { assetGroupAssetResult: {} },
          { assetGroupAssetResult: {} },
        ],
      },
    };
  }

  it('appends the UTMs (with macros) to the asset group final_urls', async () => {
    mockAxiosPost.mockResolvedValueOnce(assetGroupBatchResponse());
    await service.createAssetGroup('user-123', '1234567890', {
      name: 'AG',
      campaignResourceName: 'customers/123/campaigns/1',
      headlines: ['H1'],
      longHeadlines: ['LH1'],
      descriptions: ['D1'],
      squareImageAssets: ['customers/123/assets/sq1'],
      landscapeImageAssets: ['customers/123/assets/ls1'],
      logoAssets: ['customers/123/assets/logo1'],
      finalUrl: 'https://example.com/',
    });
    const create = mockAxiosPost.mock.calls[0][1].mutateOperations[3].assetGroupOperation.create;
    expect(create.finalUrls[0]).toBe(`https://example.com/?${FULL_SUFFIX}`);
    // asset_group has no final_url_suffix field — must not emit one.
    expect(create).not.toHaveProperty('finalUrlSuffix');
  });

  it('does not overwrite a UTM key the user already set on the asset group finalUrl (AC4)', async () => {
    mockAxiosPost.mockResolvedValueOnce(assetGroupBatchResponse());
    await service.createAssetGroup('user-123', '1234567890', {
      name: 'AG',
      campaignResourceName: 'customers/123/campaigns/1',
      headlines: ['H1'],
      longHeadlines: ['LH1'],
      descriptions: ['D1'],
      squareImageAssets: ['customers/123/assets/sq1'],
      landscapeImageAssets: ['customers/123/assets/ls1'],
      logoAssets: ['customers/123/assets/logo1'],
      finalUrl: 'https://example.com/?utm_source=newsletter',
    });
    const create = mockAxiosPost.mock.calls[0][1].mutateOperations[3].assetGroupOperation.create;
    expect(create.finalUrls[0]).toBe(
      'https://example.com/?utm_source=newsletter&utm_medium=paid&utm_campaign={campaignid}&utm_content={creative}',
    );
  });
});
