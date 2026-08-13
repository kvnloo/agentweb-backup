/**
 * ENG-1138 AC7 — admin usage-credit grants need an immutable audit trail with
 * actor, reason, and before/after balance. Grant-side extension only; refunds
 * and Stripe purchases already write payment-history entries elsewhere.
 */

const mockRecord = jest.fn<Promise<void>, any[]>(async () => {});
const mockUpdateUser = jest.fn<Promise<void>, any[]>(async () => {});
const mockGetUserById = jest.fn<Promise<any>, any[]>();

jest.mock('../services/db', () => ({
  userDb: {
    getUserById: (...a: any[]) => mockGetUserById(...a),
    updateUser: (...a: any[]) => mockUpdateUser(...a),
  },
}));

jest.mock('../services/paymentHistoryDb', () => ({
  paymentHistoryDb: { record: (...a: any[]) => mockRecord(...a) },
}));

import { grantMonthlyLlmUsageCredit } from '../services/llmUsageCreditService';

const NOW = new Date('2026-08-15T00:00:00.000Z');

beforeEach(() => {
  jest.clearAllMocks();
  mockGetUserById.mockResolvedValue({
    userId: 'u1',
    llmUsageCredits: {
      month: '2026-08',
      version: 1,
      totalPurchasedMicroUsd: 10_000_000,
      totalPurchasedReversedMicroUsd: 0,
      totalAdminGrantedMicroUsd: 0,
      totalMigrationOffsetMicroUsd: 0,
      grantIds: ['stripe:existing'],
      grants: [{ id: 'stripe:existing', source: 'purchase', amountMicroUsd: 10_000_000, grantedAt: '2026-08-01T00:00:00.000Z' }],
      reversalIds: [],
      reversals: [],
    },
  });
});

describe('admin-grant audit trail (AC7)', () => {
  it('writes an immutable payment-history record with actor, reason, and before/after balance', async () => {
    await grantMonthlyLlmUsageCredit({
      billingUserId: 'u1',
      grantId: 'admin:incident-4291',
      source: 'admin',
      amountMicroUsd: 5_000_000,
      grantedBy: 'admin@agentweb.pro',
      reason: 'Compensate for outage on 2026-08-14',
      now: NOW,
    });

    expect(mockRecord).toHaveBeenCalledTimes(1);
    const arg = mockRecord.mock.calls[0]![0] as any;
    expect(arg).toMatchObject({
      userId: 'u1',
      eventType: 'admin_credit_grant',
      amount: 5_000_000,
      status: 'granted',
      metadata: expect.objectContaining({
        grantId: 'admin:incident-4291',
        grantedBy: 'admin@agentweb.pro',
        reason: 'Compensate for outage on 2026-08-14',
        beforeAllowanceMicroUsd: 10_000_000,
        afterAllowanceMicroUsd: 15_000_000,
      }),
    });
  });

  it('records the actor even when reason is omitted', async () => {
    await grantMonthlyLlmUsageCredit({
      billingUserId: 'u1',
      grantId: 'admin:no-reason',
      source: 'admin',
      amountMicroUsd: 1_000_000,
      grantedBy: 'ops@agentweb.pro',
      now: NOW,
    });

    expect(mockRecord).toHaveBeenCalledTimes(1);
    const arg = mockRecord.mock.calls[0]![0] as any;
    expect(arg.metadata.grantedBy).toBe('ops@agentweb.pro');
    expect(arg.metadata.reason).toBeUndefined();
  });

  it('does not write an audit record for purchase-sourced grants', async () => {
    await grantMonthlyLlmUsageCredit({
      billingUserId: 'u1',
      grantId: 'stripe:cs_test_2',
      source: 'purchase',
      amountMicroUsd: 4_000_000,
      now: NOW,
    });

    expect(mockRecord).not.toHaveBeenCalled();
  });

  it('does not write an audit record for migration-sourced grants', async () => {
    await grantMonthlyLlmUsageCredit({
      billingUserId: 'u1',
      grantId: 'migration:2026-08:u1',
      source: 'migration',
      amountMicroUsd: 30_000_000,
      now: NOW,
    });

    expect(mockRecord).not.toHaveBeenCalled();
  });

  it('does not double-write the audit record when the same admin grant id is retried', async () => {
    mockGetUserById.mockResolvedValue({
      userId: 'u1',
      llmUsageCredits: {
        month: '2026-08',
        version: 2,
        totalPurchasedMicroUsd: 10_000_000,
        totalPurchasedReversedMicroUsd: 0,
        totalAdminGrantedMicroUsd: 5_000_000,
        totalMigrationOffsetMicroUsd: 0,
        grantIds: ['stripe:existing', 'admin:incident-4291'],
        grants: [],
        reversalIds: [],
        reversals: [],
      },
    });

    const result = await grantMonthlyLlmUsageCredit({
      billingUserId: 'u1',
      grantId: 'admin:incident-4291',
      source: 'admin',
      amountMicroUsd: 5_000_000,
      grantedBy: 'admin@agentweb.pro',
      now: NOW,
    });

    expect(result.granted).toBe(false);
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it('audits the before-balance from an existing admin-granted amount, not zero', async () => {
    mockGetUserById.mockResolvedValue({
      userId: 'u1',
      llmUsageCredits: {
        month: '2026-08',
        version: 2,
        totalPurchasedMicroUsd: 10_000_000,
        totalPurchasedReversedMicroUsd: 0,
        totalAdminGrantedMicroUsd: 5_000_000,
        totalMigrationOffsetMicroUsd: 0,
        grantIds: ['stripe:existing', 'admin:prior'],
        grants: [],
        reversalIds: [],
        reversals: [],
      },
    });

    await grantMonthlyLlmUsageCredit({
      billingUserId: 'u1',
      grantId: 'admin:incident-4292',
      source: 'admin',
      amountMicroUsd: 2_000_000,
      grantedBy: 'admin@agentweb.pro',
      now: NOW,
    });

    const arg = mockRecord.mock.calls[0]![0] as any;
    expect(arg.metadata.beforeAllowanceMicroUsd).toBe(15_000_000);
    expect(arg.metadata.afterAllowanceMicroUsd).toBe(17_000_000);
  });
});
