/**
 * ENG-3133 — the weekly Zoma ad-performance email.
 * Pure rules, the numbers (week-over-week, charts data), the email, the job with injected dependencies, the
 * production ad wiring (Meta and Google Ads, mocked reports), the opt-out on the user record, the all-users
 * usage read, the mail headers, and the unsubscribe routes.
 * Mock-only: no Stripe, Dynamo or mail; the live proof is the env1 run described in the PR.
 */
jest.mock('../services/connectedAccountsDb', () => ({
  createAccount: jest.fn().mockResolvedValue({}),
  getAccountsByUserId: jest.fn().mockResolvedValue([]),
  getAccountsByUserIdIncludingOrgShared: jest.fn().mockResolvedValue([]),
}));
jest.mock('../services/journeyMilestones', () => ({ zomaMilestone: jest.fn().mockResolvedValue(undefined) }));
const mockUpdateUser = jest.fn().mockResolvedValue({});
const mockGetUserByIdConsistent = jest.fn();
jest.mock('../services/db', () => ({
  userDb: { getUserById: jest.fn(), getUserByIdConsistent: (...a: any[]) => mockGetUserByIdConsistent(...a), updateUser: (...a: any[]) => mockUpdateUser(...a) },
}));
jest.mock('../services/stripeService', () => ({ stripeService: {} }));
jest.mock('../middleware/auth', () => ({ authenticateToken: (_q: any, _r: any, n: any) => n() }));
const mockRunReport = jest.fn();
const mockRunDaily = jest.fn();
jest.mock('../mcp/zomaAdsReport', () => ({
  ...jest.requireActual('../mcp/zomaAdsReport'),
  runZomaAdsReport: (...a: any[]) => mockRunReport(...a),
  runZomaAdsDaily: (...a: any[]) => mockRunDaily(...a),
}));

import express from 'express';
import request from 'supertest';
import { createZomaRouter } from '../routes/zoma';
import { googleAdsService } from '../services/googleAdsService';
import { resendService } from '../services/resendService';
import { emailService } from '../services/emailService';
import * as usageService from '../services/mcpUsageEventsService';
import {
  adsWindows,
  campaignCostLine,
  claimKey,
  combinePlatformWeeks,
  dayInsight,
  defaultZomaWeeklyReportDeps,
  eachDate,
  getZomaWeeklyReportConfig,
  inSendWindow,
  isPermanentReadError,
  isReportRecipient,
  isoWeekKey,
  mergeAdsWeeks,
  pctChange,
  recordWeeklyReportOptOut,
  runZomaWeeklyReports,
  signUnsubscribeToken,
  unsubscribeHeaders,
  verifyUnsubscribeToken,
  watchFlags,
  weekChips,
  weekFromDaily,
  weekInsight,
  weeklyReportEmail,
  zomaUnsubscribeUrl,
  type DailyPoint,
  type PlatformWeek,
  type ZomaAdsWeek,
  type ZomaWeeklyReportConfig,
  type ZomaWeeklyReportDeps,
} from '../mcp/zomaWeeklyReport';
import { getMcpUsageByUser, hasZomaFunnelRow, recordZomaBillingFunnel, type McpUsageEventStore, type McpUserUsage } from '../services/mcpUsageEventsService';

const SECRET = 'test-secret';
// Monday 2026-11-23 16:00 UTC, inside the default window (Monday from 15:00 UTC).
const MONDAY_16 = Date.UTC(2026, 10, 23, 16, 0, 0);
// The ad windows for that send: the last 7 COMPLETE days (Nov 16 to Nov 22) and the 7 before (Nov 9 to Nov 15).
const WIN = adsWindows(MONDAY_16);
const USAGE_RANGE = { start: '2026-11-16T16:00:00.000Z', end: '2026-11-23T16:00:00.000Z' };
const cfg = (over: Partial<ZomaWeeklyReportConfig> = {}): ZomaWeeklyReportConfig => ({ enabled: true, weekday: 1, hour: 15, maxPerPass: 200, onlyUserIds: null, ...over });

const usage = (over: Partial<McpUserUsage> = {}): McpUserUsage => ({
  start: USAGE_RANGE.start,
  end: USAGE_RANGE.end,
  toolCalls: 12,
  writes: { total: 2, confirmed: 2, mismatch: 0, unconfirmed: 0 },
  recentWrites: [
    { ts: '2026-11-18T10:00:00.000Z', platform: 'meta', entityType: 'CAMPAIGN', action: 'UPDATE', verification: 'CONFIRMED', objectId: '120000111' },
    { ts: '2026-11-20T09:00:00.000Z', platform: 'google_ads', entityType: 'AD_GROUP', action: 'CREATE', verification: 'CONFIRMED', objectId: '120000222' },
  ],
  ...over,
});
const noWrites = { total: 0, confirmed: 0, mismatch: 0, unconfirmed: 0 };
const usageFor = (...ids: string[]) => new Map(ids.map((id) => [id, usage()]));

const DATES = eachDate('2026-11-16', '2026-11-22');
const days = (spend: number[], conv: number[]): DailyPoint[] => spend.map((s, i) => ({ date: DATES[i], spend: s, conversions: conv[i] }));

const META_ADS: ZomaAdsWeek = {
  currency: 'USD', spend: 120, impressions: 14000, clicks: 310, conversions: 22, roas: 2.4, conversionEvent: 'purchase',
  daily: days([10, 20, 30, 0, 25, 15, 20], [2, 3, 4, 0, 5, 3, 5]),
  previous: { spend: 100, impressions: 12000, clicks: 250, conversions: 20 },
  topCampaigns: [{ name: 'Spring Sale', spend: 80, conversions: 15 }, { name: 'Retargeting', spend: 40, conversions: 7 }],
};
const GOOGLE_ADS: ZomaAdsWeek = {
  currency: 'INR', spend: 950, impressions: 5200, clicks: 120, conversions: 4, roas: null, conversionEvent: null,
  daily: days([100, 150, 200, 0, 250, 150, 100], [0, 1, 1, 0, 1, 0, 1]),
  previous: { spend: 950, impressions: 5000, clicks: 120, conversions: 4 },
  topCampaigns: [{ name: 'Brand search', spend: 600, conversions: 3 }],
};
const META_WEEK: PlatformWeek = { platform: 'meta', status: 'delivered', ads: META_ADS };
const GOOGLE_WEEK: PlatformWeek = { platform: 'google_ads', status: 'delivered', ads: GOOGLE_ADS };

const customer = (id: string, over: Record<string, unknown> = {}) => ({ userId: id, email: `${id}@acme.co`, ...over }) as any;

function makeDeps(over: Partial<ZomaWeeklyReportDeps> = {}): ZomaWeeklyReportDeps & { sent: any[] } {
  const sent: any[] = [];
  const deps: any = {
    config: () => cfg(),
    listUsers: jest.fn().mockResolvedValue([customer('u1')]),
    freshRecipient: jest.fn(async (id: string) => ({ email: `${id}@acme.co`, optedOut: false })),
    hasClaimed: jest.fn().mockResolvedValue(false),
    claim: jest.fn().mockResolvedValue(true),
    getUsageByUser: jest.fn().mockResolvedValue(usageFor('u1')),
    getAdsWeeks: jest.fn().mockResolvedValue([META_WEEK, GOOGLE_WEEK]),
    sendEmail: jest.fn(async (...a: any[]) => { sent.push(a); return 'sent'; }),
    backendUrl: () => 'https://api.test/',
    secret: () => SECRET,
    now: () => MONDAY_16,
    ...over,
  };
  deps.sent = sent;
  return deps;
}

describe('config', () => {
  it('is off unless ZOMA_WEEKLY_REPORT_ENABLED is exactly "true"', () => {
    expect(getZomaWeeklyReportConfig({}).enabled).toBe(false);
    expect(getZomaWeeklyReportConfig({ ZOMA_WEEKLY_REPORT_ENABLED: '1' } as any).enabled).toBe(false);
    expect(getZomaWeeklyReportConfig({ ZOMA_WEEKLY_REPORT_ENABLED: 'true' } as any).enabled).toBe(true);
  });
  it('uses Monday 15:00 UTC and 200 per pass by default, and ignores out-of-range values', () => {
    expect(getZomaWeeklyReportConfig({})).toEqual({ enabled: false, weekday: 1, hour: 15, maxPerPass: 200, onlyUserIds: null });
    expect(getZomaWeeklyReportConfig({ ZOMA_WEEKLY_REPORT_WEEKDAY: '9', ZOMA_WEEKLY_REPORT_HOUR: '24', ZOMA_WEEKLY_REPORT_MAX_PER_PASS: '0' } as any))
      .toEqual({ enabled: false, weekday: 1, hour: 15, maxPerPass: 200, onlyUserIds: null });
    expect(getZomaWeeklyReportConfig({ ZOMA_WEEKLY_REPORT_WEEKDAY: '5', ZOMA_WEEKLY_REPORT_HOUR: '13' } as any)).toMatchObject({ weekday: 5, hour: 13 });
  });
  it('the send hour is never before 12:00 UTC, so every ad-account time zone has finished the Sunday the report ends on', () => {
    expect(getZomaWeeklyReportConfig({ ZOMA_WEEKLY_REPORT_HOUR: '11' } as any).hour).toBe(15);
    expect(getZomaWeeklyReportConfig({ ZOMA_WEEKLY_REPORT_HOUR: '0' } as any).hour).toBe(15);
    expect(getZomaWeeklyReportConfig({ ZOMA_WEEKLY_REPORT_HOUR: '12' } as any).hour).toBe(12);
  });
  it('a canary list of user ids is parsed from a comma list, blanks ignored', () => {
    expect(getZomaWeeklyReportConfig({ ZOMA_WEEKLY_REPORT_ONLY_USER_IDS: ' u1, u2 ,,' } as any).onlyUserIds).toEqual(['u1', 'u2']);
    expect(getZomaWeeklyReportConfig({ ZOMA_WEEKLY_REPORT_ONLY_USER_IDS: '  ' } as any).onlyUserIds).toBeNull();
  });
});

describe('pure rules', () => {
  it('isoWeekKey follows ISO-8601 around the year boundaries', () => {
    expect(isoWeekKey(Date.UTC(2026, 10, 17))).toBe('2026-W47');
    expect(isoWeekKey(Date.UTC(2026, 11, 31))).toBe('2026-W53');
    expect(isoWeekKey(Date.UTC(2027, 0, 1))).toBe('2026-W53');
    expect(isoWeekKey(Date.UTC(2024, 11, 30))).toBe('2025-W01');
    expect(isoWeekKey(Date.UTC(2026, 10, 22, 23, 59))).toBe('2026-W47'); // Sunday still belongs to the week that began Monday
    expect(isoWeekKey(Date.UTC(2026, 10, 23, 0, 0))).toBe('2026-W48');
  });

  it('the send window is the configured weekday from the configured hour to the end of that day', () => {
    const c = { weekday: 1, hour: 15 };
    expect(inSendWindow(Date.UTC(2026, 10, 23, 14, 59), c)).toBe(false);
    expect(inSendWindow(Date.UTC(2026, 10, 23, 15, 0), c)).toBe(true);
    expect(inSendWindow(Date.UTC(2026, 10, 23, 23, 59), c)).toBe(true);
    expect(inSendWindow(Date.UTC(2026, 10, 24, 15, 0), c)).toBe(false);
    expect(inSendWindow(Date.UTC(2026, 10, 22, 15, 0), c)).toBe(false);
  });

  it('recipients: real customers only', () => {
    expect(isReportRecipient({ email: 'jo@acme.co' })).toBe(true);
    expect(isReportRecipient({ email: '' })).toBe(false);
    expect(isReportRecipient({ email: 'jo@agentweb.pro' })).toBe(false); // internal domain
    expect(isReportRecipient({ email: 'jo@acme.co', isAdmin: true })).toBe(false);
    expect(isReportRecipient({ email: 'qa-user@acme.co' })).toBe(false); // test/fixture local part
    expect(isReportRecipient({ email: 'x@example.com' })).toBe(false); // test domain
  });

  it('ad windows are COMPLETE days: the 7 ending yesterday, then the 7 before, never today', () => {
    expect(WIN).toEqual({ since: '2026-11-16', until: '2026-11-22', prevSince: '2026-11-09', prevUntil: '2026-11-15' });
    // Sending later the same day, or at 00:00, gives the same windows: the day of the send is never counted.
    expect(adsWindows(Date.UTC(2026, 10, 23, 23, 59))).toEqual(WIN);
    expect(adsWindows(Date.UTC(2026, 10, 23, 0, 0))).toEqual(WIN);
    // Consecutive weekly sends never share a day.
    const next = adsWindows(Date.UTC(2026, 10, 30, 16, 0));
    expect(next.since > WIN.until).toBe(true);
    expect(next.prevUntil).toBe(WIN.until);
  });

  it('eachDate lists every date inclusive, across month ends', () => {
    expect(eachDate('2026-11-29', '2026-12-02')).toEqual(['2026-11-29', '2026-11-30', '2026-12-01', '2026-12-02']);
    expect(eachDate('2026-11-16', '2026-11-22')).toHaveLength(7);
  });

  it('pctChange is whole percent, and undefined without a usable baseline', () => {
    expect(pctChange(120, 100)).toBe(20);
    expect(pctChange(80, 100)).toBe(-20);
    expect(pctChange(5, 0)).toBeUndefined();
    expect(pctChange(5, undefined)).toBeUndefined();
  });
});

const tamper = (t: string) => `${t.slice(0, 20)}${t[20] === 'A' ? 'B' : 'A'}${t.slice(21)}`;

describe('unsubscribe token', () => {
  it('round-trips, and rejects tampering, another secret and junk', () => {
    const t = signUnsubscribeToken('user-1', SECRET);
    expect(verifyUnsubscribeToken(t, SECRET)).toBe('user-1');
    expect(verifyUnsubscribeToken(t, 'other-secret')).toBeNull();
    expect(verifyUnsubscribeToken(tamper(t), SECRET)).toBeNull();
    expect(verifyUnsubscribeToken(t.slice(0, -4), SECRET)).toBeNull();
    for (const junk of [undefined, null, 42, '', 'abc', 'a.b.c', 'x'.repeat(500), '!!!!', `${t}=`, 'A'.repeat(40)]) {
      expect(verifyUnsubscribeToken(junk as any, SECRET)).toBeNull();
    }
  });
  it('is opaque: the internal user id is not in the link, in any common encoding', () => {
    const id = '94470467-309f-49a9-930c-0725ce7b3d0a';
    const t = signUnsubscribeToken(id, SECRET);
    expect(t).not.toContain(id);
    expect(t).not.toContain(Buffer.from(id).toString('base64url'));
    expect(Buffer.from(t, 'base64url').toString('utf8')).not.toContain(id);
    expect(Buffer.from(t, 'base64url').toString('latin1')).not.toContain('94470467');
    expect(verifyUnsubscribeToken(t, SECRET)).toBe(id);
  });
  it('is random per send but every one of them opts the same user out', () => {
    const a = signUnsubscribeToken('user-1', SECRET);
    const b = signUnsubscribeToken('user-1', SECRET);
    expect(a).not.toBe(b);
    expect(verifyUnsubscribeToken(a, SECRET)).toBe('user-1');
    expect(verifyUnsubscribeToken(b, SECRET)).toBe('user-1');
  });
  it('the URL carries a token that verifies back to the user', () => {
    const url = zomaUnsubscribeUrl('user-9', { backendUrl: () => 'https://api.test/', secret: () => SECRET });
    expect(url.startsWith('https://api.test/api/zoma/weekly-report/unsubscribe?t=')).toBe(true);
    expect(verifyUnsubscribeToken(decodeURIComponent(url.split('?t=')[1]), SECRET)).toBe('user-9');
    expect(url).not.toContain('user-9');
  });
  it('the one-click headers carry the same signed link', () => {
    expect(unsubscribeHeaders('https://api.test/u?t=abc')).toEqual({
      'List-Unsubscribe': '<https://api.test/u?t=abc>',
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    });
  });
});

describe('the numbers: week-over-week, chips, one insight sentence', () => {
  it('chips show each number with its change against last week and who it is good for', () => {
    const chips = Object.fromEntries(weekChips(META_ADS).map((c) => [c.label, c]));
    expect(chips['Spend']).toMatchObject({ value: '120.00 USD', deltaText: 'up 20% vs last week', arrow: '▲', tone: 'neutral' }); // spending more is neither good nor bad
    expect(chips['Conversions']).toMatchObject({ value: '22 (purchase)', deltaText: 'up 10% vs last week', tone: 'good' });
    expect(chips['Cost per conversion']).toMatchObject({ value: '5.45 USD', deltaText: 'up 9% vs last week', arrow: '▲', tone: 'bad' }); // dearer conversions are bad
    expect(chips['Clicks']).toMatchObject({ value: '310', deltaText: 'up 24% vs last week', tone: 'good' });
    expect(chips['Click rate']).toMatchObject({ value: '2.21%', deltaText: 'up 6% vs last week', tone: 'good' });
    expect(chips['Cost per click']).toMatchObject({ value: '0.39 USD', deltaText: 'down 3% vs last week', arrow: '▼', tone: 'good' }); // cheaper clicks are good
    expect(chips['Return on ad spend']).toMatchObject({ value: '2.4x', tone: 'neutral' });
    expect(weekChips(META_ADS).map((c) => c.label)).toEqual(['Spend', 'Conversions', 'Cost per conversion', 'Clicks', 'Click rate', 'Cost per click', 'Return on ad spend']);
  });

  it('a change under 2% is "about the same", and no baseline means no change text at all', () => {
    const same = weekChips(GOOGLE_ADS);
    expect(same.find((c) => c.label === 'Spend')).toMatchObject({ deltaText: 'about the same as last week', tone: 'neutral' });
    expect(same.find((c) => c.label === 'Click rate')).toMatchObject({ value: '2.31%', deltaText: 'down 4% vs last week', tone: 'bad' }); // a falling click rate is bad
    expect(same.find((c) => c.label === 'Cost per click')).toMatchObject({ value: '7.92 INR', deltaText: 'about the same as last week' });
    expect(same.map((c) => c.label)).not.toContain('Return on ad spend'); // roas null: no chip
    const noBaseline = weekChips({ ...META_ADS, previous: undefined });
    expect(noBaseline.every((c) => c.deltaText === undefined)).toBe(true);
    const zeroBaseline = weekChips({ ...META_ADS, previous: { spend: 0, impressions: 0, clicks: 0, conversions: 0 } });
    expect(zeroBaseline.every((c) => c.deltaText === undefined)).toBe(true);
  });

  it('no conversions means "none yet" for cost per conversion, never a division by zero', () => {
    const c = weekChips({ ...META_ADS, conversions: 0, roas: null }).find((x) => x.label === 'Cost per conversion')!;
    expect(c).toMatchObject({ value: 'none yet', tone: 'neutral' });
    expect(c.deltaText).toBeUndefined();
  });

  it('fractional conversions and an unknown currency read naturally', () => {
    const c = weekChips({ ...META_ADS, currency: undefined, conversions: 0.4, spend: 5, roas: null, previous: undefined });
    expect(c.find((x) => x.label === 'Spend')!.value).toBe('5.00');
    expect(c.find((x) => x.label === 'Conversions')!.value).toBe('0.4 (purchase)');
    // Spend over less than one whole conversion is noise, not a price.
    expect(c.find((x) => x.label === 'Cost per conversion')).toMatchObject({ value: 'none yet', tone: 'neutral' });
    expect(weekChips({ ...META_ADS, conversions: 0.04 }).find((x) => x.label === 'Conversions')!.value).toBe('<0.1 (purchase)');
  });

  it('no clicks or impressions means "none yet" for the click numbers, never a division by zero', () => {
    const c = weekChips({ ...META_ADS, impressions: 0, clicks: 0, previous: undefined });
    expect(c.find((x) => x.label === 'Click rate')).toMatchObject({ value: 'none yet', tone: 'neutral' });
    expect(c.find((x) => x.label === 'Cost per click')).toMatchObject({ value: 'none yet', tone: 'neutral' });
  });

  it('Meta action types are shown as plain words', () => {
    const v = (e: string) => weekChips({ ...META_ADS, conversionEvent: e }).find((c) => c.label === 'Conversions')!.value;
    expect(v('onsite_conversion.lead_grouped')).toBe('22 (lead grouped)');
    expect(v('offsite_conversion.fb_pixel_purchase')).toBe('22 (purchase)');
  });

  it('the insight is one factual sentence, and only when last week gives a baseline', () => {
    expect(weekInsight(META_ADS)).toBe('Spend is up 20% and conversions are up 10% compared with last week, so each conversion cost 9% more.');
    expect(weekInsight(GOOGLE_ADS)).toBe('Spend is about the same and conversions are about the same compared with last week.');
    expect(weekInsight({ ...META_ADS, previous: undefined })).toBeUndefined();
    expect(weekInsight({ ...META_ADS, previous: { spend: 0, impressions: 0, clicks: 0, conversions: 0 } })).toBeUndefined();
    expect(weekInsight({ ...META_ADS, spend: 0 })).toBeUndefined();
  });

  it('conversions and cost per conversion are only discussed when both weeks have conversions', () => {
    expect(weekInsight({ ...META_ADS, previous: { ...META_ADS.previous!, conversions: 0 } })).toBe('Spend is up 20% compared with last week.');
    expect(weekInsight({ ...META_ADS, conversions: 0 })).toBe('Spend is up 20% compared with last week.');
  });

  it('a small cost-per-conversion move is not mentioned, a big drop is', () => {
    const cheaper = weekInsight({ ...META_ADS, spend: 100, previous: { spend: 100, impressions: 1, clicks: 1, conversions: 11 } });
    expect(cheaper).toBe('Spend is about the same and conversions are up 100% compared with last week, so each conversion cost 50% less.');
    const flat = weekInsight({ ...META_ADS, spend: 104, conversions: 21, previous: { spend: 100, impressions: 1, clicks: 1, conversions: 20 } });
    expect(flat).toBe('Spend is up 4% and conversions are up 5% compared with last week.');
  });
});

describe('weekFromDaily', () => {
  const row = (date: string, spend: number, conversions = 0, value = 0) => ({ date, spend, impressions: spend * 10, clicks: spend / 2, conversions, conversion_value: value });
  const extra = { currency: 'USD', conversionEvent: 'purchase', topCampaigns: [] };

  it('sums this week and last, fills days with no delivery with zeros, and keeps seven days oldest first', () => {
    const week = weekFromDaily(
      [row('2026-11-16', 10, 1, 30), row('2026-11-18', 20, 2, 60), row('2026-11-10', 14, 1), row('2026-11-15', 6)],
      WIN, extra,
    )!;
    expect(week).toMatchObject({ currency: 'USD', spend: 30, impressions: 300, clicks: 15, conversions: 3, roas: 3, conversionEvent: 'purchase' });
    expect(week.previous).toEqual({ spend: 20, impressions: 200, clicks: 10, conversions: 1 });
    expect(week.daily.map((d) => d.date)).toEqual(eachDate('2026-11-16', '2026-11-22'));
    expect(week.daily.map((d) => d.spend)).toEqual([10, 0, 20, 0, 0, 0, 0]);
    expect(week.daily.map((d) => d.conversions)).toEqual([1, 0, 2, 0, 0, 0, 0]);
  });

  it('ignores rows outside both windows (a partial today, or anything older)', () => {
    const week = weekFromDaily([row('2026-11-16', 10), row('2026-11-23', 999), row('2026-11-08', 999)], WIN, extra)!;
    expect(week.spend).toBe(10);
    expect(week.previous!.spend).toBe(0);
  });

  it('two rows for one date are added, not overwritten', () => {
    const week = weekFromDaily([row('2026-11-16', 10), row('2026-11-16', 5)], WIN, extra)!;
    expect(week.daily[0].spend).toBe(15);
  });

  it('no delivery this week is null even when last week delivered; impressions alone count as delivery', () => {
    expect(weekFromDaily([row('2026-11-10', 50)], WIN, extra)).toBeNull();
    expect(weekFromDaily([], WIN, extra)).toBeNull();
    expect(weekFromDaily([{ date: '2026-11-17', spend: 0, impressions: 50, clicks: 0, conversions: 0 }], WIN, extra)).not.toBeNull();
  });

  it('ROAS only when the platform reports a conversion value', () => {
    expect(weekFromDaily([row('2026-11-16', 10)], WIN, extra)!.roas).toBeNull();
    expect(weekFromDaily([row('2026-11-16', 10, 1, 25)], WIN, extra)!.roas).toBe(2.5);
  });
});

describe('insights: best day, worth-a-look flags, cost per conversion by campaign', () => {
  const week = (over: Partial<ZomaAdsWeek>): ZomaAdsWeek => ({ ...META_ADS, ...over });

  it('best day: most conversions, the cheaper one on a tie, and the days with no spend are named', () => {
    expect(dayInsight(META_ADS)).toBe('Best day: Sun, 5 conversions at 4.00 USD each. No spend on Thu.');
    expect(dayInsight(week({ daily: days([10, 20, 30, 0, 25, 15, 0], [1, 2, 3, 0, 0, 0, 0]) }))).toBe('Best day: Wed, 3 conversions at 10.00 USD each. No spend on Thu and Sun.');
    expect(dayInsight(week({ daily: days([10, 20, 30, 0, 25, 0, 0], [1, 2, 3, 0, 0, 0, 0]) }))).toBe('Best day: Wed, 3 conversions at 10.00 USD each. No spend on Thu, Sat and Sun.');
    expect(dayInsight(week({ daily: days([10, 0, 30, 0, 25, 0, 0], [1, 0, 2, 0, 0, 0, 0]) }))).toBe('Best day: Wed, 2 conversions at 15.00 USD each. No spend on 4 days.');
  });

  it('without conversions it names the highest-spend and quietest days; equal days and an empty week say nothing', () => {
    const none = [0, 0, 0, 0, 0, 0, 0];
    expect(dayInsight(week({ daily: days([10, 20, 30, 40, 25, 15, 20], none) }))).toBe('Highest spend: Thu (40.00 USD). Quietest day: Mon (10.00 USD).');
    expect(dayInsight(week({ daily: days([10, 10, 10, 10, 10, 10, 10], none) }))).toBeUndefined();
    expect(dayInsight(week({ daily: days([0, 0, 0, 0, 0, 0, 0], none) }))).toBeUndefined();
  });

  it('best day on the quietest day is not also called the quietest', () => {
    expect(dayInsight(week({ daily: days([10, 20, 30, 40, 25, 15, 20], [3, 0, 0, 0, 0, 0, 0]) }))).toBe('Best day: Mon, 3 conversions at 3.33 USD each.');
  });

  it('flags: nothing to flag on a healthy week', () => {
    expect(watchFlags(META_ADS)).toEqual([]);
    expect(watchFlags(GOOGLE_ADS)).toEqual([]);
  });

  it('flags: spend with no conversions all week points at conversion tracking, and does not also name every campaign', () => {
    const flags = watchFlags(week({ conversions: 0, topCampaigns: [{ name: 'A', spend: 50, conversions: 0 }] }));
    expect(flags).toEqual(['No conversions were recorded this week. If you expect some, check that conversion tracking is set up.']);
  });

  it('flags: spend that stopped for two or more days at the end of the week, but not a single quiet day', () => {
    expect(watchFlags(week({ daily: days([10, 20, 30, 40, 25, 0, 0], [1, 1, 1, 1, 1, 0, 0]) })))
      .toEqual(['Spend stopped after Fri. If that is not planned, check your budgets and campaign status.']);
    expect(watchFlags(week({ daily: days([10, 20, 30, 40, 25, 15, 0], [1, 1, 1, 1, 1, 1, 0]) }))).toEqual([]);
  });

  it('flags: a top campaign that spent with no conversions (only when the account had some), cleaned, at most three flags', () => {
    const topCampaigns = [{ name: 'Win', spend: 80, conversions: 15 }, { name: 'Evil\nname', spend: 40, conversions: 0 }, { name: 'C', spend: 20, conversions: 0 }, { name: 'D', spend: 10, conversions: 0 }];
    expect(watchFlags(week({ topCampaigns }))).toEqual(['Evil name spent 40.00 USD with no conversions.', 'C spent 20.00 USD with no conversions.', 'D spent 10.00 USD with no conversions.']);
    const stopped = watchFlags(week({ topCampaigns, daily: days([10, 20, 30, 40, 25, 0, 0], [1, 1, 1, 1, 1, 0, 0]) }));
    expect(stopped).toHaveLength(3);
    expect(stopped[0]).toMatch(/^Spend stopped after Fri/);
  });

  it('cost per conversion by campaign: cheapest and dearest, only with two priced campaigns that differ', () => {
    expect(campaignCostLine(META_ADS)).toBe('Cheapest per conversion: Spring Sale (5.33 USD). Dearest: Retargeting (5.71 USD).');
    expect(campaignCostLine(GOOGLE_ADS)).toBeUndefined(); // one campaign
    expect(campaignCostLine(week({ topCampaigns: [{ name: 'A', spend: 10, conversions: 1 }, { name: 'B', spend: 20, conversions: 2 }] }))).toBeUndefined(); // same price
    expect(campaignCostLine(week({ topCampaigns: [{ name: 'A', spend: 10, conversions: 0.4 }, { name: 'B', spend: 20, conversions: 2 }] }))).toBeUndefined(); // under one conversion is not priced
  });

  it('the email shows the flags in a "Worth a look" block, escaped, in both parts', () => {
    const ads = week({ topCampaigns: [{ name: 'Win', spend: 80, conversions: 15 }, { name: '<b>Bad</b>', spend: 40, conversions: 0 }], daily: days([10, 20, 30, 40, 25, 0, 0], [1, 1, 1, 1, 1, 0, 0]) });
    const e = weeklyReportEmail({ usage: usage(), platforms: [{ platform: 'meta', status: 'delivered', ads }], range: USAGE_RANGE, unsubscribeUrl: 'https://api.test/u?t=abc' });
    expect(e.text).toContain('Worth a look:\n- Spend stopped after Fri. If that is not planned, check your budgets and campaign status.\n- <b>Bad</b> spent 40.00 USD with no conversions.');
    expect(e.html).toContain('Worth a look');
    expect(e.html).toContain('&lt;b&gt;Bad&lt;/b&gt; spent 40.00 USD with no conversions.');
    expect(e.html).not.toContain('<b>Bad</b>');
    const healthy = weeklyReportEmail({ usage: usage(), platforms: [META_WEEK], range: USAGE_RANGE, unsubscribeUrl: 'https://api.test/u?t=abc' });
    expect(healthy.text + healthy.html).not.toContain('Worth a look');
  });
});

describe('several ad accounts of one platform', () => {
  const B: ZomaAdsWeek = {
    ...META_ADS, spend: 60, impressions: 4000, clicks: 100, conversions: 6, roas: 3,
    daily: days([5, 5, 5, 5, 15, 15, 10], [1, 1, 1, 1, 1, 0, 1]),
    previous: { spend: 50, impressions: 3000, clicks: 80, conversions: 4 },
    topCampaigns: [{ name: 'B camp', spend: 90, conversions: 2 }],
  };

  it('same-currency accounts are added together: totals, days, previous week, ranking; return on ad spend is dropped', () => {
    const m = mergeAdsWeeks(META_ADS, B);
    expect(m).toMatchObject({ currency: 'USD', spend: 180, impressions: 18000, clicks: 410, conversions: 28, roas: null, conversionEvent: 'purchase' });
    expect(m.previous).toEqual({ spend: 150, impressions: 15000, clicks: 330, conversions: 24 });
    expect(m.daily.map((d) => d.spend)).toEqual([15, 25, 35, 5, 40, 30, 30]);
    expect(m.daily.map((d) => d.date)).toEqual(DATES);
    expect(m.topCampaigns.map((c) => c.name)).toEqual(['B camp', 'Spring Sale', 'Retargeting']);
  });

  it('different conversion events are not claimed as one; a missing previous week hides the comparison', () => {
    expect(mergeAdsWeeks(META_ADS, { ...B, conversionEvent: 'lead' }).conversionEvent).toBeNull();
    expect(mergeAdsWeeks(META_ADS, { ...B, previous: undefined }).previous).toBeUndefined();
  });

  it('"no delivery" only when every account was read and none delivered', () => {
    const none: PlatformWeek = { platform: 'meta', status: 'no_delivery' };
    const bad: PlatformWeek = { platform: 'meta', status: 'unreadable' };
    expect(combinePlatformWeeks('meta', [none, none])).toEqual({ platform: 'meta', status: 'no_delivery' });
    expect(combinePlatformWeeks('meta', [none, bad])).toEqual({ platform: 'meta', status: 'unreadable' });
    expect(combinePlatformWeeks('meta', [none], 1)).toEqual({ platform: 'meta', status: 'unreadable' }); // another account was not read at all
  });

  it('an account that delivered wins over an idle one, and an unreadable one is counted as not included', () => {
    const idle: PlatformWeek = { platform: 'meta', status: 'no_delivery' };
    const delivered = combinePlatformWeeks('meta', [idle, META_WEEK]);
    expect(delivered).toMatchObject({ status: 'delivered', ads: { spend: 120 } });
    expect((delivered as any).ads.notIncluded).toBeUndefined();
    const partly = combinePlatformWeeks('meta', [META_WEEK, { platform: 'meta', status: 'unreadable' }], 1);
    expect((partly as any).ads.notIncluded).toBe(2);
  });

  it('different currencies are never added: the currency with most accounts is shown and the rest are counted', () => {
    const inr: PlatformWeek = { platform: 'meta', status: 'delivered', ads: { ...GOOGLE_ADS } };
    const usdB: PlatformWeek = { platform: 'meta', status: 'delivered', ads: B };
    const tie = combinePlatformWeeks('meta', [META_WEEK, inr]) as any;
    expect(tie.ads).toMatchObject({ currency: 'USD', spend: 120, notIncluded: 1 }); // a tie goes to the first listed
    expect((combinePlatformWeeks('meta', [inr, META_WEEK]) as any).ads).toMatchObject({ currency: 'INR', spend: 950, notIncluded: 1 });
    const two = combinePlatformWeeks('meta', [inr, META_WEEK, usdB]) as any;
    expect(two.ads).toMatchObject({ currency: 'USD', spend: 180, notIncluded: 1 }); // two USD accounts beat one INR account
  });

  it('the email says what is not included, in both parts', () => {
    const noted = combinePlatformWeeks('google_ads', [GOOGLE_WEEK, { platform: 'google_ads', status: 'unreadable' }]);
    const e = weeklyReportEmail({ usage: usage(), platforms: [noted], range: USAGE_RANGE, unsubscribeUrl: 'https://api.test/u?t=abc' });
    expect(e.text).toContain('Not included here: 1 other Google Ads account (in a different currency, or could not be read).');
    expect(e.html).toContain('Not included here: 1 other Google Ads account');
  });
});

describe('the email', () => {
  const email = (over: Partial<Parameters<typeof weeklyReportEmail>[0]> = {}) =>
    weeklyReportEmail({ usage: usage(), platforms: [META_WEEK, GOOGLE_WEEK], range: USAGE_RANGE, unsubscribeUrl: 'https://api.test/u?t=abc', ...over });
  const quiet = usage({ writes: noWrites, recentWrites: [] });

  it('shows each platform with its numbers and changes, daily spend, top campaigns, the changes, the call count and the unsubscribe link', () => {
    const e = email();
    expect(e.subject).toBe('Your Zoma week in ads');
    expect(e.text).toContain('Your Zoma week in ads, Nov 16 to Nov 22.');
    expect(e.text).toContain('Meta ads\nSpend is up 20% and conversions are up 10% compared with last week, so each conversion cost 9% more.');
    expect(e.text).toContain('Spend: 120.00 USD (up 20% vs last week)');
    expect(e.text).toContain('Conversions: 22 (purchase) (up 10% vs last week)');
    expect(e.text).toContain('Cost per conversion: 5.45 USD (up 9% vs last week)');
    expect(e.text).toContain('Click rate: 2.21% (up 6% vs last week)');
    expect(e.text).toContain('Cost per click: 0.39 USD (down 3% vs last week)');
    expect(e.text).toContain('Return on ad spend: 2.4x');
    expect(e.text).toContain('Spend per day (USD): Mon 10.00, Tue 20.00, Wed 30.00, Thu 0.00, Fri 25.00, Sat 15.00, Sun 20.00');
    expect(e.text).toContain('1. Spring Sale: 80.00 USD, 15 conversions (5.33 USD each)');
    expect(e.text).toContain('2. Retargeting: 40.00 USD, 7 conversions (5.71 USD each)');
    expect(e.text).toContain('Cheapest per conversion: Spring Sale (5.33 USD). Dearest: Retargeting (5.71 USD).');
    expect(e.text).toContain('Best day: Sun, 5 conversions at 4.00 USD each. No spend on Thu.');
    expect(e.text).toContain('Best day: Sun, 1 conversion at 100.00 INR each. No spend on Thu.');
    expect(e.text).toContain('Ad platforms often add conversions for a few days after a click, so the newest numbers can still go up.');
    expect(e.text).toContain('Google Ads\nSpend is about the same and conversions are about the same compared with last week.');
    expect(e.text).toContain('Spend per day (INR): Mon 100.00');
    expect(e.text).toContain('Changes made through Zoma: 2 (each one confirmed by reading it back).');
    expect(e.text).toContain('- Nov 20: create ad group (Google Ads), confirmed');
    expect(e.text).toContain('- Nov 18: update campaign (Meta), confirmed');
    expect(e.text).toContain('Your agent made 12 successful Zoma calls in the past 7 days.');
    expect(e.text).toContain('Stop this weekly email: https://api.test/u?t=abc');
  });

  it('the HTML draws the charts with table cells (no images, no scripts), one colour per platform', () => {
    const e = email();
    expect(e.html).not.toMatch(/<img|<script|<svg|<canvas/i);
    // Bars must survive desktop Outlook (the Word renderer ignores font-size:0): 1px type and an exact line height.
    expect(e.html).not.toContain('font-size:0');
    expect(e.html).toContain('font-size:1px;line-height:1px;mso-line-height-rule:exactly');
    expect(e.html).toContain('background:#ffffff');
    expect(e.html).toContain('border-left:4px solid #1877f2');
    expect(e.html).toContain('border-left:4px solid #34a853');
    expect(e.html).toContain('bgcolor="#1877f2"');
    expect(e.html).toContain('bgcolor="#34a853"');
    expect(e.html).toContain('Spend per day (USD)');
    expect(e.html).toContain('Spend per day (INR)');
    expect(e.html).toContain('Top campaigns by spend');
    expect(e.html).toContain('Cheapest per conversion: Spring Sale');
    expect(e.html).toContain('5.33 USD each');
    expect(e.html).toContain('Best day: Sun');
    expect(e.html).toContain('Ad platforms often add conversions');
    for (const d of ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']) expect(e.html).toContain(d);
    expect(e.html).toContain('href="https://api.test/u?t=abc"');
    expect(e.html).toContain('support@agentweb.pro');
  });

  it('a day with no spend is drawn as a flat line, not a bar, and the tallest day gets the full height', () => {
    const html = email({ platforms: [META_WEEK] }).html;
    expect(html.match(/height="110" bgcolor="#1877f2"/g)).toHaveLength(1); // Wed, the 30.00 day
    expect(html).toContain('height="1" bgcolor="#dadce0"'); // Thu, no spend
  });

  it('never adds the platforms together: currencies differ and a combined number would be wrong', () => {
    const e = email();
    expect(e.text + e.html).not.toMatch(/\bTotal\b/i);
    expect(e.text + e.html).not.toMatch(/1,?070\b/); // 120 + 950
  });

  it('only the platforms that are connected appear, each described truthfully', () => {
    const metaOnly = email({ platforms: [META_WEEK], usage: quiet });
    expect(metaOnly.text).toContain('Meta ads');
    expect(metaOnly.text).not.toContain('Google Ads');
    const mixed = email({ platforms: [{ platform: 'meta', status: 'no_delivery' }, { platform: 'google_ads', status: 'unreadable' }], usage: quiet });
    expect(mixed.text).toContain('No ad delivery was recorded on your Meta ads account this week.');
    expect(mixed.text).toContain('We could not read your Google Ads account this week. It may need to be reconnected: ask your agent to run zoma_status.');
    expect(mixed.html).toContain('No ad delivery was recorded on your Meta ads account this week.');
    expect(mixed.html).toContain('We could not read your Google Ads account this week.');
    expect(mixed.html).not.toContain('Spend per day');
  });

  it('with no connected ad account it says so, and how to connect one', () => {
    const e = email({ platforms: [] });
    expect(e.text).toContain('No ad account is connected to Zoma yet. Ask your agent to run zoma_status for the connect link.');
    expect(e.html).toContain('No ad account is connected to Zoma yet.');
    expect(e.text).not.toContain('Spend per day');
  });

  it('a platform without a previous week still reads fine: no change text, no insight', () => {
    const e = email({ platforms: [{ platform: 'meta', status: 'delivered', ads: { ...META_ADS, previous: undefined } }], usage: quiet });
    expect(e.text).toContain('Spend: 120.00 USD\n');
    expect(e.text).not.toContain('vs last week');
    expect(e.text).not.toContain('compared with last week');
  });

  it('never includes object ids or account ids, and escapes every user-typed value in the HTML', () => {
    const hostile: ZomaAdsWeek = { ...META_ADS, conversionEvent: 'x<b>', topCampaigns: [{ name: '<script>alert(1)</script>', spend: 80, conversions: 1 }] };
    const e = email({ platforms: [{ platform: 'meta', status: 'delivered', ads: hostile }], unsubscribeUrl: 'https://api.test/u?t="x"&y=1' });
    expect(e.text + e.html).not.toMatch(/120000111|120000222|act_/);
    expect(e.html).not.toContain('<script>');
    expect(e.html).not.toContain('x<b>'); // the page uses its own <b> for the insight; the typed one must arrive escaped
    expect(e.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(e.html).toContain('x&lt;b&gt;');
    expect(e.html).toContain('t=&quot;x&quot;&amp;y=1');
  });

  it('numbers read consistently: "1 conversion", and the same thousands separators in the daily line as everywhere else', () => {
    const ads: ZomaAdsWeek = { ...GOOGLE_ADS, daily: days([1559, 0, 12345.5, 10, 0, 0, 0], [0, 0, 0, 0, 0, 0, 0]), topCampaigns: [{ name: 'One', spend: 6200, conversions: 1 }, { name: 'Many', spend: 100, conversions: 2 }, { name: 'Part', spend: 50, conversions: 0.4 }] };
    const e = email({ platforms: [{ platform: 'google_ads', status: 'delivered', ads }], usage: quiet });
    expect(e.text).toContain('Spend per day (INR): Mon 1,559.00, Tue 0.00, Wed 12,345.50, Thu 10.00');
    expect(e.text).toContain('1. One: 6,200.00 INR, 1 conversion (6,200.00 INR each)\n');
    expect(e.text).toContain('2. Many: 100.00 INR, 2 conversions (50.00 INR each)\n');
    expect(e.text).toContain('3. Part: 50.00 INR, 0.4 conversions\n'); // under one whole conversion: no price per conversion
  });

  it('campaign names are one short printable line; an empty one is "Untitled campaign"', () => {
    const ads: ZomaAdsWeek = { ...META_ADS, topCampaigns: [{ name: 'Line1\nLine2\t\u0007', spend: 3, conversions: 0 }, { name: 'A'.repeat(60), spend: 2, conversions: 0 }, { name: '', spend: 1, conversions: 0 }] };
    const e = email({ platforms: [{ platform: 'meta', status: 'delivered', ads }], usage: quiet });
    expect(e.text).toContain('1. Line1 Line2: 3.00 USD');
    expect(e.text).toContain(`2. ${'A'.repeat(39)}…: 2.00 USD`);
    expect(e.text).toContain('3. Untitled campaign: 1.00 USD');
    // Whole characters only: never half of an emoji.
    const emoji = email({ platforms: [{ platform: 'meta', status: 'delivered', ads: { ...META_ADS, topCampaigns: [{ name: '😀'.repeat(60), spend: 1, conversions: 0 }] } }], usage: quiet });
    expect(emoji.text).toContain(`1. ${'😀'.repeat(39)}…: 1.00 USD`);
    expect(emoji.text + emoji.html).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  });

  it('says exactly what happened with changes: none, all confirmed, some not confirmed, none confirmed', () => {
    expect(email({ usage: quiet }).text).toContain('No changes were recorded through Zoma this week.');
    expect(email({ usage: quiet }).text).not.toContain('Latest changes');

    const mixed = email({
      usage: usage({ toolCalls: 1, writes: { total: 3, confirmed: 1, mismatch: 1, unconfirmed: 1 }, recentWrites: [
        { ts: '2026-11-19T10:00:00.000Z', entityType: 'AD', action: 'UPDATE', verification: 'MISMATCH' },
        { ts: '2026-11-20T10:00:00.000Z', entityType: 'AD', action: 'PAUSE', verification: 'CONFIRMED' },
      ] }),
    });
    expect(mixed.text).toContain('Changes sent through Zoma: 3. 1 confirmed by reading them back, 2 could not be confirmed.');
    expect(mixed.text).toContain('Latest changes:');
    expect(mixed.text).toContain('- Nov 20: pause ad, confirmed');
    expect(mixed.text).toContain('- Nov 19: update ad, not confirmed');
    expect(mixed.text).toContain('Your agent made 1 successful Zoma call in the past 7 days.');

    // Writes were dispatched but none could be confirmed: never claim "no changes".
    const none = email({ usage: usage({ writes: { total: 3, confirmed: 0, mismatch: 1, unconfirmed: 2 }, recentWrites: [] }) });
    expect(none.text).toContain('Changes sent through Zoma: 3. 0 confirmed by reading them back, 3 could not be confirmed.');
    expect(none.text).not.toContain('No changes were recorded');
  });
});

describe('runZomaWeeklyReports', () => {
  it('does nothing while disabled, and outside the send window', async () => {
    const off = makeDeps({ config: () => cfg({ enabled: false }) });
    expect(await runZomaWeeklyReports(off)).toEqual({ checked: 0, sent: 0, failed: 0 });
    expect(off.listUsers).not.toHaveBeenCalled();
    const early = makeDeps({ now: () => Date.UTC(2026, 10, 23, 14, 0) });
    expect(await runZomaWeeklyReports(early)).toEqual({ checked: 0, sent: 0, failed: 0 });
    expect(early.listUsers).not.toHaveBeenCalled();
    expect(early.getUsageByUser).not.toHaveBeenCalled();
    const tuesday = makeDeps({ now: () => Date.UTC(2026, 10, 24, 16, 0) });
    expect((await runZomaWeeklyReports(tuesday)).sent).toBe(0);
  });

  it('sends one email to an eligible user, claiming the ISO week first, with the one-click headers', async () => {
    const d = makeDeps();
    const r = await runZomaWeeklyReports(d);
    expect(r).toEqual({ checked: 1, sent: 1, failed: 0 });
    expect(d.claim).toHaveBeenCalledWith('u1', '2026-W48');
    expect(d.sent).toHaveLength(1);
    expect(d.sent[0][0]).toBe('u1@acme.co');
    expect(d.sent[0][1]).toBe('Your Zoma week in ads');
    expect(d.sent[0][2]).toContain('Meta ads');
    expect(d.sent[0][2]).toContain('Google Ads');
    expect(d.sent[0][4]['List-Unsubscribe']).toMatch(/^<https:\/\/api\.test\/api\/zoma\/weekly-report\/unsubscribe\?t=.+>$/);
    expect(d.sent[0][4]['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    expect((d.claim as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan((d.sendEmail as jest.Mock).mock.invocationCallOrder[0]);
    // Usage: the last 7 x 24 hours. Ads: the last 7 complete days, then the 7 before.
    expect(d.getUsageByUser).toHaveBeenCalledWith(USAGE_RANGE);
    expect(d.getAdsWeeks).toHaveBeenCalledWith('u1', WIN, { final: false });
  });

  it('the usage query runs ONCE for the whole pass, however many users there are', async () => {
    const d = makeDeps({
      listUsers: jest.fn().mockResolvedValue([customer('a'), customer('b'), customer('c')]),
      getUsageByUser: jest.fn().mockResolvedValue(usageFor('a', 'b', 'c')),
    });
    await runZomaWeeklyReports(d);
    expect(d.getUsageByUser).toHaveBeenCalledTimes(1);
  });

  it('on the last tick of the window a platform that still cannot be read is reported, not retried', async () => {
    const d = makeDeps({ now: () => Date.UTC(2026, 10, 23, 23, 30) });
    await runZomaWeeklyReports(d);
    expect(d.getAdsWeeks).toHaveBeenCalledWith('u1', adsWindows(Date.UTC(2026, 10, 23, 23, 30)), { final: true });
  });

  it('everyone who made a call gets it, even with no ad delivery, no change, or no ad account', async () => {
    const d = makeDeps({
      listUsers: jest.fn().mockResolvedValue([customer('a'), customer('b'), customer('c')]),
      getUsageByUser: jest.fn().mockResolvedValue(new Map([['a', usage({ toolCalls: 1, writes: noWrites, recentWrites: [] })], ['b', usage({ toolCalls: 1, writes: noWrites, recentWrites: [] })], ['c', usage({ toolCalls: 1, writes: noWrites, recentWrites: [] })]])),
      getAdsWeeks: jest.fn(async (id: string) => (id === 'a' ? [] : id === 'b' ? [{ platform: 'meta', status: 'no_delivery' }] : [GOOGLE_WEEK]) as PlatformWeek[]),
    });
    expect(await runZomaWeeklyReports(d)).toMatchObject({ checked: 3, sent: 3 });
    expect(d.sent.map((s) => s[0])).toEqual(['a@acme.co', 'b@acme.co', 'c@acme.co']);
    expect(d.sent[0][2]).toContain('No ad account is connected to Zoma yet.');
    expect(d.sent[1][2]).toContain('No ad delivery was recorded');
  });

  it('a user with no successful Zoma call gets nothing and costs no per-user work', async () => {
    const absent = makeDeps({ getUsageByUser: jest.fn().mockResolvedValue(new Map()) });
    expect(await runZomaWeeklyReports(absent)).toMatchObject({ checked: 1, sent: 0 });
    expect(absent.hasClaimed).not.toHaveBeenCalled();
    expect(absent.getAdsWeeks).not.toHaveBeenCalled();
    expect(absent.freshRecipient).not.toHaveBeenCalled();
    expect(absent.sendEmail).not.toHaveBeenCalled();
    const zero = makeDeps({ getUsageByUser: jest.fn().mockResolvedValue(new Map([['u1', usage({ toolCalls: 0 })]])) });
    expect(await runZomaWeeklyReports(zero)).toMatchObject({ checked: 1, sent: 0 });
    expect(zero.claim).not.toHaveBeenCalled();
  });

  it('a second pass in the same week sends nothing', async () => {
    const d = makeDeps({ hasClaimed: jest.fn().mockResolvedValue(true) });
    expect(await runZomaWeeklyReports(d)).toMatchObject({ sent: 0 });
    expect(d.getAdsWeeks).not.toHaveBeenCalled();
    expect(d.sendEmail).not.toHaveBeenCalled();
  });

  it('only one of two concurrent instances sends: the conditional claim decides', async () => {
    const d = makeDeps({ claim: jest.fn().mockResolvedValue(false) });
    expect(await runZomaWeeklyReports(d)).toMatchObject({ sent: 0, failed: 0 });
    expect(d.sendEmail).not.toHaveBeenCalled();
  });

  it('skips internal/test accounts, pal leads, users without an email, and tombstoned accounts', async () => {
    const d = makeDeps({
      listUsers: jest.fn().mockResolvedValue([
        customer('internal', { email: 'a@agentweb.pro' }), customer('admin', { isAdmin: true }),
        customer('pal', { zomaAdsExperience: 'not_interested' }), customer('noemail', { email: '' }),
        customer('deleted_abc123'),
      ]),
      getUsageByUser: jest.fn().mockResolvedValue(usageFor('internal', 'admin', 'pal', 'noemail', 'deleted_abc123')),
    });
    expect(await runZomaWeeklyReports(d)).toMatchObject({ checked: 0, sent: 0 });
    expect(d.hasClaimed).not.toHaveBeenCalled();
    expect(d.claim).not.toHaveBeenCalled();
  });

  it('the canary list restricts the whole pass to the named users', async () => {
    const d = makeDeps({
      config: () => cfg({ onlyUserIds: ['b'] }),
      listUsers: jest.fn().mockResolvedValue([customer('a'), customer('b'), customer('c')]),
      getUsageByUser: jest.fn().mockResolvedValue(usageFor('a', 'b', 'c')),
    });
    expect(await runZomaWeeklyReports(d)).toMatchObject({ checked: 1, sent: 1 });
    expect(d.sent.map((s) => s[0])).toEqual(['b@acme.co']);
  });

  describe('opt-out and the fresh recipient read', () => {
    it('a user already marked opted out in the scan is skipped before any other read', async () => {
      const d = makeDeps({ listUsers: jest.fn().mockResolvedValue([customer('opted', { zomaWeeklyReportOptOutAt: '2026-11-20T10:00:00.000Z' })]), getUsageByUser: jest.fn().mockResolvedValue(usageFor('opted')) });
      expect(await runZomaWeeklyReports(d)).toMatchObject({ checked: 1, sent: 0 });
      expect(d.hasClaimed).not.toHaveBeenCalled();
      expect(d.getAdsWeeks).not.toHaveBeenCalled();
      expect(d.sendEmail).not.toHaveBeenCalled();
    });

    it('a user who unsubscribed after the scan (a stale row) is caught by the fresh read, before the claim', async () => {
      const d = makeDeps({ freshRecipient: jest.fn().mockResolvedValue({ email: 'u1@acme.co', optedOut: true }) });
      expect(await runZomaWeeklyReports(d)).toMatchObject({ checked: 1, sent: 0 });
      expect(d.freshRecipient).toHaveBeenCalledWith('u1');
      expect(d.claim).not.toHaveBeenCalled();
      expect(d.sendEmail).not.toHaveBeenCalled();
    });

    it('an account that cannot be resolved is never emailed (fail closed)', async () => {
      const d = makeDeps({ freshRecipient: jest.fn().mockResolvedValue(undefined) });
      expect(await runZomaWeeklyReports(d)).toMatchObject({ checked: 1, sent: 0 });
      expect(d.claim).not.toHaveBeenCalled();
      expect(d.sendEmail).not.toHaveBeenCalled();
    });

    it('the email goes to the address read fresh, not to a stale one from the scan', async () => {
      const d = makeDeps({ freshRecipient: jest.fn().mockResolvedValue({ email: 'changed@acme.co', optedOut: false }) });
      await runZomaWeeklyReports(d);
      expect(d.sent.map((s) => s[0])).toEqual(['changed@acme.co']);
    });
  });

  it('an email that cannot be built does not burn the week: nothing is claimed', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const d = makeDeps({ secret: () => { throw new Error('no signing secret'); } });
    expect(await runZomaWeeklyReports(d)).toMatchObject({ sent: 0, failed: 0 });
    expect(d.claim).not.toHaveBeenCalled();
    expect(d.sendEmail).not.toHaveBeenCalled();
  });

  it('an ad-read failure skips the user for this pass (nothing claimed, retried next hour)', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const d = makeDeps({ getAdsWeeks: jest.fn().mockRejectedValue(new Error('boom')) });
    expect(await runZomaWeeklyReports(d)).toMatchObject({ sent: 0, failed: 0 });
    expect(d.claim).not.toHaveBeenCalled();
    expect(d.sendEmail).not.toHaveBeenCalled();
  });

  it('a failed send is counted, logged and not retried in the pass', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const d = makeDeps({ sendEmail: jest.fn().mockResolvedValue('failed') });
    expect(await runZomaWeeklyReports(d)).toEqual({ checked: 1, sent: 0, failed: 1 });
    expect(d.sendEmail).toHaveBeenCalledTimes(1);
  });

  it('a suppressed send (non-prod mail guard) is neither sent nor failed', async () => {
    const d = makeDeps({ sendEmail: jest.fn().mockResolvedValue('suppressed') });
    expect(await runZomaWeeklyReports(d)).toEqual({ checked: 1, sent: 0, failed: 0 });
  });

  it('one user failing does not stop the others; the per-pass cap holds and says so', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const d = makeDeps({
      listUsers: jest.fn().mockResolvedValue([customer('a'), customer('b'), customer('c')]),
      getUsageByUser: jest.fn().mockResolvedValue(usageFor('a', 'b', 'c')),
      hasClaimed: jest.fn(async (id: string) => { if (id === 'a') throw new Error('boom'); return false; }),
      config: () => cfg({ maxPerPass: 1 }),
    });
    const r = await runZomaWeeklyReports(d);
    expect(r.sent).toBe(1); // b was claimed; the cap of 1 stops before c
    expect(d.sent.map((s) => s[0])).toEqual(['b@acme.co']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('cap of 1'));
    warn.mockRestore();
  });

  it('stops the pass after three sends in a row fail, so a mail outage cannot burn the week for everyone', async () => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const ids = ['a', 'b', 'c', 'd', 'e'];
    const d = makeDeps({
      listUsers: jest.fn().mockResolvedValue(ids.map((id) => customer(id))),
      getUsageByUser: jest.fn().mockResolvedValue(usageFor(...ids)),
      sendEmail: jest.fn().mockResolvedValue('failed'),
    });
    expect(await runZomaWeeklyReports(d)).toEqual({ checked: 3, sent: 0, failed: 3 });
    expect(d.sendEmail).toHaveBeenCalledTimes(3);
    expect(d.claim).toHaveBeenCalledTimes(3); // d and e still hold their week
    expect(error).toHaveBeenCalledWith(expect.stringContaining('sends in a row failed'));
  });

  it('a send that works in between resets the count', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const outcomes = ['failed', 'failed', 'sent', 'failed', 'failed'];
    const ids = ['a', 'b', 'c', 'd', 'e'];
    const send = jest.fn();
    outcomes.forEach((o) => send.mockResolvedValueOnce(o));
    const d = makeDeps({
      listUsers: jest.fn().mockResolvedValue(ids.map((id) => customer(id))),
      getUsageByUser: jest.fn().mockResolvedValue(usageFor(...ids)),
      sendEmail: send,
    });
    expect(await runZomaWeeklyReports(d)).toEqual({ checked: 5, sent: 1, failed: 4 });
    expect(send).toHaveBeenCalledTimes(5);
  });

  it('the unsubscribe link in the sent email verifies back to that user', async () => {
    const d = makeDeps();
    await runZomaWeeklyReports(d);
    const link = /Stop this weekly email: (\S+)/.exec(d.sent[0][2])![1];
    expect(verifyUnsubscribeToken(decodeURIComponent(link.split('?t=')[1]), SECRET)).toBe('u1');
  });
});

describe('the production wiring', () => {
  const accounts = require('../services/connectedAccountsDb');
  const metaAccount = {
    platform: 'meta', account_id: '1339', account_name: 'Acme',
    config: { account_type: 'ad_account', ad_account_id: '1339', access_token: 't', token_expires_at: Date.now() + 3_600_000, granted_scopes: ['ads_read', 'ads_management'] },
  };
  // Stored ids are undashed (googleAdsOAuthFinalize), which is what the credentials lookup compares against.
  const googleAccount = { platform: 'google_ads', account_id: 'g1', account_name: 'Acme G', config: { customer_id: '2883029950', refresh_token: 'r' } };
  const mrow = (date: string, spend: number, conversions = 0) => ({ date, spend, impressions: spend * 10, clicks: spend / 2, conversions, conversion_value: 0 });
  const metaDaily = (rows: any[]) => ({ account_id: '1339', currency: 'USD', conversion_event: 'lead', rows });
  const camp = (name: string, spend: number, conversions = 0) => ({ campaign_name: name, spend, conversions });
  const gRow = (date: string, micros: number, impressions: number, clicks: number, conversions: number) => ({
    segments: { date }, customer: { resourceName: 'customers/2883029950', currencyCode: 'INR' },
    metrics: { costMicros: String(micros), impressions: String(impressions), clicks: String(clicks), conversions },
  });
  let queryReporting: jest.SpyInstance;
  beforeEach(() => {
    mockRunReport.mockReset();
    mockRunDaily.mockReset();
    accounts.getAccountsByUserIdIncludingOrgShared.mockReset();
    queryReporting = jest.spyOn(googleAdsService, 'queryReporting').mockReset();
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => queryReporting.mockRestore());
  const read = (opts = { final: false }) => defaultZomaWeeklyReportDeps.getAdsWeeks('u1', WIN, opts);

  describe('Meta', () => {
    beforeEach(() => accounts.getAccountsByUserIdIncludingOrgShared.mockResolvedValue([metaAccount]));

    it('builds the week from one 14-day daily read plus a campaign ranking, never the agent-facing summary', async () => {
      mockRunDaily.mockResolvedValue(metaDaily([mrow('2026-11-16', 10, 1), mrow('2026-11-18', 20, 2), mrow('2026-11-10', 14, 1)]));
      mockRunReport.mockResolvedValue({ rows: [camp('Small', 5, 1), camp('Big', 25, 2), camp('Zero', 0), camp('Mid', 10), camp('Tiny', 1)], summary: 'Meta ads report for act_1339 (agent-facing text, must not be used)' });
      const weeks = await read();
      expect(weeks).toHaveLength(1);
      expect(weeks[0]).toMatchObject({
        platform: 'meta', status: 'delivered',
        ads: {
          currency: 'USD', spend: 30, impressions: 300, clicks: 15, conversions: 3, roas: null, conversionEvent: 'lead',
          previous: { spend: 14, impressions: 140, clicks: 7, conversions: 1 },
          topCampaigns: [{ name: 'Big', spend: 25, conversions: 2 }, { name: 'Mid', spend: 10, conversions: 0 }, { name: 'Small', spend: 5, conversions: 1 }],
        },
      });
      expect((weeks[0] as any).ads.daily.map((d: DailyPoint) => d.spend)).toEqual([10, 0, 20, 0, 0, 0, 0]);
      expect(JSON.stringify(weeks)).not.toMatch(/act_|agent-facing/);
      expect(mockRunDaily).toHaveBeenCalledWith(metaAccount, '1339', { since: '2026-11-09', until: '2026-11-22' });
      expect(mockRunReport).toHaveBeenCalledWith(metaAccount, '1339', { level: 'campaign', since: '2026-11-16', until: '2026-11-22', conversion_event: 'lead' });
      expect(queryReporting).not.toHaveBeenCalled();
    });

    it('no delivery this week (even if last week delivered) is "no delivery", and costs no campaign read', async () => {
      mockRunDaily.mockResolvedValueOnce(metaDaily([]));
      await expect(read()).resolves.toEqual([{ platform: 'meta', status: 'no_delivery' }]);
      mockRunDaily.mockResolvedValueOnce(metaDaily([mrow('2026-11-10', 50)]));
      await expect(read()).resolves.toEqual([{ platform: 'meta', status: 'no_delivery' }]);
      expect(mockRunReport).not.toHaveBeenCalled();
    });

    it('a failed campaign ranking does not hide the rest of the report', async () => {
      mockRunDaily.mockResolvedValue(metaDaily([mrow('2026-11-16', 10)]));
      mockRunReport.mockRejectedValue(new Error('campaign read failed'));
      await expect(read()).resolves.toMatchObject([{ status: 'delivered', ads: { spend: 10, topCampaigns: [] } }]);
    });

    it('a permanent failure (expired connection) is "unreadable" right away, never "no delivery"', async () => {
      mockRunDaily.mockRejectedValue(new Error('The Meta connection expired or was revoked, so no report was read. Reconnect Meta with a fresh Zoma connect link (call zoma_status).'));
      await expect(read()).resolves.toEqual([{ platform: 'meta', status: 'unreadable' }]);
    });

    it('a transient failure throws (the user is retried next hour) until the last tick, then is "unreadable"', async () => {
      mockRunDaily.mockRejectedValue(new Error('Meta did not return the report (HTTP 503). Nothing was changed.'));
      await expect(read({ final: false })).rejects.toThrow('HTTP 503');
      await expect(read({ final: true })).resolves.toEqual([{ platform: 'meta', status: 'unreadable' }]);
    });

    it('a connected account whose token has expired is "unreadable", not "not connected"', async () => {
      accounts.getAccountsByUserIdIncludingOrgShared.mockResolvedValue([{ ...metaAccount, config: { ...metaAccount.config, token_expires_at: Date.now() - 1000 } }]);
      await expect(read()).resolves.toEqual([{ platform: 'meta', status: 'unreadable' }]);
      expect(mockRunDaily).not.toHaveBeenCalled();
    });
  });

  describe('Google Ads', () => {
    beforeEach(() => {
      process.env.ZOMA_GOOGLE_ADS_ENABLED = 'true';
      accounts.getAccountsByUserIdIncludingOrgShared.mockResolvedValue([googleAccount]);
    });
    afterEach(() => { delete process.env.ZOMA_GOOGLE_ADS_ENABLED; });

    it('there is no Google section while the Google toolkit is dark, so no advice to run a Google flow that does not exist', async () => {
      delete process.env.ZOMA_GOOGLE_ADS_ENABLED;
      await expect(read()).resolves.toEqual([]);
      expect(queryReporting).not.toHaveBeenCalled();
    });

    it('reads a daily series for both weeks and a top-3 campaign ranking, cost micros to currency units', async () => {
      queryReporting
        .mockResolvedValueOnce([gRow('2026-11-17', 950_500_000, 5200, 120, 4.5), gRow('2026-11-10', 400_000_000, 100, 10, 1)])
        .mockResolvedValueOnce([{ campaign: { name: 'Brand' }, metrics: { costMicros: '900000000', conversions: 4 } }, { campaign: { name: 'Generic' }, metrics: { costMicros: '50500000', conversions: 0.5 } }]);
      const weeks = await read();
      expect(weeks[0]).toMatchObject({
        platform: 'google_ads', status: 'delivered',
        ads: {
          currency: 'INR', spend: 950.5, impressions: 5200, clicks: 120, conversions: 4.5, roas: null, conversionEvent: null,
          previous: { spend: 400, impressions: 100, clicks: 10, conversions: 1 },
          topCampaigns: [{ name: 'Brand', spend: 900, conversions: 4 }, { name: 'Generic', spend: 50.5, conversions: 0.5 }],
        },
      });
      expect((weeks[0] as any).ads.daily[1].spend).toBe(950.5); // Tuesday Nov 17
      expect(queryReporting).toHaveBeenCalledTimes(2);
      const [userId, customerId, daily] = queryReporting.mock.calls[0];
      expect(userId).toBe('u1');
      expect(customerId).toBe('2883029950');
      expect(daily).toContain('SELECT segments.date, customer.currency_code');
      expect(daily).toContain("FROM customer WHERE segments.date BETWEEN '2026-11-09' AND '2026-11-22'");
      const campaigns = queryReporting.mock.calls[1][2];
      expect(campaigns).toContain("FROM campaign WHERE segments.date BETWEEN '2026-11-16' AND '2026-11-22'");
      expect(campaigns).toContain('ORDER BY metrics.cost_micros DESC LIMIT 3');
      expect(mockRunDaily).not.toHaveBeenCalled();
    });

    it('zero spend and zero impressions, or no rows at all, is "no delivery" and costs no campaign read', async () => {
      queryReporting.mockResolvedValueOnce([gRow('2026-11-17', 0, 0, 0, 0)]);
      await expect(read()).resolves.toEqual([{ platform: 'google_ads', status: 'no_delivery' }]);
      queryReporting.mockResolvedValueOnce([]);
      await expect(read()).resolves.toEqual([{ platform: 'google_ads', status: 'no_delivery' }]);
      expect(queryReporting).toHaveBeenCalledTimes(2);
    });

    it('a failed campaign query keeps the report; a permanent error is "unreadable"; a transient one waits for the last tick', async () => {
      queryReporting.mockResolvedValueOnce([gRow('2026-11-17', 10_000_000, 100, 5, 1)]).mockRejectedValueOnce(new Error('campaign query failed'));
      await expect(read()).resolves.toMatchObject([{ status: 'delivered', ads: { spend: 10, topCampaigns: [] } }]);
      queryReporting.mockRejectedValueOnce(new Error('PERMISSION_DENIED: the caller does not have permission'));
      await expect(read()).resolves.toEqual([{ platform: 'google_ads', status: 'unreadable' }]);
      queryReporting.mockRejectedValue(new Error('UNAVAILABLE: try again'));
      await expect(read({ final: false })).rejects.toThrow('UNAVAILABLE');
      await expect(read({ final: true })).resolves.toEqual([{ platform: 'google_ads', status: 'unreadable' }]);
    });
  });

  it('both platforms are read independently: one failing does not hide the other', async () => {
    process.env.ZOMA_GOOGLE_ADS_ENABLED = 'true';
    accounts.getAccountsByUserIdIncludingOrgShared.mockResolvedValue([metaAccount, googleAccount]);
    mockRunDaily.mockRejectedValue(new Error('The Meta connection expired or was revoked'));
    queryReporting.mockResolvedValueOnce([gRow('2026-11-17', 4_000_000, 100, 5, 1)]).mockResolvedValueOnce([]);
    const weeks = await read();
    expect(weeks.map((w) => `${w.platform}:${w.status}`)).toEqual(['meta:unreadable', 'google_ads:delivered']);
    delete process.env.ZOMA_GOOGLE_ADS_ENABLED;
  });

  describe('several connected accounts', () => {
    const second = { ...metaAccount, account_id: '2000', account_name: 'Acme two', config: { ...metaAccount.config, ad_account_id: '2000' } };
    const third = { ...metaAccount, account_id: '3000', config: { ...metaAccount.config, ad_account_id: '3000' } };
    const fourth = { ...metaAccount, account_id: '4000', config: { ...metaAccount.config, ad_account_id: '4000' } };
    const byAccount = (rows: Record<string, any[]>) => mockRunDaily.mockImplementation(async (_a: any, id: string) => metaDaily(rows[id] ?? []));

    it('an idle first account does not hide the one that delivered: it is never reported as "no delivery"', async () => {
      accounts.getAccountsByUserIdIncludingOrgShared.mockResolvedValue([metaAccount, second]);
      byAccount({ '1339': [], '2000': [mrow('2026-11-17', 40, 2)] });
      mockRunReport.mockResolvedValue({ rows: [camp('Only', 40, 2)] });
      const weeks = await read();
      expect(weeks).toMatchObject([{ platform: 'meta', status: 'delivered', ads: { spend: 40, conversions: 2 } }]);
      expect(mockRunDaily.mock.calls.map((c) => c[1])).toEqual(['1339', '2000']);
      expect(mockRunReport).toHaveBeenCalledTimes(1);
      expect(mockRunReport.mock.calls[0][1]).toBe('2000'); // the ranking is read only for the account that delivered
    });

    it('accounts in the same currency are added together', async () => {
      accounts.getAccountsByUserIdIncludingOrgShared.mockResolvedValue([metaAccount, second]);
      byAccount({ '1339': [mrow('2026-11-16', 10, 1)], '2000': [mrow('2026-11-16', 20, 2)] });
      mockRunReport.mockResolvedValue({ rows: [] });
      const [w] = (await read()) as any[];
      expect(w.ads).toMatchObject({ spend: 30, conversions: 3 });
      expect(w.ads.daily[0].spend).toBe(30);
      expect(w.ads.notIncluded).toBeUndefined();
    });

    it('only a few accounts per platform are read, and the rest are counted as not included', async () => {
      accounts.getAccountsByUserIdIncludingOrgShared.mockResolvedValue([metaAccount, second, third, fourth]);
      byAccount({ '1339': [mrow('2026-11-16', 10)], '2000': [mrow('2026-11-16', 10)], '3000': [mrow('2026-11-16', 10)], '4000': [mrow('2026-11-16', 10)] });
      mockRunReport.mockResolvedValue({ rows: [] });
      const [w] = (await read()) as any[];
      expect(mockRunDaily).toHaveBeenCalledTimes(3);
      expect(w.ads).toMatchObject({ spend: 30, notIncluded: 1 });
    });

    it('an idle account next to an expired one cannot be called "no delivery"', async () => {
      const expired = { ...second, config: { ...second.config, token_expires_at: Date.now() - 1000 } };
      accounts.getAccountsByUserIdIncludingOrgShared.mockResolvedValue([metaAccount, expired]);
      byAccount({ '1339': [] });
      await expect(read()).resolves.toEqual([{ platform: 'meta', status: 'unreadable' }]);
    });

    it('a permanent failure on one account does not hide another that delivered, and is counted', async () => {
      accounts.getAccountsByUserIdIncludingOrgShared.mockResolvedValue([metaAccount, second]);
      mockRunDaily.mockImplementation(async (_a: any, id: string) => {
        if (id === '1339') throw new Error('The Meta connection expired or was revoked');
        return metaDaily([mrow('2026-11-17', 40, 2)]);
      });
      mockRunReport.mockResolvedValue({ rows: [] });
      const [w] = (await read()) as any[];
      expect(w.status).toBe('delivered');
      expect(w.ads.notIncluded).toBe(1);
    });
  });

  it('no connected ad account at all is an empty list and no report call', async () => {
    accounts.getAccountsByUserIdIncludingOrgShared.mockResolvedValue([]);
    await expect(read()).resolves.toEqual([]);
    expect(mockRunDaily).not.toHaveBeenCalled();
    expect(queryReporting).not.toHaveBeenCalled();
  });

  it('isPermanentReadError: connection and permission problems are permanent, outages and rate limits are not', () => {
    for (const m of ['The Meta connection expired or was revoked', 'Reconnect Meta', 'Google Ads PERMISSION_DENIED', 'invalid_grant', '... (OAuthException, code 190)', 'no usable access token',
      // The real Google error for a dead credential, seen live on env1.
      'UNAUTHENTICATED — Request had invalid authentication credentials. Expected OAuth 2 access token, login cookie or other valid authentication credential.', 'Meta did not return the report (HTTP 401)', 'Request failed with status code 400']) {
      expect(isPermanentReadError(new Error(m))).toBe(true);
    }
    for (const m of ['Meta did not return the report (HTTP 503)', 'timeout of 20000ms exceeded', 'Meta did not return the report (rate limit, code 4)', 'UNAVAILABLE', 'fetch failed', 'Meta did not return the report (HTTP 5401)']) {
      expect(isPermanentReadError(new Error(m))).toBe(false);
    }
  });

  it('the usage read is the Zoma product only (Emma MCP writes the same event type as emma_mcp)', async () => {
    const spy = jest.spyOn(usageService, 'getMcpUsageByUser').mockResolvedValue(new Map());
    await defaultZomaWeeklyReportDeps.getUsageByUser(USAGE_RANGE);
    expect(spy).toHaveBeenCalledWith(USAGE_RANGE, { product: 'zoma' });
    spy.mockRestore();
  });

  it('the claim is scoped to the environment: a non-production claim can never block production', async () => {
    expect(claimKey('u1', '2026-W48', { NODE_ENV: 'production' } as any)).toBe('u1#2026-W48');
    expect(claimKey('u1', '2026-W48', { NODE_ENV: 'development' } as any)).toBe('nonprod#u1#2026-W48');
    expect(claimKey('u1', '2026-W48', {} as any)).toBe('nonprod#u1#2026-W48');
    // And the production wiring really uses it, both to check and to claim.
    const has = jest.spyOn(usageService, 'hasZomaFunnelRow').mockResolvedValue(false);
    const rec = jest.spyOn(usageService, 'recordZomaBillingFunnel').mockResolvedValue(true);
    await defaultZomaWeeklyReportDeps.hasClaimed('u1', '2026-W48');
    await defaultZomaWeeklyReportDeps.claim('u1', '2026-W48');
    const key = claimKey('u1', '2026-W48'); // this test run is NODE_ENV=test, so non-production
    expect(key.startsWith('nonprod#')).toBe(true);
    expect(has).toHaveBeenCalledWith('u1', 'weekly_report_claimed', key);
    expect(rec).toHaveBeenCalledWith({ userId: 'u1', step: 'weekly_report_claimed', dedupeKey: key });
    has.mockRestore();
    rec.mockRestore();
  });
});

describe('opt-out on the user record', () => {
  beforeEach(() => { mockUpdateUser.mockReset().mockResolvedValue({}); mockGetUserByIdConsistent.mockReset(); });

  it('records the time through the injected setter, and reports true', async () => {
    const set = jest.fn().mockResolvedValue(undefined);
    await expect(recordWeeklyReportOptOut('u7', set, () => new Date('2026-11-23T16:05:00Z'))).resolves.toBe(true);
    expect(set).toHaveBeenCalledWith('u7', '2026-11-23T16:05:00.000Z');
  });
  it('an unknown or deleted user is false (nothing to stop); any other failure, even one that says "not found", is thrown', async () => {
    await expect(recordWeeklyReportOptOut('gone', jest.fn().mockRejectedValue(new Error("User with ID 'gone' not found or has no email.")))).resolves.toBe(false);
    await expect(recordWeeklyReportOptOut('u7', jest.fn().mockRejectedValue(new Error('ProvisionedThroughputExceeded')))).rejects.toThrow('ProvisionedThroughputExceeded');
    // An AWS "table not found" must never be reported to the user as "you are unsubscribed".
    await expect(recordWeeklyReportOptOut('u7', jest.fn().mockRejectedValue(new Error('Requested resource not found')))).rejects.toThrow('Requested resource not found');
  });
  it('the default writes only zomaWeeklyReportOptOutAt, with a partial update of that one user', async () => {
    await expect(recordWeeklyReportOptOut('u7')).resolves.toBe(true);
    expect(mockUpdateUser).toHaveBeenCalledTimes(1);
    const [userId, updates] = mockUpdateUser.mock.calls[0];
    expect(userId).toBe('u7');
    expect(Object.keys(updates)).toEqual(['zomaWeeklyReportOptOutAt']);
    expect(new Date(updates.zomaWeeklyReportOptOutAt).toString()).not.toBe('Invalid Date');
  });
  it('the fresh read uses the consistent lookup, and answers with the address and the flag', async () => {
    mockGetUserByIdConsistent.mockResolvedValueOnce({ userId: 'u1', email: 'a@acme.co', zomaWeeklyReportOptOutAt: '2026-11-23T16:05:00.000Z' });
    await expect(defaultZomaWeeklyReportDeps.freshRecipient('u1')).resolves.toEqual({ email: 'a@acme.co', optedOut: true });
    mockGetUserByIdConsistent.mockResolvedValueOnce({ userId: 'u1', email: 'a@acme.co' });
    await expect(defaultZomaWeeklyReportDeps.freshRecipient('u1')).resolves.toEqual({ email: 'a@acme.co', optedOut: false });
    expect(mockGetUserByIdConsistent).toHaveBeenCalledWith('u1');
  });
  it('an account that is gone, or has no address, is "unresolved", never "not opted out"', async () => {
    mockGetUserByIdConsistent.mockResolvedValueOnce(undefined);
    await expect(defaultZomaWeeklyReportDeps.freshRecipient('u1')).resolves.toBeUndefined();
    mockGetUserByIdConsistent.mockResolvedValueOnce({ userId: 'u1' });
    await expect(defaultZomaWeeklyReportDeps.freshRecipient('u1')).resolves.toBeUndefined();
  });
});

describe('the week claim row', () => {
  it('hasZomaFunnelRow finds the row the funnel recorder wrote, and nothing else', async () => {
    const items = new Map<string, any>();
    const store: McpUsageEventStore = {
      put: jest.fn(async (item: any, options?: any) => {
        const key = `${item.loopId}#${item.tsSession}`;
        if (options?.condition === 'attribute_not_exists' && items.has(key)) { const e: any = new Error('exists'); e.code = 'ConditionalCheckFailedException'; throw e; }
        items.set(key, item);
      }) as any,
      queryByLoopId: jest.fn(async () => []),
      get: jest.fn(async (loopId: string, tsSession: string) => items.get(`${loopId}#${tsSession}`)),
    };
    await expect(hasZomaFunnelRow('u7', 'weekly_report_claimed', 'u7#2026-W48', store)).resolves.toBe(false);
    await expect(recordZomaBillingFunnel({ userId: 'u7', step: 'weekly_report_claimed', dedupeKey: 'u7#2026-W48' }, store)).resolves.toBe(true);
    await expect(hasZomaFunnelRow('u7', 'weekly_report_claimed', 'u7#2026-W48', store)).resolves.toBe(true);
    await expect(recordZomaBillingFunnel({ userId: 'u7', step: 'weekly_report_claimed', dedupeKey: 'u7#2026-W48' }, store)).resolves.toBe(false); // second claim loses
    await expect(hasZomaFunnelRow('u7', 'weekly_report_claimed', 'u7#2026-W49', store)).resolves.toBe(false);
    await expect(hasZomaFunnelRow('u8', 'weekly_report_claimed', 'u8#2026-W48', store)).resolves.toBe(false);
    // The environment-scoped key is a different row from the production one.
    await expect(hasZomaFunnelRow('u7', 'weekly_report_claimed', 'nonprod#u7#2026-W48', store)).resolves.toBe(false);
    // A store without an exact-key read answers false instead of throwing.
    await expect(hasZomaFunnelRow('u7', 'weekly_report_claimed', 'x', { put: jest.fn(), queryByLoopId: jest.fn() } as any)).resolves.toBe(false);
    await expect(hasZomaFunnelRow('', 'weekly_report_claimed', 'x', store)).resolves.toBe(false);
  });
});

describe('getMcpUsageByUser: every user from one query', () => {
  const START = '2026-11-16T16:00:00.000Z';
  const END = '2026-11-23T16:00:00.000Z';
  const row = (subjectId: string, eventType: string, ts: string, dimensions: Record<string, string> = {}) =>
    ({ loopId: 'emma-mcp', tsSession: `${ts}#${subjectId}`, eventType, subjectId, ts, dimensions }) as any;
  const storeOf = (rows: any[]): McpUsageEventStore & { queryByLoopIdTsRangeAll: jest.Mock } =>
    ({ put: jest.fn(), queryByLoopId: jest.fn(async () => rows), queryByLoopIdTsRangeAll: jest.fn(async () => rows) }) as any;
  const rows = [
    row('u1', 'mcp_tool_used', '2026-11-18T10:00:00.000Z', { product: 'zoma' }),
    row('u1', 'mcp_tool_used', '2026-11-19T10:00:00.000Z', { product: 'zoma' }),
    row('u1', 'mcp_tool_used', '2026-11-19T11:00:00.000Z', { product: 'emma_mcp' }), // Emma's own MCP, same event type
    row('u1', 'mcp_write_executed', '2026-11-20T10:00:00.000Z', { product: 'zoma', verification: 'CONFIRMED', platform: 'meta', entityType: 'CAMPAIGN', action: 'UPDATE' }),
    row('u2', 'mcp_tool_used', '2026-11-18T10:00:00.000Z', { product: 'emma_mcp' }), // only Emma: not a Zoma user this week
    row('u3', 'mcp_tool_used', '2026-11-16T15:59:59.000Z', { product: 'zoma' }), // before the window
    row('u3', 'mcp_tool_used', END, { product: 'zoma' }), // the end is exclusive
    row('u4', 'mcp_first_tool_use', '2026-11-18T10:00:00.000Z', { product: 'zoma' }), // not a usage event
  ];

  it('groups by user, counts only Zoma-product rows in the window, and reads the table once', async () => {
    const store = storeOf(rows);
    const byUser = await getMcpUsageByUser({ start: START, end: END }, { product: 'zoma' }, store);
    expect([...byUser.keys()]).toEqual(['u1']);
    expect(byUser.get('u1')).toMatchObject({ toolCalls: 2, writes: { total: 1, confirmed: 1, mismatch: 0, unconfirmed: 0 } });
    expect(byUser.get('u1')!.recentWrites).toHaveLength(1);
    expect(store.queryByLoopIdTsRangeAll).toHaveBeenCalledTimes(1);
    expect(store.queryByLoopIdTsRangeAll).toHaveBeenCalledWith('emma-mcp', START, END);
  });

  it('without a product filter every product counts', async () => {
    const byUser = await getMcpUsageByUser({ start: START, end: END }, {}, storeOf(rows));
    expect(byUser.get('u1')!.toolCalls).toBe(3);
    expect(byUser.get('u2')!.toolCalls).toBe(1);
    expect(byUser.has('u3')).toBe(false);
    expect(byUser.has('u4')).toBe(false);
  });

  it('a store without the all-users range read falls back to the plain read with the same answer', async () => {
    const store: any = { put: jest.fn(), queryByLoopId: jest.fn(async () => rows) };
    const byUser = await getMcpUsageByUser({ start: START, end: END }, { product: 'zoma' }, store);
    expect(byUser.get('u1')!.toolCalls).toBe(2);
    expect(store.queryByLoopId).toHaveBeenCalledTimes(1);
  });
});

describe('mail headers', () => {
  it('the system mailer passes headers to the provider only when given', async () => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const spy = jest.spyOn(resendService, 'sendEmail').mockResolvedValue({ id: 'x' } as any);
    await emailService.sendEmail('a@acme.co', 's', 't', '<p>h</p>', undefined, { 'List-Unsubscribe': '<https://x>' });
    expect(spy.mock.calls[0][0]).toMatchObject({ headers: { 'List-Unsubscribe': '<https://x>' } });
    await emailService.sendEmail('a@acme.co', 's', 't', '<p>h</p>');
    expect(spy.mock.calls[1][0]).not.toHaveProperty('headers');
    spy.mockRestore();
  });
});

describe('unsubscribe routes', () => {
  const app = () => express().use(express.urlencoded({ extended: false })).use('/api/zoma', createZomaRouter());
  const token = () => signUnsubscribeToken('route-user');
  beforeEach(() => mockUpdateUser.mockReset().mockResolvedValue({}));

  it('GET shows a confirm button and changes nothing', async () => {
    const res = await request(app()).get('/api/zoma/weekly-report/unsubscribe').query({ t: token() });
    expect(res.status).toBe(200);
    expect(res.text).toContain('<form method="post" action="/api/zoma/weekly-report/unsubscribe">');
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });

  it('GET with a bad token is a 400 that points at support, and changes nothing', async () => {
    const res = await request(app()).get('/api/zoma/weekly-report/unsubscribe').query({ t: 'nope' });
    expect(res.status).toBe(400);
    expect(res.text).toContain('support@agentweb.pro');
    expect(res.text).not.toContain('Reply to the email');
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });

  it('POST with a valid token sets the opt-out on that one user and confirms', async () => {
    const res = await request(app()).post('/api/zoma/weekly-report/unsubscribe').type('form').send({ t: token() });
    expect(res.status).toBe(200);
    expect(res.text).toContain('You will not get the weekly Zoma ad report any more');
    expect(mockUpdateUser).toHaveBeenCalledTimes(1);
    const [userId, updates] = mockUpdateUser.mock.calls[0];
    expect(userId).toBe('route-user');
    expect(Object.keys(updates)).toEqual(['zomaWeeklyReportOptOutAt']);
  });

  it('the mail client one-click POST (token in the link, "List-Unsubscribe=One-Click" in the body) unsubscribes', async () => {
    const res = await request(app()).post(`/api/zoma/weekly-report/unsubscribe?t=${encodeURIComponent(token())}`).type('form').send('List-Unsubscribe=One-Click');
    expect(res.status).toBe(200);
    expect(mockUpdateUser).toHaveBeenCalledTimes(1);
    expect(mockUpdateUser.mock.calls[0][0]).toBe('route-user');
  });

  it('POST for a user that no longer exists still confirms and creates nothing', async () => {
    mockUpdateUser.mockRejectedValueOnce(new Error("User with ID 'route-user' not found or has no email."));
    const res = await request(app()).post('/api/zoma/weekly-report/unsubscribe').type('form').send({ t: token() });
    expect(res.status).toBe(200);
    expect(res.text).toContain('You will not get the weekly Zoma ad report any more');
  });

  it('POST with a tampered or missing token is a 400 and writes nothing', async () => {
    const bad = await request(app()).post('/api/zoma/weekly-report/unsubscribe').type('form').send({ t: tamper(token()) });
    expect(bad.status).toBe(400);
    const none = await request(app()).post('/api/zoma/weekly-report/unsubscribe').type('form').send({});
    expect(none.status).toBe(400);
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });

  it('a database failure is an unsubscribe-specific error page, not a false confirmation and not the setup page', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    mockUpdateUser.mockRejectedValueOnce(new Error('ProvisionedThroughputExceeded'));
    const res = await request(app()).post('/api/zoma/weekly-report/unsubscribe').type('form').send({ t: token() });
    expect(res.status).toBe(500);
    expect(res.text).not.toContain('You will not get the weekly Zoma ad report any more');
    expect(res.text).not.toContain('Zoma setup');
    expect(res.text).toContain('support@agentweb.pro');
  });

  it('an AWS "resource not found" error is a failure, never a confirmation', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    mockUpdateUser.mockRejectedValueOnce(new Error('Requested resource not found'));
    const res = await request(app()).post('/api/zoma/weekly-report/unsubscribe').type('form').send({ t: token() });
    expect(res.status).toBe(500);
    expect(res.text).not.toContain('You will not get the weekly Zoma ad report any more');
  });
});
