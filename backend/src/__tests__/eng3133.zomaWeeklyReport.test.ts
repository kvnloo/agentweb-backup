/**
 * ENG-3133 — the weekly Zoma ad-performance email.
 * Pure rules, the job with injected dependencies, the production ad-totals wiring (Meta and Google Ads,
 * mocked reports), the opt-out on the user record, and the unsubscribe routes.
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
jest.mock('../mcp/zomaAdsReport', () => ({
  ...jest.requireActual('../mcp/zomaAdsReport'),
  runZomaAdsReport: (...a: any[]) => mockRunReport(...a),
}));

import express from 'express';
import request from 'supertest';
import { createZomaRouter } from '../routes/zoma';
import { googleAdsService } from '../services/googleAdsService';
import {
  adsWeekLines,
  defaultZomaWeeklyReportDeps,
  getZomaWeeklyReportConfig,
  inSendWindow,
  isReportRecipient,
  isoWeekKey,
  recordWeeklyReportOptOut,
  runZomaWeeklyReports,
  signUnsubscribeToken,
  verifyUnsubscribeToken,
  weeklyReportEmail,
  zomaUnsubscribeUrl,
  type PlatformWeek,
  type ZomaAdsWeek,
  type ZomaWeeklyReportConfig,
  type ZomaWeeklyReportDeps,
} from '../mcp/zomaWeeklyReport';
import { hasZomaFunnelRow, recordZomaBillingFunnel, type McpUsageEventStore, type McpUserUsage } from '../services/mcpUsageEventsService';

const SECRET = 'test-secret';
// Monday 2026-11-23 16:00 UTC, inside the default window (Monday from 15:00 UTC).
const MONDAY_16 = Date.UTC(2026, 10, 23, 16, 0, 0);
const cfg = (over: Partial<ZomaWeeklyReportConfig> = {}): ZomaWeeklyReportConfig => ({ enabled: true, weekday: 1, hour: 15, lookbackDays: 7, maxPerPass: 200, ...over });

const usage = (over: Partial<McpUserUsage> = {}): McpUserUsage => ({
  start: '2026-11-16T16:00:00.000Z',
  end: '2026-11-23T16:00:00.000Z',
  toolCalls: 12,
  writes: { total: 2, confirmed: 2, mismatch: 0, unconfirmed: 0 },
  recentWrites: [
    { ts: '2026-11-18T10:00:00.000Z', platform: 'meta', entityType: 'CAMPAIGN', action: 'UPDATE', verification: 'CONFIRMED', objectId: '120000111' },
    { ts: '2026-11-20T09:00:00.000Z', platform: 'google_ads', entityType: 'AD_GROUP', action: 'CREATE', verification: 'CONFIRMED', objectId: '120000222' },
  ],
  ...over,
});
const noWrites = { total: 0, confirmed: 0, mismatch: 0, unconfirmed: 0 };

const META_ADS: ZomaAdsWeek = { currency: 'USD', spend: 120.5, impressions: 14000, clicks: 310, conversions: 22, roas: 2.4, conversionEvent: 'purchase' };
const GOOGLE_ADS: ZomaAdsWeek = { currency: 'INR', spend: 950, impressions: 5200, clicks: 120, conversions: 4, roas: null, conversionEvent: null };
const META_WEEK: PlatformWeek = { platform: 'meta', status: 'delivered', ads: META_ADS };
const GOOGLE_WEEK: PlatformWeek = { platform: 'google_ads', status: 'delivered', ads: GOOGLE_ADS };

const customer = (id: string, over: Record<string, unknown> = {}) => ({ userId: id, email: `${id}@acme.co`, ...over }) as any;

function makeDeps(over: Partial<ZomaWeeklyReportDeps> = {}): ZomaWeeklyReportDeps & { sent: any[] } {
  const sent: any[] = [];
  const deps: any = {
    config: () => cfg(),
    listUsers: jest.fn().mockResolvedValue([customer('u1')]),
    hasOptedOut: jest.fn().mockResolvedValue(false),
    hasClaimed: jest.fn().mockResolvedValue(false),
    claim: jest.fn().mockResolvedValue(true),
    recordSent: jest.fn().mockResolvedValue(true),
    getUsage: jest.fn().mockResolvedValue(usage()),
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
  it('uses Monday 15:00 UTC, 7 days, 200 per pass by default, and ignores out-of-range values', () => {
    expect(getZomaWeeklyReportConfig({})).toEqual({ enabled: false, weekday: 1, hour: 15, lookbackDays: 7, maxPerPass: 200 });
    expect(getZomaWeeklyReportConfig({ ZOMA_WEEKLY_REPORT_WEEKDAY: '9', ZOMA_WEEKLY_REPORT_HOUR: '24', ZOMA_WEEKLY_REPORT_MAX_PER_PASS: '0' } as any))
      .toEqual({ enabled: false, weekday: 1, hour: 15, lookbackDays: 7, maxPerPass: 200 });
    expect(getZomaWeeklyReportConfig({ ZOMA_WEEKLY_REPORT_WEEKDAY: '5', ZOMA_WEEKLY_REPORT_HOUR: '8' } as any)).toMatchObject({ weekday: 5, hour: 8 });
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
});

describe('unsubscribe token', () => {
  it('round-trips, and rejects tampering, another secret and junk', () => {
    const t = signUnsubscribeToken('user-1', SECRET);
    expect(verifyUnsubscribeToken(t, SECRET)).toBe('user-1');
    expect(verifyUnsubscribeToken(t, 'other-secret')).toBeNull();
    const [enc, sig] = t.split('.');
    expect(verifyUnsubscribeToken(`${Buffer.from('user-2').toString('base64url')}.${sig}`, SECRET)).toBeNull();
    expect(verifyUnsubscribeToken(`${enc}.${sig.slice(0, -2)}xx`, SECRET)).toBeNull();
    for (const junk of [undefined, null, 42, '', 'abc', 'a.b.c', `${enc}.`, '.'.repeat(5), 'x'.repeat(400)]) {
      expect(verifyUnsubscribeToken(junk as any, SECRET)).toBeNull();
    }
  });
  it('the URL carries a token that verifies back to the user', () => {
    const url = zomaUnsubscribeUrl('user-9', { backendUrl: () => 'https://api.test/', secret: () => SECRET });
    expect(url.startsWith('https://api.test/api/zoma/weekly-report/unsubscribe?t=')).toBe(true);
    expect(verifyUnsubscribeToken(decodeURIComponent(url.split('?t=')[1]), SECRET)).toBe('user-9');
  });
});

describe('the email', () => {
  const range = { start: '2026-11-16T16:00:00.000Z', end: '2026-11-23T16:00:00.000Z' };
  const email = (over: Partial<Parameters<typeof weeklyReportEmail>[0]> = {}) =>
    weeklyReportEmail({ usage: usage(), platforms: [META_WEEK, GOOGLE_WEEK], range, unsubscribeUrl: 'https://api.test/u?t=abc', ...over });

  it('shows spend and results for Meta and Google Ads, the confirmed changes, the call count and the unsubscribe link', () => {
    const e = email();
    expect(e.subject).toBe('Your Zoma week in ads');
    expect(e.text).toContain('2026-11-16 to 2026-11-23');
    expect(e.text).toMatch(/Meta ads\nSpend: 120\.50 USD\nImpressions: 14,000\nClicks: 310\nConversions: 22 \(purchase\)\nReturn on ad spend: 2\.4x/);
    expect(e.text).toMatch(/Google Ads\nSpend: 950\.00 INR\nImpressions: 5,200\nClicks: 120\nConversions: 4\n/);
    expect(e.text).toContain('Zoma made 2 confirmed changes to your ads this week.');
    expect(e.text).toContain('- 2026-11-20: create ad group (Google Ads)');
    expect(e.text).toContain('- 2026-11-18: update campaign (Meta)');
    expect(e.text).toContain('Your agent made 12 successful Zoma calls this week.');
    expect(e.text).toContain('Stop this weekly email: https://api.test/u?t=abc');
    expect(e.html).toContain('<h4>Meta ads</h4><ul><li>Spend: 120.50 USD</li>');
    expect(e.html).toContain('<h4>Google Ads</h4><ul><li>Spend: 950.00 INR</li>');
    expect(e.html).toContain('href="https://api.test/u?t=abc"');
    expect(e.html).toContain('support@agentweb.pro');
  });

  it('only the platforms that are connected appear, each described truthfully', () => {
    const metaOnly = email({ platforms: [META_WEEK] });
    expect(metaOnly.text).toContain('Meta ads');
    expect(metaOnly.text).not.toContain('Google Ads\nSpend');
    const mixed = email({ platforms: [{ platform: 'meta', status: 'no_delivery' }, { platform: 'google_ads', status: 'unreadable' }] });
    expect(mixed.text).toContain('No ad delivery was recorded on your connected Meta ads account this week.');
    expect(mixed.text).toContain('We could not read your Google Ads account this week. It may need to be reconnected: ask your agent to run zoma_status.');
    expect(mixed.html).toContain('<h4>Meta ads</h4><p>No ad delivery was recorded');
    expect(mixed.html).toContain('<h4>Google Ads</h4><p>We could not read your Google Ads account');
  });

  it('with no connected ad account it says so, and how to connect one', () => {
    const e = email({ platforms: [] });
    expect(e.text).toContain('No ad account is connected to Zoma yet. Ask your agent to run zoma_status for the connect link.');
    expect(e.html).toContain('<p>No ad account is connected to Zoma yet.');
    expect(e.text).not.toContain('Spend:');
  });

  it('never includes object ids or account ids, and escapes values and the url in the HTML', () => {
    const e = email({ platforms: [{ platform: 'meta', status: 'delivered', ads: { ...META_ADS, conversionEvent: '<script>alert(1)</script>' } }], unsubscribeUrl: 'https://api.test/u?t="x"&y=1' });
    expect(e.text + e.html).not.toMatch(/120000111|120000222|act_/);
    expect(e.html).not.toContain('<script>');
    expect(e.html).toContain('Conversions: 22 (&lt;script&gt;alert(1)&lt;/script&gt;)');
    expect(e.html).toContain('t=&quot;x&quot;&amp;y=1');
  });

  it('lists only confirmed changes, handles one change and none', () => {
    const one = email({
      usage: usage({ toolCalls: 1, writes: { total: 3, confirmed: 1, mismatch: 1, unconfirmed: 1 }, recentWrites: [
        { ts: '2026-11-19T10:00:00.000Z', entityType: 'AD', action: 'UPDATE', verification: 'MISMATCH' },
        { ts: '2026-11-20T10:00:00.000Z', entityType: 'AD', action: 'PAUSE', verification: 'CONFIRMED' },
      ] }),
    });
    expect(one.text).toContain('Zoma made 1 confirmed change to your ads this week.');
    expect(one.text).toContain('- 2026-11-20: pause ad');
    expect(one.text).not.toContain('2026-11-19');
    expect(one.text).toContain('Your agent made 1 successful Zoma call this week.');
    const none = email({ usage: usage({ writes: noWrites, recentWrites: [] }) });
    expect(none.text).toContain('Zoma made no changes to your ads this week.');
  });

  it('ad lines: no conversion event label or ROAS when there are none, no currency when unknown', () => {
    expect(adsWeekLines({ spend: 5, impressions: 100, clicks: 2, conversions: 0, roas: null, conversionEvent: null }))
      .toEqual(['Spend: 5.00', 'Impressions: 100', 'Clicks: 2', 'Conversions: 0']);
    expect(adsWeekLines({ ...META_ADS, roas: 0 })).not.toContain('Return on ad spend: 0x');
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
    const tuesday = makeDeps({ now: () => Date.UTC(2026, 10, 24, 16, 0) });
    expect((await runZomaWeeklyReports(tuesday)).sent).toBe(0);
  });

  it('sends one email to an eligible user, claiming the ISO week first', async () => {
    const d = makeDeps();
    const r = await runZomaWeeklyReports(d);
    expect(r).toEqual({ checked: 1, sent: 1, failed: 0 });
    expect(d.claim).toHaveBeenCalledWith('u1', '2026-W48');
    expect(d.sent).toHaveLength(1);
    expect(d.sent[0][0]).toBe('u1@acme.co');
    expect(d.sent[0][1]).toBe('Your Zoma week in ads');
    expect(d.sent[0][2]).toContain('Meta ads');
    expect(d.sent[0][2]).toContain('Google Ads');
    expect(d.recordSent).toHaveBeenCalledWith('u1', '2026-W48');
    expect((d.claim as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan((d.sendEmail as jest.Mock).mock.invocationCallOrder[0]);
    // The window is the last 7 days ending now.
    expect(d.getUsage).toHaveBeenCalledWith('u1', { start: '2026-11-16T16:00:00.000Z', end: '2026-11-23T16:00:00.000Z' });
    expect(d.getAdsWeeks).toHaveBeenCalledWith('u1', { start: '2026-11-16T16:00:00.000Z', end: '2026-11-23T16:00:00.000Z' });
  });

  it('everyone who made a call gets it, even with no ad delivery, no change, or no ad account', async () => {
    const d = makeDeps({
      listUsers: jest.fn().mockResolvedValue([customer('a'), customer('b'), customer('c')]),
      getUsage: jest.fn().mockResolvedValue(usage({ toolCalls: 1, writes: noWrites, recentWrites: [] })),
      getAdsWeeks: jest.fn(async (id: string) => (id === 'a' ? [] : id === 'b' ? [{ platform: 'meta', status: 'no_delivery' }] : [GOOGLE_WEEK]) as PlatformWeek[]),
    });
    expect(await runZomaWeeklyReports(d)).toMatchObject({ checked: 3, sent: 3 });
    expect(d.sent.map((s) => s[0])).toEqual(['a@acme.co', 'b@acme.co', 'c@acme.co']);
    expect(d.sent[0][2]).toContain('No ad account is connected to Zoma yet.');
    expect(d.sent[1][2]).toContain('No ad delivery was recorded');
  });

  it('a user with no successful call in the window gets nothing', async () => {
    const d = makeDeps({ getUsage: jest.fn().mockResolvedValue(usage({ toolCalls: 0 })) });
    expect(await runZomaWeeklyReports(d)).toMatchObject({ checked: 1, sent: 0 });
    expect(d.getAdsWeeks).not.toHaveBeenCalled();
    expect(d.claim).not.toHaveBeenCalled();
    expect(d.sendEmail).not.toHaveBeenCalled();
  });

  it('a second pass in the same week sends nothing', async () => {
    const d = makeDeps({ hasClaimed: jest.fn().mockResolvedValue(true) });
    expect(await runZomaWeeklyReports(d)).toMatchObject({ sent: 0 });
    expect(d.getUsage).not.toHaveBeenCalled();
    expect(d.sendEmail).not.toHaveBeenCalled();
  });

  it('only one of two concurrent instances sends: the conditional claim decides', async () => {
    const d = makeDeps({ claim: jest.fn().mockResolvedValue(false) });
    expect(await runZomaWeeklyReports(d)).toMatchObject({ sent: 0, failed: 0 });
    expect(d.sendEmail).not.toHaveBeenCalled();
  });

  it('skips internal/test accounts, pal leads and users without an email', async () => {
    const d = makeDeps({
      listUsers: jest.fn().mockResolvedValue([
        customer('internal', { email: 'a@agentweb.pro' }), customer('admin', { isAdmin: true }),
        customer('pal', { zomaAdsExperience: 'not_interested' }), customer('noemail', { email: '' }),
      ]),
    });
    expect(await runZomaWeeklyReports(d)).toMatchObject({ checked: 0, sent: 0 });
    expect(d.getUsage).not.toHaveBeenCalled();
    expect(d.claim).not.toHaveBeenCalled();
  });

  describe('opt-out', () => {
    it('a user already marked opted out in the scan is skipped before any other read', async () => {
      const d = makeDeps({ listUsers: jest.fn().mockResolvedValue([customer('opted', { zomaWeeklyReportOptOutAt: '2026-11-20T10:00:00.000Z' })]) });
      expect(await runZomaWeeklyReports(d)).toMatchObject({ checked: 1, sent: 0 });
      expect(d.hasClaimed).not.toHaveBeenCalled();
      expect(d.getUsage).not.toHaveBeenCalled();
      expect(d.sendEmail).not.toHaveBeenCalled();
    });

    it('a user who unsubscribed after the scan (a stale row) is caught by the fresh read, before the claim', async () => {
      const d = makeDeps({ hasOptedOut: jest.fn().mockResolvedValue(true) });
      expect(await runZomaWeeklyReports(d)).toMatchObject({ checked: 1, sent: 0 });
      expect(d.hasOptedOut).toHaveBeenCalledWith('u1');
      expect(d.claim).not.toHaveBeenCalled();
      expect(d.sendEmail).not.toHaveBeenCalled();
    });
  });

  it('an ad-read failure skips the user for this pass (nothing claimed, retried next hour)', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const d = makeDeps({ getAdsWeeks: jest.fn().mockRejectedValue(new Error('boom')) });
    expect(await runZomaWeeklyReports(d)).toMatchObject({ sent: 0, failed: 0 });
    expect(d.claim).not.toHaveBeenCalled();
    expect(d.sendEmail).not.toHaveBeenCalled();
  });

  it('a failed send is counted, logged, not retried in the pass and leaves no sent row', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const d = makeDeps({ sendEmail: jest.fn().mockResolvedValue('failed') });
    expect(await runZomaWeeklyReports(d)).toEqual({ checked: 1, sent: 0, failed: 1 });
    expect(d.sendEmail).toHaveBeenCalledTimes(1);
    expect(d.recordSent).not.toHaveBeenCalled();
  });

  it('a suppressed send (non-prod mail guard) is neither sent nor failed', async () => {
    const d = makeDeps({ sendEmail: jest.fn().mockResolvedValue('suppressed') });
    expect(await runZomaWeeklyReports(d)).toEqual({ checked: 1, sent: 0, failed: 0 });
    expect(d.recordSent).not.toHaveBeenCalled();
  });

  it('a sent-row write failure does not undo or repeat the send', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const d = makeDeps({ recordSent: jest.fn().mockRejectedValue(new Error('dynamo')) });
    expect(await runZomaWeeklyReports(d)).toMatchObject({ sent: 1 });
    expect(d.sendEmail).toHaveBeenCalledTimes(1);
  });

  it('one user failing does not stop the others, and the per-pass cap holds', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const d = makeDeps({
      listUsers: jest.fn().mockResolvedValue([customer('a'), customer('b'), customer('c')]),
      getUsage: jest.fn(async (id: string) => { if (id === 'a') throw new Error('boom'); return usage(); }),
      config: () => cfg({ maxPerPass: 1 }),
    });
    const r = await runZomaWeeklyReports(d);
    expect(r.sent).toBe(1); // b was claimed; the cap of 1 stops before c
    expect(d.sent.map((s) => s[0])).toEqual(['b@acme.co']);
  });

  it('the unsubscribe link in the sent email verifies back to that user', async () => {
    const d = makeDeps();
    await runZomaWeeklyReports(d);
    const link = /Stop this weekly email: (\S+)/.exec(d.sent[0][2])![1];
    expect(verifyUnsubscribeToken(decodeURIComponent(link.split('?t=')[1]), SECRET)).toBe('u1');
  });
});

describe('the production ad-totals wiring (getAdsWeeks)', () => {
  const accounts = require('../services/connectedAccountsDb');
  const range = { start: '2026-11-16T16:00:00.000Z', end: '2026-11-23T16:00:00.000Z' };
  const metaAccount = {
    platform: 'meta', account_id: '1339', account_name: 'Acme',
    config: { account_type: 'ad_account', ad_account_id: '1339', access_token: 't', token_expires_at: Date.now() + 3_600_000, granted_scopes: ['ads_read', 'ads_management'] },
  };
  const googleAccount = { platform: 'google_ads', account_id: 'g1', account_name: 'Acme G', config: { customer_id: '288-302-9950', refresh_token: 'r' } };
  const metaReport = (totals: Record<string, unknown>) => ({
    account_id: '1339', currency: 'USD', level: 'account', conversion_event: 'lead', rows: [{}], summary: 'Meta ads report for act_1339 ... (agent-facing text, must not be used)',
    totals: { spend: 0, impressions: 0, clicks: 0, ctr: null, cpc: null, conversions: 0, conversion_value: 0, roas: null, ...totals },
  });
  const googleRows = (...metrics: Array<Record<string, unknown>>) => metrics.map((m) => ({ customer: { resourceName: 'customers/2883029950', currencyCode: 'INR' }, metrics: m }));
  let queryReporting: jest.SpyInstance;
  beforeEach(() => {
    mockRunReport.mockReset();
    accounts.getAccountsByUserIdIncludingOrgShared.mockReset();
    queryReporting = jest.spyOn(googleAdsService, 'queryReporting').mockReset();
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => queryReporting.mockRestore());

  it('Meta: maps the report totals, not the agent-facing summary text', async () => {
    accounts.getAccountsByUserIdIncludingOrgShared.mockResolvedValue([metaAccount]);
    mockRunReport.mockResolvedValue(metaReport({ spend: 12.3, impressions: 1200, clicks: 40, conversions: 3, roas: 2.4 }));
    const weeks = await defaultZomaWeeklyReportDeps.getAdsWeeks('u1', range);
    expect(weeks).toEqual([{ platform: 'meta', status: 'delivered', ads: { currency: 'USD', spend: 12.3, impressions: 1200, clicks: 40, conversions: 3, roas: 2.4, conversionEvent: 'lead' } }]);
    expect(JSON.stringify(weeks)).not.toMatch(/act_|agent-facing/);
    expect(mockRunReport).toHaveBeenCalledWith(metaAccount, '1339', { level: 'account', since: '2026-11-16', until: '2026-11-23' });
    expect(queryReporting).not.toHaveBeenCalled();
  });

  it('Meta: no delivery, impressions without spend, and a failed read ("unreadable", never "no delivery")', async () => {
    accounts.getAccountsByUserIdIncludingOrgShared.mockResolvedValue([metaAccount]);
    mockRunReport.mockResolvedValueOnce(metaReport({}));
    await expect(defaultZomaWeeklyReportDeps.getAdsWeeks('u1', range)).resolves.toEqual([{ platform: 'meta', status: 'no_delivery' }]);
    mockRunReport.mockResolvedValueOnce(metaReport({ impressions: 50 }));
    await expect(defaultZomaWeeklyReportDeps.getAdsWeeks('u1', range)).resolves.toMatchObject([{ status: 'delivered', ads: { spend: 0, impressions: 50 } }]);
    mockRunReport.mockRejectedValueOnce(new Error('Meta did not return the report (code 190)'));
    await expect(defaultZomaWeeklyReportDeps.getAdsWeeks('u1', range)).resolves.toEqual([{ platform: 'meta', status: 'unreadable' }]);
  });

  it('Google Ads: exact-window GAQL, cost micros to currency units, strings to numbers', async () => {
    accounts.getAccountsByUserIdIncludingOrgShared.mockResolvedValue([googleAccount]);
    queryReporting.mockResolvedValue(googleRows({ clicks: '120', conversions: 4.5, costMicros: '950500000', impressions: '5200' }));
    const weeks = await defaultZomaWeeklyReportDeps.getAdsWeeks('u1', range);
    expect(weeks).toEqual([{ platform: 'google_ads', status: 'delivered', ads: { currency: 'INR', spend: 950.5, impressions: 5200, clicks: 120, conversions: 4.5, roas: null, conversionEvent: null } }]);
    expect(queryReporting).toHaveBeenCalledTimes(1);
    const [userId, customerId, query] = queryReporting.mock.calls[0];
    expect(userId).toBe('u1');
    expect(customerId).toBe('2883029950'); // dashes stripped
    expect(query).toContain("FROM customer WHERE segments.date BETWEEN '2026-11-16' AND '2026-11-23'");
    expect(query).toContain('metrics.cost_micros');
    expect(mockRunReport).not.toHaveBeenCalled();
  });

  it('Google Ads: several rows are summed; zero spend and zero impressions is "no delivery"; an error is "unreadable"', async () => {
    accounts.getAccountsByUserIdIncludingOrgShared.mockResolvedValue([googleAccount]);
    queryReporting.mockResolvedValueOnce(googleRows({ clicks: '1', conversions: 0, costMicros: '1000000', impressions: '10' }, { clicks: '2', conversions: 1, costMicros: '2500000', impressions: '20' }));
    await expect(defaultZomaWeeklyReportDeps.getAdsWeeks('u1', range)).resolves.toMatchObject([{ status: 'delivered', ads: { spend: 3.5, impressions: 30, clicks: 3, conversions: 1 } }]);
    queryReporting.mockResolvedValueOnce(googleRows({ clicks: '0', conversions: 0, costMicros: '0', impressions: '0' }));
    await expect(defaultZomaWeeklyReportDeps.getAdsWeeks('u1', range)).resolves.toEqual([{ platform: 'google_ads', status: 'no_delivery' }]);
    queryReporting.mockResolvedValueOnce([]);
    await expect(defaultZomaWeeklyReportDeps.getAdsWeeks('u1', range)).resolves.toEqual([{ platform: 'google_ads', status: 'no_delivery' }]);
    queryReporting.mockRejectedValueOnce(new Error('Google Ads auth expired'));
    await expect(defaultZomaWeeklyReportDeps.getAdsWeeks('u1', range)).resolves.toEqual([{ platform: 'google_ads', status: 'unreadable' }]);
  });

  it('both platforms are read independently: one failing does not hide the other', async () => {
    accounts.getAccountsByUserIdIncludingOrgShared.mockResolvedValue([metaAccount, googleAccount]);
    mockRunReport.mockRejectedValue(new Error('meta down'));
    queryReporting.mockResolvedValue(googleRows({ clicks: '5', conversions: 1, costMicros: '4000000', impressions: '100' }));
    const weeks = await defaultZomaWeeklyReportDeps.getAdsWeeks('u1', range);
    expect(weeks.map((w) => `${w.platform}:${w.status}`)).toEqual(['meta:unreadable', 'google_ads:delivered']);
  });

  it('no usable connected ad account means an empty list and no report call', async () => {
    accounts.getAccountsByUserIdIncludingOrgShared.mockResolvedValue([{ ...googleAccount, config: { customer_id: '', refresh_token: 'r' } }]);
    await expect(defaultZomaWeeklyReportDeps.getAdsWeeks('u1', range)).resolves.toEqual([]);
    accounts.getAccountsByUserIdIncludingOrgShared.mockResolvedValue([]);
    await expect(defaultZomaWeeklyReportDeps.getAdsWeeks('u1', range)).resolves.toEqual([]);
    expect(mockRunReport).not.toHaveBeenCalled();
    expect(queryReporting).not.toHaveBeenCalled();
  });
});

describe('opt-out on the user record', () => {
  beforeEach(() => { mockUpdateUser.mockReset().mockResolvedValue({}); mockGetUserByIdConsistent.mockReset(); });

  it('records the time through the injected setter, and reports true', async () => {
    const set = jest.fn().mockResolvedValue(undefined);
    await expect(recordWeeklyReportOptOut('u7', set, () => new Date('2026-11-23T16:05:00Z'))).resolves.toBe(true);
    expect(set).toHaveBeenCalledWith('u7', '2026-11-23T16:05:00.000Z');
  });
  it('an unknown or deleted user is false (nothing to stop), any other failure is thrown', async () => {
    await expect(recordWeeklyReportOptOut('gone', jest.fn().mockRejectedValue(new Error("User with ID 'gone' not found or has no email.")))).resolves.toBe(false);
    await expect(recordWeeklyReportOptOut('u7', jest.fn().mockRejectedValue(new Error('ProvisionedThroughputExceeded')))).rejects.toThrow('ProvisionedThroughputExceeded');
  });
  it('the default writes only zomaWeeklyReportOptOutAt, with a partial update of that one user', async () => {
    await expect(recordWeeklyReportOptOut('u7')).resolves.toBe(true);
    expect(mockUpdateUser).toHaveBeenCalledTimes(1);
    const [userId, updates] = mockUpdateUser.mock.calls[0];
    expect(userId).toBe('u7');
    expect(Object.keys(updates)).toEqual(['zomaWeeklyReportOptOutAt']);
    expect(new Date(updates.zomaWeeklyReportOptOutAt).toString()).not.toBe('Invalid Date');
  });
  it('the fresh read uses the consistent lookup and answers by the flag', async () => {
    mockGetUserByIdConsistent.mockResolvedValueOnce({ userId: 'u1', zomaWeeklyReportOptOutAt: '2026-11-23T16:05:00.000Z' });
    await expect(defaultZomaWeeklyReportDeps.hasOptedOut('u1')).resolves.toBe(true);
    mockGetUserByIdConsistent.mockResolvedValueOnce({ userId: 'u1' });
    await expect(defaultZomaWeeklyReportDeps.hasOptedOut('u1')).resolves.toBe(false);
    mockGetUserByIdConsistent.mockResolvedValueOnce(undefined);
    await expect(defaultZomaWeeklyReportDeps.hasOptedOut('u1')).resolves.toBe(false);
    expect(mockGetUserByIdConsistent).toHaveBeenCalledWith('u1');
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
    await expect(hasZomaFunnelRow('u7', 'weekly_report_sent', 'u7#2026-W48', store)).resolves.toBe(false);
    // A store without an exact-key read answers false instead of throwing.
    await expect(hasZomaFunnelRow('u7', 'weekly_report_claimed', 'x', { put: jest.fn(), queryByLoopId: jest.fn() } as any)).resolves.toBe(false);
    await expect(hasZomaFunnelRow('', 'weekly_report_claimed', 'x', store)).resolves.toBe(false);
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

  it('GET with a bad token is a 400 and changes nothing', async () => {
    const res = await request(app()).get('/api/zoma/weekly-report/unsubscribe').query({ t: 'nope' });
    expect(res.status).toBe(400);
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

  it('POST for a user that no longer exists still confirms and creates nothing', async () => {
    mockUpdateUser.mockRejectedValueOnce(new Error("User with ID 'route-user' not found or has no email."));
    const res = await request(app()).post('/api/zoma/weekly-report/unsubscribe').type('form').send({ t: token() });
    expect(res.status).toBe(200);
    expect(res.text).toContain('You will not get the weekly Zoma ad report any more');
  });

  it('POST with a tampered or missing token is a 400 and writes nothing', async () => {
    const bad = await request(app()).post('/api/zoma/weekly-report/unsubscribe').type('form').send({ t: `${token()}x` });
    expect(bad.status).toBe(400);
    const none = await request(app()).post('/api/zoma/weekly-report/unsubscribe').type('form').send({});
    expect(none.status).toBe(400);
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });

  it('a database failure is an error page, not a false confirmation', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    mockUpdateUser.mockRejectedValueOnce(new Error('ProvisionedThroughputExceeded'));
    const res = await request(app()).post('/api/zoma/weekly-report/unsubscribe').type('form').send({ t: token() });
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(res.text).not.toContain('You will not get the weekly Zoma ad report any more');
  });
});
