jest.mock('../config/integrations', () => ({
  getGoogleAdsConfig: jest.fn().mockResolvedValue({
    clientId: 'test-client-id',
    clientSecret: 'test-client-secret',
    redirectUri: 'http://localhost:3001/api/oauth/google-ads/callback',
    scopes: ['https://www.googleapis.com/auth/adwords'],
    authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
  }),
}));

const mockAxiosPost = jest.fn();
jest.mock('axios', () => ({
  post: (...args: any[]) => mockAxiosPost(...args),
  get: jest.fn(),
}));

jest.mock('../services/connectedAccountsDb', () => ({
  createAccount: jest.fn().mockResolvedValue({ platform: 'google_ads', account_id: '1234567890' }),
  deleteAccountById: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../services/googleAdsService', () => ({
  googleAdsService: {
    listAccessibleAccounts: jest.fn().mockResolvedValue([
      { customerId: '1234567890', name: 'Test Account', currency: 'USD' },
    ]),
  },
}));

jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = { userId: 'user-123' };
    next();
  },
}));

import request from 'supertest';
import express from 'express';
import router from '../routes/googleAdsAuth';
import { createAccount, deleteAccountById } from '../services/connectedAccountsDb';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
const app = express();
app.use(express.json());
app.use('/', router);

const makeState = (userId: string, expiresIn: jwt.SignOptions['expiresIn'] = '15m') =>
  jwt.sign({ userId, nonce: 'abc123' }, JWT_SECRET, { expiresIn });

beforeEach(() => {
  jest.clearAllMocks();
  mockAxiosPost.mockResolvedValue({
    data: { access_token: 'gads-token', refresh_token: 'gads-refresh', expires_in: 3600 },
  });
});

describe('GET /init', () => {
  it('returns a Google OAuth URL containing accounts.google.com and adwords', async () => {
    const res = await request(app).get('/init').expect(200);
    expect(res.body.success).toBe(true);
    expect(res.body.url).toContain('accounts.google.com');
    expect(res.body.url).toContain('adwords');
  });
});

describe('GET /callback', () => {
  it('redirects to frontend with code and state on success', async () => {
    const res = await request(app)
      .get('/callback?code=auth-code&state=somestate')
      .expect(302);
    expect(res.headers.location).toContain('code=auth-code');
    expect(res.headers.location).toContain('state=somestate');
  });

  it('redirects with error on access_denied', async () => {
    const res = await request(app)
      .get('/callback?error=access_denied')
      .expect(302);
    expect(res.headers.location).toContain('error=google_ads_access_denied');
  });
});

describe('POST /finalize', () => {
  it('returns adAccounts and tokenSessionId on valid code + state', async () => {
    const state = makeState('user-123');
    const res = await request(app)
      .post('/finalize')
      .send({ code: 'auth-code', state })
      .expect(200);
    expect(res.body.success).toBe(true);
    expect(res.body.adAccounts).toHaveLength(1);
    expect(res.body.tokenSessionId).toBeDefined();
  });

  it('returns 403 for invalid state', async () => {
    const res = await request(app)
      .post('/finalize')
      .send({ code: 'auth-code', state: 'bad-state' })
      .expect(403);
    expect(res.body.error).toMatch(/invalid or expired/i);
  });

  it('returns 400 for missing code', async () => {
    const state = makeState('user-123');
    await request(app).post('/finalize').send({ state }).expect(400);
  });
});

describe('POST /connect', () => {
  it('stores selected account and returns success', async () => {
    const state = makeState('user-123');
    const finalizeRes = await request(app)
      .post('/finalize')
      .send({ code: 'auth-code', state })
      .expect(200);

    const res = await request(app)
      .post('/connect')
      .send({
        tokenSessionId: finalizeRes.body.tokenSessionId,
        customerId: '1234567890',
        accountName: 'Test Account',
        currency: 'USD',
      })
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(createAccount).toHaveBeenCalledWith('user-123', 'google_ads', expect.objectContaining({
      account_id: '1234567890',
    }));
  });

  it('returns 401 for expired or invalid tokenSessionId', async () => {
    const res = await request(app)
      .post('/connect')
      .send({ tokenSessionId: 'bad-session', customerId: '123' })
      .expect(401);
    expect(res.body.error).toMatch(/invalid or expired/i);
  });
});

describe('DELETE /disconnect', () => {
  it('removes the account', async () => {
    const res = await request(app)
      .delete('/disconnect')
      .send({ customerId: '1234567890' })
      .expect(200);
    expect(res.body.success).toBe(true);
    expect(deleteAccountById).toHaveBeenCalledWith('user-123', 'google_ads', '1234567890');
  });
});
