// ENG-3042: Google Ads, Google Drive and YouTube pending OAuth sessions live in
// the shared AW-OAuthSessions row, so /finalize and /connect may land on
// different backend instances.
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createOAuthSessionDbMock } from './fixtures/oauthSessionDb';
import { getJwtSecret } from '../config/jwt';

const mockDb = createOAuthSessionDbMock();
jest.mock('../services/db', () => ({ oauthSessionDb: mockDb, userDb: {}, orgDb: {} }));
jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = { userId: req.headers['x-user'] || 'user-123' }; next();
  },
}));
jest.mock('../config/integrations', () => {
  const config = {
    clientId: 'client', clientSecret: 'secret', redirectUri: 'https://example.com/callback',
    authorizationUrl: 'https://example.com/auth', tokenUrl: 'https://example.com/token',
    profileUrl: 'https://example.com/profile', channelsUrl: 'https://example.com/channels',
    scopes: ['https://www.googleapis.com/auth/drive.file'],
  };
  return { getGoogleAdsConfig: async () => config, getGoogleDriveConfig: async () => config, getYouTubeConfig: async () => config };
});
jest.mock('axios', () => ({
  post: jest.fn(async () => ({
    data: {
      access_token: 'access', refresh_token: 'refresh', expires_in: 3600,
      scope: ['adwords', 'drive.file', 'youtube', 'youtube.readonly', 'youtube.upload', 'youtube.force-ssl', 'userinfo.email', 'userinfo.profile']
        .map(s => `https://www.googleapis.com/auth/${s}`).join(' '),
    },
  })),
  get: jest.fn(async (url: string) => url.includes('channels')
    ? { data: { items: [{ id: 'UC1', snippet: { title: 'Channel' }, statistics: {} }] } }
    : { data: { email: 'a@example.com', name: 'A' } }),
}));
const mockCreateAccount = jest.fn(async (..._args: any[]) => ({ account_id: 'account', config: {} }));
jest.mock('../services/connectedAccountsDb', () => ({
  createAccount: (...args: any[]) => mockCreateAccount(...args),
  getAccountsByUserId: jest.fn(async () => []),
  getAccountByPlatform: jest.fn(async () => null),
}));
jest.mock('../services/googleAdsService', () => ({
  googleAdsService: {
    listAccountHierarchy: jest.fn(async () => [
      { type: 'leaf', customerId: '111', name: 'Leaf', currency: 'USD', loginCustomerId: '111' },
    ]),
    flattenConnectableLeaves: jest.fn((nodes: any[]) => nodes.map(({ type: _type, ...leaf }) => leaf)),
  },
}));
jest.mock('../services/journeyMilestones', () => ({ zomaMilestone: jest.fn() }));
jest.mock('../services/integrationAccessService', () => ({}));

const PROVIDERS = [
  { route: 'googleAdsAuth', provider: 'google_ads', extra: { customerIds: ['111'] } },
  { route: 'googleDriveAuth', provider: 'google_drive', extra: {} },
  { route: 'youtubeAuth', provider: 'youtube', extra: {} },
];

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

describe.each(PROVIDERS)('$provider shared OAuth sessions', ({ route, provider, extra }) => {
  beforeEach(() => { mockDb.rows.clear(); jest.clearAllMocks(); });
  afterEach(() => jest.restoreAllMocks());
  const connect = (app: express.Express, tokenSessionId: unknown, userId = 'user-123') =>
    request(app).post('/connect').set('x-user', userId).send({ ...extra, tokenSessionId });

  it('finalizes on one instance, connects on a fresh one, and cannot replay on either', async () => {
    const a = instance(route);
    const b = instance(route);
    const result = await finalize(a);
    expect(result.status).toBe(200);
    expect(result.body.tokenSessionId).toMatch(/^[a-f0-9]{64}$/);
    expect(mockDb.rows.get(result.body.tokenSessionId).provider).toBe(provider);

    expect((await connect(b, result.body.tokenSessionId)).status).toBe(200);
    expect(mockCreateAccount).toHaveBeenCalledTimes(1);
    const config = mockCreateAccount.mock.calls[0][2].config;
    expect(config).toMatchObject({ access_token: 'access', refresh_token: 'refresh' });

    for (const app of [b, a]) {
      const replay = await connect(app, result.body.tokenSessionId);
      expect(replay.status).toBe(401);
      expect(replay.body.error).toBe('Invalid or expired token session. Please reconnect.');
    }
    expect(mockCreateAccount).toHaveBeenCalledTimes(1);
  });

  it('rejects a different user without consuming the rightful user session', async () => {
    const a = instance(route);
    const { body } = await finalize(a);
    expect((await connect(a, body.tokenSessionId, 'other')).status).toBe(401);
    expect((await connect(a, body.tokenSessionId)).status).toBe(200);
  });

  it('rejects a session after the 10-minute TTL', async () => {
    const a = instance(route);
    const { body } = await finalize(a);
    jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 600001);
    expect((await connect(a, body.tokenSessionId)).status).toBe(401);
    expect(mockCreateAccount).not.toHaveBeenCalled();
  });

  it('does not accept a session stored for another provider', async () => {
    const a = instance(route);
    const { body } = await finalize(a);
    mockDb.rows.get(body.tokenSessionId).provider = provider === 'youtube' ? 'google_drive' : 'youtube';
    expect((await connect(a, body.tokenSessionId)).status).toBe(401);
  });

  it.each([null, 'wrong-type', { tokens: true }, { userId: 'user-123', expires: 9e15, tokens: { access_token: 'access', expires_in: 3600 } }])(
    'rejects a malformed stored payload: %p', async payload => {
      const a = instance(route);
      const { body } = await finalize(a);
      mockDb.rows.get(body.tokenSessionId).payload = payload;
      expect((await connect(a, body.tokenSessionId)).status).toBe(401);
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
    const { body } = await finalize(a);
    mockDb.consume.mockRejectedValueOnce(new Error('Dynamo unavailable'));
    expect((await connect(a, body.tokenSessionId)).status).toBe(500);
    expect(mockCreateAccount).not.toHaveBeenCalled();
  });
});
