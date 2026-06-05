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
}));

jest.mock('../services/googleAdsService', () => ({
  googleAdsService: {
    listAccessibleAccounts: jest.fn().mockResolvedValue([
      { customerId: '1234567890', name: 'Test Account', currency: 'USD' },
    ]),
  },
}));

let mockAuthUserId = 'user-123';
jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = { userId: mockAuthUserId };
    next();
  },
}));

import request from 'supertest';
import express from 'express';
import router from '../routes/googleAdsAuth';
import { createAccount } from '../services/connectedAccountsDb';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
const app = express();
app.use(express.json());
app.use('/', router);

const makeState = (userId: string, expiresIn: jwt.SignOptions['expiresIn'] = '15m') =>
  jwt.sign({ userId, nonce: 'abc123' }, JWT_SECRET, { expiresIn });

beforeEach(() => {
  mockAuthUserId = 'user-123';
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
    expect(res.headers.location).toContain('error=access_denied');
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

  it('returns 400 when customerId is not in the session adAccounts', async () => {
    const state = makeState('user-123');
    const finalizeRes = await request(app)
      .post('/finalize')
      .send({ code: 'auth-code', state })
      .expect(200);

    const res = await request(app)
      .post('/connect')
      .send({
        tokenSessionId: finalizeRes.body.tokenSessionId,
        customerId: '9999999999', // not in mocked adAccounts
        accountName: 'Ghost Account',
        currency: 'USD',
      })
      .expect(400);

    expect(res.body.error).toMatch(/not found in your authorized accounts/i);
    expect(createAccount).not.toHaveBeenCalled();
  });

});


describe('Cross-user session-theft blocked', () => {
  it('rejects a tokenSessionId issued to user-123 when presented by user-456', async () => {
    // Obtain a tokenSessionId bound to user-123
    const state = makeState('user-123');
    const finalizeRes = await request(app)
      .post('/finalize')
      .send({ code: 'auth-code', state })
      .expect(200);
    const { tokenSessionId } = finalizeRes.body;

    // Switch auth identity to user-456 and attempt to redeem user-123's session
    mockAuthUserId = 'user-456';
    const res = await request(app)
      .post('/connect')
      .send({ tokenSessionId, customerId: '1234567890', accountName: 'Test Account', currency: 'USD' })
      .expect(401);
    expect(res.body.error).toMatch(/invalid or expired/i);
  });
});

describe('GET /callback URL encoding', () => {
  it('encodes special characters in code and state query params', async () => {
    const res = await request(app)
      .get('/callback?code=auth+code&state=foo+bar')
      .expect(302);
    const location = res.headers.location as string;
    // The raw '+' in the original query string must not appear literally in the
    // code parameter position of the redirect URL — it must be percent-encoded.
    const codeMatch = location.match(/[?&]code=([^&]*)/);
    expect(codeMatch).not.toBeNull();
    expect(codeMatch![1]).not.toContain('+');
  });
});
