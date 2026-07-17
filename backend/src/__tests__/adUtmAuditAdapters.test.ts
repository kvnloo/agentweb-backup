/**
 * ENG-239 AC3 — the three platform adapters behind `AdReadPort`.
 *
 * THE GOVERNING PRINCIPLE UNDER TEST: the audit must read destination URLs from
 * EXACTLY the places the tagger writes them, plus the places the platform inherits
 * from. If a read misses a write site, a healthy campaign is reported "untagged" —
 * and acting on that means swapping a live Meta creative, which RESETS the ad's
 * learning phase. A false positive here is actively harmful, so read/write symmetry
 * is the correctness bar and the round-trip tests below are the ones that matter.
 *
 * These suites exercise the REAL metaService / googleAdsService / linkedInAdsService
 * extraction code and the REAL `auditCampaigns` — only the platform HTTP/SDK boundary
 * is mocked. Mocking the adapters themselves would prove nothing about symmetry.
 */

// ─── Platform boundary mocks (must precede imports) ──────────────────────────

const mockGetAds = jest.fn();
const mockGetCampaigns = jest.fn();

jest.mock('facebook-nodejs-business-sdk', () => ({
  FacebookAdsApi: { init: jest.fn() },
  AdAccount: jest.fn().mockImplementation(() => ({
    getAds: (...args: any[]) => mockGetAds(...args),
    getCampaigns: (...args: any[]) => mockGetCampaigns(...args),
    createAdCreative: jest.fn(),
  })),
  AdCreative: Object.assign(
    jest.fn().mockImplementation(() => ({ get: jest.fn() })),
    { Fields: { name: 'name', object_story_spec: 'object_story_spec' } },
  ),
  Campaign: jest.fn(),
  AdSet: jest.fn(),
  Ad: jest.fn(),
  CustomAudience: jest.fn(),
  User: jest.fn(),
}));

// googleAdsService uses axios.post/axios.get; linkedInAdsService calls axios(config).
// One mock must serve both shapes.
const mockAxiosFn = jest.fn();
const mockAxiosPost = jest.fn();
const mockAxiosGet = jest.fn();
jest.mock('axios', () => {
  const fn = (...args: any[]) => mockAxiosFn(...args);
  (fn as any).post = (...args: any[]) => mockAxiosPost(...args);
  (fn as any).get = (...args: any[]) => mockAxiosGet(...args);
  (fn as any).put = jest.fn().mockResolvedValue({ data: {} });
  (fn as any).create = jest.fn().mockReturnValue(fn);
  return { __esModule: true, default: fn, post: (...a: any[]) => mockAxiosPost(...a), get: (...a: any[]) => mockAxiosGet(...a) };
});

jest.mock('../utils/secretsManager', () => ({
  getMetaAccessToken: jest.fn().mockResolvedValue('meta-token'),
  getMetaCredentials: jest.fn().mockResolvedValue({ clientId: 'x', clientSecret: 'y' }),
  getGoogleAdsCredentials: jest.fn().mockResolvedValue({
    clientId: 'g-client',
    clientSecret: 'g-secret',
    developerToken: 'g-dev-token',
  }),
}));

jest.mock('../config/integrations', () => ({
  INTEGRATION_CONFIG: {
    linkedinAds: { apiVersion: '202603', tokenUrl: 'https://www.linkedin.com/oauth/v2/accessToken' },
    meta: { apiVersion: 'v25.0' },
  },
  getLinkedInAdsConfig: jest.fn().mockResolvedValue({ clientId: 'li-id', clientSecret: 'li-secret' }),
}));

jest.mock('../utils/ssrfGuard', () => ({
  assertPublicHostname: jest.fn().mockResolvedValue(undefined),
  SsrfBlockedError: class SsrfBlockedError extends Error {},
}));

jest.mock('../services/connectedAccountsDb', () => ({
  updateAccountTokens: jest.fn().mockResolvedValue(undefined),
  getAccountsWithOwnerIncludingOrgShared: jest.fn().mockResolvedValue([
    {
      userId: 'user-1',
      platform: 'google_ads',
      account_id: '9999999999',
      config: {
        customer_id: '9999999999',
        access_token: 'g-token',
        refresh_token: 'g-refresh',
        token_expires_at: Date.now() + 3600_000,
        login_customer_id: '9999999999',
      },
    },
    {
      userId: 'user-1',
      platform: 'linkedin_ads',
      account_id: '5550001',
      account_name: 'LI Ads',
      config: {
        account_type: 'ad_account',
        access_token: 'li-token',
        refresh_token: 'li-refresh',
        token_expires_at: Date.now() + 3600_000,
      },
    },
  ]),
}));

import { metaService } from '../services/metaService';
import { googleAdsService } from '../services/googleAdsService';
import * as linkedInAdsService from '../services/linkedInAdsService';
import { metaAdReadPort, googleAdReadPort, linkedInAdReadPort } from '../services/adUtmAuditAdapters';
import { auditCampaigns } from '../services/adUtmAuditService';

const USER = 'user-1';

// The exact strings our taggers emit. If these drift, the round-trip tests must
// fail — that is the point.
const META_TAGS = 'utm_source=meta&utm_medium=paid&utm_campaign={{campaign.id}}&utm_content={{ad.id}}';
const GOOGLE_SUFFIX = 'utm_source=google&utm_medium=paid&utm_campaign={campaignid}&utm_content={creative}';
const LI_TAGGED = 'https://example.com/lp?utm_source=linkedin&utm_medium=paid&utm_campaign=777';

/** A Graph API ad row as the SDK hands it back. */
const metaAd = (id: string, campaignId: string, creative: any) => ({
  _data: { id, campaign_id: campaignId, creative },
});

beforeEach(() => {
  jest.clearAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// META
// ─────────────────────────────────────────────────────────────────────────────

describe('Meta — listAdsForUtmAudit reads every site createAdCreative writes', () => {
  const ACCOUNT = '1234567890';

  it('ROUND TRIP: a creative shaped exactly as our tagger produces it audits as tagged', async () => {
    // Precisely what createAdCreative writes for a single-image creative: a PLAIN
    // link_url (no UTMs on it) plus the creative-level url_tags Meta appends at
    // delivery. If the audit cannot see url_tags, this campaign is reported
    // untagged and someone swaps a live creative for nothing.
    mockGetCampaigns.mockResolvedValue([{ _data: { id: 'c1', name: 'Spring Sale' } }]);
    mockGetAds.mockResolvedValue([
      metaAd('ad1', 'c1', {
        id: 'cr1',
        url_tags: META_TAGS,
        object_story_spec: {
          link_data: {
            link: 'https://example.com/landing',
            call_to_action: { type: 'LEARN_MORE', value: { link: 'https://example.com/landing' } },
          },
        },
      }),
    ]);

    const report = await auditCampaigns('meta', USER, ACCOUNT, metaAdReadPort);

    expect(report).toEqual([
      {
        campaignId: 'c1',
        name: 'Spring Sale',
        tagged: true,
        missingKeys: [],
        untaggedAdIds: [],
        unreadableAdIds: [],
      },
    ]);
  });

  it('requests the creative fields the audit depends on, with the listAds status filter', async () => {
    mockGetAds.mockResolvedValue([]);
    await metaService.listAdsForUtmAudit(ACCOUNT, 'tok');

    const [fields, params] = mockGetAds.mock.calls[0];
    expect(fields).toContain('id');
    expect(fields).toContain('campaign_id');
    expect(fields).toContain('creative{id,link_url,url_tags,object_story_spec,asset_feed_spec}');
    // Ads paused at campaign/adset level must not be silently omitted from the audit.
    expect(params.effective_status).toEqual(
      expect.arrayContaining(['ACTIVE', 'PAUSED', 'CAMPAIGN_PAUSED', 'ADSET_PAUSED']),
    );
  });

  it('extracts ALL carousel child_attachments[].link (3 cards → 3 URLs)', async () => {
    mockGetAds.mockResolvedValue([
      metaAd('ad1', 'c1', {
        id: 'cr1',
        object_story_spec: {
          link_data: {
            link: 'https://example.com/fallback',
            child_attachments: [
              { link: 'https://example.com/card1' },
              { link: 'https://example.com/card2' },
              { link: 'https://example.com/card3' },
            ],
          },
        },
      }),
    ]);

    const ads = await metaService.listAdsForUtmAudit('1234567890', 'tok');

    expect(ads[0].destinationUrls).toEqual(
      expect.arrayContaining([
        'https://example.com/card1',
        'https://example.com/card2',
        'https://example.com/card3',
      ]),
    );
    // …and the fallback link too — Meta serves it when a card has none.
    expect(ads[0].destinationUrls).toContain('https://example.com/fallback');
    expect(ads[0].destinationUrls).toHaveLength(4);
  });

  it('a single untagged carousel card makes the campaign untagged (hole in attribution)', async () => {
    mockGetCampaigns.mockResolvedValue([{ _data: { id: 'c1', name: 'Carousel' } }]);
    mockGetAds.mockResolvedValue([
      metaAd('ad1', 'c1', {
        id: 'cr1',
        // No url_tags. Two cards tagged by hand, one not.
        object_story_spec: {
          link_data: {
            child_attachments: [
              { link: 'https://example.com/a?utm_source=meta&utm_medium=paid&utm_campaign=x' },
              { link: 'https://example.com/b?utm_source=meta&utm_medium=paid&utm_campaign=x' },
              { link: 'https://example.com/c' },
            ],
          },
        },
      }),
    ]);

    const [report] = await auditCampaigns('meta', USER, '1234567890', metaAdReadPort);

    expect(report.tagged).toBe(false);
    expect(report.untaggedAdIds).toEqual(['ad1']);
    expect(report.missingKeys).toEqual(['utm_source', 'utm_medium', 'utm_campaign']);
  });

  it('extracts asset_feed_spec.link_urls[].website_url (placement-customized creative)', async () => {
    mockGetAds.mockResolvedValue([
      metaAd('ad1', 'c1', {
        id: 'cr1',
        object_story_spec: { page_id: 'p1' },
        asset_feed_spec: {
          link_urls: [
            { website_url: 'https://example.com/feed-lp' },
            { website_url: 'https://example.com/story-lp' },
          ],
        },
      }),
    ]);

    const ads = await metaService.listAdsForUtmAudit('1234567890', 'tok');

    expect(ads[0].destinationUrls).toEqual([
      'https://example.com/feed-lp',
      'https://example.com/story-lp',
    ]);
  });

  it('extracts creative.link_url, link_data CTA link, and video_data CTA link; dedupes', async () => {
    mockGetAds.mockResolvedValue([
      metaAd('ad1', 'c1', {
        id: 'cr1',
        link_url: 'https://example.com/top-level',
        object_story_spec: {
          video_data: {
            video_id: 'v1',
            call_to_action: { type: 'SHOP_NOW', value: { link: 'https://example.com/video-cta' } },
          },
          link_data: {
            link: 'https://example.com/top-level', // duplicate of creative.link_url
            call_to_action: { value: { link: 'https://example.com/link-cta' } },
          },
        },
      }),
    ]);

    const ads = await metaService.listAdsForUtmAudit('1234567890', 'tok');

    expect(ads[0].destinationUrls.sort()).toEqual([
      'https://example.com/link-cta',
      'https://example.com/top-level',
      'https://example.com/video-cta',
    ]);
    expect(ads[0].adId).toBe('ad1');
    expect(ads[0].campaignId).toBe('c1');
  });

  it('surfaces creative.url_tags as urlTags / appendField', async () => {
    mockGetAds.mockResolvedValue([
      metaAd('ad1', 'c1', { id: 'cr1', url_tags: META_TAGS, link_url: 'https://example.com/x' }),
    ]);

    const ads = await metaService.listAdsForUtmAudit('1234567890', 'tok');
    expect(ads[0].urlTags).toBe(META_TAGS);
  });

  it('an ad with no extractable URL yields destinationUrls: [] and audits as unreadable (never a placeholder)', async () => {
    mockGetCampaigns.mockResolvedValue([{ _data: { id: 'c1', name: 'Odd' } }]);
    mockGetAds.mockResolvedValue([
      // A creative we cannot read a destination from at all (e.g. a lead-gen form ad).
      metaAd('ad1', 'c1', { id: 'cr1', object_story_spec: { page_id: 'p1' } }),
    ]);

    const ads = await metaService.listAdsForUtmAudit('1234567890', 'tok');
    expect(ads[0].destinationUrls).toEqual([]);

    const [report] = await auditCampaigns('meta', USER, '1234567890', metaAdReadPort);
    // Unreadable, NOT untagged: acting on a false "untagged" swaps a live creative.
    expect(report.unreadableAdIds).toEqual(['ad1']);
    expect(report.untaggedAdIds).toEqual([]);
    expect(report.tagged).toBe(false);
  });

  it('port scopes ads to the campaign under audit even if the platform filter is ignored', async () => {
    mockGetCampaigns.mockResolvedValue([{ _data: { id: 'c1', name: 'One' } }]);
    mockGetAds.mockResolvedValue([
      metaAd('ad1', 'c1', { id: 'cr1', link_url: 'https://example.com/a' }),
      metaAd('ad2', 'c2', { id: 'cr2', link_url: 'https://example.com/b' }), // other campaign
    ]);

    const ads = await metaAdReadPort.listAdDestinations(USER, '1234567890', 'c1');
    expect(ads.map((a) => a.adId)).toEqual(['ad1']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GOOGLE
// ─────────────────────────────────────────────────────────────────────────────

describe('Google — listAdsForUtmAudit and final_url_suffix inheritance', () => {
  const CUSTOMER = '9999999999';

  /** Route the three GAQL queries the Google port issues. */
  const mockGaql = (opts: { campaigns?: any[]; adRows?: any[]; assetGroupRows?: any[] }) => {
    mockAxiosPost.mockImplementation(async (_url: string, body: any) => {
      const q = String(body?.query ?? '');
      if (q.includes('FROM ad_group_ad')) return { data: { results: opts.adRows ?? [] } };
      if (q.includes('FROM asset_group')) return { data: { results: opts.assetGroupRows ?? [] } };
      return { data: { results: opts.campaigns ?? [] } };
    });
  };

  const campaignRow = (id: string, name: string) => ({
    campaign: { resourceName: `customers/${CUSTOMER}/campaigns/${id}`, id, name, status: 'ENABLED', advertisingChannelType: 'SEARCH' },
  });

  it('ROUND TRIP: an ad shaped exactly as our tagger produces it audits as tagged', async () => {
    // createAd writes finalUrlSuffix and leaves finalUrls plain. If the audit does
    // not read the suffix, this healthy campaign is reported untagged.
    mockGaql({
      campaigns: [campaignRow('111', 'Search — Brand')],
      adRows: [
        {
          campaign: { id: '111', name: 'Search — Brand' },
          adGroupAd: { ad: { id: '5001', finalUrls: ['https://example.com/lp'], finalUrlSuffix: GOOGLE_SUFFIX } },
        },
      ],
    });

    const report = await auditCampaigns('google', USER, CUSTOMER, googleAdReadPort);

    expect(report).toEqual([
      { campaignId: '111', name: 'Search — Brand', tagged: true, missingKeys: [], untaggedAdIds: [], unreadableAdIds: [] },
    ]);
  });

  it('INHERITANCE: an ad with no suffix inherits the campaign suffix → campaign reports tagged', async () => {
    mockGaql({
      campaigns: [campaignRow('111', 'Inherits')],
      adRows: [
        {
          campaign: { id: '111', name: 'Inherits', finalUrlSuffix: GOOGLE_SUFFIX },
          adGroupAd: { ad: { id: '5001', finalUrls: ['https://example.com/lp'] } }, // no ad-level suffix
        },
      ],
    });

    const ads = await googleAdsService.listAdsForUtmAudit(USER, CUSTOMER);
    expect(ads[0].appendField).toBe(GOOGLE_SUFFIX);

    const [report] = await auditCampaigns('google', USER, CUSTOMER, googleAdReadPort);
    expect(report.tagged).toBe(true);
    expect(report.untaggedAdIds).toEqual([]);
  });

  it('OVERRIDE: an ad-level suffix REPLACES the campaign-level one (never concatenated)', async () => {
    mockGaql({
      adRows: [
        {
          campaign: { id: '111', name: 'Override', finalUrlSuffix: 'utm_source=google&utm_medium=paid&utm_campaign=campaign-level' },
          adGroupAd: { ad: { id: '5001', finalUrls: ['https://example.com/lp'], finalUrlSuffix: 'utm_source=google&utm_medium=paid&utm_campaign=ad-level' } },
        },
      ],
    });

    const ads = await googleAdsService.listAdsForUtmAudit(USER, CUSTOMER);

    expect(ads[0].appendField).toBe('utm_source=google&utm_medium=paid&utm_campaign=ad-level');
    expect(ads[0].appendField).not.toContain('campaign-level');
  });

  it('AD-GROUP INHERITANCE: an ad with no ad-level suffix inherits its AD GROUP\'s suffix, not just the campaign\'s (Greptile)', async () => {
    // retagAdUtm/updateAd now correctly write and inherit ad-group-level
    // final_url_suffix (the level between ad and campaign). The audit's
    // appendField computation must read it too, or a healthy ad-group-tagged
    // campaign gets reported as a false-positive "untagged".
    mockGaql({
      adRows: [
        {
          campaign: { id: '111', name: 'AdGroup Inherits' }, // no campaign-level suffix
          adGroup: { finalUrlSuffix: GOOGLE_SUFFIX },
          adGroupAd: { ad: { id: '5001', finalUrls: ['https://example.com/lp'] } }, // no ad-level suffix
        },
      ],
    });

    const ads = await googleAdsService.listAdsForUtmAudit(USER, CUSTOMER);
    expect(ads[0].appendField).toBe(GOOGLE_SUFFIX);
  });

  it('returns ALL of an ad\'s finalUrls, not just the first', async () => {
    mockGaql({
      adRows: [
        {
          campaign: { id: '111', name: 'Multi' },
          adGroupAd: {
            ad: {
              id: '5001',
              finalUrls: ['https://example.com/a', 'https://example.com/b', 'https://example.com/c'],
              finalUrlSuffix: GOOGLE_SUFFIX,
            },
          },
        },
      ],
    });

    const ads = await googleAdsService.listAdsForUtmAudit(USER, CUSTOMER);

    expect(ads[0].destinationUrls).toEqual([
      'https://example.com/a',
      'https://example.com/b',
      'https://example.com/c',
    ]);
    expect(ads[0].campaignId).toBe('111');
    expect(ads[0].campaignName).toBe('Multi');
  });

  it('selects campaign + ad suffix and final_urls in a single ad_group_ad GAQL', async () => {
    mockGaql({ adRows: [] });
    await googleAdsService.listAdsForUtmAudit(USER, CUSTOMER);

    const query = String(mockAxiosPost.mock.calls[0][1].query);
    expect(query).toContain('campaign.id');
    expect(query).toContain('campaign.name');
    expect(query).toContain('campaign.final_url_suffix');
    expect(query).toContain('ad_group_ad.ad.id');
    expect(query).toContain('ad_group_ad.ad.final_urls');
    expect(query).toContain('ad_group_ad.ad.final_url_suffix');
    expect(query).toContain('FROM ad_group_ad');
  });

  it('an ad with no final_urls yields destinationUrls: [] → unreadable, not untagged', async () => {
    mockGaql({
      campaigns: [campaignRow('111', 'No URLs')],
      adRows: [{ campaign: { id: '111', name: 'No URLs' }, adGroupAd: { ad: { id: '5001' } } }],
    });

    const ads = await googleAdsService.listAdsForUtmAudit(USER, CUSTOMER);
    expect(ads[0].destinationUrls).toEqual([]);

    const [report] = await auditCampaigns('google', USER, CUSTOMER, googleAdReadPort);
    expect(report.unreadableAdIds).toEqual(['5001']);
    expect(report.untaggedAdIds).toEqual([]);
  });

  it('reports a genuinely untagged campaign (no suffix anywhere, plain final URL)', async () => {
    mockGaql({
      campaigns: [campaignRow('111', 'Untagged')],
      adRows: [{ campaign: { id: '111', name: 'Untagged' }, adGroupAd: { ad: { id: '5001', finalUrls: ['https://example.com/lp'] } } }],
    });

    const [report] = await auditCampaigns('google', USER, CUSTOMER, googleAdReadPort);

    expect(report.tagged).toBe(false);
    expect(report.untaggedAdIds).toEqual(['5001']);
    expect(report.missingKeys).toEqual(['utm_source', 'utm_medium', 'utm_campaign']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GOOGLE — PMax asset groups
//
// A PMax campaign has NO ad_group_ads: its destinations live on `asset_group.final_urls`.
// An audit that only reads ad_group_ad sees zero ads and reports the campaign
// `tagged: true` VACUOUSLY — a clean bill of health for a campaign it never looked at.
// That is the single most dangerous output this report can produce: the team trusts the
// list and skips a client who genuinely has no attribution.
// ─────────────────────────────────────────────────────────────────────────────

describe('Google — PMax asset groups are audited, never vacuously passed', () => {
  const CUSTOMER = '9999999999';

  const mockGaql = (opts: { campaigns?: any[]; adRows?: any[]; assetGroupRows?: any[] }) => {
    mockAxiosPost.mockImplementation(async (_url: string, body: any) => {
      const q = String(body?.query ?? '');
      if (q.includes('FROM ad_group_ad')) return { data: { results: opts.adRows ?? [] } };
      if (q.includes('FROM asset_group')) return { data: { results: opts.assetGroupRows ?? [] } };
      return { data: { results: opts.campaigns ?? [] } };
    });
  };

  const pmaxCampaignRow = (id: string, name: string) => ({
    campaign: { resourceName: `customers/${CUSTOMER}/campaigns/${id}`, id, name, status: 'ENABLED', advertisingChannelType: 'PERFORMANCE_MAX' },
  });

  // Exactly what createAssetGroup writes (googleAdsService:1072) — mergeUtmIntoUrl bakes the
  // UTMs straight into the final URL, because asset_group has no final_url_suffix field.
  const BAKED_URL =
    'https://example.com/lp?utm_source=google&utm_medium=paid&utm_campaign={campaignid}&utm_content={creative}';

  it('ROUND TRIP: an asset group with UTMs baked into final_urls audits as tagged', async () => {
    mockGaql({
      campaigns: [pmaxCampaignRow('222', 'PMax — Prospecting')],
      adRows: [], // PMax has no ad_group_ads. This is the case that used to pass vacuously.
      assetGroupRows: [
        {
          campaign: { id: '222', name: 'PMax — Prospecting' },
          assetGroup: { id: '8001', finalUrls: [BAKED_URL] },
        },
      ],
    });

    // The asset group must actually be READ — a campaign with zero ads also reports
    // tagged:true (vacuously), so asserting only on `tagged` would pass even with no
    // asset-group support at all. Pin the asset group as an audited destination first.
    const rows = await googleAdsService.listAdsForUtmAudit(USER, CUSTOMER);
    expect(rows).toEqual([
      {
        adId: 'assetGroup/8001',
        campaignId: '222',
        campaignName: 'PMax — Prospecting',
        destinationUrls: [BAKED_URL],
        appendField: undefined, // no campaign suffix set, and asset groups have none of their own
      },
    ]);

    const port = await googleAdReadPort.listAdDestinations(USER, CUSTOMER, '222');
    expect(port).toEqual([
      { adId: 'assetGroup/8001', destinationUrls: [BAKED_URL], appendField: undefined },
    ]);

    const report = await auditCampaigns('google', USER, CUSTOMER, googleAdReadPort);

    expect(report).toEqual([
      { campaignId: '222', name: 'PMax — Prospecting', tagged: true, missingKeys: [], untaggedAdIds: [], unreadableAdIds: [] },
    ]);
  });

  it('THE INVISIBLE CASE: an asset group with NO UTMs is reported untagged (not vacuously tagged)', async () => {
    mockGaql({
      campaigns: [pmaxCampaignRow('222', 'PMax — Untagged')],
      adRows: [],
      assetGroupRows: [
        {
          campaign: { id: '222', name: 'PMax — Untagged' },
          assetGroup: { id: '8001', finalUrls: ['https://example.com/lp'] },
        },
      ],
    });

    const [report] = await auditCampaigns('google', USER, CUSTOMER, googleAdReadPort);

    // Before asset-group coverage this campaign came back tagged:true with zero ads —
    // a client with no attribution at all, reported healthy.
    expect(report.tagged).toBe(false);
    expect(report.untaggedAdIds).toEqual(['assetGroup/8001']);
    expect(report.missingKeys).toEqual(['utm_source', 'utm_medium', 'utm_campaign']);
  });

  it('asset-group appendField is the CAMPAIGN suffix only — asset_group has no suffix field of its own', async () => {
    mockGaql({
      assetGroupRows: [
        {
          campaign: { id: '222', name: 'PMax', finalUrlSuffix: GOOGLE_SUFFIX },
          assetGroup: { id: '8001', finalUrls: ['https://example.com/lp'] },
        },
      ],
    });

    const rows = await googleAdsService.listAdsForUtmAudit(USER, CUSTOMER);
    const assetGroup = rows.find((r) => r.adId === 'assetGroup/8001')!;

    // Campaign-level suffix DOES apply to a PMax campaign's asset-group URLs, so it counts.
    expect(assetGroup.appendField).toBe(GOOGLE_SUFFIX);
    expect(assetGroup.destinationUrls).toEqual(['https://example.com/lp']);

    // …and a campaign suffix alone is enough to make it tagged.
    mockGaql({
      campaigns: [pmaxCampaignRow('222', 'PMax')],
      assetGroupRows: [
        {
          campaign: { id: '222', name: 'PMax', finalUrlSuffix: GOOGLE_SUFFIX },
          assetGroup: { id: '8001', finalUrls: ['https://example.com/lp'] },
        },
      ],
    });
    const [report] = await auditCampaigns('google', USER, CUSTOMER, googleAdReadPort);
    expect(report.tagged).toBe(true);
  });

  it('selects campaign suffix + asset_group final_urls in the asset_group GAQL', async () => {
    mockGaql({ adRows: [], assetGroupRows: [] });
    await googleAdsService.listAdsForUtmAudit(USER, CUSTOMER);

    const queries = mockAxiosPost.mock.calls.map((c: any[]) => String(c[1].query));
    const assetGroupQuery = queries.find((q) => q.includes('FROM asset_group'))!;

    expect(assetGroupQuery).toContain('campaign.id');
    expect(assetGroupQuery).toContain('campaign.name');
    expect(assetGroupQuery).toContain('campaign.final_url_suffix');
    expect(assetGroupQuery).toContain('asset_group.id');
    expect(assetGroupQuery).toContain('asset_group.final_urls');
    // asset_group.final_url_suffix does not exist in the Google Ads API — selecting it
    // would make the whole GAQL fail and take the audit down with it.
    expect(assetGroupQuery).not.toContain('asset_group.final_url_suffix');
  });

  it('a campaign with BOTH ad_group_ads and asset groups surfaces both', async () => {
    mockGaql({
      campaigns: [pmaxCampaignRow('222', 'Hybrid')],
      adRows: [
        {
          campaign: { id: '222', name: 'Hybrid' },
          adGroupAd: { ad: { id: '5001', finalUrls: ['https://example.com/ad'], finalUrlSuffix: GOOGLE_SUFFIX } },
        },
      ],
      assetGroupRows: [
        {
          campaign: { id: '222', name: 'Hybrid' },
          assetGroup: { id: '8001', finalUrls: ['https://example.com/ag'] }, // untagged
        },
      ],
    });

    const rows = await googleAdsService.listAdsForUtmAudit(USER, CUSTOMER);
    expect(rows.map((r) => r.adId).sort()).toEqual(['5001', 'assetGroup/8001']);

    const [report] = await auditCampaigns('google', USER, CUSTOMER, googleAdReadPort);
    // The tagged ad does not excuse the untagged asset group.
    expect(report.tagged).toBe(false);
    expect(report.untaggedAdIds).toEqual(['assetGroup/8001']);
  });

  it('an asset group with no final_urls yields destinationUrls: [] → unreadable, not untagged', async () => {
    mockGaql({
      campaigns: [pmaxCampaignRow('222', 'PMax')],
      assetGroupRows: [{ campaign: { id: '222', name: 'PMax' }, assetGroup: { id: '8001' } }],
    });

    const [report] = await auditCampaigns('google', USER, CUSTOMER, googleAdReadPort);

    expect(report.unreadableAdIds).toEqual(['assetGroup/8001']);
    expect(report.untaggedAdIds).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// LINKEDIN
// ─────────────────────────────────────────────────────────────────────────────

describe('LinkedIn — listAdsForUtmAudit reads every shape appendLinkedInUtm writes', () => {
  const ACCOUNT = '5550001';

  /** Route LinkedIn REST reads by path. */
  const mockLi = (opts: { campaigns?: any[]; creatives?: any[] }) => {
    mockAxiosFn.mockImplementation(async (config: any) => {
      const url = String(config.url);
      if (url.includes('/adCampaigns')) {
        return { data: { elements: opts.campaigns ?? [] }, status: 200, headers: {} };
      }
      if (url.includes('/creatives')) {
        return { data: { elements: opts.creatives ?? [] }, status: 200, headers: {} };
      }
      return { data: {}, status: 200, headers: {} };
    });
  };

  it('ROUND TRIP: URLs shaped as appendLinkedInUtm produces them audit as tagged (appendField undefined)', async () => {
    mockLi({
      campaigns: [{ id: 777, name: 'LI Campaign' }],
      creatives: [
        {
          id: 'urn:li:sponsoredCreative:1',
          campaign: 'urn:li:sponsoredCampaign:777',
          content: { textAd: { headline: 'Hi', landingPage: LI_TAGGED } },
        },
      ],
    });

    const report = await auditCampaigns('linkedin', USER, ACCOUNT, linkedInAdReadPort);

    expect(report).toEqual([
      { campaignId: '777', name: 'LI Campaign', tagged: true, missingKeys: [], untaggedAdIds: [], unreadableAdIds: [] },
    ]);

    const ads = await linkedInAdsService.listAdsForUtmAudit('li-token', ACCOUNT, '777');
    // LinkedIn has no native append field — inventing one would be a lie.
    expect(ads[0].appendField).toBeUndefined();
  });

  it('extracts carousel card landingPage AND contentLandingPage', async () => {
    mockLi({
      creatives: [
        {
          id: 'urn:li:sponsoredCreative:2',
          campaign: 'urn:li:sponsoredCampaign:777',
          content: {
            carousel: {
              cards: [
                { landingPage: 'https://example.com/card1' },
                { landingPage: 'https://example.com/card2' },
              ],
            },
          },
          contentLandingPage: 'https://example.com/content-lp',
        },
      ],
    });

    const ads = await linkedInAdsService.listAdsForUtmAudit('li-token', ACCOUNT, '777');

    expect(ads[0].destinationUrls).toEqual(
      expect.arrayContaining([
        'https://example.com/card1',
        'https://example.com/card2',
        'https://example.com/content-lp',
      ]),
    );
    expect(ads[0].adId).toBe('urn:li:sponsoredCreative:2');
    expect(ads[0].campaignId).toBe('777');
  });

  it('extracts the spotlight (dynamic ad) landingPage', async () => {
    mockLi({
      creatives: [
        {
          id: 'urn:li:sponsoredCreative:3',
          campaign: 'urn:li:sponsoredCampaign:777',
          content: { spotlight: { headline: 'Hey', callToAction: 'Learn', landingPage: 'https://example.com/spotlight' } },
        },
      ],
    });

    const ads = await linkedInAdsService.listAdsForUtmAudit('li-token', ACCOUNT, '777');
    expect(ads[0].destinationUrls).toEqual(['https://example.com/spotlight']);
  });

  it('extracts the InMail callToActionLandingPageUrl and conversation-ad button landing pages', async () => {
    mockLi({
      creatives: [
        {
          id: 'urn:li:sponsoredCreative:4',
          campaign: 'urn:li:sponsoredCampaign:777',
          content: {
            inMail: { subContent: { regular: { callToActionLandingPageUrl: 'https://example.com/inmail-cta' } } },
          },
        },
        {
          id: 'urn:li:sponsoredCreative:5',
          campaign: 'urn:li:sponsoredCampaign:777',
          content: {
            sponsoredMessageContent: {
              buttons: [
                { text: 'A', landingPage: 'https://example.com/btn-a' },
                { text: 'B', landingPage: 'https://example.com/btn-b' },
              ],
            },
          },
        },
      ],
    });

    const ads = await linkedInAdsService.listAdsForUtmAudit('li-token', ACCOUNT, '777');

    expect(ads[0].destinationUrls).toEqual(['https://example.com/inmail-cta']);
    expect(ads[1].destinationUrls).toEqual(['https://example.com/btn-a', 'https://example.com/btn-b']);
  });

  it('an untagged landing page is reported untagged', async () => {
    mockLi({
      campaigns: [{ id: 777, name: 'LI Campaign' }],
      creatives: [
        {
          id: 'urn:li:sponsoredCreative:6',
          campaign: 'urn:li:sponsoredCampaign:777',
          content: { textAd: { landingPage: 'https://example.com/plain' } },
        },
      ],
    });

    const [report] = await auditCampaigns('linkedin', USER, ACCOUNT, linkedInAdReadPort);

    expect(report.tagged).toBe(false);
    expect(report.untaggedAdIds).toEqual(['urn:li:sponsoredCreative:6']);
  });

  it('a creative that only references a post yields destinationUrls: [] → unreadable, never a placeholder', async () => {
    mockLi({
      campaigns: [{ id: 777, name: 'LI Campaign' }],
      creatives: [
        {
          id: 'urn:li:sponsoredCreative:7',
          campaign: 'urn:li:sponsoredCampaign:777',
          content: { reference: 'urn:li:share:12345' },
        },
      ],
    });

    const [report] = await auditCampaigns('linkedin', USER, ACCOUNT, linkedInAdReadPort);

    expect(report.unreadableAdIds).toEqual(['urn:li:sponsoredCreative:7']);
    expect(report.untaggedAdIds).toEqual([]);
  });
});
