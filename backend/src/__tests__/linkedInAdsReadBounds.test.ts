/**
 * ENG-2840 (W2-9): the optional bounds on LinkedIn Ads reads, end to end through Emma's real implementation (emma/impl/adsApis.ts) and the
 * real LinkedIn client (services/linkedInAdsService.ts) down to axios. With the read route's bounds: every request (the token refresh too)
 * carries a timeout, a list stops at its page and element caps and says `truncated`, CREATIVE LIST expands at most 10 referenced posts, and a
 * LinkedIn failure carries its HTTP status. Without bounds (Emma's own calls): no timeout, every page, every post, the same answer shapes.
 */
const mockAxiosFn = jest.fn();
const mockAxiosPost = jest.fn();
jest.mock('axios', () => {
  const fn = (...args: any[]) => mockAxiosFn(...args);
  (fn as any).post = (...args: any[]) => mockAxiosPost(...args);
  (fn as any).get = jest.fn();
  (fn as any).create = jest.fn().mockReturnValue(fn);
  return { __esModule: true, default: fn };
});
jest.mock('../config/integrations', () => ({
  INTEGRATION_CONFIG: { linkedinAds: { apiVersion: '202603', tokenUrl: 'https://www.linkedin.com/oauth/v2/accessToken' } },
  getLinkedInAdsConfig: jest.fn().mockResolvedValue({ clientId: 'cid', clientSecret: 'secret' }),
}));
jest.mock('../services/connectedAccountsDb', () => ({
  getAccountsWithOwnerIncludingOrgShared: jest.fn(),
  updateAccountTokens: jest.fn().mockResolvedValue(undefined),
}));
// adsApis.ts reaches agentModeService.ts only through metaLaunchGate.ts (adsApis.moduleIsolation.test.ts); not needed here.
jest.mock('../services/metaLaunchGate', () => ({
  isMetaSpendStartingWrite: jest.fn(),
  runMetaTrackingGate: jest.fn(),
  computeTrackingOverrideDigest: jest.fn(),
  trackingOverrideTokenMatches: jest.fn(),
}));

import { callLinkedInAdsInsightsApi, callLinkedInMarketingApi } from '../emma/impl/adsApis';
import { getAccountsWithOwnerIncludingOrgShared, updateAccountTokens } from '../services/connectedAccountsDb';
import { LINKEDIN_INSIGHTS_ROUTE_BOUNDS, LINKEDIN_READ_ROUTE_BOUNDS } from '../routes/emmaLinkedInAdsReadRoutes';

const mockAccounts = getAccountsWithOwnerIncludingOrgShared as jest.Mock;
const account = (expiresAt: number) => ({
  platform: 'linkedin_ads', account_id: '111', userId: 'owner-1',
  config: { account_type: 'ad_account', access_token: 'tok', refresh_token: 'rt', token_expires_at: expiresAt },
});
const RANGE = { start: { year: 2026, month: 1, day: 1 }, end: { year: 2026, month: 1, day: 31 } };

/** Every axios GET answers a page of `perPage` elements with a next-page token, forever (posts answer one post). */
function endlessPages(perPage: number) {
  let n = 0;
  mockAxiosFn.mockImplementation(async (config: any) => {
    if (String(config.url).includes('/rest/posts/')) return { status: 200, data: { id: 'post', commentary: 'c' } };
    n++;
    return { status: 200, data: { elements: Array.from({ length: perPage }, (_, i) => ({ id: n * 1000 + i })), metadata: { nextPageToken: `t${n}` } } };
  });
}

beforeEach(() => {
  mockAxiosFn.mockReset();
  mockAxiosPost.mockReset();
  mockAccounts.mockResolvedValue([account(Date.now() + 3_600_000)]);
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => jest.restoreAllMocks());

describe('list reads', () => {
  it('with the read route\'s bounds: a 30 s timeout on each request, pages of at most 500, cut at 500 elements, truncated', async () => {
    endlessPages(500);
    const r = await callLinkedInMarketingApi('user-1', 'CAMPAIGN_GROUP', 'LIST', '111', {}, LINKEDIN_READ_ROUTE_BOUNDS);
    expect(mockAxiosFn).toHaveBeenCalledTimes(1);
    expect(mockAxiosFn.mock.calls[0][0]).toMatchObject({ method: 'GET', timeout: 30_000 });
    expect(mockAxiosFn.mock.calls[0][0].url).toMatch(/pageSize=500(&|$)/);
    expect(r.campaignGroups).toHaveLength(500);
    expect(r.truncated).toBe(true);
  });

  it('with the read route\'s bounds: at most 5 pages', async () => {
    endlessPages(100);
    const r = await callLinkedInMarketingApi('user-1', 'CAMPAIGN', 'LIST', '111', { status: 'ACTIVE' }, LINKEDIN_READ_ROUTE_BOUNDS);
    expect(mockAxiosFn).toHaveBeenCalledTimes(5);
    expect(r.campaigns).toHaveLength(500);
    expect(r.truncated).toBe(true);
    for (const [config] of mockAxiosFn.mock.calls) expect(config.timeout).toBe(30_000);
  });

  it('without bounds (Emma): no timeout, pages of 1000, every page, no truncated key', async () => {
    let n = 0;
    mockAxiosFn.mockImplementation(async () => {
      n++;
      return { status: 200, data: { elements: [{ id: n }], metadata: n < 7 ? { nextPageToken: `t${n}` } : {} } };
    });
    const r = await callLinkedInMarketingApi('user-1', 'CAMPAIGN_GROUP', 'LIST', '111', {});
    expect(mockAxiosFn).toHaveBeenCalledTimes(7);
    for (const [config] of mockAxiosFn.mock.calls) {
      expect(config).not.toHaveProperty('timeout');
      expect(config.url).toMatch(/pageSize=1000(&|$)/);
    }
    expect(r).toEqual({ success: true, campaignGroups: [1, 2, 3, 4, 5, 6, 7].map((id) => ({ id })) });
  });

  it('AD_ACCOUNT LIST is bounded the same way (the filter to the caller\'s accounts is the route\'s)', async () => {
    endlessPages(500);
    const r = await callLinkedInMarketingApi('user-1', 'AD_ACCOUNT', 'LIST', '111', {}, LINKEDIN_READ_ROUTE_BOUNDS);
    expect(mockAxiosFn).toHaveBeenCalledTimes(1);
    expect(r.adAccounts).toHaveLength(500);
  });
});

describe('CREATIVE LIST referenced posts', () => {
  function creatives(n: number) {
    mockAxiosFn.mockImplementation(async (config: any) => {
      if (String(config.url).includes('/rest/posts/')) return { status: 200, data: { contentLandingPage: 'https://example.com/' } };
      return { status: 200, data: { elements: Array.from({ length: n }, (_, i) => ({ id: i, content: { reference: `urn:li:share:${i}` } })), metadata: {} } };
    });
  }
  const postCalls = () => mockAxiosFn.mock.calls.filter(([c]) => String(c.url).includes('/rest/posts/'));

  it('with the read route\'s bounds: expands the first 10, counts the rest, and each post read has the timeout', async () => {
    creatives(15);
    const r = await callLinkedInMarketingApi('user-1', 'CREATIVE', 'LIST', '111', { campaign_id: '9' }, LINKEDIN_READ_ROUTE_BOUNDS);
    expect(postCalls()).toHaveLength(10);
    for (const [config] of postCalls()) expect(config.timeout).toBe(30_000);
    expect(r.creatives.slice(0, 10).every((c: any) => c.referencedPost)).toBe(true);
    expect(r.creatives.slice(10).some((c: any) => c.referencedPost)).toBe(false);
    expect(r.referencedPostsNotExpanded).toBe(5);
  });

  it('without bounds (Emma): expands every one, no extra keys', async () => {
    creatives(15);
    const r = await callLinkedInMarketingApi('user-1', 'CREATIVE', 'LIST', '111', { campaign_id: '9' });
    expect(postCalls()).toHaveLength(15);
    expect(Object.keys(r).sort()).toEqual(['creatives', 'success']);
    expect(r.creatives.every((c: any) => c.referencedPost)).toBe(true);
  });
});

describe('insights, token refresh and failures', () => {
  it('insights with the route\'s bounds has the timeout; without, none', async () => {
    mockAxiosFn.mockResolvedValue({ status: 200, data: { elements: [{ impressions: 1 }] } });
    const bounded = await callLinkedInAdsInsightsApi('user-1', '111', { pivot: 'CAMPAIGN', dateRange: RANGE, fields: ['impressions'] }, LINKEDIN_INSIGHTS_ROUTE_BOUNDS);
    expect(mockAxiosFn.mock.calls[0][0]).toMatchObject({ timeout: 30_000 });
    expect(mockAxiosFn.mock.calls[0][0].url).toContain('/rest/adAnalytics?q=analytics&pivot=CAMPAIGN');
    const emma = await callLinkedInAdsInsightsApi('user-1', '111', { pivot: 'CAMPAIGN', dateRange: RANGE, fields: ['impressions'] });
    expect(mockAxiosFn.mock.calls[1][0]).not.toHaveProperty('timeout');
    expect(bounded).toEqual(emma);
    expect(emma).toEqual({ success: true, analytics: [{ impressions: 1 }] });
  });

  it('a token refresh with bounds has the timeout (and is saved on the owner\'s record); without, none', async () => {
    mockAccounts.mockResolvedValue([account(Date.now() - 1000)]);
    mockAxiosPost.mockResolvedValue({ data: { access_token: 'new', refresh_token: 'rt2', expires_in: 3600 } });
    mockAxiosFn.mockResolvedValue({ status: 200, data: { elements: [] } });
    await callLinkedInMarketingApi('user-1', 'TARGETING', 'LIST_FACETS', '111', {}, LINKEDIN_READ_ROUTE_BOUNDS);
    expect(mockAxiosPost.mock.calls[0][2]).toMatchObject({ timeout: 30_000 });
    expect(updateAccountTokens).toHaveBeenCalledWith('owner-1', 'linkedin_ads', expect.objectContaining({ access_token: 'new' }), '111');
    await callLinkedInMarketingApi('user-1', 'TARGETING', 'LIST_FACETS', '111', {});
    expect(mockAxiosPost.mock.calls[1][2]).not.toHaveProperty('timeout');
  });

  it('a failed LinkedIn read throws the same message as before, now with LinkedIn\'s status; a timeout has none', async () => {
    mockAxiosFn.mockRejectedValue({ response: { status: 403, data: { message: 'Not enough permissions' } } });
    for (const bounds of [LINKEDIN_READ_ROUTE_BOUNDS, undefined]) {
      const err: any = await callLinkedInMarketingApi('user-1', 'POST', 'GET', '111', { post_urn: 'urn:li:share:1' }, bounds).catch((e) => e);
      expect(err.message).toBe('Not enough permissions');
      expect(err.linkedInStatus).toBe(403);
    }
    mockAxiosFn.mockRejectedValue(Object.assign(new Error('timeout of 30000ms exceeded'), { code: 'ECONNABORTED' }));
    const timeout: any = await callLinkedInAdsInsightsApi('user-1', '111', { pivot: 'CAMPAIGN', dateRange: RANGE }, LINKEDIN_INSIGHTS_ROUTE_BOUNDS).catch((e) => e);
    expect(timeout.message).toBe('timeout of 30000ms exceeded');
    expect(timeout.linkedInStatus).toBeUndefined();
    expect('linkedInStatus' in timeout).toBe(true);
  });
});
