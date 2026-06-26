// Verifies that GET /api/admin/users strips large, frontend-unused GTM/onboarding
// artifact blobs (and never leaks password hashes) so the response stays small
// enough to be buffered in memory by the EB nginx proxy instead of spilling to a
// temp file (which fails when the instance disk is full).
import request from 'supertest';
import express from 'express';
import adminRoutes from '../routes/admin';

jest.mock('../services/db', () => ({
  userDb: {
    getAllUsers: jest.fn(),
  },
}));
jest.mock('../services/waitlistDb', () => ({}));
jest.mock('../services/emailService', () => ({}));
jest.mock('../services/workflowDb', () => ({}));
jest.mock('../services/chatbotService', () => ({}));
jest.mock('../services/resendService', () => ({
  resendService: { sendEmail: jest.fn() },
}));
jest.mock('../services/settingsService', () => ({
  settingsService: {
    getSetting: jest.fn(),
    setSetting: jest.fn(),
    getSettingsByPrefix: jest.fn(),
  },
}));

jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = { userId: 'admin-user-1', email: 'admin@example.com', isAdmin: true };
    next();
  },
}));
jest.mock('../middleware/admin', () => ({
  isAdmin: (_req: any, _res: any, next: any) => next(),
}));

jest.mock('aws-sdk', () => ({
  default: {
    SecretsManager: jest.fn(() => ({
      getSecretValue: jest.fn().mockReturnValue({
        promise: jest.fn().mockResolvedValue({ SecretString: 'test-secret' }),
      }),
    })),
  },
  config: { update: jest.fn() },
  DynamoDB: { DocumentClient: jest.fn(() => ({})) },
  SecretsManager: jest.fn(() => ({
    getSecretValue: jest.fn().mockReturnValue({
      promise: jest.fn().mockResolvedValue({ SecretString: 'test-secret' }),
    }),
  })),
}));

import { userDb } from '../services/db';
import { settingsService } from '../services/settingsService';

const mockUserDb = userDb as jest.Mocked<typeof userDb>;
const mockSettingsService = settingsService as jest.Mocked<typeof settingsService>;

const app = express();
app.use(express.json());
app.use('/api/admin', adminRoutes);

describe('GET /api/admin/users - payload slimming', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSettingsService.getSetting.mockRejectedValue(new Error('Not found'));
  });

  it('should strip large GTM/onboarding artifact blobs from each user', async () => {
    const users = [
      {
        userId: 'user-1',
        email: 'user1@test.com',
        isAdmin: false,
        isActive: true,
        createdAt: '2026-01-01',
        displayName: 'User One',
        competitorResult: { huge: 'x'.repeat(5000) },
        marketStrategy: { huge: 'y'.repeat(5000) },
        brandGuidelines: { huge: 'z'.repeat(5000) },
        adImageResult: { huge: 'a'.repeat(5000) },
        icpResult: { huge: 'b'.repeat(5000) },
        creativeDirResult: { huge: 'c'.repeat(5000) },
        adCopyResult: { huge: 'd'.repeat(5000) },
        onboardingEvents: [{ e: 'f'.repeat(5000) }],
        startupProfiles: [{ p: 'g'.repeat(5000) }],
        connected_accounts: { x: 'h'.repeat(5000) },
      },
    ];
    mockUserDb.getAllUsers.mockResolvedValue(users as any);

    const res = await request(app).get('/api/admin/users').expect(200);

    const u = res.body[0];
    // Fields the admin table actually displays are preserved
    expect(u.userId).toBe('user-1');
    expect(u.email).toBe('user1@test.com');
    expect(u.displayName).toBe('User One');
    // Large artifact blobs are removed
    expect(u.competitorResult).toBeUndefined();
    expect(u.marketStrategy).toBeUndefined();
    expect(u.brandGuidelines).toBeUndefined();
    expect(u.adImageResult).toBeUndefined();
    expect(u.icpResult).toBeUndefined();
    expect(u.creativeDirResult).toBeUndefined();
    expect(u.adCopyResult).toBeUndefined();
    expect(u.onboardingEvents).toBeUndefined();
    expect(u.startupProfiles).toBeUndefined();
    expect(u.connected_accounts).toBeUndefined();
  });

  it('should never leak password hashes to the frontend', async () => {
    const users = [
      {
        userId: 'user-1',
        email: 'user1@test.com',
        isAdmin: false,
        isActive: true,
        createdAt: '2026-01-01',
        password: '$2a$10$abcdefghijklmnopqrstuv',
      },
    ];
    mockUserDb.getAllUsers.mockResolvedValue(users as any);

    const res = await request(app).get('/api/admin/users').expect(200);

    expect(res.body[0].password).toBeUndefined();
    expect(res.body[0].userId).toBe('user-1');
  });

  it('should preserve fields the admin table displays, including tokenUsage', async () => {
    const users = [
      {
        userId: 'user-1',
        email: 'user1@test.com',
        isAdmin: false,
        isActive: true,
        createdAt: '2026-01-01',
        displayName: 'User One',
        roles: ['customer'],
        taskCount: 5,
        workflowCount: 2,
        chatSessionCount: 3,
        tokenUsage: { month: '2026-06', totalTokens: 1234, totalCost: 0.5 },
        tokenUsageHistory: [{ month: '2026-05', totalTokens: 1000, totalCost: 0.4 }],
        subscription_status: 'active',
        marketStrategy: { huge: 'y'.repeat(5000) },
      },
    ];
    mockUserDb.getAllUsers.mockResolvedValue(users as any);

    const res = await request(app).get('/api/admin/users').expect(200);

    const u = res.body[0];
    expect(u.tokenUsage).toEqual({ month: '2026-06', totalTokens: 1234, totalCost: 0.5 });
    expect(u.tokenUsageHistory).toEqual([{ month: '2026-05', totalTokens: 1000, totalCost: 0.4 }]);
    expect(u.taskCount).toBe(5);
    expect(u.workflowCount).toBe(2);
    expect(u.chatSessionCount).toBe(3);
    expect(u.roles).toEqual(['customer']);
    expect(u.subscription_status).toBe('active');
    // but the large blob is still stripped
    expect(u.marketStrategy).toBeUndefined();
  });

  it('should still strip secrets and expose only secretNames alongside slimming', async () => {
    const users = [
      {
        userId: 'user-1',
        email: 'user1@test.com',
        isAdmin: false,
        isActive: true,
        createdAt: '2026-01-01',
        secrets: { GITHUB_TOKEN: 'enc1', API_KEY: 'enc2' },
        competitorResult: { huge: 'x'.repeat(5000) },
      },
    ];
    mockUserDb.getAllUsers.mockResolvedValue(users as any);

    const res = await request(app).get('/api/admin/users').expect(200);

    expect(res.body[0].secrets).toBeUndefined();
    expect(res.body[0].secretNames).toEqual(['GITHUB_TOKEN', 'API_KEY']);
    expect(res.body[0].competitorResult).toBeUndefined();
  });
});
