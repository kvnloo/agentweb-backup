/**
 * ENG-668 PR-2 — the credit ledger keeps the month it closes.
 *
 * `llmUsageCredits` holds one month, and the first write of a new month (the seat-credit sweep at
 * 10:00 UTC on day 1, a top-up, a debit) replaces it wholesale. Month-end PAYG settlement runs after
 * that, from day 2, and must measure the closed month against that month's credits — so the write that
 * rolls the ledger over keeps the old one as `llmUsageCreditsClosed`, atomically, under the same
 * condition. The row here is real state: the conditions are evaluated, not just recorded.
 */
type TransactParams = {
  TransactItems: Array<{
    Update: { UpdateExpression: string; ExpressionAttributeNames: Record<string, string>; ExpressionAttributeValues: Record<string, unknown> };
  }>;
};
const mockTransactWrite = jest.fn<{ promise: () => Promise<unknown> }, [TransactParams]>(() => ({ promise: async () => ({}) }));
jest.mock('aws-sdk', () => {
  const actual = jest.requireActual('aws-sdk');
  return {
    ...actual,
    DynamoDB: {
      ...actual.DynamoDB,
      DocumentClient: jest.fn(() => ({ transactWrite: (params: TransactParams) => mockTransactWrite(params) })),
    },
  };
});
jest.mock('../services/db', () => ({ userDb: { getUserById: jest.fn(), updateUser: jest.fn() } }));
jest.mock('../services/paymentHistoryDb', () => ({ paymentHistoryDb: { record: jest.fn() } }));

import { userDb } from '../services/db';
import {
  getLlmUsageCreditAdjustment,
  getLlmUsageCreditLedgerForMonth,
  grantMonthlyLlmUsageCredit,
  recordLlmUsageDebit,
  type MonthlyLlmUsageCredits,
} from '../services/llmUsageCreditService';
import { createUserRowFake } from './helpers/userRowFake';

const USD = 1_000_000;
const september: MonthlyLlmUsageCredits = {
  month: '2026-09',
  version: 4,
  totalPurchasedMicroUsd: 50 * USD,
  totalPurchasedReversedMicroUsd: 0,
  totalAdminGrantedMicroUsd: 5 * USD,
  totalMigrationOffsetMicroUsd: 0,
  grantIds: ['seat-credit:org-1:2026-09', 'stripe:cs_topup'],
  grants: [
    { id: 'seat-credit:org-1:2026-09', source: 'purchase', amountMicroUsd: 30 * USD, grantedAt: '2026-09-01T10:00:00.000Z' },
    { id: 'stripe:cs_topup', source: 'purchase', amountMicroUsd: 20 * USD, grantedAt: '2026-09-12T08:00:00.000Z' },
  ],
  debits: [{ id: 'meter:w1', workId: 'w1', amountMicroUsd: 1_000, debitedAt: '2026-09-20T00:00:00.000Z' }],
  debitIds: ['meter:w1'],
  totalDebitedMicroUsd: 1_000,
};
const DAY1_SWEEP = new Date('2026-10-01T10:00:00.000Z');

let store: ReturnType<typeof createUserRowFake>;
/** A PAYG account (on or off): the only kind settlement ever measures, so the only kind that keeps a copy. */
const PAYG = { enabled: false, capPercentOfPool: 50, updatedBy: 'owner-1', updatedAt: '2026-08-01T00:00:00.000Z', version: 1 };
function setup(row: Record<string, unknown>) {
  store = createUserRowFake({ userId: 'owner-1', email: 'owner@example.com', paygOverage: PAYG, ...row });
  (userDb.getUserById as jest.Mock).mockImplementation(store.read);
  (userDb.updateUser as jest.Mock).mockImplementation(store.updateUser);
}

beforeEach(() => jest.clearAllMocks());

describe('ENG-668 closed-month credit ledger', () => {
  it('the day-1 seat-credit grant keeps September as llmUsageCreditsClosed', async () => {
    setup({ llmUsageCredits: september });
    const result = await grantMonthlyLlmUsageCredit({
      billingUserId: 'owner-1', grantId: 'seat-credit:org-1:2026-10', source: 'purchase', amountMicroUsd: 30 * USD, now: DAY1_SWEEP,
    });

    expect(result.granted).toBe(true);
    expect(store.row.llmUsageCredits).toMatchObject({ month: '2026-10', totalPurchasedMicroUsd: 30 * USD });
    // Everything settlement reads survives; the per-debit list is left behind.
    const expected: MonthlyLlmUsageCredits = { ...september };
    delete expected.debits;
    delete expected.debitIds;
    expect(store.row.llmUsageCreditsClosed).toEqual(expected);
    // And settlement can find September's credits on day 2.
    expect(getLlmUsageCreditAdjustment(getLlmUsageCreditLedgerForMonth(store.row, '2026-09'), '2026-09')).toEqual({
      purchasedMicroUsd: 50 * USD, adminGrantedMicroUsd: 5 * USD, migrationOffsetMicroUsd: 0,
    });
  });

  it('an account with no PAYG record gets no closed copy: the rollover is exactly as before (review M7)', async () => {
    setup({ llmUsageCredits: september, paygOverage: undefined });
    await grantMonthlyLlmUsageCredit({
      billingUserId: 'owner-1', grantId: 'seat-credit:org-1:2026-10', source: 'purchase', amountMicroUsd: 30 * USD, now: DAY1_SWEEP,
    });
    await recordLlmUsageDebit({ billingUserId: 'owner-1', workId: 'w9', amountMicroUsd: 2_000, now: DAY1_SWEEP });
    expect(store.row.llmUsageCredits).toMatchObject({ month: '2026-10' });
    expect(store.row).not.toHaveProperty('llmUsageCreditsClosed');
    for (const [, fields] of (userDb.updateUser as jest.Mock).mock.calls) expect(fields).not.toHaveProperty('llmUsageCreditsClosed');

    setup({ llmUsageCredits: september, paygOverage: undefined });
    await grantMonthlyLlmUsageCredit({
      billingUserId: 'owner-1', grantId: 'admin:owner-1:g3', source: 'admin', amountMicroUsd: 7 * USD, now: DAY1_SWEEP,
    });
    expect(mockTransactWrite.mock.calls[0][0].TransactItems[0].Update.UpdateExpression).toBe('SET #creditLedger = :next');
  });

  it('a second write in the new month leaves the closed copy alone', async () => {
    setup({ llmUsageCredits: september });
    await grantMonthlyLlmUsageCredit({
      billingUserId: 'owner-1', grantId: 'seat-credit:org-1:2026-10', source: 'purchase', amountMicroUsd: 30 * USD, now: DAY1_SWEEP,
    });
    const closed = store.row.llmUsageCreditsClosed;
    await grantMonthlyLlmUsageCredit({
      billingUserId: 'owner-1', grantId: 'stripe:cs_oct', source: 'purchase', amountMicroUsd: 10 * USD, now: new Date('2026-10-05T00:00:00.000Z'),
    });
    expect(store.row.llmUsageCreditsClosed).toEqual(closed);
    expect((userDb.updateUser as jest.Mock).mock.calls[1][1]).not.toHaveProperty('llmUsageCreditsClosed');
  });

  it('a rollover that loses the ledger condition writes neither the new ledger nor the closed copy', async () => {
    setup({ llmUsageCredits: september });
    // Another writer bumped September's ledger between the read and the write.
    (userDb.getUserById as jest.Mock).mockImplementationOnce(async () => ({ ...store.row, llmUsageCredits: { ...september, version: 3 } }));
    await grantMonthlyLlmUsageCredit({
      billingUserId: 'owner-1', grantId: 'seat-credit:org-1:2026-10', source: 'purchase', amountMicroUsd: 30 * USD, now: DAY1_SWEEP,
    });
    // The retry re-read the real ledger and closed THAT one (version 4), not the stale snapshot.
    expect(store.row.llmUsageCreditsClosed).toMatchObject({ month: '2026-09', version: 4 });
  });

  it('an admin grant rolls over inside its transaction', async () => {
    setup({ llmUsageCredits: september });
    await grantMonthlyLlmUsageCredit({
      billingUserId: 'owner-1', grantId: 'admin:owner-1:g1', source: 'admin', amountMicroUsd: 7 * USD, reason: 'goodwill', grantedBy: 'ops', now: DAY1_SWEEP,
    });
    const update = mockTransactWrite.mock.calls[0][0].TransactItems[0].Update;
    expect(update.UpdateExpression).toBe('SET #creditLedger = :next, #closedLedger = :closed');
    expect(update.ExpressionAttributeNames['#closedLedger']).toBe('llmUsageCreditsClosed');
    expect(update.ExpressionAttributeValues[':closed']).toMatchObject({ month: '2026-09', version: 4 });
    expect(update.ExpressionAttributeValues[':closed']).not.toHaveProperty('debits');
  });

  it('an admin grant inside the month does not touch the closed copy', async () => {
    setup({ llmUsageCredits: september });
    await grantMonthlyLlmUsageCredit({
      billingUserId: 'owner-1', grantId: 'admin:owner-1:g2', source: 'admin', amountMicroUsd: 7 * USD, now: new Date('2026-09-20T00:00:00.000Z'),
    });
    const update = mockTransactWrite.mock.calls[0][0].TransactItems[0].Update;
    expect(update.UpdateExpression).toBe('SET #creditLedger = :next');
    expect(update.ExpressionAttributeValues).not.toHaveProperty(':closed');
  });

  it('a debit can be the write that rolls the month over', async () => {
    setup({ llmUsageCredits: september });
    await recordLlmUsageDebit({ billingUserId: 'owner-1', workId: 'w2', amountMicroUsd: 2_000, now: DAY1_SWEEP });
    expect(store.row.llmUsageCredits).toMatchObject({ month: '2026-10', totalDebitedMicroUsd: 2_000 });
    expect(store.row.llmUsageCreditsClosed).toMatchObject({ month: '2026-09', totalPurchasedMicroUsd: 50 * USD, totalDebitedMicroUsd: 1_000 });
  });

  it('the ledger for a month is the live one or the closed one, never another month\'s', () => {
    const october = { ...september, month: '2026-10' };
    expect(getLlmUsageCreditLedgerForMonth({ llmUsageCredits: october, llmUsageCreditsClosed: september }, '2026-09')).toBe(september);
    expect(getLlmUsageCreditLedgerForMonth({ llmUsageCredits: september }, '2026-09')).toBe(september);
    expect(getLlmUsageCreditLedgerForMonth({ llmUsageCredits: october, llmUsageCreditsClosed: { ...september, month: '2026-08' } }, '2026-09'))
      .toBeUndefined();
  });
});
