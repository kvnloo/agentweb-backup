/**
 * ENG-2837. Server-side idempotency for the public lead capture endpoint
 * (POST /api/webhooks/forward-lead and its /api/leads/public/:listId alias).
 *
 * A lander that loses the response to a successful capture (timeout, tab sleep, a 502 from
 * its own Vercel route) retries with the SAME submission key — the Flatfee landers keep one
 * `submissionId` per form in sessionStorage until a submission is accepted. Without this, the
 * retry re-ran the whole capture: a second owner notification, a second CAPI Lead event, a
 * second HubSpot/Attio push. With it, the first request to claim (listId, key) does the work
 * and stores its response; every repeat gets that exact response back and does nothing else.
 *
 * Storage: one item per (listId, key) in the EXISTING AW-Configs table under a reserved
 * system partition — the same no-new-table pattern emailDomainClaimService uses for its
 * global claims. Nothing in AW-Configs reads that partition.
 *
 *   in_progress  { ownerToken, claimedAtMs }   — someone is processing it right now
 *   completed    { leadId, responseStatus, responseBody, completedAt } — replay this
 *
 * The claim is a conditional put (attribute_not_exists, or an in_progress claim older than
 * CLAIM_STALE_MS), so two concurrent requests cannot both win. A completed record has no
 * `claimedAtMs`, and a comparison against a missing attribute is false, so a completed key can
 * never be reclaimed. A failed attempt deletes its own claim (owner-token conditioned) so the
 * retry is processed; if even that delete fails, the staleness window frees it.
 */

import AWS from 'aws-sdk';
import { createHash, randomUUID } from 'crypto';

// Same prefix rule as services/db.ts, so the claim lives beside the leads it guards.
const TABLE_PREFIX = process.env.NODE_ENV === 'development' ? 'Dev-' : '';
const CONFIGS_TABLE = `${TABLE_PREFIX}AW-Configs`;
const CLAIM_PARTITION = '__system__:leadSubmissionClaims';

/**
 * An in_progress claim older than this is presumed abandoned (the owner crashed between claim
 * and completion) and may be taken over. A capture normally completes in well under a second;
 * two minutes is long enough that a slow-but-alive owner is never reclaimed out from under itself.
 */
export const CLAIM_STALE_MS = 2 * 60 * 1000;

/** Bound on what we accept as a key: UUIDs and similar opaque tokens, never free text. */
const KEY_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/;

let docClient: AWS.DynamoDB.DocumentClient | null = null;
let waitAttempts = 12;
let waitDelayMs = 250;

function client(): AWS.DynamoDB.DocumentClient {
  if (!docClient) docClient = new AWS.DynamoDB.DocumentClient();
  return docClient;
}

/** Test seam: inject a DocumentClient (e.g. tests/helpers/inMemoryDynamo) and shrink the in-flight wait. */
export function __configureLeadSubmissionIdempotencyForTests(opts: {
  client?: AWS.DynamoDB.DocumentClient | null;
  waitAttempts?: number;
  waitDelayMs?: number;
}): void {
  if (opts.client !== undefined) docClient = opts.client;
  if (opts.waitAttempts !== undefined) waitAttempts = opts.waitAttempts;
  if (opts.waitDelayMs !== undefined) waitDelayMs = opts.waitDelayMs;
}

/**
 * The caller's submission key, or null when it sent none (behaviour then stays exactly as
 * before). Precedence: an explicit top-level `idempotencyKey`, then top-level `submissionId`
 * (what the Flatfee capture route forwards), then `customFields.submissionId` (where that same
 * value is stored on the lead, for callers that nest it). A present-but-malformed key is
 * ignored with a warning rather than rejected: this route is public and a capture must never
 * fail because of an optional dedupe hint.
 */
export function resolveSubmissionKey(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, any>;
  const nested = b.customFields && typeof b.customFields === 'object' ? b.customFields.submissionId : undefined;
  for (const candidate of [b.idempotencyKey, b.submissionId, nested]) {
    if (candidate === undefined || candidate === null || candidate === '') continue;
    const key = typeof candidate === 'string' ? candidate.trim() : '';
    if (KEY_PATTERN.test(key)) return key;
    console.warn('[leadSubmissionIdempotency] ignoring malformed submission key', { type: typeof candidate });
    return null;
  }
  return null;
}

function configIdFor(listId: string, key: string): string {
  return `leadSubmission:${createHash('sha256').update(`${listId}\n${key}`).digest('hex')}`;
}

export interface CompletedSubmission {
  leadId: string;
  responseStatus: number;
  responseBody: Record<string, unknown>;
}

export type ClaimResult =
  | { outcome: 'claimed'; ownerToken: string }
  | { outcome: 'completed'; record: CompletedSubmission }
  | { outcome: 'in_progress' };

async function readRecord(listId: string, key: string): Promise<Record<string, any> | undefined> {
  const res = await client()
    .get({ TableName: CONFIGS_TABLE, Key: { userId: CLAIM_PARTITION, configId: configIdFor(listId, key) }, ConsistentRead: true })
    .promise();
  return res.Item;
}

function asCompleted(item: Record<string, any> | undefined): CompletedSubmission | null {
  if (!item || item.status !== 'completed' || typeof item.leadId !== 'string') return null;
  return { leadId: item.leadId, responseStatus: Number(item.responseStatus), responseBody: item.responseBody };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Claim (listId, key). A loser that finds the key completed gets the stored response; one that
 * finds it in flight waits a bounded time for it to complete (a double-click resolves to the
 * original's response) and otherwise reports in_progress. Throws only on a DynamoDB error.
 */
export async function claimLeadSubmission(listId: string, key: string): Promise<ClaimResult> {
  const ownerToken = randomUUID();
  const configId = configIdFor(listId, key);
  try {
    await client()
      .put({
        TableName: CONFIGS_TABLE,
        Item: {
          userId: CLAIM_PARTITION, configId, status: 'in_progress',
          ownerToken, claimedAtMs: Date.now(), listId,
        },
        ConditionExpression: 'attribute_not_exists(configId) OR claimedAtMs < :staleBefore',
        ExpressionAttributeValues: { ':staleBefore': Date.now() - CLAIM_STALE_MS },
      })
      .promise();
    return { outcome: 'claimed', ownerToken };
  } catch (err: any) {
    if (err?.code !== 'ConditionalCheckFailedException') throw err;
  }

  for (let attempt = 0; attempt <= waitAttempts; attempt++) {
    const completed = asCompleted(await readRecord(listId, key));
    if (completed) return { outcome: 'completed', record: completed };
    if (attempt < waitAttempts) await sleep(waitDelayMs);
  }
  return { outcome: 'in_progress' };
}

/**
 * Record the response for a claim this caller owns. Replaces the in_progress item with the
 * completed one (dropping claimedAtMs, so it can never be reclaimed). Returns false when the
 * claim is no longer ours (reclaimed as stale) — the work is done either way; only the replay
 * record was not written by us.
 */
export async function completeLeadSubmission(
  listId: string,
  key: string,
  ownerToken: string,
  record: CompletedSubmission,
): Promise<boolean> {
  try {
    await client()
      .put({
        TableName: CONFIGS_TABLE,
        Item: {
          userId: CLAIM_PARTITION, configId: configIdFor(listId, key), status: 'completed', listId,
          leadId: record.leadId, responseStatus: record.responseStatus, responseBody: record.responseBody,
          completedAt: new Date().toISOString(),
        },
        ConditionExpression: 'ownerToken = :ownerToken',
        ExpressionAttributeValues: { ':ownerToken': ownerToken },
      })
      .promise();
    return true;
  } catch (err: any) {
    if (err?.code === 'ConditionalCheckFailedException') return false;
    throw err;
  }
}

/** Give back a claim whose work failed before any lead was written, so the retry is processed. */
export async function releaseLeadSubmission(listId: string, key: string, ownerToken: string): Promise<void> {
  try {
    await client()
      .delete({
        TableName: CONFIGS_TABLE,
        Key: { userId: CLAIM_PARTITION, configId: configIdFor(listId, key) },
        ConditionExpression: 'ownerToken = :ownerToken',
        ExpressionAttributeValues: { ':ownerToken': ownerToken },
      })
      .promise();
  } catch (err: any) {
    if (err?.code === 'ConditionalCheckFailedException') return;
    throw err;
  }
}
