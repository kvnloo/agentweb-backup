/**
 * AW-UnipileSentInvitations — cache of PENDING (sent but not-yet-accepted) LinkedIn
 * connection invitations per Unipile account.
 *
 * Table schema:
 *   PK: accountId             (Unipile account ID)
 *   SK: invitedUserPublicId   (LinkedIn public identifier, e.g. "johndoe")
 *
 *   GSI: publicProfileUrl-index
 *     PK: publicProfileUrl    — lets the CRM check "did we already invite this lead?"
 *
 * Populated by linkedInConnectionSyncCron (every ~10 min): it pulls all sent
 * invitations from Unipile (getAllInvitationsSent) and reconciles the cache —
 * invitations that have been accepted/withdrawn drop off Unipile's feed and are
 * pruned here, so a row existing == invitation is still pending.
 *
 * Mirrors unipileConnectionsDb so the CRM can show "Invitation pending" and
 * suppress re-inviting.
 */

import AWS from 'aws-sdk';
import dotenv from 'dotenv';
import path from 'path';
import { normalizeLinkedInUrl } from './unipileConnectionsDb';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

AWS.config.update({
  region: process.env.AWS_REGION || 'us-west-2',
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
});

const dynamodb = new AWS.DynamoDB.DocumentClient();

const TABLE_PREFIX = process.env.NODE_ENV === 'development' ? 'Dev-' : '';
const TABLE = `${TABLE_PREFIX}AW-UnipileSentInvitations`;

export interface UnipileSentInvitation {
  accountId: string;           // Unipile account ID (PK)
  invitedUserPublicId: string; // LinkedIn public identifier (SK) — e.g. "johndoe"
  publicProfileUrl: string;    // normalized "https://www.linkedin.com/in/johndoe/" (GSI key)
  invitationId: string;        // Unipile invitation id (for withdraw, if ever needed)
  invitedUserName: string;
  invitationText: string;
  sentAt: string;              // ISO — Unipile parsed_datetime when the invite was sent
  syncedAt: string;            // ISO — when this row was last written
}

/** Build the normalized profile URL from a Unipile public identifier. */
export function profileUrlFromPublicId(publicId: string): string {
  return normalizeLinkedInUrl(`https://www.linkedin.com/in/${publicId}/`);
}

/** Upsert a single pending-invitation record. Idempotent. */
export async function upsertSentInvitation(inv: UnipileSentInvitation): Promise<void> {
  await dynamodb.put({ TableName: TABLE, Item: inv }).promise();
}

/** Upsert many pending invitations in parallel batches. */
export async function upsertSentInvitations(invs: UnipileSentInvitation[]): Promise<void> {
  if (invs.length === 0) return;
  const BATCH = 25;
  for (let i = 0; i < invs.length; i += BATCH) {
    await Promise.all(invs.slice(i, i + BATCH).map(upsertSentInvitation));
  }
}

/**
 * Reconcile the cache for an account to exactly the given set of still-pending
 * public ids: delete any cached rows whose invitedUserPublicId is no longer in
 * the set (accepted/withdrawn invitations drop off Unipile's sent feed).
 */
export async function pruneStaleSentInvitations(
  accountId: string,
  stillPendingPublicIds: Set<string>,
): Promise<number> {
  const existing = await getAllSentInvitationsByAccount(accountId);
  const stale = existing.filter((inv) => !stillPendingPublicIds.has(inv.invitedUserPublicId));
  const BATCH = 25;
  for (let i = 0; i < stale.length; i += BATCH) {
    await Promise.all(stale.slice(i, i + BATCH).map((inv) =>
      dynamodb.delete({
        TableName: TABLE,
        Key: { accountId, invitedUserPublicId: inv.invitedUserPublicId },
      }).promise()
    ));
  }
  return stale.length;
}

/**
 * Look up a pending invitation by the invited user's LinkedIn public id for a
 * specific account. Uses the base-table PK (accountId, invitedUserPublicId) so
 * the read is STRONGLY consistent — unlike the GSI variant below, this reflects
 * a write-through upsert made earlier in the same run immediately (the GSI is
 * only eventually consistent). Returns the record or null.
 */
export async function getSentInvitationByPublicIdAndAccount(
  accountId: string,
  invitedUserPublicId: string,
): Promise<UnipileSentInvitation | null> {
  if (!accountId || !invitedUserPublicId) return null;
  const result = await dynamodb.get({
    TableName: TABLE,
    Key: { accountId, invitedUserPublicId },
  }).promise();
  return (result.Item as UnipileSentInvitation) ?? null;
}

/** Look up a pending invitation by profile URL for a specific account. Returns the record or null. */
export async function getSentInvitationByProfileUrlAndAccount(
  publicProfileUrl: string,
  accountId: string,
): Promise<UnipileSentInvitation | null> {
  const normalized = normalizeLinkedInUrl(publicProfileUrl);
  const result = await dynamodb.query({
    TableName: TABLE,
    IndexName: 'publicProfileUrl-index',
    KeyConditionExpression: 'publicProfileUrl = :url',
    FilterExpression: 'accountId = :aid',
    ExpressionAttributeValues: { ':url': normalized, ':aid': accountId },
    Limit: 5,
  }).promise();
  return (result.Items?.[0] as UnipileSentInvitation) ?? null;
}

/** Fetch all pending-invitation rows for an account. */
export async function getAllSentInvitationsByAccount(accountId: string): Promise<UnipileSentInvitation[]> {
  const items: UnipileSentInvitation[] = [];
  let lastEvaluatedKey: AWS.DynamoDB.DocumentClient.Key | undefined;
  do {
    const result = await dynamodb.query({
      TableName: TABLE,
      KeyConditionExpression: 'accountId = :aid',
      ExpressionAttributeValues: { ':aid': accountId },
      ExclusiveStartKey: lastEvaluatedKey,
    }).promise();
    items.push(...((result.Items ?? []) as UnipileSentInvitation[]));
    lastEvaluatedKey = result.LastEvaluatedKey as AWS.DynamoDB.DocumentClient.Key | undefined;
  } while (lastEvaluatedKey);
  return items;
}
