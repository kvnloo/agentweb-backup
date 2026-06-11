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

const mockUserDb = userDb as jest.Mocked<typeof userDb>;

const app = express();
app.use(express.json());
app.use('/api/admin', adminRoutes);

const existingUser = {
  userId: 'user-abc',
  email: 'user@example.com',
  isAdmin: false,
  isActive: true,
  slackChannels: ['C_ABC'],
};

describe('PUT /api/admin/users/:userId/slack-suggested-replies', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 404 when user does not exist', async () => {
    mockUserDb.getUserById.mockResolvedValue(null as any);
    const res = await request(app)
      .put('/api/admin/users/nonexistent/slack-suggested-replies')
      .send({ enabled: false });
    expect(res.status).toBe(404);
    expect(mockUserDb.updateUser).not.toHaveBeenCalled();
  });

  it('disables suggested replies (enabled: false → slackSuggestedRepliesDisabled: true)', async () => {
    mockUserDb.getUserById.mockResolvedValue(existingUser as any);
    mockUserDb.updateUser.mockResolvedValue({ ...existingUser, slackSuggestedRepliesDisabled: true } as any);

    const res = await request(app)
      .put('/api/admin/users/user-abc/slack-suggested-replies')
      .send({ enabled: false });

    expect(res.status).toBe(200);
    expect(mockUserDb.updateUser).toHaveBeenCalledWith('user-abc', { slackSuggestedRepliesDisabled: true });
    expect(res.body.slackSuggestedRepliesDisabled).toBe(true);
  });

  it('enables suggested replies (enabled: true → slackSuggestedRepliesDisabled: false)', async () => {
    mockUserDb.getUserById.mockResolvedValue({ ...existingUser, slackSuggestedRepliesDisabled: true } as any);
    mockUserDb.updateUser.mockResolvedValue({ ...existingUser, slackSuggestedRepliesDisabled: false } as any);

    const res = await request(app)
      .put('/api/admin/users/user-abc/slack-suggested-replies')
      .send({ enabled: true });

    expect(res.status).toBe(200);
    expect(mockUserDb.updateUser).toHaveBeenCalledWith('user-abc', { slackSuggestedRepliesDisabled: false });
  });

  it('coerces truthy non-boolean enabled to a boolean (string "true" → enabled)', async () => {
    mockUserDb.getUserById.mockResolvedValue(existingUser as any);
    mockUserDb.updateUser.mockResolvedValue(existingUser as any);

    const res = await request(app)
      .put('/api/admin/users/user-abc/slack-suggested-replies')
      .send({ enabled: 'true' });

    expect(res.status).toBe(200);
    // Any truthy value means "enabled", so disabled flag must be false
    expect(mockUserDb.updateUser).toHaveBeenCalledWith('user-abc', { slackSuggestedRepliesDisabled: false });
  });

  it('treats a missing enabled field as disabling (defaults disabled flag to true)', async () => {
    mockUserDb.getUserById.mockResolvedValue(existingUser as any);
    mockUserDb.updateUser.mockResolvedValue({ ...existingUser, slackSuggestedRepliesDisabled: true } as any);

    const res = await request(app)
      .put('/api/admin/users/user-abc/slack-suggested-replies')
      .send({});

    expect(res.status).toBe(200);
    expect(mockUserDb.updateUser).toHaveBeenCalledWith('user-abc', { slackSuggestedRepliesDisabled: true });
  });
});
