/**
 * Tracks single-use consumption of audience-campaign confirm preview tokens
 * (ENG-600 Greptile finding: an HMAC-valid preview token was never consumed
 * or invalidated after use, so replaying the same confirmed call would
 * silently re-execute — e.g. creating a second ad set under the same
 * campaign with no new user confirmation).
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

export async function isPreviewTokenConsumed(userId: string, token: string): Promise<boolean> {
  const dynamodb = new AWS.DynamoDB.DocumentClient();
  const result = await dynamodb.get({
    TableName: CONFIGS_TABLE,
    Key: { userId, configId: tokenConfigId(token) },
  }).promise();
  return !!result.Item;
}

export async function markPreviewTokenConsumed(userId: string, token: string): Promise<void> {
  const dynamodb = new AWS.DynamoDB.DocumentClient();
  await dynamodb.put({
    TableName: CONFIGS_TABLE,
    Item: {
      userId,
      configId: tokenConfigId(token),
      consumedAt: new Date().toISOString(),
    },
  }).promise();
}
