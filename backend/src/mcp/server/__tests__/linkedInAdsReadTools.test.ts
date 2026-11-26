/**
 * ENG-2840 (W2-9): the two LinkedIn Ads reads for outside agents (linkedInAdsReadTools.ts). What each sends to its route, what is refused
 * before anything is called (every write action, query-string injection values, bad dates, caps, unknown arguments), the fixed-field
 * answers and their size cap, error handling (4xx passes, 5xx is a fixed text) and the per-caller guards. No network: the self-call is a
 * double; the routes' own behaviour has its own test (src/__tests__/emmaLinkedInAdsReadRoutes.test.ts).
 */
jest.mock('../httpClient', () => ({ mcpFetch: jest.fn() }));

import { mcpFetch } from '../httpClient';
import { mcpToolRegistry } from '../registry';
import { GUARDS, TIMEOUTS_MS } from '../linkedInAdsReadTools';

const mockFetch = mcpFetch as jest.Mock;
const ctxFor = (userId: string) => ({ userId, sessionId: 'sess-1', apiKeyId: 'key-1', externalMcp: true });
const call = (name: string, args: unknown, userId = 'user-1') => (mcpToolRegistry.getTool(name) as any).execute(args, ctxFor(userId));
const parse = (r: any) => JSON.parse(r.content[0].text);
const INSIGHTS = 'call_linkedin_ads_insights_api';
const READ = 'call_linkedin_marketing_api';
const RANGE = { start: { year: 2026, month: 1, day: 1 }, end: { year: 2026, month: 3, day: 31 } };
const insights = (over: Record<string, unknown> = {}) => ({ account_id: '111', pivot: 'CAMPAIGN', dateRange: RANGE, ...over });
const read = (entity_type: string, action: string, params?: unknown) => ({ entity_type, action, account_id: '111', ...(params === undefined ? {} : { params }) });

beforeEach(() => {
  mockFetch.mockReset();
  Object.values(GUARDS).forEach((g) => g.reset());
});

async function refused(tool: string, args: unknown, pattern: RegExp) {
  await expect(call(tool, args)).rejects.toThrow(pattern);
}

function nothingCalled() {
  expect(mockFetch).not.toHaveBeenCalled();
  Object.values(GUARDS).forEach((g) => {
    expect(g.inFlight).toBe(0);
    expect(g.recent.size).toBe(0);
  });
}

describe('call_linkedin_marketing_api: reads only', () => {
  // Every write Emma's tool takes (emma/impl/adsApis.ts callLinkedInMarketingApi), plus pairs that do not exist and near-misses.
  const WRITES: Array<[string, string]> = [
    ['CAMPAIGN_GROUP', 'CREATE'], ['CAMPAIGN_GROUP', 'UPDATE'],
    ['CAMPAIGN', 'CREATE'], ['CAMPAIGN', 'UPDATE'],
    ['CREATIVE', 'CREATE'], ['CREATIVE', 'CREATE_INLINE'], ['CREATIVE', 'CREATE_DYNAMIC'], ['CREATIVE', 'RETAG_UTM'], ['CREATIVE', 'UPDATE'],
    ['POST', 'CREATE'],
    ['MEDIA', 'UPLOAD_IMAGE'], ['MEDIA', 'UPLOAD_VIDEO'], ['MEDIA', 'UPLOAD_DOCUMENT'], ['MEDIA', 'INIT_IMAGE_UPLOAD'], ['MEDIA', 'INIT_VIDEO_UPLOAD'], ['MEDIA', 'FINALIZE_VIDEO'],
    ['INMAIL', 'CREATE_CONTENT'], ['INMAIL', 'SEND_TEST'],
    ['CONVERSATION_AD', 'CREATE'], ['CONVERSATION_AD', 'CREATE_CONTENT'], ['CONVERSATION_AD', 'SET_FIRST_CONTENT'],
    ['AD_ACCOUNT', 'GET'], ['POST', 'LIST'], ['CAMPAIGN', 'list'], ['campaign', 'LIST'], ['TARGETING', 'CREATE'], ['CREATIVE', 'GET'],
  ];

  it('refuses every write action (and every pair outside the read list) before anything is called', async () => {
    for (const [entity, action] of WRITES) {
      await expect(call(READ, read(entity, action, { campaign_id: '1', status: 'ACTIVE', recipient_email: 'x@y.z' })))
        .rejects.toThrow(/^call_linkedin_marketing_api: .*is not available here: this tool only reads.*Nothing was changed\.$/);
    }
    await refused(READ, { action: 'LIST', account_id: '111' }, /entity_type and action are required/);
    await refused(READ, { entity_type: ['AD_ACCOUNT'], action: 'LIST', account_id: '111' }, /entity_type and action are required/);
    await refused(READ, read('AD_ACCOUNT&x=1', 'LIST'), /that entity_type and action is not available here/);
    nothingCalled();
  });

  it('refuses any argument or param it does not take, by name (a userId or a raw targeting_criteria never reaches the route)', async () => {
    await refused(READ, { ...read('AD_ACCOUNT', 'LIST'), userId: 'victim' }, /"userId" is not an input of call_linkedin_marketing_api/);
    await refused(READ, read('AD_ACCOUNT', 'LIST', { status: 'ACTIVE' }), /params of AD_ACCOUNT LIST does not take "status"; it takes nothing/);
    await refused(READ, read('TARGETING', 'ESTIMATE_REACH', { targeting_criteria: { include: {} } }), /does not take "targeting_criteria"/);
    await refused(READ, read('TARGETING', 'SEARCH', { facet: 'urn:li:adTargetingFacet:locations', locale_language: 'en' }), /does not take "locale_language"/);
    await refused(READ, read('CREATIVE', 'LIST', { campaign_id: '1', __proto__x: 1 }), /does not take "__proto__x"/);
    await refused(READ, read('CREATIVE', 'LIST', 'campaign_id=1'), /params of CREATIVE LIST must be an object/);
    nothingCalled();
  });

  it('refuses query-string injection and every value outside its exact shape', async () => {
    const cases: Array<[unknown, RegExp]> = [
      [read('CAMPAIGN_GROUP', 'LIST', { status: 'ACTIVE)))&q=x' }), /params\.status must be one of/],
      [read('CAMPAIGN_GROUP', 'LIST', { status: 'ACTIVE,PAUSED' }), /params\.status must be one of/],
      [read('CAMPAIGN_GROUP', 'LIST', { status: ['ACTIVE', 'ACTIVE'] }), /the same status twice/],
      [read('CAMPAIGN', 'LIST', { campaign_group_id: '1)&search=(' }), /params\.campaign_group_id must be a numeric campaign group id/],
      [read('CAMPAIGN', 'LIST', { campaign_group_id: 'urn:li:sponsoredCampaignGroup:1' }), /params\.campaign_group_id must be/],
      [read('CAMPAIGN', 'LIST', { campaign_group_id: '1', status: 'ACTIVE' }), /not both/],
      [read('CREATIVE', 'LIST', {}), /params\.campaign_id is required/],
      [read('CREATIVE', 'LIST', { campaign_id: '1%26x' }), /params\.campaign_id must be a numeric campaign id/],
      [read('CREATIVE', 'LIST', { campaign_id: -5 }), /params\.campaign_id must be/],
      [read('POST', 'GET', { post_urn: 'urn:li:share:1/../../adAccounts' }), /params\.post_urn is required: urn:li:share/],
      [read('POST', 'GET', { post_urn: 'urn:li:activity:1' }), /params\.post_urn is required/],
      [read('TARGETING', 'SEARCH', { facet: 'urn:li:adTargetingFacet:locations&x=1' }), /params\.facet is required/],
      [read('TARGETING', 'SEARCH', { facet: 'urn:li:adTargetingFacet:locations', query: 'x'.repeat(101) }), /params\.query must be text of at most 100/],
      [read('TARGETING', 'SEARCH', { facet: 'urn:li:adTargetingFacet:locations', query: 'a\nb' }), /params\.query must be text/],
      [read('TARGETING', 'SEARCH', { facet: 'urn:li:adTargetingFacet:locations', query: `a${String.fromCharCode(0x202e)}b` }), /params\.query must be text/],
      [read('TARGETING', 'ESTIMATE_REACH', {}), /params\.targeting_include is required/],
      [read('TARGETING', 'ESTIMATE_REACH', { targeting_include: [{ facet_urn: 'urn:li:adTargetingFacet:locations', values: ['urn:li:geo:1&x=1'] }] }), /values\[0\] must be a LinkedIn URN/],
      [read('TARGETING', 'ESTIMATE_REACH', { targeting_include: [{ facet_urn: 'urn:li:adTargetingFacet:loc_ations', values: ['urn:li:geo:1'] }] }), /facet_urn must be a facet URN/],
      [read('TARGETING', 'ESTIMATE_REACH', { targeting_include: [{ facet_urn: 'urn:li:adTargetingFacet:locations', values: ['urn:li:geo:1'], extra: 1 }] }), /does not take "extra"/],
      [read('TARGETING', 'ESTIMATE_REACH', { targeting_include: [
        { facet_urn: 'urn:li:adTargetingFacet:locations', values: ['urn:li:geo:1'] }, { facet_urn: 'urn:li:adTargetingFacet:locations', values: ['urn:li:geo:2'] },
      ] }), /has the facet urn:li:adTargetingFacet:locations twice/],
      [{ ...read('AD_ACCOUNT', 'LIST'), account_id: '1&x=2' }, /account_id must be the numeric LinkedIn Ads account id/],
      [{ ...read('AD_ACCOUNT', 'LIST'), account_id: '../111' }, /account_id must be/],
      [{ ...read('AD_ACCOUNT', 'LIST'), account_id: undefined }, /account_id is required/],
    ];
    for (const [args, pattern] of cases) await refused(READ, args, pattern);
    nothingCalled();
  });

  it('caps targeting at 10 facets and 50 values in all', async () => {
    const facets = (n: number, per: number) => Array.from({ length: n }, (_, i) => ({
      facet_urn: `urn:li:adTargetingFacet:f${String.fromCharCode(97 + i)}`.replace(/\d/g, ''),
      values: Array.from({ length: per }, (_, j) => `urn:li:geo:${i * 100 + j}`),
    }));
    await refused(READ, read('TARGETING', 'ESTIMATE_REACH', { targeting_include: facets(11, 1) }), /list of 1 to 10 facets/);
    await refused(READ, read('TARGETING', 'ESTIMATE_REACH', { targeting_include: facets(6, 9) }), /more than 50 values in all/);
    await refused(READ, read('TARGETING', 'ESTIMATE_REACH', { targeting_include: facets(1, 1), targeting_exclude: facets(11, 1) }), /targeting_exclude must be a list of 0 to 10 facets/);
    nothingCalled();
    mockFetch.mockResolvedValueOnce({ success: true, account_id: '111', entity_type: 'TARGETING', action: 'ESTIMATE_REACH', audience: { active: 1, total: 2 } });
    await call(READ, read('TARGETING', 'ESTIMATE_REACH', { targeting_include: facets(5, 10) }));
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

describe('call_linkedin_marketing_api: the request and the answer', () => {
  it('sends the checked request (ids as digits, status as a list) to the read route with its timeout, and never an identity', async () => {
    mockFetch.mockResolvedValueOnce({ success: true, account_id: '111', entity_type: 'CAMPAIGN', action: 'LIST', count: 0, truncated: false, campaigns: [] });
    await call(READ, { entity_type: 'CAMPAIGN', action: 'LIST', account_id: 'urn:li:sponsoredAccount:111', params: { status: 'ACTIVE' } });
    const req = mockFetch.mock.calls[0][0];
    expect(req).toMatchObject({ method: 'POST', path: '/api/emma/linkedin-ads/read', timeoutMs: TIMEOUTS_MS.call_linkedin_marketing_api });
    expect(req.body).toEqual({ entity_type: 'CAMPAIGN', action: 'LIST', account_id: '111', params: { status: ['ACTIVE'] } });
    expect(req.context.userId).toBe('user-1');

    mockFetch.mockResolvedValueOnce({ success: true, account_id: '111', entity_type: 'CREATIVE', action: 'LIST', creatives: [] });
    await call(READ, read('CREATIVE', 'LIST', { campaign_id: 42 }));
    expect(mockFetch.mock.calls[1][0].body).toEqual({ entity_type: 'CREATIVE', action: 'LIST', account_id: '111', params: { campaign_id: '42' } });
  });

  it('answers fixed fields only, re-cut to the size cap', async () => {
    const creatives = Array.from({ length: 400 }, (_, i) => ({ id: i, content: { reference: `urn:li:share:${i}` }, note: 'n'.repeat(400) }));
    mockFetch.mockResolvedValueOnce({
      success: true, account_id: '111', entity_type: 'CREATIVE', action: 'LIST', count: 400, truncated: false, creatives,
      referenced_posts_not_expanded: 3, error: 'raw stack', debug: { token: 'secret' },
    });
    const r = await call(READ, read('CREATIVE', 'LIST', { campaign_id: '9' }));
    const a = parse(r);
    expect(Object.keys(a).sort()).toEqual(['account_id', 'action', 'count', 'creatives', 'entity_type', 'referenced_posts_not_expanded', 'truncated']);
    expect(a.truncated).toBe(true);
    expect(a.count).toBe(a.creatives.length);
    expect(a.count).toBeLessThan(400);
    expect(r.content[0].text.length).toBeLessThanOrEqual(62_000);
    expect(r.content[0].text).not.toMatch(/secret|raw stack/);
  });

  it('answers ESTIMATE_REACH as two numbers and POST GET as the post', async () => {
    mockFetch.mockResolvedValueOnce({ success: true, account_id: '111', entity_type: 'TARGETING', action: 'ESTIMATE_REACH', audience: { active: 1200, total: 5000, extra: 'x' } });
    const est = parse(await call(READ, read('TARGETING', 'ESTIMATE_REACH', { targeting_include: [{ facet_urn: 'urn:li:adTargetingFacet:locations', values: ['urn:li:geo:103644278', 'urn:li:staffCountRange:(11,50)'] }] })));
    expect(est).toEqual({ account_id: '111', entity_type: 'TARGETING', action: 'ESTIMATE_REACH', audience: { active: 1200, total: 5000 } });

    mockFetch.mockResolvedValueOnce({ success: true, account_id: '111', entity_type: 'POST', action: 'GET', post: { id: 'urn:li:share:5', commentary: 'hi' }, truncated: false });
    const post = parse(await call(READ, read('POST', 'GET', { post_urn: 'urn:li:share:5' })));
    expect(post).toEqual({ account_id: '111', entity_type: 'POST', action: 'GET', post: { id: 'urn:li:share:5', commentary: 'hi' }, truncated: false });
  });
});

describe('call_linkedin_ads_insights_api', () => {
  it('sends the checked request with Emma\'s default metrics plus the row labels; answers fixed fields', async () => {
    mockFetch.mockResolvedValueOnce({
      success: true, account_id: '111', pivot: 'CAMPAIGN', timeGranularity: 'ALL', dateRange: RANGE, fields: ['impressions'],
      count: 1, truncated: false, elements: [{ impressions: 5, pivotValues: ['urn:li:sponsoredCampaign:7'] }], message: 'internal',
    });
    const a = parse(await call(INSIGHTS, insights({ campaigns: ['urn:li:sponsoredCampaign:7', 8] })));
    const req = mockFetch.mock.calls[0][0];
    expect(req).toMatchObject({ method: 'POST', path: '/api/emma/linkedin-ads/insights', timeoutMs: TIMEOUTS_MS.call_linkedin_ads_insights_api });
    expect(req.body).toEqual({
      account_id: '111', pivot: 'CAMPAIGN', timeGranularity: 'ALL', dateRange: RANGE,
      fields: ['impressions', 'clicks', 'costInLocalCurrency', 'dateRange', 'pivotValues'], campaigns: ['7', '8'],
    });
    expect(Object.keys(a).sort()).toEqual(['account_id', 'count', 'dateRange', 'elements', 'fields', 'pivot', 'timeGranularity', 'truncated']);
    expect(a.elements).toEqual([{ impressions: 5, pivotValues: ['urn:li:sponsoredCampaign:7'] }]);
  });

  it('refuses query-string injection in every value that reaches the LinkedIn query string', async () => {
    const cases: Array<[unknown, RegExp]> = [
      [insights({ fields: ['impressions&accounts=urn:li:sponsoredAccount:1'] }), /fields\[0\] must be a LinkedIn metric name/],
      [insights({ fields: ['impressions,clicks'] }), /fields\[0\] must be a LinkedIn metric name/],
      [insights({ fields: ['impressions', 'impressions'] }), /the same name twice/],
      [insights({ fields: 'impressions' }), /fields must be a list of 1 to 20/],
      [insights({ pivot: 'CAMPAIGN&accounts=urn:li:sponsoredAccount:1' }), /pivot must be one of/],
      [insights({ pivot: 'MEMBER_COMPANY' }), /pivot must be one of/],
      [insights({ timeGranularity: 'ALL&x=1' }), /timeGranularity must be one of/],
      [insights({ dateRange: { start: { year: '2026&accounts=urn:li:sponsoredAccount:1', month: 1, day: 1 }, end: RANGE.end } }), /dateRange\.start\.year must be a whole number from 2000 to 2100/],
      [insights({ campaigns: ['123&accounts=urn:li:sponsoredAccount:1'] }), /campaigns\[0\] must be a numeric LinkedIn id or urn:li:sponsoredCampaign:<id>/],
      [insights({ campaigns: ['urn:li:sponsoredCampaignGroup:1'] }), /campaigns\[0\] must be/],
      [insights({ campaign_groups: ['urn:li:sponsoredCampaignGroup:1)&x=('] }), /campaign_groups\[0\] must be/],
      [insights({ creatives: ['urn:li:sponsoredCreative:abc'] }), /creatives\[0\] must be/],
      [insights({ account_id: '111&accounts=List(urn:li:sponsoredAccount:2)' }), /account_id must be the numeric LinkedIn Ads account id/],
      [{ ...insights(), userId: 'victim' }, /"userId" is not an input of call_linkedin_ads_insights_api/],
      [{ ...insights(), adGroups: ['1'] }, /"adGroups" is not an input/],
    ];
    for (const [args, pattern] of cases) await refused(INSIGHTS, args, pattern);
    nothingCalled();
  });

  it('refuses bad dates: not whole numbers, out of range, not a real day, reversed, too long, wrong shape', async () => {
    const at = (year: unknown, month: unknown, day: unknown) => ({ year, month, day });
    const cases: Array<[unknown, RegExp]> = [
      [{ start: at(2026, 13, 1), end: RANGE.end }, /dateRange\.start\.month must be a whole number from 1 to 12/],
      [{ start: at(2026, 1, 32), end: RANGE.end }, /dateRange\.start\.day must be a whole number from 1 to 31/],
      [{ start: at(2026, 1, 1.5), end: RANGE.end }, /day must be a whole number/],
      [{ start: at(1999, 1, 1), end: RANGE.end }, /year must be a whole number from 2000 to 2100/],
      [{ start: RANGE.start, end: at(2101, 1, 1) }, /dateRange\.end\.year must be/],
      [{ start: at(2026, 2, 29), end: RANGE.end }, /dateRange\.start is not a real calendar date/],
      [{ start: at(2026, 4, 31), end: at(2026, 5, 1) }, /not a real calendar date/],
      [{ start: at(2026, 3, 1), end: at(2026, 2, 1) }, /dateRange\.end is before dateRange\.start/],
      [{ start: at(2020, 1, 1), end: at(2023, 1, 2) }, /longer than 1096 days/],
      [{ start: { year: 2026, month: 1 }, end: RANGE.end }, /dateRange\.start\.day must be a whole number/],
      [{ start: { ...RANGE.start, hour: 1 }, end: RANGE.end }, /dateRange\.start does not take "hour"/],
      [{ start: RANGE.start }, /dateRange\.end must be an object/],
      [{ ...RANGE, timezone: 'UTC' }, /dateRange does not take "timezone"/],
      ['2026-01-01..2026-03-31', /dateRange must be an object/],
    ];
    for (const [dateRange, pattern] of cases) await refused(INSIGHTS, insights({ dateRange }), pattern);
    await refused(INSIGHTS, { account_id: '111', pivot: 'CAMPAIGN' }, /dateRange is required/);
    nothingCalled();
    // 2024 is a leap year; exactly 1096 days is allowed.
    mockFetch.mockResolvedValue({ success: true, elements: [] });
    await call(INSIGHTS, insights({ dateRange: { start: at(2024, 2, 29), end: at(2024, 2, 29) } }));
    await call(INSIGHTS, insights({ dateRange: { start: at(2020, 1, 1), end: at(2023, 1, 1) } }));
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('caps fields and filter ids at 20', async () => {
    const twentyOne = Array.from({ length: 21 }, (_, i) => `m${i}`);
    await refused(INSIGHTS, insights({ fields: twentyOne }), /fields must be a list of 1 to 20/);
    await refused(INSIGHTS, insights({ campaigns: twentyOne.map((_, i) => String(i + 1)) }), /campaigns must be a list of at most 20 ids/);
    await refused(INSIGHTS, insights({ creatives: ['1', '1'] }), /creatives has the same id twice/);
    nothingCalled();
  });

  it('cuts the rows to about 60 KB with truncated: true', async () => {
    const elements = Array.from({ length: 3000 }, (_, i) => ({ impressions: i, clicks: i, costInLocalCurrency: '1.00', pivotValues: [`urn:li:sponsoredCampaign:${i}`] }));
    mockFetch.mockResolvedValueOnce({ success: true, account_id: '111', pivot: 'CAMPAIGN', timeGranularity: 'DAILY', dateRange: RANGE, fields: ['impressions'], truncated: false, elements });
    const r = await call(INSIGHTS, insights({ timeGranularity: 'DAILY' }));
    const a = parse(r);
    expect(a.truncated).toBe(true);
    expect(a.count).toBe(a.elements.length);
    expect(a.count).toBeLessThan(3000);
    expect(r.content[0].text.length).toBeLessThanOrEqual(62_000);
  });
});

describe('errors', () => {
  it('passes a 4xx through with the route\'s own words', async () => {
    mockFetch.mockRejectedValueOnce(new Error('API error (404): LinkedIn Ads account 111 is not connected to your account or shared with your organization.'));
    await expect(call(READ, read('AD_ACCOUNT', 'LIST'))).rejects.toThrow('API error (404): LinkedIn Ads account 111 is not connected');
    mockFetch.mockRejectedValueOnce(new Error('API error (429): LinkedIn is limiting requests'));
    await expect(call(INSIGHTS, insights())).rejects.toThrow('API error (429): LinkedIn is limiting requests');
  });

  it('turns a 5xx or an unreachable route into a fixed text (no internal detail)', async () => {
    mockFetch.mockRejectedValueOnce(new Error('API error (502): stack at /srv/app/internal.js'));
    await expect(call(READ, read('AD_ACCOUNT', 'LIST'))).rejects.toThrow(/^call_linkedin_marketing_api: the service could not answer \(HTTP 502\)\. Try again later\. Nothing was changed\.$/);
    mockFetch.mockRejectedValueOnce(new Error('connect ECONNREFUSED 127.0.0.1:3001'));
    await expect(call(INSIGHTS, insights())).rejects.toThrow(/^call_linkedin_ads_insights_api: the service could not be reached or did not answer in time\. Try again later\. Nothing was changed\.$/);
  });

  it('treats an answer without success: true as a refusal carrying only its short message', async () => {
    mockFetch.mockResolvedValueOnce({ success: false, message: 'Nope', error: 'raw' });
    await expect(call(READ, read('AD_ACCOUNT', 'LIST'))).rejects.toThrow(/^call_linkedin_marketing_api: Nope\.$/);
  });
});

describe('guards', () => {
  it('allows one call at a time per caller and frees the slot after', async () => {
    let release!: (v: unknown) => void;
    mockFetch.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const first = call(READ, read('AD_ACCOUNT', 'LIST'));
    await refused(READ, read('AD_ACCOUNT', 'LIST'), /another call of yours to this tool is still running/);
    release({ success: true, account_id: '111', entity_type: 'AD_ACCOUNT', action: 'LIST', adAccounts: [] });
    await first;
    expect(GUARDS.call_linkedin_marketing_api.inFlight).toBe(0);
    mockFetch.mockResolvedValueOnce({ success: true, adAccounts: [] });
    await call(READ, read('AD_ACCOUNT', 'LIST'));
  });

  it('runs at most 4 callers at once per process, and frees the slot when the call fails', async () => {
    const releases: Array<(v: unknown) => void> = [];
    mockFetch.mockImplementation(() => new Promise((resolve) => { releases.push(resolve); }));
    const running = ['a', 'b', 'c', 'd'].map((u) => call(INSIGHTS, insights(), u));
    await expect(call(INSIGHTS, insights(), 'e')).rejects.toThrow(/this tool is busy/);
    releases.forEach((r) => r({ success: true, elements: [] }));
    await Promise.all(running);
    mockFetch.mockReset();
    mockFetch.mockRejectedValueOnce(new Error('API error (500): x'));
    await expect(call(INSIGHTS, insights(), 'e')).rejects.toThrow(/HTTP 500/);
    expect(GUARDS.call_linkedin_ads_insights_api.inFlight).toBe(0);
  });

  it('allows 60 calls an hour per caller', async () => {
    mockFetch.mockResolvedValue({ success: true, adAccounts: [] });
    for (let i = 0; i < 60; i++) await call(READ, read('AD_ACCOUNT', 'LIST'));
    await refused(READ, read('AD_ACCOUNT', 'LIST'), /you have made 60 calls to this tool in the last hour/);
    await call(READ, read('AD_ACCOUNT', 'LIST'), 'user-2');
    expect(mockFetch).toHaveBeenCalledTimes(61);
    expect(GUARDS.call_linkedin_marketing_api.processMax).toBe(4);
    expect(GUARDS.call_linkedin_ads_insights_api.perHour).toBe(60);
  });

  it('does not spend a call of the hourly allowance on a refused argument', async () => {
    await refused(READ, read('INMAIL', 'SEND_TEST', { recipient_email: 'x@y.z' }), /only reads/);
    expect(GUARDS.call_linkedin_marketing_api.recent.size).toBe(0);
  });
});

describe('registration', () => {
  it('registers both tools under Emma\'s names, for user accounts, not read-only (a read can refresh and store a token)', () => {
    for (const name of [INSIGHTS, READ]) {
      const tool = mcpToolRegistry.getTool(name) as any;
      expect(tool.requiresUserAccount).toBe(true);
      expect(tool.readOnly).not.toBe(true);
      expect(tool.definition.description).toMatch(/Read-only over MCP/);
    }
    const schema = (mcpToolRegistry.getTool(READ) as any).definition.inputSchema;
    expect([...schema.properties.entity_type.enum].sort()).toEqual(['AD_ACCOUNT', 'CAMPAIGN', 'CAMPAIGN_GROUP', 'CREATIVE', 'POST', 'TARGETING']);
    expect([...schema.properties.action.enum].sort()).toEqual(['ESTIMATE_REACH', 'GET', 'LIST', 'LIST_FACETS', 'SEARCH']);
  });
});
