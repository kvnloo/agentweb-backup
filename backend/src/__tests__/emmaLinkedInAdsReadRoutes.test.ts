/**
 * ENG-2840 (W2-9): the two LinkedIn Ads read routes (routes/emmaLinkedInAdsReadRoutes.ts) on a Router with a fake signed-in user. Emma's
 * implementation and the connected-accounts read are doubles. What is pinned: the caller is req.user.userId and nothing else; the body is
 * checked again here (writes and injection refused, nothing called); the account must be the caller's own or org-shared; AD_ACCOUNT LIST
 * answers only those accounts; the bounds reach Emma's implementation; LinkedIn's failures become the right status and words.
 */
import request from 'supertest';
import express from 'express';

jest.mock('../emma/impl/adsApis', () => ({
  callLinkedInMarketingApi: jest.fn(),
  callLinkedInAdsInsightsApi: jest.fn(),
}));
jest.mock('../services/connectedAccountsDb', () => ({
  getAccountsWithOwnerIncludingOrgShared: jest.fn(),
}));
jest.mock('../services/evaluationPolicy', () => {
  const actual = jest.requireActual('../services/evaluationPolicy');
  return { ...actual, enforceEvaluationTool: jest.fn(async () => undefined) };
});

import { callLinkedInAdsInsightsApi, callLinkedInMarketingApi } from '../emma/impl/adsApis';
import { getAccountsWithOwnerIncludingOrgShared } from '../services/connectedAccountsDb';
import { EvaluationDenied, enforceEvaluationTool } from '../services/evaluationPolicy';
import {
  AD_ACCOUNT_CUT_NOTE,
  LINKEDIN_INSIGHTS_ROUTE_BOUNDS,
  LINKEDIN_READ_ROUTE_BOUNDS,
  registerLinkedInAdsReadRoutes,
} from '../routes/emmaLinkedInAdsReadRoutes';

const mockMarketing = callLinkedInMarketingApi as jest.Mock;
const mockInsights = callLinkedInAdsInsightsApi as jest.Mock;
const mockAccounts = getAccountsWithOwnerIncludingOrgShared as jest.Mock;
const mockEnforce = enforceEvaluationTool as jest.Mock;

const app = express();
app.use(express.json());
const router = express.Router();
router.use((req: any, _res: any, next: any) => {
  req.user = { userId: 'user-1', email: 'u@example.com', isAdmin: false };
  next();
});
registerLinkedInAdsReadRoutes(router);
app.use('/api/emma', router);

const OWN = { platform: 'linkedin_ads', account_id: '111', config: { account_type: 'ad_account', access_token: 't' }, userId: 'user-1' };
const SHARED = { platform: 'linkedin_ads', account_id: 'urn:li:sponsoredAccount:222', config: { account_type: 'ad_account', access_token: 't' }, userId: 'owner-2', sharedWithOrg: true };
// Same ids on rows that are not LinkedIn ad accounts: they make nothing visible.
const NOT_AD_ACCOUNT = { platform: 'linkedin_ads', account_id: '333', config: { account_type: 'organization' }, userId: 'user-1' };
const OTHER_PLATFORM = { platform: 'meta', account_id: '444', config: { account_type: 'ad_account' }, userId: 'user-1' };

const RANGE = { start: { year: 2026, month: 1, day: 1 }, end: { year: 2026, month: 1, day: 31 } };
const post = (path: string, body: unknown) => request(app).post(`/api/emma/linkedin-ads/${path}`).send(body as object);

beforeEach(() => {
  jest.clearAllMocks();
  mockAccounts.mockResolvedValue([OWN, SHARED, NOT_AD_ACCOUNT, OTHER_PLATFORM]);
  mockEnforce.mockResolvedValue(undefined);
});

describe('POST /linkedin-ads/read', () => {
  it('AD_ACCOUNT LIST answers only the caller\'s own and org-shared ad accounts, fixed fields', async () => {
    mockMarketing.mockResolvedValueOnce({
      success: true,
      adAccounts: [
        { id: 111, name: 'Own', currency: 'USD', status: 'ACTIVE', type: 'BUSINESS', reference: 'urn:li:organization:1', test: false, notifiedOnCampaignOptimization: true },
        { id: 222, name: 'Shared by owner', currency: 'EUR', status: 'ACTIVE', type: 'BUSINESS' },
        { id: 333, name: 'Agency client A', currency: 'USD', status: 'ACTIVE', type: 'BUSINESS' },
        { id: 'urn:li:sponsoredAccount:444', name: 'Agency client B', currency: 'USD', status: 'ACTIVE', type: 'ENTERPRISE' },
        { id: 555, name: 'Agency client C' },
      ],
    });
    const res = await post('read', { entity_type: 'AD_ACCOUNT', action: 'LIST', account_id: '222' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true, account_id: '222', entity_type: 'AD_ACCOUNT', action: 'LIST', count: 2, truncated: false,
      adAccounts: [
        { id: 111, name: 'Own', currency: 'USD', status: 'ACTIVE', type: 'BUSINESS', reference: 'urn:li:organization:1', test: false },
        { id: 222, name: 'Shared by owner', currency: 'EUR', status: 'ACTIVE', type: 'BUSINESS' },
      ],
    });
    expect(JSON.stringify(res.body)).not.toMatch(/Agency client/);
    expect(mockAccounts).toHaveBeenCalledWith('user-1');
  });

  it('AD_ACCOUNT LIST says truncated, with a note, when the bound cut the token\'s list (no LinkedIn paging or total is passed on)', async () => {
    mockMarketing.mockResolvedValueOnce({
      success: true,
      truncated: true,
      paging: { start: 0, count: 500, total: 9000 },
      adAccounts: [{ id: 111, name: 'Own' }, ...Array.from({ length: 499 }, (_, i) => ({ id: 10_000 + i, name: `Client ${i}` }))],
    });
    const res = await post('read', { entity_type: 'AD_ACCOUNT', action: 'LIST', account_id: '111' });
    expect(res.body).toEqual({
      success: true, account_id: '111', entity_type: 'AD_ACCOUNT', action: 'LIST', count: 1, truncated: true,
      adAccounts: [{ id: 111, name: 'Own' }], note: AD_ACCOUNT_CUT_NOTE,
    });
    expect(JSON.stringify(res.body)).not.toMatch(/9000|500|Client/);
  });

  it('passes the bounds, the caller\'s userId and only the checked fields to Emma\'s implementation', async () => {
    mockMarketing.mockResolvedValueOnce({ success: true, campaigns: [{ id: 1 }], truncated: true });
    const res = await post('read', { entity_type: 'CAMPAIGN', action: 'LIST', account_id: 'urn:li:sponsoredAccount:111', params: { status: ['ACTIVE', 'PAUSED'] } });
    expect(res.status).toBe(200);
    expect(mockMarketing).toHaveBeenCalledWith('user-1', 'CAMPAIGN', 'LIST', '111', { status: 'ACTIVE,PAUSED' }, LINKEDIN_READ_ROUTE_BOUNDS);
    expect(LINKEDIN_READ_ROUTE_BOUNDS).toEqual({ timeoutMs: 30_000, maxPages: 5, maxElements: 500, maxReferencedPosts: 10 });
    expect(res.body).toMatchObject({ count: 1, truncated: true, campaigns: [{ id: 1 }] });
    expect(mockEnforce).toHaveBeenCalledWith('user-1', 'call_linkedin_marketing_api');
  });

  it('never takes an identity from the body: a userId (top level or in params) is refused, nothing is called', async () => {
    for (const body of [
      { entity_type: 'AD_ACCOUNT', action: 'LIST', account_id: '111', userId: 'victim' },
      { entity_type: 'CREATIVE', action: 'LIST', account_id: '111', params: { campaign_id: '1', userId: 'victim' } },
      { entity_type: 'AD_ACCOUNT', action: 'LIST', account_id: '111', ownerUserId: 'victim' },
    ]) {
      const res = await post('read', body);
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/does not take "(userId|ownerUserId)"/);
    }
    expect(mockMarketing).not.toHaveBeenCalled();
    expect(mockAccounts).not.toHaveBeenCalled();
  });

  it('refuses every write and every injection value with a 400 before anything is called', async () => {
    const bodies = [
      { entity_type: 'CAMPAIGN_GROUP', action: 'CREATE', account_id: '111', params: { name: 'x' } },
      { entity_type: 'CREATIVE', action: 'UPDATE', account_id: '111', params: { creative_id: '1', status: 'ACTIVE' } },
      { entity_type: 'INMAIL', action: 'SEND_TEST', account_id: '111', params: { recipient_email: 'a@b.c' } },
      { entity_type: 'MEDIA', action: 'UPLOAD_IMAGE', account_id: '111', params: { image_url: 'http://169.254.169.254/' } },
      { entity_type: 'CAMPAIGN', action: 'LIST', account_id: '111', params: { status: 'ACTIVE)))&q=x' } },
      { entity_type: 'CREATIVE', action: 'LIST', account_id: '111', params: { campaign_id: '1&x=2' } },
      { entity_type: 'AD_ACCOUNT', action: 'LIST', account_id: '111&accounts=2' },
      // Emma's POST GET reads any post the token can see, an unshared account's too: not offered.
      { entity_type: 'POST', action: 'GET', account_id: '111', params: { post_urn: 'urn:li:share:1' } },
    ];
    for (const body of bodies) expect((await post('read', body)).status).toBe(400);
    const empty = await post('read', undefined);
    expect(empty.status).toBe(400);
    expect(mockMarketing).not.toHaveBeenCalled();
  });

  it('answers 404 for an account that is not the caller\'s own or shared (a LinkedIn id on a non-ad-account row does not count)', async () => {
    for (const accountId of ['999', '333', '444']) {
      const res = await post('read', { entity_type: 'CAMPAIGN_GROUP', action: 'LIST', account_id: accountId });
      expect(res.status).toBe(404);
      expect(res.body.message).toMatch(new RegExp(`LinkedIn Ads account ${accountId} is not connected to your account or shared with your organization`));
    }
    expect(mockMarketing).not.toHaveBeenCalled();
  });

  it('answers CREATIVE LIST with the count of referenced posts left unexpanded, and ESTIMATE_REACH as two numbers', async () => {
    mockMarketing.mockResolvedValueOnce({ success: true, creatives: [{ id: 1 }, { id: 2 }], referencedPostsNotExpanded: 4 });
    const creatives = await post('read', { entity_type: 'CREATIVE', action: 'LIST', account_id: '111', params: { campaign_id: '77' } });
    expect(creatives.body).toEqual({ success: true, account_id: '111', entity_type: 'CREATIVE', action: 'LIST', count: 2, truncated: false, creatives: [{ id: 1 }, { id: 2 }], referenced_posts_not_expanded: 4 });
    expect(mockMarketing).toHaveBeenLastCalledWith('user-1', 'CREATIVE', 'LIST', '111', { campaign_id: '77' }, LINKEDIN_READ_ROUTE_BOUNDS);

    mockMarketing.mockResolvedValueOnce({ success: true, audienceCount: { elements: [{ active: 900, total: 4000, raw: 'x' }], paging: {} } });
    const include = [{ facet_urn: 'urn:li:adTargetingFacet:locations', values: ['urn:li:geo:103644278'] }];
    const reach = await post('read', { entity_type: 'TARGETING', action: 'ESTIMATE_REACH', account_id: '111', params: { targeting_include: include } });
    expect(reach.body).toEqual({ success: true, account_id: '111', entity_type: 'TARGETING', action: 'ESTIMATE_REACH', audience: { active: 900, total: 4000 } });
    expect(mockMarketing).toHaveBeenLastCalledWith('user-1', 'TARGETING', 'ESTIMATE_REACH', '111', { targeting_include: include }, LINKEDIN_READ_ROUTE_BOUNDS);
  });

  it('maps LinkedIn failures: a 4xx with its words, 401 as reconnect, 5xx / timeout / anything else as a fixed text', async () => {
    const fail = (message: string, linkedInStatus?: number) => Object.assign(new Error(message), { linkedInStatus });
    const cases: Array<[unknown, number, RegExp, RegExp?]> = [
      [fail('Not enough permissions to access: GET /adCampaignGroups', 403), 403, /^LinkedIn refused the request \(HTTP 403\): Not enough permissions/],
      [fail('Unauthorized', 401), 403, /Reconnect LinkedIn Ads in AgentWeb/],
      [fail('Too many requests', 429), 429, /HTTP 429/],
      [fail(`Bad field\n  - fields: ${'x'.repeat(500)}`, 400), 400, /^LinkedIn refused the request \(HTTP 400\): Bad field - fields: x+\.\.\.$/],
      [fail('upstream exploded with internal details', 503), 502, /^LinkedIn could not answer \(HTTP 503\)\. Try again later$/, /internal details/],
      [fail('timeout of 30000ms exceeded'), 504, /did not answer in time/],
      [fail('socket hang up'), 502, /^LinkedIn could not be reached/],
      [new Error('LinkedIn Ads access token expired and no refresh token available. Please reconnect your account.'), 409, /has expired\. Reconnect/],
      [Object.assign(new Error('Request failed with status code 400'), { isAxiosError: true, response: { status: 400 } }), 409, /did not renew the sign-in/],
      [Object.assign(new Error('timeout of 30000ms exceeded'), { isAxiosError: true, code: 'ECONNABORTED' }), 504, /did not answer in time/],
      [new Error('Cannot read properties of undefined (reading \'x\') at /srv/app.js:1'), 500, /^The LinkedIn Ads read failed\. Try again later$/, /srv/],
    ];
    const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    for (const [err, status, pattern, hidden] of cases) {
      mockMarketing.mockRejectedValueOnce(err);
      const res = await post('read', { entity_type: 'TARGETING', action: 'LIST_FACETS', account_id: '111' });
      expect(res.status).toBe(status);
      expect(res.body.message).toMatch(pattern);
      if (hidden) expect(res.body.message).not.toMatch(hidden);
    }
    spy.mockRestore();
  });

  it('refuses an evaluation sandbox\'s denied tool class with a 403, nothing called', async () => {
    mockEnforce.mockRejectedValueOnce(new EvaluationDenied('Tool "call_linkedin_marketing_api" is not available in this sandbox workspace (third_party_writes).'));
    const res = await post('read', { entity_type: 'AD_ACCOUNT', action: 'LIST', account_id: '111' });
    expect(res.status).toBe(403);
    expect(res.body.message).toBe('This tool is not available in this sandbox workspace');
    expect(mockMarketing).not.toHaveBeenCalled();
  });
});

describe('POST /linkedin-ads/insights', () => {
  it('passes the timeout bound, the caller\'s userId and only the checked fields; answers fixed fields', async () => {
    mockInsights.mockResolvedValueOnce({ success: true, analytics: [{ impressions: 3, pivotValues: ['urn:li:sponsoredCampaign:5'] }], secret: 'x' });
    const res = await post('insights', { account_id: '222', pivot: 'CAMPAIGN', dateRange: RANGE });
    expect(res.status).toBe(200);
    // No campaign / creative filters ever reach Emma: the rows are scoped by the checked account alone.
    expect(mockInsights).toHaveBeenCalledWith('user-1', '222', {
      pivot: 'CAMPAIGN', dateRange: RANGE, timeGranularity: 'ALL', fields: ['impressions', 'clicks', 'costInLocalCurrency', 'dateRange', 'pivotValues'],
    }, LINKEDIN_INSIGHTS_ROUTE_BOUNDS);
    expect(LINKEDIN_INSIGHTS_ROUTE_BOUNDS).toEqual({ timeoutMs: 30_000 });
    expect(res.body).toEqual({
      success: true, account_id: '222', pivot: 'CAMPAIGN', timeGranularity: 'ALL', dateRange: RANGE,
      fields: ['impressions', 'clicks', 'costInLocalCurrency', 'dateRange', 'pivotValues'], count: 1, truncated: false,
      elements: [{ impressions: 3, pivotValues: ['urn:li:sponsoredCampaign:5'] }],
    });
    expect(mockEnforce).toHaveBeenCalledWith('user-1', 'call_linkedin_ads_insights_api');
  });

  it('checks the body again: injection, bad dates and identities are 400s, an unknown account a 404; nothing is called', async () => {
    for (const body of [
      { account_id: '111', pivot: 'CAMPAIGN', dateRange: RANGE, fields: ['impressions&accounts=urn:li:sponsoredAccount:1'] },
      { account_id: '111', pivot: 'CAMPAIGN', dateRange: { start: { year: '2026', month: 1, day: 1 }, end: RANGE.end } },
      { account_id: '111', pivot: 'CAMPAIGN', dateRange: { start: { year: 2026, month: 2, day: 30 }, end: RANGE.end } },
      { account_id: '111', pivot: 'CAMPAIGN', dateRange: RANGE, userId: 'victim' },
      { account_id: '111', pivot: 'CAMPAIGN', dateRange: RANGE, campaigns: ['1'] },
      { account_id: '111', pivot: 'CAMPAIGN', dateRange: RANGE, campaign_groups: ['1'] },
      { account_id: '111', pivot: 'CAMPAIGN', dateRange: RANGE, creatives: ['urn:li:sponsoredCreative:9'] },
    ]) {
      const res = await post('insights', body);
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/must|does not take|not a real/);
    }
    expect((await post('insights', { account_id: '999', pivot: 'CAMPAIGN', dateRange: RANGE })).status).toBe(404);
    expect(mockInsights).not.toHaveBeenCalled();
  });

  it('cuts many rows to the size cap with truncated: true', async () => {
    mockInsights.mockResolvedValueOnce({ success: true, analytics: Array.from({ length: 5000 }, (_, i) => ({ impressions: i, pivotValues: [`urn:li:sponsoredCreative:${i}`] })) });
    const res = await post('insights', { account_id: '111', pivot: 'CREATIVE', dateRange: RANGE });
    expect(res.body.truncated).toBe(true);
    expect(res.body.count).toBe(res.body.elements.length);
    expect(res.body.count).toBeLessThan(5000);
    expect(JSON.stringify(res.body, null, 2).length).toBeLessThanOrEqual(62_000);
  });
});
