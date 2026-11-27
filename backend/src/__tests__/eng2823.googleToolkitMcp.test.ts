process.env.ZOMA_REQUIRE_PAYMENT_METHOD = 'true';
/**
 * ENG-2823 hardening — the Google Ads toolkit end to end over MCP JSON-RPC.
 *
 * Real router (routes/metaToolkit) → real gateway → real Google toolkit → the Emma
 * call_google_ads_api handler → real googleAdsService. Google is faked only at the HTTP
 * boundary (axios), plus the AWS-backed seams (API key, accounts, secrets, user, Stripe,
 * usage events). Nothing at the toolkit layer is mocked.
 */
import request from 'supertest';
import express from 'express';

jest.mock('../services/agentModeService', () => ({ agentModeService: {} }));
jest.mock('../utils/scheduledPublishConsentGuard', () => ({
  refuseUnauthorizedScheduledPublish: jest.fn().mockResolvedValue(null),
  attachPublishRevalidation: (_: unknown, context: unknown) => context,
}));
jest.mock('../services/evaluationPolicy', () => ({ enforceEvaluationTool: jest.fn().mockResolvedValue(undefined) }));

const mockPost = jest.fn();
const mockGet = jest.fn();
jest.mock('axios', () => {
  const interceptors = { request: { use: jest.fn(), eject: jest.fn() }, response: { use: jest.fn(), eject: jest.fn() } };
  const instance: any = { post: (...a: any[]) => mockPost(...a), get: (...a: any[]) => mockGet(...a), interceptors, defaults: { headers: { common: {} } } };
  return { __esModule: true, default: { ...instance, create: () => instance, isAxiosError: () => false }, ...instance };
});

const mockAccounts = jest.fn();
jest.mock('../services/connectedAccountsDb', () => ({
  ...jest.requireActual('../services/connectedAccountsDb'),
  getAccountsByUserIdIncludingOrgShared: (...a: any[]) => mockAccounts(...a),
  getAccountsWithOwnerIncludingOrgShared: (...a: any[]) => mockAccounts(...a),
  updateAccountTokens: jest.fn(),
}));
jest.mock('../utils/secretsManager', () => ({
  ...jest.requireActual('../utils/secretsManager'),
  getGoogleAdsCredentials: jest.fn().mockResolvedValue({ clientId: 'c', clientSecret: 's', developerToken: 'dev-token' }),
}));
jest.mock('../services/agentApiKeyService', () => ({
  agentApiKeyService: { validateKey: jest.fn(async (raw: string) => (raw === 'aw_u1' ? { userId: 'u1', keyId: 'k1' } : raw === 'aw_u2' ? { userId: 'u2', keyId: 'k2' } : null)) },
}));
const mockRecordUse = jest.fn().mockResolvedValue(true);
const mockRecordWrite = jest.fn().mockResolvedValue(true);
jest.mock('../services/mcpUsageEventsService', () => ({
  recordMcpToolUse: (...a: any[]) => mockRecordUse(...a),
  recordMcpWriteExecuted: (...a: any[]) => mockRecordWrite(...a),
  getMcpUserUsage: jest.fn(),
}));
jest.mock('../services/db', () => ({
  ...jest.requireActual('../services/db'),
  userDb: { getUserById: jest.fn(async (id: string) => ({ userId: id, email: `${id}@example.com` })) },
}));
jest.mock('../services/stripeService', () => ({
  stripeService: { resolveUserPaymentMethod: jest.fn().mockResolvedValue({ hasPaymentMethod: true }) },
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const router = require('../routes/metaToolkit').default;

const app = express();
app.use(express.json());
app.use('/api/meta-toolkit', router);

const CID = '1234567890';
const MANAGER = '9990001112';
const BUDGET = `customers/${CID}/campaignBudgets/55`;

// ── Fake Google Ads REST API (the HTTP boundary) ──────────────────────────────
let budgets: Record<string, { name: string; amountMicros: string; explicitlyShared: boolean; referenceCount: string; status: string }>;
const mutates = () => mockPost.mock.calls.filter(([url]) => String(url).includes(':mutate'));

function fakeGoogle(url: string, body: any) {
  if (!url.startsWith('https://googleads.googleapis.com/')) throw new Error(`unexpected URL ${url}`);
  if (url.endsWith(`/customers/${CID}/googleAds:search`)) {
    const q: string = body.query;
    if (!/FROM campaign_budget/.test(q)) return { data: { results: [] } };
    const only = q.match(/campaign_budget\.resource_name = '([^']+)'/)?.[1];
    const rows = Object.entries(budgets)
      .filter(([rn]) => !only || rn === only)
      .map(([resourceName, b]) => ({ campaignBudget: { resourceName, ...b } }));
    return { data: { results: rows, totalResultsCount: String(rows.length) } };
  }
  if (url.endsWith(`/customers/${CID}/campaignBudgets:mutate`)) {
    const op = body.operations[0];
    if (op.update) budgets[op.update.resourceName].amountMicros = String(op.update.amountMicros);
    return { data: { results: [{ resourceName: op.update?.resourceName }] } };
  }
  throw new Error(`fake Google: unhandled ${url}`);
}

const googleAccount = (over: Record<string, unknown> = {}) => ({
  platform: 'google_ads', account_id: CID, account_name: 'Acme Search', userId: 'u1',
  config: {
    customer_id: CID, login_customer_id: MANAGER, currency: 'USD',
    access_token: 'live-access', refresh_token: 'r', token_expires_at: Date.now() + 3600_000, ...over,
  },
});

let nextId = 1;
const rpc = (method: string, params: any = {}, key = 'aw_u1') =>
  request(app).post('/api/meta-toolkit/mcp').set('Authorization', `Bearer ${key}`).send({ jsonrpc: '2.0', id: nextId++, method, params });
const call = async (name: string, args: any, key = 'aw_u1') => {
  const res = await rpc('tools/call', { name, arguments: args }, key).expect(200);
  const text = res.body.result?.content?.[0]?.text;
  let parsed: any = text;
  try { parsed = JSON.parse(text); } catch { /* refusal text */ }
  return { isError: res.body.result?.isError, result: parsed, body: res.body };
};

describe('ENG-2823 Google Ads toolkit over MCP JSON-RPC (Google faked at HTTP)', () => {
  const prev = process.env.ZOMA_GOOGLE_ENABLED;
  beforeEach(() => {
    process.env.ZOMA_GOOGLE_ENABLED = 'true';
    budgets = { [BUDGET]: { name: 'Daily', amountMicros: '20000000', explicitlyShared: false, referenceCount: '1', status: 'ENABLED' } };
    mockAccounts.mockResolvedValue([googleAccount()]);
    mockPost.mockImplementation(async (url: string, body: any) => fakeGoogle(url, body));
    mockGet.mockRejectedValue(new Error('no GET expected'));
  });
  afterAll(() => {
    if (prev === undefined) delete process.env.ZOMA_GOOGLE_ENABLED;
    else process.env.ZOMA_GOOGLE_ENABLED = prev;
  });

  it('initialize answers for an authenticated caller', async () => {
    const res = await rpc('initialize', { protocolVersion: '2025-03-26' }).expect(200);
    expect(res.body.result.capabilities.tools).toBeDefined();
  });

  it('tools/list includes the Google tools only while the flag is on', async () => {
    const on = await rpc('tools/list').expect(200);
    const onNames = on.body.result.tools.map((t: any) => t.name);
    expect(onNames).toEqual(expect.arrayContaining(['call_google_ads_api', 'call_google_ads_reporting_api']));
    const api = on.body.result.tools.find((t: any) => t.name === 'call_google_ads_api');
    expect(api.inputSchema.properties.client_id).toBeUndefined();
    expect(api.inputSchema.properties.amount_micros).toBeUndefined();

    delete process.env.ZOMA_GOOGLE_ENABLED;
    const off = await rpc('tools/list').expect(200);
    const offNames = off.body.result.tools.map((t: any) => t.name);
    expect(offNames.filter((n: string) => n.includes('google'))).toEqual([]);
    expect(offNames).toEqual(onNames.filter((n: string) => !n.startsWith('call_google_ads')));
  });

  it('a read goes to Google with the manager login-customer-id and is metered as google_ads', async () => {
    const { isError, result } = await call('call_google_ads_api', { customer_id: CID, entity_type: 'BUDGET', action: 'LIST' });
    expect(isError).toBe(false);
    expect(result.budgets).toEqual([expect.objectContaining({ resourceName: BUDGET, amountMicros: '20000000' })]);
    const [url, , cfg] = mockPost.mock.calls[0];
    expect(url).toBe(`https://googleads.googleapis.com/v${url.match(/\/v(\d+)\//)[1]}/customers/${CID}/googleAds:search`);
    expect(cfg.headers['login-customer-id']).toBe(MANAGER);
    expect(cfg.headers['developer-token']).toBe('dev-token');
    expect(mutates()).toHaveLength(0);
    expect(mockRecordUse).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u1', toolName: 'call_google_ads_api', platform: 'google_ads' }));
  });

  it('preview → confirm: preview sends no mutate; confirm sends exactly one; replay sends none', async () => {
    // 2x: within the built-in default ceiling (ENG-3212: unset env = $500/day, ≤2x per change).
    const args = { customer_id: CID, entity_type: 'BUDGET', action: 'UPDATE', budget_resource_name: BUDGET, amount: 40 };
    const preview = await call('call_google_ads_api', args);
    expect(preview.result.status).toBe('PREVIEW');
    expect(preview.result.preview).toContain('20.00 USD/day (= 20000000 micros) → 40.00 USD/day (= 40000000 micros)');
    expect(mutates()).toHaveLength(0);
    expect(mockRecordWrite).not.toHaveBeenCalled();

    // Another user (even with the same org-shared account) cannot spend this approval.
    mockAccounts.mockResolvedValue([googleAccount()]);
    const stolen = await call('call_google_ads_api', { ...args, confirm: true, preview_token: preview.result.preview_token }, 'aw_u2');
    expect(stolen.result.status).toBe('PREVIEW_MISMATCH');
    expect(mutates()).toHaveLength(0);

    const confirmed = await call('call_google_ads_api', { ...args, confirm: true, preview_token: preview.result.preview_token });
    expect(confirmed.result).toMatchObject({ success: true, verification: 'CONFIRMED', id: BUDGET, amount_micros: 40_000_000 });
    expect(mutates()).toHaveLength(1);
    const [, body, cfg] = mutates()[0];
    expect(body.operations).toEqual([{ update: { resourceName: BUDGET, amountMicros: '40000000' }, updateMask: 'amount_micros' }]);
    expect(cfg.headers['login-customer-id']).toBe(MANAGER);
    expect(mockRecordWrite).toHaveBeenCalledTimes(1);
    expect(mockRecordWrite).toHaveBeenCalledWith(expect.objectContaining({ platform: 'google_ads', verification: 'CONFIRMED', entityType: 'BUDGET', action: 'UPDATE' }));

    const replay = await call('call_google_ads_api', { ...args, confirm: true, preview_token: preview.result.preview_token });
    expect(replay.result.status).toBe('PREVIEW_MISMATCH');
    expect(mutates()).toHaveLength(1);
  });

  it('campaign goal LIST and guarded UPDATE use the real handler and independent GAQL read-back', async () => {
    const rn = `customers/${CID}/campaignConversionGoals/77~CONTACT~WEBSITE`;
    let biddable = true;
    mockPost.mockImplementation(async (url: string, body: any) => {
      if (url.endsWith('/campaignConversionGoals:mutate')) {
        expect(body.operations).toEqual([{ update: { resourceName: rn, biddable: false }, updateMask: 'biddable' }]);
        biddable = false;
        return { data: { results: [{ resourceName: rn }] } };
      }
      if (body.query?.includes('FROM campaign_conversion_goal')) {
        return { data: { results: [{ campaign: { name: 'Brand' }, campaignConversionGoal: { resourceName: rn, campaign: `customers/${CID}/campaigns/77`, category: 'CONTACT', origin: 'WEBSITE', biddable } }] } };
      }
      return fakeGoogle(url, body);
    });
    const list = await call('call_google_ads_api', { customer_id: CID, entity_type: 'CAMPAIGN_CONVERSION_GOAL', action: 'LIST', campaign_id: '77' });
    expect(list.isError).toBe(false);
    expect(JSON.stringify(list.result)).toContain(rn);
    const args = { customer_id: CID, entity_type: 'CAMPAIGN_CONVERSION_GOAL', action: 'UPDATE', resource_name: rn, biddable: false };
    const preview = await call('call_google_ads_api', args);
    expect(preview.result.preview).toContain('Brand');
    expect(mutates()).toHaveLength(0);
    const confirmed = await call('call_google_ads_api', { ...args, confirm: true, preview_token: preview.result.preview_token });
    expect(confirmed.result).toMatchObject({ success: true, verification: 'CONFIRMED', biddable: false });
    expect(mutates()).toHaveLength(1);
    expect(mockPost.mock.calls.filter(([, body]) => body.query?.includes('campaign_conversion_goal.resource_name ='))).toHaveLength(4);
  });

  it('with GOOGLE_TOOLKIT_SPEND_CEILING unset, the built-in default refuses a >2x raise before any mutate (ENG-3212)', async () => {
    const saved = process.env.GOOGLE_TOOLKIT_SPEND_CEILING;
    delete process.env.GOOGLE_TOOLKIT_SPEND_CEILING;
    try {
      const r = await call('call_google_ads_api', { customer_id: CID, entity_type: 'BUDGET', action: 'UPDATE', budget_resource_name: BUDGET, amount: 50 });
      expect(r.isError).toBe(true);
      expect(JSON.stringify(r)).toMatch(/ceiling/i);
      expect(mutates()).toHaveLength(0);
    } finally {
      if (saved === undefined) delete process.env.GOOGLE_TOOLKIT_SPEND_CEILING; else process.env.GOOGLE_TOOLKIT_SPEND_CEILING = saved;
    }
  });

  it('a timeout on the confirmed mutate is UNCONFIRMED (metered as a write), not "did not apply"', async () => {
    const args = { customer_id: CID, entity_type: 'BUDGET', action: 'CREATE', name: 'New', amount: 25 };
    const preview = await call('call_google_ads_api', args);
    mockPost.mockImplementation(async (url: string, body: any) => {
      if (url.includes(':mutate')) throw Object.assign(new Error('timeout of 30000ms exceeded'), { code: 'ECONNABORTED' });
      return fakeGoogle(url, body);
    });
    const r = await call('call_google_ads_api', { ...args, confirm: true, preview_token: preview.result.preview_token });
    expect(r.result).toMatchObject({ success: false, verification: 'UNCONFIRMED' });
    expect(r.result.message).toMatch(/Do not retry blindly/);
    expect(mockRecordWrite).toHaveBeenCalledWith(expect.objectContaining({ verification: 'UNCONFIRMED', platform: 'google_ads' }));
  });

  it('refusals are tool errors, reach no Google endpoint and are not metered', async () => {
    for (const args of [
      { customer_id: CID, entity_type: 'CAMPAIGN', action: 'REMOVE', campaign_resource_name: `customers/${CID}/campaigns/1` },
      { customer_id: CID, entity_type: 'KEYWORD', action: 'CREATE' },
      { customer_id: CID, entity_type: 'BUDGET', action: 'UPDATE', budget_resource_name: BUDGET, amount: '50' },
      { customer_id: CID, entity_type: 'BUDGET', action: 'LIST', client_id: 'someone-else' },
    ]) {
      const r = await call('call_google_ads_api', args);
      expect(r.isError).toBe(true);
    }
    expect(mockPost).not.toHaveBeenCalled();
    expect(mockRecordUse).not.toHaveBeenCalled();
  });

  it('a customer the caller is not connected to is refused before Google (403)', async () => {
    const res = await rpc('tools/call', { name: 'call_google_ads_api', arguments: { customer_id: '5555555555', entity_type: 'BUDGET', action: 'LIST' } });
    expect(res.status).toBe(403);
    expect(res.body.error.message).toMatch(/not connected/);
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('flag off: a Google tool call never reaches Google', async () => {
    delete process.env.ZOMA_GOOGLE_ENABLED;
    await rpc('tools/call', { name: 'call_google_ads_api', arguments: { customer_id: CID, entity_type: 'BUDGET', action: 'LIST' } });
    expect(mockPost).not.toHaveBeenCalled();
  });
});
