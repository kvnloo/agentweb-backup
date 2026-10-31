/**
 * ENG-2771: GET /api/admin/usage/enforcement — read-only effective-allowance
 * lookup behind Emma's inspect_client_usage tool.
 */
import express from 'express';
import request from 'supertest';

let asAdmin = true;
jest.mock('../../middleware/auth', () => ({
  authenticateToken: jest.fn((req: any, _res: any, next: any) => {
    req.user = { userId: 'caller', isAdmin: asAdmin };
    next();
  }),
}));
jest.mock('../../middleware/admin', () => ({
  isAdmin: jest.fn((req: any, res: any, next: any) =>
    req.user?.isAdmin ? next() : res.status(403).json({ message: 'Access denied. Admin privileges required.' })),
}));
jest.mock('../../services/usageAnalyticsService', () => ({}));
jest.mock('../../services/spendEventDb', () => ({ listSpendEventsBounded: jest.fn() }));
jest.mock('../../services/usageRecordDb', () => ({ usageRecordDb: {} }));
jest.mock('../../services/tokenUsageService', () => ({ resolveBillingUserId: jest.fn(), checkTokenUsage: jest.fn() }));
jest.mock('../../services/db', () => ({
  userDb: { getUserById: jest.fn(), getUserByEmail: jest.fn(), updateUser: jest.fn() },
  orgDb: { getOrgMembers: jest.fn() },
}));
jest.mock('../../services/subscriptionService', () => ({ getSubscriptionTypeConfig: jest.fn() }));
jest.mock('../../services/llmUsageCreditService', () => ({ getLlmUsageCreditAdjustment: jest.fn() }));

import adminUsageRoutes from '../adminUsage';
import { checkTokenUsage, resolveBillingUserId } from '../../services/tokenUsageService';
import { userDb } from '../../services/db';

const app = express();
app.use('/api/admin', adminUsageRoutes);

const mockCheck = checkTokenUsage as jest.Mock;
const mockResolve = resolveBillingUserId as jest.Mock;
const mockByEmail = (userDb as any).getUserByEmail as jest.Mock;
const mockById = (userDb as any).getUserById as jest.Mock;

const status = (over: Record<string, unknown> = {}) => ({
  month: '2026-10', allowed: true, used: 100, effectiveAllowance: 1000, percentUsed: 10,
  costEnforced: false, costUsed: 0, costAllowance: null, costPercentUsed: 0,
  usagePolicyVersion: 'v3', ...over,
});

describe('ENG-2771 GET /api/admin/usage/enforcement', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    asAdmin = true;
    mockResolve.mockResolvedValue('owner-1');
    mockById.mockResolvedValue({ userId: 'u-9' });
  });

  it('reports a paused, cost-gated account via checkTokenUsage -> describeEnforcement on the billing owner', async () => {
    mockByEmail.mockResolvedValue({ userId: 'member-1' });
    mockCheck.mockResolvedValue(status({ allowed: false, costEnforced: true, costUsed: 912.5, costAllowance: 900, costPercentUsed: 101.4 }));
    const res = await request(app).get('/api/admin/usage/enforcement?email=Client@X.com');
    expect(res.status).toBe(200);
    expect(mockByEmail).toHaveBeenCalledWith('client@x.com');
    expect(mockResolve).toHaveBeenCalledWith('member-1');
    expect(mockCheck).toHaveBeenCalledWith('owner-1');
    expect(res.body).toMatchObject({
      billingUserId: 'owner-1',
      enforcement: {
        available: true, month: '2026-10', paused: true, gatedBy: 'cost', used: 912.5, limit: 900,
        percentUsed: 101.4, resetsOn: '2026-11-01', usagePolicyVersion: 'v3',
      },
    });
  });

  it('reports an unpaused token-gated account by userId', async () => {
    mockCheck.mockResolvedValue(status());
    const res = await request(app).get('/api/admin/usage/enforcement?userId=u-9');
    expect(res.status).toBe(200);
    expect(mockByEmail).not.toHaveBeenCalled();
    expect(res.body.enforcement).toMatchObject({ available: true, paused: false, gatedBy: 'tokens', used: 100, limit: 1000 });
  });

  it('reports unreadable enforcer state instead of failing', async () => {
    mockCheck.mockRejectedValue(new Error('ddb down'));
    const res = await request(app).get('/api/admin/usage/enforcement?userId=u-9');
    expect(res.status).toBe(200);
    expect(res.body.enforcement).toEqual({ available: false, reason: 'unreadable', message: "Could not read the enforcer's state" });
  });

  it('404s an unknown email and 400s a missing identifier', async () => {
    mockByEmail.mockResolvedValue(null);
    expect((await request(app).get('/api/admin/usage/enforcement?email=nobody@x.com')).status).toBe(404);
    expect((await request(app).get('/api/admin/usage/enforcement')).status).toBe(400);
    expect(mockCheck).not.toHaveBeenCalled();
  });

  it('404s an unknown userId and 400s conflicting identifiers (CodeRabbit #3859)', async () => {
    mockById.mockResolvedValue(null);
    expect((await request(app).get('/api/admin/usage/enforcement?userId=ghost-1')).status).toBe(404);
    expect((await request(app).get('/api/admin/usage/enforcement?userId=u-9&email=a@x.com')).status).toBe(400);
    expect((await request(app).get('/api/admin/usage/enforcement?email=a@x.com&email=b@x.com&userId=u-9')).status).toBe(400);
    expect(mockResolve).not.toHaveBeenCalled();
    expect(mockCheck).not.toHaveBeenCalled();
  });

  it('denies non-admin callers before any read', async () => {
    asAdmin = false;
    const res = await request(app).get('/api/admin/usage/enforcement?userId=u-9');
    expect(res.status).toBe(403);
    expect(mockResolve).not.toHaveBeenCalled();
    expect(mockCheck).not.toHaveBeenCalled();
  });

  it('performs no writes', async () => {
    mockCheck.mockResolvedValue(status());
    await request(app).get('/api/admin/usage/enforcement?userId=u-9');
    expect((userDb as any).updateUser).not.toHaveBeenCalled();
  });
});
