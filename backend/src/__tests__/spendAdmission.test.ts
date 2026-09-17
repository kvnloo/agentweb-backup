/**
 * ENG-1250 §4 — admission reservation/concurrency semantics.
 *
 * The concurrency guarantee lives in the CONDITION EXPRESSION (DynamoDB
 * serialises the conditional update), so the load-bearing assertions are: the
 * admission update conditions on `availableMicroUsd >= :est` and decrements
 * both counters atomically; a condition failure means not-admitted with no
 * balance change; overrun skips the balance condition but still requires the
 * row; and settle/void move the balance by the right signed amounts.
 */
jest.mock('aws-sdk', () => {
  const mockDynamoDB = { update: jest.fn(), get: jest.fn() };
  return { DynamoDB: { DocumentClient: jest.fn(() => mockDynamoDB) }, config: { update: jest.fn() } };
});

import AWS from 'aws-sdk';
import { admitAndReserve, settleReservation, voidReservation } from '../services/spendAdmission';

const mockDynamoDB = new (AWS.DynamoDB.DocumentClient as any)();
const conditionFail = () => Object.assign(new Error('cond'), { code: 'ConditionalCheckFailedException' });

describe('admitAndReserve', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDynamoDB.update.mockReturnValue({ promise: jest.fn().mockResolvedValue({}) });
    mockDynamoDB.get.mockReturnValue({ promise: jest.fn().mockResolvedValue({}) });
  });

  it('reserves under a balance condition and decrements both counters atomically', async () => {
    const r = await admitAndReserve('owner-1', '2026-09', 12500);

    expect(r).toEqual({ admitted: true, reason: 'admitted' });
    const arg = mockDynamoDB.update.mock.calls[0][0];
    expect(arg.ConditionExpression).toBe('attribute_exists(billingUserId) AND availableMicroUsd >= :est');
    expect(arg.UpdateExpression).toBe('ADD reservedMicroUsd :est, availableMicroUsd :negEst');
    expect(arg.ExpressionAttributeValues[':est']).toBe(12500);
    expect(arg.ExpressionAttributeValues[':negEst']).toBe(-12500);
  });

  it('does not admit — and writes nothing more — when the balance is short', async () => {
    // The condition fails; the reservation never lands, so the balance is left
    // intact for whatever call does fit. This IS the concurrency outcome.
    mockDynamoDB.update.mockReturnValue({ promise: jest.fn().mockRejectedValue(conditionFail()) });
    mockDynamoDB.get.mockReturnValue({ promise: jest.fn().mockResolvedValue({ Item: { billingUserId: 'owner-1' } }) });

    const r = await admitAndReserve('owner-1', '2026-09', 12500);

    expect(r).toEqual({ admitted: false, reason: 'insufficient_balance' });
  });

  it('distinguishes a missing projection row from an ordinary pause', async () => {
    mockDynamoDB.update.mockReturnValue({ promise: jest.fn().mockRejectedValue(conditionFail()) });
    mockDynamoDB.get.mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }); // no Item

    const r = await admitAndReserve('owner-1', '2026-09', 12500);

    expect(r).toEqual({ admitted: false, reason: 'missing_projection' });
  });

  it('overrun admits without the balance condition, but still requires the row', async () => {
    const r = await admitAndReserve('owner-1', '2026-09', 12500, { allowOverrun: true });

    expect(r).toEqual({ admitted: true, reason: 'over_allowed' });
    expect(mockDynamoDB.update.mock.calls[0][0].ConditionExpression).toBe('attribute_exists(billingUserId)');
  });

  it('overrun against a missing row is a seeding bug, not an admission', async () => {
    mockDynamoDB.update.mockReturnValue({ promise: jest.fn().mockRejectedValue(conditionFail()) });

    const r = await admitAndReserve('owner-1', '2026-09', 12500, { allowOverrun: true });

    expect(r).toEqual({ admitted: false, reason: 'missing_projection' });
  });

  it('rejects a negative or fractional estimate before touching the balance', async () => {
    await expect(admitAndReserve('owner-1', '2026-09', -1)).rejects.toThrow(/non-negative integer/);
    await expect(admitAndReserve('owner-1', '2026-09', 1.5)).rejects.toThrow(/non-negative integer/);
    expect(mockDynamoDB.update).not.toHaveBeenCalled();
  });

  it('propagates an unrelated DynamoDB error rather than reading it as a pause', async () => {
    mockDynamoDB.update.mockReturnValue({
      promise: jest.fn().mockRejectedValue(Object.assign(new Error('boom'), { code: 'ProvisionedThroughputExceededException' })),
    });
    await expect(admitAndReserve('owner-1', '2026-09', 12500)).rejects.toThrow('boom');
  });
});

describe('settleReservation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDynamoDB.update.mockReturnValue({ promise: jest.fn().mockResolvedValue({}) });
  });

  it('moves reserved→settled and refunds the estimate/actual difference', async () => {
    // Reserved $1.00, actual $0.60 -> settle 0.60, release 0.40 to available.
    await settleReservation('owner-1', '2026-09', 1_000_000, 600_000);

    const v = mockDynamoDB.update.mock.calls[0][0].ExpressionAttributeValues;
    expect(v[':actual']).toBe(600_000);
    expect(v[':negReserved']).toBe(-1_000_000);
    expect(v[':availDelta']).toBe(400_000); // reserved − actual
  });

  it('drives available further negative when actual exceeds the reservation (honest overrun)', async () => {
    await settleReservation('owner-1', '2026-09', 1_000_000, 1_500_000);
    expect(mockDynamoDB.update.mock.calls[0][0].ExpressionAttributeValues[':availDelta']).toBe(-500_000);
  });

  it('is never gated on balance — a reservation that happened always settles', async () => {
    await settleReservation('owner-1', '2026-09', 1_000_000, 600_000);
    expect(mockDynamoDB.update.mock.calls[0][0].ConditionExpression).toBe('attribute_exists(billingUserId)');
  });
});

describe('voidReservation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDynamoDB.update.mockReturnValue({ promise: jest.fn().mockResolvedValue({}) });
  });

  it('returns the whole reservation to the balance', async () => {
    await voidReservation('owner-1', '2026-09', 1_000_000);

    const arg = mockDynamoDB.update.mock.calls[0][0];
    expect(arg.UpdateExpression).toBe('ADD reservedMicroUsd :negReserved, availableMicroUsd :reserved');
    expect(arg.ExpressionAttributeValues[':negReserved']).toBe(-1_000_000);
    expect(arg.ExpressionAttributeValues[':reserved']).toBe(1_000_000);
  });
});
