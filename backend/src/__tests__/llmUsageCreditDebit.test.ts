/**
 * ENG-1138 AC5a — append-only debit entries against the AgentWeb Credits
 * wallet. This PR (PR2) ships the data structure and the standalone debit
 * function; a follow-up PR wires it into meterUserUsage's chokepoint so
 * every over-hard-cap charge produces a debit keyed to its work id.
 *
 * The debit function is deliberately idempotent by `workId`: retry-safe so
 * fire-and-forget from the meter path can be re-attempted after a transient
 * DynamoDB failure without double-debiting.
 */

const mockUpdateUser = jest.fn<Promise<void>, any[]>(async () => {});
const mockGetUserById = jest.fn<Promise<any>, any[]>();

jest.mock('../services/db', () => ({
  userDb: {
    getUserById: (...a: any[]) => mockGetUserById(...a),
    updateUser: (...a: any[]) => mockUpdateUser(...a),
  },
}));

import { recordLlmUsageDebit, type MonthlyLlmUsageCredits } from '../services/llmUsageCreditService';

const NOW = new Date('2026-08-15T00:00:00.000Z');

const baseLedger = (): MonthlyLlmUsageCredits => ({
  month: '2026-08',
  version: 1,
  totalPurchasedMicroUsd: 10_000_000,
  totalPurchasedReversedMicroUsd: 0,
  totalAdminGrantedMicroUsd: 0,
  totalMigrationOffsetMicroUsd: 0,
  grantIds: ['stripe:cs_test_1'],
  grants: [{ id: 'stripe:cs_test_1', source: 'purchase' as const, amountMicroUsd: 10_000_000, grantedAt: '2026-08-01T00:00:00.000Z' }],
  reversalIds: [],
  reversals: [],
});

beforeEach(() => {
  jest.clearAllMocks();
  mockGetUserById.mockResolvedValue({
    userId: 'u1',
    email: 'u1@example.com',
    llmUsageCredits: baseLedger(),
  });
});

describe('recordLlmUsageDebit', () => {
  it('appends a debit entry with workId, amount, and timestamp on first call', async () => {
    const result = await recordLlmUsageDebit({
      billingUserId: 'u1',
      workId: 'task-42',
      amountMicroUsd: 2_500_000,
      now: NOW,
    });

    expect(result.debited).toBe(true);
    expect(mockUpdateUser).toHaveBeenCalledTimes(1);
    const [, updates] = mockUpdateUser.mock.calls[0]!;
    const next = updates.llmUsageCredits;
    expect(next.debits).toHaveLength(1);
    expect(next.debits[0]).toMatchObject({
      workId: 'task-42',
      amountMicroUsd: 2_500_000,
      debitedAt: NOW.toISOString(),
    });
    expect(next.debitIds).toContain('meter:task-42');
    expect(next.totalDebitedMicroUsd).toBe(2_500_000);
  });

  it('returns debited: false and does not write when the same workId is submitted again', async () => {
    const ledger = baseLedger();
    ledger.debitIds = ['meter:task-42'] as any;
    ledger.debits = [{
      id: 'meter:task-42',
      workId: 'task-42',
      amountMicroUsd: 2_500_000,
      debitedAt: '2026-08-14T12:00:00.000Z',
    }] as any;
    ledger.totalDebitedMicroUsd = 2_500_000 as any;
    mockGetUserById.mockResolvedValue({ userId: 'u1', email: 'u1@example.com', llmUsageCredits: ledger });

    const result = await recordLlmUsageDebit({
      billingUserId: 'u1',
      workId: 'task-42',
      amountMicroUsd: 2_500_000,
      now: NOW,
    });

    expect(result.debited).toBe(false);
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });

  it('accumulates the running total across multiple distinct debits in the same month', async () => {
    const ledger = baseLedger();
    ledger.debitIds = ['meter:task-1'] as any;
    ledger.debits = [{ id: 'meter:task-1', workId: 'task-1', amountMicroUsd: 1_000_000, debitedAt: '2026-08-14T12:00:00.000Z' }] as any;
    ledger.totalDebitedMicroUsd = 1_000_000 as any;
    mockGetUserById.mockResolvedValue({ userId: 'u1', email: 'u1@example.com', llmUsageCredits: ledger });

    await recordLlmUsageDebit({
      billingUserId: 'u1',
      workId: 'task-2',
      amountMicroUsd: 3_500_000,
      now: NOW,
    });

    const [, updates] = mockUpdateUser.mock.calls[0]!;
    expect(updates.llmUsageCredits.totalDebitedMicroUsd).toBe(4_500_000);
    expect(updates.llmUsageCredits.debits).toHaveLength(2);
  });

  it('starts a fresh ledger when the stored month is not the current one', async () => {
    const ledger = baseLedger();
    ledger.month = '2026-07';
    ledger.debitIds = ['meter:task-old'] as any;
    ledger.debits = [{ id: 'meter:task-old', workId: 'task-old', amountMicroUsd: 500_000, debitedAt: '2026-07-15T00:00:00.000Z' }] as any;
    ledger.totalDebitedMicroUsd = 500_000 as any;
    mockGetUserById.mockResolvedValue({ userId: 'u1', email: 'u1@example.com', llmUsageCredits: ledger });

    await recordLlmUsageDebit({
      billingUserId: 'u1',
      workId: 'task-new',
      amountMicroUsd: 2_000_000,
      now: NOW,
    });

    const [, updates] = mockUpdateUser.mock.calls[0]!;
    const next = updates.llmUsageCredits;
    expect(next.month).toBe('2026-08');
    expect(next.debits).toHaveLength(1);
    expect(next.debits[0].workId).toBe('task-new');
    // Previous month's debit total does NOT carry over as debits — carryover
    // of unspent purchased capacity is AC4's job (a follow-up PR).
    expect(next.totalDebitedMicroUsd).toBe(2_000_000);
  });

  it('rejects a non-positive amount so a caller cannot silently record a phantom debit', async () => {
    await expect(
      recordLlmUsageDebit({ billingUserId: 'u1', workId: 'task-zero', amountMicroUsd: 0, now: NOW }),
    ).rejects.toThrow('amountMicroUsd must be a positive integer');
    await expect(
      recordLlmUsageDebit({ billingUserId: 'u1', workId: 'task-neg', amountMicroUsd: -1, now: NOW }),
    ).rejects.toThrow('amountMicroUsd must be a positive integer');
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });

  it('rejects an empty workId — every debit must be traceable to a work unit', async () => {
    await expect(
      recordLlmUsageDebit({ billingUserId: 'u1', workId: '', amountMicroUsd: 100, now: NOW }),
    ).rejects.toThrow('workId is required');
    await expect(
      recordLlmUsageDebit({ billingUserId: 'u1', workId: '   ', amountMicroUsd: 100, now: NOW }),
    ).rejects.toThrow('workId is required');
  });
});
