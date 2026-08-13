/**
 * ENG-1138 AC7 — admin usage-credit grants need an immutable audit trail with
 * actor, reason, and before/after balance. The ledger update and audit write
 * go through DynamoDB TransactWriteItems so the two land together or not at
 * all — a follow-up call would permanently orphan grants whenever the audit
 * write fails (retry short-circuits on the persisted grantId and never
 * re-attempts).
 */

const mockTransactWrite = jest.fn<{ promise: () => Promise<any> }, any[]>(() => ({ promise: async () => ({}) }));
const mockUpdateUser = jest.fn<Promise<void>, any[]>(async () => {});
const mockGetUserById = jest.fn<Promise<any>, any[]>();
const mockRecord = jest.fn<Promise<void>, any[]>(async () => {});

jest.mock('aws-sdk', () => {
  const actual = jest.requireActual('aws-sdk');
  return {
    ...actual,
    DynamoDB: {
      ...actual.DynamoDB,
      DocumentClient: jest.fn(() => ({ transactWrite: (...a: any[]) => mockTransactWrite(...a) })),
    },
  };
});

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
  mockTransactWrite.mockReturnValue({ promise: async () => ({}) });
  mockGetUserById.mockResolvedValue({
    userId: 'u1',
    email: 'u1@example.com',
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
  it('writes ledger + audit atomically via TransactWriteItems, with amount in cents and micro-USD in metadata', async () => {
    await grantMonthlyLlmUsageCredit({
      billingUserId: 'u1',
      grantId: 'admin:incident-4291',
      source: 'admin',
      amountMicroUsd: 5_000_000,
      grantedBy: 'admin@agentweb.pro',
      reason: 'Compensate for outage on 2026-08-14',
      now: NOW,
    });

    expect(mockTransactWrite).toHaveBeenCalledTimes(1);
    const params = mockTransactWrite.mock.calls[0]![0] as any;
    expect(params.TransactItems).toHaveLength(2);

    const [ledgerOp, auditOp] = params.TransactItems;
    expect(ledgerOp.Update.TableName).toMatch(/AW-Users$/);
    expect(ledgerOp.Update.Key).toEqual({ email: 'u1@example.com' });
    expect(ledgerOp.Update.ConditionExpression).toBeTruthy();

    expect(auditOp.Put.TableName).toMatch(/AW-PaymentHistory$/);
    expect(auditOp.Put.Item).toMatchObject({
      userId: 'u1',
      eventType: 'admin_credit_grant',
      // Cents, not micro-USD — payment-history convention.
      amount: 500,
      currency: 'usd',
      status: 'granted',
      metadata: expect.objectContaining({
        grantId: 'admin:incident-4291',
        grantedBy: 'admin@agentweb.pro',
        reason: 'Compensate for outage on 2026-08-14',
        amountMicroUsd: 5_000_000,
        beforeAllowanceMicroUsd: 10_000_000,
        afterAllowanceMicroUsd: 15_000_000,
      }),
    });

    // Non-admin paths still use userDb.updateUser; admin path routes exclusively
    // through the transaction, so neither the plain update nor the standalone
    // paymentHistoryDb.record fires here.
    expect(mockUpdateUser).not.toHaveBeenCalled();
    expect(mockRecord).not.toHaveBeenCalled();
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

    const params = mockTransactWrite.mock.calls[0]![0] as any;
    const auditItem = params.TransactItems[1].Put.Item;
    expect(auditItem.metadata.grantedBy).toBe('ops@agentweb.pro');
    expect(auditItem.metadata.reason).toBeUndefined();
  });

  it('does not write an audit record for purchase-sourced grants', async () => {
    await grantMonthlyLlmUsageCredit({
      billingUserId: 'u1',
      grantId: 'stripe:cs_test_2',
      source: 'purchase',
      amountMicroUsd: 4_000_000,
      now: NOW,
    });

    expect(mockTransactWrite).not.toHaveBeenCalled();
    expect(mockUpdateUser).toHaveBeenCalledTimes(1);
  });

  it('does not write an audit record for migration-sourced grants', async () => {
    await grantMonthlyLlmUsageCredit({
      billingUserId: 'u1',
      grantId: 'migration:2026-08:u1',
      source: 'migration',
      amountMicroUsd: 30_000_000,
      now: NOW,
    });

    expect(mockTransactWrite).not.toHaveBeenCalled();
    expect(mockUpdateUser).toHaveBeenCalledTimes(1);
  });

  it('does not re-run the transaction on idempotent retry with an existing admin grant id', async () => {
    mockGetUserById.mockResolvedValue({
      userId: 'u1',
      email: 'u1@example.com',
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
    expect(mockTransactWrite).not.toHaveBeenCalled();
  });

  it('audits the before-balance from an existing admin-granted amount, not zero', async () => {
    mockGetUserById.mockResolvedValue({
      userId: 'u1',
      email: 'u1@example.com',
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

    const params = mockTransactWrite.mock.calls[0]![0] as any;
    const auditItem = params.TransactItems[1].Put.Item;
    expect(auditItem.metadata.beforeAllowanceMicroUsd).toBe(15_000_000);
    expect(auditItem.metadata.afterAllowanceMicroUsd).toBe(17_000_000);
  });

  it('retries on a TransactionCanceledException with a ConditionalCheckFailed reason', async () => {
    const cancelErr: any = new Error('Transaction canceled');
    cancelErr.code = 'TransactionCanceledException';
    cancelErr.CancellationReasons = [{ Code: 'ConditionalCheckFailed' }, { Code: 'None' }];
    mockTransactWrite
      .mockReturnValueOnce({ promise: async () => { throw cancelErr; } })
      .mockReturnValueOnce({ promise: async () => ({}) });

    const result = await grantMonthlyLlmUsageCredit({
      billingUserId: 'u1',
      grantId: 'admin:retry-me',
      source: 'admin',
      amountMicroUsd: 3_000_000,
      grantedBy: 'admin@agentweb.pro',
      now: NOW,
    });

    expect(result.granted).toBe(true);
    expect(mockTransactWrite).toHaveBeenCalledTimes(2);
    // getUserById is re-fetched on every attempt so the ledger snapshot stays fresh.
    expect(mockGetUserById).toHaveBeenCalledTimes(2);
  });

  it('propagates non-conditional transaction errors instead of retrying', async () => {
    const throttleErr: any = new Error('Rate exceeded');
    throttleErr.code = 'ProvisionedThroughputExceededException';
    mockTransactWrite.mockReturnValueOnce({ promise: async () => { throw throttleErr; } });

    await expect(
      grantMonthlyLlmUsageCredit({
        billingUserId: 'u1',
        grantId: 'admin:no-retry',
        source: 'admin',
        amountMicroUsd: 1_000_000,
        grantedBy: 'admin@agentweb.pro',
        now: NOW,
      }),
    ).rejects.toThrow('Rate exceeded');

    // Neither the ledger nor the audit landed — the whole transaction failed,
    // so no partial state escapes and nothing needs backfilling.
    expect(mockTransactWrite).toHaveBeenCalledTimes(1);
  });
});
