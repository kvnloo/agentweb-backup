/**
 * Persists the hashed row-keys last uploaded to a given Meta Custom Audience,
 * so a later reuse-and-resync can diff the new source against them and issue
 * removals for members no longer present (ENG-600 Greptile finding: reusing
 * an audience for a fresh source never removed stale members before).
 *
 * Reuses the existing AW-Configs table (keyed userId+configId) rather than a
 * new table — per CLAUDE.md's "Database/data-plane work requires Harsha
 * before merge" gate, this is a new logical use of an existing table/schema,
 * not a schema change.
 *
 * Note: rowKeys are stored as a flat string array in one item. DynamoDB caps
 * a single item at 400KB, which bounds this to roughly a few thousand rows
 * per audience before it would need to shard across multiple items — fine
 * for this ticket's HubSpot-list/CSV seed-audience scope, but a real
 * follow-up if this store is ever reused for much larger audiences.
 */

import AWS from 'aws-sdk';

const TABLE_PREFIX = process.env.NODE_ENV === 'production' ? '' : 'Dev-';
const CONFIGS_TABLE = `${TABLE_PREFIX}AW-Configs`;

function snapshotConfigId(audienceId: string): string {
  return `metaAudienceSnapshot:${audienceId}`;
}

export async function getAudienceSnapshotRowKeys(userId: string, audienceId: string): Promise<string[] | null> {
  const dynamodb = new AWS.DynamoDB.DocumentClient();
  const result = await dynamodb.get({
    TableName: CONFIGS_TABLE,
    Key: { userId, configId: snapshotConfigId(audienceId) },
  }).promise();

  const rowKeys = result.Item?.rowKeys;
  if (!Array.isArray(rowKeys)) return null;
  return rowKeys;
}

export async function saveAudienceSnapshotRowKeys(userId: string, audienceId: string, rowKeys: string[]): Promise<void> {
  const dynamodb = new AWS.DynamoDB.DocumentClient();
  await dynamodb.put({
    TableName: CONFIGS_TABLE,
    Item: {
      userId,
      configId: snapshotConfigId(audienceId),
      rowKeys,
      updatedAt: new Date().toISOString(),
    },
  }).promise();
}
