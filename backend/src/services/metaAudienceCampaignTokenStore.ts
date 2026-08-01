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

// Greptile finding: releasePreviewToken is only best-effort — if it exhausts
// its own retries (a double failure: the launch failed AND the release
// failed), the claim record was left in place FOREVER, since the digest is
// deterministic and the token can never be re-claimed once taken. Allowing a
// claim to be taken over once it's older than this window means a retry is
// never permanently blocked purely by release having failed — worst case it
// waits out this window. A genuinely concurrent duplicate request within the
// window still correctly loses the race, since the DynamoDB condition (not
// the caller) decides atomically.
//
// Greptile follow-up finding: the staleness override alone didn't
// distinguish "claimed because the launch failed and release also failed"
// from "claimed because the launch SUCCEEDED" — after the window, a caller
// could reclaim and re-execute an already-successfully-completed launch too,
// defeating single-use replay protection entirely for anything older than
// the window. Every claim is written with status "in_progress"; only a
// record still in that status (never promoted to "consumed" by
// markPreviewTokenSucceeded) is eligible for staleness-based reclaim — a
// genuinely successful launch's record can never be reclaimed, no matter
// how old.
const CLAIM_STALE_AFTER_MS = 60_000;

/**
 * Attempts to atomically claim a preview token for this user. Returns true
 * if this call won the claim — the token had never been claimed before, OR
 * the existing claim is still "in_progress" (never marked succeeded) and
 * older than CLAIM_STALE_AFTER_MS — and false if it's claimed-and-fresh, or
 * permanently consumed by a successful launch. The caller should treat
 * false exactly like an invalid token and fall back to a fresh preview
 * rather than executing.
 */
export async function claimPreviewToken(userId: string, token: string): Promise<boolean> {
  const dynamodb = new AWS.DynamoDB.DocumentClient();
  const now = Date.now();
  try {
    await dynamodb.put({
      TableName: CONFIGS_TABLE,
      Item: {
        userId,
        configId: tokenConfigId(token),
        status: 'in_progress',
        consumedAt: new Date(now).toISOString(),
      },
      ConditionExpression: 'attribute_not_exists(userId) OR (#status = :inProgress AND consumedAt < :staleThreshold)',
      ExpressionAttributeNames: {
        '#status': 'status',
      },
      ExpressionAttributeValues: {
        ':inProgress': 'in_progress',
        ':staleThreshold': new Date(now - CLAIM_STALE_AFTER_MS).toISOString(),
      },
    }).promise();
    return true;
  } catch (e: any) {
    if (e.code === 'ConditionalCheckFailedException') return false;
    throw e;
  }
}

/**
 * Marks a claimed token as permanently consumed after a successful launch —
 * unlike an "in_progress" claim, a "consumed" record is never eligible for
 * staleness-based reclaim, no matter how old, so a genuinely completed
 * launch's token can never be replayed.
 */
export async function markPreviewTokenSucceeded(userId: string, token: string): Promise<void> {
  const dynamodb = new AWS.DynamoDB.DocumentClient();
  await dynamodb.put({
    TableName: CONFIGS_TABLE,
    Item: {
      userId,
      configId: tokenConfigId(token),
      status: 'consumed',
      consumedAt: new Date().toISOString(),
    },
  }).promise();
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
