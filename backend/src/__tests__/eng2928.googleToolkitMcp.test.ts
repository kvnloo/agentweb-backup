process.env.ZOMA_REQUIRE_PAYMENT_METHOD = 'true';
/**
 * ENG-2928 — the new Google Ads writes end to end over MCP JSON-RPC.
 *
 * Real router → real gateway → real Google toolkit → the Emma call_google_ads_api handler →
 * real googleAdsService. Google is faked only at the HTTP boundary (axios), plus the
 * AWS-backed seams (same harness as eng2823.googleToolkitMcp).
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
const AD_GROUP = `customers/${CID}/adGroups/66`;
const CAMPAIGN = `customers/${CID}/campaigns/88`;
const ASSET_GROUP = `customers/${CID}/assetGroups/301`;
let keywords: Array<{ resourceName: string; text: string; matchType: string; status: string; negative: boolean }>;
let assetGroupStatus: string;
let assets: Record<string, { type: string; text?: string; name: string }>;
const mutates = () => mockPost.mock.calls.filter(([url]) => String(url).includes(':mutate'));
const rows = (results: any[]) => ({ data: { results, totalResultsCount: String(results.length) } });

function fakeGoogle(url: string, body: any) {
  if (!url.startsWith('https://googleads.googleapis.com/')) throw new Error(`unexpected URL ${url}`);
  if (url.endsWith(`/customers/${CID}/googleAds:search`)) {
    const q: string = body.query;
    if (/FROM ad_group_criterion/.test(q)) {
      return rows(keywords.map((k) => ({ adGroupCriterion: { resourceName: k.resourceName, keyword: { text: k.text, matchType: k.matchType }, status: k.status, negative: k.negative, adGroup: AD_GROUP } })));
    }
    if (/FROM ad_group /.test(q)) return rows([{ adGroup: { resourceName: AD_GROUP, name: 'Shoes', status: 'ENABLED', campaign: CAMPAIGN } }]);
    if (/FROM asset_group /.test(q)) {
      return rows([{ assetGroup: { resourceName: ASSET_GROUP, name: 'Spring', status: assetGroupStatus, campaign: CAMPAIGN, finalUrls: ['https://acme.example'] } }]);
    }
    if (/FROM campaign_budget/.test(q)) return rows([{ campaignBudget: { resourceName: BUDGET, name: 'Daily', amountMicros: '20000000', explicitlyShared: false, referenceCount: '1' } }]);
    if (/FROM campaign /.test(q)) {
      return rows([{ campaign: { resourceName: CAMPAIGN, name: 'PMax', status: 'PAUSED', campaignBudget: BUDGET, advertisingChannelType: 'PERFORMANCE_MAX' } }]);
    }
    if (/FROM asset /.test(q)) {
      const rn = q.match(/asset\.resource_name = '([^']+)'/)?.[1] ?? '';
      const a = assets[rn];
      return rows(a ? [{ asset: { resourceName: rn, name: a.name, type: a.type, ...(a.text ? { textAsset: { text: a.text } } : {}) } }] : []);
    }
    return rows([]);
  }
  if (url.endsWith(`/customers/${CID}/adGroupCriteria:mutate`)) {
    const results = body.operations.map((op: any, i: number) => {
      const resourceName = `customers/${CID}/adGroupCriteria/66~${900 + i}`;
      keywords.push({ resourceName, text: op.create.keyword.text, matchType: op.create.keyword.matchType, status: op.create.status, negative: op.create.negative === true });
      return { resourceName };
    });
    return { data: { results } };
  }
  if (url.endsWith(`/customers/${CID}/assetGroups:mutate`)) {
    assetGroupStatus = body.operations[0].update.status;
    return { data: { results: [{ resourceName: ASSET_GROUP }] } };
  }
  if (url.endsWith(`/customers/${CID}/assets:mutate`)) {
    const c = body.operations[0].create;
    const resourceName = `customers/${CID}/assets/${7000 + Object.keys(assets).length}`;
    assets[resourceName] = { type: c.type, name: c.name, text: c.textAsset?.text };
    return { data: { results: [{ resourceName }] } };
  }
  throw new Error(`fake Google: unhandled ${url}`);
}

const googleAccount = () => ({
  platform: 'google_ads', account_id: CID, account_name: 'Acme Search', userId: 'u1',
  config: { customer_id: CID, login_customer_id: MANAGER, currency: 'USD', access_token: 'live-access', refresh_token: 'r', token_expires_at: Date.now() + 3600_000 },
});

let nextId = 1;
const rpc = (method: string, params: any = {}, key = 'aw_u1') =>
  request(app).post('/api/meta-toolkit/mcp').set('Authorization', `Bearer ${key}`).send({ jsonrpc: '2.0', id: nextId++, method, params });
const call = async (name: string, args: any) => {
  const res = await rpc('tools/call', { name, arguments: args }).expect(200);
  const text = res.body.result?.content?.[0]?.text;
  let parsed: any = text;
  try { parsed = JSON.parse(text); } catch { /* refusal text */ }
  return { isError: res.body.result?.isError, result: parsed };
};

describe('ENG-2928 Google Ads writes over MCP JSON-RPC (Google faked at HTTP)', () => {
  const prev = process.env.ZOMA_GOOGLE_ENABLED;
  beforeEach(() => {
    process.env.ZOMA_GOOGLE_ENABLED = 'true';
    keywords = [];
    assetGroupStatus = 'PAUSED';
    assets = {};
    mockPost.mockReset();
    mockRecordWrite.mockClear();
    mockRecordUse.mockClear();
    mockAccounts.mockResolvedValue([googleAccount()]);
    mockPost.mockImplementation(async (url: string, body: any) => fakeGoogle(url, body));
    mockGet.mockRejectedValue(new Error('no GET expected'));
  });
  afterAll(() => {
    if (prev === undefined) delete process.env.ZOMA_GOOGLE_ENABLED;
    else process.env.ZOMA_GOOGLE_ENABLED = prev;
  });

  it('KEYWORD ADD: preview sends no mutate; confirm sends one PAUSED create; GAQL read-back CONFIRMED; metered once', async () => {
    const args = { customer_id: CID, entity_type: 'KEYWORD', action: 'ADD', ad_group_resource_name: AD_GROUP, keywords: [{ text: 'red shoes', matchType: 'EXACT' }] };
    const preview = await call('call_google_ads_api', args);
    expect(preview.result.status).toBe('PREVIEW');
    expect(mutates()).toHaveLength(0);
    const confirmed = await call('call_google_ads_api', { ...args, confirm: true, preview_token: preview.result.preview_token });
    expect(confirmed.result).toMatchObject({ success: true, verification: 'CONFIRMED', id: AD_GROUP, ids: [`customers/${CID}/adGroupCriteria/66~900`] });
    expect(mutates()).toHaveLength(1);
    expect(mutates()[0][1].operations).toEqual([{ create: { adGroup: AD_GROUP, status: 'PAUSED', keyword: { text: 'red shoes', matchType: 'EXACT' } } }]);
    expect(mockRecordWrite).toHaveBeenCalledTimes(1);
    expect(mockRecordWrite).toHaveBeenCalledWith(expect.objectContaining({ platform: 'google_ads', entityType: 'KEYWORD', action: 'ADD', verification: 'CONFIRMED' }));
  });

  it('ASSET_GROUP UPDATE status=ENABLED goes through the new Emma branch: one status mutate, read back CONFIRMED', async () => {
    const args = { customer_id: CID, entity_type: 'ASSET_GROUP', action: 'UPDATE', asset_group_resource_name: ASSET_GROUP, status: 'ENABLED' };
    const preview = await call('call_google_ads_api', args);
    expect(preview.result.preview).toContain('Asset group "Spring": PAUSED → ENABLED.');
    const confirmed = await call('call_google_ads_api', { ...args, confirm: true, preview_token: preview.result.preview_token });
    expect(confirmed.result).toMatchObject({ success: true, verification: 'CONFIRMED', status: 'ENABLED', id: ASSET_GROUP });
    expect(mutates()).toHaveLength(1);
    expect(mutates()[0][1].operations).toEqual([{ update: { resourceName: ASSET_GROUP, status: 'ENABLED' }, updateMask: 'status' }]);
  });

  it('ASSET UPLOAD TEXT runs without a preview token, is read back CONFIRMED and metered as a write', async () => {
    const r = await call('call_google_ads_api', { customer_id: CID, entity_type: 'ASSET', action: 'UPLOAD', asset_type: 'TEXT', data: 'Acme Shoes' });
    expect(r.result).toMatchObject({ success: true, verification: 'CONFIRMED', asset_type: 'TEXT' });
    expect(mutates()).toHaveLength(1);
    expect(mutates()[0][1].operations).toEqual([{ create: { name: 'Acme Shoes', type: 'TEXT', textAsset: { text: 'Acme Shoes' } } }]);
    expect(mockRecordWrite).toHaveBeenCalledWith(expect.objectContaining({ entityType: 'ASSET', action: 'UPLOAD', verification: 'CONFIRMED', objectId: r.result.id }));
  });

  it('refusals (RSA with 2 headlines, private image URL) reach no Google endpoint and are not metered', async () => {
    const rsa = await call('call_google_ads_api', {
      customer_id: CID, entity_type: 'AD', action: 'CREATE', ad_group_resource_name: AD_GROUP,
      headlines: ['a', 'b'], descriptions: ['c', 'd'], final_url: 'https://acme.example',
    });
    expect(rsa.isError).toBe(true);
    const img = await call('call_google_ads_api', { customer_id: CID, entity_type: 'ASSET', action: 'UPLOAD', asset_type: 'IMAGE', name: 'x', data: 'https://127.0.0.1/a.png' });
    expect(img.isError).toBe(true);
    expect(String(img.result)).toMatch(/public address/);
    expect(mutates()).toHaveLength(0);
    expect(mockRecordWrite).not.toHaveBeenCalled();
  });
});
