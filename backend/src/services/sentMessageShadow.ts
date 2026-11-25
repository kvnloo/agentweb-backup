import { randomUUID } from 'crypto';
import { DynamoDB } from 'aws-sdk';

export interface ShadowSendRecord {
  channel: 'email' | 'linkedin';
  userId?: string;
  accountId?: string;
  recipients: string[];
  providerId?: string;
  adapter: string;
}

let client: DynamoDB.DocumentClient | undefined;
let inFlight = 0;
const orgCache = new Map<string, { orgId?: string; expires: number }>();

/** Observation only: no claims/provider keys/enforce path. Detached and bounded;
 * even hung storage cannot delay sends or start more than 32 record operations.
 * Missing org attribution is explicitly labelled rather than invented.
 */
export function recordSuccessfulSend(input: ShadowSendRecord): void {
  if ((process.env.SENT_MESSAGE_LEDGER_MODE || 'shadow') !== 'shadow' || inFlight >= 32) return;
  inFlight++;
  void (async () => {
    const prefix = process.env.NODE_ENV === 'development' ? 'Dev-' : '';
    const db = client ||= new DynamoDB.DocumentClient({ region: process.env.AWS_REGION || 'us-west-2',
      maxRetries: 0, httpOptions: { connectTimeout: 1000, timeout: 2000 } });
    let cached = input.userId ? orgCache.get(input.userId) : undefined;
    if (input.userId && (!cached || cached.expires < Date.now())) {
      const result = await db.query({ TableName: `${prefix}AW-Users`, IndexName: 'UserIdIndex',
        KeyConditionExpression: 'userId = :id', ExpressionAttributeValues: { ':id': input.userId },
        ProjectionExpression: 'orgId', Limit: 1 }).promise();
      cached = { orgId: result.Items?.[0]?.orgId, expires: Date.now() + 60000 };
      if (orgCache.size >= 1000) orgCache.clear();
      orgCache.set(input.userId, cached);
    }
    const orgId = cached?.orgId || (input.userId ? `USER#${input.userId}` : `ACCOUNT#${input.accountId}`);
    const sentAt = new Date().toISOString();
    await db.put({ TableName: process.env.SENT_MESSAGES_TABLE || `${prefix}AW-SentMessages`,
      Item: { ...input, recipients: input.recipients.slice(0, 100).map((r) => r.slice(0, 512)),
        orgId, scopeType: cached?.orgId ? 'org' : input.userId ? 'user' : 'account',
        sk: `SENT#${sentAt}#${randomUUID()}`, sentAt, status: 'sent', mode: 'shadow' },
    }).promise();
  })().catch((error) => {
    try { console.warn('[sent-message-shadow] record failed', error?.code || 'unknown'); } catch (_) { /* best effort */ }
  }).finally(() => { inFlight--; });
}
