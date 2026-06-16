/**
 * PUT /api/admin/users/:userId/password
 *
 * When an admin sets a password for a user, it becomes the user's own
 * long-term password — so any system-generated initial-password lifecycle
 * flags (mustChangePassword / tempPasswordExpires) MUST be cleared. Otherwise
 * the login expiry guard would lock the user out once the original 1-month
 * window elapsed, even though the password is no longer system-generated.
 */

import request from 'supertest';
import express from 'express';
import adminRoutes from '../routes/admin';

jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = { userId: 'admin-user-1', email: 'admin@example.com', isAdmin: true };
    next();
  },
}));

jest.mock('../middleware/admin', () => ({
  isAdmin: (_req: any, _res: any, next: any) => next(),
}));

jest.mock('bcryptjs', () => ({
  hash: jest.fn().mockResolvedValue('hashed-admin-password'),
}));

jest.mock('../services/db', () => ({
  userDb: {
    getUserById: jest.fn(),
    updateUser: jest.fn(),
  },
}));

import { userDb } from '../services/db';
const mockUserDb = userDb as jest.Mocked<typeof userDb>;

let app: express.Application;

beforeEach(() => {
  jest.clearAllMocks();
  app = express();
  app.use(express.json());
  app.use('/api/admin', adminRoutes);
});

describe('PUT /api/admin/users/:userId/password', () => {
  it('rejects passwords shorter than 6 characters', async () => {
    const res = await request(app)
      .put('/api/admin/users/user-1/password')
      .send({ password: 'abc' });
    expect(res.status).toBe(400);
    expect(mockUserDb.updateUser).not.toHaveBeenCalled();
  });

  it('returns 404 when the user does not exist', async () => {
    mockUserDb.getUserById.mockResolvedValue(undefined as any);
    const res = await request(app)
      .put('/api/admin/users/missing/password')
      .send({ password: 'ValidPass1' });
    expect(res.status).toBe(404);
    expect(mockUserDb.updateUser).not.toHaveBeenCalled();
  });

  it('updates the password and clears temp-password lifecycle flags', async () => {
    mockUserDb.getUserById.mockResolvedValue({ userId: 'user-1', email: 'u@x.com' } as any);
    mockUserDb.updateUser.mockResolvedValue({ userId: 'user-1' } as any);

    const res = await request(app)
      .put('/api/admin/users/user-1/password')
      .send({ password: 'ValidPass1' });

    expect(res.status).toBe(200);
    expect(mockUserDb.updateUser).toHaveBeenCalledWith('user-1', {
      password: 'hashed-admin-password',
      mustChangePassword: false,
      tempPasswordExpires: null,
    });
  });
});
