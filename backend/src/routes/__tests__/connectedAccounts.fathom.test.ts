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
  getAccountsWithOwnerIncludingOrgShared: jest.fn(),
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
  linkedInOutreachService: {
    deleteAccount: jest.fn(),
    getStatusesForAccounts: jest.fn().mockResolvedValue(new Map()),
  },
}));

jest.mock('../../utils/tokenUtils', () => ({
  getTokenStatus: jest.fn().mockReturnValue('active'),
  formatExpiryMessage: jest.fn().mockReturnValue('Connected'),
}));

describe('Connected Accounts - Fathom', () => {
  let app: express.Application;

  beforeEach(() => {
    jest.clearAllMocks();
    app = express();
    app.use(express.json());
    app.use('/api/oauth', connectedAccountsRouter);
  });

  describe('POST /api/oauth/connected-accounts/fathom — removed (now OAuth)', () => {
    it('should return 404 since POST route was removed in favor of OAuth flow', async () => {
      const response = await request(app)
        .post('/api/oauth/connected-accounts/fathom')
        .send({ api_key: 'fv2_valid_key_here' });

      // Route no longer exists — Express returns 404
      expect(response.status).toBe(404);
    });
  });

  describe('DELETE /api/oauth/connected-accounts/fathom', () => {
    it('should disconnect Fathom and clean up webhook via FathomApiService', async () => {
      (connectedAccountsDb.getAccountByPlatform as jest.Mock).mockResolvedValue({
        platform: 'fathom',
        account_id: 'fathom-user-123',
        account_name: 'Fathom',
        config: {
          account_type: 'oauth',
          access_token: 'oauth-access-token',
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
          account_type: 'oauth',
          access_token: 'oauth-access-token',
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
          account_type: 'oauth',
          access_token: 'oauth-access-token',
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
    it('should show Fathom account as active when live API check passes', async () => {
      const mockAccounts = [
        {
          platform: 'fathom',
          account_id: 'fathom-user-123',
          account_name: 'Fathom',
          created_at: '2026-03-16T00:00:00.000Z',
          updated_at: '2026-03-16T00:00:00.000Z',
          config: {
            account_type: 'oauth',
            token_expires_at: Date.now() + 3600 * 1000,
            access_token: 'oauth-token',
          },
        },
      ];

      (connectedAccountsDb.getAccountsWithOwnerIncludingOrgShared as jest.Mock).mockResolvedValue(mockAccounts);
      mockValidateApiKey.mockResolvedValue(true);

      const response = await request(app).get('/api/oauth/connected-accounts');

      expect(response.status).toBe(200);
      expect(response.body.accounts).toHaveLength(1);
      expect(response.body.accounts[0].platform).toBe('fathom');
      expect(response.body.accounts[0].status).toBe('active');
      expect(response.body.accounts[0].expiry_message).toBe('Connected');
    });

    it('should show Fathom account as disconnected when live API check returns 401', async () => {
      const mockAccounts = [
        {
          platform: 'fathom',
          account_id: 'fathom-user-123',
          account_name: 'Fathom',
          created_at: '2026-03-16T00:00:00.000Z',
          updated_at: '2026-03-16T00:00:00.000Z',
          config: {
            account_type: 'oauth',
            token_expires_at: Date.now() + 3600 * 24 * 365 * 4 * 1000, // far future
            access_token: 'revoked-token',
          },
        },
      ];

      (connectedAccountsDb.getAccountsWithOwnerIncludingOrgShared as jest.Mock).mockResolvedValue(mockAccounts);
      mockValidateApiKey.mockResolvedValue(false);

      const response = await request(app).get('/api/oauth/connected-accounts');

      expect(response.status).toBe(200);
      expect(response.body.accounts[0].status).toBe('disconnected');
      expect(response.body.accounts[0].expiry_message).toContain('reconnect');
    });
  });
});
