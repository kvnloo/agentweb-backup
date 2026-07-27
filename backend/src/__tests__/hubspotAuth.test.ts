import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';

// ── Mocks ──────────────────────────────────────────────────────────────────
const CRM_SCOPES = [
  'crm.objects.contacts.read',
  'crm.objects.contacts.write',
  'crm.objects.deals.read',
];
const MARKETING_SCOPES = [
  ...CRM_SCOPES,
  'marketing.campaigns.read',
  'marketing.campaigns.write',
  'content',
];
const mockOAuthSessions = new Map<string, any>();

jest.mock('../config/integrations', () => ({
  getHubSpotConfig: jest.fn().mockResolvedValue({
    clientId: 'test-client-id',
    clientSecret: 'test-client-secret',
    redirectUri: 'http://localhost:3001/api/oauth/hubspot/callback',
    authorizationUrl: 'https://app.hubspot.com/oauth/authorize',
    tokenUrl: 'https://api.hubapi.com/oauth/v1/token',
    tokenInfoUrl: 'https://api.hubapi.com/oauth/v1/access-tokens',
    scopes: CRM_SCOPES,
    marketingScopes: MARKETING_SCOPES,
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
}));

jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = { userId: 'user-123', email: 'user@example.com' };
    next();
  },
}));

// OAuth token sessions are no longer held in process memory — they round-trip through the
// settings table (shared DynamoDB-backed store) so /finalize and /connect can land on
// different instances (ENG-162). Back it with an in-memory map for this route test.
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

jest.mock('../services/db', () => ({
  oauthSessionDb: {
    savePending: jest.fn(async (session: any) => {
      mockOAuthSessions.set(session.sessionId, session);
    }),
    consumePending: jest.fn(async (sessionId: string, userId: string, provider: string) => {
      const session = mockOAuthSessions.get(sessionId);
      if (!session || session.userId !== userId || session.provider !== provider) return null;
      mockOAuthSessions.delete(sessionId);
      return session.data;
    }),
  },
}));

jest.mock('axios');
const axios = require('axios');

// ── App setup ──────────────────────────────────────────────────────────────
process.env.JWT_SECRET = 'test-jwt-secret';
process.env.CUSTOMER_FRONTEND_URL = 'http://localhost:5174';

import hubspotAuthRouter from '../routes/hubspotAuth';
import { createAccount } from '../services/connectedAccountsDb';
import { oauthSessionDb } from '../services/db';

const app = express();
app.use(express.json());
app.use('/api/oauth/hubspot', hubspotAuthRouter);

// ── Helpers ────────────────────────────────────────────────────────────────
const generateValidState = (userId: string, accountType: 'crm' | 'marketing' = 'crm') =>
  jwt.sign({ userId, nonce: 'testnonce', accountType }, 'test-jwt-secret', { expiresIn: '15m' });

const mockCreateAccount = createAccount as jest.MockedFunction<typeof createAccount>;

// ── Tests ─────────────────────────────────────────────────────────────────
describe('HubSpot OAuth Routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ── /init ─────────────────────────────────────────────────────────────
  describe('GET /init', () => {
    it('returns CRM scopes by default (no accountType param)', async () => {
      const res = await request(app)
        .get('/api/oauth/hubspot/init')
        .set('Authorization', 'Bearer mock-token');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      const url = new URL(res.body.url);
      const scope = url.searchParams.get('scope') ?? '';
      expect(scope).toContain('crm.objects.contacts.read');
      expect(scope).not.toContain('marketing.campaigns.read');
    });

    it('returns CRM scopes when accountType=crm', async () => {
      const res = await request(app)
        .get('/api/oauth/hubspot/init?accountType=crm')
        .set('Authorization', 'Bearer mock-token');

      expect(res.status).toBe(200);
      const url = new URL(res.body.url);
      const scope = url.searchParams.get('scope') ?? '';
      expect(scope).toContain('crm.objects.contacts.read');
      expect(scope).not.toContain('marketing.campaigns.read');
    });

    it('returns marketing scopes when accountType=marketing', async () => {
      const res = await request(app)
        .get('/api/oauth/hubspot/init?accountType=marketing')
        .set('Authorization', 'Bearer mock-token');

      expect(res.status).toBe(200);
      const url = new URL(res.body.url);
      const scope = url.searchParams.get('scope') ?? '';
      expect(scope).toContain('crm.objects.contacts.read');
      expect(scope).toContain('marketing.campaigns.read');
      expect(scope).toContain('content');
    });

    it('encodes accountType into state JWT', async () => {
      const res = await request(app)
        .get('/api/oauth/hubspot/init?accountType=marketing')
        .set('Authorization', 'Bearer mock-token');

      const url = new URL(res.body.url);
      const state = url.searchParams.get('state')!;
      const decoded = jwt.verify(state, 'test-jwt-secret') as any;
      expect(decoded.accountType).toBe('marketing');
    });
  });

  // ── /finalize ─────────────────────────────────────────────────────────
  describe('POST /finalize', () => {
    const tokenExchangeResponse = {
      data: { access_token: 'access-tok', refresh_token: 'refresh-tok', expires_in: 3600 },
    };

    it('returns empty missingScopes when portal has all requested scopes', async () => {
      const state = generateValidState('user-123', 'crm');
      axios.post.mockResolvedValueOnce(tokenExchangeResponse);
      axios.get.mockResolvedValueOnce({
        data: {
          hub_id: 1234,
          hub_domain: 'test.hubspot.com',
          user: 'user@test.com',
          scopes: CRM_SCOPES,
        },
      });

      const res = await request(app)
        .post('/api/oauth/hubspot/finalize')
        .send({ code: 'auth-code', state });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.missingScopes).toEqual([]);
      expect(res.body.tokenSessionId).toBeTruthy();
    });

    it('returns missingScopes when portal lacks marketing permissions', async () => {
      const state = generateValidState('user-123', 'marketing');
      axios.post.mockResolvedValueOnce(tokenExchangeResponse);
      axios.get.mockResolvedValueOnce({
        data: {
          hub_id: 1234,
          hub_domain: 'test.hubspot.com',
          user: 'user@test.com',
          scopes: CRM_SCOPES, // only CRM granted, not marketing
        },
      });

      const res = await request(app)
        .post('/api/oauth/hubspot/finalize')
        .send({ code: 'auth-code', state });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.missingScopes).toContain('marketing.campaigns.read');
      expect(res.body.missingScopes).toContain('content');
    });

    it('handles scopes returned as space-separated string', async () => {
      const state = generateValidState('user-123', 'crm');
      axios.post.mockResolvedValueOnce(tokenExchangeResponse);
      axios.get.mockResolvedValueOnce({
        data: {
          hub_id: 1234,
          hub_domain: 'test.hubspot.com',
          user: 'user@test.com',
          scopes: CRM_SCOPES.join(' '), // string form
        },
      });

      const res = await request(app)
        .post('/api/oauth/hubspot/finalize')
        .send({ code: 'auth-code', state });

      expect(res.status).toBe(200);
      expect(res.body.missingScopes).toEqual([]);
    });

    it('treats absent scopes field as all missing', async () => {
      const state = generateValidState('user-123', 'crm');
      axios.post.mockResolvedValueOnce(tokenExchangeResponse);
      axios.get.mockResolvedValueOnce({
        data: { hub_id: 1234, hub_domain: 'test.hubspot.com', user: 'user@test.com' },
      });

      const res = await request(app)
        .post('/api/oauth/hubspot/finalize')
        .send({ code: 'auth-code', state });

      expect(res.status).toBe(200);
      expect(res.body.missingScopes).toEqual(expect.arrayContaining(CRM_SCOPES));
    });

    it('returns 403 on invalid state', async () => {
      const res = await request(app)
        .post('/api/oauth/hubspot/finalize')
        .send({ code: 'auth-code', state: 'invalid-state' });

      expect(res.status).toBe(403);
    });

    it('returns an explicit 500 when the shared session store cannot persist tokens', async () => {
      const state = generateValidState('user-123', 'crm');
      axios.post.mockResolvedValueOnce(tokenExchangeResponse);
      axios.get.mockResolvedValueOnce({
        data: {
          hub_id: 1234,
          hub_domain: 'test.hubspot.com',
          user: 'user@test.com',
          scopes: CRM_SCOPES,
        },
      });
      (oauthSessionDb.savePending as jest.Mock).mockRejectedValueOnce(
        new Error('Dynamo write failed'),
      );

      const res = await request(app)
        .post('/api/oauth/hubspot/finalize')
        .send({ code: 'auth-code', state });

      expect(res.status).toBe(500);
      expect(res.body.error).toBe('Failed to finalize HubSpot connection');
      expect(res.body.tokenSessionId).toBeUndefined();
    });
  });

  // ── /connect ─────────────────────────────────────────────────────────
  describe('POST /connect', () => {
    const setupSession = async (accountType: 'crm' | 'marketing' = 'crm', missingScopes: string[] = []) => {
      const state = generateValidState('user-123', accountType);
      const grantedScopes = accountType === 'crm' ? CRM_SCOPES : MARKETING_SCOPES.filter(s => !missingScopes.includes(s));
      axios.post.mockResolvedValueOnce({
        data: { access_token: 'tok', refresh_token: 'ref', expires_in: 3600 },
      });
      axios.get.mockResolvedValueOnce({
        data: { hub_id: 99, hub_domain: 'portal.hubspot.com', user: 'u@test.com', scopes: grantedScopes },
      });
      const finalizeRes = await request(app)
        .post('/api/oauth/hubspot/finalize')
        .send({ code: 'code', state });
      return finalizeRes.body.tokenSessionId as string;
    };

    it('stores hubspot_account_type=crm in account config', async () => {
      const tokenSessionId = await setupSession('crm');

      const res = await request(app)
        .post('/api/oauth/hubspot/connect')
        .send({ tokenSessionId });

      expect(res.status).toBe(200);
      expect(mockCreateAccount).toHaveBeenCalledWith(
        'user-123',
        'hubspot',
        expect.objectContaining({
          config: expect.objectContaining({ hubspot_account_type: 'crm' }),
        })
      );
    });

    it('stores hubspot_account_type=marketing in account config', async () => {
      const tokenSessionId = await setupSession('marketing');

      const res = await request(app)
        .post('/api/oauth/hubspot/connect')
        .send({ tokenSessionId });

      expect(res.status).toBe(200);
      expect(mockCreateAccount).toHaveBeenCalledWith(
        'user-123',
        'hubspot',
        expect.objectContaining({
          config: expect.objectContaining({ hubspot_account_type: 'marketing' }),
        })
      );
    });

    it('stores granted_scopes in account config', async () => {
      const tokenSessionId = await setupSession('crm');

      await request(app)
        .post('/api/oauth/hubspot/connect')
        .send({ tokenSessionId });

      expect(mockCreateAccount).toHaveBeenCalledWith(
        'user-123',
        'hubspot',
        expect.objectContaining({
          config: expect.objectContaining({
            granted_scopes: expect.arrayContaining(['crm.objects.contacts.read']),
          }),
        })
      );
    });

    it('returns 401 on invalid/expired session', async () => {
      const res = await request(app)
        .post('/api/oauth/hubspot/connect')
        .send({ tokenSessionId: 'nonexistent-session' });

      expect(res.status).toBe(401);
    });

    it('returns an explicit 500 when the shared session store cannot be read', async () => {
      (oauthSessionDb.consumePending as jest.Mock).mockRejectedValueOnce(
        new Error('Dynamo read failed'),
      );

      const res = await request(app)
        .post('/api/oauth/hubspot/connect')
        .send({ tokenSessionId: 'session-id' });

      expect(res.status).toBe(500);
      expect(res.body.error).toBe('Failed to connect HubSpot account');
    });
  });
});
