/**
 * Tests for the admin shadow-usage routes (routes/adminUsage.ts).
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

jest.mock('../../services/usageAnalyticsService', () => ({
  getUserUsageByModelDay: jest.fn(),
  getUsageComparison: jest.fn(),
  getUserXBreakdown: jest.fn(),
}));

import adminUsageRoutes from '../adminUsage';
import { authenticateToken } from '../../middleware/auth';
import {
  getUserUsageByModelDay,
  getUsageComparison,
  getUserXBreakdown,
} from '../../services/usageAnalyticsService';

const mockByModelDay = getUserUsageByModelDay as jest.Mock;
const mockComparison = getUsageComparison as jest.Mock;
const mockXBreakdown = getUserXBreakdown as jest.Mock;
const mockAuth = authenticateToken as unknown as jest.Mock;

let app: express.Application;

describe('admin usage routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAuth.mockImplementation((req: any, _res: any, next: any) => {
      req.user = { userId: 'admin-1', email: 'admin@example.com', isAdmin: true };
      next();
    });
    app = express();
    app.use(express.json());
    app.use('/api/admin', adminUsageRoutes);
  });

  describe('GET /api/admin/users/:userId/usage/by-model-day', () => {
    it('400s when start/end are missing or malformed', async () => {
      await request(app).get('/api/admin/users/u1/usage/by-model-day').expect(400);
      await request(app)
        .get('/api/admin/users/u1/usage/by-model-day?start=June&end=2026-06-30')
        .expect(400);
      expect(mockByModelDay).not.toHaveBeenCalled();
    });

    it('400s when start > end', async () => {
      await request(app)
        .get('/api/admin/users/u1/usage/by-model-day?start=2026-06-30&end=2026-06-01')
        .expect(400);
      expect(mockByModelDay).not.toHaveBeenCalled();
    });

    it('403s for non-admin users', async () => {
      mockAuth.mockImplementation((req: any, _res: any, next: any) => {
        req.user = { userId: 'basic-1', email: 'basic@example.com', isAdmin: false };
        next();
      });
      await request(app)
        .get('/api/admin/users/u1/usage/by-model-day?start=2026-06-01&end=2026-06-30')
        .expect(403);
      expect(mockByModelDay).not.toHaveBeenCalled();
    });

    it('returns the analytics payload for valid requests', async () => {
      const payload = { userId: 'u1', start: '2026-06-01', end: '2026-06-30', rows: [], totals: {} };
      mockByModelDay.mockResolvedValue(payload);

      const res = await request(app)
        .get('/api/admin/users/u1/usage/by-model-day?start=2026-06-01&end=2026-06-30')
        .expect(200);

      expect(res.body).toEqual(payload);
      expect(mockByModelDay).toHaveBeenCalledWith('u1', '2026-06-01', '2026-06-30');
    });

    it('500s (with a message) when the service throws', async () => {
      mockByModelDay.mockRejectedValue(new Error('dynamo down'));
      const res = await request(app)
        .get('/api/admin/users/u1/usage/by-model-day?start=2026-06-01&end=2026-06-30')
        .expect(500);
      expect(res.body.message).toBe('Failed to load usage');
      expect(res.body.error).toBe('dynamo down');
    });

    it('500s with "Unknown error" when a non-Error value is thrown', async () => {
      // The catch block does `error instanceof Error ? error.message : "Unknown error"`.
      // Rejecting with a non-Error exercises the falsy side of that ternary.
      mockByModelDay.mockRejectedValue('plain string failure');
      const res = await request(app)
        .get('/api/admin/users/u1/usage/by-model-day?start=2026-06-01&end=2026-06-30')
        .expect(500);
      expect(res.body.message).toBe('Failed to load usage');
      expect(res.body.error).toBe('Unknown error');
    });
  });

  describe('GET /api/admin/users/:userId/usage/comparison', () => {
    it('400s when month is missing or malformed', async () => {
      await request(app).get('/api/admin/users/u1/usage/comparison').expect(400);
      await request(app).get('/api/admin/users/u1/usage/comparison?month=2026-6').expect(400);
      expect(mockComparison).not.toHaveBeenCalled();
    });

    it('returns the comparison payload for valid requests', async () => {
      const payload = {
        userId: 'u1',
        month: '2026-06',
        shadow: { totalTokens: 10, costUsd: 0.1, callCount: 2 },
        legacy: { totalTokens: 8, costUsd: 0.08, source: 'current' },
        delta: { totalTokens: 2, costUsd: 0.02 },
      };
      mockComparison.mockResolvedValue(payload);

      const res = await request(app)
        .get('/api/admin/users/u1/usage/comparison?month=2026-06')
        .expect(200);

      expect(res.body).toEqual(payload);
      expect(mockComparison).toHaveBeenCalledWith('u1', '2026-06');
    });

    it('500s when the service throws', async () => {
      mockComparison.mockRejectedValue(new Error('boom'));
      const res = await request(app)
        .get('/api/admin/users/u1/usage/comparison?month=2026-06')
        .expect(500);
      expect(res.body.message).toBe('Failed to load usage comparison');
      expect(res.body.error).toBe('boom');
    });

    it('500s with "Unknown error" when a non-Error value is thrown', async () => {
      // Falsy side of `error instanceof Error ? error.message : "Unknown error"`.
      mockComparison.mockRejectedValue({ code: 'WEIRD' });
      const res = await request(app)
        .get('/api/admin/users/u1/usage/comparison?month=2026-06')
        .expect(500);
      expect(res.body.message).toBe('Failed to load usage comparison');
      expect(res.body.error).toBe('Unknown error');
    });
  });

  describe('GET /api/admin/users/:userId/usage/x-breakdown', () => {
    it('400s without valid start/end', async () => {
      await request(app)
        .get('/api/admin/users/u1/usage/x-breakdown?start=nope&end=2026-07-31')
        .expect(400);
      expect(mockXBreakdown).not.toHaveBeenCalled();
    });

    it('returns the per-user X breakdown for an admin', async () => {
      const payload = {
        userId: 'u1', start: '2026-07-01', end: '2026-07-31', costUsd: 0.065, callCount: 6,
        byOperation: [{ operation: 'search_tweets', callCount: 5, quantity: 10, costUsd: 0.05 }],
      };
      mockXBreakdown.mockResolvedValue(payload);
      const res = await request(app)
        .get('/api/admin/users/u1/usage/x-breakdown?start=2026-07-01&end=2026-07-31')
        .expect(200);
      expect(res.body).toEqual(payload);
      expect(mockXBreakdown).toHaveBeenCalledWith('u1', '2026-07-01', '2026-07-31');
    });

    it('403s for non-admin users', async () => {
      mockAuth.mockImplementation((req: any, _res: any, next: any) => {
        req.user = { userId: 'basic-1', email: 'basic@example.com', isAdmin: false };
        next();
      });
      await request(app)
        .get('/api/admin/users/u1/usage/x-breakdown?start=2026-07-01&end=2026-07-31')
        .expect(403);
      expect(mockXBreakdown).not.toHaveBeenCalled();
    });
  });

});
