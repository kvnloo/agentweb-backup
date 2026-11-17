/**
 * ENG-3134 — Zoma redesign, end to end through the real MCP endpoint, gateway, Zoma tools, Meta
 * OAuth callback forward and Zoma browser pages. Only persistence (user row, connected
 * accounts, usage events), Meta's token exchange (metaOAuthFinalize) and Graph HTTP (fetch) are
 * faked.
 *
 * Acceptance (Harsha, 2026-11-16):
 *   1. First MCP connect: "Hey, welcome to Zoma." then ONE question about ads experience.
 *   2. The answer leads directly to the Meta connect link; Meta's callback finishes on Zoma's own
 *      pages (never the AgentWeb/Emma app), then docs + a concrete next prompt.
 *   3. Every tool response carries an actionable next step.
 *   4. Friend path: exactly "Thanks for signing up and trying out Zoma.", classified `pal`
 *      internally and excluded from potential-user counts.
 *   5. zoma_ads_report: campaign/date-range spend, impressions, clicks, CTR, CPC, conversions,
 *      ROAS from the connected account; discoverable in tools/list.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'eng-3134-test-secret';
process.env.BACKEND_URL = 'https://api.agentweb.pro';
process.env.CUSTOMER_FRONTEND_URL = 'https://app.agentweb.pro';
delete process.env.ZOMA_REQUIRE_PAYMENT_METHOD;
delete process.env.ZOMA_GOOGLE_ENABLED;

const users = new Map<string, Record<string, any>>();
let accounts: any[] = [];
const finalizeMetaOAuth = jest.fn();
const connectMetaAdAccounts = jest.fn();

jest.mock('../utils/secretsManager', () => ({
  getMetaCredentials: jest.fn().mockResolvedValue({ clientId: 'meta-app-id' }),
  getInstagramCredentials: jest.fn(),
}));
jest.mock('../services/db', () => ({
  userDb: {
    getUserById: jest.fn(async (id: string) => users.get(id) ?? null),
    updateUser: jest.fn(async (id: string, patch: Record<string, unknown>) => { users.set(id, { ...users.get(id), ...patch }); }),
  },
}));
jest.mock('../services/connectedAccountsDb', () => ({
  getAccountsByUserIdIncludingOrgShared: jest.fn(async () => accounts),
  createAccount: jest.fn(),
}));
jest.mock('../services/stripeService', () => ({ stripeService: {} }));
jest.mock('../mcp/oauth/oauthService', () => ({
  mcpOAuthService: {
    validateAccessToken: jest.fn(async (t: string) => (t === 'oauth-good' ? { userId: 'u1', clientId: 'claude-code' } : null)),
    getClient: jest.fn(async () => ({ redirectUris: ['http://localhost:33418/callback'] })),
  },
}));
jest.mock('../services/mcpUsageEventsService', () => ({
  recordMcpToolUse: jest.fn().mockResolvedValue(undefined),
  recordMcpWriteExecuted: jest.fn().mockResolvedValue(undefined),
  getMcpUserUsage: jest.fn(),
  EMMA_MCP_LOOP_ID: 'emma-mcp',
  EVT_MCP_WRITE_EXECUTED: 'mcp_write_executed',
}));
jest.mock('../services/journeyMilestones', () => ({ noteProductUse: jest.fn(), noteSignup: jest.fn(), zomaMilestone: jest.fn() }));
jest.mock('../services/journeyTracking', () => ({ aliasJourney: jest.fn(), anonymousSetupId: (id: string) => id, trackJourney: jest.fn() }));
jest.mock('../services/metaOAuthFinalize', () => ({
  finalizeMetaOAuth: (...a: unknown[]) => finalizeMetaOAuth(...a),
  connectMetaAdAccounts: (...a: unknown[]) => connectMetaAdAccounts(...a),
  META_PRECONNECT_INSTRUCTIONS: '',
  MetaTokenSessionError: class extends Error {},
  retrieveTokenSession: jest.fn(),
  safeAutoResolve: jest.fn(),
}));

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import metaToolkitRoutes from '../routes/metaToolkit';
import metaAuthRoutes from '../routes/metaAuth';
import zomaRoutes from '../routes/zoma';
import { buildZomaScoreboard } from '../services/zomaScoreboard';

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/api/meta-toolkit', metaToolkitRoutes);
app.use('/api/oauth/meta', metaAuthRoutes);
app.use('/api/zoma', zomaRoutes);

const AUTH = 'Bearer oauth-good';
const EMMA_APP = 'app.agentweb.pro';
const WELCOME = 'Hey, welcome to Zoma.';
const FRIEND = 'Thanks for signing up and trying out Zoma.';
const metaAccount = {
  platform: 'meta',
  account_id: 'act_111',
  account_name: 'Phoenix Shop',
  config: { account_type: 'ad_account', access_token: 'EAAG-secret-token', ad_account_id: '111', currency: 'USD', granted_scopes: ['ads_management'] },
};

let rpcId = 0;
const rpc = (method: string, params: Record<string, unknown> = {}, auth = AUTH) =>
  request(app).post('/api/meta-toolkit/mcp').set('Authorization', auth).send({ jsonrpc: '2.0', id: ++rpcId, method, params });
const call = (name: string, args: Record<string, unknown> = {}) => rpc('tools/call', { name, arguments: args });
const texts = (res: request.Response): string[] => res.body.result.content.map((c: any) => c.text);

const fetchMock = jest.fn();
beforeEach(() => {
  users.clear();
  users.set('u1', { userId: 'u1', email: 'nikhil@gmail.com' });
  accounts = [];
  finalizeMetaOAuth.mockReset();
  connectMetaAdAccounts.mockReset().mockImplementation(async () => { accounts = [metaAccount]; });
  fetchMock.mockReset();
  (global as any).fetch = fetchMock;
});

const graphJson = (body: unknown, ok = true, status = 200) => ({ ok, status, json: async () => body });

describe('ENG-3134 first connect: welcome -> one question -> Meta connect -> docs + next prompt', () => {
  it('initialize tells the agent to open with the welcome and the one question', async () => {
    const res = await rpc('initialize', { protocolVersion: '2025-06-18' }).expect(200);
    expect(res.body.result.instructions.startsWith(WELCOME)).toBe(true);
    expect(res.body.result.instructions).toContain('How familiar are you with ads?');
    expect(res.body.result.serverInfo.title).toBe('Zoma');
  });

  it('runs the whole journey on Zoma surfaces, never the Emma app', async () => {
    // 1. First call: welcome + the one question, nothing else (no checklist, no links).
    const first = await call('zoma_status').expect(200);
    const firstSummary = JSON.parse(texts(first)[0]).summary as string;
    expect(firstSummary.startsWith(`${WELCOME}\n`)).toBe(true);
    expect(firstSummary).toContain('How familiar are you with ads?');
    expect(firstSummary).not.toContain('[ ]');
    expect(firstSummary).not.toMatch(/https?:\/\//);

    // 2. The answer is stored and leads straight to the Meta connect link.
    const answered = await call('zoma_status', { ads_experience: 'runs_ads' }).expect(200);
    const body = JSON.parse(texts(answered)[0]);
    expect(users.get('u1')!.zomaAdsExperience).toBe('runs_ads');
    expect(body.next_step.startsWith('Connect Meta')).toBe(true);
    const link = new URL(body.meta.link);
    expect(link.hostname).toBe('www.facebook.com');
    expect(link.searchParams.get('redirect_uri')).toBe('https://api.agentweb.pro/api/oauth/meta/callback');
    const state = link.searchParams.get('state')!;
    expect(jwt.verify(state, process.env.JWT_SECRET!)).toMatchObject({ userId: 'u1', zoma: 'mcp', flow: 'marketing' });
    expect(texts(answered).join('\n')).not.toContain(EMMA_APP);

    // 3. Meta's callback is forwarded to Zoma's page and finished server-side for this user.
    finalizeMetaOAuth.mockResolvedValue({
      flow: 'marketing', tokenSessionId: 'ts-1', preconnectInstructions: '',
      adAccounts: [{ account_id: '111', name: 'Phoenix Shop', currency: 'USD', account_status: 1 }],
    });
    const cb = await request(app).get('/api/oauth/meta/callback').query({ code: 'meta-code', state }).expect(302);
    expect(cb.headers.location.startsWith('/api/zoma/meta/callback?')).toBe(true);
    const page = await request(app).get(cb.headers.location).expect(200);
    expect(finalizeMetaOAuth).toHaveBeenCalledWith({ userId: 'u1', code: 'meta-code', flow: 'marketing' });
    expect(connectMetaAdAccounts).toHaveBeenCalledWith({ userId: 'u1', adAccounts: [expect.objectContaining({ account_id: '111' })], tokenSessionId: 'ts-1' });
    expect(page.text).toContain('Meta connected');
    expect(page.text).toContain('Check my Zoma setup');
    expect(page.text).not.toContain(EMMA_APP);

    // 4. Connected: docs link + a concrete next prompt that names the reporting tool.
    const done = await call('zoma_status').expect(200);
    const summary = JSON.parse(texts(done)[0]).summary as string;
    expect(summary).toContain('All set.');
    expect(summary).toContain('Docs: https://api.agentweb.pro/api/meta-toolkit/skill.md');
    expect(summary).toContain('Try asking: "Show my Meta ad spend, impressions, clicks, CTR, CPC, conversions and ROAS by campaign for the last 7 days."');
    expect(summary).toContain('zoma_ads_report');
  });

  it('new_to_ads also leads with the Meta link; the setup guide follows it', async () => {
    const res = await call('zoma_status', { ads_experience: 'new_to_ads' }).expect(200);
    const next = JSON.parse(texts(res)[0]).next_step as string;
    expect(next.indexOf('facebook.com')).toBeLessThan(next.indexOf('Business portfolio'));
    expect(next).not.toContain(EMMA_APP);
  });

  it('Meta with several ad accounts: Zoma picker for this user, then back to the agent', async () => {
    const answered = await call('zoma_status', { ads_experience: 'runs_ads' });
    const state = new URL(JSON.parse(texts(answered)[0]).meta.link).searchParams.get('state')!;
    finalizeMetaOAuth.mockResolvedValue({
      flow: 'marketing', tokenSessionId: 'ts-2', preconnectInstructions: '',
      adAccounts: [
        { account_id: '111', name: 'Phoenix Shop', currency: 'USD', account_status: 1 },
        { account_id: '222', name: 'Side Project', currency: 'EUR', account_status: 1 },
      ],
    });
    const picker = await request(app).get('/api/zoma/meta/callback').query({ code: 'c', state }).expect(200);
    expect(picker.text).toContain('Choose your ad account');
    const token = /name="t" value="([^"]+)"/.exec(picker.text)![1];
    const chose = await request(app).post('/api/zoma/meta/select').type('form').send({ t: token, account_id: '222' }).expect(200);
    expect(connectMetaAdAccounts).toHaveBeenCalledWith({ userId: 'u1', adAccounts: [expect.objectContaining({ account_id: '222' })], tokenSessionId: 'ts-2' });
    expect(chose.text).toContain('Meta connected');
  });

  it('Meta with no ad account: the setup guide and a fresh Reconnect link, no Emma detour', async () => {
    const answered = await call('zoma_status', { ads_experience: 'new_to_ads' });
    const state = new URL(JSON.parse(texts(answered)[0]).meta.link).searchParams.get('state')!;
    finalizeMetaOAuth.mockResolvedValue({ flow: 'marketing', tokenSessionId: 'ts-3', preconnectInstructions: '', adAccounts: [] });
    const res = await request(app).get('/api/zoma/meta/callback').query({ code: 'c', state }).expect(400);
    expect(res.text).toContain('No ad account found');
    expect(res.text).toContain('business.facebook.com/overview');
    expect(res.text).toContain('Reconnect Meta');
    expect(res.text).not.toContain(EMMA_APP);
    expect(connectMetaAdAccounts).not.toHaveBeenCalled();
  });

  it('a forged or expired state never connects anything', async () => {
    const forged = jwt.sign({ userId: 'u1', zoma: 'mcp', flow: 'marketing' }, 'not-the-secret');
    const res = await request(app).get('/api/zoma/meta/callback').query({ code: 'c', state: forged }).expect(400);
    expect(res.text).toContain('invalid or has expired');
    expect(finalizeMetaOAuth).not.toHaveBeenCalled();
  });

  it('a card added from zoma_status returns to a Zoma page', async () => {
    const res = await request(app).get('/api/zoma/done').query({ mcp: '1' }).expect(200);
    expect(res.text).toContain('Payment method added');
    expect(res.text).toContain('Check my Zoma setup');
  });
});

describe('ENG-3134 friend path', () => {
  it('is exactly the thank-you, with nothing appended', async () => {
    const res = await call('zoma_status', { ads_experience: 'not_interested' }).expect(200);
    expect(texts(res)).toEqual([FRIEND]);
    expect(users.get('u1')!.zomaAdsExperience).toBe('not_interested');
    // Asking again later is the same one sentence.
    expect(texts(await call('zoma_status').expect(200))).toEqual([FRIEND]);
  });

  it('is classified pal in the lead list and excluded from potential-user counts', async () => {
    const board = await buildZomaScoreboard({
      listZomaUsers: async () => [
        { userId: 'u1', email: 'nikhil@gmail.com', zomaAdsExperience: 'not_interested' },
        { userId: 'u2', email: 'owner@shop.co', zomaAdsExperience: 'runs_ads' },
      ],
      getUser: async () => undefined,
      listWriteEvents: async () => [],
      now: () => Date.parse('2026-11-16T12:00:00Z'),
    });
    expect(board.rows.find((r) => r.userId === 'u1')).toMatchObject({ excluded: 'pal', active7d: false });
    expect(board.summary).toMatchObject({ zomaUsers: 1, palUsers: 1, excludedAccounts: 1 });
  });
});

describe('ENG-3134 every tool response has an actionable next step', () => {
  it('a read, a refusal and a missing-account call each end with "Next step:"', async () => {
    accounts = [metaAccount];
    fetchMock.mockResolvedValue(graphJson({ data: [] }));
    const read = await call('zoma_ads_report').expect(200);
    expect(texts(read)[1]).toMatch(/^Next step: \S/);

    const refused = await call('zoma_ads_report', { since: '2026-11-10' }).expect(200);
    expect(refused.body.result.isError).toBe(true);
    expect(texts(refused)[1]).toMatch(/^Next step: \S/);

    accounts = [];
    const missing = await call('zoma_ads_report').expect(403);
    expect(missing.body.error.message).toMatch(/No usable Meta ad account.*Next step: .*zoma_status/);
  });

  it('shared Meta refusals never point at the Emma settings screen', async () => {
    accounts = [{ ...metaAccount, config: { ...metaAccount.config, has_meta_pages: false, meta_page_count: 0 } }];
    users.set('u1', { userId: 'u1', email: 'nikhil@gmail.com', zomaAdsExperience: 'runs_ads' });
    const res = await call('zoma_status').expect(200);
    const all = texts(res).join('\n');
    expect(all).toContain('Facebook Page');
    expect(all).not.toMatch(/Settings -> ?Connected accounts/);
    expect(all).toContain('fresh Zoma connect link');
  });
});

describe('ENG-3134 zoma_ads_report', () => {
  it('is discoverable in tools/list as a read-only tool', async () => {
    const res = await rpc('tools/list').expect(200);
    const tool = res.body.result.tools.find((t: any) => t.name === 'zoma_ads_report');
    expect(tool).toBeDefined();
    expect(tool.description).toMatch(/spend, impressions, clicks, CTR, CPC, conversions and ROAS/);
    expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
  });

  it('reports per campaign for a date range from the connected account, with computed metrics and totals', async () => {
    accounts = [metaAccount];
    fetchMock
      .mockResolvedValueOnce(graphJson({
        data: [{
          campaign_id: '9001', campaign_name: 'Spring Sale', spend: '120.50', impressions: '10000', clicks: '250', account_currency: 'USD',
          actions: [{ action_type: 'link_click', value: '250' }, { action_type: 'omni_purchase', value: '6' }, { action_type: 'purchase', value: '6' }],
          action_values: [{ action_type: 'omni_purchase', value: '480.00' }],
        }],
        paging: { next: 'https://graph.facebook.com/v25.0/act_111/insights?after=abc&access_token=EAAG-secret-token' },
      }))
      .mockResolvedValueOnce(graphJson({
        data: [{ campaign_id: '9002', campaign_name: 'Retargeting', spend: '30', impressions: '2000', clicks: '0', account_currency: 'USD', actions: [] }],
      }));
    const res = await call('zoma_ads_report', { since: '2026-11-01', until: '2026-11-15' }).expect(200);
    const [json, next] = texts(res);
    const report = JSON.parse(json);

    const firstUrl = new URL(fetchMock.mock.calls[0][0]);
    expect(firstUrl.pathname).toBe('/v25.0/act_111/insights');
    expect(firstUrl.searchParams.get('level')).toBe('campaign');
    expect(JSON.parse(firstUrl.searchParams.get('time_range')!)).toEqual({ since: '2026-11-01', until: '2026-11-15' });
    expect(firstUrl.searchParams.get('access_token')).toBe('EAAG-secret-token');
    expect(fetchMock).toHaveBeenCalledTimes(2);

    expect(report).toMatchObject({ account_id: '111', currency: 'USD', date_range: { since: '2026-11-01', until: '2026-11-15' }, conversion_event: 'omni_purchase' });
    expect(report.rows[0]).toEqual({
      campaign_id: '9001', campaign_name: 'Spring Sale', spend: 120.5, impressions: 10000, clicks: 250,
      ctr: 2.5, cpc: 0.48, conversions: 6, conversion_value: 480, roas: 3.98,
    });
    expect(report.rows[1]).toMatchObject({ campaign_id: '9002', ctr: 0, cpc: null, conversions: 0, roas: null });
    expect(report.totals).toEqual({ spend: 150.5, impressions: 12000, clicks: 250, ctr: 2.08, cpc: 0.6, conversions: 6, conversion_value: 480, roas: 3.19 });
    expect(report.summary).toContain('Spring Sale');
    expect(json).not.toContain('EAAG-secret-token');
    expect(next).toMatch(/^Next step: /);
  });

  it('narrows to campaign_ids and a preset, and refuses bad input before calling Meta', async () => {
    accounts = [metaAccount];
    fetchMock.mockResolvedValue(graphJson({ data: [] }));
    await call('zoma_ads_report', { date_preset: 'last_30d', campaign_ids: ['9001'] }).expect(200);
    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.searchParams.get('date_preset')).toBe('last_30d');
    expect(JSON.parse(url.searchParams.get('filtering')!)).toEqual([{ field: 'campaign.id', operator: 'IN', value: ['9001'] }]);

    fetchMock.mockClear();
    for (const bad of [{ date_preset: 'forever' }, { since: '2026-11-15', until: '2026-11-01' }, { campaign_ids: ['abc'] }, { level: 'ad' }]) {
      const res = await call('zoma_ads_report', bad).expect(200);
      expect(res.body.result.isError).toBe(true);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('ROAS stays purchase value / spend even when conversions count leads', async () => {
    accounts = [metaAccount];
    fetchMock.mockResolvedValue(graphJson({ data: [{
      campaign_id: '1', campaign_name: 'Leads', spend: '100', impressions: '1000', clicks: '10',
      actions: [{ action_type: 'lead', value: '4' }, { action_type: 'purchase', value: '1' }],
      action_values: [{ action_type: 'lead', value: '999' }, { action_type: 'purchase', value: '250' }],
    }] }));
    const report = JSON.parse(texts(await call('zoma_ads_report', { conversion_event: 'lead' }).expect(200))[0]);
    expect(report.rows[0]).toMatchObject({ conversions: 4, conversion_value: 250, roas: 2.5 });
  });

  it('a report too large for the page cap is refused, never returned as partial totals', async () => {
    accounts = [metaAccount];
    fetchMock.mockResolvedValue(graphJson({ data: [{ campaign_id: '1', spend: '1', impressions: '1', clicks: '0' }], paging: { next: 'https://graph.facebook.com/next' } }));
    const res = await call('zoma_ads_report').expect(200);
    expect(res.body.result.isError).toBe(true);
    expect(texts(res)[0]).toMatch(/Narrow it/);
    expect(fetchMock).toHaveBeenCalledTimes(10);
  });

  it('an unreadable or data-less Meta response is a read failure, not an empty report', async () => {
    accounts = [metaAccount];
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad'); } });
    expect((await call('zoma_ads_report').expect(200)).body.result.isError).toBe(true);
    fetchMock.mockResolvedValueOnce(graphJson({ something: 'else' }));
    expect((await call('zoma_ads_report').expect(200)).body.result.isError).toBe(true);
  });

  it('an expired Meta token is a clear reconnect instruction, not a crash', async () => {
    accounts = [metaAccount];
    fetchMock.mockResolvedValue(graphJson({ error: { message: 'Error validating access token', code: 190 } }, false, 400));
    const res = await call('zoma_ads_report').expect(200);
    expect(res.body.result.isError).toBe(true);
    expect(texts(res)[0]).toMatch(/expired or was revoked.*zoma_status/);
  });
});
