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
  getAccountsByUserId: jest.fn().mockResolvedValue([]),
}));

jest.mock('../services/googleAdsService', () => ({
  googleAdsService: {
    listAccountHierarchy: jest.fn().mockResolvedValue([
      { type: 'leaf', customerId: '1234567890', name: 'Test Account', currency: 'USD', loginCustomerId: '1234567890' },
      { type: 'manager', customerId: '999', name: 'MCC', children: [
        { customerId: '222', name: 'Child A', currency: 'USD', loginCustomerId: '999' },
      ] },
    ]),
    flattenConnectableLeaves: jest.fn((nodes: any[]) => {
      const out: any[] = [];
      for (const n of nodes) {
        if (n.type === 'leaf') out.push({ customerId: n.customerId, name: n.name, currency: n.currency, loginCustomerId: n.loginCustomerId });
        else out.push(...n.children);
      }
      return out;
    }),
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
  it('returns accountTree and tokenSessionId on valid code + state', async () => {
    const state = makeState('user-123');
    const res = await request(app)
      .post('/finalize')
      .send({ code: 'auth-code', state })
      .expect(200);
    expect(res.body.success).toBe(true);
    expect(res.body.accountTree).toHaveLength(2);
    expect(res.body.accountTree[0]).toMatchObject({ type: 'leaf', customerId: '1234567890', alreadyConnected: false });
    expect(res.body.accountTree[1]).toMatchObject({ type: 'manager', customerId: '999' });
    expect(res.body.accountTree[1].children[0]).toMatchObject({ customerId: '222', alreadyConnected: false });
    expect(res.body.tokenSessionId).toBeDefined();
  });

  it('marks already-connected leaves', async () => {
    const { getAccountsByUserId } = require('../services/connectedAccountsDb');
    (getAccountsByUserId as jest.Mock).mockResolvedValueOnce([
      { platform: 'google_ads', account_id: '222' },
    ]);
    const state = makeState('user-123');
    const res = await request(app)
      .post('/finalize')
      .send({ code: 'auth-code', state })
      .expect(200);
    expect(res.body.accountTree[0].alreadyConnected).toBe(false); // 1234567890 not connected
    expect(res.body.accountTree[1].children[0].alreadyConnected).toBe(true); // 222 connected
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
  it('stores multiple selected leaves (standalone + managed) and returns the count', async () => {
    const state = makeState('user-123');
    const finalizeRes = await request(app)
      .post('/finalize')
      .send({ code: 'auth-code', state })
      .expect(200);

    const res = await request(app)
      .post('/connect')
      .send({
        tokenSessionId: finalizeRes.body.tokenSessionId,
        customerIds: ['1234567890', '222'],
      })
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.connected).toBe(2);
    expect(createAccount).toHaveBeenCalledTimes(2);
    // standalone leaf: login_customer_id equals its own id
    expect(createAccount).toHaveBeenCalledWith('user-123', 'google_ads', expect.objectContaining({
      account_id: '1234567890',
      config: expect.objectContaining({ customer_id: '1234567890', login_customer_id: '1234567890' }),
    }));
    // managed leaf: login_customer_id is the manager id
    expect(createAccount).toHaveBeenCalledWith('user-123', 'google_ads', expect.objectContaining({
      account_id: '222',
      config: expect.objectContaining({ customer_id: '222', login_customer_id: '999' }),
    }));
  });

  it('returns 400 when customerIds is missing or empty', async () => {
    const state = makeState('user-123');
    const finalizeRes = await request(app)
      .post('/finalize')
      .send({ code: 'auth-code', state })
      .expect(200);

    await request(app)
      .post('/connect')
      .send({ tokenSessionId: finalizeRes.body.tokenSessionId, customerIds: [] })
      .expect(400);
    expect(createAccount).not.toHaveBeenCalled();
  });

  it('returns 401 for expired or invalid tokenSessionId', async () => {
    const res = await request(app)
      .post('/connect')
      .send({ tokenSessionId: 'bad-session', customerIds: ['123'] })
      .expect(401);
    expect(res.body.error).toMatch(/invalid or expired/i);
  });

  it('returns 400 (and saves nothing) when any customerId is not in the session', async () => {
    const state = makeState('user-123');
    const finalizeRes = await request(app)
      .post('/finalize')
      .send({ code: 'auth-code', state })
      .expect(200);

    const res = await request(app)
      .post('/connect')
      .send({
        tokenSessionId: finalizeRes.body.tokenSessionId,
        customerIds: ['1234567890', '9999999999'], // second one is a ghost
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
      .send({ tokenSessionId, customerIds: ['1234567890'] })
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
