import express from 'express';
import request from 'supertest';

jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = { userId: 'admin-1', email: 'admin@agentweb.pro', isAdmin: true };
    next();
  },
}));
jest.mock('../middleware/admin', () => ({ isAdmin: (_req: any, _res: any, next: any) => next() }));
jest.mock('../services/db', () => ({
  userDb: { getUserById: jest.fn() },
  taskDb: {}, subscriberDb: {}, crmDb: {}, orgDb: {},
  chatbotDb: {},
}));
jest.mock('../services/tokenUsageService', () => ({
  resolveBillingUserId: jest.fn(),
  grantTokenBonus: jest.fn(),
  getUserTokenUsage: jest.fn(),
  getUserTokenAllowance: jest.fn(),
}));
jest.mock('../services/llmUsageCreditService', () => ({
  grantMonthlyLlmUsageCredit: jest.fn(),
}));

import adminRoutes from '../routes/admin';
import { userDb } from '../services/db';
import { resolveBillingUserId } from '../services/tokenUsageService';
import { grantMonthlyLlmUsageCredit } from '../services/llmUsageCreditService';

const mockedUserDb = userDb as jest.Mocked<typeof userDb>;
const mockedResolveBillingUserId = resolveBillingUserId as jest.Mock;
const mockedGrant = grantMonthlyLlmUsageCredit as jest.Mock;

describe('admin one-time LLM usage credits', () => {
  const app = express();
  app.use(express.json());
  app.use('/api/admin', adminRoutes);

  beforeEach(() => {
    jest.clearAllMocks();
    mockedUserDb.getUserById.mockResolvedValue({ userId: 'member-1', email: 'member@agentweb.pro' } as any);
    mockedResolveBillingUserId.mockResolvedValue('owner-1');
    mockedGrant.mockResolvedValue({
      granted: true,
      billingUserId: 'owner-1',
      ledger: {
        month: '2026-08', totalPurchasedMicroUsd: 0, totalAdminGrantedMicroUsd: 500_000_000,
        totalMigrationOffsetMicroUsd: 0, grantIds: ['admin:owner-1:grow106_123'], grants: [],
      },
    });
  });

  it('grants provider-cost credit to the org billing root with audit metadata', async () => {
    const res = await request(app)
      .post('/api/admin/users/member-1/llm-usage-credit')
      .send({ amountUsd: 500, reason: 'GROW-106 founder event', idempotencyKey: 'grow106_123' })
      .expect(200);

    expect(mockedResolveBillingUserId).toHaveBeenCalledWith('member-1');
    expect(mockedGrant).toHaveBeenCalledWith(expect.objectContaining({
      billingUserId: 'owner-1',
      source: 'admin',
      amountMicroUsd: 500_000_000,
      reason: 'GROW-106 founder event',
      grantedBy: 'admin@agentweb.pro',
      grantId: 'admin:owner-1:grow106_123',
    }));
    expect(res.body).toMatchObject({ granted: true, billingUserId: 'owner-1', amountUsd: 500 });
  });

  it.each([
    [{ amountUsd: 0, reason: 'x', idempotencyKey: 'valid_key' }, 'amountUsd'],
    [{ amountUsd: 10, reason: '', idempotencyKey: 'valid_key' }, 'reason'],
    [{ amountUsd: 10, reason: 'x', idempotencyKey: 'short' }, 'idempotencyKey'],
    // Sub-cent amounts fail with a clean 400 instead of a generic 500 from
    // the whole-cent check in grantMonthlyLlmUsageCredit. 0.005 = half a cent.
    [{ amountUsd: 0.005, reason: 'x', idempotencyKey: 'valid_key' }, 'whole cents'],
  ])('rejects an invalid grant before writing: %p', async (payload, message) => {
    const res = await request(app)
      .post('/api/admin/users/member-1/llm-usage-credit')
      .send(payload)
      .expect(400);
    expect(res.body.message).toContain(message);
    expect(mockedGrant).not.toHaveBeenCalled();
  });

  it('returns an idempotent no-op result for a repeated admin action', async () => {
    mockedGrant.mockResolvedValueOnce({
      granted: false,
      billingUserId: 'owner-1',
      ledger: {
        month: '2026-08', totalPurchasedMicroUsd: 0, totalAdminGrantedMicroUsd: 10_000_000,
        totalMigrationOffsetMicroUsd: 0, grantIds: ['admin:owner-1:grow106_123'], grants: [],
      },
    });
    const res = await request(app)
      .post('/api/admin/users/member-1/llm-usage-credit')
      .send({ amountUsd: 10, reason: 'GROW-106 founder event', idempotencyKey: 'grow106_123' })
      .expect(200);
    expect(res.body.granted).toBe(false);
  });
});
