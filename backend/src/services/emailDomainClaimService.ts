/**
 * Atomic cross-user claim on a sending domain (ENG-265).
 *
 * `POST /email-domains`'s pre-existing ownership check was a DB scan
 * (getUsersByEmailDomain) followed by a per-user conditional write — that
 * only protects the CALLING user's own `emailDomains` array, not
 * cross-user uniqueness. Two different users can both pass the scan (it's
 * eventually consistent, and a scan-then-write has an inherent TOCTOU gap)
 * and both end up with the same domain registered.
 *
 * This gives every domain a single global lock: all claims share one fixed
 * DynamoDB partition (`CLAIM_PARTITION`), so the (userId, configId) primary
 * key alone makes "first writer wins" atomic per domain — no new table,
 * reusing the existing AW-Configs table the same way
 * senderUsageTrackerFactory.ts reuses it for daily-send counters.
 */

import AWS from 'aws-sdk';

const TABLE_PREFIX = process.env.NODE_ENV === 'production' ? '' : 'Dev-';
const CONFIGS_TABLE = `${TABLE_PREFIX}AW-Configs`;
const CLAIM_PARTITION = '__system__:emailDomainClaims';

function claimConfigId(normalizedDomain: string): string {
  return `emailDomainClaim:${normalizedDomain}`;
}

export class EmailDomainAlreadyClaimedError extends Error {
  constructor(public domain: string, public claimedByUserId: string) {
    super(`Domain "${domain}" is already registered on another account.`);
    this.name = 'EmailDomainAlreadyClaimedError';
  }
}

let cachedClient: AWS.DynamoDB.DocumentClient | null = null;
function client(): AWS.DynamoDB.DocumentClient {
  if (!cachedClient) cachedClient = new AWS.DynamoDB.DocumentClient();
  return cachedClient;
}

/** Atomically claim a domain for userId. Throws EmailDomainAlreadyClaimedError if already claimed. */
export async function claimEmailDomain(userId: string, normalizedDomain: string): Promise<void> {
  try {
    await client()
      .put({
        TableName: CONFIGS_TABLE,
        Item: {
          userId: CLAIM_PARTITION,
          configId: claimConfigId(normalizedDomain),
          ownerUserId: userId,
          claimedAt: new Date().toISOString(),
        },
        ConditionExpression: 'attribute_not_exists(configId)',
      })
      .promise();
  } catch (err: any) {
    if (err?.code !== 'ConditionalCheckFailedException') throw err;
    const existing = await client()
      .get({ TableName: CONFIGS_TABLE, Key: { userId: CLAIM_PARTITION, configId: claimConfigId(normalizedDomain) } })
      .promise();
    throw new EmailDomainAlreadyClaimedError(normalizedDomain, existing.Item?.ownerUserId ?? 'another account');
  }
}

/** Release a claim (e.g. on removal, or to unwind a claim after a later step in registration failed). */
export async function releaseEmailDomainClaim(normalizedDomain: string): Promise<void> {
  await client()
    .delete({ TableName: CONFIGS_TABLE, Key: { userId: CLAIM_PARTITION, configId: claimConfigId(normalizedDomain) } })
    .promise();
}
