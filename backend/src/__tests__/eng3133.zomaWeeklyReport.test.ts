/**
 * ENG-3133 — the weekly Zoma ad-performance email.
 * Pure rules, the job with injected dependencies, the opt-out row, and the unsubscribe routes.
 * Mock-only: no Stripe, Dynamo or mail; the live proof is the env1 run described in the PR.
 */
jest.mock('../services/connectedAccountsDb', () => ({
  createAccount: jest.fn().mockResolvedValue({}),
  getAccountsByUserId: jest.fn().mockResolvedValue([]),
  getAccountsByUserIdIncludingOrgShared: jest.fn().mockResolvedValue([]),
}));
jest.mock('../services/journeyMilestones', () => ({ zomaMilestone: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../services/db', () => ({ userDb: { getUserById: jest.fn() } }));
jest.mock('../services/stripeService', () => ({ stripeService: {} }));
jest.mock('../middleware/auth', () => ({ authenticateToken: (_q: any, _r: any, n: any) => n() }));
const mockRecordFunnel = jest.fn().mockResolvedValue(true);
jest.mock('../services/mcpUsageEventsService', () => ({
  ...jest.requireActual('../services/mcpUsageEventsService'),
  recordZomaBillingFunnel: (...a: any[]) => mockRecordFunnel(...a),
}));

import express from 'express';
import request from 'supertest';
import { createZomaRouter } from '../routes/zoma';
import {
  getZomaWeeklyReportConfig,
  hasSomethingToReport,
  inSendWindow,
  isReportRecipient,
  isoWeekKey,
  recordWeeklyReportOptOut,
  runZomaWeeklyReports,
  signUnsubscribeToken,
  verifyUnsubscribeToken,
  weeklyReportEmail,
  zomaUnsubscribeUrl,
  type ZomaWeeklyReportConfig,
  type ZomaWeeklyReportDeps,
} from '../mcp/zomaWeeklyReport';
import { hasZomaFunnelRow, type McpUsageEventStore, type McpUserUsage } from '../services/mcpUsageEventsService';

// The module above mocks recordZomaBillingFunnel (for the route tests); the store test needs the real one.
const realRecordFunnel: typeof import('../services/mcpUsageEventsService').recordZomaBillingFunnel =
  jest.requireActual('../services/mcpUsageEventsService').recordZomaBillingFunnel;

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
    { ts: '2026-11-20T09:00:00.000Z', platform: 'meta', entityType: 'AD_SET', action: 'CREATE', verification: 'CONFIRMED', objectId: '120000222' },
  ],
  ...over,
});

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
    getAdsSummary: jest.fn().mockResolvedValue('Spent $120.50 on 14,000 impressions, 310 clicks, 22 conversions.'),
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

  it.each([
    [{ toolCalls: 0, writes: { total: 0, confirmed: 0, mismatch: 0, unconfirmed: 0 } }, 'Spent $5', false],
    [{ toolCalls: 3, writes: { total: 0, confirmed: 0, mismatch: 0, unconfirmed: 0 } }, undefined, false],
    [{ toolCalls: 3, writes: { total: 0, confirmed: 0, mismatch: 0, unconfirmed: 0 } }, 'Spent $5', true],
    [{ toolCalls: 3, writes: { total: 1, confirmed: 1, mismatch: 0, unconfirmed: 0 } }, undefined, true],
    [{ toolCalls: 3, writes: { total: 1, confirmed: 0, mismatch: 1, unconfirmed: 0 } }, undefined, false],
  ])('has something to report: %j / %s -> %s', (u, summary, expected) => {
    expect(hasSomethingToReport(u as any, summary as any)).toBe(expected);
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
  it('shows performance, the confirmed changes, the call count and the unsubscribe link', () => {
    const e = weeklyReportEmail({ usage: usage(), adsSummary: 'Spent $120.50 on 14,000 impressions.', range, unsubscribeUrl: 'https://api.test/u?t=abc' });
    expect(e.subject).toBe('Your Zoma week in ads');
    expect(e.text).toContain('2026-11-16 to 2026-11-23');
    expect(e.text).toContain('Spent $120.50 on 14,000 impressions.');
    expect(e.text).toContain('Zoma made 2 confirmed changes to your ads this week.');
    expect(e.text).toContain('- 2026-11-20: create ad set');
    expect(e.text).toContain('- 2026-11-18: update campaign');
    expect(e.text).toContain('Your agent made 12 successful Zoma calls this week.');
    expect(e.text).toContain('Stop this weekly email: https://api.test/u?t=abc');
    expect(e.html).toContain('href="https://api.test/u?t=abc"');
    expect(e.html).toContain('support@agentweb.pro');
  });
  it('never includes object ids, and escapes the summary and url in the HTML', () => {
    const e = weeklyReportEmail({ usage: usage(), adsSummary: '<script>alert(1)</script> & more', range, unsubscribeUrl: 'https://api.test/u?t="x"&y=1' });
    expect(e.text + e.html).not.toMatch(/120000111|120000222/);
    expect(e.html).not.toContain('<script>');
    expect(e.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; more');
    expect(e.html).toContain('t=&quot;x&quot;&amp;y=1');
  });
  it('handles no delivery, one change, and only confirmed changes are listed', () => {
    const e = weeklyReportEmail({
      usage: usage({ toolCalls: 1, writes: { total: 3, confirmed: 1, mismatch: 1, unconfirmed: 1 }, recentWrites: [
        { ts: '2026-11-19T10:00:00.000Z', entityType: 'AD', action: 'UPDATE', verification: 'MISMATCH' },
        { ts: '2026-11-20T10:00:00.000Z', entityType: 'AD', action: 'PAUSE', verification: 'CONFIRMED' },
      ] }),
      adsSummary: undefined, range, unsubscribeUrl: 'u',
    });
    expect(e.text).toContain('No ad delivery was recorded on your connected Meta ad account this week.');
    expect(e.text).toContain('Zoma made 1 confirmed change to your ads this week.');
    expect(e.text).toContain('- 2026-11-20: pause ad');
    expect(e.text).not.toContain('2026-11-19');
    expect(e.text).toContain('Your agent made 1 successful Zoma call this week.');
  });
  it('says so when Zoma changed nothing', () => {
    const e = weeklyReportEmail({ usage: usage({ writes: { total: 0, confirmed: 0, mismatch: 0, unconfirmed: 0 }, recentWrites: [] }), adsSummary: 'Spent $5.', range, unsubscribeUrl: 'u' });
    expect(e.text).toContain('Zoma made no changes to your ads this week.');
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
    expect(d.recordSent).toHaveBeenCalledWith('u1', '2026-W48');
    const claimOrder = (d.claim as jest.Mock).mock.invocationCallOrder[0];
    expect(claimOrder).toBeLessThan((d.sendEmail as jest.Mock).mock.invocationCallOrder[0]);
    // The ads window is the last 7 days ending now.
    expect(d.getUsage).toHaveBeenCalledWith('u1', { start: '2026-11-16T16:00:00.000Z', end: '2026-11-23T16:00:00.000Z' });
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

  it('skips opted-out users, internal/test accounts, pal leads, users with no calls and users with nothing to report', async () => {
    const users = [
      customer('opted'), customer('internal', { email: 'a@agentweb.pro' }), customer('admin', { isAdmin: true }),
      customer('pal', { zomaAdsExperience: 'not_interested' }), customer('quiet'), customer('empty'), customer('noemail', { email: '' }),
    ];
    const getUsage = jest.fn(async (id: string) => id === 'quiet'
      ? usage({ toolCalls: 0 })
      : id === 'empty' ? usage({ writes: { total: 0, confirmed: 0, mismatch: 0, unconfirmed: 0 } }) : usage());
    const d = makeDeps({
      listUsers: jest.fn().mockResolvedValue(users),
      hasOptedOut: jest.fn(async (id: string) => id === 'opted'),
      getUsage,
      getAdsSummary: jest.fn(async (id: string) => (id === 'empty' ? undefined : 'Spent $5.')),
    });
    const r = await runZomaWeeklyReports(d);
    expect(r.sent).toBe(0);
    expect(d.sendEmail).not.toHaveBeenCalled();
    expect(d.claim).not.toHaveBeenCalled();
  });

  it('an ads-summary failure falls back to the confirmed changes; with none, the user is skipped', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const withWrites = makeDeps({ getAdsSummary: jest.fn().mockRejectedValue(new Error('meta down')) });
    expect(await runZomaWeeklyReports(withWrites)).toMatchObject({ sent: 1 });
    expect(withWrites.sent[0][2]).toContain('No ad delivery was recorded');
    const noWrites = makeDeps({
      getAdsSummary: jest.fn().mockRejectedValue(new Error('meta down')),
      getUsage: jest.fn().mockResolvedValue(usage({ writes: { total: 0, confirmed: 0, mismatch: 0, unconfirmed: 0 } })),
    });
    expect(await runZomaWeeklyReports(noWrites)).toMatchObject({ sent: 0 });
    expect(noWrites.claim).not.toHaveBeenCalled();
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
    const users = [customer('a'), customer('b'), customer('c')];
    const d = makeDeps({
      listUsers: jest.fn().mockResolvedValue(users),
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

describe('opt-out row', () => {
  it('writes one funnel row keyed by the user, so a repeat click is a no-op', async () => {
    const record = jest.fn().mockResolvedValue(true);
    await recordWeeklyReportOptOut('u7', record);
    expect(record).toHaveBeenCalledWith({ userId: 'u7', step: 'weekly_report_opt_out', dedupeKey: 'u7' });
  });

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
    await expect(hasZomaFunnelRow('u7', 'weekly_report_opt_out', 'u7', store)).resolves.toBe(false);
    await expect(realRecordFunnel({ userId: 'u7', step: 'weekly_report_opt_out', dedupeKey: 'u7' }, store)).resolves.toBe(true);
    await expect(hasZomaFunnelRow('u7', 'weekly_report_opt_out', 'u7', store)).resolves.toBe(true);
    await expect(realRecordFunnel({ userId: 'u7', step: 'weekly_report_opt_out', dedupeKey: 'u7' }, store)).resolves.toBe(false);
    await expect(hasZomaFunnelRow('u8', 'weekly_report_opt_out', 'u8', store)).resolves.toBe(false);
    await expect(hasZomaFunnelRow('u7', 'weekly_report_claimed', 'u7', store)).resolves.toBe(false);
    // A store without an exact-key read answers false instead of throwing.
    await expect(hasZomaFunnelRow('u7', 'weekly_report_opt_out', 'u7', { put: jest.fn(), queryByLoopId: jest.fn() } as any)).resolves.toBe(false);
    await expect(hasZomaFunnelRow('', 'weekly_report_opt_out', 'x', store)).resolves.toBe(false);
  });
});

describe('unsubscribe routes', () => {
  const app = () => express().use(express.urlencoded({ extended: false })).use('/api/zoma', createZomaRouter());
  const token = () => signUnsubscribeToken('route-user');
  beforeEach(() => mockRecordFunnel.mockClear());

  it('GET shows a confirm button and changes nothing', async () => {
    const res = await request(app()).get('/api/zoma/weekly-report/unsubscribe').query({ t: token() });
    expect(res.status).toBe(200);
    expect(res.text).toContain('<form method="post" action="/api/zoma/weekly-report/unsubscribe">');
    expect(mockRecordFunnel).not.toHaveBeenCalled();
  });

  it('GET with a bad token is a 400 and changes nothing', async () => {
    const res = await request(app()).get('/api/zoma/weekly-report/unsubscribe').query({ t: 'nope' });
    expect(res.status).toBe(400);
    expect(mockRecordFunnel).not.toHaveBeenCalled();
  });

  it('POST with a valid token records the opt-out once and confirms', async () => {
    const res = await request(app()).post('/api/zoma/weekly-report/unsubscribe').type('form').send({ t: token() });
    expect(res.status).toBe(200);
    expect(res.text).toContain('You will not get the weekly Zoma ad report any more');
    expect(mockRecordFunnel).toHaveBeenCalledTimes(1);
    expect(mockRecordFunnel).toHaveBeenCalledWith({ userId: 'route-user', step: 'weekly_report_opt_out', dedupeKey: 'route-user' });
  });

  it('POST with a tampered or missing token is a 400 and records nothing', async () => {
    const bad = await request(app()).post('/api/zoma/weekly-report/unsubscribe').type('form').send({ t: `${token()}x` });
    expect(bad.status).toBe(400);
    const none = await request(app()).post('/api/zoma/weekly-report/unsubscribe').type('form').send({});
    expect(none.status).toBe(400);
    expect(mockRecordFunnel).not.toHaveBeenCalled();
  });
});
