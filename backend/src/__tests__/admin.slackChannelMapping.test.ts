import request from 'supertest';
import express from 'express';
import adminRoutes from '../routes/admin';

jest.mock('../services/db', () => ({
  userDb: {
    getUserById: jest.fn(),
    updateUser: jest.fn(),
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
    invalidateSlackChannelMappingsForUser: jest.fn().mockResolvedValue(undefined),
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
const mockSettings = settingsService as jest.Mocked<typeof settingsService>;

const app = express();
app.use(express.json());
app.use('/api/admin', adminRoutes);

const existingUser = {
  userId: 'user-abc',
  email: 'user@example.com',
  isAdmin: false,
  isActive: true,
  slackChannels: ['C09HAPV2WM6'],
};

describe('PUT /api/admin/users/:userId/slack-channel — cache invalidation', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 404 when user does not exist', async () => {
    mockUserDb.getUserById.mockResolvedValue(null as any);
    const res = await request(app)
      .put('/api/admin/users/nonexistent/slack-channel')
      .send({ slackChannels: ['C_NEW'] });
    expect(res.status).toBe(404);
  });

  it('invalidates stale cache before updating channels', async () => {
    mockUserDb.getUserById.mockResolvedValue(existingUser as any);
    mockUserDb.updateUser.mockResolvedValue({ ...existingUser, slackChannels: ['C_NEW'] } as any);

    const res = await request(app)
      .put('/api/admin/users/user-abc/slack-channel')
      .send({ slackChannels: ['C_NEW'] });

    expect(res.status).toBe(200);
    expect(mockSettings.invalidateSlackChannelMappingsForUser).toHaveBeenCalledWith('user-abc');
    expect(mockSettings.invalidateSlackChannelMappingsForUser).toHaveBeenCalledTimes(1);
    expect(mockUserDb.updateUser).toHaveBeenCalledWith('user-abc', { slackChannels: ['C_NEW'] });
  });

  it('invalidates cache even when clearing channels to empty', async () => {
    mockUserDb.getUserById.mockResolvedValue(existingUser as any);
    mockUserDb.updateUser.mockResolvedValue({ ...existingUser, slackChannels: null } as any);

    const res = await request(app)
      .put('/api/admin/users/user-abc/slack-channel')
      .send({ slackChannels: [] });

    expect(res.status).toBe(200);
    expect(mockSettings.invalidateSlackChannelMappingsForUser).toHaveBeenCalledWith('user-abc');
    expect(mockUserDb.updateUser).toHaveBeenCalledWith('user-abc', { slackChannels: null });
  });

  it('invalidates cache when multiple channels are assigned', async () => {
    mockUserDb.getUserById.mockResolvedValue(existingUser as any);
    mockUserDb.updateUser.mockResolvedValue({ ...existingUser, slackChannels: ['C_A', 'C_B'] } as any);

    const res = await request(app)
      .put('/api/admin/users/user-abc/slack-channel')
      .send({ slackChannels: ['C_A', 'C_B'] });

    expect(res.status).toBe(200);
    expect(mockSettings.invalidateSlackChannelMappingsForUser).toHaveBeenCalledWith('user-abc');
    expect(mockUserDb.updateUser).toHaveBeenCalledWith('user-abc', { slackChannels: ['C_A', 'C_B'] });
  });

  it('strips whitespace and filters empty strings from channel list', async () => {
    mockUserDb.getUserById.mockResolvedValue(existingUser as any);
    mockUserDb.updateUser.mockResolvedValue({ ...existingUser, slackChannels: ['C_CLEAN'] } as any);

    const res = await request(app)
      .put('/api/admin/users/user-abc/slack-channel')
      .send({ slackChannels: ['  C_CLEAN  ', '', '  '] });

    expect(res.status).toBe(200);
    expect(mockUserDb.updateUser).toHaveBeenCalledWith('user-abc', { slackChannels: ['C_CLEAN'] });
  });
});
