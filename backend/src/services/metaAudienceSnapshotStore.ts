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
 * Sharded across an index item (`metaAudienceSnapshot:<audienceId>`, holding
 * `chunkCount`) plus N chunk items (`metaAudienceSnapshot:<audienceId>:chunk:<i>`,
 * each holding up to MAX_KEYS_PER_CHUNK rowKeys) rather than one flat array in
 * one item — DynamoDB caps a single item at 400KB, which a large audience's
 * row-keys array could exceed if stored as one array. Chunk items are written
 * before the index item so a partial write failure never leaves the index
 * pointing at a chunk that was never saved.
 */

import AWS from 'aws-sdk';

const TABLE_PREFIX = process.env.NODE_ENV === 'production' ? '' : 'Dev-';
const CONFIGS_TABLE = `${TABLE_PREFIX}AW-Configs`;

// ~130 bytes per row-key (two 64-char hex hashes + separator) * 2000 ≈ 260KB,
// comfortably under the 400KB DynamoDB item cap with room for item overhead.
const MAX_KEYS_PER_CHUNK = 2000;

function indexConfigId(audienceId: string): string {
  return `metaAudienceSnapshot:${audienceId}`;
}

function chunkConfigId(audienceId: string, index: number): string {
  return `metaAudienceSnapshot:${audienceId}:chunk:${index}`;
}

export async function getAudienceSnapshotRowKeys(userId: string, audienceId: string): Promise<string[] | null> {
  const dynamodb = new AWS.DynamoDB.DocumentClient();
  const indexResult = await dynamodb.get({
    TableName: CONFIGS_TABLE,
    Key: { userId, configId: indexConfigId(audienceId) },
  }).promise();

  const item = indexResult.Item;
  if (!item) return null;

  // Backward-compat: an index item that stores rowKeys directly (pre-sharding
  // format, or a hand-written test fixture) — return as-is.
  if (Array.isArray(item.rowKeys)) return item.rowKeys;

  const chunkCount = typeof item.chunkCount === 'number' ? item.chunkCount : 0;
  if (chunkCount === 0) return null;

  const chunkResults = await Promise.all(
    Array.from({ length: chunkCount }, (_, i) =>
      dynamodb.get({
        TableName: CONFIGS_TABLE,
        Key: { userId, configId: chunkConfigId(audienceId, i) },
      }).promise()
    )
  );

  // Greptile finding: a missing/malformed chunk used to be silently treated
  // as contributing zero rows, returning a SHORT baseline as if it were
  // complete — reconciliation would then never issue DELETE_USERS for the
  // stale contacts the omitted chunk actually represented, leaving them
  // targetable forever with no signal anything was wrong. Throwing treats
  // this as a read failure, which agentModeService already blocks the whole
  // launch on rather than proceeding with an incomplete baseline.
  const rowKeys: string[] = [];
  for (let i = 0; i < chunkResults.length; i++) {
    const chunkRowKeys = chunkResults[i].Item?.rowKeys;
    if (!Array.isArray(chunkRowKeys)) {
      throw new Error(`Snapshot chunk ${i} for audience ${audienceId} is missing or malformed (expected ${chunkCount} chunks).`);
    }
    rowKeys.push(...chunkRowKeys);
  }
  return rowKeys;
}

// Greptile P1 finding: a save failure was purely non-fatal with no retry — the
// next sync would find no prior snapshot at all and silently skip stale-member
// reconciliation entirely. Retrying covers the common transient-failure case
// (e.g. a throughput-exceeded blip) without a bigger atomic-rewrite of the
// sharded storage format.
const SAVE_RETRY_ATTEMPTS = 3;
const SAVE_RETRY_DELAY_MS = 200;

async function saveAudienceSnapshotRowKeysOnce(userId: string, audienceId: string, rowKeys: string[]): Promise<void> {
  const dynamodb = new AWS.DynamoDB.DocumentClient();

  const chunks: string[][] = [];
  for (let i = 0; i < rowKeys.length; i += MAX_KEYS_PER_CHUNK) {
    chunks.push(rowKeys.slice(i, i + MAX_KEYS_PER_CHUNK));
  }
  if (chunks.length === 0) chunks.push([]); // zero-member audience still gets a baseline snapshot

  await Promise.all(
    chunks.map((chunk, i) =>
      dynamodb.put({
        TableName: CONFIGS_TABLE,
        Item: { userId, configId: chunkConfigId(audienceId, i), rowKeys: chunk },
      }).promise()
    )
  );

  await dynamodb.put({
    TableName: CONFIGS_TABLE,
    Item: {
      userId,
      configId: indexConfigId(audienceId),
      chunkCount: chunks.length,
      updatedAt: new Date().toISOString(),
    },
  }).promise();
}

export async function saveAudienceSnapshotRowKeys(userId: string, audienceId: string, rowKeys: string[]): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= SAVE_RETRY_ATTEMPTS; attempt++) {
    try {
      await saveAudienceSnapshotRowKeysOnce(userId, audienceId, rowKeys);
      return;
    } catch (e) {
      lastError = e;
      if (attempt < SAVE_RETRY_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, SAVE_RETRY_DELAY_MS));
      }
    }
  }
  throw lastError;
}
