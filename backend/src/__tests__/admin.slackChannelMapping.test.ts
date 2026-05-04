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
    invalidateSlackChannelMappings: jest.fn().mockResolvedValue(undefined),
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
  slackChannels: ['C_OLD'],
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

  it('invalidates by userId and by channel ID when updating channels', async () => {
    mockUserDb.getUserById.mockResolvedValue(existingUser as any);
    mockUserDb.updateUser.mockResolvedValue({ ...existingUser, slackChannels: ['C_NEW'] } as any);

    const res = await request(app)
      .put('/api/admin/users/user-abc/slack-channel')
      .send({ slackChannels: ['C_NEW'] });

    expect(res.status).toBe(200);
    expect(mockSettings.invalidateSlackChannelMappings).toHaveBeenCalledWith(
      'user-abc',
      expect.arrayContaining(['C_OLD', 'C_NEW'])
    );
    expect(mockSettings.invalidateSlackChannelMappings).toHaveBeenCalledTimes(1);
    expect(mockUserDb.updateUser).toHaveBeenCalledWith('user-abc', { slackChannels: ['C_NEW'] });
  });

  it('invalidates stale cache for a channel previously assigned to a different user', async () => {
    // Simulates the waldium bug: channel C0AJVBQ49TN was cached under Jeff's userId,
    // but now being assigned to amrutha. Both Jeff's old userId AND the channel ID
    // must be cleared from the cache.
    const amrutha = { userId: 'amrutha-id', email: 'amrutha@structuredlabs.com', slackChannels: ['C0AJVBQ49TN'] };
    mockUserDb.getUserById.mockResolvedValue(amrutha as any);
    mockUserDb.updateUser.mockResolvedValue(amrutha as any);

    const res = await request(app)
      .put('/api/admin/users/amrutha-id/slack-channel')
      .send({ slackChannels: ['C0AJVBQ49TN'] });

    expect(res.status).toBe(200);
    expect(mockSettings.invalidateSlackChannelMappings).toHaveBeenCalledWith(
      'amrutha-id',
      expect.arrayContaining(['C0AJVBQ49TN'])
    );
  });

  it('invalidates cache when clearing channels to empty', async () => {
    mockUserDb.getUserById.mockResolvedValue(existingUser as any);
    mockUserDb.updateUser.mockResolvedValue({ ...existingUser, slackChannels: null } as any);

    const res = await request(app)
      .put('/api/admin/users/user-abc/slack-channel')
      .send({ slackChannels: [] });

    expect(res.status).toBe(200);
    expect(mockSettings.invalidateSlackChannelMappings).toHaveBeenCalledWith(
      'user-abc',
      expect.arrayContaining(['C_OLD'])
    );
    expect(mockUserDb.updateUser).toHaveBeenCalledWith('user-abc', { slackChannels: null });
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
