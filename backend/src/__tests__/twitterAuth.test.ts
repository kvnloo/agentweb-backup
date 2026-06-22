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
