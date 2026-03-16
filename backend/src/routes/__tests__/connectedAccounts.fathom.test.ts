import express from 'express';
import request from 'supertest';
import connectedAccountsRouter from '../connectedAccounts';
import * as connectedAccountsDb from '../../services/connectedAccountsDb';

// Mock dependencies
jest.mock('../../middleware/auth', () => ({
  authenticateToken: jest.fn((req: any, _res: any, next: any) => {
    req.user = { userId: 'user-123' };
    next();
  }),
}));

jest.mock('../../services/connectedAccountsDb', () => ({
  createAccount: jest.fn(),
  deleteAccount: jest.fn(),
  deleteAccountById: jest.fn(),
  getAccountsByUserId: jest.fn(),
  getAccountByPlatform: jest.fn(),
  updateAccountConfig: jest.fn(),
}));

// Mock fathomApiService
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

jest.mock('../../services/linkedInOutreachService', () => ({
  linkedInOutreachService: { deleteAccount: jest.fn() },
}));

jest.mock('../../utils/tokenUtils', () => ({
  getTokenStatus: jest.fn().mockReturnValue('active'),
  formatExpiryMessage: jest.fn().mockReturnValue('Connected'),
}));

// Mock global fetch for Fathom API validation
const mockFetch = jest.fn();
global.fetch = mockFetch;

describe('Connected Accounts - Fathom', () => {
  let app: express.Application;

  beforeEach(() => {
    jest.clearAllMocks();
    app = express();
    app.use(express.json());
    app.use('/api/oauth', connectedAccountsRouter);
  });

  describe('POST /api/oauth/connected-accounts/fathom', () => {
    it('should connect Fathom with a valid API key and register webhook', async () => {
      // Mock successful Fathom API validation
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          teams: [{ id: 'team-1', name: 'My Team' }],
        }),
      });

      // Mock successful webhook registration
      mockRegisterWebhook.mockResolvedValueOnce({ id: 'wh-new-123' });

      (connectedAccountsDb.createAccount as jest.Mock).mockResolvedValue({
        platform: 'fathom',
        account_id: 'fathom-user-123',
        account_name: 'Fathom',
        config: {
          api_key: 'fv2_valid_key_here',
        },
        created_at: '2026-03-16T00:00:00.000Z',
        updated_at: '2026-03-16T00:00:00.000Z',
      });

      (connectedAccountsDb.updateAccountConfig as jest.Mock).mockResolvedValue(undefined);

      const response = await request(app)
        .post('/api/oauth/connected-accounts/fathom')
        .send({ api_key: 'fv2_valid_key_here' });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.account).toBeDefined();
      expect(response.body.account.platform).toBe('fathom');

      // Should have validated against Fathom API
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.fathom.ai/external/v1/teams',
        expect.objectContaining({
          headers: expect.objectContaining({
            'X-Api-Key': 'fv2_valid_key_here',
          }),
        })
      );

      // Should have stored in DB
      expect(connectedAccountsDb.createAccount).toHaveBeenCalledWith(
        'user-123',
        'fathom',
        expect.objectContaining({
          account_id: expect.any(String),
          account_name: 'Fathom',
          config: expect.objectContaining({
            api_key: 'fv2_valid_key_here',
          }),
        })
      );

      // Should have registered webhook
      expect(mockRegisterWebhook).toHaveBeenCalledWith(
        expect.stringContaining('/api/webhooks/fathom')
      );

      // Should have stored webhook_id in DB
      expect(connectedAccountsDb.updateAccountConfig).toHaveBeenCalledWith(
        'user-123',
        'fathom',
        'fathom-user-123',
        expect.objectContaining({
          webhook_id: 'wh-new-123',
          webhook_url: expect.stringContaining('/api/webhooks/fathom'),
        })
      );
    });

    it('should still succeed if webhook registration fails (graceful degradation)', async () => {
      // Mock successful Fathom API validation
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          teams: [{ id: 'team-1', name: 'My Team' }],
        }),
      });

      // Mock webhook registration failure
      mockRegisterWebhook.mockRejectedValueOnce(new Error('Webhook registration failed'));

      (connectedAccountsDb.createAccount as jest.Mock).mockResolvedValue({
        platform: 'fathom',
        account_id: 'fathom-user-123',
        account_name: 'Fathom',
        config: {
          api_key: 'fv2_valid_key_here',
        },
        created_at: '2026-03-16T00:00:00.000Z',
        updated_at: '2026-03-16T00:00:00.000Z',
      });

      const response = await request(app)
        .post('/api/oauth/connected-accounts/fathom')
        .send({ api_key: 'fv2_valid_key_here' });

      // Should still succeed — webhook registration is best-effort
      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.account).toBeDefined();

      // Should NOT have tried to store webhook_id
      expect(connectedAccountsDb.updateAccountConfig).not.toHaveBeenCalled();
    });

    it('should reject an invalid API key (401 from Fathom)', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        json: async () => ({ error: 'Unauthorized' }),
      });

      const response = await request(app)
        .post('/api/oauth/connected-accounts/fathom')
        .send({ api_key: 'invalid_key' });

      expect(response.status).toBe(401);
      expect(response.body.error).toBeDefined();
      expect(connectedAccountsDb.createAccount).not.toHaveBeenCalled();
    });

    it('should reject when api_key is missing from request body', async () => {
      const response = await request(app)
        .post('/api/oauth/connected-accounts/fathom')
        .send({});

      expect(response.status).toBe(400);
      expect(response.body.error).toBeDefined();
      expect(mockFetch).not.toHaveBeenCalled();
      expect(connectedAccountsDb.createAccount).not.toHaveBeenCalled();
    });

    it('should handle Fathom API being unreachable', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      const response = await request(app)
        .post('/api/oauth/connected-accounts/fathom')
        .send({ api_key: 'some_key' });

      expect(response.status).toBe(502);
      expect(response.body.error).toBeDefined();
      expect(connectedAccountsDb.createAccount).not.toHaveBeenCalled();
    });
  });

  describe('DELETE /api/oauth/connected-accounts/fathom', () => {
    it('should disconnect Fathom and clean up webhook via FathomApiService', async () => {
      (connectedAccountsDb.getAccountByPlatform as jest.Mock).mockResolvedValue({
        platform: 'fathom',
        account_id: 'fathom-user-123',
        account_name: 'Fathom',
        config: {
          api_key: 'fv2_valid_key',
          webhook_id: 'wh-123',
        },
        created_at: '2026-03-16T00:00:00.000Z',
        updated_at: '2026-03-16T00:00:00.000Z',
      });

      // Mock webhook deletion success
      mockDeleteWebhook.mockResolvedValueOnce(undefined);

      (connectedAccountsDb.deleteAccount as jest.Mock).mockResolvedValue(undefined);

      const response = await request(app)
        .delete('/api/oauth/connected-accounts/fathom');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);

      // Should have called FathomApiService to delete webhook
      expect(mockDeleteWebhook).toHaveBeenCalledWith('wh-123');

      expect(connectedAccountsDb.deleteAccount).toHaveBeenCalledWith('user-123', 'fathom');
    });

    it('should disconnect Fathom without webhook cleanup if no webhook stored', async () => {
      (connectedAccountsDb.getAccountByPlatform as jest.Mock).mockResolvedValue({
        platform: 'fathom',
        account_id: 'fathom-user-123',
        account_name: 'Fathom',
        config: {
          api_key: 'fv2_valid_key',
          // No webhook_id
        },
        created_at: '2026-03-16T00:00:00.000Z',
        updated_at: '2026-03-16T00:00:00.000Z',
      });

      (connectedAccountsDb.deleteAccount as jest.Mock).mockResolvedValue(undefined);

      const response = await request(app)
        .delete('/api/oauth/connected-accounts/fathom');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);

      // Should NOT have tried to delete webhook
      expect(mockDeleteWebhook).not.toHaveBeenCalled();

      expect(connectedAccountsDb.deleteAccount).toHaveBeenCalledWith('user-123', 'fathom');
    });

    it('should still delete from DB if webhook cleanup fails (graceful degradation)', async () => {
      (connectedAccountsDb.getAccountByPlatform as jest.Mock).mockResolvedValue({
        platform: 'fathom',
        account_id: 'fathom-user-123',
        account_name: 'Fathom',
        config: {
          api_key: 'fv2_valid_key',
          webhook_id: 'wh-123',
        },
        created_at: '2026-03-16T00:00:00.000Z',
        updated_at: '2026-03-16T00:00:00.000Z',
      });

      // Mock webhook deletion failure
      mockDeleteWebhook.mockRejectedValueOnce(new Error('Fathom API down'));

      (connectedAccountsDb.deleteAccount as jest.Mock).mockResolvedValue(undefined);

      const response = await request(app)
        .delete('/api/oauth/connected-accounts/fathom');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);

      // Should still delete from DB even though webhook cleanup failed
      expect(connectedAccountsDb.deleteAccount).toHaveBeenCalledWith('user-123', 'fathom');
    });
  });

  describe('GET /api/oauth/connected-accounts - Fathom account in list', () => {
    it('should show Fathom account as permanently connected (no token expiry)', async () => {
      const mockAccounts = [
        {
          platform: 'fathom',
          account_id: 'fathom-user-123',
          account_name: 'Fathom',
          created_at: '2026-03-16T00:00:00.000Z',
          updated_at: '2026-03-16T00:00:00.000Z',
          config: {
            api_key: 'fv2_key',
            account_type: 'api_key',
            // token_expires_at set to far future for API key accounts
            token_expires_at: Date.now() + 10 * 365 * 24 * 60 * 60 * 1000,
            access_token: 'fv2_key',
          },
        },
      ];

      (connectedAccountsDb.getAccountsByUserId as jest.Mock).mockResolvedValue(mockAccounts);

      const response = await request(app).get('/api/oauth/connected-accounts');

      expect(response.status).toBe(200);
      expect(response.body.accounts).toHaveLength(1);
      expect(response.body.accounts[0].platform).toBe('fathom');
    });
  });
});
