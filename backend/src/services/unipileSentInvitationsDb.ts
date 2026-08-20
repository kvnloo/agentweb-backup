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
 *
 * `known` lets a caller that has ALREADY loaded the account's rows hand them in
 * rather than making this function scan the same account a second time in the
 * same cycle (ENG-875 — the sync cron read every account twice per 10-minute
 * tick). Omit it and the read happens here exactly as before, so a caller that
 * failed to preload stays correct.
 *
 * The caller must pass the rows as they were BEFORE this cycle's upserts. That
 * is what the sync cron does, and it is safe because pruning is decided purely
 * by key membership in `stillPendingPublicIds` — a row this cycle rewrote is
 * still pending, so it is never a prune candidate regardless of its contents.
 */
export async function pruneStaleSentInvitations(
  accountId: string,
  stillPendingPublicIds: Set<string>,
  known?: UnipileSentInvitation[],
): Promise<number> {
  const existing = known ?? (await getAllSentInvitationsByAccount(accountId));
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
 * Drop specific pending-invitation rows the moment we learn they are no longer
 * pending, rather than waiting for the next full-feed prune (ENG-1197).
 *
 * An invitation leaves the pending set in exactly two ways, and we observe both
 * directly: the recipient accepts (the 10-minute connection sync sees the new
 * connection) or we withdraw it ourselves. Deleting on those events keeps the cache
 * fresh independently of how often the whole feed is walked — which matters because
 * that walk is now hourly, and a lead showing "invite pending" in the CRM an hour
 * after they accepted is a visible lie.
 *
 * The full-feed prune remains the backstop for everything else: invites that expired
 * on LinkedIn's side, or were withdrawn outside this product.
 */
export async function deleteSentInvitationsByProfileUrls(
  accountId: string,
  publicProfileUrls: string[],
): Promise<number> {
  // Normalize BEFORE discarding empties: a whitespace-only string is truthy and
  // survives filter(Boolean), but normalizes to '' — which would then match any
  // malformed cached row that also normalizes to '' and delete it.
  // Keep the Set: `includes` on an array made this O(rows x urls), and both sides
  // scale with the account's backlog — the reported account had 1,540 pending rows.
  const urls = new Set(
    publicProfileUrls.map((u) => (u ? normalizeLinkedInUrl(u) : '')).filter(Boolean),
  );
  if (urls.size === 0) return 0;

  const rows = (await getAllSentInvitationsByAccount(accountId)).filter((inv) =>
    urls.has(normalizeLinkedInUrl(inv.publicProfileUrl)),
  );
  return deleteRows(accountId, rows.map((r) => r.invitedUserPublicId));
}

/**
 * Drop the row for an invitation we just withdrew. Keyed by the invitation id
 * because that is what the withdraw call carries; the table's key is the invitee's
 * public id, so this resolves one from the other off the account's own partition.
 */
export async function deleteSentInvitationByInvitationId(
  accountId: string,
  invitationId: string,
): Promise<number> {
  if (!invitationId) return 0;
  const rows = (await getAllSentInvitationsByAccount(accountId)).filter(
    (inv) => inv.invitationId === invitationId,
  );
  return deleteRows(accountId, rows.map((r) => r.invitedUserPublicId));
}

/** Delete rows by their sort key, batched the same way the prune does. */
async function deleteRows(accountId: string, invitedUserPublicIds: string[]): Promise<number> {
  const BATCH = 25;
  for (let i = 0; i < invitedUserPublicIds.length; i += BATCH) {
    await Promise.all(invitedUserPublicIds.slice(i, i + BATCH).map((invitedUserPublicId) =>
      dynamodb.delete({
        TableName: TABLE,
        Key: { accountId, invitedUserPublicId },
      }).promise()
    ));
  }
  return invitedUserPublicIds.length;
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
