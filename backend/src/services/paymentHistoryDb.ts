import AWS from 'aws-sdk';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const TABLE_PREFIX = process.env.NODE_ENV === 'development' ? 'Dev-' : '';
const TABLE_NAME = `${TABLE_PREFIX}AW-PaymentHistory`;

// Sentinel partition for dedup markers. Real users have opaque IDs that never
// collide with this literal, so markers coexist with data rows in one table
// without polluting getByUserId queries.
const DEDUP_PARTITION = '__dedup__';

const dynamodb = new AWS.DynamoDB.DocumentClient();

export type PaymentEventType =
  | 'payment_succeeded'
  | 'payment_failed'
  | 'refund'
  | 'admin_credit_grant'
  | 'dispute_opened'
  | 'dispute_closed'
  | 'subscription_created'
  | 'subscription_updated'
  | 'subscription_canceled'
  | 'subscription_downgraded';

export interface PaymentHistoryRecord {
  userId: string;
  timestamp: string; // ISO-8601
  eventType: PaymentEventType;
  amount: number; // cents
  currency: string;
  status: string;
  stripeInvoiceId?: string;
  stripeSubscriptionId?: string;
  priceId?: string;
  planName?: string;
  metadata?: Record<string, any>;
}

export interface RecordOptions {
  /**
   * When set, the write is guarded by an atomic dedup marker on the sentinel
   * partition. Concurrent writes with the same dedupKey race on a
   * ConditionExpression instead of a bounded query-then-put window, so
   * webhook redeliveries can never double-write regardless of history depth.
   */
  dedupKey?: string;
}

export interface RecordResult {
  written: boolean;
}

function transactionCancelledReasons(error: any): any[] | null {
  if (error?.code !== 'TransactionCanceledException') return null;
  return error?.CancellationReasons || [];
}

// DDB optimistic-concurrency conflict: two concurrent TransactWrites touch
// the same item and DDB rolls one back. Retriable — the losing caller
// should re-attempt with the same intent. Surfaces two ways:
//   1. Top-level error.code = 'TransactionConflictException'
//   2. TransactionCanceledException with any reason.Code = 'TransactionConflict'
// Handling only ConditionalCheckFailed lets this class escape as an
// unhandled throw under real webhook fan-out (caught 2026-08-14 via
// live-test on Dev-AW-PaymentHistory with Promise.all-based redelivery).
function isRetriableTransactionConflict(error: any): boolean {
  if (error?.code === 'TransactionConflictException') return true;
  const reasons = transactionCancelledReasons(error);
  return !!reasons?.some((r: any) => r?.Code === 'TransactionConflict');
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Bounded retry budget for main-row (userId, timestamp) collisions between
// two DISTINCT events for the same user landing in the same millisecond,
// and for DDB optimistic-concurrency `TransactionConflict` rollbacks under
// concurrent webhook fan-out. Node's Date.now() has ms resolution, so a
// 2ms wait guarantees the next timestamp mint bumps; 8 attempts covers
// unrealistic worst-case pileups. Marker collisions (same dedupKey) are a
// real duplicate and handled separately in one shot — no retry.
const MAX_TRANSACT_RETRIES = 8;
const TRANSACT_RETRY_BACKOFF_MS = 2;

export const paymentHistoryDb = {
  /**
   * Record a payment event.
   *
   * Deduplication strategies (checked in order):
   *  - `opts.dedupKey`: atomic — TransactWriteItems puts the main row plus a
   *    marker row on the sentinel dedup partition with
   *    `attribute_not_exists(userId)`. Race-safe under concurrent redelivery.
   *  - `stripeInvoiceId` (legacy): best-effort query-then-put via GSI. Kept
   *    for existing subscription-billing callers that already keyed off it.
   *    Prefer `dedupKey` for new callers where correctness under concurrent
   *    webhook redelivery matters.
   */
  async record(record: PaymentHistoryRecord, opts?: RecordOptions): Promise<RecordResult> {
    const buildItem = (timestamp: string): Record<string, any> => {
      const item: Record<string, any> = {
        userId: record.userId,
        timestamp,
        eventType: record.eventType,
        amount: record.amount,
        currency: record.currency,
        status: record.status,
      };
      if (record.stripeInvoiceId) item.stripeInvoiceId = record.stripeInvoiceId;
      if (record.stripeSubscriptionId) item.stripeSubscriptionId = record.stripeSubscriptionId;
      if (record.priceId) item.priceId = record.priceId;
      if (record.planName) item.planName = record.planName;
      if (record.metadata) item.metadata = record.metadata;
      return item;
    };

    if (opts?.dedupKey) {
      // Guard BOTH puts with attribute_not_exists so two DISTINCT events for
      // the same user landing in the same millisecond can't overwrite each
      // other's audit row. Marker condition catches redelivery (same
      // dedupKey); main-row condition catches same-ms collision (different
      // dedupKey, same (userId, timestamp)). On main-row collision, retry
      // with a fresh timestamp — marker collision is a real duplicate and
      // returns immediately.
      for (let attempt = 0; attempt < MAX_TRANSACT_RETRIES; attempt++) {
        if (attempt > 0) await sleep(TRANSACT_RETRY_BACKOFF_MS);
        const timestamp = attempt === 0
          ? (record.timestamp || new Date().toISOString())
          : new Date().toISOString();
        const item = buildItem(timestamp);
        try {
          await dynamodb
            .transactWrite({
              TransactItems: [
                {
                  Put: {
                    TableName: TABLE_NAME,
                    Item: item,
                    ConditionExpression: 'attribute_not_exists(userId)',
                  },
                },
                {
                  Put: {
                    TableName: TABLE_NAME,
                    Item: {
                      userId: DEDUP_PARTITION,
                      timestamp: opts.dedupKey,
                      mainUserId: record.userId,
                      mainTimestamp: timestamp,
                      createdAt: new Date().toISOString(),
                    },
                    ConditionExpression: 'attribute_not_exists(userId)',
                  },
                },
              ],
            })
            .promise();
          return { written: true };
        } catch (error: any) {
          const reasons = transactionCancelledReasons(error);
          if (reasons) {
            // Marker condition is a real duplicate — never retry, never
            // fall through to conflict/collision handling.
            if (reasons[1]?.Code === 'ConditionalCheckFailed') {
              console.log(
                `[PaymentHistory] Skipping duplicate via dedupKey=${opts.dedupKey} (userId=${record.userId})`,
              );
              return { written: false };
            }
            // Main-row condition = same-ms distinct-event PK collision;
            // retry with a freshly minted timestamp.
            if (reasons[0]?.Code === 'ConditionalCheckFailed') continue;
          }
          // Optimistic-concurrency conflict from concurrent TransactWrites
          // touching the same item — retriable with same intent.
          if (isRetriableTransactionConflict(error)) continue;
          throw error;
        }
      }
      throw new Error(
        `payment history transact-write unresolved after ${MAX_TRANSACT_RETRIES} attempts (userId=${record.userId}, dedupKey=${opts.dedupKey})`,
      );
    }

    const item = buildItem(record.timestamp || new Date().toISOString());

    // Legacy invoice-based dedup: keeps the same query-then-put behavior for
    // existing subscription-billing callers. Prefer dedupKey for new writes.
    if (record.stripeInvoiceId) {
      const existing = await this.getByStripeInvoiceId(record.stripeInvoiceId);
      if (existing.some(r => r.eventType === record.eventType)) {
        console.log(
          `[PaymentHistory] Skipping duplicate: ${record.eventType} for invoice ${record.stripeInvoiceId}`,
        );
        return { written: false };
      }
    }

    await dynamodb.put({ TableName: TABLE_NAME, Item: item }).promise();
    return { written: true };
  },

  /**
   * Query payment history for a user, newest first. Returns up to `limit` records.
   */
  async getByUserId(userId: string, limit: number = 50): Promise<PaymentHistoryRecord[]> {
    const result = await dynamodb
      .query({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'userId = :uid',
        ExpressionAttributeValues: { ':uid': userId },
        ScanIndexForward: false, // newest first
        Limit: limit,
      })
      .promise();

    return (result.Items || []) as PaymentHistoryRecord[];
  },

  /**
   * Look up records by stripeInvoiceId (via GSI) for dedup.
   */
  async getByStripeInvoiceId(stripeInvoiceId: string): Promise<PaymentHistoryRecord[]> {
    const result = await dynamodb
      .query({
        TableName: TABLE_NAME,
        IndexName: 'StripeInvoiceIndex',
        KeyConditionExpression: 'stripeInvoiceId = :iid',
        ExpressionAttributeValues: { ':iid': stripeInvoiceId },
      })
      .promise();

    return (result.Items || []) as PaymentHistoryRecord[];
  },
};
