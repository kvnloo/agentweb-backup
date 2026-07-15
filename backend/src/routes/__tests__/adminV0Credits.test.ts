/**
 * Tests for the admin v0 credit-monitor route (routes/adminV0Credits.ts).
 *
 * Mirrors the adminUsage.test.ts pattern: pass-through auth mocks by default,
 * individual tests flip behavior; the billing service is fully mocked.
 */

import express from 'express';
import request from 'supertest';

// Pass-through auth by default; individual tests flip behavior.
jest.mock('../../middleware/auth', () => ({
  authenticateToken: jest.fn((req: any, _res: any, next: any) => {
    req.user = { userId: 'admin-1', email: 'admin@example.com', isAdmin: true };
    next();
  }),
}));

jest.mock('../../middleware/admin', () => ({
  isAdmin: jest.fn((req: any, res: any, next: any) => {
    if (!req.user?.isAdmin) {
      return res.status(403).json({ message: 'Access denied. Admin privileges required.' });
    }
    next();
  }),
}));

jest.mock('../../services/v0BillingService', () => ({
  getV0Credits: jest.fn(),
}));

import adminV0CreditsRoutes from '../adminV0Credits';
import { authenticateToken } from '../../middleware/auth';
import { getV0Credits } from '../../services/v0BillingService';

const mockGetV0Credits = getV0Credits as jest.Mock;
const mockAuth = authenticateToken as unknown as jest.Mock;

const DTO = {
  plan: 'v0-team',
  billingCycle: { start: 1781938800000, end: 1784530800000 },
  monthly: { remaining: 2, total: 30 },
  onDemand: { remaining: 10.7621578, total: 50 },
  totalSpendableUsd: 12.76,
  rateLimits: {
    limit: 250,
    remaining: 250,
    reset: 1783814400000,
    daily: { limit: 7, remaining: 7, reset: 1783814400000 },
  },
  warnLevel: 'low',
  fetchedAt: '2026-07-11T00:00:00.000Z',
};

let app: express.Application;

describe('GET /api/admin/v0/credits', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAuth.mockImplementation((req: any, _res: any, next: any) => {
      req.user = { userId: 'admin-1', email: 'admin@example.com', isAdmin: true };
      next();
    });
    app = express();
    app.use(express.json());
    app.use('/api/admin', adminV0CreditsRoutes);
  });

  it('returns the credits DTO for admins', async () => {
    mockGetV0Credits.mockResolvedValue(DTO);

    const res = await request(app).get('/api/admin/v0/credits').expect(200);

    expect(res.body).toEqual(DTO);
    expect(mockGetV0Credits).toHaveBeenCalledWith({ forceRefresh: false });
  });

  it('passes forceRefresh through when ?refresh=1', async () => {
    mockGetV0Credits.mockResolvedValue(DTO);

    await request(app).get('/api/admin/v0/credits?refresh=1').expect(200);

    expect(mockGetV0Credits).toHaveBeenCalledWith({ forceRefresh: true });
  });

  it('403s for non-admin users', async () => {
    mockAuth.mockImplementation((req: any, _res: any, next: any) => {
      req.user = { userId: 'basic-1', email: 'basic@example.com', isAdmin: false };
      next();
    });

    await request(app).get('/api/admin/v0/credits').expect(403);
    expect(mockGetV0Credits).not.toHaveBeenCalled();
  });

  it('502s with the error surfaced when the v0 API fails — never fabricated balances', async () => {
    mockGetV0Credits.mockRejectedValue(new Error('v0 billing request failed: 500'));

    const res = await request(app).get('/api/admin/v0/credits').expect(502);

    expect(res.body.message).toBe('Failed to fetch v0 billing');
    expect(res.body.error).toBe('v0 billing request failed: 500');
    // No balance fields on the error body — callers must not mistake it for data.
    expect(res.body.totalSpendableUsd).toBeUndefined();
    expect(res.body.monthly).toBeUndefined();
  });

  it('502s with "Unknown error" when a non-Error value is thrown', async () => {
    mockGetV0Credits.mockRejectedValue('plain string failure');

    const res = await request(app).get('/api/admin/v0/credits').expect(502);
    expect(res.body.message).toBe('Failed to fetch v0 billing');
    expect(res.body.error).toBe('Unknown error');
  });
});
