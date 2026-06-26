import request from 'supertest';
import express from 'express';

// ── Mocks ──────────────────────────────────────────────────────────────────
const mockGenerateOAuth2AuthLink = jest.fn();
const mockLoginWithOAuth2 = jest.fn();
const mockMe = jest.fn();

jest.mock('twitter-api-v2', () => ({
  TwitterApi: jest.fn().mockImplementation(() => ({
    generateOAuth2AuthLink: (...a: any[]) => mockGenerateOAuth2AuthLink(...a),
    loginWithOAuth2: (...a: any[]) => mockLoginWithOAuth2(...a),
  })),
}), { virtual: true });

jest.mock('../utils/secretsManager', () => ({
  getTwitterCredentials: jest.fn().mockResolvedValue({ clientId: 'cid', clientSecret: 'csecret' }),
}));

const mockCreateAccount = jest.fn((...args: any[]) => {
  const input = args[2];
  return Promise.resolve({
    platform: args[1], account_id: input.account_id, account_name: input.account_name, config: input.config,
    created_at: 'now', updated_at: 'now',
  });
});
const mockDeleteAccountById = jest.fn((..._args: any[]) => Promise.resolve(true));
jest.mock('../services/connectedAccountsDb', () => ({
  createAccount: (...a: any[]) => mockCreateAccount(...a),
  deleteAccountById: (...a: any[]) => mockDeleteAccountById(...a),
}));

jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = { userId: 'user-123', email: 'user@example.com' };
    next();
  },
}));

process.env.JWT_SECRET = 'test-jwt-secret';
process.env.CUSTOMER_FRONTEND_URL = 'http://localhost:5174';
process.env.BACKEND_URL = 'http://localhost:3001';

import twitterAuthRouter from '../routes/twitterAuth';

const app = express();
app.use(express.json());
app.use('/api/oauth/twitter', twitterAuthRouter);

beforeEach(() => {
  jest.clearAllMocks();
  mockGenerateOAuth2AuthLink.mockReturnValue({
    url: 'https://twitter.com/i/oauth2/authorize?state=ST8&code_challenge=cc',
    codeVerifier: 'verifier-abc',
    state: 'ST8',
  });
  mockLoginWithOAuth2.mockResolvedValue({
    accessToken: 'acc-tok',
    refreshToken: 'ref-tok',
    expiresIn: 7200,
    client: { v2: { me: (...a: any[]) => mockMe(...a) } },
  });
  mockMe.mockResolvedValue({ data: { id: '999', username: 'handle', name: 'The Handle' } });
});

describe('GET /init', () => {
  it('returns an authorization url', async () => {
    const res = await request(app).get('/api/oauth/twitter/init');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.url).toContain('oauth2');
    expect(mockGenerateOAuth2AuthLink).toHaveBeenCalled();
  });
});

describe('GET /callback', () => {
  it('forwards code and state to the frontend', async () => {
    const res = await request(app).get('/api/oauth/twitter/callback?code=C1&state=ST8');
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('/oauth/twitter/callback');
    expect(res.headers.location).toContain('code=C1');
    expect(res.headers.location).toContain('state=ST8');
  });

  it('redirects with an error when access is denied', async () => {
    const res = await request(app).get('/api/oauth/twitter/callback?error=access_denied');
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('error=');
  });
});

describe('POST /finalize', () => {
  it('400 when code missing', async () => {
    const res = await request(app).post('/api/oauth/twitter/finalize').send({ state: 'ST8' });
    expect(res.status).toBe(400);
  });

  it('400/401 when state is unknown (no stored verifier)', async () => {
    const res = await request(app).post('/api/oauth/twitter/finalize').send({ code: 'C1', state: 'UNKNOWN' });
    expect([400, 401, 403]).toContain(res.status);
  });

  it('exchanges code and creates a twitter account', async () => {
    // First /init to stash the codeVerifier under state ST8.
    await request(app).get('/api/oauth/twitter/init');
    const res = await request(app).post('/api/oauth/twitter/finalize').send({ code: 'C1', state: 'ST8' });
    expect(res.status).toBe(200);
    expect(mockLoginWithOAuth2).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'C1', codeVerifier: 'verifier-abc' })
    );
    expect(mockCreateAccount).toHaveBeenCalledWith(
      'user-123',
      'twitter',
      expect.objectContaining({
        account_id: '999',
        config: expect.objectContaining({ twitter_user_id: '999', username: 'handle', access_token: 'acc-tok', refresh_token: 'ref-tok' }),
      })
    );
    expect(res.body.account.platform).toBe('twitter');
  });

  it('rejects a finalize that reuses an already-consumed state', async () => {
    await request(app).get('/api/oauth/twitter/init');
    await request(app).post('/api/oauth/twitter/finalize').send({ code: 'C1', state: 'ST8' });
    const res = await request(app).post('/api/oauth/twitter/finalize').send({ code: 'C1', state: 'ST8' });
    expect([400, 401, 403]).toContain(res.status); // one-time use
  });
});

describe('POST /reconnect', () => {
  it('returns an authorization url', async () => {
    const res = await request(app).post('/api/oauth/twitter/reconnect');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.url).toContain('oauth2');
    expect(mockGenerateOAuth2AuthLink).toHaveBeenCalled();
  });

  it('returns 500 when getAppClient fails', async () => {
    const { TwitterApi } = require('twitter-api-v2');
    TwitterApi.mockImplementationOnce(() => { throw new Error('credentials unavailable'); });
    const res = await request(app).post('/api/oauth/twitter/reconnect');
    expect(res.status).toBe(500);
  });
});

describe('POST /finalize — 500 error paths', () => {
  it('returns 500 when loginWithOAuth2 throws', async () => {
    await request(app).get('/api/oauth/twitter/init');
    mockLoginWithOAuth2.mockRejectedValueOnce(new Error('X API down'));
    const res = await request(app).post('/api/oauth/twitter/finalize').send({ code: 'C1', state: 'ST8' });
    expect(res.status).toBe(500);
  });

  it('returns 500 when me() throws', async () => {
    await request(app).get('/api/oauth/twitter/init');
    mockMe.mockRejectedValueOnce(new Error('profile fetch failed'));
    const res = await request(app).post('/api/oauth/twitter/finalize').send({ code: 'C1', state: 'ST8' });
    expect(res.status).toBe(500);
  });

  it('returns 500 when createAccount throws', async () => {
    await request(app).get('/api/oauth/twitter/init');
    mockCreateAccount.mockRejectedValueOnce(new Error('DB write failed'));
    const res = await request(app).post('/api/oauth/twitter/finalize').send({ code: 'C1', state: 'ST8' });
    expect(res.status).toBe(500);
  });

  it('does not include OAuth tokens in the success response', async () => {
    await request(app).get('/api/oauth/twitter/init');
    const res = await request(app).post('/api/oauth/twitter/finalize').send({ code: 'C1', state: 'ST8' });
    expect(res.status).toBe(200);
    expect(res.body.account).not.toHaveProperty('config');
    expect(res.body.account).toHaveProperty('platform', 'twitter');
  });
});

describe('PKCE session security', () => {
  it('rejects a finalize with an expired session', async () => {
    await request(app).get('/api/oauth/twitter/init');
    const realNow = Date.now;
    jest.spyOn(Date, 'now').mockReturnValue(realNow() + 16 * 60 * 1000); // past 15-min TTL
    const res = await request(app).post('/api/oauth/twitter/finalize').send({ code: 'C1', state: 'ST8' });
    jest.spyOn(Date, 'now').mockRestore();
    expect([400, 401, 403]).toContain(res.status);
  });

  it('rejects a second finalize with the same state (one-time use)', async () => {
    await request(app).get('/api/oauth/twitter/init');
    await request(app).post('/api/oauth/twitter/finalize').send({ code: 'C1', state: 'ST8' });
    const res = await request(app).post('/api/oauth/twitter/finalize').send({ code: 'C1', state: 'ST8' });
    expect([400, 401, 403]).toContain(res.status);
  });
});

describe('DELETE /disconnect', () => {
  it('removes the connected account', async () => {
    const res = await request(app).delete('/api/oauth/twitter/disconnect').send({ accountId: '999' });
    expect(res.status).toBe(200);
    expect(mockDeleteAccountById).toHaveBeenCalledWith('user-123', 'twitter', '999');
  });

  it('400 when accountId missing', async () => {
    const res = await request(app).delete('/api/oauth/twitter/disconnect').send({});
    expect(res.status).toBe(400);
  });
});
