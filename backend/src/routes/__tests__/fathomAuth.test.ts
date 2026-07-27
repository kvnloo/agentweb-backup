import express from 'express';
import request from 'supertest';

// ── Mocks ──────────────────────────────────────────────────────────────────

// Must be hoisted before the router import
jest.mock('../../middleware/auth', () => ({
  authenticateToken: jest.fn((req: any, _res: any, next: any) => {
    req.user = { userId: 'user-123' };
    next();
  }),
}));

jest.mock('../../config/integrations', () => ({
  getFathomConfig: jest.fn().mockResolvedValue({
    clientId: 'fathom-client-id',
    clientSecret: 'fathom-client-secret',
    redirectUri: 'http://localhost:3001/api/oauth/fathom/callback',
    scopes: ['public_api'],
    authorizationUrl: 'https://fathom.video/external/v1/oauth2/authorize',
    tokenUrl: 'https://api.fathom.ai/external/v1/oauth2/token',
  }),
}));

const mockCreateAccount = jest.fn();
const mockUpdateAccountConfig = jest.fn();
const mockOAuthSessions = new Map<string, any>();
jest.mock('../../services/connectedAccountsDb', () => ({
  createAccount: (...args: any[]) => mockCreateAccount(...args),
  updateAccountConfig: (...args: any[]) => mockUpdateAccountConfig(...args),
}));

// /finalize and /connect may run on separate instances. Model their canonical
// AW-OAuthSessions handoff while keeping this route test independent of DynamoDB.
jest.mock('../../services/db', () => ({
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

const mockRegisterWebhook = jest.fn();
const mockDeleteWebhook = jest.fn();
const mockValidateApiKey = jest.fn();
jest.mock('../../services/fathomApiService', () => ({
  FathomApiService: jest.fn().mockImplementation(() => ({
    registerWebhook: mockRegisterWebhook,
    deleteWebhook: mockDeleteWebhook,
    validateApiKey: mockValidateApiKey,
  })),
}));

// Mock axios for /finalize token exchange
jest.mock('axios', () => ({
  post: jest.fn(),
}));

// Mock crypto for deterministic token sessions
const realCrypto = jest.requireActual('crypto');

// ── Import router after mocks ──────────────────────────────────────────────

import fathomAuthRouter from '../fathomAuth';

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * To test the /connect endpoint, we need a valid tokenSessionId.
 * The /finalize endpoint creates these, but we need to go through the full
 * flow: finalize (stores token session) → connect (consumes it).
 *
 * We mock axios.post to simulate Fathom's token exchange response.
 */
const axios = require('axios');

const setupApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/', fathomAuthRouter);
  return app;
};

// ── Tests ──────────────────────────────────────────────────────────────────

describe('Fathom Auth Router - /connect webhook registration', () => {
  let app: express.Application;

  beforeEach(() => {
    mockOAuthSessions.clear();
    jest.clearAllMocks();
    app = setupApp();

    // Default: createAccount succeeds
    mockCreateAccount.mockResolvedValue({
      platform: 'fathom',
      account_id: 'fathom-user-123',
      account_name: 'Fathom',
      config: {
        account_type: 'oauth',
        access_token: 'fathom-access-token',
        refresh_token: 'fathom-refresh-token',
        token_expires_at: Date.now() + 3600000,
      },
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    // Default: updateAccountConfig succeeds
    mockUpdateAccountConfig.mockResolvedValue(undefined);
  });

  /**
   * Helper: finalize to get a tokenSessionId, then connect.
   * This simulates the full OAuth flow: code exchange → token session → connect.
   */
  const finalizeAndConnect = async (overrides?: {
    webhookResult?: any;
    webhookError?: Error;
  }) => {
    // Step 1: Mock Fathom token exchange
    axios.post.mockResolvedValueOnce({
      data: {
        access_token: 'fathom-access-token',
        refresh_token: 'fathom-refresh-token',
        expires_in: 3600,
      },
    });

    // Step 2: Generate a valid JWT state
    const jwt = require('jsonwebtoken');
    const state = jwt.sign(
      { userId: 'user-123', nonce: 'test-nonce' },
      process.env.JWT_SECRET!,
      { expiresIn: '15m' }
    );

    // Step 3: Call /finalize to get tokenSessionId
    const finalizeRes = await request(app)
      .post('/finalize')
      .send({ code: 'auth-code-123', state });

    expect(finalizeRes.status).toBe(200);
    const { tokenSessionId } = finalizeRes.body;
    expect(tokenSessionId).toBeTruthy();

    // Step 4: Set up webhook mock
    if (overrides?.webhookError) {
      mockRegisterWebhook.mockRejectedValueOnce(overrides.webhookError);
    } else {
      mockRegisterWebhook.mockResolvedValueOnce(
        overrides?.webhookResult || { id: 'wh-new-456' }
      );
    }

    // Step 5: Call /connect
    const connectRes = await request(app)
      .post('/connect')
      .send({ tokenSessionId });

    return connectRes;
  };

  describe('POST /connect — webhook registration on success', () => {
    it('should register a webhook with Fathom after creating the account', async () => {
      const res = await finalizeAndConnect();

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      // Verify account was created
      expect(mockCreateAccount).toHaveBeenCalledWith(
        'user-123',
        'fathom',
        expect.objectContaining({
          account_id: 'fathom-user-123',
          account_name: 'Fathom',
          config: expect.objectContaining({
            account_type: 'oauth',
            access_token: 'fathom-access-token',
          }),
        })
      );

      // Verify webhook was registered
      expect(mockRegisterWebhook).toHaveBeenCalledTimes(1);
      expect(mockRegisterWebhook).toHaveBeenCalledWith(
        expect.stringContaining('/api/webhooks/fathom')
      );
    });

    it('should store webhook_id in account config after successful registration', async () => {
      const res = await finalizeAndConnect({ webhookResult: { id: 'wh-stored-789' } });

      expect(res.status).toBe(200);

      // Verify webhook_id was saved to account config
      expect(mockUpdateAccountConfig).toHaveBeenCalledWith(
        'user-123',
        'fathom',
        'fathom-user-123',
        expect.objectContaining({
          webhook_id: 'wh-stored-789',
          webhook_url: expect.stringContaining('/api/webhooks/fathom'),
        })
      );
    });

    it('should store both webhook_id and webhook_url in config', async () => {
      const res = await finalizeAndConnect({ webhookResult: { id: 'wh-full-001' } });

      expect(res.status).toBe(200);

      const configUpdate = mockUpdateAccountConfig.mock.calls[0][3];
      expect(configUpdate).toHaveProperty('webhook_id', 'wh-full-001');
      expect(configUpdate).toHaveProperty('webhook_url');
      expect(configUpdate.webhook_url).toMatch(/\/api\/webhooks\/fathom$/);
    });
  });

  describe('POST /connect — webhook registration failure (graceful degradation)', () => {
    it('should still succeed (200) when webhook registration fails', async () => {
      const res = await finalizeAndConnect({
        webhookError: new Error('Fathom API unreachable'),
      });

      // Connect should still succeed — webhook is best-effort
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.account).toBeTruthy();
    });

    it('should NOT store webhook_id when registration fails', async () => {
      await finalizeAndConnect({
        webhookError: new Error('422 Invalid URL'),
      });

      // updateAccountConfig should NOT have been called since registration failed
      expect(mockUpdateAccountConfig).not.toHaveBeenCalled();
    });

    it('should still create the account even when webhook fails', async () => {
      await finalizeAndConnect({
        webhookError: new Error('Network timeout'),
      });

      // Account creation should still have happened
      expect(mockCreateAccount).toHaveBeenCalledTimes(1);
      expect(mockCreateAccount).toHaveBeenCalledWith(
        'user-123',
        'fathom',
        expect.objectContaining({
          account_name: 'Fathom',
        })
      );
    });
  });

  describe('POST /connect — input validation', () => {
    it('should return 400 if tokenSessionId is missing', async () => {
      const res = await request(app)
        .post('/connect')
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('tokenSessionId');
    });

    it('should return 401 if tokenSessionId is invalid', async () => {
      const res = await request(app)
        .post('/connect')
        .send({ tokenSessionId: 'invalid-session-id' });

      expect(res.status).toBe(401);
      expect(res.body.error).toContain('Invalid or expired');
    });
  });

  describe('POST /connect — account creation failure', () => {
    it('should return 500 if createAccount throws', async () => {
      mockCreateAccount.mockRejectedValueOnce(new Error('DynamoDB write failed'));

      // We still need a valid tokenSessionId
      axios.post.mockResolvedValueOnce({
        data: {
          access_token: 'fathom-access-token',
          refresh_token: 'fathom-refresh-token',
          expires_in: 3600,
        },
      });

      const jwt = require('jsonwebtoken');
      const state = jwt.sign(
        { userId: 'user-123', nonce: 'test-nonce-2' },
        process.env.JWT_SECRET!,
        { expiresIn: '15m' }
      );

      const finalizeRes = await request(app)
        .post('/finalize')
        .send({ code: 'auth-code-456', state });

      const connectRes = await request(app)
        .post('/connect')
        .send({ tokenSessionId: finalizeRes.body.tokenSessionId });

      expect(connectRes.status).toBe(500);
      expect(connectRes.body.error).toContain('Failed to connect');

      // Webhook should not have been attempted
      expect(mockRegisterWebhook).not.toHaveBeenCalled();
    });
  });
});
