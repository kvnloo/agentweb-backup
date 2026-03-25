/**
 * Tests for routes/linkedInAdsAuth.ts — OAuth flow endpoints
 */

jest.mock('../config/integrations', () => ({
  getLinkedInAdsConfig: jest.fn().mockResolvedValue({
    clientId: 'test-client-id',
    clientSecret: 'test-client-secret',
    redirectUri: 'http://localhost:3001/api/oauth/linkedin-ads/callback',
    scopes: ['r_ads', 'rw_ads'],
    authorizationUrl: 'https://www.linkedin.com/oauth/v2/authorization',
    tokenUrl: 'https://www.linkedin.com/oauth/v2/accessToken',
    profileUrl: 'https://api.linkedin.com/v2/userinfo',
    apiBaseUrl: 'https://api.linkedin.com',
    apiVersion: '202603',
  }),
}));

jest.mock('../services/linkedInAdsService', () => ({
  listAdAccounts: jest.fn().mockResolvedValue({
    success: true,
    data: {
      elements: [
        { id: 'urn:li:sponsoredAccount:111', name: 'Test Ad Account', currency: 'USD', status: 'ACTIVE' },
      ],
    },
  }),
}));

const mockAxiosPost = jest.fn();
jest.mock('axios', () => ({
  default: { post: (...args: any[]) => mockAxiosPost(...args) },
  post: (...args: any[]) => mockAxiosPost(...args),
}));

jest.mock('../services/connectedAccountsDb', () => ({
  createAccount: jest.fn().mockResolvedValue({
    platform: 'linkedin_ads',
    account_id: 'urn:li:sponsoredAccount:111',
    account_name: 'Test Ad Account',
  }),
}));

jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = { userId: 'user-123' };
    next();
  },
}));

import request from 'supertest';
import express from 'express';
import router from '../routes/linkedInAdsAuth';
import * as linkedInAdsService from '../services/linkedInAdsService';
import { createAccount } from '../services/connectedAccountsDb';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

const app = express();
app.use(express.json());
app.use('/', router);

const makeState = (userId: string, expiresIn = '15m') =>
  jwt.sign({ userId, nonce: 'abc123' }, JWT_SECRET, { expiresIn });

beforeEach(() => {
  jest.clearAllMocks();
  mockAxiosPost.mockResolvedValue({
    data: { access_token: 'li-token', refresh_token: 'li-refresh', expires_in: 5183944 },
  });
  (linkedInAdsService.listAdAccounts as jest.Mock).mockResolvedValue({
    success: true,
    data: { elements: [{ id: 'urn:li:sponsoredAccount:111', name: 'Test Ad Account', currency: 'USD', status: 'ACTIVE' }] },
  });
  (createAccount as jest.Mock).mockResolvedValue({
    platform: 'linkedin_ads',
    account_id: 'urn:li:sponsoredAccount:111',
    account_name: 'Test Ad Account',
  });
});

// ── GET /init ─────────────────────────────────────────────────────────────────

describe('GET /init', () => {
  it('returns OAuth URL', async () => {
    const res = await request(app).get('/init');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.url).toContain('https://www.linkedin.com/oauth/v2/authorization');
  });

  it('URL contains client_id and redirect_uri', async () => {
    const res = await request(app).get('/init');
    expect(res.body.url).toContain('client_id=test-client-id');
    expect(res.body.url).toContain(encodeURIComponent('http://localhost:3001/api/oauth/linkedin-ads/callback'));
  });

  it('URL contains state parameter', async () => {
    const res = await request(app).get('/init');
    expect(res.body.url).toContain('state=');
  });

  it('URL contains all required scopes', async () => {
    const res = await request(app).get('/init');
    expect(res.body.url).toContain('r_ads');
    expect(res.body.url).toContain('rw_ads');
  });
});

// ── GET /callback ─────────────────────────────────────────────────────────────

describe('GET /callback', () => {
  const FRONTEND_URL = process.env.CUSTOMER_FRONTEND_URL || 'http://localhost:5174';

  it('redirects to frontend callback with code and state', async () => {
    const res = await request(app).get('/callback?code=auth-code-123&state=test-state');
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain(`${FRONTEND_URL}/oauth/linkedin-ads/callback`);
    expect(res.headers.location).toContain('code=auth-code-123');
    expect(res.headers.location).toContain('state=test-state');
  });

  it('redirects with error when access denied', async () => {
    const res = await request(app).get('/callback?error=access_denied');
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('error=linkedin_ads_access_denied');
  });

  it('redirects with error when no code provided', async () => {
    const res = await request(app).get('/callback?state=test-state');
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('error=no_code_provided');
  });
});

// ── POST /finalize ────────────────────────────────────────────────────────────

describe('POST /finalize', () => {
  it('exchanges code for token and returns adAccounts + tokenSessionId', async () => {
    const state = makeState('user-123');
    const res = await request(app).post('/finalize').send({ code: 'auth-code', state });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.adAccounts).toBeDefined();
    expect(res.body.tokenSessionId).toBeTruthy();
  });

  it('calls token endpoint with correct params', async () => {
    const state = makeState('user-123');
    await request(app).post('/finalize').send({ code: 'my-code', state });
    expect(mockAxiosPost).toHaveBeenCalledWith(
      'https://www.linkedin.com/oauth/v2/accessToken',
      null,
      expect.objectContaining({
        params: expect.objectContaining({
          grant_type: 'authorization_code',
          code: 'my-code',
          client_id: 'test-client-id',
        }),
      })
    );
  });

  it('returns 400 when code is missing', async () => {
    const state = makeState('user-123');
    const res = await request(app).post('/finalize').send({ state });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('code');
  });

  it('returns 400 when state is missing', async () => {
    const res = await request(app).post('/finalize').send({ code: 'auth-code' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('state');
  });

  it('returns 403 when state userId does not match authenticated user', async () => {
    const state = makeState('different-user');
    const res = await request(app).post('/finalize').send({ code: 'code', state });
    expect(res.status).toBe(403);
    expect(res.body.error).toContain('state');
  });

  it('returns 403 when state token is expired', async () => {
    const state = makeState('user-123', '-1s');
    const res = await request(app).post('/finalize').send({ code: 'code', state });
    expect(res.status).toBe(403);
  });

  it('calls listAdAccounts with the received access token', async () => {
    const state = makeState('user-123');
    await request(app).post('/finalize').send({ code: 'code', state });
    expect(linkedInAdsService.listAdAccounts).toHaveBeenCalledWith('li-token');
  });
});

// ── POST /connect ─────────────────────────────────────────────────────────────

describe('POST /connect', () => {
  const getValidSessionId = async () => {
    const state = makeState('user-123');
    const res = await request(app).post('/finalize').send({ code: 'code', state });
    return res.body.tokenSessionId;
  };

  it('saves connected account and returns success', async () => {
    const tokenSessionId = await getValidSessionId();
    const res = await request(app).post('/connect').send({
      tokenSessionId,
      adAccountId: 'urn:li:sponsoredAccount:111',
      adAccountName: 'Test Ad Account',
      currency: 'USD',
      status: 'ACTIVE',
    });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.account).toBeDefined();
  });

  it('calls createAccount with correct platform', async () => {
    const tokenSessionId = await getValidSessionId();
    await request(app).post('/connect').send({
      tokenSessionId,
      adAccountId: 'urn:li:sponsoredAccount:111',
      adAccountName: 'Test Ad Account',
    });
    expect(createAccount).toHaveBeenCalledWith(
      'user-123',
      'linkedin_ads',
      expect.objectContaining({
        account_id: 'urn:li:sponsoredAccount:111',
        account_name: 'Test Ad Account',
      })
    );
  });

  it('stores access token in config', async () => {
    const tokenSessionId = await getValidSessionId();
    await request(app).post('/connect').send({
      tokenSessionId,
      adAccountId: 'urn:li:sponsoredAccount:111',
    });
    expect(createAccount).toHaveBeenCalledWith(
      'user-123',
      'linkedin_ads',
      expect.objectContaining({
        config: expect.objectContaining({ access_token: 'li-token' }),
      })
    );
  });

  it('returns 400 when tokenSessionId is missing', async () => {
    const res = await request(app).post('/connect').send({ adAccountId: 'urn:li:sponsoredAccount:111' });
    expect(res.status).toBe(400);
  });

  it('returns 400 when adAccountId is missing', async () => {
    const tokenSessionId = await getValidSessionId();
    const res = await request(app).post('/connect').send({ tokenSessionId });
    expect(res.status).toBe(400);
  });

  it('returns 401 when tokenSessionId is invalid', async () => {
    const res = await request(app).post('/connect').send({
      tokenSessionId: 'invalid-session-id',
      adAccountId: 'urn:li:sponsoredAccount:111',
    });
    expect(res.status).toBe(401);
    expect(res.body.error).toContain('Invalid or expired token session');
  });

  it('token session is one-time use', async () => {
    const tokenSessionId = await getValidSessionId();
    await request(app).post('/connect').send({ tokenSessionId, adAccountId: 'urn:li:sponsoredAccount:111' });
    const secondRes = await request(app).post('/connect').send({ tokenSessionId, adAccountId: 'urn:li:sponsoredAccount:111' });
    expect(secondRes.status).toBe(401);
  });
});
