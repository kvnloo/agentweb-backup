// ENG-3043: LinkedIn and LinkedIn Ads pending OAuth sessions live in the shared
// AW-OAuthSessions row, so /finalize and /connect may land on different backend instances.
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createOAuthSessionDbMock } from './fixtures/oauthSessionDb';
import { getJwtSecret } from '../config/jwt';

const mockDb = createOAuthSessionDbMock();
jest.mock('../services/db', () => ({ oauthSessionDb: mockDb }));
jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = { userId: req.headers['x-user'] || 'user-123' }; next();
  },
}));
jest.mock('../config/integrations', () => {
  const linkedin = {
    clientId: 'li-client', clientSecret: 'li-secret', redirectUri: 'https://api.example.com/api/oauth/linkedin/callback',
    authorizationUrl: 'https://www.linkedin.com/oauth/v2/authorization', tokenUrl: 'https://www.linkedin.com/oauth/v2/accessToken',
    scopes: ['openid', 'profile', 'w_member_social'],
  };
  const ads = { ...linkedin, clientId: 'ads-client', redirectUri: 'https://api.example.com/api/oauth/linkedin-ads/callback', scopes: ['r_ads', 'rw_ads'] };
  return {
    getLinkedInConfig: async () => linkedin,
    getLinkedInAdsConfig: async () => ads,
    getLinkedInScopesForType: (type: string) => (type === 'company' ? ['w_organization_social'] : ['openid', 'profile']),
  };
});
const mockAxiosPost = jest.fn();
jest.mock('axios', () => ({
  post: (...args: any[]) => mockAxiosPost(...args),
  get: jest.fn(async () => ({ data: { id: 'member1' } })),
}));
jest.mock('../services/linkedInService', () => ({
  linkedInService: {
    getProfile: jest.fn(async () => ({ sub: 'abc', name: 'Ada', email: 'ada@example.com' })),
    getProfilePicture: jest.fn(async () => 'https://example.com/ada.png'),
    getAdminOrganizationDetails: jest.fn(async () => [{ urn: 'urn:li:organization:9', id: '9', name: 'Org' }]),
  },
}));
jest.mock('../services/linkedInAdsService', () => ({
  listAdAccounts: jest.fn(async () => ({
    success: true,
    data: { elements: [{ id: 111, name: 'Ads', currency: 'USD', status: 'ACTIVE', reference: 'urn:li:organization:9' }] },
  })),
}));
const mockCreateAccount = jest.fn(async (..._args: any[]) => ({ account_id: 'account', config: {} }));
jest.mock('../services/connectedAccountsDb', () => ({
  createAccount: (...args: any[]) => mockCreateAccount(...args),
  getAccountsByUserId: jest.fn(async () => []),
}));
jest.mock('../services/approvalInboxCustomerNotify', () => ({ safeAutoResolveCredentialDecision: jest.fn() }));

const PROVIDERS = [
  {
    route: 'linkedinAuth', provider: 'linkedin', connectPath: '/connect-accounts',
    body: { personal: true, profile: { urn: 'urn:li:person:abc', name: 'Ada', picture: 'https://example.com/ada.png' } },
    expectedRow: ['linkedin', {
      account_id: 'urn:li:person:abc', account_name: 'Ada',
      config: {
        account_type: 'personal', profile_id: 'urn:li:person:abc', profile_image_url: 'https://example.com/ada.png',
        access_token: 'access', refresh_token: 'refresh', token_expires_at: expect.any(Number), scopes: ['openid', 'profile', 'w_member_social'],
      },
    }],
  },
  {
    route: 'linkedInAdsAuth', provider: 'linkedin_ads', connectPath: '/connect',
    body: { adAccountId: '111', adAccountName: 'Ads', currency: 'USD', status: 'ACTIVE' },
    expectedRow: ['linkedin_ads', {
      account_id: '111', account_name: 'Ads',
      config: {
        account_type: 'ad_account', currency: 'USD', status: 'ACTIVE', access_token: 'access', refresh_token: 'refresh',
        token_expires_at: expect.any(Number), scopes: ['r_ads', 'rw_ads'],
        organization_urn: 'urn:li:organization:9', person_urn: 'urn:li:person:member1',
      },
    }],
  },
];
const EXPIRED = 'Invalid or expired token session. Please reconnect.';

function instance(route: string) {
  const app = express();
  jest.isolateModules(() => {
    app.use(express.json(), require(`../routes/${route}`).default);
  });
  return app;
}
const finalize = (app: express.Express, userId = 'user-123') =>
  request(app).post('/finalize').set('x-user', userId)
    .send({ code: 'code', state: jwt.sign({ userId, nonce: 'n' }, getJwtSecret(), { expiresIn: '15m' }) });

describe.each(PROVIDERS)('$provider pending OAuth sessions', ({ route, provider, connectPath, body, expectedRow }) => {
  beforeEach(() => {
    mockDb.rows.clear();
    jest.clearAllMocks();
    mockAxiosPost.mockResolvedValue({ data: { access_token: 'access', refresh_token: 'refresh', expires_in: 3600 } });
  });
  afterEach(() => jest.restoreAllMocks());
  const connect = (app: express.Express, tokenSessionId: unknown, userId = 'user-123') =>
    request(app).post(connectPath).set('x-user', userId).send({ ...body, tokenSessionId });

  // Characterization (passes on main, single instance): redirect URI, scopes, stored row and one-time use.
  it('exchanges the code with the configured redirect URI and writes the same connected account once', async () => {
    const a = instance(route);
    const init = await request(a).get('/init');
    const url = new URL(init.body.url);
    expect(url.searchParams.get('redirect_uri')).toBe(`https://api.example.com/api/oauth/${route === 'linkedinAuth' ? 'linkedin' : 'linkedin-ads'}/callback`);
    expect(url.searchParams.get('scope')).toBe(route === 'linkedinAuth' ? 'openid profile w_member_social' : 'r_ads rw_ads');

    const callback = await request(a).get('/callback').query({ code: 'c1', state: 's1' });
    expect(callback.status).toBe(302);
    expect(callback.headers.location).toBe(`http://localhost:5174/oauth/${route === 'linkedinAuth' ? 'linkedin' : 'linkedin-ads'}/callback?code=c1&state=s1`);

    const result = await finalize(a);
    expect(result.status).toBe(200);
    expect(result.body.tokenSessionId).toMatch(/^[a-f0-9]{64}$/);
    expect(mockAxiosPost.mock.calls[0][2].params.redirect_uri).toBe(url.searchParams.get('redirect_uri'));

    expect((await connect(a, result.body.tokenSessionId)).status).toBe(200);
    expect(mockCreateAccount).toHaveBeenCalledTimes(1);
    expect(mockCreateAccount).toHaveBeenCalledWith('user-123', ...expectedRow);

    const replay = await connect(a, result.body.tokenSessionId);
    expect(replay.status).toBe(401);
    expect(replay.body.error).toBe(EXPIRED);
    expect(mockCreateAccount).toHaveBeenCalledTimes(1);
  });

  it('rejects a different user with the reconnect response', async () => {
    const { body: fin } = await finalize(instance(route));
    const res = await connect(instance(route), fin.tokenSessionId, 'other');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe(EXPIRED);
    expect(mockCreateAccount).not.toHaveBeenCalled();
  });

  it('rejects a session after the 10-minute TTL with the reconnect response', async () => {
    const a = instance(route);
    const { body: fin } = await finalize(a);
    jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 600001);
    const res = await connect(a, fin.tokenSessionId);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe(EXPIRED);
    expect(mockCreateAccount).not.toHaveBeenCalled();
  });

  // ENG-3043: shared store behaviour.
  it('finalizes on one instance, connects on a fresh one, and cannot replay on either', async () => {
    const a = instance(route);
    const b = instance(route);
    const { body: fin } = await finalize(a);
    expect(mockDb.rows.get(fin.tokenSessionId).provider).toBe(provider);
    expect((await connect(b, fin.tokenSessionId)).status).toBe(200);
    expect(mockCreateAccount).toHaveBeenCalledWith('user-123', ...expectedRow);
    for (const app of [b, a]) {
      const replay = await connect(app, fin.tokenSessionId);
      expect(replay.status).toBe(401);
      expect(replay.body.error).toBe(EXPIRED);
    }
    expect(mockCreateAccount).toHaveBeenCalledTimes(1);
  });

  it('a different user does not consume the rightful user session', async () => {
    const a = instance(route);
    const { body: fin } = await finalize(a);
    expect((await connect(a, fin.tokenSessionId, 'other')).status).toBe(401);
    expect((await connect(instance(route), fin.tokenSessionId)).status).toBe(200);
  });

  it('does not accept a session stored for the other LinkedIn provider', async () => {
    const a = instance(route);
    const { body: fin } = await finalize(a);
    mockDb.rows.get(fin.tokenSessionId).provider = provider === 'linkedin' ? 'linkedin_ads' : 'linkedin';
    expect((await connect(a, fin.tokenSessionId)).status).toBe(401);
  });

  it.each([null, 'wrong-type', { tokens: true }, { userId: 'user-123', expires: 9e15, tokens: { access_token: 'access', expires_in: 3600 } }])(
    'rejects a malformed stored payload: %p', async payload => {
      const a = instance(route);
      const { body: fin } = await finalize(a);
      mockDb.rows.get(fin.tokenSessionId).payload = payload;
      expect((await connect(a, fin.tokenSessionId)).status).toBe(401);
      expect(mockCreateAccount).not.toHaveBeenCalled();
    });

  it('returns 500 on a store write outage without returning a session id', async () => {
    mockDb.save.mockRejectedValueOnce(new Error('Dynamo unavailable'));
    const result = await finalize(instance(route));
    expect(result.status).toBe(500);
    expect(result.body.tokenSessionId).toBeUndefined();
  });

  it('returns 500 on a store read outage, not a missing session', async () => {
    const a = instance(route);
    const { body: fin } = await finalize(a);
    mockDb.consume.mockRejectedValueOnce(new Error('Dynamo unavailable'));
    expect((await connect(a, fin.tokenSessionId)).status).toBe(500);
    expect(mockCreateAccount).not.toHaveBeenCalled();
  });
});
