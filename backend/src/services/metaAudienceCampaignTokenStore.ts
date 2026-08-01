/**
 * Tracks single-use consumption of audience-campaign confirm preview tokens.
 *
 * ENG-600 Greptile findings:
 * 1. An HMAC-valid preview token was never consumed or invalidated after
 *    use, so replaying the same confirmed call would silently re-execute —
 *    e.g. creating a second ad set under the same campaign with no new user
 *    confirmation.
 * 2. A separate check-then-mark (isConsumed, then markConsumed) is
 *    non-atomic: two concurrent requests with the same valid token could
 *    both read "not yet consumed" before either write became visible, both
 *    then executing from a single user confirmation.
 *
 * claimPreviewToken closes both by using a single conditional DynamoDB put
 * (attribute_not_exists) to claim the token atomically — only one concurrent
 * caller can ever win. Mirrors the same conditional-put race-safety pattern
 * already used elsewhere in this codebase (see enrichSoServiceFactory.ts's
 * safeIncrement day-rollover claim).
 *
 * Reuses the existing AW-Configs table (keyed userId+configId) rather than a
 * new table — per CLAUDE.md's "Database/data-plane work requires Harsha
 * before merge" gate, this is a new logical use of an existing table/schema,
 * not a schema change.
 *
 * Consumed-token records are small (a few dozen bytes) and are not
 * auto-expired — left as a known, low-cost follow-up rather than touching
 * the table's TTL configuration (a retention change, its own approval gate).
 */

import AWS from 'aws-sdk';

const TABLE_PREFIX = process.env.NODE_ENV === 'production' ? '' : 'Dev-';
const CONFIGS_TABLE = `${TABLE_PREFIX}AW-Configs`;

function tokenConfigId(token: string): string {
  return `metaAudienceCampaignConfirmToken:${token}`;
}

/**
 * Attempts to atomically claim a preview token for this user. Returns true
 * if this call won the claim (the token had never been claimed before) and
 * false if it was already claimed (by a prior call, or a concurrent one that
 * won the race) — the caller should treat false exactly like an invalid
 * token and fall back to a fresh preview rather than executing.
 */
export async function claimPreviewToken(userId: string, token: string): Promise<boolean> {
  const dynamodb = new AWS.DynamoDB.DocumentClient();
  try {
    await dynamodb.put({
      TableName: CONFIGS_TABLE,
      Item: {
        userId,
        configId: tokenConfigId(token),
        consumedAt: new Date().toISOString(),
      },
      ConditionExpression: 'attribute_not_exists(userId)',
    }).promise();
    return true;
  } catch (e: any) {
    if (e.code === 'ConditionalCheckFailedException') return false;
    throw e;
  }
}

// Greptile follow-up finding: swallowing a delete failure on the first
// attempt defeated the whole point of releasing — a transient DynamoDB blip
// would leave the token permanently consumed just as before this fix
// existed. Retrying (mirroring saveAudienceSnapshotRowKeys's pattern) makes
// that the rare case rather than the common one.
const RELEASE_RETRY_ATTEMPTS = 3;
const RELEASE_RETRY_DELAY_MS = 200;

/**
 * Releases a claimed token after a failed launch, so a legitimate retry with
 * the exact same (unchanged) arguments — which produces the same
 * deterministic HMAC digest — can claim it again instead of being
 * permanently locked out. Retries a few times before giving up; even after
 * exhausting retries this stays best-effort (swallowed) rather than
 * compounding the original launch failure with a second thrown error — a
 * failure to release just means the caller needs a fresh preview next time.
 */
export async function releasePreviewToken(userId: string, token: string): Promise<void> {
  const dynamodb = new AWS.DynamoDB.DocumentClient();
  for (let attempt = 1; attempt <= RELEASE_RETRY_ATTEMPTS; attempt++) {
    try {
      await dynamodb.delete({
        TableName: CONFIGS_TABLE,
        Key: { userId, configId: tokenConfigId(token) },
      }).promise();
      return;
    } catch {
      if (attempt < RELEASE_RETRY_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, RELEASE_RETRY_DELAY_MS));
      }
      // Best-effort — see docstring. Final attempt's failure is swallowed too.
    }
  }
}
