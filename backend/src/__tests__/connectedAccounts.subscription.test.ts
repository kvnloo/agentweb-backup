import request from 'supertest';
import express from 'express';

// Mock auth middleware
jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = { userId: 'test-user-1', isAdmin: false };
    next();
  },
}));

// Mock connectedAccountsDb
jest.mock('../services/connectedAccountsDb', () => ({
  getAccountsByUserId: jest.fn(),
  getAccountsWithOwnerIncludingOrgShared: jest.fn(),
  deleteAccount: jest.fn(),
  deleteAccountById: jest.fn(),
  getAccountByPlatform: jest.fn(),
}));

// Mock tokenUtils
jest.mock('../utils/tokenUtils', () => ({
  getTokenStatus: jest.fn(() => 'active'),
  formatExpiryMessage: jest.fn(() => 'Connected'),
}));

// Mock linkedInOutreachService
jest.mock('../services/linkedInOutreachService', () => ({
  linkedInOutreachService: {
    deleteAccount: jest.fn(),
    getStatusesForAccounts: jest.fn().mockResolvedValue(new Map()),
  },
}));

// Mock fathomApiService
jest.mock('../services/fathomApiService', () => ({
  FathomApiService: jest.fn().mockImplementation(() => ({
    deleteWebhook: jest.fn(),
  })),
}));

// Mock subscriptionService — need to provide getAllowedConnectedAccounts which
// connectedAccounts.ts imports directly. We implement it in terms of the other mocks.
const ALL_PLATFORMS = ['linkedin', 'unipile', 'meta', 'gmail', 'youtube', 'fathom', 'instagram'];

jest.mock('../services/subscriptionService', () => {
  const mockGetUserSubscriptionType = jest.fn();
  const mockGetSubscriptionTypeConfig = jest.fn();
  const mockGetAllAvailableConnectedAccounts = jest.fn(() => ALL_PLATFORMS);

  return {
    getUserSubscriptionType: mockGetUserSubscriptionType,
    getSubscriptionTypeConfig: mockGetSubscriptionTypeConfig,
    getAllAvailableConnectedAccounts: mockGetAllAvailableConnectedAccounts,
    getAllowedConnectedAccounts: jest.fn(async (userId: string) => {
      const typeName = await mockGetUserSubscriptionType(userId);
      const config = await mockGetSubscriptionTypeConfig(typeName);
      if (!config) return [...ALL_PLATFORMS];
      const allowed = config.allowedConnectedAccounts;
      if (!allowed || allowed.includes('*') || allowed.length === 0) return [...ALL_PLATFORMS];
      return allowed;
    }),
  };
});

import connectedAccountsRoutes from '../routes/connectedAccounts';
import * as subscriptionService from '../services/subscriptionService';
import { getAccountsWithOwnerIncludingOrgShared } from '../services/connectedAccountsDb';

const mockedGetSubscriptionTypeConfig = subscriptionService.getSubscriptionTypeConfig as jest.Mock;
const mockedGetUserSubscriptionType = subscriptionService.getUserSubscriptionType as jest.Mock;
const mockedGetAccountsByUserId = getAccountsWithOwnerIncludingOrgShared as jest.Mock;

let app: express.Application;

describe('Connected accounts subscription enforcement', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    app = express();
    app.use(express.json());
    app.use('/api/oauth', connectedAccountsRoutes);
  });

  describe('GET /api/oauth/connected-accounts', () => {
    it('should return allowedConnectedAccounts in response', async () => {
      mockedGetUserSubscriptionType.mockResolvedValue('Basic');
      mockedGetSubscriptionTypeConfig.mockResolvedValue({
        name: 'Basic',
        allowedPages: ['*'],
        allowedSkills: ['*'],
        allowedConnectedAccounts: ['linkedin', 'gmail'],
      });
      mockedGetAccountsByUserId.mockResolvedValue([]);

      const res = await request(app)
        .get('/api/oauth/connected-accounts')
        .set('Authorization', 'Bearer test-token')
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.allowedConnectedAccounts).toEqual(['linkedin', 'gmail']);
    });

    it('should return all platforms when allowedConnectedAccounts is ["*"]', async () => {
      mockedGetUserSubscriptionType.mockResolvedValue('Pro');
      mockedGetSubscriptionTypeConfig.mockResolvedValue({
        name: 'Pro',
        allowedPages: ['*'],
        allowedSkills: ['*'],
        allowedConnectedAccounts: ['*'],
      });
      mockedGetAccountsByUserId.mockResolvedValue([]);

      const res = await request(app)
        .get('/api/oauth/connected-accounts')
        .set('Authorization', 'Bearer test-token')
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.allowedConnectedAccounts).toEqual([
        'linkedin', 'unipile', 'meta', 'gmail', 'youtube', 'fathom', 'instagram',
      ]);
    });

    it('should return all platforms when no subscription type config found', async () => {
      mockedGetUserSubscriptionType.mockResolvedValue('Unknown');
      mockedGetSubscriptionTypeConfig.mockResolvedValue(null);
      mockedGetAccountsByUserId.mockResolvedValue([]);

      const res = await request(app)
        .get('/api/oauth/connected-accounts')
        .set('Authorization', 'Bearer test-token')
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.allowedConnectedAccounts).toEqual([
        'linkedin', 'unipile', 'meta', 'gmail', 'youtube', 'fathom', 'instagram',
      ]);
    });

    it('should return all platforms when allowedConnectedAccounts is undefined (backward compat)', async () => {
      mockedGetUserSubscriptionType.mockResolvedValue('Legacy');
      mockedGetSubscriptionTypeConfig.mockResolvedValue({
        name: 'Legacy',
        allowedPages: ['*'],
        allowedSkills: ['*'],
        // no allowedConnectedAccounts field
      });
      mockedGetAccountsByUserId.mockResolvedValue([]);

      const res = await request(app)
        .get('/api/oauth/connected-accounts')
        .set('Authorization', 'Bearer test-token')
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.allowedConnectedAccounts).toEqual([
        'linkedin', 'unipile', 'meta', 'gmail', 'youtube', 'fathom', 'instagram',
      ]);
    });
  });
});
