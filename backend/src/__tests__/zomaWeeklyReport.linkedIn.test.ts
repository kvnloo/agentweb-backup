/**
 * The weekly Zoma email reports LinkedIn Ads, and never says "no ad account is connected" to a customer
 * whose only ad accounts are LinkedIn or X. Mock-only: no LinkedIn, Dynamo or mail.
 */
jest.mock('../services/connectedAccountsDb', () => ({
  createAccount: jest.fn().mockResolvedValue({}),
  getAccountsByUserId: jest.fn().mockResolvedValue([]),
  getAccountsByUserIdIncludingOrgShared: jest.fn().mockResolvedValue([]),
}));
jest.mock('../services/journeyMilestones', () => ({ zomaMilestone: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../services/db', () => ({ userDb: { getUserById: jest.fn(), getUserByIdConsistent: jest.fn(), updateUser: jest.fn() } }));
jest.mock('../services/stripeService', () => ({ stripeService: {} }));
const mockGetToken = jest.fn();
jest.mock('../services/linkedInAdsCredentials', () => ({
  ...jest.requireActual('../services/linkedInAdsCredentials'),
  getFreshLinkedInAdsToken: (...a: any[]) => mockGetToken(...a),
}));
const mockAnalytics = jest.fn();
jest.mock('../services/linkedInAdsService', () => ({
  ...jest.requireActual('../services/linkedInAdsService'),
  getAdAnalytics: (...a: any[]) => mockAnalytics(...a),
}));

import { adsWindows, defaultZomaWeeklyReportDeps, linkedInDailyRows, weeklyReportEmail } from '../mcp/zomaWeeklyReport';
import type { McpUserUsage } from '../services/mcpUsageEventsService';

const accounts = jest.requireMock('../services/connectedAccountsDb');
const WIN = adsWindows(Date.UTC(2026, 10, 23, 16, 0, 0));
const RANGE = { start: '2026-11-16T16:00:00.000Z', end: '2026-11-23T16:00:00.000Z' };
const usage: McpUserUsage = { start: RANGE.start, end: RANGE.end, toolCalls: 9, writes: { total: 0, confirmed: 0, mismatch: 0, unconfirmed: 0 }, recentWrites: [] } as any;
const NO_ACCOUNT = 'No ad account is connected to Zoma yet';

const liAccount = (id: string, extra: any = {}) => ({
  platform: 'linkedin_ads', account_id: id, account_name: `LI ${id}`, userId: 'u1',
  config: { account_type: 'ad_account', currency: 'usd', access_token: 'tok', refresh_token: 'r', token_expires_at: Date.now() + 86_400_000, ...extra },
});
const liRow = (date: string, cost: string, impressions: number, clicks: number, conv = 0, leads = 0) => {
  const [year, month, day] = date.split('-').map(Number);
  return { dateRange: { start: { year, month, day }, end: { year, month, day } }, costInLocalCurrency: cost, impressions, clicks, externalWebsiteConversions: conv, oneClickLeads: leads };
};

beforeEach(() => {
  accounts.getAccountsByUserIdIncludingOrgShared.mockReset();
  mockGetToken.mockReset().mockResolvedValue({ accessToken: 'fresh', fresh: false });
  mockAnalytics.mockReset();
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('linkedInDailyRows', () => {
  it('turns adAnalytics DAILY elements into daily rows; conversions are website conversions plus lead form leads', () => {
    expect(linkedInDailyRows([liRow('2026-11-22', '6.5', 744, 3, 1, 2), { impressions: 5 }])).toEqual([
      { date: '2026-11-22', spend: 6.5, impressions: 744, clicks: 3, conversions: 3 },
    ]);
  });
});

describe('getAdsWeeks: LinkedIn Ads', () => {
  const read = (opts = { final: false }) => defaultZomaWeeklyReportDeps.getAdsWeeks('u1', WIN, opts);

  it('reads every LinkedIn ad account over both weeks and adds same-currency accounts together', async () => {
    accounts.getAccountsByUserIdIncludingOrgShared.mockResolvedValue([liAccount('556450004'), liAccount('507505814')]);
    mockAnalytics.mockImplementation(async (_t: string, id: string) => ({
      success: true,
      data: { elements: id === '556450004' ? [liRow('2026-11-22', '6', 744, 3), liRow('2026-11-18', '2', 91, 1), liRow('2026-11-12', '2', 7, 1)] : [] },
    }));
    const weeks = await read();
    expect(weeks).toHaveLength(1);
    expect(weeks[0]).toMatchObject({ platform: 'linkedin_ads', status: 'delivered', ads: { currency: 'USD', spend: 8, impressions: 835, clicks: 4, previous: { spend: 2 } } });
    expect(mockAnalytics).toHaveBeenCalledWith('fresh', '556450004', 'ACCOUNT', 'DAILY',
      { start: { year: 2026, month: 11, day: 9 }, end: { year: 2026, month: 11, day: 22 } }, expect.arrayContaining(['costInLocalCurrency', 'dateRange']));
  });

  it('an org-shared account refreshes its token on the owner', async () => {
    accounts.getAccountsByUserIdIncludingOrgShared.mockResolvedValue([{ ...liAccount('1'), userId: 'teammate' }]);
    mockAnalytics.mockResolvedValue({ success: true, data: { elements: [] } });
    expect((await read())[0]).toEqual({ platform: 'linkedin_ads', status: 'no_delivery' });
    expect(mockGetToken).toHaveBeenCalledWith('teammate', expect.objectContaining({ account_id: '1' }));
  });

  it('a 401/403 is "could not read" (permanent); a 5xx is retried next tick until the final one', async () => {
    accounts.getAccountsByUserIdIncludingOrgShared.mockResolvedValue([liAccount('1')]);
    mockAnalytics.mockResolvedValue({ success: false, status: 403, error: 'not configured to access the related advertiser account' });
    expect((await read())[0]).toEqual({ platform: 'linkedin_ads', status: 'unreadable' });
    mockAnalytics.mockResolvedValue({ success: false, status: 503 });
    await expect(read()).rejects.toThrow(/HTTP 503/);
    expect((await read({ final: true }))[0]).toEqual({ platform: 'linkedin_ads', status: 'unreadable' });
  });

  it('a connected X Ads account is named as not reported yet, never hidden', async () => {
    accounts.getAccountsByUserIdIncludingOrgShared.mockResolvedValue([{ platform: 'x_ads', account_id: 'abc', config: { ad_account_id: 'abc' } }]);
    expect(await read()).toEqual([{ platform: 'x_ads', status: 'not_reported' }]);
  });
});

describe('the email', () => {
  const email = (platforms: any[]) => weeklyReportEmail({ usage, platforms, range: RANGE, unsubscribeUrl: 'https://api.test/u?t=abc' });

  it('shows a LinkedIn Ads section with its numbers', () => {
    const daily = ['2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20', '2026-11-21', '2026-11-22'].map((date) => ({ date, spend: 2, conversions: 0 }));
    const e = email([{ platform: 'linkedin_ads', status: 'delivered', ads: { currency: 'USD', spend: 14, impressions: 1355, clicks: 6, conversions: 0, roas: null, conversionEvent: null, daily, topCampaigns: [] } }]);
    expect(e.text).toContain('LinkedIn Ads');
    expect(e.html).toContain('LinkedIn Ads');
    expect(e.text).not.toContain(NO_ACCOUNT);
  });

  it('an unreadable LinkedIn account points to AgentWeb, not zoma_status', () => {
    const e = email([{ platform: 'linkedin_ads', status: 'unreadable' }]);
    expect(e.text).toContain('We could not read your LinkedIn Ads account this week. It may need to be reconnected in AgentWeb.');
    expect(e.text).not.toContain('zoma_status');
  });

  it('only X Ads connected: says it is connected but not reported, never "no ad account is connected"', () => {
    const e = email([{ platform: 'x_ads', status: 'not_reported' }]);
    expect(e.text).toContain('Your X Ads account is connected. Its numbers are not in this weekly email yet.');
    expect(e.text).not.toContain(NO_ACCOUNT);
    expect(e.html).not.toContain(NO_ACCOUNT);
  });

  it('nothing connected still says so', () => {
    expect(email([]).text).toContain(NO_ACCOUNT);
  });
});
