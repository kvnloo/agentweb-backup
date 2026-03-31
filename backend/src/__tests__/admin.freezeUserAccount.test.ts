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

jest.mock('../services/db', () => ({
  userDb: {
    getUserById: jest.fn(),
    deactivateUser: jest.fn(),
    reactivateUser: jest.fn(),
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

describe('POST /api/admin/users/:userId/deactivate', () => {
  it('returns 404 when user not found', async () => {
    mockUserDb.getUserById.mockResolvedValue(null as any);
    const res = await request(app).post('/api/admin/users/missing-id/deactivate');
    expect(res.status).toBe(404);
    expect(res.body.message).toBe('User not found');
  });

  it('returns 403 when attempting to deactivate an admin user', async () => {
    mockUserDb.getUserById.mockResolvedValue({ userId: 'admin-id', isAdmin: true, isActive: true } as any);
    const res = await request(app).post('/api/admin/users/admin-id/deactivate');
    expect(res.status).toBe(403);
    expect(res.body.message).toBe('Cannot deactivate admin users');
  });

  it('returns 400 when user is already deactivated', async () => {
    mockUserDb.getUserById.mockResolvedValue({ userId: 'user-1', isAdmin: false, isActive: false } as any);
    const res = await request(app).post('/api/admin/users/user-1/deactivate');
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('User is already deactivated');
  });

  it('deactivates an active user successfully', async () => {
    const updatedUser = { userId: 'user-1', email: 'bot@example.com', isActive: false };
    mockUserDb.getUserById.mockResolvedValue({ userId: 'user-1', isAdmin: false, isActive: true } as any);
    mockUserDb.deactivateUser.mockResolvedValue(updatedUser as any);
    const res = await request(app).post('/api/admin/users/user-1/deactivate');
    expect(res.status).toBe(200);
    expect(res.body.isActive).toBe(false);
    expect(mockUserDb.deactivateUser).toHaveBeenCalledWith('user-1');
  });
});

describe('POST /api/admin/users/:userId/reactivate', () => {
  it('returns 404 when user not found', async () => {
    mockUserDb.getUserById.mockResolvedValue(null as any);
    const res = await request(app).post('/api/admin/users/missing-id/reactivate');
    expect(res.status).toBe(404);
    expect(res.body.message).toBe('User not found');
  });

  it('returns 400 when user is already active', async () => {
    mockUserDb.getUserById.mockResolvedValue({ userId: 'user-1', isActive: true } as any);
    const res = await request(app).post('/api/admin/users/user-1/reactivate');
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('User is already active');
  });

  it('reactivates a deactivated user successfully', async () => {
    const updatedUser = { userId: 'user-1', email: 'bot@example.com', isActive: true };
    mockUserDb.getUserById.mockResolvedValue({ userId: 'user-1', isActive: false } as any);
    mockUserDb.reactivateUser.mockResolvedValue(updatedUser as any);
    const res = await request(app).post('/api/admin/users/user-1/reactivate');
    expect(res.status).toBe(200);
    expect(res.body.isActive).toBe(true);
    expect(mockUserDb.reactivateUser).toHaveBeenCalledWith('user-1');
  });
});
