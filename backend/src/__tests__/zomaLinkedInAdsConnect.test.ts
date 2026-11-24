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
import { createAccount, getAccountsByUserId } from '../services/connectedAccountsDb';
import { listAdAccounts } from '../services/linkedInAdsService';
import { getJwtSecret } from '../config/jwt';
import { rateLimiter } from '../middleware/rateLimiter';
import {
  completeLinkedInAdsConnect, defaultZomaLinkedInAdsDeps, selectLinkedInAdsAccounts, type ZomaLinkedInAdsDeps,
} from '../mcp/zomaLinkedInAdsConnect';
import { connectLinkedInAdsAccounts, finalizeLinkedInAdsOAuth } from '../services/linkedInAdsOAuthFinalize';
import type { LinkedInTokenDeps } from '../services/linkedInAdsCredentials';
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
  (getAccountsByUserId as jest.Mock).mockResolvedValue([]);
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
      tokenSessionId: 'sess1', listFailed: false,
      adAccounts: [{ id: '5001', name: 'Acme', currency: 'EUR', status: 'ACTIVE' }],
    }),
    connect: jest.fn().mockResolvedValue({ ok: true, accounts: [{}], kept: [], replaced: [] }),
    mintLink: jest.fn().mockResolvedValue('https://www.linkedin.com/oauth/v2/authorization?state=retry'),
    getUserEmail: jest.fn().mockResolvedValue('mvarma@argusoft.com'),
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

  it('even a single ad account is never connected on arrival: the page names the Zoma account (full email) and waits for an explicit Connect', async () => {
    const d = deps();
    const step: any = await completeLinkedInAdsConnect({ code: 'the-code', state: zomaState('user-42') }, d);
    expect(d.finalize).toHaveBeenCalledWith('user-42', 'the-code');
    expect(d.connect).not.toHaveBeenCalled();
    expect(step).toMatchObject({ kind: 'pick_account', action: ZOMA_LINKEDIN_SELECT_PATH, submitLabel: 'Connect' });
    expect(step.accounts).toEqual([{ account_id: '5001', name: 'Acme', currency: 'EUR' }]);
    expect(step.message).toContain('the Zoma account mvarma@argusoft.com');
    expect(step.message).not.toContain('***');
    expect(step.message).toMatch(/Only continue if that is your Zoma account/);
    expect(d.getUserEmail).toHaveBeenCalledWith('user-42');
    // The click is what connects, for the user named in the signed picker link, and nobody else.
    const done: any = await selectLinkedInAdsAccounts({ t: step.token, account_id: '5001' }, d);
    expect(d.connect).toHaveBeenCalledWith('user-42', 'sess1', [{ adAccountId: '5001', adAccountName: 'Acme', currency: 'EUR', status: 'ACTIVE' }]);
    expect(done).toMatchObject({ kind: 'page', status: 200, title: 'LinkedIn Ads connected', done: true });
    expect(done.message).toContain('no campaign was created and nothing was spent');
  });

  it('two different accounts that a mask would have shown identically get two different pages (the full address is shown)', async () => {
    const emails: Record<string, string> = { 'user-a': 'mvarma@argusoft.com', 'user-b': 'mmarcos@argusoft.com' };
    const d = deps({ getUserEmail: jest.fn(async (id: string) => emails[id]) });
    const a: any = await completeLinkedInAdsConnect({ code: 'c', state: zomaState('user-a') }, d);
    const b: any = await completeLinkedInAdsConnect({ code: 'c', state: zomaState('user-b') }, d);
    expect(a.message).toContain('mvarma@argusoft.com');
    expect(b.message).toContain('mmarcos@argusoft.com');
    expect(a.message).not.toBe(b.message);
    // the old shape ("m***@argusoft.com") would have been the same for both
    expect(`${a.message}${b.message}`).not.toMatch(/\*\*\*/);
  });

  it('an account with no usable email is not connected at all: the generic invalid-link page, and the OAuth code is never exchanged', async () => {
    for (const getUserEmail of [jest.fn().mockResolvedValue(undefined), jest.fn().mockResolvedValue(''), jest.fn().mockResolvedValue('not-an-address'), jest.fn().mockRejectedValue(new Error('db down')), undefined]) {
      const d = deps({ getUserEmail: getUserEmail as any });
      const step: any = await completeLinkedInAdsConnect({ code: 'c', state: zomaState('u9') }, d);
      expect(step).toMatchObject({ kind: 'page', status: 400, title: 'Zoma setup' });
      expect(step.message).toContain('LinkedIn Ads connection link is invalid or has expired');
      expect(d.finalize).not.toHaveBeenCalled();
      expect(d.connect).not.toHaveBeenCalled();
    }
    // and a picker link whose account lost its email cannot be used either
    const ok = deps();
    const picker: any = await completeLinkedInAdsConnect({ code: 'c', state: zomaState('u9') }, ok);
    const gone = deps({ getUserEmail: jest.fn().mockResolvedValue(undefined) });
    expect(await selectLinkedInAdsAccounts({ t: picker.token, account_id: 'not-offered' }, gone)).toMatchObject({ kind: 'page', status: 400 });
  });

  it('the shared page shows the Zoma account\'s full email and an explicit Connect button, not the generic Continue', async () => {
    const d = deps();
    const app = express();
    app.use(express.urlencoded({ extended: false }));
    app.use('/api/zoma', createZomaRouter(undefined, undefined, undefined, d));
    const res = await request(app).get('/api/zoma/linkedin/callback').query({ code: 'c', state: zomaState('user-5') });
    expect(res.status).toBe(200);
    expect(res.text).toContain('mvarma@argusoft.com');
    expect(res.text).not.toContain('m***');
    expect(res.text).toMatch(/<button type="submit">Connect<\/button>/);
    expect(res.text).not.toMatch(/<button type="submit">Continue<\/button>/);
    expect(res.text).toContain('action="/api/zoma/linkedin/select"');
    expect(d.connect).not.toHaveBeenCalled();
  });

  it('several accounts: a picker with only the active ones; only an offered account can be chosen; a forged picker link is refused', async () => {
    const d = deps({
      finalize: jest.fn().mockResolvedValue({
        tokenSessionId: 'sess2', listFailed: false,
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

    const empty = await completeLinkedInAdsConnect({ code: 'c', state: zomaState() }, deps({ finalize: jest.fn().mockResolvedValue({ tokenSessionId: 's', listFailed: false, adAccounts: [] }) }));
    expect(empty).toMatchObject({ kind: 'page', status: 400, title: 'No LinkedIn ad account found' });
    const inactive = await completeLinkedInAdsConnect({ code: 'c', state: zomaState() }, deps({
      finalize: jest.fn().mockResolvedValue({ tokenSessionId: 's', listFailed: false, adAccounts: [{ id: '1', name: 'x', status: 'CANCELED' }] }),
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

describe('a failed ad account list is not "you have no ad account"', () => {
  it('the service reports listFailed (status only is logged) and the portal answer is exactly what it was', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    (listAdAccounts as jest.Mock).mockResolvedValue({ success: false, status: 503, error: 'LinkedIn body with client_secret=LEAK and Bearer LEAK' });
    const failed = await finalizeLinkedInAdsOAuth({ userId: 'u1', code: 'c' });
    expect(failed).toMatchObject({ adAccounts: [], listFailed: true });
    expect(JSON.stringify(spy.mock.calls)).toContain('503');
    expect(JSON.stringify(spy.mock.calls)).not.toContain('LEAK');
    const portal = await request(portalApp()).post('/finalize').send({ code: 'c', state: portalState('u1') });
    expect(portal.status).toBe(200);
    expect(portal.body).toEqual({ success: true, adAccounts: [], tokenSessionId: expect.any(String) });
    expect(portal.body).not.toHaveProperty('listFailed');
    spy.mockRestore();
  });

  it('a successful but empty list is not a failure', async () => {
    (listAdAccounts as jest.Mock).mockResolvedValue({ success: true, data: { elements: [] } });
    expect(await finalizeLinkedInAdsOAuth({ userId: 'u1', code: 'c' })).toMatchObject({ adAccounts: [], listFailed: false });
  });

  it('LinkedIn answering 401/403 (access not approved) is told differently from a temporary failure', async () => {
    const page = (listStatus?: number) => completeLinkedInAdsConnect({ code: 'c', state: zomaState() }, {
      ...defaultZomaLinkedInAdsDeps,
      finalize: jest.fn().mockResolvedValue({ tokenSessionId: 's', adAccounts: [], listFailed: true, listStatus }),
      mintLink: jest.fn().mockResolvedValue('https://www.linkedin.com/oauth/v2/authorization?state=retry'),
      getUserEmail: jest.fn().mockResolvedValue('a@b.co'),
      enabled: () => true,
    }) as Promise<any>;
    for (const status of [401, 403]) {
      const step = await page(status);
      expect(step).toMatchObject({ status: 403, retryUrl: expect.any(String) });
      expect(step.message).toMatch(/access Zoma asked for was not approved/);
      expect(step.message).toMatch(/approve every permission/);
      expect(step.message).not.toMatch(/temporary/);
    }
    for (const status of [429, 500, 503, undefined]) {
      const step = await page(status);
      expect(step).toMatchObject({ status: 502, retryUrl: expect.any(String) });
      expect(step.message).toMatch(/usually temporary/);
      expect(step.message).not.toMatch(/not approved/);
    }
  });

  it('the service passes LinkedIn\'s status along (and only when the list failed)', async () => {
    (listAdAccounts as jest.Mock).mockResolvedValue({ success: false, status: 403, error: 'denied' });
    expect(await finalizeLinkedInAdsOAuth({ userId: 'u1', code: 'c' })).toMatchObject({ listFailed: true, listStatus: 403 });
    (listAdAccounts as jest.Mock).mockResolvedValue({ success: true, data: { elements: [] } });
    expect(await finalizeLinkedInAdsOAuth({ userId: 'u1', code: 'c' })).not.toHaveProperty('listStatus');
  });

  it('the Zoma page says it could not read the accounts and offers a retry, never the create-an-account steps', async () => {
    const d: ZomaLinkedInAdsDeps = {
      ...defaultZomaLinkedInAdsDeps,
      finalize: jest.fn().mockResolvedValue({ tokenSessionId: 's', adAccounts: [], listFailed: true }),
      mintLink: jest.fn().mockResolvedValue('https://www.linkedin.com/oauth/v2/authorization?state=retry'),
      getUserEmail: jest.fn().mockResolvedValue('a@b.co'),
      enabled: () => true,
    };
    const step: any = await completeLinkedInAdsConnect({ code: 'c', state: zomaState() }, d);
    expect(step).toMatchObject({ kind: 'page', status: 502, title: 'LinkedIn Ads not connected', retryUrl: expect.stringContaining('linkedin.com') });
    expect(step.message).toContain('could not read your LinkedIn ad accounts');
    expect(step.steps).toBeUndefined();
    expect(JSON.stringify(step)).not.toMatch(/Campaign Manager|create (it|an|one)|No LinkedIn ad account/i);
  });
});

describe('a Zoma reconnect never narrows an existing connection', () => {
  const PORTAL_SCOPES = ['r_basicprofile', 'r_ads', 'rw_ads', 'r_ads_reporting', 'r_organization_social', 'w_organization_social'];
  const portalRow = (over: Record<string, unknown> = {}) => ({
    platform: 'linkedin_ads', account_id: '5001', account_name: 'Acme',
    config: { account_type: 'ad_account', currency: 'EUR', status: 'ACTIVE', access_token: 'PORTAL-ACCESS', refresh_token: 'PORTAL-REFRESH', token_expires_at: Date.now() + 40 * 86400000, scopes: PORTAL_SCOPES, ...over },
  });
  const scopesOf = (url: string) => new URL(url).searchParams.get('scope')!.split(' ');

  it('the link asks for the mode\'s scopes PLUS the scopes the user\'s existing connections hold', async () => {
    (getAccountsByUserId as jest.Mock).mockResolvedValue([portalRow(), { platform: 'meta', account_id: 'act_1', config: { scopes: ['ads_management'] } }]);
    process.env.ZOMA_LINKEDIN_ADS_ENABLED = 'read';
    const asked = scopesOf(await defaultZomaLinkedInAdsDeps.mintLink('u1'));
    expect([...asked].sort()).toEqual([...PORTAL_SCOPES].sort());
    expect(asked).not.toContain('ads_management'); // another platform's scopes are not borrowed
    expect(new Set(asked).size).toBe(asked.length);
    (getAccountsByUserId as jest.Mock).mockResolvedValue([]);
    expect(scopesOf(await defaultZomaLinkedInAdsDeps.mintLink('u1')).sort()).toEqual(['r_ads', 'r_ads_reporting', 'r_basicprofile']);
    (getAccountsByUserId as jest.Mock).mockRejectedValue(new Error('db down'));
    expect(scopesOf(await defaultZomaLinkedInAdsDeps.mintLink('u1')).sort()).toEqual(['r_ads', 'r_ads_reporting', 'r_basicprofile']);
  });

  it('carries over only stored scopes the configured Ads list still names (a stale scope is never requested forever)', async () => {
    (getAccountsByUserId as jest.Mock).mockResolvedValue([portalRow({ scopes: [...PORTAL_SCOPES, 'r_legacy_scope', 'w_member_social'] })]);
    process.env.ZOMA_LINKEDIN_ADS_ENABLED = 'read';
    const asked = scopesOf(await defaultZomaLinkedInAdsDeps.mintLink('u1'));
    expect(asked).not.toContain('r_legacy_scope');
    expect(asked).not.toContain('w_member_social');
    expect([...asked].sort()).toEqual([...PORTAL_SCOPES].sort());
  });

  it('read mode never asks for rw_ads on its own: only a connection that already holds it carries it', async () => {
    process.env.ZOMA_LINKEDIN_ADS_ENABLED = 'read';
    const withoutWrite = PORTAL_SCOPES.filter((scope) => scope !== 'rw_ads');
    (getAccountsByUserId as jest.Mock).mockResolvedValue([portalRow({ scopes: withoutWrite })]);
    const asked = scopesOf(await defaultZomaLinkedInAdsDeps.mintLink('u1'));
    expect(asked).not.toContain('rw_ads');
    expect(asked).toEqual(expect.arrayContaining(['r_organization_social', 'w_organization_social']));
    (getAccountsByUserId as jest.Mock).mockResolvedValue([]);
    expect(scopesOf(await defaultZomaLinkedInAdsDeps.mintLink('u1'))).not.toContain('rw_ads');
    (getAccountsByUserId as jest.Mock).mockResolvedValue([portalRow()]); // this one holds rw_ads
    expect(scopesOf(await defaultZomaLinkedInAdsDeps.mintLink('u1'))).toContain('rw_ads');
    // and what is recorded for a read-mode connect is never wider than what was asked for
    (getAccountsByUserId as jest.Mock).mockResolvedValue([portalRow({ scopes: withoutWrite })]);
    mockAxiosPost.mockResolvedValue({ data: { access_token: 'a', refresh_token: 'r', expires_in: 3600 } });
    const finalized = await defaultZomaLinkedInAdsDeps.finalize('u1', 'c');
    await defaultZomaLinkedInAdsDeps.connect('u1', finalized.tokenSessionId, [{ adAccountId: '9999', adAccountName: 'Other', currency: 'USD', status: 'ACTIVE' }]);
    expect((createAccount as jest.Mock).mock.calls.at(-1)![2].config.scopes).not.toContain('rw_ads');
  });

  it('stores the scopes LinkedIn actually granted when it says so, otherwise the requested set', async () => {
    process.env.ZOMA_LINKEDIN_ADS_ENABLED = 'true';
    (getAccountsByUserId as jest.Mock).mockResolvedValue([]);
    mockAxiosPost.mockResolvedValue({ data: { access_token: 'a', refresh_token: 'r', expires_in: 3600, scope: 'r_ads,r_ads_reporting' } });
    let finalized = await defaultZomaLinkedInAdsDeps.finalize('u1', 'c');
    await defaultZomaLinkedInAdsDeps.connect('u1', finalized.tokenSessionId, [{ adAccountId: '5001', adAccountName: 'Acme', currency: 'EUR', status: 'ACTIVE' }]);
    expect((createAccount as jest.Mock).mock.calls.at(-1)![2].config.scopes).toEqual(['r_ads', 'r_ads_reporting']);
    mockAxiosPost.mockResolvedValue({ data: { access_token: 'a', refresh_token: 'r', expires_in: 3600 } });
    finalized = await defaultZomaLinkedInAdsDeps.finalize('u1', 'c');
    await defaultZomaLinkedInAdsDeps.connect('u1', finalized.tokenSessionId, [{ adAccountId: '5001', adAccountName: 'Acme', currency: 'EUR', status: 'ACTIVE' }]);
    expect((createAccount as jest.Mock).mock.calls.at(-1)![2].config.scopes).toEqual(['r_basicprofile', 'r_ads', 'r_ads_reporting', 'rw_ads']);
  });

  it('an existing portal row with the organization-social scopes is kept when the new grant is narrower, and the page says so', async () => {
    process.env.ZOMA_LINKEDIN_ADS_ENABLED = 'read';
    (getAccountsByUserId as jest.Mock).mockResolvedValue([portalRow()]);
    mockAxiosPost.mockResolvedValue({ data: { access_token: 'ZOMA-ACCESS', refresh_token: 'ZOMA-REFRESH', expires_in: 3600, scope: 'r_ads,r_ads_reporting,r_basicprofile' } });
    const finalized = await defaultZomaLinkedInAdsDeps.finalize('u1', 'c');
    const result = await defaultZomaLinkedInAdsDeps.connect('u1', finalized.tokenSessionId, [{ adAccountId: '5001', adAccountName: 'Acme', currency: 'EUR', status: 'ACTIVE' }]);
    expect(result).toMatchObject({ ok: true, accounts: [], kept: ['5001'] });
    expect(createAccount).not.toHaveBeenCalled(); // the portal token, with w_organization_social, is untouched
    const d: ZomaLinkedInAdsDeps = { ...defaultZomaLinkedInAdsDeps, connect: jest.fn().mockResolvedValue(result), enabled: () => true, getUserEmail: jest.fn().mockResolvedValue('a@b.co') };
    const step: any = await completeLinkedInAdsConnect({ code: 'c', state: zomaState() }, { ...d, finalize: jest.fn().mockResolvedValue({ tokenSessionId: 's', listFailed: false, adAccounts: [{ id: '5001', name: 'Acme', currency: 'EUR', status: 'ACTIVE' }] }) });
    const done: any = await selectLinkedInAdsAccounts({ t: step.token, account_id: '5001' }, d);
    expect(done).toMatchObject({ kind: 'page', status: 200, done: true });
    expect(done.message).toMatch(/already connected with wider access that still works.*left exactly as it was/);
    expect(done.message).not.toMatch(/is connected to Zoma/);
  });

  describe('a "kept" row must still work: a dead one is replaced, not hidden', () => {
    const narrowGrant = async () => {
      process.env.ZOMA_LINKEDIN_ADS_ENABLED = 'read';
      mockAxiosPost.mockResolvedValue({ data: { access_token: 'ZOMA-ACCESS', refresh_token: 'ZOMA-REFRESH', expires_in: 3600, scope: 'r_ads,r_ads_reporting,r_basicprofile' } });
      return defaultZomaLinkedInAdsDeps.finalize('u1', 'c');
    };
    const choice = [{ adAccountId: '5001', adAccountName: 'Acme', currency: 'EUR', status: 'ACTIVE' }];
    const tokenDeps = (over: Partial<LinkedInTokenDeps> = {}): LinkedInTokenDeps => ({
      now: () => Date.now(),
      loadOAuthConfig: jest.fn().mockResolvedValue({ clientId: 'cid', clientSecret: 'CLIENT-SECRET' }),
      refresh: jest.fn().mockResolvedValue({ access_token: 'renewed', refresh_token: 'renewed-rt', expires_in: 5183944 }),
      saveTokens: jest.fn().mockResolvedValue(undefined),
      ...over,
    });

    it('a dead portal row (expired, no refresh token) with wider scopes is replaced by the narrower new grant, and the page says so', async () => {
      (getAccountsByUserId as jest.Mock).mockResolvedValue([portalRow({ token_expires_at: Date.now() - 86400000, refresh_token: undefined })]);
      const finalized = await narrowGrant();
      const result: any = await connectLinkedInAdsAccounts({ userId: 'u1', tokenSessionId: finalized.tokenSessionId, accounts: choice, keepWiderExisting: true, tokenDeps: tokenDeps() });
      expect(result).toMatchObject({ ok: true, kept: [], replaced: ['5001'] });
      expect(createAccount).toHaveBeenCalledTimes(1);
      expect((createAccount as jest.Mock).mock.calls[0][2]).toMatchObject({ account_id: '5001', config: { access_token: 'ZOMA-ACCESS', scopes: ['r_ads', 'r_ads_reporting', 'r_basicprofile'] } });
      const d: ZomaLinkedInAdsDeps = { ...defaultZomaLinkedInAdsDeps, connect: jest.fn().mockResolvedValue(result), enabled: () => true, getUserEmail: jest.fn().mockResolvedValue('a@b.co') };
      const step: any = await completeLinkedInAdsConnect({ code: 'c', state: zomaState() }, { ...d, finalize: jest.fn().mockResolvedValue({ tokenSessionId: 's', listFailed: false, adAccounts: [{ id: '5001', name: 'Acme', currency: 'EUR', status: 'ACTIVE' }] }) });
      const done: any = await selectLinkedInAdsAccounts({ t: step.token, account_id: '5001' }, d);
      expect(done).toMatchObject({ kind: 'page', status: 200, done: true });
      expect(done.message).toMatch(/had expired or been revoked and could not be used, so this new connection replaced it/);
      expect(done.message).toMatch(/fewer permissions/);
      expect(done.message).not.toMatch(/left exactly as/);
    });

    it('a row whose token expired but whose refresh succeeds still works: it is kept (and its refreshed tokens saved)', async () => {
      (getAccountsByUserId as jest.Mock).mockResolvedValue([portalRow({ token_expires_at: Date.now() - 1000 })]);
      const finalized = await narrowGrant();
      const deps = tokenDeps();
      const result: any = await connectLinkedInAdsAccounts({ userId: 'u1', tokenSessionId: finalized.tokenSessionId, accounts: choice, keepWiderExisting: true, tokenDeps: deps });
      expect(result).toMatchObject({ ok: true, accounts: [], kept: ['5001'], replaced: [] });
      expect(deps.refresh).toHaveBeenCalledTimes(1);
      expect(deps.saveTokens).toHaveBeenCalledTimes(1);
      expect(createAccount).not.toHaveBeenCalled();
    });

    it('a row whose refresh is rejected is dead and replaced; an unreachable LinkedIn is no answer either way, so nothing is written', async () => {
      (getAccountsByUserId as jest.Mock).mockResolvedValue([portalRow({ token_expires_at: Date.now() - 1000 })]);
      jest.spyOn(console, 'error').mockImplementation(() => undefined);
      let finalized = await narrowGrant();
      const rejected = Object.assign(new Error('Request failed with status code 400'), { response: { status: 400 } });
      const dead: any = await connectLinkedInAdsAccounts({
        userId: 'u1', tokenSessionId: finalized.tokenSessionId, accounts: choice, keepWiderExisting: true, tokenDeps: tokenDeps({ refresh: jest.fn().mockRejectedValue(rejected) }),
      });
      expect(dead).toMatchObject({ ok: true, kept: [], replaced: ['5001'] });
      expect(createAccount).toHaveBeenCalledTimes(1);
      (createAccount as jest.Mock).mockClear();
      finalized = await narrowGrant();
      await expect(connectLinkedInAdsAccounts({
        userId: 'u1', tokenSessionId: finalized.tokenSessionId, accounts: choice, keepWiderExisting: true, tokenDeps: tokenDeps({ refresh: jest.fn().mockRejectedValue(new Error('ECONNRESET')) }),
      })).rejects.toMatchObject({ kind: 'temporary' });
      expect(createAccount).not.toHaveBeenCalled();
    });
  });

  it('a grant that covers everything the row holds replaces it (the reconnect is allowed to refresh the token); another account is unaffected', async () => {
    process.env.ZOMA_LINKEDIN_ADS_ENABLED = 'read';
    (getAccountsByUserId as jest.Mock).mockResolvedValue([portalRow()]);
    mockAxiosPost.mockResolvedValue({ data: { access_token: 'ZOMA-ACCESS', refresh_token: 'ZOMA-REFRESH', expires_in: 3600, scope: PORTAL_SCOPES.join(',') } });
    let finalized = await defaultZomaLinkedInAdsDeps.finalize('u1', 'c');
    const result: any = await defaultZomaLinkedInAdsDeps.connect('u1', finalized.tokenSessionId, [{ adAccountId: '5001', adAccountName: 'Acme', currency: 'EUR', status: 'ACTIVE' }]);
    expect(result).toMatchObject({ ok: true, kept: [] });
    expect((createAccount as jest.Mock).mock.calls.at(-1)![2].config.scopes).toEqual(PORTAL_SCOPES);
    // a narrower grant for an account the user does not hold yet is simply saved
    mockAxiosPost.mockResolvedValue({ data: { access_token: 'a', refresh_token: 'r', expires_in: 3600, scope: 'r_ads' } });
    finalized = await defaultZomaLinkedInAdsDeps.finalize('u1', 'c');
    const other: any = await defaultZomaLinkedInAdsDeps.connect('u1', finalized.tokenSessionId, [{ adAccountId: '9999', adAccountName: 'Other', currency: 'USD', status: 'ACTIVE' }]);
    expect(other.kept).toEqual([]);
    expect((createAccount as jest.Mock).mock.calls.at(-1)![2]).toMatchObject({ account_id: '9999', config: { scopes: ['r_ads'] } });
  });

  it('the portal connect is unchanged: it replaces the row as it always did', async () => {
    (getAccountsByUserId as jest.Mock).mockResolvedValue([portalRow()]);
    const app = portalApp();
    const fin = await request(app).post('/finalize').send({ code: 'c', state: portalState('u1') });
    const res = await request(app).post('/connect').send({ tokenSessionId: fin.body.tokenSessionId, adAccountId: '5001', adAccountName: 'Acme', currency: 'EUR' });
    expect(res.status).toBe(200);
    expect(createAccount).toHaveBeenCalledTimes(1);
  });
});
