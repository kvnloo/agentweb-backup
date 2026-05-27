/**
 * AW-UnipileConnections — cache of all LinkedIn 1st-degree connections per Unipile account.
 *
 * Table schema:
 *   PK: accountId       (Unipile account ID)
 *   SK: memberId        (LinkedIn member_id — stable, unlike public URLs)
 *
 *   GSI: publicProfileUrl-index
 *     PK: publicProfileUrl   — lets the drip worker check "is this lead already connected?"
 *
 * The table is populated by the linkedInConnectionSyncCron which polls getAllRelations
 * every 10 minutes per Unipile account. It is read-only for the rest of the application.
 */

import AWS from 'aws-sdk';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

AWS.config.update({
  region: process.env.AWS_REGION || 'us-west-2',
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
});

const dynamodb = new AWS.DynamoDB.DocumentClient();

const TABLE_PREFIX = process.env.NODE_ENV === 'development' ? 'Dev-' : '';
const TABLE = `${TABLE_PREFIX}AW-UnipileConnections`;

export interface UnipileConnection {
  accountId: string;        // Unipile account ID (PK)
  memberId: string;         // LinkedIn member_id — stable identifier (SK)
  publicProfileUrl: string; // e.g. "https://www.linkedin.com/in/johndoe/" (GSI key)
  memberUrn: string;
  connectionUrn: string;
  firstName: string;
  lastName: string;
  headline: string;
  connectedAt: number;      // UNIX timestamp from Unipile created_at
  syncedAt: string;         // ISO — when this record was last written
}

/** Upsert a single connection record. Idempotent — safe to call on every cron run. */
export async function upsertConnection(conn: UnipileConnection): Promise<void> {
  await dynamodb.put({
    TableName: TABLE,
    Item: conn,
  }).promise();
}

/** Upsert many connections in parallel batches. Also updates the per-account latestConnectedAt watermark. */
export async function upsertConnections(conns: UnipileConnection[]): Promise<void> {
  if (conns.length === 0) return;
  const BATCH = 25;
  for (let i = 0; i < conns.length; i += BATCH) {
    await Promise.all(conns.slice(i, i + BATCH).map(upsertConnection));
  }

  // Maintain a per-account watermark row (SK='__latest__') so getLatestConnectedAt
  // can do a direct GetItem instead of relying on alphabetical SK ordering.
  const maxByAccount = new Map<string, number>();
  for (const c of conns) {
    if (c.connectedAt > (maxByAccount.get(c.accountId) ?? 0)) {
      maxByAccount.set(c.accountId, c.connectedAt);
    }
  }
  await Promise.all(
    Array.from(maxByAccount.entries()).map(([accountId, connectedAt]) =>
      dynamodb.update({
        TableName: TABLE,
        Key: { accountId, memberId: '__latest__' },
        UpdateExpression: 'SET connectedAt = :ts',
        ConditionExpression: 'attribute_not_exists(connectedAt) OR connectedAt < :ts',
        ExpressionAttributeValues: { ':ts': connectedAt },
      }).promise().catch(() => { /* ConditionalCheckFailedException — stored value is already ≥ */ })
    )
  );
}

/**
 * Look up whether a LinkedIn profile URL is a 1st-degree connection for ANY
 * Unipile account. Returns the first matching record, or null if not connected.
 * Used by the drip worker and enrollment logic.
 */
export async function getConnectionByProfileUrl(publicProfileUrl: string): Promise<UnipileConnection | null> {
  const normalized = normalizeLinkedInUrl(publicProfileUrl);
  const result = await dynamodb.query({
    TableName: TABLE,
    IndexName: 'publicProfileUrl-index',
    KeyConditionExpression: 'publicProfileUrl = :url',
    ExpressionAttributeValues: { ':url': normalized },
    Limit: 1,
  }).promise();
  return (result.Items?.[0] as UnipileConnection) ?? null;
}

/**
 * Look up whether a LinkedIn profile URL is a 1st-degree connection for a
 * specific Unipile accountId. Returns the record, or null.
 */
export async function getConnectionByProfileUrlAndAccount(
  publicProfileUrl: string,
  accountId: string,
): Promise<UnipileConnection | null> {
  const normalized = normalizeLinkedInUrl(publicProfileUrl);
  const result = await dynamodb.query({
    TableName: TABLE,
    IndexName: 'publicProfileUrl-index',
    KeyConditionExpression: 'publicProfileUrl = :url',
    FilterExpression: 'accountId = :aid',
    ExpressionAttributeValues: { ':url': normalized, ':aid': accountId },
    Limit: 5,
  }).promise();
  return (result.Items?.[0] as UnipileConnection) ?? null;
}

/**
 * Fetch all connection records for a specific Unipile accountId.
 * Used by the linkedInConnected server-side filter.
 */
export async function getAllConnectionsByAccount(accountId: string): Promise<UnipileConnection[]> {
  const items: UnipileConnection[] = [];
  let lastEvaluatedKey: AWS.DynamoDB.DocumentClient.Key | undefined;
  do {
    const result = await dynamodb.query({
      TableName: TABLE,
      KeyConditionExpression: 'accountId = :aid',
      FilterExpression: 'memberId <> :wm',
      ExpressionAttributeValues: { ':aid': accountId, ':wm': '__latest__' },
      ExclusiveStartKey: lastEvaluatedKey,
    }).promise();
    items.push(...((result.Items ?? []) as UnipileConnection[]));
    lastEvaluatedKey = result.LastEvaluatedKey as AWS.DynamoDB.DocumentClient.Key | undefined;
  } while (lastEvaluatedKey);
  return items;
}

/** Get the timestamp of the most recently synced connection for an account. */
export async function getLatestConnectedAt(accountId: string): Promise<number | null> {
  // Read the watermark row written by upsertConnections (SK='__latest__').
  // Avoids relying on alphabetical SK ordering which does NOT sort by connectedAt.
  const result = await dynamodb.get({
    TableName: TABLE,
    Key: { accountId, memberId: '__latest__' },
    ProjectionExpression: 'connectedAt',
  }).promise();
  const item = result.Item as Pick<UnipileConnection, 'connectedAt'> | undefined;
  return item?.connectedAt ?? null;
}

/** Normalize a LinkedIn URL to lowercase with trailing slash for consistent GSI keys. */
export function normalizeLinkedInUrl(url: string): string {
  let u = url.trim().toLowerCase();
  if (!u.endsWith('/')) u += '/';
  return u;
}
