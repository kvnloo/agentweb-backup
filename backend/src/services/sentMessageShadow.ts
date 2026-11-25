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

/** Observation only. No claims, provider keys, cooldowns or enforce path exist here.
 * Detached from the successful send result; even a hung database cannot delay it.
 * Missing org attribution is labelled explicitly, never represented as a real org.
 */
export function recordSuccessfulSend(input: ShadowSendRecord): void {
  if ((process.env.SENT_MESSAGE_LEDGER_MODE || 'shadow') !== 'shadow') return;
  void (async () => {
    const { userDb } = await import('./db');
    const TABLE_PREFIX = process.env.NODE_ENV === 'development' ? 'Dev-' : '';
    const user = input.userId ? await userDb.getUserById(input.userId) : undefined;
    const orgId = user?.orgId || (input.userId ? `USER#${input.userId}` : `ACCOUNT#${input.accountId}`);
    const sentAt = new Date().toISOString();
    const db = new DynamoDB.DocumentClient({ region: process.env.AWS_REGION || 'us-west-2',
      maxRetries: 0, httpOptions: { connectTimeout: 1000, timeout: 2000 } });
    await db.put({ TableName: process.env.SENT_MESSAGES_TABLE || `${TABLE_PREFIX}AW-SentMessages`,
      Item: { ...input, orgId, scopeType: user?.orgId ? 'org' : input.userId ? 'user' : 'account',
        sk: `SENT#${sentAt}#${randomUUID()}`, sentAt, status: 'sent', mode: 'shadow' },
    }).promise();
  })().catch((error) => {
    // Do not log recipient data or let diagnostics become a send failure.
    try { console.warn('[sent-message-shadow] record failed', error?.code || 'unknown'); } catch (_) { /* best effort */ }
  });
}
