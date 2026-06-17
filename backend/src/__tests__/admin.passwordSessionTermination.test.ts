import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';
import adminRoutes from '../routes/admin';

// Mock the dependencies
jest.mock('../services/db', () => ({
  userDb: {
    getUserById: jest.fn(),
    updateUser: jest.fn(),
    incrementSessionVersion: jest.fn(),
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

jest.mock('../services/sessionSockets', () => ({
  disconnectStaleUserSockets: jest.fn().mockResolvedValue(0),
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
import { disconnectStaleUserSockets } from '../services/sessionSockets';

const mockUserDb = userDb as jest.Mocked<typeof userDb>;
const mockDisconnect = disconnectStaleUserSockets as jest.Mock;

const app = express();
app.use(express.json());
app.use('/api/admin', adminRoutes);

describe('PUT /api/admin/users/:userId/password — session termination', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('FAIL: password missing → 400, no session termination', async () => {
    const res = await request(app)
      .put('/api/admin/users/user-1/password')
      .set('Authorization', 'Bearer test-token')
      .send({});

    expect(res.status).toBe(400);
    expect(mockUserDb.incrementSessionVersion).not.toHaveBeenCalled();
  });

  it('FAIL: password shorter than 12 chars → 400, no session termination', async () => {
    const res = await request(app)
      .put('/api/admin/users/user-1/password')
      .set('Authorization', 'Bearer test-token')
      .send({ password: 'short' });

    expect(res.status).toBe(400);
    expect(mockUserDb.incrementSessionVersion).not.toHaveBeenCalled();
  });

  it('FAIL: user does not exist → 404, password not written, no session termination', async () => {
    mockUserDb.getUserById.mockResolvedValue(null as any);

    const res = await request(app)
      .put('/api/admin/users/nonexistent/password')
      .set('Authorization', 'Bearer test-token')
      .send({ password: 'NewPassword123!' });

    expect(res.status).toBe(404);
    expect(mockUserDb.updateUser).not.toHaveBeenCalled();
    expect(mockUserDb.incrementSessionVersion).not.toHaveBeenCalled();
  });

  it('FAIL: incrementSessionVersion throws → 500', async () => {
    mockUserDb.getUserById.mockResolvedValue({ userId: 'user-1', email: 'u@e.com' } as any);
    mockUserDb.updateUser.mockResolvedValue({} as any);
    mockUserDb.incrementSessionVersion.mockRejectedValue(new Error('dynamo down'));

    const res = await request(app)
      .put('/api/admin/users/user-1/password')
      .set('Authorization', 'Bearer test-token')
      .send({ password: 'NewPassword123!' });

    expect(res.status).toBe(500);
  });

  it('SUCCESS: admin changes a user password → password updated AND every session terminated', async () => {
    mockUserDb.getUserById.mockResolvedValue({
      userId: 'user-1',
      email: 'user1@test.com',
      sessionVersion: 3,
    } as any);
    mockUserDb.updateUser.mockResolvedValue({} as any);
    mockUserDb.incrementSessionVersion.mockResolvedValue(4);

    const res = await request(app)
      .put('/api/admin/users/user-1/password')
      .set('Authorization', 'Bearer test-token')
      .send({ password: 'NewPassword123!' });

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Password updated successfully');

    // Password was written...
    expect(mockUserDb.updateUser).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ password: expect.any(String) })
    );
    // ...and every active session for the target user was invalidated.
    expect(mockUserDb.incrementSessionVersion).toHaveBeenCalledWith('user-1');
    expect(mockUserDb.incrementSessionVersion).toHaveBeenCalledTimes(1);
    // ...including live sockets, swept with the NEW session version.
    expect(mockDisconnect).toHaveBeenCalledWith('user-1', 4);
    // Acting on SOMEONE ELSE's account → no fresh token is returned.
    expect(res.body.token).toBeUndefined();
  });

  it('SUCCESS: admin resets OWN password → returns a fresh token carrying the new session version', async () => {
    process.env.JWT_SECRET = 'test-secret';
    // The mocked authenticateToken sets req.user.userId = 'admin-user-1'.
    mockUserDb.getUserById.mockResolvedValue({
      userId: 'admin-user-1',
      email: 'admin@example.com',
      roles: ['partner'],
      isAdmin: true,
      sessionVersion: 1,
    } as any);
    mockUserDb.updateUser.mockResolvedValue({} as any);
    mockUserDb.incrementSessionVersion.mockResolvedValue(2);

    const res = await request(app)
      .put('/api/admin/users/admin-user-1/password')
      .set('Authorization', 'Bearer test-token')
      .send({ password: 'NewPassword123!' });

    expect(res.status).toBe(200);
    expect(mockUserDb.incrementSessionVersion).toHaveBeenCalledWith('admin-user-1');
    expect(mockDisconnect).toHaveBeenCalledWith('admin-user-1', 2);

    // A fresh token is returned so the acting admin stays signed in...
    expect(typeof res.body.token).toBe('string');
    const decoded = jwt.verify(res.body.token, 'test-secret') as any;
    // ...and it carries the NEW session version, so it survives the bump.
    expect(decoded.sv).toBe(2);
    expect(decoded.userId).toBe('admin-user-1');
  });

  it('SUCCESS: session is terminated only after the password is persisted', async () => {
    const callOrder: string[] = [];
    mockUserDb.getUserById.mockResolvedValue({ userId: 'user-1', email: 'u@e.com' } as any);
    mockUserDb.updateUser.mockImplementation(async () => {
      callOrder.push('updateUser');
      return {} as any;
    });
    mockUserDb.incrementSessionVersion.mockImplementation(async () => {
      callOrder.push('incrementSessionVersion');
      return 1;
    });
    mockDisconnect.mockImplementation(async () => {
      callOrder.push('disconnectStaleUserSockets');
      return 0;
    });

    const res = await request(app)
      .put('/api/admin/users/user-1/password')
      .set('Authorization', 'Bearer test-token')
      .send({ password: 'NewPassword123!' });

    expect(res.status).toBe(200);
    // Sockets are swept only after the bump, which is only after the write.
    expect(callOrder).toEqual([
      'updateUser',
      'incrementSessionVersion',
      'disconnectStaleUserSockets',
    ]);
  });
});
