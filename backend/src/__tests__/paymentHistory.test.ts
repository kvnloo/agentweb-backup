/**
 * Payment History DynamoDB Service Tests
 *
 * Tests the paymentHistoryDb service: record, query, dedup, and admin endpoint.
 * All DynamoDB calls are mocked.
 */

const mockPut = jest.fn().mockReturnValue({ promise: () => Promise.resolve() });
const mockQuery = jest.fn().mockReturnValue({ promise: () => Promise.resolve({ Items: [] }) });
const mockTransactWrite = jest.fn().mockReturnValue({ promise: () => Promise.resolve() });

jest.mock('aws-sdk', () => {
  const DocumentClient = jest.fn().mockImplementation(() => ({
    put: mockPut,
    query: mockQuery,
    transactWrite: mockTransactWrite,
  }));
  return {
    config: { update: jest.fn() },
    DynamoDB: { DocumentClient },
    S3: jest.fn().mockImplementation(() => ({})),
  };
});

// Mock db service for admin endpoint test
jest.mock('../services/db', () => ({
  userDb: {
    getUserById: jest.fn(),
    getUserByEmail: jest.fn(),
    updateUser: jest.fn(),
    scanWithFilter: jest.fn(),
  },
}));

// Mock stripeService (needed when controller is imported)
jest.mock('../services/stripeService', () => ({
  stripeService: {
    constructWebhookEvent: jest.fn(),
    createCheckoutSession: jest.fn(),
    listProducts: jest.fn(),
  },
  handleCheckoutSessionCompleted: jest.fn(),
  handleSubscriptionUpdated: jest.fn(),
  handleSubscriptionDeleted: jest.fn(),
  findUserByStripeCustomerId: jest.fn(),
}));

// Mock settingsService
jest.mock('../services/settingsService', () => ({
  settingsService: {
    getSetting: jest.fn().mockResolvedValue(null),
  },
}));

import { paymentHistoryDb, PaymentHistoryRecord } from '../services/paymentHistoryDb';

describe('paymentHistoryDb', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Reset mocks to defaults
    mockQuery.mockReturnValue({ promise: () => Promise.resolve({ Items: [] }) });
    mockPut.mockReturnValue({ promise: () => Promise.resolve() });
    mockTransactWrite.mockReturnValue({ promise: () => Promise.resolve() });
  });

  describe('record()', () => {
    it('writes a record with correct fields to DynamoDB', async () => {
      const record: PaymentHistoryRecord = {
        userId: 'user-123',
        timestamp: '2026-04-04T10:00:00.000Z',
        eventType: 'payment_succeeded',
        amount: 2999,
        currency: 'usd',
        status: 'paid',
        stripeInvoiceId: 'in_abc123',
        stripeSubscriptionId: 'sub_xyz789',
        priceId: 'price_starter',
        planName: 'Basic',
      };

      await paymentHistoryDb.record(record);

      expect(mockPut).toHaveBeenCalledTimes(1);
      const putCall = mockPut.mock.calls[0][0];
      expect(putCall.Item).toMatchObject({
        userId: 'user-123',
        timestamp: '2026-04-04T10:00:00.000Z',
        eventType: 'payment_succeeded',
        amount: 2999,
        currency: 'usd',
        status: 'paid',
        stripeInvoiceId: 'in_abc123',
        stripeSubscriptionId: 'sub_xyz789',
        priceId: 'price_starter',
        planName: 'Basic',
      });
    });

    it('omits optional fields when not provided', async () => {
      const record: PaymentHistoryRecord = {
        userId: 'user-456',
        timestamp: '2026-04-04T11:00:00.000Z',
        eventType: 'subscription_created',
        amount: 0,
        currency: 'usd',
        status: 'active',
      };

      await paymentHistoryDb.record(record);

      expect(mockPut).toHaveBeenCalledTimes(1);
      const putCall = mockPut.mock.calls[0][0];
      expect(putCall.Item.stripeInvoiceId).toBeUndefined();
      expect(putCall.Item.stripeSubscriptionId).toBeUndefined();
      expect(putCall.Item.priceId).toBeUndefined();
      expect(putCall.Item.planName).toBeUndefined();
      expect(putCall.Item.metadata).toBeUndefined();
    });

    it('includes metadata when provided', async () => {
      const record: PaymentHistoryRecord = {
        userId: 'user-789',
        timestamp: '2026-04-04T12:00:00.000Z',
        eventType: 'refund',
        amount: 1500,
        currency: 'usd',
        status: 'refunded',
        metadata: { reason: 'customer_request', refundId: 're_abc' },
      };

      await paymentHistoryDb.record(record);

      const putCall = mockPut.mock.calls[0][0];
      expect(putCall.Item.metadata).toEqual({ reason: 'customer_request', refundId: 're_abc' });
    });
  });

  describe('dedup by stripeInvoiceId', () => {
    it('skips writing when a record with the same invoiceId and eventType exists', async () => {
      // First query (dedup check via GSI) returns an existing record
      mockQuery.mockReturnValueOnce({
        promise: () =>
          Promise.resolve({
            Items: [
              {
                userId: 'user-123',
                timestamp: '2026-04-04T10:00:00.000Z',
                eventType: 'payment_succeeded',
                stripeInvoiceId: 'in_dup123',
              },
            ],
          }),
      });

      const record: PaymentHistoryRecord = {
        userId: 'user-123',
        timestamp: '2026-04-04T10:01:00.000Z',
        eventType: 'payment_succeeded',
        amount: 2999,
        currency: 'usd',
        status: 'paid',
        stripeInvoiceId: 'in_dup123',
      };

      await paymentHistoryDb.record(record);

      // put should NOT have been called because of dedup
      expect(mockPut).not.toHaveBeenCalled();
    });

    it('allows writing when invoiceId exists but eventType differs', async () => {
      // GSI returns a record with different eventType
      mockQuery.mockReturnValueOnce({
        promise: () =>
          Promise.resolve({
            Items: [
              {
                userId: 'user-123',
                timestamp: '2026-04-04T10:00:00.000Z',
                eventType: 'payment_succeeded',
                stripeInvoiceId: 'in_mixed456',
              },
            ],
          }),
      });

      const record: PaymentHistoryRecord = {
        userId: 'user-123',
        timestamp: '2026-04-04T11:00:00.000Z',
        eventType: 'payment_failed',
        amount: 2999,
        currency: 'usd',
        status: 'failed',
        stripeInvoiceId: 'in_mixed456',
      };

      await paymentHistoryDb.record(record);

      // put SHOULD be called because eventType is different
      expect(mockPut).toHaveBeenCalledTimes(1);
    });
  });

  describe('dedup by dedupKey (atomic)', () => {
    it('writes main row + sentinel-partition marker atomically via TransactWriteItems', async () => {
      const record: PaymentHistoryRecord = {
        userId: 'user-atomic',
        timestamp: '2026-08-14T09:00:00.000Z',
        eventType: 'dispute_opened',
        amount: 2500,
        currency: 'usd',
        status: 'disputed',
        metadata: { disputeId: 'dp_atomic' },
      };

      const result = await paymentHistoryDb.record(record, { dedupKey: 'dispute:opened:dp_atomic' });

      expect(result).toEqual({ written: true });
      expect(mockPut).not.toHaveBeenCalled();
      expect(mockTransactWrite).toHaveBeenCalledTimes(1);
      const arg = mockTransactWrite.mock.calls[0][0];
      expect(arg.TransactItems).toHaveLength(2);
      expect(arg.TransactItems[0].Put.Item).toMatchObject({
        userId: 'user-atomic',
        timestamp: '2026-08-14T09:00:00.000Z',
        eventType: 'dispute_opened',
      });
      expect(arg.TransactItems[1].Put.Item).toMatchObject({
        userId: '__dedup__',
        timestamp: 'dispute:opened:dp_atomic',
        mainUserId: 'user-atomic',
      });
      expect(arg.TransactItems[1].Put.ConditionExpression).toBe('attribute_not_exists(userId)');
    });

    it('returns {written: false} without throwing when the marker condition fails on redelivery', async () => {
      mockTransactWrite.mockReturnValueOnce({
        promise: () => Promise.reject({
          code: 'TransactionCanceledException',
          CancellationReasons: [{ Code: 'None' }, { Code: 'ConditionalCheckFailed' }],
        }),
      });

      const result = await paymentHistoryDb.record({
        userId: 'user-dup',
        timestamp: '2026-08-14T09:00:00.000Z',
        eventType: 'dispute_opened',
        amount: 2500,
        currency: 'usd',
        status: 'disputed',
      }, { dedupKey: 'dispute:opened:dp_dup' });

      expect(result).toEqual({ written: false });
    });

    it('propagates non-conditional transaction errors', async () => {
      mockTransactWrite.mockReturnValueOnce({
        promise: () => Promise.reject({ code: 'ProvisionedThroughputExceededException' }),
      });

      await expect(paymentHistoryDb.record({
        userId: 'user-err',
        timestamp: '2026-08-14T09:00:00.000Z',
        eventType: 'dispute_opened',
        amount: 2500,
        currency: 'usd',
        status: 'disputed',
      }, { dedupKey: 'dispute:opened:dp_err' })).rejects.toMatchObject({
        code: 'ProvisionedThroughputExceededException',
      });
    });

    it('retries with a fresh timestamp when the main-row Put collides but the dedup marker succeeds', async () => {
      // Distinct dispute events for the same user landing in the same
      // millisecond used to overwrite each other's audit row because the
      // marker keys differed while (userId, timestamp) collided. Now the
      // main-row Put is condition-guarded and the txn cancels with reason
      // index 0 (main) = ConditionalCheckFailed; we retry with a new ts.
      let call = 0;
      mockTransactWrite.mockImplementation(() => ({
        promise: () => {
          call++;
          if (call === 1) {
            return Promise.reject({
              code: 'TransactionCanceledException',
              CancellationReasons: [{ Code: 'ConditionalCheckFailed' }, { Code: 'None' }],
            });
          }
          return Promise.resolve();
        },
      }));

      const result = await paymentHistoryDb.record({
        userId: 'user-collide',
        timestamp: '2026-08-14T09:00:00.000Z',
        eventType: 'dispute_opened',
        amount: 2500,
        currency: 'usd',
        status: 'disputed',
      }, { dedupKey: 'dispute:opened:dp_collide' });

      expect(result).toEqual({ written: true });
      expect(mockTransactWrite).toHaveBeenCalledTimes(2);
      // Second attempt must have used a freshly minted timestamp, not the
      // caller-supplied one that just collided.
      const secondArg = mockTransactWrite.mock.calls[1][0];
      expect(secondArg.TransactItems[0].Put.Item.timestamp).not.toBe('2026-08-14T09:00:00.000Z');
    });

    it('does NOT retry when the marker condition fails (real duplicate)', async () => {
      mockTransactWrite.mockReturnValueOnce({
        promise: () => Promise.reject({
          code: 'TransactionCanceledException',
          CancellationReasons: [{ Code: 'None' }, { Code: 'ConditionalCheckFailed' }],
        }),
      });

      const result = await paymentHistoryDb.record({
        userId: 'user-real-dup',
        timestamp: '2026-08-14T09:00:00.000Z',
        eventType: 'dispute_opened',
        amount: 2500,
        currency: 'usd',
        status: 'disputed',
      }, { dedupKey: 'dispute:opened:dp_dup' });

      expect(result).toEqual({ written: false });
      expect(mockTransactWrite).toHaveBeenCalledTimes(1);
    });

    it('throws when timestamp collisions persist past the retry budget', async () => {
      // Simulate all attempts colliding on the main-row PK.
      mockTransactWrite.mockImplementation(() => ({
        promise: () => Promise.reject({
          code: 'TransactionCanceledException',
          CancellationReasons: [{ Code: 'ConditionalCheckFailed' }, { Code: 'None' }],
        }),
      }));

      await expect(paymentHistoryDb.record({
        userId: 'user-forever-collide',
        timestamp: '2026-08-14T09:00:00.000Z',
        eventType: 'dispute_opened',
        amount: 2500,
        currency: 'usd',
        status: 'disputed',
      }, { dedupKey: 'dispute:opened:dp_x' })).rejects.toThrow(/transact-write unresolved/);
    });

    it('retries on TransactionConflict cancellation reason (concurrent txn contention)', async () => {
      let call = 0;
      mockTransactWrite.mockImplementation(() => ({
        promise: () => {
          call++;
          if (call === 1) {
            return Promise.reject({
              code: 'TransactionCanceledException',
              CancellationReasons: [{ Code: 'None' }, { Code: 'TransactionConflict' }],
            });
          }
          return Promise.resolve();
        },
      }));

      const result = await paymentHistoryDb.record({
        userId: 'user-conflict',
        timestamp: '2026-08-14T09:00:00.000Z',
        eventType: 'dispute_opened',
        amount: 2500,
        currency: 'usd',
        status: 'disputed',
      }, { dedupKey: 'dispute:opened:dp_conflict' });

      expect(result).toEqual({ written: true });
      expect(mockTransactWrite).toHaveBeenCalledTimes(2);
    });

    it('does NOT retry when TransactionConflict is mixed with a permanent reason', async () => {
      // Mixed cancellation: main-row hit a permanent ValidationError while
      // marker slot happened to see a concurrent conflict. Classifying the
      // whole cancellation as retriable would mask the permanent cause and
      // return a generic "unresolved after 8 attempts" error instead.
      mockTransactWrite.mockImplementation(() => ({
        promise: () => Promise.reject({
          code: 'TransactionCanceledException',
          CancellationReasons: [
            { Code: 'ValidationError', Message: 'permanent' },
            { Code: 'TransactionConflict' },
          ],
        }),
      }));

      await expect(
        paymentHistoryDb.record({
          userId: 'user-mixed',
          timestamp: '2026-08-14T09:00:00.000Z',
          eventType: 'dispute_opened',
          amount: 2500,
          currency: 'usd',
          status: 'disputed',
        }, { dedupKey: 'dispute:opened:dp_mixed' })
      ).rejects.toMatchObject({ code: 'TransactionCanceledException' });

      // Bailed on first attempt — no retry, permanent cause surfaced intact
      expect(mockTransactWrite).toHaveBeenCalledTimes(1);
    });

    it('retries on top-level TransactionConflictException', async () => {
      let call = 0;
      mockTransactWrite.mockImplementation(() => ({
        promise: () => {
          call++;
          if (call === 1) return Promise.reject({ code: 'TransactionConflictException' });
          return Promise.resolve();
        },
      }));

      const result = await paymentHistoryDb.record({
        userId: 'user-conflict-top',
        timestamp: '2026-08-14T09:00:00.000Z',
        eventType: 'dispute_opened',
        amount: 2500,
        currency: 'usd',
        status: 'disputed',
      }, { dedupKey: 'dispute:opened:dp_conflict_top' });

      expect(result).toEqual({ written: true });
      expect(mockTransactWrite).toHaveBeenCalledTimes(2);
    });

    it('dedupKey takes precedence over legacy invoice dedup path', async () => {
      // Even with stripeInvoiceId set, dedupKey routes to TransactWrite
      // (invoice dedup is left in place only for callers that never migrate).
      await paymentHistoryDb.record({
        userId: 'user-mix',
        timestamp: '2026-08-14T09:00:00.000Z',
        eventType: 'payment_succeeded',
        amount: 2999,
        currency: 'usd',
        status: 'paid',
        stripeInvoiceId: 'in_mix',
      }, { dedupKey: 'invoice:in_mix:payment_succeeded' });

      expect(mockQuery).not.toHaveBeenCalled();
      expect(mockPut).not.toHaveBeenCalled();
      expect(mockTransactWrite).toHaveBeenCalledTimes(1);
    });
  });

  describe('getByUserId()', () => {
    it('queries with correct key condition and returns sorted results (newest first)', async () => {
      const mockItems = [
        { userId: 'user-123', timestamp: '2026-04-04T12:00:00.000Z', eventType: 'payment_succeeded' },
        { userId: 'user-123', timestamp: '2026-04-04T10:00:00.000Z', eventType: 'subscription_created' },
      ];
      mockQuery.mockReturnValueOnce({
        promise: () => Promise.resolve({ Items: mockItems }),
      });

      const results = await paymentHistoryDb.getByUserId('user-123');

      expect(mockQuery).toHaveBeenCalledTimes(1);
      const queryCall = mockQuery.mock.calls[0][0];
      expect(queryCall.KeyConditionExpression).toBe('userId = :uid');
      expect(queryCall.ExpressionAttributeValues).toEqual({ ':uid': 'user-123' });
      expect(queryCall.ScanIndexForward).toBe(false); // newest first
      expect(queryCall.Limit).toBe(50);
      expect(results).toEqual(mockItems);
    });

    it('respects custom limit parameter', async () => {
      mockQuery.mockReturnValueOnce({
        promise: () => Promise.resolve({ Items: [] }),
      });

      await paymentHistoryDb.getByUserId('user-123', 10);

      const queryCall = mockQuery.mock.calls[0][0];
      expect(queryCall.Limit).toBe(10);
    });
  });

  describe('getByStripeInvoiceId()', () => {
    it('queries the StripeInvoiceIndex GSI', async () => {
      mockQuery.mockReturnValueOnce({
        promise: () => Promise.resolve({ Items: [] }),
      });

      await paymentHistoryDb.getByStripeInvoiceId('in_test789');

      expect(mockQuery).toHaveBeenCalledTimes(1);
      const queryCall = mockQuery.mock.calls[0][0];
      expect(queryCall.IndexName).toBe('StripeInvoiceIndex');
      expect(queryCall.KeyConditionExpression).toBe('stripeInvoiceId = :iid');
      expect(queryCall.ExpressionAttributeValues).toEqual({ ':iid': 'in_test789' });
    });
  });
});

describe('getPaymentHistory controller', () => {
  it('is exported from stripeController', () => {
    // Verify the controller exports the getPaymentHistory function
    const controller = require('../controllers/stripeController');
    expect(typeof controller.getPaymentHistory).toBe('function');
  });
});
