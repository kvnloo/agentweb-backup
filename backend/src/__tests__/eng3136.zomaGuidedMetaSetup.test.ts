/**
 * ENG-3136 — Zoma guided Meta ad-account setup: resumable, honest, and never a false "set up".
 * Same real MCP endpoint / gateway / Zoma pages scaffold as ENG-3134; only persistence, Meta's
 * token exchange and Graph HTTP are faked.
 *
 * Regression for the Nikhil onboarding (2026-11-16): Meta's own "create ad account" submit did
 * nothing, he connected a personal Facebook login with a different email, and Zoma never said
 * whose page failed, whether a different email is allowed, or how to resume.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'eng-3134-test-secret';
process.env.BACKEND_URL = 'https://api.agentweb.pro';
process.env.CUSTOMER_FRONTEND_URL = 'https://app.agentweb.pro';
delete process.env.ZOMA_REQUIRE_PAYMENT_METHOD;
delete process.env.ZOMA_GOOGLE_ADS_ENABLED;

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


const metaState = async (adsExperience: string) => {
  const res = await call('zoma_status', { ads_experience: adsExperience }).expect(200);
  const status = JSON.parse(texts(res)[0]);
  return { status, state: new URL(status.meta.link).searchParams.get('state')! };
};

describe('ENG-3136 guided Meta ad-account setup', () => {
  it('a returning advertiser is told a different Facebook email is fine, and which login must own the account', async () => {
    const { status } = await metaState('runs_ads');
    expect(status.meta.ready).toBe(false);
    expect(status.next_step).toContain('does not need to use the same email as your Zoma login');
    expect(status.next_step).toContain('created the ad account or belongs to the Business portfolio');
    expect(status.next_step).not.toContain(EMMA_APP);
  });

  it('a new advertiser whose Meta create button fails gets a provider route, is told it is Meta\'s page, and a way back', async () => {
    const { status } = await metaState('new_to_ads');
    const next = status.next_step as string;
    expect(next).toContain('that is Meta\'s page, not Zoma');
    expect(next).toContain('Zoma cannot create the account for you');
    expect(next).toContain('https://adsmanager.facebook.com');
    expect(next).toContain('https://www.facebook.com/business/help');
    expect(next).toContain('https://business.facebook.com/settings/ad-accounts');
    expect(next).toContain('re-check');
  });

  it('a Facebook login with no ad account: guided page, nothing saved, no false success, resumes on reconnect', async () => {
    const { state } = await metaState('new_to_ads');
    finalizeMetaOAuth.mockResolvedValue({ flow: 'marketing', tokenSessionId: 'ts-a', preconnectInstructions: '', adAccounts: [] });
    const page = await request(app).get('/api/zoma/meta/callback').query({ code: 'c', state }).expect(400);
    expect(page.text).toContain('No ad account found');
    expect(page.text).toContain('does not need to use the same email as your Zoma login');
    expect(page.text).toContain('a different Facebook login shows Zoma no ad accounts');
    expect(page.text).toContain('adsmanager.facebook.com');
    expect(page.text).toContain('Reconnect Meta');
    expect(page.text).not.toContain(EMMA_APP);
    expect(connectMetaAdAccounts).not.toHaveBeenCalled();

    // Nothing was connected: status still asks to connect, with a fresh link, never "All set".
    const again = JSON.parse(texts(await call('zoma_status').expect(200))[0]);
    expect(again.meta.ready).toBe(false);
    expect(again.summary).not.toContain('All set');
    expect(again.meta.link).toContain('facebook.com');

    // The user creates the account at Meta and reconnects with the same link flow.
    finalizeMetaOAuth.mockResolvedValue({
      flow: 'marketing', tokenSessionId: 'ts-b', preconnectInstructions: '',
      adAccounts: [{ account_id: '111', name: 'Phoenix Shop', currency: 'USD', account_status: 1 }],
    });
    const retryState = new URL(again.meta.link).searchParams.get('state')!;
    const ok = await request(app).get('/api/zoma/meta/callback').query({ code: 'c2', state: retryState }).expect(200);
    expect(ok.text).toContain('Meta connected');
    const done = JSON.parse(texts(await call('zoma_status').expect(200))[0]);
    expect(done.meta.ready).toBe(true);
    expect(done.summary).toContain('All set.');
  });

  it('connected but no usable Facebook Page: never "All set", Page guidance, and readiness is rechecked after reconnect', async () => {
    accounts = [{ ...metaAccount, config: { ...metaAccount.config, has_meta_pages: false, meta_page_count: 0 } }];
    users.set('u1', { userId: 'u1', email: 'nikhil@gmail.com', zomaAdsExperience: 'new_to_ads' });
    const blocked = JSON.parse(texts(await call('zoma_status').expect(200))[0]);
    expect(blocked.summary).not.toContain('All set');
    expect(blocked.blocker).toMatchObject({ reason: 'no_page_exists' });
    expect(blocked.summary).toContain('https://www.facebook.com/pages/create');
    expect(blocked.blocker.link).toContain('facebook.com');

    accounts = [{ ...metaAccount, config: { ...metaAccount.config, has_meta_pages: true, meta_page_count: 1 } }];
    const fixed = JSON.parse(texts(await call('zoma_status').expect(200))[0]);
    expect(fixed.blocker).toBeNull();
    expect(fixed.summary).toContain('All set.');
  });
});
