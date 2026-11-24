/**
 * LinkedIn Ads connect for a Zoma user. Invariants only:
 *  - the connect link's state is a signed JWT carrying `zoma`; the portal /callback forwards to Zoma's
 *    pages only for a state whose signature verifies, only while the flag is read/true, and never on
 *    an unsigned query parameter; the portal flow is otherwise untouched
 *  - the Zoma handlers verify signature AND expiry again and take the user only from that payload: a
 *    missing, tampered or expired claim is the generic invalid-link page, and nothing is finalized
 *  - flag off: the Zoma pages answer a generic 404 page and LinkedIn is never called
 *  - consent asks only for the scopes of the mode; the stored connection has the same fields as the
 *    portal's
 * Mock-only (no live LinkedIn OAuth).
 */
const mockAxiosPost = jest.fn();
const mockAxiosGet = jest.fn();
jest.mock('axios', () => ({ post: (...a: any[]) => mockAxiosPost(...a), get: (...a: any[]) => mockAxiosGet(...a) }));
jest.mock('../config/integrations', () => ({
  getLinkedInAdsConfig: jest.fn().mockResolvedValue({
    clientId: 'test-client-id', clientSecret: 'test-client-secret',
    redirectUri: 'https://api.test/api/oauth/linkedin-ads/callback',
    scopes: ['r_basicprofile', 'r_ads', 'rw_ads', 'r_ads_reporting', 'r_organization_social', 'w_organization_social'],
    authorizationUrl: 'https://www.linkedin.com/oauth/v2/authorization',
    tokenUrl: 'https://www.linkedin.com/oauth/v2/accessToken',
  }),
}));
jest.mock('../services/linkedInAdsService', () => ({ listAdAccounts: jest.fn() }));
jest.mock('../services/connectedAccountsDb', () => ({
  createAccount: jest.fn().mockResolvedValue({ platform: 'linkedin_ads', account_id: '5001', config: {} }),
  getAccountsByUserId: jest.fn().mockResolvedValue([]),
  getAccountsByUserIdIncludingOrgShared: jest.fn().mockResolvedValue([]),
}));
jest.mock('../services/approvalInboxCustomerNotify', () => ({ safeAutoResolveCredentialDecision: jest.fn() }));
jest.mock('../services/journeyMilestones', () => ({ zomaMilestone: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../services/db', () => ({ userDb: { getUserById: jest.fn() } }));
jest.mock('../services/stripeService', () => ({ stripeService: {} }));
jest.mock('../middleware/auth', () => ({ authenticateToken: (req: any, _res: any, next: any) => { req.user = { userId: 'u1' }; next(); } }));

import jwt from 'jsonwebtoken';
import express from 'express';
import request from 'supertest';
import linkedInAdsAuthRouter from '../routes/linkedInAdsAuth';
import { createZomaRouter } from '../routes/zoma';
import { buildLinkedInAdsConnectUrl, zomaLinkedInScopes } from '../services/linkedInAdsConnectUrl';
import { createAccount } from '../services/connectedAccountsDb';
import { listAdAccounts } from '../services/linkedInAdsService';
import { getJwtSecret } from '../config/jwt';
import { rateLimiter } from '../middleware/rateLimiter';
import {
  completeLinkedInAdsConnect, defaultZomaLinkedInAdsDeps, selectLinkedInAdsAccounts, type ZomaLinkedInAdsDeps,
} from '../mcp/zomaLinkedInAdsConnect';
import { defaultZomaLinkCodec, ZOMA_LINKEDIN_CALLBACK_PATH, ZOMA_LINKEDIN_SELECT_PATH, ZOMA_MCP_SETUP } from '../mcp/zomaSetupLinks';
import { ZOMA_BACK_TO_AGENT } from '../mcp/zomaDeviceFlow';

const secret = () => getJwtSecret();
const zomaState = (userId = 'u1', opts: jwt.SignOptions = { expiresIn: '15m' }, key: string = secret()) =>
  jwt.sign({ userId, zoma: ZOMA_MCP_SETUP, nonce: 'n' }, key, opts);
const portalState = (userId = 'u1') => jwt.sign({ userId, nonce: 'n' }, secret(), { expiresIn: '15m' });
const expiredZomaState = () => zomaState('u1', { expiresIn: '-10s' });
const tamper = (token: string) => {
  const [h, p, s] = token.split('.');
  const payload = JSON.parse(Buffer.from(p, 'base64url').toString());
  return `${h}.${Buffer.from(JSON.stringify({ ...payload, userId: 'victim' })).toString('base64url')}.${s}`;
};

const ENV = { li: process.env.ZOMA_LINKEDIN_ADS_ENABLED, front: process.env.CUSTOMER_FRONTEND_URL };
afterEach(() => {
  if (ENV.li === undefined) delete process.env.ZOMA_LINKEDIN_ADS_ENABLED; else process.env.ZOMA_LINKEDIN_ADS_ENABLED = ENV.li;
  if (ENV.front === undefined) delete process.env.CUSTOMER_FRONTEND_URL; else process.env.CUSTOMER_FRONTEND_URL = ENV.front;
});
beforeEach(() => {
  jest.clearAllMocks();
  process.env.CUSTOMER_FRONTEND_URL = 'https://portal.test';
  mockAxiosPost.mockResolvedValue({ data: { access_token: 'LI-ACCESS', refresh_token: 'LI-REFRESH', expires_in: 5183944 } });
  mockAxiosGet.mockResolvedValue({ data: { id: 'member1' } });
  (listAdAccounts as jest.Mock).mockResolvedValue({
    success: true,
    data: { elements: [{ id: 5001, name: 'Acme', currency: 'EUR', status: 'ACTIVE', reference: 'urn:li:organization:77' }] },
  });
});

const portalApp = () => { const app = express(); app.use(express.json()); app.use('/', linkedInAdsAuthRouter); return app; };
const zomaApp = () => { const app = express(); app.use(express.urlencoded({ extended: false })); app.use('/api/zoma', createZomaRouter()); return app; };

describe('consent URL: scopes by mode, signed zoma state, the registered redirect URI', () => {
  const scopesOf = (url: string) => new URL(url).searchParams.get('scope')!.split(' ');

  it('read mode asks only for the read scopes; full mode adds rw_ads; no write feature needs an organization social scope', async () => {
    const read = scopesOf(await buildLinkedInAdsConnectUrl('u1', { zoma: ZOMA_MCP_SETUP }, zomaLinkedInScopes(false)));
    expect(read.sort()).toEqual(['r_ads', 'r_ads_reporting', 'r_basicprofile']);
    const full = scopesOf(await buildLinkedInAdsConnectUrl('u1', { zoma: ZOMA_MCP_SETUP }, zomaLinkedInScopes(true)));
    expect(full.sort()).toEqual(['r_ads', 'r_ads_reporting', 'r_basicprofile', 'rw_ads']);
    for (const scopes of [read, full]) expect(scopes).not.toEqual(expect.arrayContaining(['w_organization_social']));
    for (const scopes of [read, full]) expect(scopes).not.toEqual(expect.arrayContaining(['r_organization_social']));
  });

  it('the link Zoma mints follows the mode, reuses the registered redirect URI and signs the user and the zoma claim into the state', async () => {
    process.env.ZOMA_LINKEDIN_ADS_ENABLED = 'read';
    const readUrl = new URL(await defaultZomaLinkedInAdsDeps.mintLink('u1'));
    expect(readUrl.searchParams.get('scope')).toBe('r_basicprofile r_ads r_ads_reporting');
    expect(readUrl.searchParams.get('redirect_uri')).toBe('https://api.test/api/oauth/linkedin-ads/callback');
    const claims: any = jwt.verify(readUrl.searchParams.get('state')!, secret());
    expect(claims).toMatchObject({ userId: 'u1', zoma: ZOMA_MCP_SETUP });
    process.env.ZOMA_LINKEDIN_ADS_ENABLED = 'true';
    expect(new URL(await defaultZomaLinkedInAdsDeps.mintLink('u1')).searchParams.get('scope')).toBe('r_basicprofile r_ads r_ads_reporting rw_ads');
  });

  it('the portal /init is untouched: the configured scope list, and a state without any zoma claim', async () => {
    const res = await request(portalApp()).get('/init');
    expect(res.status).toBe(200);
    const url = new URL(res.body.url);
    expect(url.searchParams.get('scope')).toBe('r_basicprofile r_ads rw_ads r_ads_reporting r_organization_social w_organization_social');
    expect(jwt.verify(url.searchParams.get('state')!, secret())).not.toHaveProperty('zoma');
  });
});

describe('the portal /callback forwards only a verified Zoma state, only while the flag is on', () => {
  const callback = (query: string) => request(portalApp()).get(`/callback?${query}`);
  const portalRedirect = 'https://portal.test/oauth/linkedin-ads/callback';

  beforeEach(() => { process.env.ZOMA_LINKEDIN_ADS_ENABLED = 'read'; });

  it('a signed state carrying zoma goes to the Zoma page with code, state and error, and never to the portal', async () => {
    const state = zomaState();
    const res = await callback(`code=abc&state=${state}`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`${ZOMA_LINKEDIN_CALLBACK_PATH}?code=abc&state=${encodeURIComponent(state)}`);
    const denied = await callback(`error=user_cancelled_authorize&state=${state}`);
    expect(denied.headers.location).toMatch(new RegExp(`^${ZOMA_LINKEDIN_CALLBACK_PATH}\\?`));
    expect(denied.headers.location).toContain('error=user_cancelled_authorize');
  });

  it('a signed state whose expiry has passed still reaches Zoma\'s page, which answers "invalid or expired"', async () => {
    const res = await callback(`code=abc&state=${expiredZomaState()}`);
    expect(res.headers.location).toMatch(new RegExp(`^${ZOMA_LINKEDIN_CALLBACK_PATH}\\?`));
  });

  it('a portal state, a tampered state, a state signed with another key and an unsigned "zoma" parameter all stay on the portal path', async () => {
    for (const query of [
      `code=abc&state=${portalState()}`,
      `code=abc&state=${tamper(zomaState())}`,
      `code=abc&state=${zomaState('u1', { expiresIn: '15m' }, 'not-the-server-key')}`,
      `code=abc&state=plain-state&zoma=mcp`,
      `code=abc&state=${portalState()}&zoma=mcp`,
      `code=abc`,
    ]) {
      const res = await callback(query);
      expect(res.status).toBe(302);
      expect(res.headers.location).toContain(portalRedirect);
      expect(res.headers.location).not.toContain('/api/zoma/');
    }
  });

  it('flag off: even a valid Zoma state takes the portal path, exactly as before LinkedIn existed on Zoma', async () => {
    for (const value of [undefined, 'false', 'TRUE', '1']) {
      if (value === undefined) delete process.env.ZOMA_LINKEDIN_ADS_ENABLED; else process.env.ZOMA_LINKEDIN_ADS_ENABLED = value;
      const res = await callback(`code=abc&state=${zomaState()}`);
      expect(res.headers.location).toContain(portalRedirect);
    }
  });
});

describe('the Zoma pages: user bound from the verified state, invalid links get the generic page', () => {
  const deps = (over: Partial<ZomaLinkedInAdsDeps> = {}): ZomaLinkedInAdsDeps => ({
    ...defaultZomaLinkedInAdsDeps,
    finalize: jest.fn().mockResolvedValue({
      tokenSessionId: 'sess1',
      adAccounts: [{ id: '5001', name: 'Acme', currency: 'EUR', status: 'ACTIVE' }],
    }),
    connect: jest.fn().mockResolvedValue({ ok: true, accounts: [{}] }),
    mintLink: jest.fn().mockResolvedValue('https://www.linkedin.com/oauth/v2/authorization?state=retry'),
    enabled: () => true,
    ...over,
  });
  const INVALID = { kind: 'page', status: 400, title: 'Zoma setup' };

  it('flag off: both pages answer the generic 404 page and nothing is finalized, connected or minted', async () => {
    const d = deps({ enabled: () => false });
    for (const step of [
      await completeLinkedInAdsConnect({ code: 'c', state: zomaState() }, d),
      await selectLinkedInAdsAccounts({ t: 'anything', account_id: '1' }, d),
    ] as any[]) {
      expect(step).toMatchObject({ kind: 'page', status: 404, title: 'Zoma setup' });
      expect(JSON.stringify(step)).not.toMatch(/linkedin/i);
    }
    expect(d.finalize).not.toHaveBeenCalled();
    expect(d.connect).not.toHaveBeenCalled();
    expect(d.mintLink).not.toHaveBeenCalled();
  });

  it('a missing, tampered, expired, foreign-key or non-zoma state is the generic invalid-link page and nothing is finalized', async () => {
    const d = deps();
    for (const state of [undefined, '', 'garbage', portalState(), tamper(zomaState()), expiredZomaState(), zomaState('u1', { expiresIn: '15m' }, 'not-the-server-key'), 42]) {
      const step: any = await completeLinkedInAdsConnect({ code: 'c', state }, d);
      expect(step).toMatchObject(INVALID);
      expect(step.message).toContain('LinkedIn Ads connection link is invalid or has expired');
      expect(step.message).toContain(ZOMA_BACK_TO_AGENT);
    }
    expect(d.finalize).not.toHaveBeenCalled();
    expect(d.connect).not.toHaveBeenCalled();
  });

  it('one active ad account connects at once, for the state\'s user, with nothing created or spent', async () => {
    const d = deps();
    const step: any = await completeLinkedInAdsConnect({ code: 'the-code', state: zomaState('user-42') }, d);
    expect(d.finalize).toHaveBeenCalledWith('user-42', 'the-code');
    expect(d.connect).toHaveBeenCalledWith('user-42', 'sess1', [{ adAccountId: '5001', adAccountName: 'Acme', currency: 'EUR', status: 'ACTIVE' }]);
    expect(step).toMatchObject({ kind: 'page', status: 200, title: 'LinkedIn Ads connected', done: true });
    expect(step.message).toContain('no campaign was created and nothing was spent');
  });

  it('several accounts: a picker with only the active ones; only an offered account can be chosen; a forged picker link is refused', async () => {
    const d = deps({
      finalize: jest.fn().mockResolvedValue({
        tokenSessionId: 'sess2',
        adAccounts: [
          { id: '5001', name: 'Acme', currency: 'EUR', status: 'ACTIVE' },
          { id: '5002', name: 'Beta', currency: 'USD', status: 'ACTIVE' },
          { id: '5003', name: 'Old', currency: 'USD', status: 'CANCELED' },
        ],
      }),
    });
    const picker: any = await completeLinkedInAdsConnect({ code: 'c', state: zomaState('user-7') }, d);
    expect(picker).toMatchObject({ kind: 'pick_account', action: ZOMA_LINKEDIN_SELECT_PATH });
    expect(picker.accounts.map((a: any) => a.account_id)).toEqual(['5001', '5002']);
    expect(d.connect).not.toHaveBeenCalled();

    const none: any = await selectLinkedInAdsAccounts({ t: picker.token, account_id: '5003' }, d);
    expect(none).toMatchObject({ kind: 'pick_account' });
    expect(d.connect).not.toHaveBeenCalled();
    const chosen: any = await selectLinkedInAdsAccounts({ t: picker.token, account_id: ['5002', '9999'] }, d);
    expect(chosen).toMatchObject({ kind: 'page', status: 200, title: 'LinkedIn Ads connected' });
    expect(d.connect).toHaveBeenCalledWith('user-7', 'sess2', [{ adAccountId: '5002', adAccountName: 'Beta', currency: 'USD', status: 'ACTIVE' }]);

    for (const t of [undefined, 'garbage', tamper(picker.token), defaultZomaLinkCodec.sign({ purpose: 'pick_google_account', zoma: ZOMA_MCP_SETUP, uid: 'u1' }, 600)]) {
      expect(await selectLinkedInAdsAccounts({ t, account_id: '5001' }, d)).toMatchObject({ kind: 'page', status: 400 });
    }
    expect(d.connect).toHaveBeenCalledTimes(1);
  });

  it('declined consent, a failed finalize and an account list with nothing to connect each end on a page that offers a retry link and no secret', async () => {
    const declined = deps();
    expect(await completeLinkedInAdsConnect({ error: 'user_cancelled_authorize', state: zomaState() }, declined)).toMatchObject({
      kind: 'page', status: 400, title: 'LinkedIn Ads not connected', retryUrl: expect.stringContaining('linkedin.com'),
    });
    expect(declined.finalize).not.toHaveBeenCalled();

    const broken = deps({ finalize: jest.fn().mockRejectedValue(Object.assign(new Error('boom client_secret=test-client-secret'), { response: { status: 500 } })) });
    const failed: any = await completeLinkedInAdsConnect({ code: 'c', state: zomaState() }, broken);
    expect(failed).toMatchObject({ kind: 'page', status: 502, retryUrl: expect.any(String) });
    expect(JSON.stringify(failed)).not.toMatch(/test-client-secret|boom/);

    const empty = await completeLinkedInAdsConnect({ code: 'c', state: zomaState() }, deps({ finalize: jest.fn().mockResolvedValue({ tokenSessionId: 's', adAccounts: [] }) }));
    expect(empty).toMatchObject({ kind: 'page', status: 400, title: 'No LinkedIn ad account found' });
    const inactive = await completeLinkedInAdsConnect({ code: 'c', state: zomaState() }, deps({
      finalize: jest.fn().mockResolvedValue({ tokenSessionId: 's', adAccounts: [{ id: '1', name: 'x', status: 'CANCELED' }] }),
    }));
    expect(inactive).toMatchObject({ kind: 'page', status: 400, title: 'No active LinkedIn ad account' });
  });

  it('through the HTTP routes: flag on without a valid state is the invalid-link page', async () => {
    process.env.ZOMA_LINKEDIN_ADS_ENABLED = 'read';
    const on = await request(zomaApp()).get('/api/zoma/linkedin/callback').query({ code: 'c', state: tamper(zomaState()) });
    expect(on.status).toBe(400);
    expect(on.text).toContain('LinkedIn Ads connection link is invalid or has expired');
    expect(mockAxiosPost).not.toHaveBeenCalled();
  });

  it('flag off: the LinkedIn routes do not exist: they fall through like any unknown route and use none of the shared throttle', async () => {
    const check = jest.spyOn(rateLimiter, 'check');
    const app = express();
    app.use(express.urlencoded({ extended: false }));
    app.use('/api/zoma', createZomaRouter());
    app.use((_req, res) => res.status(404).type('text').send('UNKNOWN ROUTE'));
    for (const value of [undefined, 'false', 'TRUE']) {
      if (value === undefined) delete process.env.ZOMA_LINKEDIN_ADS_ENABLED; else process.env.ZOMA_LINKEDIN_ADS_ENABLED = value;
      const unknown = await request(app).get('/api/zoma/not-a-route').query({ code: 'c', state: zomaState() });
      const callback = await request(app).get('/api/zoma/linkedin/callback').query({ code: 'c', state: zomaState() });
      const select = await request(app).post('/api/zoma/linkedin/select').type('form').send({ t: 'x', account_id: '1' });
      for (const res of [callback, select]) {
        expect(res.status).toBe(unknown.status);
        expect(res.text).toBe(unknown.text);
        expect(res.headers['content-type']).toBe(unknown.headers['content-type']);
        expect(res.headers['content-security-policy']).toBeUndefined();
      }
    }
    expect(check.mock.calls.filter(([key]) => String(key).startsWith('zoma-activate'))).toEqual([]);
    expect(mockAxiosPost).not.toHaveBeenCalled();
    // On, the same routes are real and do spend the bucket.
    process.env.ZOMA_LINKEDIN_ADS_ENABLED = 'read';
    expect((await request(app).get('/api/zoma/linkedin/callback').query({ state: 'x' })).status).toBe(400);
    expect(check.mock.calls.filter(([key]) => String(key).startsWith('zoma-activate')).length).toBe(1);
    check.mockRestore();
  });
});

describe('what is stored: the same connection the portal stores, with the scopes that were asked for', () => {
  const connectThroughZoma = async (mode: 'read' | 'true') => {
    process.env.ZOMA_LINKEDIN_ADS_ENABLED = mode;
    const finalized = await defaultZomaLinkedInAdsDeps.finalize('u1', 'the-code');
    const connected = await defaultZomaLinkedInAdsDeps.connect('u1', finalized.tokenSessionId, [{ adAccountId: '5001', adAccountName: 'Acme', currency: 'EUR', status: 'ACTIVE' }]);
    return { finalized, connected, row: (createAccount as jest.Mock).mock.calls.at(-1) };
  };

  it('the row has the portal\'s fields (organization and person URN included) and the scopes of the mode', async () => {
    const read = await connectThroughZoma('read');
    expect(read.connected).toMatchObject({ ok: true });
    const [userId, platform, input] = read.row;
    expect([userId, platform]).toEqual(['u1', 'linkedin_ads']);
    expect(input).toMatchObject({ account_id: '5001', account_name: 'Acme' });
    expect(Object.keys(input.config).sort()).toEqual([
      'access_token', 'account_type', 'currency', 'organization_urn', 'person_urn', 'refresh_token', 'scopes', 'status', 'token_expires_at',
    ]);
    expect(input.config).toMatchObject({
      account_type: 'ad_account', currency: 'EUR', status: 'ACTIVE', organization_urn: 'urn:li:organization:77', person_urn: 'urn:li:person:member1',
      scopes: ['r_basicprofile', 'r_ads', 'r_ads_reporting'],
    });
    const full = await connectThroughZoma('true');
    expect(full.row[2].config.scopes).toEqual(['r_basicprofile', 'r_ads', 'r_ads_reporting', 'rw_ads']);
  });

  it('the portal connect keeps storing the configured scope list; a token session works once and only for its user', async () => {
    const app = portalApp();
    const state = portalState('u1');
    const fin = await request(app).post('/finalize').send({ code: 'c', state });
    expect(fin.status).toBe(200);
    const body = { tokenSessionId: fin.body.tokenSessionId, adAccountId: '5001', adAccountName: 'Acme', currency: 'EUR', status: 'ACTIVE' };
    const first = await request(app).post('/connect').send(body);
    expect(first.status).toBe(200);
    expect(first.body.account.config).not.toHaveProperty('access_token');
    expect((createAccount as jest.Mock).mock.calls.at(-1)![2].config.scopes).toEqual(['r_basicprofile', 'r_ads', 'rw_ads', 'r_ads_reporting', 'r_organization_social', 'w_organization_social']);
    expect((await request(app).post('/connect').send(body)).status).toBe(401);
  });
});
