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

function isTransactDedupFailure(error: any): boolean {
  if (error?.code !== 'TransactionCanceledException') return false;
  const reasons = error?.CancellationReasons || [];
  return reasons.some((r: any) => r?.Code === 'ConditionalCheckFailed');
}

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
    const item: Record<string, any> = {
      userId: record.userId,
      timestamp: record.timestamp || new Date().toISOString(),
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

    if (opts?.dedupKey) {
      try {
        await dynamodb
          .transactWrite({
            TransactItems: [
              { Put: { TableName: TABLE_NAME, Item: item } },
              {
                Put: {
                  TableName: TABLE_NAME,
                  Item: {
                    userId: DEDUP_PARTITION,
                    timestamp: opts.dedupKey,
                    mainUserId: record.userId,
                    mainTimestamp: item.timestamp,
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
        if (isTransactDedupFailure(error)) {
          console.log(
            `[PaymentHistory] Skipping duplicate via dedupKey=${opts.dedupKey} (userId=${record.userId})`,
          );
          return { written: false };
        }
        throw error;
      }
    }

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
