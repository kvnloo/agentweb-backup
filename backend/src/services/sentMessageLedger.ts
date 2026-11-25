import type { DynamoDB } from 'aws-sdk';
import { createHash, randomUUID } from 'crypto';

export interface SendIdentity {
  orgId: string;
  channel: 'email' | 'linkedin';
  recipient: string;
  campaignId: string;
  step: string;
}

/** Permanent keys: no lease expiry and no TTL. An unknown outcome must be reconciled,
 * never automatically reclaimed. Caller supplies server-resolved org and stable campaign/step.
 * This module is dark until send adapters and rollout are explicitly wired.
 */
export class SentMessageLedger {
  constructor(private readonly db: Pick<DynamoDB.DocumentClient, 'put' | 'update' | 'transactWrite'>, private readonly tableName: string) {
    if (!tableName) throw new Error('An explicit sent-message table is required');
  }

  async send(input: SendIdentity, provider: (idempotencyKey: string) => Promise<{ id: string }>): Promise<{ status: 'sent'; providerId: string } | { status: 'blocked' }> {
    for (const value of Object.values(input)) {
      if (typeof value !== 'string' || !value.trim()) throw new Error('Send identity fields must be nonempty');
    }
    // Email domains/local parts are case-insensitive for our dedup policy. LinkedIn provider
    // identifiers are opaque: do not lowercase or silently rewrite them.
    const recipient = input.channel === 'email' ? input.recipient.trim().toLowerCase() : input.recipient.trim();
    const digest = createHash('sha256').update(JSON.stringify([input.channel, recipient, input.campaignId, input.step])).digest('hex');
    const key = { orgId: input.orgId, sk: `IDEMP#${digest}` };
    const token = randomUUID();
    const claimedAt = new Date().toISOString();
    try {
      await this.db.put({ TableName: this.tableName,
        Item: { ...input, ...key, recipient, token, status: 'claimed', claimedAt },
        ConditionExpression: 'attribute_not_exists(orgId)',
      }).promise();
    } catch (error: any) {
      if (error.code === 'ConditionalCheckFailedException') return { status: 'blocked' };
      throw error; // Storage unavailable: fail closed before the provider.
    }

    let providerId: string;
    try {
      providerId = (await provider(`aw-ledger-${createHash('sha256').update(JSON.stringify([input.orgId, digest])).digest('hex')}`)).id;
      if (!providerId) throw new Error('Provider returned no message id');
    } catch (error) {
      // A timeout or rejection may still have been accepted remotely. Do not infer failure.
      // If this update fails, the permanent claimed row remains blocking (safe fallback).
      await this.db.update({ TableName: this.tableName, Key: key,
        UpdateExpression: 'SET #status = :ambiguous',
        ConditionExpression: '#status = :claimed AND #token = :token',
        ExpressionAttributeNames: { '#status': 'status', '#token': 'token' },
        ExpressionAttributeValues: { ':ambiguous': 'ambiguous', ':claimed': 'claimed', ':token': token },
      }).promise();
      throw error;
    }
    const sentAt = new Date().toISOString();
    // Atomic finalization: durable guard and chronological audit row agree, or the claim
    // stays blocking. Never retry the provider if finalization fails after acceptance.
    await this.db.transactWrite({ TransactItems: [
      { Update: { TableName: this.tableName, Key: key,
        UpdateExpression: 'SET #status = :sent, providerId = :providerId, sentAt = :sentAt',
        ConditionExpression: '#status = :claimed AND #token = :token',
        ExpressionAttributeNames: { '#status': 'status', '#token': 'token' },
        ExpressionAttributeValues: { ':sent': 'sent', ':claimed': 'claimed', ':token': token, ':providerId': providerId, ':sentAt': sentAt },
      } },
      { Put: { TableName: this.tableName,
        Item: { ...input, recipient, orgId: input.orgId, sk: `SENT#${sentAt}#${token}`, status: 'sent', providerId, sentAt, idempotencyKey: key.sk },
        ConditionExpression: 'attribute_not_exists(orgId)',
      } },
    ] }).promise();
    return { status: 'sent', providerId };
  }
}
