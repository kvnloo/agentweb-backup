import { readFileSync } from 'fs';
import { join } from 'path';
jest.mock('../utils/secretsManager', () => ({ getGoogleAdsCredentials: jest.fn() }));
jest.mock('../services/connectedAccountsDb', () => ({ updateAccountTokens: jest.fn() }));
import { GoogleAdsService } from '../services/googleAdsService';

const campaign = () => ({ campaign: { id: '1', resourceName: 'customers/123/campaigns/1', status: 'ENABLED', startDateTime: '2026-01-01 00:00:00', endDateTime: '2037-12-30 23:59:59', advertisingChannelType: 'SEARCH', campaignBudget: 'customers/123/campaignBudgets/5' }, campaignBudget: { id: '5', resourceName: 'customers/123/campaignBudgets/5', status: 'ENABLED', amountMicros: '10000000', explicitlyShared: true } });
const group = (id = '2') => ({ campaign: { id: '1' }, adGroup: { id, resourceName: `customers/123/adGroups/${id}`, status: 'ENABLED' } });
const ad = (id = '2') => ({ adGroup: { id }, adGroupAd: { resourceName: `customers/123/adGroupAds/${id}~3`, ad: { id: '3' }, status: 'ENABLED', policySummary: { approvalStatus: 'APPROVED', reviewStatus: 'REVIEWED' } } });
const keyword = (id = '2') => ({ adGroup: { id }, adGroupCriterion: { criterionId: '4', resourceName: `customers/123/adGroupCriteria/${id}~4`, status: 'ENABLED', negative: false, approvalStatus: 'APPROVED', primaryStatus: 'ELIGIBLE' } });
let service: GoogleAdsService;
let rows: Record<string, any[]>;
let api: jest.SpyInstance;
const verify = () => service.getServingChainStatus('user', '123', ['1']);
const state = async () => (await verify()).campaigns[0];
beforeEach(() => {
  jest.useFakeTimers().setSystemTime(new Date('2026-09-17T02:00:00Z'));
  service = new GoogleAdsService();
  jest.spyOn(service, 'getAccountCredentials').mockResolvedValue({ accessToken: 'token', customerId: '123', currency: 'USD', loginCustomerId: '999' });
  rows = { customer: [{ customer: { timeZone: 'America/Los_Angeles', currencyCode: 'USD' } }], campaign: [campaign()], ad_group: [group()], ad_group_ad: [ad()], ad_group_criterion: [keyword()], telemetry: [] };
  api = jest.spyOn(service as any, 'callApi').mockImplementation(async (_method, _path, _token, body: any) => {
    const results = rows[body.query.includes('metrics.impressions') ? 'telemetry' : body.query.match(/FROM (\w+)/)[1]];
    return { results, totalResultsCount: String(results.length) };
  });
});
afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks(); });

test('existing search returns a complete result page (control)', async () => {
  expect(await service.search('123', 'token', 'SELECT ad_group.id FROM ad_group WHERE campaign.id = 9')).toEqual(rows.ad_group);
});
test('SmartWaterHeater replay: paused creative blocks enabled campaign/group/keywords', async () => {
  rows.ad_group_ad[0].adGroupAd.status = 'PAUSED';
  const result = await state();
  expect(result.state).toBe('BLOCKED_BY_AD');
  expect(result.adGroups[0].blockers).toContainEqual(expect.objectContaining({ state: 'BLOCKED_BY_AD', entityId: '3' }));
});
test.each(['DISAPPROVED', 'UNDER_APPEAL'])('enabled creative with %s policy blocks', async policy => {
  if (policy === 'UNDER_APPEAL') rows.ad_group_ad[0].adGroupAd.policySummary.reviewStatus = policy;
  else rows.ad_group_ad[0].adGroupAd.policySummary.approvalStatus = policy;
  expect((await state()).state).toBe('BLOCKED_BY_POLICY');
});
test.each([
  ['APPROVED_LIMITED', 'REVIEWED'],
  ['AREA_OF_INTEREST_ONLY', 'ELIGIBLE_MAY_SERVE'],
])('serving-capable ad policy %s/%s remains eligible', async (approvalStatus, reviewStatus) => {
  rows.ad_group_ad[0].adGroupAd.policySummary = { approvalStatus, reviewStatus };
  expect((await state()).state).toBe('READY');
});
test.each(['PAUSED', 'REMOVED', 'zero'])('%s shared budget blocks', async status => {
  if (status === 'zero') rows.campaign[0].campaignBudget.amountMicros = '0';
  else rows.campaign[0].campaignBudget.status = status;
  expect((await state()).state).toBe('BLOCKED_BY_BUDGET');
});
test.each(['PAUSED', 'NOT_ELIGIBLE', 'DISAPPROVED', 'empty'])('no eligible keywords: %s', async status => {
  if (status === 'empty') rows.ad_group_criterion = [];
  else if (status === 'PAUSED') rows.ad_group_criterion[0].adGroupCriterion.status = status;
  else if (status === 'DISAPPROVED') rows.ad_group_criterion[0].adGroupCriterion.approvalStatus = status;
  else rows.ad_group_criterion[0].adGroupCriterion.primaryStatus = status;
  expect((await state()).state).toBe('BLOCKED_BY_KEYWORD');
});
test('mixed groups retain every blocked sibling and eligible path', async () => {
  rows.ad_group.push(group('6')); rows.ad_group_ad.push(ad('6')); rows.ad_group_criterion.push(keyword('6'));
  rows.ad_group_ad[1].adGroupAd.status = 'PAUSED';
  const result = await state();
  expect(result.state).toBe('READY');
  expect(result.adGroups.map((g: any) => g.state)).toEqual(['READY', 'BLOCKED_BY_AD']);
  expect(result.blockers).toContainEqual(expect.objectContaining({ entityId: '3', adGroupId: '6' }));
});
test('READY has zero telemetry and account-local explicit observation window', async () => {
  const result = await verify();
  expect(result.campaigns[0].state).toBe('READY');
  expect(result.timeZone).toBe('America/Los_Angeles');
  expect(result.window).toEqual({ startDate: '2026-09-16', endDate: '2026-09-16', preset: 'TODAY' });
  expect(result.checkedAt).toBe('2026-09-17T02:00:00.000Z');
  expect(result.campaigns[0].adGroups[0].telemetry).toEqual({ impressions: 0, costMicros: 0 });
  expect(api.mock.calls.find(c => c[3].query.includes('metrics.impressions'))![3].query).toContain("segments.date = '2026-09-16'");
});
test.each([['1','0'], ['0','10']])('DELIVERING requires positive observed impressions/cost %s/%s', async (impressions, costMicros) => {
  rows.telemetry = [{ adGroup: { id: '2' }, metrics: { impressions, costMicros } }];
  expect((await state()).state).toBe('DELIVERING');
  rows.ad_group_ad[0].adGroupAd.status = 'PAUSED';
  expect((await state()).state).toBe('BLOCKED_BY_AD');
});
test.each([403, 500])('API/permission error %s fails closed', async code => {
  api.mockRejectedValue({ response: { status: code } });
  expect((await verify()).state).toBe('UNVERIFIED');
});
test.each(['campaign', 'ad_group', 'ad_group_ad', 'ad_group_criterion', 'telemetry', 'customer'])('partial/malformed %s read fails closed', async table => {
  rows[table].push(null);
  expect((await verify()).state).toBe('UNVERIFIED');
});
test('pagination cap fails closed instead of certifying partial children', async () => {
  api.mockImplementation(async (_method, _path, _token, body: any) => {
    const results = rows[body.query.match(/FROM (\w+)/)[1]];
    return { results, totalResultsCount: String(results.length), ...(body.query.includes('FROM ad_group_ad ') ? { nextPageToken: 'more' } : {}) };
  });
  expect((await verify()).state).toBe('UNVERIFIED');
});
test('missing completeness count fails closed', async () => {
  const normal = api.getMockImplementation()!;
  api.mockImplementation(async (...args: any[]) => {
    const result = await normal(...args);
    if (args[3].query.includes('FROM ad_group_ad ')) delete result.totalResultsCount;
    return result;
  });
  expect((await verify()).state).toBe('UNVERIFIED');
});
test('omitted completeness count on an empty result page is accepted as zero', async () => {
  api.mockResolvedValue({ results: [] });
  const completeness = {};
  await expect(service.search('123', 'token', 'SELECT ad_group.id FROM ad_group', undefined, completeness)).resolves.toEqual([]);
  expect(completeness).toEqual({});
});
test.each(['PERFORMANCE_MAX', 'DISPLAY'])('unsupported %s is unverified', async channel => {
  rows.campaign[0].campaign.advertisingChannelType = channel;
  expect((await state()).state).toBe('UNVERIFIED');
});
test.each(['budget', 'groups', 'ads', 'policy', 'campaign'])('missing %s hierarchy fails closed', async level => {
  if (level === 'budget') delete rows.campaign[0].campaignBudget;
  if (level === 'groups') rows.ad_group = [];
  if (level === 'ads') rows.ad_group_ad = [];
  if (level === 'policy') delete rows.ad_group_ad[0].adGroupAd.policySummary;
  if (level === 'campaign') rows.campaign = [];
  expect((await state()).state).toBe('UNVERIFIED');
});
test.each(['campaign', 'adGroup'])('paused %s blocks', async level => {
  if (level === 'campaign') rows.campaign[0].campaign.status = 'PAUSED';
  else rows.ad_group[0].adGroup.status = 'PAUSED';
  expect((await state()).state).toBe(level === 'campaign' ? 'BLOCKED_BY_CAMPAIGN' : 'BLOCKED_BY_AD_GROUP');
});
test('agent contract refuses unsupported live/spending claims and requires verifier evidence', () => {
  // ENG-2823: the call_google_ads_reporting_api description moved with its handler to emma/googleAdsTools.ts.
  for (const file of ['emma/googleAdsTools.ts', 'docs/agentModeSystemPrompt.ts']) {
    const prompt = readFileSync(join(__dirname, '..', file), 'utf8');
    expect(prompt).toContain('mode="serving_chain"');
    expect(prompt).toContain('Never claim ads are live, serving, or spending from campaign or keyword status alone');
    expect(prompt).toContain('costMicros > 0');
    expect(prompt).toContain('READY is not evidence of delivery');
  }
});

test.each(['ad_group_ad', 'ad_group_criterion', 'telemetry'])('permission failure reading %s invalidates known groups', async table => {
  const normal = api.getMockImplementation()!;
  api.mockImplementation(async (...args: any[]) => {
    const query = args[3].query;
    if (table === 'telemetry' ? query.includes('metrics.impressions') : query.includes(`FROM ${table} `)) throw new Error('PERMISSION_DENIED');
    return normal(...args);
  });
  const result = await state();
  expect(result.state).toBe('UNVERIFIED');
  expect(result.adGroups[0].state).toBe('UNVERIFIED');
});
test('partial failure envelope never becomes successful evidence', async () => {
  api.mockResolvedValue({ results: rows.campaign, totalResultsCount: String(rows.campaign.length), partialFailureError: { code: 7 } });
  expect((await verify()).state).toBe('UNVERIFIED');
});
test.each(['policy', 'keyword', 'metrics', 'orphan'])('wrong-type or unknown %s evidence fails closed', async kind => {
  if (kind === 'policy') rows.ad_group_ad[0].adGroupAd.policySummary = 'APPROVED';
  if (kind === 'keyword') rows.ad_group_criterion[0].adGroupCriterion.primaryStatus = 'UNKNOWN';
  if (kind === 'metrics') rows.telemetry = [{ adGroup: { id: '2' }, metrics: { impressions: true, costMicros: '0' } }];
  if (kind === 'orphan') rows.ad_group_ad[0].adGroup.id = '999';
  expect((await state()).state).toBe('UNVERIFIED');
});
test('unknown sibling prevents campaign certification while keeping verified sibling evidence', async () => {
  rows.ad_group.push(group('6')); rows.ad_group_ad.push(ad('6')); rows.ad_group_criterion.push(keyword('6'));
  delete rows.ad_group_ad[1].adGroupAd.policySummary;
  const result = await state();
  expect(result.state).toBe('UNVERIFIED');
  expect(result.adGroups.map((g: any) => g.state)).toEqual(['READY', 'UNVERIFIED']);
});
test.each([['startDateTime', '2026-09-17 00:00:00'], ['endDateTime', '2026-09-15 23:59:59']])('enabled but outside %s does not imply readiness', async (field, value) => {
  rows.campaign[0].campaign[field] = value;
  expect((await state()).state).toBe('BLOCKED_BY_CAMPAIGN');
});
test('legacy campaign.start_date/end_date fields are rejected as unsupported (ENG-2031)', async () => {
  await verify();
  const campaignQuery = api.mock.calls.find(c => c[3].query.includes('FROM campaign'))![3].query;
  expect(campaignQuery).toContain('campaign.start_date_time');
  expect(campaignQuery).toContain('campaign.end_date_time');
  expect(campaignQuery).not.toMatch(/campaign\.(start_date|end_date)(?!_)/);
});
test('cleared end_date_time means an indefinite campaign (ENG-2031)', async () => {
  rows.campaign[0].campaign.endDateTime = '';
  expect((await state()).state).toBe('READY');
});
test.each([[undefined], [null]])('omitted end_date_time (%s) means an indefinite campaign (ENG-2031)', async (value) => {
  rows.campaign[0].campaign.endDateTime = value;
  expect((await state()).state).toBe('READY');
});
test('malformed start_date_time fails closed (ENG-2031)', async () => {
  rows.campaign[0].campaign.startDateTime = 'not-a-date';
  expect((await state()).state).toBe('UNVERIFIED');
});
test('blocked rollup follows chain priority independent of API row order', async () => {
  rows.ad_group.push(group('6')); rows.ad_group_ad.push(ad('6')); rows.ad_group_criterion.push(keyword('6'));
  rows.ad_group_ad[0].adGroupAd.status = 'PAUSED';
  rows.ad_group[1].adGroup.status = 'PAUSED';
  expect((await state()).state).toBe('BLOCKED_BY_AD_GROUP');
  rows.ad_group.reverse();
  expect((await state()).state).toBe('BLOCKED_BY_AD_GROUP');
});

test('a partial child page with an inconsistent total count fails closed', async () => {
  const normal = api.getMockImplementation()!;
  api.mockImplementation(async (...args: any[]) => ({
    ...await normal(...args),
    ...(args[3].query.includes('FROM ad_group_ad ') ? { totalResultsCount: '2' } : {}),
  }));
  expect((await state()).state).toBe('UNVERIFIED');
});
