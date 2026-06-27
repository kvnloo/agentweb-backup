import request from 'supertest';
import express from 'express';
import adminRoutes from '../routes/admin';

// Mock the dependencies
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
  resendService: {
    sendEmail: jest.fn(),
  },
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

// Mock AWS SDK
jest.mock('aws-sdk', () => ({
  default: {
    SecretsManager: jest.fn(() => ({
      getSecretValue: jest.fn().mockReturnValue({
        promise: jest.fn().mockResolvedValue({ SecretString: 'test-secret' }),
      }),
    })),
  },
  config: {
    update: jest.fn(),
  },
  DynamoDB: {
    DocumentClient: jest.fn(() => ({})),
  },
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

describe('GET /api/admin/users - replay URLs', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should include replayUrl for users with replay session settings', async () => {
    const users = [
      { userId: 'user-1', email: 'user1@test.com', isAdmin: false, isActive: true, createdAt: '2026-01-01' },
      { userId: 'user-2', email: 'user2@test.com', isAdmin: false, isActive: true, createdAt: '2026-01-02' },
    ];

    mockUserDb.getAllUsers.mockResolvedValue(users as any);

    const replayUrl = 'https://clarity.microsoft.com/projects/view/proj123/impressions?CustomUserId=is%3Buser-1';
    mockSettingsService.getSetting.mockImplementation((key: string) => {
      if (key === 'replay_sessions_user-1') {
        return Promise.resolve({
          settingName: 'replay_sessions_user-1',
          settingValue: JSON.stringify({
            replayUrl,
            clarityProjectId: 'proj123',
            trackingUserId: 'user-1',
            lastTracked: '2026-02-17T00:00:00Z',
          }),
        } as any);
      }
      return Promise.reject(new Error('Not found'));
    });

    const res = await request(app)
      .get('/api/admin/users')
      .expect(200);

    expect(res.body).toHaveLength(2);
    expect(res.body[0].replayUrl).toBe(replayUrl);
    expect(res.body[1].replayUrl).toBeUndefined();
  });

  it('should handle missing replay session settings gracefully', async () => {
    const users = [
      { userId: 'user-1', email: 'user1@test.com', isAdmin: false, isActive: true, createdAt: '2026-01-01' },
    ];

    mockUserDb.getAllUsers.mockResolvedValue(users as any);
    mockSettingsService.getSetting.mockRejectedValue(new Error('Not found'));

    const res = await request(app)
      .get('/api/admin/users')
      .expect(200);

    expect(res.body).toHaveLength(1);
    expect(res.body[0].replayUrl).toBeUndefined();
  });

  it('should handle malformed replay session JSON gracefully', async () => {
    const users = [
      { userId: 'user-1', email: 'user1@test.com', isAdmin: false, isActive: true, createdAt: '2026-01-01' },
    ];

    mockUserDb.getAllUsers.mockResolvedValue(users as any);
    mockSettingsService.getSetting.mockResolvedValue({
      settingName: 'replay_sessions_user-1',
      settingValue: 'not-valid-json',
    } as any);

    const res = await request(app)
      .get('/api/admin/users')
      .expect(200);

    expect(res.body).toHaveLength(1);
    expect(res.body[0].replayUrl).toBeUndefined();
  });

  it('should strip secrets and expose only secretNames', async () => {
    const users = [
      {
        userId: 'user-1',
        email: 'user1@test.com',
        isAdmin: false,
        isActive: true,
        createdAt: '2026-01-01',
        secrets: { GITHUB_TOKEN: 'encrypted-value', API_KEY: 'encrypted-value2' },
      },
    ];

    mockUserDb.getAllUsers.mockResolvedValue(users as any);
    mockSettingsService.getSetting.mockRejectedValue(new Error('Not found'));

    const res = await request(app)
      .get('/api/admin/users')
      .expect(200);

    expect(res.body[0].secrets).toBeUndefined();
    expect(res.body[0].secretNames).toEqual(['GITHUB_TOKEN', 'API_KEY']);
  });

  it('should return a compact list payload without large raw user fields', async () => {
    const largeBlob = 'x'.repeat(250_000);
    const users = [
      {
        userId: 'user-1',
        email: 'user1@test.com',
        isAdmin: false,
        isActive: true,
        createdAt: '2026-01-01',
        lastLoginTime: '2026-02-01',
        roles: ['customer'],
        taskCount: 4,
        workflowCount: 2,
        chatSessionCount: 9,
        subscription_status: 'active',
        current_period_end: '2026-07-01',
        tokenUsage: {
          month: '2026-06',
          totalTokens: 123,
          totalCost: 1.23,
          resetDate: '2026-07-01',
        },
        googleDriveFolders: [{ folderId: 'folder-1', name: 'Customer assets' }],
        slackChannels: ['C123'],
        secrets: { OPENAI_API_KEY: 'encrypted-value' },
        chatSessions: [{ messages: [{ role: 'user', content: largeBlob }] }],
        onboardingEvents: [{ event: 'huge', payload: largeBlob }],
        rawWorkflowCache: largeBlob,
        connected_accounts: [{ account_id: 'acct-1', access_token: largeBlob }],
      },
    ];

    mockUserDb.getAllUsers.mockResolvedValue(users as any);
    mockSettingsService.getSetting.mockRejectedValue(new Error('Not found'));

    const res = await request(app)
      .get('/api/admin/users')
      .expect(200);

    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({
      userId: 'user-1',
      email: 'user1@test.com',
      roles: ['customer'],
      taskCount: 4,
      workflowCount: 2,
      chatSessionCount: 9,
      subscription_status: 'active',
      current_period_end: '2026-07-01',
      tokenUsage: {
        month: '2026-06',
        totalTokens: 123,
        totalCost: 1.23,
        resetDate: '2026-07-01',
      },
      googleDriveFolders: [{ folderId: 'folder-1', name: 'Customer assets' }],
      slackChannels: ['C123'],
      secretNames: ['OPENAI_API_KEY'],
    });
    expect(res.body[0].secrets).toBeUndefined();
    expect(res.body[0].chatSessions).toBeUndefined();
    expect(res.body[0].onboardingEvents).toBeUndefined();
    expect(res.body[0].rawWorkflowCache).toBeUndefined();
    expect(res.body[0].connected_accounts).toBeUndefined();
    expect(JSON.stringify(res.body).length).toBeLessThan(5_000);
  });
});
