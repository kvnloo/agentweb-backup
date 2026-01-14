import request from 'supertest';
import express from 'express';
import adminRoutes from '../routes/admin';
import jwt from 'jsonwebtoken';

// Mock auth + admin middleware so we always act as an admin
jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = { userId: 'admin-user-1', email: 'admin@example.com', isAdmin: true };
    next();
  },
}));

jest.mock('../middleware/admin', () => ({
  isAdmin: (_req: any, _res: any, next: any) => next(),
}));

// Mock userDb
jest.mock('../services/db', () => ({
  userDb: {
    getUserById: jest.fn(),
  },
}));

import { userDb } from '../services/db';

const mockUserDb = userDb as jest.Mocked<typeof userDb>;

let app: express.Application;

describe('Admin delegate access endpoint', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    app = express();
    app.use(express.json());
    app.use('/api/admin', adminRoutes);
  });

  it('should create delegate access token with 90 days expiration', async () => {
    const targetUserId = 'target-user-1';
    const targetUser = {
      userId: targetUserId,
      email: 'customer@example.com',
      roles: ['customer'],
    };

    mockUserDb.getUserById.mockResolvedValue(targetUser as any);

    const res = await request(app)
      .post(`/api/admin/users/${targetUserId}/delegate-access`)
      .set('Authorization', 'Bearer test-token')
      .expect(200);

    // Verify response structure
    expect(res.body).toHaveProperty('delegateToken');
    expect(res.body).toHaveProperty('customerPortalUrl');
    expect(res.body).toHaveProperty('expiresIn');
    
    // Verify expiration time is 90d
    expect(res.body.expiresIn).toBe('90d');

    // Verify the token is valid and has correct expiration
    const decoded = jwt.decode(res.body.delegateToken) as any;
    expect(decoded).toBeTruthy();
    expect(decoded.userId).toBe(targetUserId);
    expect(decoded.email).toBe('customer@example.com');
    expect(decoded.roles).toEqual(['customer']);
    expect(decoded.delegateAccess).toBeDefined();
    expect(decoded.delegateAccess.adminUserId).toBe('admin-user-1');
    expect(decoded.delegateAccess.adminEmail).toBe('admin@example.com');
    expect(decoded.delegateAccess.targetUserId).toBe(targetUserId);
    expect(decoded.delegateAccess.targetEmail).toBe('customer@example.com');

    // Verify token expiration is approximately 90 days from now
    const now = Math.floor(Date.now() / 1000);
    const expirationTime = decoded.exp;
    const daysUntilExpiration = (expirationTime - now) / (60 * 60 * 24);
    
    // Allow 1 day tolerance for test execution time
    expect(daysUntilExpiration).toBeGreaterThan(89);
    expect(daysUntilExpiration).toBeLessThan(91);
  });

  it('should return 404 when user does not exist', async () => {
    const targetUserId = 'non-existent-user';
    
    mockUserDb.getUserById.mockResolvedValue(null);

    const res = await request(app)
      .post(`/api/admin/users/${targetUserId}/delegate-access`)
      .set('Authorization', 'Bearer test-token')
      .expect(404);

    expect(res.body.message).toBe('User not found');
  });

  it('should return 400 when user does not have customer role', async () => {
    const targetUserId = 'partner-user-1';
    const targetUser = {
      userId: targetUserId,
      email: 'partner@example.com',
      roles: ['partner'],
    };

    mockUserDb.getUserById.mockResolvedValue(targetUser as any);

    const res = await request(app)
      .post(`/api/admin/users/${targetUserId}/delegate-access`)
      .set('Authorization', 'Bearer test-token')
      .expect(400);

    expect(res.body.message).toBe('User does not have customer portal access');
  });

  it('should return 400 when user has no roles', async () => {
    const targetUserId = 'no-role-user-1';
    const targetUser = {
      userId: targetUserId,
      email: 'norole@example.com',
      roles: [],
    };

    mockUserDb.getUserById.mockResolvedValue(targetUser as any);

    const res = await request(app)
      .post(`/api/admin/users/${targetUserId}/delegate-access`)
      .set('Authorization', 'Bearer test-token')
      .expect(400);

    expect(res.body.message).toBe('User does not have customer portal access');
  });
});
