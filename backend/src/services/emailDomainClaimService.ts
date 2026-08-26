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

// An abandoned claim (process dies between this write and the caller's later
// emailDomains[] persistence) must not block the domain forever — a fresh
// claim attempt is allowed to override one older than this window instead of
// requiring manual intervention. Comfortably longer than the Resend
// create/get-domain round trip the registration route makes right after
// claiming.
const CLAIM_STALE_MS = 10 * 60 * 1000;

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

/**
 * Atomically claim a domain for userId. Throws EmailDomainAlreadyClaimedError if already
 * claimed. The claim starts UNCONFIRMED — call confirmEmailDomainClaim once the caller's
 * later emailDomains[] write actually succeeds. Only an unconfirmed claim can be taken over
 * by the staleness window below; a confirmed claim is a real, completed registration and
 * must never expire, or two accounts could end up owning the same domain.
 */
export async function claimEmailDomain(userId: string, normalizedDomain: string): Promise<void> {
  const staleBefore = new Date(Date.now() - CLAIM_STALE_MS).toISOString();
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
        ConditionExpression:
          'attribute_not_exists(configId) OR (attribute_not_exists(confirmed) AND claimedAt < :staleBefore)',
        ExpressionAttributeValues: { ':staleBefore': staleBefore },
      })
      .promise();
  } catch (err: any) {
    if (err?.code !== 'ConditionalCheckFailedException') throw err;
    // Strongly consistent: the put above just lost a race (or hit a live claim), and an
    // eventually-consistent read here could still return stale/missing data and misreport
    // claimedByUserId.
    const existing = await client()
      .get({
        TableName: CONFIGS_TABLE,
        Key: { userId: CLAIM_PARTITION, configId: claimConfigId(normalizedDomain) },
        ConsistentRead: true,
      })
      .promise();
    throw new EmailDomainAlreadyClaimedError(normalizedDomain, existing.Item?.ownerUserId ?? 'another account');
  }
}

/**
 * Promote a claim to confirmed once the caller's emailDomains[] write has actually landed, so
 * the abandoned-claim staleness window in claimEmailDomain no longer applies to it. Conditioned
 * on the caller still being the current owner (mirrors releaseEmailDomainClaim) — a failed
 * condition means this claim was already superseded, which is a no-op, not an error.
 */
export async function confirmEmailDomainClaim(normalizedDomain: string, ownerUserId: string): Promise<void> {
  try {
    await client()
      .update({
        TableName: CONFIGS_TABLE,
        Key: { userId: CLAIM_PARTITION, configId: claimConfigId(normalizedDomain) },
        UpdateExpression: 'SET confirmed = :true, confirmedAt = :now',
        ConditionExpression: 'ownerUserId = :ownerUserId',
        ExpressionAttributeValues: {
          ':true': true,
          ':now': new Date().toISOString(),
          ':ownerUserId': ownerUserId,
        },
      })
      .promise();
  } catch (err: any) {
    if (err?.code !== 'ConditionalCheckFailedException') throw err;
  }
}

/**
 * Release a claim (e.g. on removal, or to unwind a claim after a later step in registration
 * failed). Conditioned on the caller still being the current owner, so a delayed or duplicate
 * release call can't delete a different user's newer claim on the same domain (which would let
 * two users end up "owning" it at once — e.g. a stale retry racing a stale-claim override by a
 * different user). A failed condition means someone else already holds this domain's claim slot,
 * which is exactly the state the caller wanted, so it's a successful no-op, not an error.
 */
export async function releaseEmailDomainClaim(normalizedDomain: string, ownerUserId: string): Promise<void> {
  try {
    await client()
      .delete({
        TableName: CONFIGS_TABLE,
        Key: { userId: CLAIM_PARTITION, configId: claimConfigId(normalizedDomain) },
        ConditionExpression: 'ownerUserId = :ownerUserId',
        ExpressionAttributeValues: { ':ownerUserId': ownerUserId },
      })
      .promise();
  } catch (err: any) {
    if (err?.code !== 'ConditionalCheckFailedException') throw err;
  }
}
