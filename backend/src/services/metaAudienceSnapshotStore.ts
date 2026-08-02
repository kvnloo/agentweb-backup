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
 * `generationId` + `chunkCount`) plus N chunk items
 * (`metaAudienceSnapshot:<audienceId>:gen:<generationId>:chunk:<i>`, each
 * holding up to MAX_KEYS_PER_CHUNK rowKeys) rather than one flat array in one
 * item — DynamoDB caps a single item at 400KB, which a large audience's
 * row-keys array could exceed if stored as one array.
 *
 * Greptile finding: an earlier version reused the SAME static chunk keys
 * (`...chunk:<i>`, no generation) across every save. Chunk-before-index
 * write ordering protected against the index ever pointing at a chunk that
 * was never written, but NOT against a "mixed generation" read: if a new
 * save's chunk writes partially succeeded (overwriting some low-numbered
 * chunk keys with fresh data) and then its index write failed, the OLD
 * index — still pointing at the OLD chunkCount — would read back a mix of
 * newly-overwritten low chunks and stale untouched high chunks, silently
 * treating that inconsistent mash-up as one coherent baseline. Namespacing
 * every save's chunks under a unique generationId makes this impossible: a
 * failed save's chunks are written under keys no read ever references (the
 * index still points at the OLD generationId until the NEW generation's
 * index write succeeds), so a read always sees exactly one generation's
 * chunks, never a mix. Orphaned old-generation chunks after a failed save
 * are harmless — small, and not accumulating indefinitely in practice since
 * each successful save's generation is what future reads/writes reference.
 */

import AWS from 'aws-sdk';
import { randomUUID } from 'crypto';

const TABLE_PREFIX = process.env.NODE_ENV === 'production' ? '' : 'Dev-';
const CONFIGS_TABLE = `${TABLE_PREFIX}AW-Configs`;

// ~130 bytes per row-key (two 64-char hex hashes + separator) * 2000 ≈ 260KB,
// comfortably under the 400KB DynamoDB item cap with room for item overhead.
const MAX_KEYS_PER_CHUNK = 2000;

function indexConfigId(audienceId: string): string {
  return `metaAudienceSnapshot:${audienceId}`;
}

function chunkConfigId(audienceId: string, generationId: string, index: number): string {
  return `metaAudienceSnapshot:${audienceId}:gen:${generationId}:chunk:${index}`;
}

// Greptile finding: a malformed/missing chunk or index throws to block the
// launch (see below) so an incomplete baseline is never silently treated as
// complete — but a generic Error looks identical to a transient DynamoDB
// outage to the caller, which blocked EVERY future launch for that audience
// forever, since a corrupted record never becomes readable on retry (unlike
// a transient outage, which does). A distinct error type lets the caller
// treat corruption specifically as "no trustworthy baseline" (falling back
// to the same self-healing no-baseline REPLACE_USERS path already used when
// no snapshot exists at all — still never proceeds with an incomplete
// baseline, and a fresh, uncorrupted snapshot gets saved right after) while
// still hard-blocking on a real infra failure, which SHOULD keep blocking
// rather than triggering an unnecessary full resync on every attempt.
export class CorruptSnapshotError extends Error {}

export async function getAudienceSnapshotRowKeys(userId: string, audienceId: string): Promise<string[] | null> {
  const dynamodb = new AWS.DynamoDB.DocumentClient();
  const indexResult = await dynamodb.get({
    TableName: CONFIGS_TABLE,
    Key: { userId, configId: indexConfigId(audienceId) },
  }).promise();

  const item = indexResult.Item;
  if (!item) return null;

  // Backward-compat: an index item that stores rowKeys directly (a
  // hand-written test fixture, or a trivial/legacy shape) — return as-is.
  if (Array.isArray(item.rowKeys)) return item.rowKeys;

  const chunkCount = typeof item.chunkCount === 'number' ? item.chunkCount : 0;
  if (chunkCount === 0) return null;

  const generationId = item.generationId;
  if (typeof generationId !== 'string' || !generationId) {
    throw new CorruptSnapshotError(`Snapshot index for audience ${audienceId} has chunkCount but no generationId — malformed index.`);
  }

  const chunkResults = await Promise.all(
    Array.from({ length: chunkCount }, (_, i) =>
      dynamodb.get({
        TableName: CONFIGS_TABLE,
        Key: { userId, configId: chunkConfigId(audienceId, generationId, i) },
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
      throw new CorruptSnapshotError(`Snapshot chunk ${i} for audience ${audienceId} (generation ${generationId}) is missing or malformed (expected ${chunkCount} chunks).`);
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

  // Every save gets a fresh generation id and writes to NEW, never-before-used
  // chunk keys — see the module docstring for why this eliminates mixed-
  // generation reads even under a partial-write failure.
  const generationId = randomUUID();

  await Promise.all(
    chunks.map((chunk, i) =>
      dynamodb.put({
        TableName: CONFIGS_TABLE,
        Item: { userId, configId: chunkConfigId(audienceId, generationId, i), rowKeys: chunk },
      }).promise()
    )
  );

  await dynamodb.put({
    TableName: CONFIGS_TABLE,
    Item: {
      userId,
      configId: indexConfigId(audienceId),
      generationId,
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
