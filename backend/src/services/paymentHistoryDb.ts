import AWS from 'aws-sdk';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const TABLE_PREFIX = process.env.NODE_ENV === 'development' ? 'Dev-' : '';
const TABLE_NAME = `${TABLE_PREFIX}AW-PaymentHistory`;

const dynamodb = new AWS.DynamoDB.DocumentClient();

export type PaymentEventType =
  | 'payment_succeeded'
  | 'payment_failed'
  | 'refund'
  | 'admin_credit_grant'
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

export const paymentHistoryDb = {
  /**
   * Record a payment event. Deduplicates by stripeInvoiceId if provided.
   */
  async record(record: PaymentHistoryRecord): Promise<void> {
    // Dedup: if stripeInvoiceId is provided and eventType matches, check for existing record
    if (record.stripeInvoiceId) {
      const existing = await this.getByStripeInvoiceId(record.stripeInvoiceId);
      if (existing.some(r => r.eventType === record.eventType)) {
        console.log(
          `[PaymentHistory] Skipping duplicate: ${record.eventType} for invoice ${record.stripeInvoiceId}`
        );
        return;
      }
    }

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

    await dynamodb
      .put({
        TableName: TABLE_NAME,
        Item: item,
      })
      .promise();
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
