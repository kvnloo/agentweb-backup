import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';

// ── Mocks ──────────────────────────────────────────────────────────────────
jest.mock('../config/integrations', () => ({
  getFathomConfig: jest.fn().mockResolvedValue({
    clientId: 'test-client-id',
    clientSecret: 'test-client-secret',
    redirectUri: 'http://localhost:3001/api/oauth/fathom/callback',
    authorizationUrl: 'https://fathom.video/oauth/authorize',
    tokenUrl: 'https://fathom.video/oauth/token',
    scopes: ['recordings:read', 'webhooks:write'],
  }),
}));

jest.mock('../services/connectedAccountsDb', () => ({
  createAccount: jest.fn(async (_userId: string, platform: string, input: any) => ({
    platform,
    account_id: input.account_id,
    account_name: input.account_name,
    config: input.config,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  })),
  updateAccountConfig: jest.fn(async () => ({})),
}));

// Best-effort webhook registration during /connect — mock it so the route never makes a
// live HTTP call. The default resolves; individual tests can override to prove /connect
// still succeeds when webhook registration fails (it is wrapped in a try/catch that only warns).
const mockRegisterWebhook = jest.fn(async () => ({ id: 'webhook-123' }));
jest.mock('../services/fathomApiService', () => ({
  FathomApiService: jest.fn().mockImplementation(() => ({
    registerWebhook: mockRegisterWebhook,
  })),
}));

jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = { userId: 'user-123', email: 'user@example.com' };
    next();
  },
}));

// OAuth token sessions round-trip through the settings table (shared DynamoDB-backed store)
// so /finalize and /connect can land on different instances (ENG-162). Back it with an
// in-memory map for this route test.
jest.mock('../services/settingsService', () => {
  const store = new Map<string, string>();
  return {
    settingsService: {
      setSetting: jest.fn(async (settingName: string, settingValue: string) => {
        store.set(settingName, settingValue);
      }),
      getSetting: jest.fn(async (settingName: string) => {
        const settingValue = store.get(settingName);
        return settingValue ? { settingName, settingValue } : null;
      }),
      deleteSetting: jest.fn(async (settingName: string) => {
        store.delete(settingName);
      }),
    },
  };
});

jest.mock('axios');
const axios = require('axios');

// ── App setup ──────────────────────────────────────────────────────────────
process.env.JWT_SECRET = 'test-jwt-secret';
process.env.CUSTOMER_FRONTEND_URL = 'http://localhost:5174';

import fathomAuthRouter from '../routes/fathomAuth';
import { createAccount } from '../services/connectedAccountsDb';
import { settingsService } from '../services/settingsService';

const app = express();
app.use(express.json());
app.use('/api/oauth/fathom', fathomAuthRouter);

// ── Helpers ────────────────────────────────────────────────────────────────
const generateValidState = (userId: string) =>
  jwt.sign({ userId, nonce: 'testnonce' }, 'test-jwt-secret', { expiresIn: '15m' });

const mockCreateAccount = createAccount as jest.MockedFunction<typeof createAccount>;

// ── Tests ────────────────────────────────────────────────────────────────
describe('Fathom OAuth Routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRegisterWebhook.mockResolvedValue({ id: 'webhook-123' });
  });

  // ── GET /init ─────────────────────────────────────────────────────────
  describe('GET /init', () => {
    it('returns an authorization URL', async () => {
      const res = await request(app).get('/api/oauth/fathom/init');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.url).toMatch(/fathom\.video/);
    });

    it('URL contains required OAuth params', async () => {
      const res = await request(app).get('/api/oauth/fathom/init');
      const url = new URL(res.body.url);
      expect(url.searchParams.get('response_type')).toBe('code');
      expect(url.searchParams.get('client_id')).toBe('test-client-id');
      expect(url.searchParams.get('redirect_uri')).toBeTruthy();
      expect(url.searchParams.get('state')).toBeTruthy();
      const scope = url.searchParams.get('scope') || '';
      expect(scope).toContain('recordings:read');
    });
  });

  // ── GET /callback ─────────────────────────────────────────────────────
  describe('GET /callback', () => {
    it('redirects with code and state to frontend on success', async () => {
      const res = await request(app)
        .get('/api/oauth/fathom/callback?code=authcode123&state=somestate');
      expect(res.status).toBe(302);
      expect(res.headers.location).toContain('localhost:5174');
      expect(res.headers.location).toContain('code=authcode123');
      expect(res.headers.location).toContain('state=somestate');
    });

    it('redirects with error when Fathom returns error', async () => {
      const res = await request(app)
        .get('/api/oauth/fathom/callback?error=access_denied');
      expect(res.status).toBe(302);
      expect(res.headers.location).toContain('error=fathom_access_denied');
    });

    it('redirects with error when code is missing', async () => {
      const res = await request(app)
        .get('/api/oauth/fathom/callback?state=somestate');
      expect(res.status).toBe(302);
      expect(res.headers.location).toContain('error=no_code_provided');
    });
  });

  // ── POST /finalize ────────────────────────────────────────────────────
  describe('POST /finalize', () => {
    const tokenExchangeResponse = {
      data: { access_token: 'access-tok', refresh_token: 'refresh-tok', expires_in: 3600 },
    };

    it('exchanges code for tokens and returns a tokenSessionId', async () => {
      axios.post.mockResolvedValueOnce(tokenExchangeResponse);
      const state = generateValidState('user-123');
      const res = await request(app)
        .post('/api/oauth/fathom/finalize')
        .send({ code: 'auth-code', state });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.tokenSessionId).toBeTruthy();
    });

    it('returns 400 when code is missing', async () => {
      const state = generateValidState('user-123');
      const res = await request(app)
        .post('/api/oauth/fathom/finalize')
        .send({ state });
      expect(res.status).toBe(400);
    });

    it('returns 400 when state is missing', async () => {
      const res = await request(app)
        .post('/api/oauth/fathom/finalize')
        .send({ code: 'some-code' });
      expect(res.status).toBe(400);
    });

    it('returns 403 when state JWT is invalid (CSRF)', async () => {
      const res = await request(app)
        .post('/api/oauth/fathom/finalize')
        .send({ code: 'some-code', state: 'invalid-state' });
      expect(res.status).toBe(403);
    });

    it('returns 403 when state userId does not match authenticated user', async () => {
      const state = generateValidState('different-user-456');
      const res = await request(app)
        .post('/api/oauth/fathom/finalize')
        .send({ code: 'some-code', state });
      expect(res.status).toBe(403);
    });

    it('returns 500 when Fathom token exchange fails', async () => {
      axios.post.mockRejectedValueOnce(new Error('Fathom API error'));
      const state = generateValidState('user-123');
      const res = await request(app)
        .post('/api/oauth/fathom/finalize')
        .send({ code: 'bad-code', state });
      expect(res.status).toBe(500);
    });

    it('returns an explicit 500 when the shared session store cannot persist tokens', async () => {
      axios.post.mockResolvedValueOnce(tokenExchangeResponse);
      (settingsService.setSetting as jest.Mock).mockRejectedValueOnce(
        new Error('Dynamo write failed'),
      );
      const state = generateValidState('user-123');

      const res = await request(app)
        .post('/api/oauth/fathom/finalize')
        .send({ code: 'auth-code', state });

      expect(res.status).toBe(500);
      expect(res.body.error).toBe('Failed to finalize Fathom connection');
      expect(res.body.tokenSessionId).toBeUndefined();
    });
  });

  // ── POST /connect ─────────────────────────────────────────────────────
  describe('POST /connect', () => {
    const primeSession = async () => {
      axios.post.mockResolvedValueOnce({
        data: { access_token: 'tok', refresh_token: 'ref', expires_in: 3600 },
      });
      const state = generateValidState('user-123');
      const finalizeRes = await request(app)
        .post('/api/oauth/fathom/finalize')
        .send({ code: 'code', state });
      return finalizeRes.body.tokenSessionId as string;
    };

    it('returns 400 when tokenSessionId is missing', async () => {
      const res = await request(app)
        .post('/api/oauth/fathom/connect')
        .send({});
      expect(res.status).toBe(400);
    });

    it('returns 401 when tokenSessionId is invalid or expired', async () => {
      const res = await request(app)
        .post('/api/oauth/fathom/connect')
        .send({ tokenSessionId: 'nonexistent-session' });
      expect(res.status).toBe(401);
    });

    it('returns an explicit 500 when the shared session store cannot be read', async () => {
      (settingsService.getSetting as jest.Mock).mockRejectedValueOnce(
        new Error('Dynamo read failed'),
      );

      const res = await request(app)
        .post('/api/oauth/fathom/connect')
        .send({ tokenSessionId: 'session-id' });

      expect(res.status).toBe(500);
      expect(res.body.error).toBe('Failed to connect Fathom account');
    });

    it('persists the fathom account with the exchanged tokens', async () => {
      const tokenSessionId = await primeSession();

      const res = await request(app)
        .post('/api/oauth/fathom/connect')
        .send({ tokenSessionId });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(mockCreateAccount).toHaveBeenCalledWith(
        'user-123',
        'fathom',
        expect.objectContaining({
          account_id: 'fathom-user-123',
          config: expect.objectContaining({
            account_type: 'oauth',
            access_token: 'tok',
            refresh_token: 'ref',
          }),
        }),
      );
    });

    it('still succeeds when best-effort webhook registration fails', async () => {
      mockRegisterWebhook.mockRejectedValueOnce(new Error('webhook down'));
      const tokenSessionId = await primeSession();

      const res = await request(app)
        .post('/api/oauth/fathom/connect')
        .send({ tokenSessionId });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('is one-time use: a session cannot be replayed', async () => {
      const tokenSessionId = await primeSession();

      const first = await request(app)
        .post('/api/oauth/fathom/connect')
        .send({ tokenSessionId });
      expect(first.status).toBe(200);

      const second = await request(app)
        .post('/api/oauth/fathom/connect')
        .send({ tokenSessionId });
      expect(second.status).toBe(401);
    });
  });
});
