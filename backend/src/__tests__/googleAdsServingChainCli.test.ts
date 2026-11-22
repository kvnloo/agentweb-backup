jest.mock('../utils/secretsManager', () => ({ getGoogleAdsCredentials: jest.fn() }));
jest.mock('../services/connectedAccountsDb', () => ({ updateAccountTokens: jest.fn() }));
import { GoogleAdsService } from '../services/googleAdsService';
import { EXIT_ERROR, EXIT_NOT_SERVING, EXIT_OK, parseServingChainArgs, redact, runServingChainCli } from '../services/googleAdsServingChainCli';

// Same fixture shape as googleAdsServingChain.test.ts; the REAL verifier runs, only the HTTP layer is mocked.
const TOKEN = 'ya29.a0AfH6SMBsecretAccessToken_xyz';
const campaign = () => ({ campaign: { id: '1', resourceName: 'customers/123/campaigns/1', status: 'ENABLED', startDateTime: '2026-01-01 00:00:00', endDateTime: '2037-12-30 23:59:59', advertisingChannelType: 'SEARCH', campaignBudget: 'customers/123/campaignBudgets/5' }, campaignBudget: { id: '5', resourceName: 'customers/123/campaignBudgets/5', status: 'ENABLED', amountMicros: '10000000', explicitlyShared: true } });
const group = () => ({ campaign: { id: '1' }, adGroup: { id: '2', resourceName: 'customers/123/adGroups/2', status: 'ENABLED' } });
const ad = () => ({ adGroup: { id: '2' }, adGroupAd: { resourceName: 'customers/123/adGroupAds/2~3', ad: { id: '3', finalUrls: [`https://x.test/?t=${TOKEN}`] }, status: 'ENABLED', policySummary: { approvalStatus: 'APPROVED', reviewStatus: 'REVIEWED' } } });
const keyword = () => ({ adGroup: { id: '2' }, adGroupCriterion: { criterionId: '4', resourceName: 'customers/123/adGroupCriteria/2~4', status: 'ENABLED', negative: false, approvalStatus: 'APPROVED', primaryStatus: 'ELIGIBLE' } });

let service: GoogleAdsService;
let rows: Record<string, any[]>;
let lines: string[];
const argv = ['--user-id', 'user', '--customer-id', '123', '--campaign-id', '1'];
const run = () => runServingChainCli(argv, service, l => lines.push(l));
const output = () => JSON.parse(lines[0]);

beforeEach(() => {
  jest.useFakeTimers().setSystemTime(new Date('2026-09-17T02:00:00Z'));
  lines = [];
  service = new GoogleAdsService();
  jest.spyOn(service, 'getAccountCredentials').mockResolvedValue({ accessToken: TOKEN, customerId: '123', currency: 'USD', loginCustomerId: '999' });
  rows = { customer: [{ customer: { timeZone: 'America/Los_Angeles', currencyCode: 'USD' } }], campaign: [campaign()], ad_group: [group()], ad_group_ad: [ad()], ad_group_criterion: [keyword()], telemetry: [] };
  jest.spyOn(service as any, 'callApi').mockImplementation(async (_m, _p, _t, body: any) => {
    const results = rows[body.query.includes('metrics.impressions') ? 'telemetry' : body.query.match(/FROM (\w+)/)[1]];
    return { results, totalResultsCount: String(results.length) };
  });
});
afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks(); });

test('DELIVERING exits 0 with entity IDs and TODAY telemetry', async () => {
  rows.telemetry = [{ adGroup: { id: '2' }, metrics: { impressions: '12', costMicros: '3400000' } }];
  const verifier = jest.spyOn(service, 'getServingChainStatus');
  expect(await run()).toBe(EXIT_OK);
  expect(verifier).toHaveBeenCalledWith('user', '123', ['1']);
  const out = output();
  expect(out.verdict).toBe('DELIVERING');
  expect(out.window).toEqual(expect.objectContaining({ preset: 'TODAY', startDate: '2026-09-16' }));
  expect(out.campaigns[0]).toEqual(expect.objectContaining({ campaignId: '1', budgetId: '5' }));
  expect(out.campaigns[0].adGroups[0]).toEqual(expect.objectContaining({ adGroupId: '2', adIds: ['3'], keywordIds: ['4'], telemetry: { impressions: 12, costMicros: 3400000 } }));
});

test('SmartWaterHeater replay: paused creative -> BLOCKED_BY_AD exits 2', async () => {
  rows.ad_group_ad[0].adGroupAd.status = 'PAUSED';
  expect(await run()).toBe(EXIT_NOT_SERVING);
  expect(output().verdict).toBe('BLOCKED_BY_AD');
  expect(output().campaigns[0].adGroups[0].blockers).toContainEqual(expect.objectContaining({ state: 'BLOCKED_BY_AD', entityId: '3' }));
});

test('credential failure fails closed as UNVERIFIED exit 2 and never leaks the token', async () => {
  (service.getAccountCredentials as jest.Mock).mockRejectedValue(new Error(`refresh failed for Bearer ${TOKEN}`));
  expect(await run()).toBe(EXIT_NOT_SERVING);
  expect(output().verdict).toBe('UNVERIFIED');
  expect(lines.join('\n')).not.toContain(TOKEN);
});

test('output never contains tokens or raw creative readback', async () => {
  await run();
  const text = lines.join('\n');
  expect(text).not.toContain(TOKEN);
  expect(text).not.toContain('finalUrls');
  expect(text).not.toContain('loginCustomerId');
});

test('bad args exit 1 without calling the verifier', async () => {
  const verifier = jest.spyOn(service, 'getServingChainStatus');
  expect(await runServingChainCli(['--user-id', 'u'], service, l => lines.push(l))).toBe(EXIT_ERROR);
  expect(verifier).not.toHaveBeenCalled();
  expect(output().verdict).toBe('ERROR');
});

test('parse/redact helpers', () => {
  expect(parseServingChainArgs(['--user-id=u', '--customer-id=123-456-7890'])).toEqual({ userId: 'u', customerId: '1234567890' });
  expect(() => parseServingChainArgs(['--user-id', 'u', '--customer-id', '1', '--campaign-id', '--campaign-id=4'])).toThrow('missing value for --campaign-id');
  expect(() => parseServingChainArgs(['--user-id', 'u', '--customer-id', '1', '--campaign-id', '-h'])).toThrow('missing value for --campaign-id');
  expect(redact('x eyJhbGc.eyJzdWI.sig y 1//0gRefreshTok3n_abc z')).toBe('x [REDACTED] y [REDACTED] z');
});
