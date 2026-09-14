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
    incrementDelegateTokenEpoch: jest.fn(),
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

  it('mints a short-lived token stamped with the target\'s revocation counters', async () => {
    const targetUserId = 'target-user-1';
    const targetUser = {
      userId: targetUserId,
      email: 'customer@example.com',
      roles: ['customer'],
      delegateTokenEpoch: 3,
      sessionVersion: 7,
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
    
    // ENG-1506: 90d of standing customer impersonation is not a security control.
    expect(res.body.expiresIn).toBe('8h');

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

    // ENG-1506: the two claims that make this token revocable. Without them the
    // middleware has nothing to compare against and the token is only bounded by
    // its expiry — which is the whole defect this ticket was filed for.
    expect(decoded.dte).toBe(3);
    expect(decoded.sv).toBe(7);

    // Hours, not months.
    const now = Math.floor(Date.now() / 1000);
    const hoursUntilExpiration = (decoded.exp - now) / (60 * 60);
    expect(hoursUntilExpiration).toBeGreaterThan(7.5);
    expect(hoursUntilExpiration).toBeLessThan(8.5);
  });

  // ENG-1907 AC5: a sandbox account is a real customer-portal account. Access
  // Portal opens it through the same callback as everyone else; only the token
  // scope differs (evaluation), so the auth layer still binds it to the candidate.
  it('routes an evaluation target through the customer-portal callback with an evaluation-scoped token', async () => {
    mockUserDb.getUserById.mockResolvedValue({ userId: 'eval_ryan', email: 'case@example.invalid', roles: ['customer'], delegateTokenEpoch: 2, sessionVersion: 3 } as any);
    const res = await request(app).post('/api/admin/users/eval_ryan/delegate-access').set('Host', 'evaluation.example.invalid').expect(200);
    expect(res.body.customerPortalUrl).toBe(`${process.env.CUSTOMER_FRONTEND_URL || 'http://localhost:5174'}/oauth-callback?token=${res.body.delegateToken}`);
    expect(res.body.customerPortalUrl).not.toContain('/evaluation');
    expect(jwt.decode(res.body.delegateToken)).toMatchObject({ userId: 'eval_ryan', dte: 2, sv: 3, isAdmin: false, delegateAccess: { scope: 'evaluation', targetUserId: 'eval_ryan' } });
    expect(res.body.expiresIn).toBe('8h');
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('preserves the existing customer portal callback for non-evaluation users', async () => {
    mockUserDb.getUserById.mockResolvedValue({ userId: 'customer', email: 'case@example.invalid', roles: ['customer'] } as any);
    const res = await request(app).post('/api/admin/users/customer/delegate-access').expect(200);
    expect(res.body.customerPortalUrl).toBe(`${process.env.CUSTOMER_FRONTEND_URL || 'http://localhost:5174'}/oauth-callback?token=${res.body.delegateToken}`);
    expect((jwt.decode(res.body.delegateToken) as any).delegateAccess.scope).toBeUndefined();
  });

  // A user who has never been delegated to, or predates the field entirely, has
  // no epoch. That must mint 0 rather than undefined, or the claim is absent and
  // the middleware's `?? 0` silently compares nothing.
  it('stamps 0 when the target has no counters yet', async () => {
    const targetUserId = 'fresh-user-1';
    mockUserDb.getUserById.mockResolvedValue({
      userId: targetUserId,
      email: 'fresh@example.com',
      roles: ['customer'],
    } as any);

    const res = await request(app)
      .post(`/api/admin/users/${targetUserId}/delegate-access`)
      .set('Authorization', 'Bearer test-token')
      .expect(200);

    const decoded = jwt.decode(res.body.delegateToken) as any;
    expect(decoded.dte).toBe(0);
    expect(decoded.sv).toBe(0);
  });

  describe('revoke', () => {
    it('bumps the epoch and reports the new value', async () => {
      mockUserDb.getUserById.mockResolvedValue({
        userId: 'target-user-1',
        email: 'customer@example.com',
        roles: ['customer'],
      } as any);
      (userDb.incrementDelegateTokenEpoch as jest.Mock).mockResolvedValue(4);

      const res = await request(app)
        .post('/api/admin/users/target-user-1/delegate-access/revoke')
        .set('Authorization', 'Bearer test-token')
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.delegateTokenEpoch).toBe(4);
      expect(userDb.incrementDelegateTokenEpoch).toHaveBeenCalledWith('target-user-1');
    });

    it('404s for an unknown user instead of bumping anything', async () => {
      mockUserDb.getUserById.mockResolvedValue(null as any);

      await request(app)
        .post('/api/admin/users/ghost/delegate-access/revoke')
        .set('Authorization', 'Bearer test-token')
        .expect(404);

      expect(userDb.incrementDelegateTokenEpoch).not.toHaveBeenCalled();
    });
  });

  it('should return 404 when user does not exist', async () => {
    const targetUserId = 'non-existent-user';
    
    mockUserDb.getUserById.mockResolvedValue(null as any);

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
