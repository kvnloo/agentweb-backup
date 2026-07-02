/**
 * Tests for linkedInAdsService.ts — raw API client
 */

const mockAxiosPost = jest.fn();
const mockAxiosGet = jest.fn();
const mockAxiosFn = jest.fn();

jest.mock('axios', () => {
  const fn = (...args: any[]) => mockAxiosFn(...args);
  (fn as any).post = (...args: any[]) => mockAxiosPost(...args);
  (fn as any).get = (...args: any[]) => mockAxiosGet(...args);
  (fn as any).put = jest.fn().mockResolvedValue({ data: {} });
  (fn as any).create = jest.fn().mockReturnValue(fn);
  return { __esModule: true, default: fn };
});

jest.mock('../config/integrations', () => ({
  INTEGRATION_CONFIG: {
    linkedinAds: {
      apiVersion: '202603',
      tokenUrl: 'https://www.linkedin.com/oauth/v2/accessToken',
    },
  },
}));

import * as svc from '../services/linkedInAdsService';

const ACCESS_TOKEN = 'test-access-token';
const ACCOUNT_ID = '123456789';

beforeEach(() => {
  jest.clearAllMocks();
  mockAxiosFn.mockResolvedValue({ data: { elements: [] }, status: 200 });
  mockAxiosPost.mockResolvedValue({
    data: { access_token: 'new-token', refresh_token: 'new-refresh', expires_in: 5183944 },
  });
});

describe('refreshAccessToken', () => {
  it('calls token endpoint with correct params', async () => {
    await svc.refreshAccessToken('old-refresh', 'client-id', 'client-secret');
    expect(mockAxiosPost).toHaveBeenCalledWith(
      'https://www.linkedin.com/oauth/v2/accessToken',
      null,
      expect.objectContaining({
        params: expect.objectContaining({
          grant_type: 'refresh_token',
          refresh_token: 'old-refresh',
          client_id: 'client-id',
          client_secret: 'client-secret',
        }),
      })
    );
  });

  it('returns new token data', async () => {
    const result = await svc.refreshAccessToken('r', 'c', 's');
    expect(result).toEqual({ access_token: 'new-token', refresh_token: 'new-refresh', expires_in: 5183944 });
  });

  it('throws if access_token missing from response', async () => {
    mockAxiosPost.mockResolvedValue({ data: { refresh_token: 'r' } });
    await expect(svc.refreshAccessToken('r', 'c', 's')).rejects.toThrow('no access_token');
  });
});

describe('listAdAccounts', () => {
  it('makes GET request to adAccounts endpoint', async () => {
    await svc.listAdAccounts(ACCESS_TOKEN);
    expect(mockAxiosFn).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'GET',
        url: expect.stringContaining('/rest/adAccounts'),
        headers: expect.objectContaining({
          Authorization: `Bearer ${ACCESS_TOKEN}`,
          'LinkedIn-Version': '202603',
        }),
      })
    );
  });

  it('returns success result', async () => {
    mockAxiosFn.mockResolvedValue({ data: { elements: [{ id: '1' }] }, status: 200 });
    const result = await svc.listAdAccounts(ACCESS_TOKEN);
    expect(result.success).toBe(true);
    expect(result.data.elements).toHaveLength(1);
  });

  it('returns failure on API error', async () => {
    mockAxiosFn.mockRejectedValue({
      response: { status: 403, data: { message: 'Forbidden' } },
    });
    const result = await svc.listAdAccounts(ACCESS_TOKEN);
    expect(result.success).toBe(false);
    expect(result.status).toBe(403);
  });
});

describe('listCampaignGroups', () => {
  it('makes GET to adCampaignGroups nested under account', async () => {
    await svc.listCampaignGroups(ACCESS_TOKEN, ACCOUNT_ID);
    expect(mockAxiosFn).toHaveBeenCalledWith(
      expect.objectContaining({
        url: expect.stringContaining(`/rest/adAccounts/${ACCOUNT_ID}/adCampaignGroups`),
      })
    );
  });
});

describe('createCampaignGroup', () => {
  const RUN_START = 1700000000000;

  it('makes POST with account URN and name', async () => {
    await svc.createCampaignGroup(ACCESS_TOKEN, ACCOUNT_ID, { name: 'My Group', status: 'ACTIVE', run_schedule_start: RUN_START });
    expect(mockAxiosFn).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'POST',
        url: expect.stringContaining(`/rest/adAccounts/${ACCOUNT_ID}/adCampaignGroups`),
        data: expect.objectContaining({
          account: `urn:li:sponsoredAccount:${ACCOUNT_ID}`,
          name: 'My Group',
          status: 'ACTIVE',
        }),
      })
    );
  });

  it('includes budget when provided', async () => {
    await svc.createCampaignGroup(ACCESS_TOKEN, ACCOUNT_ID, {
      name: 'G',
      total_budget_amount: 1000,
      total_budget_currency: 'USD',
      run_schedule_start: RUN_START,
    });
    expect(mockAxiosFn).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          totalBudget: { amount: '1000', currencyCode: 'USD' },
        }),
      })
    );
  });

  it('throws when run_schedule_start is missing', async () => {
    await expect(svc.createCampaignGroup(ACCESS_TOKEN, ACCOUNT_ID, { name: 'G' }))
      .rejects.toThrow('run_schedule_start is required');
  });
});

describe('updateCampaignGroup', () => {
  it('sends PARTIAL_UPDATE header', async () => {
    await svc.updateCampaignGroup(ACCESS_TOKEN, ACCOUNT_ID, 'cg-1', { status: 'PAUSED' });
    expect(mockAxiosFn).toHaveBeenCalledWith(
      expect.objectContaining({
        headers: expect.objectContaining({ 'X-RestLi-Method': 'PARTIAL_UPDATE' }),
        data: expect.objectContaining({ patch: { $set: { status: 'PAUSED' } } }),
      })
    );
  });
});

describe('listCampaigns', () => {
  it('makes GET to adCampaigns under account', async () => {
    await svc.listCampaigns(ACCESS_TOKEN, ACCOUNT_ID);
    expect(mockAxiosFn).toHaveBeenCalledWith(
      expect.objectContaining({
        url: expect.stringContaining(`/rest/adAccounts/${ACCOUNT_ID}/adCampaigns`),
      })
    );
  });

  it('includes campaignGroup filter when provided', async () => {
    await svc.listCampaigns(ACCESS_TOKEN, ACCOUNT_ID, { campaign_group_id: 'cg-99' });
    const call = mockAxiosFn.mock.calls[0][0];
    expect(call.url).toContain('urn%3Ali%3AsponsoredCampaignGroup%3Acg-99');
  });
});

describe('createCampaign', () => {
  it('posts campaign with account URN', async () => {
    await svc.createCampaign(ACCESS_TOKEN, ACCOUNT_ID, { name: 'Camp 1', cost_type: 'CPC' });
    expect(mockAxiosFn).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'POST',
        data: expect.objectContaining({
          account: `urn:li:sponsoredAccount:${ACCOUNT_ID}`,
          name: 'Camp 1',
        }),
      })
    );
  });

  it('returns error when creating a DYNAMIC campaign without a format', async () => {
    const result = await svc.createCampaign(ACCESS_TOKEN, ACCOUNT_ID, { name: 'Camp Dyn', type: 'DYNAMIC' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('format is required when campaign type is DYNAMIC');
  });
});

describe('makeRequest — LinkedIn account-access error enrichment', () => {
  const RAW_ACCOUNT_ACCESS_ERROR =
    'Your application is not configured to access the related advertiser account(s), please ensure you have added the account ID(s) in your Account Management list.';

  it('rewrites the raw LinkedIn account-access error with AgentWeb-side guidance', async () => {
    mockAxiosFn.mockRejectedValue({
      response: { status: 403, data: { message: RAW_ACCOUNT_ACCESS_ERROR } },
    });
    const result = await svc.createCampaign(ACCESS_TOKEN, ACCOUNT_ID, { name: 'Camp 1' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('AgentWeb platform configuration');
    expect(result.error).toContain('does not have their own');
    expect(result.error).toContain('contact AgentWeb support');
  });

  it('includes the ad account id extracted from the request path', async () => {
    mockAxiosFn.mockRejectedValue({
      response: { status: 403, data: { message: RAW_ACCOUNT_ACCESS_ERROR } },
    });
    const result = await svc.createCampaign(ACCESS_TOKEN, ACCOUNT_ID, { name: 'Camp 1' });
    expect(result.error).toContain(ACCOUNT_ID);
  });

  it('includes the ad account id from the request body when the path has no /adAccounts/ segment', async () => {
    mockAxiosFn.mockRejectedValue({
      response: { status: 403, data: { message: RAW_ACCOUNT_ACCESS_ERROR } },
    });
    // POST /rest/conversationAds carries the account only in body.parentAccount
    const result = await svc.createConversationAd(ACCESS_TOKEN, ACCOUNT_ID, { name: 'x' });
    expect(result.error).toContain(ACCOUNT_ID);
  });

  it('matches the LinkedIn error case-insensitively', async () => {
    mockAxiosFn.mockRejectedValue({
      response: { status: 403, data: { message: RAW_ACCOUNT_ACCESS_ERROR.toUpperCase() } },
    });
    const result = await svc.createCampaign(ACCESS_TOKEN, ACCOUNT_ID, { name: 'Camp 1' });
    expect(result.error).toContain('AgentWeb platform configuration');
  });

  it('does not rewrite unrelated LinkedIn errors', async () => {
    mockAxiosFn.mockRejectedValue({
      response: { status: 422, data: { message: 'ERROR :: /name :: unrecognized field found but not allowed' } },
    });
    const result = await svc.createCampaign(ACCESS_TOKEN, ACCOUNT_ID, { name: 'Camp 1' });
    expect(result.error).toBe('ERROR :: /name :: unrecognized field found but not allowed');
  });
});

describe('updateCampaign', () => {
  it('sends PARTIAL_UPDATE for campaign', async () => {
    await svc.updateCampaign(ACCESS_TOKEN, ACCOUNT_ID, 'camp-1', { status: 'PAUSED' });
    expect(mockAxiosFn).toHaveBeenCalledWith(
      expect.objectContaining({
        headers: expect.objectContaining({ 'X-RestLi-Method': 'PARTIAL_UPDATE' }),
      })
    );
  });
});

describe('createCreative', () => {
  it('creates sponsored content creative from post URN', async () => {
    await svc.createCreative(ACCESS_TOKEN, {
      campaign_id: 'camp-1',
      post_urn: 'urn:li:share:999',
      ad_account_id: ACCOUNT_ID,
    });
    expect(mockAxiosFn).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'POST',
        url: expect.stringContaining(`/rest/adAccounts/${ACCOUNT_ID}/creatives`),
        data: expect.objectContaining({
          campaign: 'urn:li:sponsoredCampaign:camp-1',
          content: { reference: 'urn:li:share:999' },
        }),
      })
    );
  });

  it('creates text ad creative from headline', async () => {
    await svc.createCreative(ACCESS_TOKEN, {
      campaign_id: 'camp-1',
      headline: 'Click Here',
      description: 'Ad copy',
      landing_page: 'https://example.com',
      ad_account_id: ACCOUNT_ID,
    });
    const call = mockAxiosFn.mock.calls[0][0];
    expect(call.data.content.textAd).toMatchObject({
      headline: 'Click Here',
      description: 'Ad copy',
      landingPage: 'https://example.com',
    });
  });

  it('returns error when no creative type provided', async () => {
    const result = await svc.createCreative(ACCESS_TOKEN, { campaign_id: 'camp-1', ad_account_id: ACCOUNT_ID });
    expect(result.success).toBe(false);
    expect(result.error).toContain('CREATIVE CREATE requires');
  });

  it('returns error when ad_account_id is missing', async () => {
    const result = await svc.createCreative(ACCESS_TOKEN, { campaign_id: 'camp-1', post_urn: 'urn:li:share:999' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('ad_account_id');
  });
});

describe('createCreativeInline', () => {
  it('posts to creatives?action=createInline endpoint', async () => {
    await svc.createCreativeInline(ACCESS_TOKEN, {
      ad_account_id: ACCOUNT_ID,
      campaign_id: 'camp-1',
      author_urn: 'urn:li:organization:org-1',
      commentary: 'Check this out',
    });
    expect(mockAxiosFn).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'POST',
        url: expect.stringContaining(`/rest/adAccounts/${ACCOUNT_ID}/creatives?action=createInline`),
        data: expect.objectContaining({
          creative: expect.objectContaining({
            campaign: 'urn:li:sponsoredCampaign:camp-1',
            intendedStatus: 'ACTIVE',
          }),
        }),
      })
    );
  });

  it('includes image content when image_urn provided', async () => {
    await svc.createCreativeInline(ACCESS_TOKEN, {
      ad_account_id: ACCOUNT_ID,
      campaign_id: 'camp-1',
      author_urn: 'urn:li:organization:org-1',
      image_urn: 'urn:li:image:img-1',
      title: 'My Ad',
    });
    const call = mockAxiosFn.mock.calls[0][0];
    expect(call.data.creative.inlineContent.post.content).toMatchObject({
      media: { id: 'urn:li:image:img-1', title: 'My Ad' },
    });
  });

  it('returns error when ad_account_id missing', async () => {
    const result = await svc.createCreativeInline(ACCESS_TOKEN, { campaign_id: 'camp-1', author_urn: 'urn:li:organization:org-1' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('ad_account_id');
  });

  it('returns error when campaign_id missing', async () => {
    const result = await svc.createCreativeInline(ACCESS_TOKEN, { ad_account_id: ACCOUNT_ID, author_urn: 'urn:li:organization:org-1' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('campaign_id');
  });

  it('returns error when author_urn missing', async () => {
    const result = await svc.createCreativeInline(ACCESS_TOKEN, { ad_account_id: ACCOUNT_ID, campaign_id: 'camp-1' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('author_urn');
  });
});

describe('createInMailContent', () => {
  const validParams = {
    ad_account_id: ACCOUNT_ID,
    name: 'Test InMail',
    sender: 'urn:li:person:abc123',
    subject: 'Hello from LinkedIn',
    htmlBody: '<p>Check us out</p>',
    callToActionText: 'Learn More',
    callToActionLandingPageUrl: 'https://example.com',
  };

  it('posts to /rest/inMailContents with correct body', async () => {
    await svc.createInMailContent(ACCESS_TOKEN, validParams);
    expect(mockAxiosFn).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'POST',
        url: expect.stringContaining('/rest/inMailContents'),
        data: expect.objectContaining({
          account: `urn:li:sponsoredAccount:${ACCOUNT_ID}`,
          sender: 'urn:li:person:abc123',
          subject: 'Hello from LinkedIn',
          htmlBody: '<p>Check us out</p>',
          subContent: {
            regular: {
              callToActionText: 'Learn More',
              callToActionLandingPageUrl: 'https://example.com',
            },
          },
        }),
      })
    );
  });

  it('returns error when sender missing', async () => {
    const result = await svc.createInMailContent(ACCESS_TOKEN, { ...validParams, sender: '' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('sender');
  });

  it('returns error when subject missing', async () => {
    const result = await svc.createInMailContent(ACCESS_TOKEN, { ...validParams, subject: '' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('subject');
  });

  it('returns error when htmlBody missing', async () => {
    const result = await svc.createInMailContent(ACCESS_TOKEN, { ...validParams, htmlBody: '' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('htmlBody');
  });
});

describe('sendTestInMail', () => {
  it('posts to inMailContents action=sendTestInMail', async () => {
    const inMailUrn = 'urn:li:inMailContent:123';
    await svc.sendTestInMail(ACCESS_TOKEN, inMailUrn, 'test@example.com');
    expect(mockAxiosFn).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'POST',
        url: expect.stringContaining('action=sendTestInMail'),
        data: expect.objectContaining({ recipient: 'test@example.com' }),
      })
    );
  });

  it('encodes the inMailContent URN in the URL', async () => {
    await svc.sendTestInMail(ACCESS_TOKEN, 'urn:li:inMailContent:456', 'a@b.com');
    const call = mockAxiosFn.mock.calls[0][0];
    expect(call.url).toContain(encodeURIComponent('urn:li:inMailContent:456'));
  });
});

describe('createPost', () => {
  it('creates dark post with feedDistribution NONE', async () => {
    await svc.createPost(ACCESS_TOKEN, {
      author_urn: 'urn:li:person:abc123',
      text: 'Hello world',
      visibility: 'PUBLIC',
    });
    expect(mockAxiosFn).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'POST',
        url: expect.stringContaining('/rest/posts'),
        data: expect.objectContaining({
          author: 'urn:li:person:abc123',
          commentary: 'Hello world',
          distribution: expect.objectContaining({ feedDistribution: 'NONE' }),
          lifecycleState: 'PUBLISHED',
        }),
      })
    );
  });
});

describe('searchTargetingEntities', () => {
  it('builds typeahead query when query provided', async () => {
    await svc.searchTargetingEntities(ACCESS_TOKEN, {
      facet_urn: 'urn:li:adTargetingFacet:locations',
      query: 'New York',
    });
    const call = mockAxiosFn.mock.calls[0][0];
    expect(call.url).toContain('q=typeahead');
    expect(call.url).toContain('New%20York');
  });

  it('returns error when facet_urn missing', async () => {
    const result = await svc.searchTargetingEntities(ACCESS_TOKEN, { query: 'test' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('facet_urn');
  });
});

describe('getAudienceCount', () => {
  const CRITERIA = {
    include: {
      and: [
        { or: { 'urn:li:adTargetingFacet:locations': ['urn:li:geo:103644278'] } },
        { or: { 'urn:li:adTargetingFacet:skills': ['urn:li:skill:43774', 'urn:li:skill:31706'] } },
      ],
    },
  };

  it('uses the q=targetingCriteriaV2 finder (not the deprecated dotted target finder)', async () => {
    await svc.getAudienceCount(ACCESS_TOKEN, CRITERIA);
    const call = mockAxiosFn.mock.calls[0][0];
    expect(call.method).toBe('GET');
    expect(call.url).toContain('/rest/audienceCounts');
    expect(call.url).toContain('q=targetingCriteriaV2');
    // The old broken format used target.includedTargetingFacets dotted keys
    expect(call.url).not.toContain('target.includedTargetingFacets');
    expect(call.url).not.toContain('q=targetingCriteria&');
  });

  it('encodes the targetingCriteria param in RestLi 2.0 reduced form with URL-encoded URNs', async () => {
    await svc.getAudienceCount(ACCESS_TOKEN, CRITERIA);
    const url: string = mockAxiosFn.mock.calls[0][0].url;
    // Structural tokens stay literal
    expect(url).toContain('targetingCriteria=(include:(and:List(');
    expect(url).toContain('(or:(');
    expect(url).toContain(':List(');
    // URNs (facet + values) are percent-encoded
    expect(url).toContain(encodeURIComponent('urn:li:adTargetingFacet:locations'));
    expect(url).toContain(encodeURIComponent('urn:li:geo:103644278'));
    expect(url).toContain(encodeURIComponent('urn:li:skill:43774'));
    expect(url).toContain(encodeURIComponent('urn:li:skill:31706'));
  });

  it('includes an exclude clause when the criteria has one', async () => {
    await svc.getAudienceCount(ACCESS_TOKEN, {
      ...CRITERIA,
      exclude: { or: { 'urn:li:adTargetingFacet:seniorities': ['urn:li:seniority:1'] } },
    });
    const url: string = mockAxiosFn.mock.calls[0][0].url;
    expect(url).toContain('exclude:(or:(');
    expect(url).toContain(encodeURIComponent('urn:li:seniority:1'));
  });

  it('returns an error when there is no include facet', async () => {
    const result = await svc.getAudienceCount(ACCESS_TOKEN, { include: { and: [] } });
    expect(result.success).toBe(false);
    expect(result.error).toContain('include');
    expect(mockAxiosFn).not.toHaveBeenCalled();
  });

  it('returns an error when criteria is null', async () => {
    const result = await svc.getAudienceCount(ACCESS_TOKEN, null as any);
    expect(result.success).toBe(false);
    expect(mockAxiosFn).not.toHaveBeenCalled();
  });
});

describe('resolveTargetingCriteria', () => {
  it('builds criteria from the flat targeting_include array (same shape as CAMPAIGN CREATE)', () => {
    const tc = svc.resolveTargetingCriteria({
      targeting_include: [
        { facet_urn: 'urn:li:adTargetingFacet:locations', values: ['urn:li:geo:103644278'] },
        { facet_urn: 'urn:li:adTargetingFacet:titles', values: ['urn:li:title:68'] },
      ],
    });
    expect(tc).toEqual({
      include: {
        and: [
          { or: { 'urn:li:adTargetingFacet:locations': ['urn:li:geo:103644278'] } },
          { or: { 'urn:li:adTargetingFacet:titles': ['urn:li:title:68'] } },
        ],
      },
    });
  });

  it('adds an exclude clause from targeting_exclude', () => {
    const tc = svc.resolveTargetingCriteria({
      targeting_include: [{ facet_urn: 'urn:li:adTargetingFacet:locations', values: ['urn:li:geo:103644278'] }],
      targeting_exclude: [{ facet_urn: 'urn:li:adTargetingFacet:seniorities', values: ['urn:li:seniority:1'] }],
    });
    expect(tc.exclude).toEqual({ or: { 'urn:li:adTargetingFacet:seniorities': ['urn:li:seniority:1'] } });
  });

  it('normalizes a raw targeting_criteria object', () => {
    const tc = svc.resolveTargetingCriteria({
      targeting_criteria: { include: { and: [{ or: { 'urn:li:adTargetingFacet:locations': ['urn:li:geo:1'] } }] } },
    });
    expect(tc.include.and).toHaveLength(1);
  });

  it('returns null when no targeting is provided', () => {
    expect(svc.resolveTargetingCriteria({})).toBeNull();
  });
});

describe('createPost — article and document support', () => {
  it('creates post with article content', async () => {
    mockAxiosFn.mockResolvedValue({ data: {}, headers: { 'x-restli-id': 'urn:li:post:art-1' }, status: 201 });
    const result = await svc.createPost(ACCESS_TOKEN, {
      author_urn: 'urn:li:organization:123',
      article_url: 'https://example.com/blog/post',
      article_title: 'My Article',
      article_description: 'An interesting read',
    });
    const body = mockAxiosFn.mock.calls[0][0].data;
    expect(body.content.article.source).toBe('https://example.com/blog/post');
    expect(body.content.article.title).toBe('My Article');
    expect(result.success).toBe(true);
  });

  it('creates post with document content', async () => {
    mockAxiosFn.mockResolvedValue({ data: {}, headers: { 'x-restli-id': 'urn:li:post:doc-1' }, status: 201 });
    await svc.createPost(ACCESS_TOKEN, {
      author_urn: 'urn:li:organization:123',
      document_urn: 'urn:li:document:doc-1',
      title: 'Our Brochure',
    });
    const body = mockAxiosFn.mock.calls[0][0].data;
    expect(body.content.media.id).toBe('urn:li:document:doc-1');
    expect(body.content.media.title).toBe('Our Brochure');
  });

  it('includes thumbnail in article content when thumbnail_urn provided', async () => {
    mockAxiosFn.mockResolvedValue({ data: {}, headers: { 'x-restli-id': 'urn:li:post:art-2' }, status: 201 });
    await svc.createPost(ACCESS_TOKEN, {
      author_urn: 'urn:li:organization:123',
      article_url: 'https://example.com/article',
      thumbnail_urn: 'urn:li:image:thumb-1',
    });
    const body = mockAxiosFn.mock.calls[0][0].data;
    expect(body.content.article.thumbnail).toBe('urn:li:image:thumb-1');
  });
});

describe('createCreative — VAST tag video and event ad', () => {
  it('creates VAST tag video creative', async () => {
    mockAxiosFn.mockResolvedValue({ data: {}, headers: { 'x-restli-id': 'urn:li:sponsoredCreative:vast-1' }, status: 201 });
    const result = await svc.createCreative(ACCESS_TOKEN, {
      campaign_id: 'camp-1',
      ad_account_id: ACCOUNT_ID,
      vast_tag_url: 'https://innovid.com/vast/my-ad.xml',
    });
    const body = mockAxiosFn.mock.calls[0][0].data;
    expect(body.content.thirdPartyVastTagVideoAd.vastTagUrl).toBe('https://innovid.com/vast/my-ad.xml');
    expect(result.success).toBe(true);
  });

  it('creates event ad creative with pre_event_registration_image', async () => {
    mockAxiosFn.mockResolvedValue({ data: {}, headers: { 'x-restli-id': 'urn:li:sponsoredCreative:evt-1' }, status: 201 });
    await svc.createCreative(ACCESS_TOKEN, {
      campaign_id: 'camp-1',
      ad_account_id: ACCOUNT_ID,
      post_urn: 'urn:li:ugcPost:event-123',
      pre_event_registration_image: 'urn:li:image:img-2',
    });
    const body = mockAxiosFn.mock.calls[0][0].data;
    expect(body.content.reference).toBe('urn:li:ugcPost:event-123');
    expect(body.content.preEventRegistrationImage).toBe('urn:li:image:img-2');
  });
});

describe('uploadVideoPart', () => {
  it('PUTs buffer to uploadUrl and returns ETag from response header', async () => {
    const axiosMock = jest.requireMock('axios');
    axiosMock.default.put = jest.fn().mockResolvedValue({ headers: { etag: 'etag-part-1' }, data: {} });
    const buf = Buffer.from('video-chunk');
    const etag = await svc.uploadVideoPart('https://video-upload.example.com', buf);
    expect(axiosMock.default.put).toHaveBeenCalledWith(
      'https://video-upload.example.com',
      buf,
      { headers: { 'Content-Type': 'application/octet-stream' } }
    );
    expect(etag).toBe('etag-part-1');
  });

  it('returns empty string when ETag header is absent', async () => {
    const axiosMock = jest.requireMock('axios');
    axiosMock.default.put = jest.fn().mockResolvedValue({ headers: {}, data: {} });
    const etag = await svc.uploadVideoPart('https://video-upload.example.com', Buffer.from('x'));
    expect(etag).toBe('');
  });
});

describe('initializeDocumentUpload', () => {
  it('POSTs to /rest/documents?action=initializeUpload with ownerUrn', async () => {
    mockAxiosFn.mockResolvedValue({ data: { value: { uploadUrl: 'https://doc-upload.example.com', document: 'urn:li:document:doc-1' } }, status: 200 });
    const result = await svc.initializeDocumentUpload(ACCESS_TOKEN, 'urn:li:organization:123');
    const call = mockAxiosFn.mock.calls[0][0];
    expect(call.url).toContain('/rest/documents?action=initializeUpload');
    expect(call.data.initializeUploadRequest.owner).toBe('urn:li:organization:123');
    expect(result.success).toBe(true);
  });
});

describe('uploadDocumentBinary', () => {
  it('PUTs buffer to uploadUrl with correct content type', async () => {
    const axiosMock = jest.requireMock('axios');
    const buf = Buffer.from('pdf-bytes');
    await svc.uploadDocumentBinary('https://doc-upload.example.com', buf, 'application/pdf');
    expect(axiosMock.default.put).toHaveBeenCalledWith(
      'https://doc-upload.example.com',
      buf,
      { headers: { 'Content-Type': 'application/pdf' } }
    );
  });

  it('defaults content type to application/pdf', async () => {
    const axiosMock = jest.requireMock('axios');
    await svc.uploadDocumentBinary('https://doc-upload.example.com', Buffer.from('data'));
    expect(axiosMock.default.put).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Buffer),
      { headers: { 'Content-Type': 'application/pdf' } }
    );
  });
});

describe('createDynamicCreative', () => {
  it('creates JOBS dynamic creative', async () => {
    mockAxiosFn.mockResolvedValue({ data: {}, headers: { 'x-restli-id': 'urn:li:sponsoredCreative:dyn-1' }, status: 201 });
    const result = await svc.createDynamicCreative(ACCESS_TOKEN, ACCOUNT_ID, {
      campaign_id: 'camp-1',
      format: 'JOBS',
      headline: 'We are hiring!',
      button_label: 'Apply Now',
    });
    const body = mockAxiosFn.mock.calls[0][0].data;
    expect(body.content.jobs.headline).toBe('We are hiring!');
    expect(body.content.jobs.buttonLabel).toBe('Apply Now');
    expect(result.success).toBe(true);
  });

  it('creates SPOTLIGHT dynamic creative', async () => {
    mockAxiosFn.mockResolvedValue({ data: {}, headers: { 'x-restli-id': 'urn:li:sponsoredCreative:dyn-2' }, status: 201 });
    await svc.createDynamicCreative(ACCESS_TOKEN, ACCOUNT_ID, {
      campaign_id: 'camp-1',
      format: 'SPOTLIGHT',
      headline: 'See our work',
      call_to_action: 'Visit Now',
      landing_page: 'https://example.com',
      description: 'Award-winning agency',
      logo_urn: 'urn:li:image:logo-1',
    });
    const body = mockAxiosFn.mock.calls[0][0].data;
    expect(body.content.spotlight.headline).toBe('See our work');
    expect(body.content.spotlight.callToAction).toBe('Visit Now');
    expect(body.content.spotlight.landingPage).toBe('https://example.com');
    expect(body.content.spotlight.description).toBe('Award-winning agency');
    expect(body.content.spotlight.logo).toBe('urn:li:image:logo-1');
  });

  it('returns error if SPOTLIGHT dynamic creative is missing logo_urn', async () => {
    const result = await svc.createDynamicCreative(ACCESS_TOKEN, ACCOUNT_ID, {
      campaign_id: 'camp-1',
      format: 'SPOTLIGHT',
      headline: 'See our work',
      call_to_action: 'Visit Now',
      landing_page: 'https://example.com',
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('require logo_urn');
  });

  it('creates FOLLOW_COMPANY dynamic creative', async () => {
    mockAxiosFn.mockResolvedValue({ data: {}, headers: { 'x-restli-id': 'urn:li:sponsoredCreative:dyn-3' }, status: 201 });
    await svc.createDynamicCreative(ACCESS_TOKEN, ACCOUNT_ID, {
      campaign_id: 'camp-1',
      format: 'FOLLOW_COMPANY',
      headline: 'Follow us for updates',
    });
    const body = mockAxiosFn.mock.calls[0][0].data;
    expect(body.content.follow.headline).toBe('Follow us for updates');
  });

  it('returns error for unknown format', async () => {
    const result = await svc.createDynamicCreative(ACCESS_TOKEN, ACCOUNT_ID, {
      campaign_id: 'camp-1',
      format: 'UNKNOWN_FORMAT',
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Unknown dynamic ad format');
  });

  it('returns error when campaign_id missing', async () => {
    const result = await svc.createDynamicCreative(ACCESS_TOKEN, ACCOUNT_ID, { format: 'JOBS' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('campaign_id');
  });
});

describe('createConversationAd', () => {
  it('POSTs to /rest/conversationAds with parentAccount and maps name to headlineText', async () => {
    mockAxiosFn.mockResolvedValue({ data: {}, headers: { 'x-restli-id': 'urn:li:conversationAd:ca-1' }, status: 201 });
    const result = await svc.createConversationAd(ACCESS_TOKEN, ACCOUNT_ID, { name: 'My Conversation Ad' });
    const call = mockAxiosFn.mock.calls[0][0];
    expect(call.url).toContain('/rest/conversationAds');
    expect(call.data.parentAccount).toBe(`urn:li:sponsoredAccount:${ACCOUNT_ID}`);
    expect(call.data.headlineText).toBe('My Conversation Ad');
    // LinkedIn's SponsoredConversation schema has no "name" field — sending one is
    // rejected with "ERROR :: /name :: unrecognized field found but not allowed".
    expect(call.data.name).toBeUndefined();
    expect(result.success).toBe(true);
  });

  it('accepts headline_text directly as an alias for name', async () => {
    mockAxiosFn.mockResolvedValue({ data: {}, headers: { 'x-restli-id': 'urn:li:conversationAd:ca-1' }, status: 201 });
    await svc.createConversationAd(ACCESS_TOKEN, ACCOUNT_ID, { headline_text: 'Direct headline' });
    const call = mockAxiosFn.mock.calls[0][0];
    expect(call.data.headlineText).toBe('Direct headline');
  });

  it("accepts LinkedIn's documented camelCase headlineText spelling", async () => {
    mockAxiosFn.mockResolvedValue({ data: {}, headers: { 'x-restli-id': 'urn:li:conversationAd:ca-1' }, status: 201 });
    await svc.createConversationAd(ACCESS_TOKEN, ACCOUNT_ID, { headlineText: 'Camel headline' });
    const call = mockAxiosFn.mock.calls[0][0];
    expect(call.data.headlineText).toBe('Camel headline');
  });

  it('omits headlineText entirely when neither name nor headline_text is provided — LinkedIn treats it as optional', async () => {
    mockAxiosFn.mockResolvedValue({ data: {}, headers: { 'x-restli-id': 'urn:li:conversationAd:ca-1' }, status: 201 });
    const result = await svc.createConversationAd(ACCESS_TOKEN, ACCOUNT_ID, {});
    const call = mockAxiosFn.mock.calls[0][0];
    expect(call.data.parentAccount).toBe(`urn:li:sponsoredAccount:${ACCOUNT_ID}`);
    expect('headlineText' in call.data).toBe(false);
    expect(result.success).toBe(true);
  });

  it('still requires ad_account_id', async () => {
    const result = await svc.createConversationAd(ACCESS_TOKEN, '', { name: 'x' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('ad_account_id');
  });
});

describe('createConversationAdContent', () => {
  it('POSTs message node with buttons to conversation ad', async () => {
    mockAxiosFn.mockResolvedValue({ data: {}, headers: { 'x-restli-id': 'urn:li:conversationAdContent:cc-1' }, status: 201 });
    const result = await svc.createConversationAdContent(
      ACCESS_TOKEN,
      'urn:li:conversationAd:ca-1',
      {
        body: 'Hello! Interested in learning more?',
        buttons: [
          { text: 'Yes, tell me more', action: 'SEND_MESSAGE' },
          { text: 'Visit our site', action: 'OPEN_URL', url: 'https://example.com' },
        ],
      }
    );
    const call = mockAxiosFn.mock.calls[0][0];
    expect(call.url).toContain('conversationAds');
    expect(call.url).toContain('sponsoredMessageContents');
    expect(call.data.body).toBe('Hello! Interested in learning more?');
    expect(call.data.buttons).toHaveLength(2);
    expect(result.success).toBe(true);
  });

  it('returns error when body missing', async () => {
    const result = await svc.createConversationAdContent(ACCESS_TOKEN, 'urn:li:conversationAd:ca-1', {
      buttons: [{ text: 'OK', action: 'OPEN_URL' }],
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('body');
  });

  it('returns error when buttons missing', async () => {
    const result = await svc.createConversationAdContent(ACCESS_TOKEN, 'urn:li:conversationAd:ca-1', {
      body: 'Hello',
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('buttons');
  });
});

describe('setConversationAdFirstContent', () => {
  it('PATCHes conversation ad to set firstContent', async () => {
    mockAxiosFn.mockResolvedValue({ data: {}, headers: {}, status: 204 });
    const result = await svc.setConversationAdFirstContent(
      ACCESS_TOKEN,
      'urn:li:conversationAd:ca-1',
      'urn:li:conversationAdContent:cc-1'
    );
    const call = mockAxiosFn.mock.calls[0][0];
    expect(call.url).toContain('conversationAds');
    expect(call.headers['X-RestLi-Method']).toBe('PARTIAL_UPDATE');
    expect(call.data.patch.$set.firstContent).toBe('urn:li:conversationAdContent:cc-1');
    expect(result.success).toBe(true);
  });
});

describe('getAdAnalytics', () => {
  it('builds analytics query with pivot and date range', async () => {
    await svc.getAdAnalytics(
      ACCESS_TOKEN,
      '502840441',
      'CAMPAIGN',
      'ALL',
      { start: { year: 2024, month: 1, day: 1 }, end: { year: 2024, month: 12, day: 31 } },
      ['impressions', 'clicks']
    );
    const call = mockAxiosFn.mock.calls[0][0];
    expect(call.url).toContain('q=analytics');
    expect(call.url).toContain('pivot=CAMPAIGN');
    expect(call.url).toContain('timeGranularity=ALL');
    expect(call.url).toContain('dateRange=(start:');
    expect(call.url).toContain('fields=impressions,clicks');
    expect(call.url).toContain('sponsoredAccount');
  });

  it('includes campaign filters when provided', async () => {
    await svc.getAdAnalytics(
      ACCESS_TOKEN,
      '502840441',
      'CAMPAIGN',
      'DAILY',
      { start: { year: 2024, month: 1, day: 1 }, end: { year: 2024, month: 1, day: 31 } },
      ['impressions'],
      { campaign_ids: ['camp-1', 'camp-2'] }
    );
    const call = mockAxiosFn.mock.calls[0][0];
    expect(call.url).toContain('sponsoredCampaign');
    expect(call.url).toContain('camp-1');
  });

  it('includes campaignGroups filter when campaign_group_ids provided', async () => {
    await svc.getAdAnalytics(
      ACCESS_TOKEN,
      '502840441',
      'CAMPAIGN_GROUP',
      'ALL',
      { start: { year: 2024, month: 1, day: 1 }, end: { year: 2024, month: 12, day: 31 } },
      ['impressions'],
      { campaign_group_ids: ['cg-1', 'cg-2'] }
    );
    const call = mockAxiosFn.mock.calls[0][0];
    expect(call.url).toContain('campaignGroups=List(');
    expect(call.url).toContain('sponsoredCampaignGroup');
  });

  it('makes only a single API call (no pagination for analytics)', async () => {
    await svc.getAdAnalytics(
      ACCESS_TOKEN,
      '502840441',
      'CAMPAIGN',
      'ALL',
      { start: { year: 2024, month: 1, day: 1 }, end: { year: 2024, month: 12, day: 31 } },
      ['impressions']
    );
    expect(mockAxiosFn).toHaveBeenCalledTimes(1);
  });
});

// ─── Pagination behaviour (fetchAllPages helper) ───────────────────────────────

describe('pagination — listAdAccounts', () => {
  it('sends pageSize=1000 on the first request', async () => {
    await svc.listAdAccounts(ACCESS_TOKEN);
    const url: string = mockAxiosFn.mock.calls[0][0].url;
    expect(url).toContain('pageSize=1000');
  });

  it('returns all elements from a single page', async () => {
    mockAxiosFn.mockResolvedValueOnce({
      data: { elements: [{ id: 'acc-1' }, { id: 'acc-2' }], metadata: {} },
      status: 200,
    });
    const result = await svc.listAdAccounts(ACCESS_TOKEN);
    expect(result.success).toBe(true);
    expect(result.data.elements).toHaveLength(2);
    expect(mockAxiosFn).toHaveBeenCalledTimes(1);
  });

  it('fetches subsequent pages when nextPageToken is present', async () => {
    mockAxiosFn
      .mockResolvedValueOnce({
        data: { elements: [{ id: 'acc-1' }], metadata: { nextPageToken: 'tok-1' } },
        status: 200,
      })
      .mockResolvedValueOnce({
        data: { elements: [{ id: 'acc-2' }], metadata: {} },
        status: 200,
      });
    const result = await svc.listAdAccounts(ACCESS_TOKEN);
    expect(result.success).toBe(true);
    expect(result.data.elements).toHaveLength(2);
    expect(mockAxiosFn).toHaveBeenCalledTimes(2);
    const secondUrl: string = mockAxiosFn.mock.calls[1][0].url;
    expect(secondUrl).toContain('pageToken=tok-1');
  });

  it('stops fetching when nextPageToken is null', async () => {
    mockAxiosFn
      .mockResolvedValueOnce({
        data: { elements: [{ id: 'acc-1' }], metadata: { nextPageToken: 'tok-1' } },
        status: 200,
      })
      .mockResolvedValueOnce({
        data: { elements: [{ id: 'acc-2' }], metadata: { nextPageToken: null } },
        status: 200,
      });
    const result = await svc.listAdAccounts(ACCESS_TOKEN);
    expect(result.data.elements).toHaveLength(2);
    expect(mockAxiosFn).toHaveBeenCalledTimes(2);
  });

  it('returns error immediately if a page request fails', async () => {
    mockAxiosFn
      .mockResolvedValueOnce({
        data: { elements: [{ id: 'acc-1' }], metadata: { nextPageToken: 'tok-1' } },
        status: 200,
      })
      .mockRejectedValueOnce({
        response: { status: 429, data: { message: 'Rate limited' } },
      });
    const result = await svc.listAdAccounts(ACCESS_TOKEN);
    expect(result.success).toBe(false);
    expect(result.status).toBe(429);
    expect(mockAxiosFn).toHaveBeenCalledTimes(2);
  });
});

describe('pagination — listCampaignGroups', () => {
  it('sends pageSize=1000', async () => {
    await svc.listCampaignGroups(ACCESS_TOKEN, ACCOUNT_ID);
    const url: string = mockAxiosFn.mock.calls[0][0].url;
    expect(url).toContain('pageSize=1000');
  });

  it('accumulates elements across multiple pages', async () => {
    const page1 = Array.from({ length: 3 }, (_, i) => ({ id: `cg-${i}` }));
    const page2 = Array.from({ length: 2 }, (_, i) => ({ id: `cg-${i + 3}` }));
    mockAxiosFn
      .mockResolvedValueOnce({ data: { elements: page1, metadata: { nextPageToken: 'tok-cg' } }, status: 200 })
      .mockResolvedValueOnce({ data: { elements: page2, metadata: {} }, status: 200 });

    const result = await svc.listCampaignGroups(ACCESS_TOKEN, ACCOUNT_ID);
    expect(result.data.elements).toHaveLength(5);
    expect(mockAxiosFn).toHaveBeenCalledTimes(2);
  });

  it('applies status filter in search param', async () => {
    await svc.listCampaignGroups(ACCESS_TOKEN, ACCOUNT_ID, { status: 'ACTIVE' });
    const url: string = mockAxiosFn.mock.calls[0][0].url;
    expect(url).toContain('ACTIVE');
  });
});

describe('pagination — listCampaigns', () => {
  it('sends pageSize=1000', async () => {
    await svc.listCampaigns(ACCESS_TOKEN, ACCOUNT_ID);
    const url: string = mockAxiosFn.mock.calls[0][0].url;
    expect(url).toContain('pageSize=1000');
  });

  it('accumulates elements across multiple pages', async () => {
    mockAxiosFn
      .mockResolvedValueOnce({ data: { elements: [{ id: 'c-1' }], metadata: { nextPageToken: 'tok-c' } }, status: 200 })
      .mockResolvedValueOnce({ data: { elements: [{ id: 'c-2' }, { id: 'c-3' }], metadata: {} }, status: 200 });

    const result = await svc.listCampaigns(ACCESS_TOKEN, ACCOUNT_ID);
    expect(result.data.elements).toHaveLength(3);
    expect(mockAxiosFn).toHaveBeenCalledTimes(2);
    const secondUrl: string = mockAxiosFn.mock.calls[1][0].url;
    expect(secondUrl).toContain('pageToken=tok-c');
  });

  it('returns error if a mid-pagination request fails', async () => {
    mockAxiosFn
      .mockResolvedValueOnce({ data: { elements: [{ id: 'c-1' }], metadata: { nextPageToken: 'tok-c' } }, status: 200 })
      .mockRejectedValueOnce({ response: { status: 500, data: { message: 'Server error' } } });

    const result = await svc.listCampaigns(ACCESS_TOKEN, ACCOUNT_ID);
    expect(result.success).toBe(false);
    expect(result.status).toBe(500);
  });
});

describe('pagination — listCreatives', () => {
  it('sends pageSize=100 (not 1000) per v202603 docs', async () => {
    await svc.listCreatives(ACCESS_TOKEN, ACCOUNT_ID, 'camp-1');
    const url: string = mockAxiosFn.mock.calls[0][0].url;
    expect(url).toContain('pageSize=100');
    expect(url).not.toContain('pageSize=1000');
  });

  it('sends X-RestLi-Method: FINDER header on every page request', async () => {
    mockAxiosFn
      .mockResolvedValueOnce({ data: { elements: [{ id: 'cr-1' }], metadata: { nextPageToken: 'tok-cr' } }, status: 200 })
      .mockResolvedValueOnce({ data: { elements: [{ id: 'cr-2' }], metadata: {} }, status: 200 });

    await svc.listCreatives(ACCESS_TOKEN, ACCOUNT_ID, 'camp-1');
    for (const call of mockAxiosFn.mock.calls) {
      expect(call[0].headers['X-RestLi-Method']).toBe('FINDER');
    }
  });

  it('accumulates elements across multiple pages', async () => {
    mockAxiosFn
      .mockResolvedValueOnce({ data: { elements: [{ id: 'cr-1' }], metadata: { nextPageToken: 'tok-cr' } }, status: 200 })
      .mockResolvedValueOnce({ data: { elements: [{ id: 'cr-2' }], metadata: {} }, status: 200 });

    const result = await svc.listCreatives(ACCESS_TOKEN, ACCOUNT_ID, 'camp-1');
    expect(result.data.elements).toHaveLength(2);
    expect(mockAxiosFn).toHaveBeenCalledTimes(2);
  });

  it('encodes numeric campaign ID as full URN in URL', async () => {
    await svc.listCreatives(ACCESS_TOKEN, ACCOUNT_ID, '99999');
    const url: string = mockAxiosFn.mock.calls[0][0].url;
    expect(url).toContain('urn%3Ali%3AsponsoredCampaign%3A99999');
  });

  it('accepts full URN campaign ID without double-prefixing', async () => {
    await svc.listCreatives(ACCESS_TOKEN, ACCOUNT_ID, 'urn:li:sponsoredCampaign:99999');
    const url: string = mockAxiosFn.mock.calls[0][0].url;
    expect(url).toContain('urn%3Ali%3AsponsoredCampaign%3A99999');
    expect(url).not.toContain('sponsoredCampaign%3Aurn');
  });
});
