/**
 * ENG-3135 — Google Ads connect for a Zoma user.
 *  - the connect link's signed state carries `zoma`; the OAuth callback forwards it to Zoma's pages
 *    (never the Emma portal), while portal states are untouched
 *  - the callback/finalize/connect chain only reads from Google and writes one connected_accounts
 *    row: no campaign, budget, conversion action or other mutate
 *  - a user with no Google Ads account gets explicit no-campaign guidance and a retry link
 *  - zoma_status never hands out the bare ads.google.com (Google's campaign signup)
 * Mock-only proof (no live Google OAuth): labeled as such in the PR.
 */
const mockAxiosPost = jest.fn();
jest.mock('axios', () => ({ post: (...a: any[]) => mockAxiosPost(...a), get: jest.fn() }));
jest.mock('../config/integrations', () => ({
  getGoogleAdsConfig: jest.fn().mockResolvedValue({
    clientId: 'cid', clientSecret: 'secret', redirectUri: 'https://api.test/api/oauth/google-ads/callback',
    scopes: ['https://www.googleapis.com/auth/adwords'],
    authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth', tokenUrl: 'https://oauth2.googleapis.com/token',
  }),
}));
jest.mock('../services/connectedAccountsDb', () => ({
  createAccount: jest.fn().mockResolvedValue({}),
  getAccountsByUserId: jest.fn().mockResolvedValue([]),
  getAccountsByUserIdIncludingOrgShared: jest.fn().mockResolvedValue([]),
}));
jest.mock('../services/journeyMilestones', () => ({ zomaMilestone: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../services/db', () => ({ userDb: { getUserById: jest.fn() } }));
jest.mock('../services/stripeService', () => ({ stripeService: {} }));
jest.mock('../middleware/auth', () => ({ authenticateToken: (_q: any, _r: any, n: any) => n() }));

const tree = jest.fn();
const mutations = {
  createCampaign: jest.fn(), createBudget: jest.fn(), createConversionAction: jest.fn(),
  mutate: jest.fn(), batchMutate: jest.fn(),
};
jest.mock('../services/googleAdsService', () => ({
  googleAdsService: {
    listAccountHierarchy: (...a: any[]) => tree(...a),
    flattenConnectableLeaves: (nodes: any[]) => nodes.flatMap((n) => (n.type === 'leaf' ? [n] : n.children)),
    ...mutations,
  },
}));

import jwt from 'jsonwebtoken';
import express from 'express';
import request from 'supertest';
import googleAdsAuthRouter from '../routes/googleAdsAuth';
import { createZomaRouter } from '../routes/zoma';
import { buildGoogleAdsConnectUrl } from '../services/googleAdsConnectUrl';
import { createAccount } from '../services/connectedAccountsDb';
import { getJwtSecret } from '../config/jwt';
import { completeGoogleConnect, defaultZomaGoogleDeps, selectGoogleAccounts, type ZomaGoogleDeps } from '../mcp/zomaGoogleConnect';
import { ZOMA_MCP_SETUP } from '../mcp/zomaSetupLinks';
import { ZOMA_BACK_TO_AGENT } from '../mcp/zomaDeviceFlow';
import { getZomaReadiness, type ZomaOnboardingDeps } from '../mcp/zomaOnboarding';

const GRANTED = 'https://www.googleapis.com/auth/adwords https://www.googleapis.com/auth/userinfo.email';
const leaf = (id: string, name = `Acct ${id}`) => ({ type: 'leaf', customerId: id, name, currency: 'EUR', loginCustomerId: id, testAccount: false });
const zomaState = (userId = 'u1') => jwt.sign({ userId, zoma: ZOMA_MCP_SETUP, nonce: 'n' }, getJwtSecret(), { expiresIn: '15m' });
const portalState = (userId = 'u1') => jwt.sign({ userId, nonce: 'n' }, getJwtSecret(), { expiresIn: '15m' });
const stateOf = (url: string) => new URL(url).searchParams.get('state')!;

const ORIGINAL_FRONTEND_URL = process.env.CUSTOMER_FRONTEND_URL;
afterEach(() => {
  if (ORIGINAL_FRONTEND_URL === undefined) delete process.env.CUSTOMER_FRONTEND_URL;
  else process.env.CUSTOMER_FRONTEND_URL = ORIGINAL_FRONTEND_URL;
});

beforeEach(() => {
  jest.clearAllMocks();
  mockAxiosPost.mockResolvedValue({ data: { access_token: 'at', refresh_token: 'rt', expires_in: 3600, scope: GRANTED } });
  tree.mockResolvedValue([leaf('1112223333')]);
});

describe('connect link state', () => {
  it('carries zoma only when asked, and sends no locale/country/account-creation hint', async () => {
    const zoma = await buildGoogleAdsConnectUrl('u1', { zoma: ZOMA_MCP_SETUP });
    expect(jwt.verify(stateOf(zoma), getJwtSecret())).toMatchObject({ userId: 'u1', zoma: ZOMA_MCP_SETUP });
    expect(jwt.verify(stateOf(await buildGoogleAdsConnectUrl('u1')), getJwtSecret())).not.toHaveProperty('zoma');
    const params = new URL(zoma).searchParams;
    const hijack = jwt.verify(stateOf(await buildGoogleAdsConnectUrl('u1', { userId: 'attacker' })), getJwtSecret());
    expect(hijack).toMatchObject({ userId: 'u1' });
    expect([...params.keys()].sort()).toEqual(['access_type', 'client_id', 'prompt', 'redirect_uri', 'response_type', 'scope', 'state']);
  });
});

describe('GET /api/oauth/google-ads/callback', () => {
  const app = express().use('/', googleAdsAuthRouter);
  it('forwards a Zoma state (code or denial) to Zoma pages, not the portal', async () => {
    const ok = await request(app).get('/callback').query({ code: 'c0de', state: zomaState() });
    expect(ok.status).toBe(302);
    expect(ok.headers.location).toMatch(/^\/api\/zoma\/google\/callback\?/);
    expect(new URLSearchParams(ok.headers.location.split('?')[1]).get('code')).toBe('c0de');
    const denied = await request(app).get('/callback').query({ error: 'access_denied', state: zomaState() });
    expect(denied.headers.location).toMatch(/^\/api\/zoma\/google\/callback\?.*error=access_denied/);
  });
  it('an EXPIRED Zoma state still lands on Zoma (which shows the expired page), never the portal', async () => {
    const expired = jwt.sign({ userId: 'u1', zoma: ZOMA_MCP_SETUP, nonce: 'n' }, getJwtSecret(), { expiresIn: -60 });
    const res = await request(app).get('/callback').query({ code: 'c0de', state: expired });
    expect(res.headers.location).toMatch(/^\/api\/zoma\/google\/callback\?/);
    expect(await completeGoogleConnect({ code: 'c0de', state: expired }, { ...defaultZomaGoogleDeps, enabled: () => true })).toMatchObject({ kind: 'page', status: 400 });
    expect(mockAxiosPost).not.toHaveBeenCalled();
  });
  it('a forged (wrongly signed) state is not treated as Zoma', async () => {
    process.env.CUSTOMER_FRONTEND_URL = 'https://app.test';
    const forged = jwt.sign({ userId: 'u1', zoma: ZOMA_MCP_SETUP }, 'not-the-secret');
    const res = await request(app).get('/callback').query({ code: 'c0de', state: forged });
    expect(res.headers.location).toMatch(/^https:\/\/app\.test\//);
  });
  it('leaves portal states going to the customer portal', async () => {
    process.env.CUSTOMER_FRONTEND_URL = 'https://app.test';
    const res = await request(app).get('/callback').query({ code: 'c0de', state: portalState() });
    expect(res.headers.location).toMatch(/^https:\/\/app\.test\/oauth\/google-ads\/callback\?code=c0de/);
  });
});

describe('completeGoogleConnect', () => {
  const deps = (over: Partial<ZomaGoogleDeps> = {}): ZomaGoogleDeps => ({
    ...defaultZomaGoogleDeps,
    mintLink: jest.fn().mockResolvedValue('https://accounts.google.com/o/oauth2/v2/auth?state=fresh'),
    enabled: () => true,
    ...over,
  });

  it('one existing account: connected for the state user, back to the agent, nothing created', async () => {
    const step: any = await completeGoogleConnect({ code: 'c', state: zomaState('u7') }, deps());
    expect(step).toMatchObject({ kind: 'page', status: 200, title: 'Google Ads connected', done: true });
    expect(step.message).toContain(ZOMA_BACK_TO_AGENT);
    expect(step.message).toContain('no campaign was created');
    expect(step.message).not.toMatch(/emma|app\.agentweb/i);
    expect(createAccount).toHaveBeenCalledTimes(1);
    expect((createAccount as jest.Mock).mock.calls[0].slice(0, 2)).toEqual(['u7', 'google_ads']);
    expect(mockAxiosPost).toHaveBeenCalledTimes(1);
    expect(mockAxiosPost.mock.calls[0][0]).toBe('https://oauth2.googleapis.com/token');
    for (const fn of Object.values(mutations)) expect(fn).not.toHaveBeenCalled();
  });

  it('several accounts: signed picker that only accepts offered ids', async () => {
    tree.mockResolvedValue([leaf('111'), { type: 'manager', customerId: '9', name: 'MCC', children: [leaf('222'), leaf('333')] }]);
    const d = deps();
    const picker: any = await completeGoogleConnect({ code: 'c', state: zomaState() }, d);
    expect(picker.kind).toBe('pick_account');
    expect(picker.action).toBe('/api/zoma/google/select');
    expect(picker.accounts.map((a: any) => a.account_id)).toEqual(['111', '222', '333']);
    expect(createAccount).not.toHaveBeenCalled();

    const none: any = await selectGoogleAccounts({ t: picker.token, account_id: ['999'] }, d);
    expect(none.kind).toBe('pick_account');
    expect(createAccount).not.toHaveBeenCalled();

    const done: any = await selectGoogleAccounts({ t: picker.token, account_id: ['222', '999'] }, d);
    expect(done).toMatchObject({ kind: 'page', status: 200, done: true });
    expect(createAccount).toHaveBeenCalledTimes(1);
    expect((createAccount as jest.Mock).mock.calls[0][2].account_id).toBe('222');
    for (const fn of Object.values(mutations)) expect(fn).not.toHaveBeenCalled();
  });

  it('rejects a forged, non-Zoma, or wrong-purpose token', async () => {
    const d = deps();
    expect(await completeGoogleConnect({ code: 'c', state: 'garbage' }, d)).toMatchObject({ kind: 'page', status: 400 });
    expect(await completeGoogleConnect({ code: 'c', state: portalState() }, d)).toMatchObject({ kind: 'page', status: 400 });
    const meta = d.links.sign({ purpose: 'pick_meta_account', zoma: ZOMA_MCP_SETUP, uid: 'u1', tokenSessionId: 't', googleAccounts: [{ customer_id: '1', name: 'x', currency: 'USD' }] }, 60);
    expect(await selectGoogleAccounts({ t: meta, account_id: '1' }, d)).toMatchObject({ kind: 'page', status: 400 });
    expect(createAccount).not.toHaveBeenCalled();
    expect(mockAxiosPost).not.toHaveBeenCalled();
  });

  it('no Google Ads account: explicit no-campaign guidance, user-chosen country/currency/time zone, reconnect link', async () => {
    tree.mockResolvedValue([]);
    const step: any = await completeGoogleConnect({ code: 'c', state: zomaState() }, deps());
    expect(step).toMatchObject({ kind: 'page', status: 400, title: 'No Google Ads account found', retryLabel: 'Connect Google Ads again' });
    expect(step.retryUrl).toContain('accounts.google.com');
    const text = step.steps.join(' ');
    expect(text).toContain('Create an account without a campaign');
    expect(text).toMatch(/billing country, currency and time zone, choose them yourself/);
    expect(text).not.toMatch(/https:\/\/ads\.google\.com/);
    expect(text).toContain('support.google.com/google-ads/answer/6366720');
    expect(createAccount).not.toHaveBeenCalled();
  });

  it('account exists but Google has not enabled it: finish THAT account, never "create one"', async () => {
    tree.mockImplementation(async (_token: string, diag?: { notEnabledCustomerIds?: string[] }) => {
      if (diag) diag.notEnabledCustomerIds = ['9990001111'];
      return [];
    });
    const step: any = await completeGoogleConnect({ code: 'c', state: zomaState() }, deps());
    expect(step).toMatchObject({ kind: 'page', status: 400, title: 'Google Ads account not finished', retryLabel: 'Connect Google Ads again' });
    expect(step.message).toContain('9990001111');
    expect(step.message).toMatch(/did not create it/);
    const text = step.steps.join(' ');
    expect(text).toMatch(/If its setup is unfinished, finish it there; do not create another account yet/);
    expect(text).toContain('Create an account without a campaign');
    expect(text).toMatch(/Zoma cannot change any of them/);
    expect(text).not.toMatch(/Create a Google Ads account yourself/);
    expect(step.message).toMatch(/deactivated/);
    expect(createAccount).not.toHaveBeenCalled();
  });

  it('manager-only login with no active client account: no "create an account" advice', async () => {
    tree.mockResolvedValue([{ type: 'manager', customerId: '9', name: 'MCC', children: [] }]);
    const step: any = await completeGoogleConnect({ code: 'c', state: zomaState() }, deps());
    expect(step).toMatchObject({ kind: 'page', status: 400, title: 'No active Google Ads account to connect', retryLabel: 'Connect Google Ads again' });
    expect(step.steps.join(' ')).not.toMatch(/Create a Google Ads account yourself/);
    expect(createAccount).not.toHaveBeenCalled();
  });

  it('Google 401 NOT_ADS_USER (login never used Google Ads) is the no-account page, not a failure', async () => {
    const notAdsUser = Object.assign(new Error('Request failed with status code 401'), {
      response: { status: 401, data: { error: { code: 401, status: 'UNAUTHENTICATED', details: [
        { errors: [{ errorCode: { authenticationError: 'NOT_ADS_USER' }, message: 'User in the cookie is not a valid Ads user.' }] },
      ] } } },
    });
    tree.mockRejectedValueOnce(notAdsUser);
    const step: any = await completeGoogleConnect({ code: 'c', state: zomaState() }, deps());
    expect(step).toMatchObject({ kind: 'page', status: 400, title: 'No Google Ads account found', retryLabel: 'Connect Google Ads again' });
    expect(step.steps.join(' ')).toContain('Create an account without a campaign');
    expect(createAccount).not.toHaveBeenCalled();
  });

  it('any other 401 stays a generic failure and logs the status and Google error code', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const other = Object.assign(new Error('Request failed with status code 401'), {
      response: { status: 401, data: { error: { details: [{ errors: [{ errorCode: { authenticationError: 'OAUTH_TOKEN_INVALID' } }] }] } } },
    });
    tree.mockRejectedValueOnce(other);
    const step: any = await completeGoogleConnect({ code: 'c', state: zomaState() }, deps());
    expect(step).toMatchObject({ status: 502, title: 'Google Ads not connected' });
    expect(logSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain('status code 401 [OAUTH_TOKEN_INVALID]');
    logSpy.mockRestore();
  });

  it('a usable account still connects when another one is not enabled', async () => {
    tree.mockImplementation(async (_token: string, diag?: { notEnabledCustomerIds?: string[] }) => {
      if (diag) diag.notEnabledCustomerIds = ['9990001111'];
      return [leaf('1112223333')];
    });
    expect(await completeGoogleConnect({ code: 'c', state: zomaState() }, deps())).toMatchObject({ status: 200, title: 'Google Ads connected' });
    expect(createAccount).toHaveBeenCalledTimes(1);
  });

  it('denied consent, missing adwords scope, and token-exchange failure give a retry, never a connection', async () => {
    const denied: any = await completeGoogleConnect({ error: 'access_denied', state: zomaState() }, deps());
    expect(denied).toMatchObject({ status: 400, title: 'Google Ads not connected' });
    mockAxiosPost.mockResolvedValueOnce({ data: { access_token: 'at', expires_in: 3600, scope: 'https://www.googleapis.com/auth/userinfo.email' } });
    const scopes: any = await completeGoogleConnect({ code: 'c', state: zomaState() }, deps());
    expect(scopes).toMatchObject({ status: 422 });
    expect(scopes.message).toContain('permission was not granted');
    mockAxiosPost.mockRejectedValueOnce(new Error('boom'));
    expect(await completeGoogleConnect({ code: 'c', state: zomaState() }, deps())).toMatchObject({ status: 502 });
    expect(createAccount).not.toHaveBeenCalled();
  });

  it('retry page still points at the agent when a fresh link cannot be minted', async () => {
    const step: any = await completeGoogleConnect({ error: 'access_denied', state: zomaState() }, deps({ mintLink: jest.fn().mockRejectedValue(new Error('x')) }));
    expect(step.retryUrl).toBeUndefined();
    expect(step.message).toContain(ZOMA_BACK_TO_AGENT);
  });
});

describe('POST /api/zoma/google/select + GET /api/zoma/google/callback routes', () => {
  const prev = process.env.ZOMA_GOOGLE_ENABLED;
  beforeAll(() => { process.env.ZOMA_GOOGLE_ENABLED = 'true'; });
  afterAll(() => { if (prev === undefined) delete process.env.ZOMA_GOOGLE_ENABLED; else process.env.ZOMA_GOOGLE_ENABLED = prev; });
  const app = express().use(express.urlencoded({ extended: false })).use('/api/zoma', createZomaRouter());
  it('renders the connected page on Zoma (not a redirect to the portal)', async () => {
    const res = await request(app).get('/api/zoma/google/callback').query({ code: 'c', state: zomaState() });
    expect(res.status).toBe(200);
    expect(res.text).toContain('Google Ads connected');
    expect(res.headers.location).toBeUndefined();
    expect(res.text).not.toMatch(/app\.agentweb/i);
  });
  it('an invalid picker link renders an expired page, not a 500', async () => {
    const res = await request(app).post('/api/zoma/google/select').type('form').send({ t: 'bad', account_id: '1' });
    expect(res.status).toBe(400);
  });
});

describe('zoma_status Google link', () => {
  const base = (over: Partial<ZomaOnboardingDeps> = {}): ZomaOnboardingDeps => ({
    getUser: jest.fn().mockResolvedValue({ userId: 'u1', zomaAdsExperience: 'runs_ads', email: 'a@b.co' }),
    listAccounts: jest.fn().mockResolvedValue([]),
    findLiveCustomerId: jest.fn().mockResolvedValue(null),
    createCustomerForUser: jest.fn().mockResolvedValue('cus_new'),
    resolvePaymentMethod: jest.fn().mockResolvedValue({ hasPaymentMethod: false, customerId: null, card: null, isZoma: false }),
    createPaymentMethodSetupSession: jest.fn().mockResolvedValue({ url: 'https://checkout.stripe.com/x' }),
    buildMetaConnectUrl: jest.fn().mockResolvedValue('https://www.facebook.com/dialog/oauth?x'),
    pagesUrl: () => 'https://api.agentweb.pro',
    googleEnabled: () => true,
    now: () => 1_800_000_000_000,
    ...over,
  } as any);

  it('default link is minted with the Zoma state', async () => {
    const r = await getZomaReadiness('u1', base());
    expect(jwt.verify(stateOf(r.google_ads.link!), getJwtSecret())).toMatchObject({ userId: 'u1', zoma: ZOMA_MCP_SETUP });
    expect(r.next_step).toContain(r.google_ads.link!);
    expect(r.next_step).toContain('creates no campaign');
  });

  it('never falls back to the bare ads.google.com when the link cannot be minted', async () => {
    const r = await getZomaReadiness('u1', base({ buildGoogleAdsConnectUrl: jest.fn().mockRejectedValue(new Error('x')) }));
    expect(r.next_step).not.toContain('ads.google.com');
    expect(r.next_step).toContain('call zoma_status again');
  });
});
