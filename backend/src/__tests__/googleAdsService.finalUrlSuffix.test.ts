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
  // Benign default so an unqueued call (e.g. the inherited-suffix GAQL read that
  // createAd/updateAd now issue before mutating) never crashes. Assertions below
  // check what we SENT, so the response body only has to be well-shaped.
  mockAxiosPost.mockResolvedValue({ data: { results: [{ resourceName: 'default' }] } });
  service = new GoogleAdsService();
});

/**
 * Locate the mutate POST by its body shape rather than by call index: createAd /
 * updateAd now issue a GAQL `search` first (to read the campaign's inherited
 * final_url_suffix — see the AC4 tests below), so the mutate is no longer call 0.
 * `search` posts `{ query }`; `mutate` posts `{ operations }`.
 */
function mutateOperation(): any {
  const call = mockAxiosPost.mock.calls.find((c: any) => c[1]?.operations);
  if (!call) throw new Error('no mutate call was made');
  return call[1].operations[0];
}

function adGroupAdCreate(): any {
  return mutateOperation().create;
}

/** Stub the inherited-suffix GAQL read. Pass undefined for "campaign has none". */
function mockInheritedSuffix(suffix?: string) {
  mockAxiosPost.mockResolvedValueOnce({
    data: { results: [{ campaign: suffix ? { finalUrlSuffix: suffix } : {} }] },
  });
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

describe('retagAdUtm — single existing ad, on-demand retrofit (Harsha\'s ask)', () => {
  // LIVE-VERIFIED 2026-07-16 against a real Google Ads account (customer 2883029950):
  // ad-level UPDATE of final_url_suffix is REJECTED by the live API --
  // "IMMUTABLE_FIELD: Field 'ad.final_url_suffix' cannot be modified by 'UPDATE'
  // operation" -- even though the v24 Ad proto carries no IMMUTABLE annotation on
  // this field. The proto and live server-side validation disagree; do not trust
  // proto silence as proof of mutability again. CAMPAIGN-level UPDATE of
  // final_url_suffix, by contrast, was confirmed live to succeed and read back
  // correctly. retagAdUtm therefore writes at the CAMPAIGN level: it reads the
  // ad's final_url (for the AC4 omission check) and the campaign's CURRENT
  // final_url_suffix (to merge into, not replace), then writes the merged value
  // back to the campaign. This means retagging affects EVERY ad under that
  // campaign, not just the one the caller named -- callers/tools must disclose
  // this blast radius.

  it('returns success:false with a reason when the ad has no destination URL', async () => {
    mockAxiosPost.mockResolvedValueOnce({ data: { results: [] } });
    const result = await service.retagAdUtm('user-123', '1234567890', 'customers/123/adGroupAds/1');
    expect(result).toEqual({ success: false, reason: 'no_destination_url' });
    expect(mockAxiosPost).toHaveBeenCalledTimes(1); // only the read — never reaches updateCampaign
  });

  it('is a no-op (success:false) when the campaign suffix already covers every key the ad needs', async () => {
    mockAxiosPost.mockResolvedValueOnce({
      data: {
        results: [{
          adGroupAd: { ad: { finalUrls: ['https://example.com/'] } },
          campaign: {
            resourceName: 'customers/1234567890/campaigns/9',
            finalUrlSuffix: 'utm_source=a&utm_medium=b&utm_campaign=c&utm_content=d&utm_term=e',
          },
        }],
      },
    });
    const result = await service.retagAdUtm('user-123', '1234567890', 'customers/123/adGroupAds/1');
    expect(result).toEqual({ success: false });
    expect(mockAxiosPost).toHaveBeenCalledTimes(1); // read only — no mutate fires
  });

  it('does not touch anything when the ad\'s final_url is unreadable (never risk a duplicate)', async () => {
    mockAxiosPost.mockResolvedValueOnce({
      data: {
        results: [{
          adGroupAd: { ad: { finalUrls: ['not a url'] } },
          campaign: { resourceName: 'customers/1234567890/campaigns/9', finalUrlSuffix: undefined },
        }],
      },
    });
    const result = await service.retagAdUtm('user-123', '1234567890', 'customers/123/adGroupAds/1');
    expect(result).toEqual({ success: false });
    expect(mockAxiosPost).toHaveBeenCalledTimes(1);
  });

  it('writes the merged suffix to the CAMPAIGN, not the ad (happy path)', async () => {
    mockAxiosPost.mockResolvedValueOnce({
      data: {
        results: [{
          adGroupAd: { ad: { finalUrls: ['https://example.com/'] } },
          campaign: { resourceName: 'customers/1234567890/campaigns/9', finalUrlSuffix: undefined },
        }],
      },
    });
    mockAxiosPost.mockResolvedValueOnce({ data: { results: [{}] } }); // the mutate
    const result = await service.retagAdUtm('user-123', '1234567890', 'customers/123/adGroupAds/1');
    expect(result).toEqual({ success: true });
    const op = mutateOperation();
    expect(op.update.resourceName).toBe('customers/1234567890/campaigns/9');
    expect(op.update.finalUrlSuffix).toBe(FULL_SUFFIX);
    expect(op.update).not.toHaveProperty('ad'); // never touches the ad resource
  });

  it('merges into the EXISTING campaign suffix rather than replacing it (AC4)', async () => {
    mockAxiosPost.mockResolvedValueOnce({
      data: {
        results: [{
          adGroupAd: { ad: { finalUrls: ['https://example.com/'] } },
          campaign: { resourceName: 'customers/1234567890/campaigns/9', finalUrlSuffix: 'utm_source=custom&partner_id=1' },
        }],
      },
    });
    mockAxiosPost.mockResolvedValueOnce({ data: { results: [{}] } });
    await service.retagAdUtm('user-123', '1234567890', 'customers/123/adGroupAds/1');
    const op = mutateOperation();
    expect(op.update.finalUrlSuffix).toBe(
      'utm_source=custom&partner_id=1&utm_medium=paid&utm_campaign={campaignid}&utm_content={creative}',
    );
  });

  it('reads exactly the resource name it was given (no destination-URL guessing)', async () => {
    mockAxiosPost.mockResolvedValueOnce({
      data: {
        results: [{
          adGroupAd: { ad: { finalUrls: ['https://example.com/'] } },
          campaign: { resourceName: 'customers/1234567890/campaigns/9', finalUrlSuffix: undefined },
        }],
      },
    });
    mockAxiosPost.mockResolvedValueOnce({ data: { results: [{}] } });
    await service.retagAdUtm('user-123', '1234567890', 'customers/123/adGroupAds/42');
    const readQuery = mockAxiosPost.mock.calls[0][1].query;
    expect(readQuery).toContain(`ad_group_ad.resource_name = 'customers/123/adGroupAds/42'`);
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

  it('appends the UTMs (with macros, no utm_content) to the asset group final_urls', async () => {
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
    // Google's own developer docs mark {creative} unsupported for Performance Max
    // (developers.google.com/google-ads/api/performance-max/valuetrack) -- it
    // never resolves, so it must never be emitted here, unlike the ad-level path.
    expect(create.finalUrls[0]).toBe('https://example.com/?utm_source=google&utm_medium=paid&utm_campaign={campaignid}');
    expect(create.finalUrls[0]).not.toContain('utm_content');
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
      'https://example.com/?utm_source=newsletter&utm_medium=paid&utm_campaign={campaignid}',
    );
  });
});

/**
 * ENG-239 AC4 at the level nobody checks — the bug this suite was extended for.
 *
 * Google resolves `final_url_suffix` by MOST SPECIFIC level (ad > ad group >
 * campaign > account) and the winning level REPLACES the others outright — they
 * are NOT concatenated. So writing an ad-level suffix silently destroys whatever
 * the client configured at campaign level, which is the normal place to configure
 * it. "User-provided UTMs are respected, not overwritten" has to hold there too.
 */
describe('createAd — inherited campaign-level final_url_suffix (AC4)', () => {
  it("carries the campaign's own tracking params forward instead of destroying them", async () => {
    mockInheritedSuffix('clientparam=1&partner=acme');
    mockAxiosPost.mockResolvedValueOnce({ data: { results: [{ resourceName: 'customers/1/adGroupAds/1~1' }] } });

    await service.createAd('user-123', '1234567890', {
      adGroupResourceName: 'customers/1234567890/adGroups/55',
      type: 'RESPONSIVE_SEARCH_AD',
      headlines: ['h'], descriptions: ['d'],
      finalUrl: 'https://example.com',
    });

    const suffix = adGroupAdCreate().ad.finalUrlSuffix;
    // the client's params survive the ad-level write
    expect(suffix).toContain('clientparam=1');
    expect(suffix).toContain('partner=acme');
    // and our UTMs are appended alongside them
    expect(suffix).toContain('utm_source=google');
    expect(suffix).toContain('utm_campaign={campaignid}');
  });

  it("does not duplicate a UTM key the campaign suffix already defines", async () => {
    mockInheritedSuffix('utm_source=partnernetwork');
    mockAxiosPost.mockResolvedValueOnce({ data: { results: [{ resourceName: 'x' }] } });

    await service.createAd('user-123', '1234567890', {
      adGroupResourceName: 'customers/1234567890/adGroups/55',
      type: 'RESPONSIVE_SEARCH_AD',
      headlines: ['h'], descriptions: ['d'],
      finalUrl: 'https://example.com',
    });

    const suffix = adGroupAdCreate().ad.finalUrlSuffix;
    expect(suffix).toContain('utm_source=partnernetwork');
    expect(suffix).not.toContain('utm_source=google');
    expect(suffix).toContain('utm_medium=paid');
  });

  it('writes no suffix when the inherited-suffix read fails — never clobber what we cannot see', async () => {
    // Fail-safe: losing attribution on one ad is recoverable; silently destroying a
    // client's campaign-level tracking is not.
    mockAxiosPost.mockRejectedValueOnce(new Error('transient API error'));
    mockAxiosPost.mockResolvedValueOnce({ data: { results: [{ resourceName: 'x' }] } });

    await service.createAd('user-123', '1234567890', {
      adGroupResourceName: 'customers/1234567890/adGroups/55',
      type: 'RESPONSIVE_SEARCH_AD',
      headlines: ['h'], descriptions: ['d'],
      finalUrl: 'https://example.com',
    });

    expect(adGroupAdCreate().ad.finalUrlSuffix).toBeUndefined();
  });
});

describe('createAd — malformed destination URL must not abort ad creation', () => {
  it('creates the ad untagged rather than throwing when finalUrl is unparseable', async () => {
    // A user typing `example.com` (no scheme) should get GOOGLE's validation error,
    // not ours. Tagging is a best-effort overlay; it must never be the thing that
    // breaks an ad build.
    mockInheritedSuffix(undefined);
    mockAxiosPost.mockResolvedValueOnce({ data: { results: [{ resourceName: 'x' }] } });

    await expect(
      service.createAd('user-123', '1234567890', {
        adGroupResourceName: 'customers/1234567890/adGroups/55',
        type: 'RESPONSIVE_SEARCH_AD',
        headlines: ['h'], descriptions: ['d'],
        finalUrl: 'example.com',
      }),
    ).resolves.toBeDefined();

    // We could not read its keys, so we add nothing and let Google judge the URL.
    const create = adGroupAdCreate();
    expect(create.ad.finalUrls).toEqual(['example.com']);
    expect(create.ad.finalUrlSuffix).toBeUndefined();
  });
});

describe('retagAssetGroupUtm — single existing PMax asset group, on-demand retrofit (Harsha\'s ask)', () => {
  it('returns success:false with a reason when the asset group has no destination URL', async () => {
    mockAxiosPost.mockResolvedValueOnce({ data: { results: [] } });
    const result = await service.retagAssetGroupUtm('user-123', '1234567890', 'customers/123/assetGroups/1');
    expect(result).toEqual({ success: false, reason: 'no_destination_url' });
    expect(mockAxiosPost).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when the URL already carries every key the spec would add', async () => {
    mockAxiosPost.mockResolvedValueOnce({
      data: {
        results: [{
          assetGroup: { finalUrls: ['https://example.com/?utm_source=a&utm_medium=b&utm_campaign=c'] },
          campaign: {},
        }],
      },
    });
    const result = await service.retagAssetGroupUtm('user-123', '1234567890', 'customers/123/assetGroups/1');
    expect(result).toEqual({ success: false });
    expect(mockAxiosPost).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when the CAMPAIGN suffix already supplies every key (inherited at delivery)', async () => {
    mockAxiosPost.mockResolvedValueOnce({
      data: {
        results: [{
          assetGroup: { finalUrls: ['https://example.com/'] },
          campaign: { finalUrlSuffix: 'utm_source=a&utm_medium=b&utm_campaign=c' },
        }],
      },
    });
    const result = await service.retagAssetGroupUtm('user-123', '1234567890', 'customers/123/assetGroups/1');
    expect(result).toEqual({ success: false });
    expect(mockAxiosPost).toHaveBeenCalledTimes(1); // never writes — campaign already covers it
  });

  it('does not touch anything when the URL is unreadable (never risk a duplicate)', async () => {
    mockAxiosPost.mockResolvedValueOnce({
      data: { results: [{ assetGroup: { finalUrls: ['not a url'] }, campaign: {} }] },
    });
    const result = await service.retagAssetGroupUtm('user-123', '1234567890', 'customers/123/assetGroups/1');
    expect(result).toEqual({ success: false });
    expect(mockAxiosPost).toHaveBeenCalledTimes(1);
  });

  it('adds the missing UTMs into final_urls, with NO utm_content, on the happy path', async () => {
    mockAxiosPost.mockResolvedValueOnce({
      data: { results: [{ assetGroup: { finalUrls: ['https://example.com/'] }, campaign: {} }] },
    });
    mockAxiosPost.mockResolvedValueOnce({ data: { results: [{}] } }); // the mutate
    const result = await service.retagAssetGroupUtm('user-123', '1234567890', 'customers/123/assetGroups/1');
    expect(result).toEqual({ success: true });
    const op = mutateOperation();
    expect(op.update.resourceName).toBe('customers/123/assetGroups/1');
    expect(op.update.finalUrls[0]).toBe('https://example.com/?utm_source=google&utm_medium=paid&utm_campaign={campaignid}');
    expect(op.update.finalUrls[0]).not.toContain('utm_content');
    expect(op.updateMask).toBe('final_urls');
  });

  it('does not duplicate a key already supplied by the CAMPAIGN suffix, adds only what\'s missing', async () => {
    mockAxiosPost.mockResolvedValueOnce({
      data: {
        results: [{
          assetGroup: { finalUrls: ['https://example.com/'] },
          campaign: { finalUrlSuffix: 'utm_source=custom' },
        }],
      },
    });
    mockAxiosPost.mockResolvedValueOnce({ data: { results: [{}] } });
    await service.retagAssetGroupUtm('user-123', '1234567890', 'customers/123/assetGroups/1');
    const op = mutateOperation();
    expect(op.update.finalUrls[0]).toBe('https://example.com/?utm_medium=paid&utm_campaign={campaignid}');
    expect(op.update.finalUrls[0]).not.toContain('utm_source=google');
  });
});
