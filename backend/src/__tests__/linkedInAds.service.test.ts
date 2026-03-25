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
  it('makes POST with account URN and name', async () => {
    await svc.createCampaignGroup(ACCESS_TOKEN, ACCOUNT_ID, { name: 'My Group', status: 'ACTIVE' });
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
    });
    expect(mockAxiosFn).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          totalBudget: { amount: '1000', currencyCode: 'USD' },
        }),
      })
    );
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
    expect(call.url).toContain('urn:li:sponsoredCampaignGroup:cg-99');
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
    });
    expect(mockAxiosFn).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'POST',
        url: expect.stringContaining('/rest/creatives'),
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
    });
    const call = mockAxiosFn.mock.calls[0][0];
    expect(call.data.content.textAd).toMatchObject({
      headline: 'Click Here',
      description: 'Ad copy',
      landingPage: 'https://example.com',
    });
  });

  it('returns error when no creative type provided', async () => {
    const result = await svc.createCreative(ACCESS_TOKEN, { campaign_id: 'camp-1' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('CREATIVE CREATE requires');
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

describe('getAdAnalytics', () => {
  it('builds analytics query with pivot and date range', async () => {
    await svc.getAdAnalytics(
      ACCESS_TOKEN,
      'CAMPAIGN',
      'ALL',
      { start: { year: 2024, month: 1, day: 1 }, end: { year: 2024, month: 12, day: 31 } },
      ['impressions', 'clicks']
    );
    const call = mockAxiosFn.mock.calls[0][0];
    expect(call.url).toContain('q=analytics');
    expect(call.url).toContain('pivot=CAMPAIGN');
    expect(call.url).toContain('timeGranularity=ALL');
    expect(call.url).toContain('dateRange.start.year=2024');
    expect(call.url).toContain('fields=impressions%2Cclicks');
  });

  it('includes campaign filters when provided', async () => {
    await svc.getAdAnalytics(
      ACCESS_TOKEN,
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
});
