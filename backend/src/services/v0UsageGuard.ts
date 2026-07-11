import crypto from 'crypto';
import AWS from 'aws-sdk';

const TABLE_PREFIX = process.env.NODE_ENV === 'development' ? 'Dev-' : '';
const TABLE_NAME = `${TABLE_PREFIX}AW-V0Usage`;

const dynamodb = new AWS.DynamoDB.DocumentClient({
  region: process.env.AWS_REGION || 'us-west-2',
  httpOptions: { timeout: 10_000, connectTimeout: 3_000 },
});

export type V0UsageOperation =
  | 'first_page_chat_create'
  | 'additional_page_chat_create'
  | 'correction_message';

export interface V0UsageRecord {
  idempotencyKey: string;
  userId: string;
  operation: V0UsageOperation;
  scopeId: string;
  promptHash?: string;
  chatId?: string;
  status: 'reserved' | 'succeeded' | 'failed' | 'reused' | 'skipped';
  failureReason?: string;
  createdAt: string;
  updatedAt: string;
}

const memoryUsage = new Map<string, V0UsageRecord>();

/**
 * How long a `reserved` record is treated as a live lock. A guarded chat-create
 * holds the reservation only while `create()` runs — at most withRetry's
 * 3 × 300s ≈ 15 min. Past this ceiling a still-`reserved` record means the run
 * was abandoned (process crash / deploy before the catch), so we let a new
 * attempt reclaim it instead of blocking forever. (ENG-287)
 */
export const V0_RESERVATION_TTL_MS = 20 * 60 * 1000;

/**
 * Should an existing usage record block a NEW generation attempt?
 *
 * Only a *fresh* `reserved` record blocks — that is a genuinely in-progress run.
 * A `failed` record must never block (retries have to be able to proceed), a
 * `succeeded` record is handled as a reuse by the caller (not here), and a
 * `reserved` record older than the TTL is a crash-abandoned lock we reclaim.
 * (ENG-287)
 */
export function isReservationBlocking(
  existing: V0UsageRecord | undefined,
  nowMs: number,
  ttlMs: number = V0_RESERVATION_TTL_MS,
): boolean {
  if (!existing || existing.status !== 'reserved') return false;
  // An unparseable timestamp yields NaN → not blocking. Failing open here costs at
  // most one duplicate v0 call; failing closed would recreate the permanent wedge
  // this fix exists to kill.
  return nowMs - Date.parse(existing.updatedAt || existing.createdAt) <= ttlMs;
}

function persistenceEnabled(): boolean {
  return process.env.NODE_ENV !== 'test' || process.env.V0_USAGE_DYNAMO_TEST === 'true';
}

function normalizePrompt(prompt: string): string {
  return prompt.trim().replace(/\s+/g, ' ').toLowerCase();
}

export function hashV0Prompt(prompt: string): string {
  return crypto.createHash('sha256').update(normalizePrompt(prompt)).digest('hex').slice(0, 24);
}

export function buildV0IdempotencyKey(input: {
  userId: string;
  operation: V0UsageOperation;
  scopeId: string;
  slug?: string;
  prompt?: string;
  chatId?: string;
}): string {
  // The key deliberately does NOT include the prompt. The enriched prompt varies
  // between attempts (brand context is not stable), so keying on it meant retries
  // never deduped and each retry called v0 at full cost. "The same generation" is
  // identified by (operation, user, scope, slug[, chatId]) — the prompt is stored
  // on the record for observability but is not part of the identity. (ENG-287)
  return [
    input.operation,
    input.userId,
    input.scopeId,
    input.slug || '',
    input.chatId || '',
  ].join('#');
}

async function bestEffortPut(
  record: V0UsageRecord,
  opts?: {
    condition?: string;
    names?: Record<string, string>;
    values?: Record<string, unknown>;
  },
): Promise<boolean> {
  if (!persistenceEnabled()) return true;
  try {
    await dynamodb.put({
      TableName: TABLE_NAME,
      Item: record,
      ...(opts?.condition ? { ConditionExpression: opts.condition } : {}),
      ...(opts?.names ? { ExpressionAttributeNames: opts.names } : {}),
      ...(opts?.values ? { ExpressionAttributeValues: opts.values } : {}),
    }).promise();
    return true;
  } catch (error: any) {
    if (error?.code === 'ConditionalCheckFailedException') return false;
    console.warn('[V0_USAGE] Persistence skipped:', error?.message || error);
    return true;
  }
}

/**
 * Reserve the key iff nothing is holding it: no record, or a `failed` record, or
 * a `reserved` record older than the TTL (crash-abandoned). Mirrors
 * `isReservationBlocking` on the DynamoDB side so a concurrent winner is rejected.
 * The stale clause is scoped to `reserved` so a `succeeded` record is never
 * clobbered — reuse of an old succeeded chat must survive this put. (ENG-287)
 */
async function reserveInDynamo(record: V0UsageRecord, staleThresholdIso: string): Promise<boolean> {
  return bestEffortPut(record, {
    condition:
      'attribute_not_exists(idempotencyKey) OR #status = :failed OR (#status = :reserved AND #updatedAt < :stale)',
    names: { '#status': 'status', '#updatedAt': 'updatedAt' },
    values: { ':failed': 'failed', ':reserved': 'reserved', ':stale': staleThresholdIso },
  });
}

async function bestEffortGet(key: string): Promise<V0UsageRecord | undefined> {
  if (!persistenceEnabled()) return undefined;
  try {
    const res = await dynamodb.get({ TableName: TABLE_NAME, Key: { idempotencyKey: key } }).promise();
    return res.Item as V0UsageRecord | undefined;
  } catch (error: any) {
    console.warn('[V0_USAGE] Read skipped:', error?.message || error);
    return undefined;
  }
}

/**
 * Drop the usage records tied to a landing page when the page is deleted/archived.
 * Without this, the prompt-independent key makes a `succeeded` record permanent: a
 * user who deletes a page and regenerates the same slug would get the OLD chat back
 * as `reused` forever, silently ignoring their new prompt. Best-effort — a cleanup
 * failure must never block the delete itself. (ENG-287 review follow-up)
 */
export async function clearV0UsageForPage(input: {
  userId: string;
  pageId: string;
  siteId?: string;
  slug?: string;
}): Promise<void> {
  const keys = [
    buildV0IdempotencyKey({
      userId: input.userId,
      operation: 'first_page_chat_create',
      scopeId: input.pageId,
    }),
  ];
  if (input.siteId && input.slug) {
    keys.push(
      buildV0IdempotencyKey({
        userId: input.userId,
        operation: 'additional_page_chat_create',
        scopeId: input.siteId,
        slug: input.slug,
      }),
    );
  }
  for (const key of keys) {
    memoryUsage.delete(key);
    if (!persistenceEnabled()) continue;
    try {
      await dynamodb.delete({ TableName: TABLE_NAME, Key: { idempotencyKey: key } }).promise();
    } catch (error: any) {
      console.warn('[V0_USAGE] Cleanup skipped for', key, ':', error?.message || error);
    }
  }
}

async function save(record: V0UsageRecord): Promise<void> {
  record.updatedAt = new Date().toISOString();
  memoryUsage.set(record.idempotencyKey, record);
  await bestEffortPut(record);
}

export async function guardedV0ChatCreate<T = any>(input: {
  userId: string;
  operation: Extract<V0UsageOperation, 'first_page_chat_create' | 'additional_page_chat_create'>;
  scopeId: string;
  slug?: string;
  prompt: string;
  create: () => Promise<T>;
}): Promise<T | { id: string; reused: true }> {
  const idempotencyKey = buildV0IdempotencyKey(input);
  const existing = memoryUsage.get(idempotencyKey) || await bestEffortGet(idempotencyKey);
  if (existing?.chatId && existing.status === 'succeeded') {
    return { id: existing.chatId, reused: true };
  }
  // Only a fresh reservation blocks; a failed or crash-abandoned (stale) record
  // must let a retry through. (ENG-287)
  const nowMs = Date.now();
  if (isReservationBlocking(existing, nowMs)) {
    throw new Error('A v0 generation for this page is already in progress.');
  }

  const now = new Date(nowMs).toISOString();
  const reserved: V0UsageRecord = {
    idempotencyKey,
    userId: input.userId,
    operation: input.operation,
    scopeId: input.scopeId,
    promptHash: hashV0Prompt(input.prompt),
    status: 'reserved',
    createdAt: now,
    updatedAt: now,
  };
  memoryUsage.set(idempotencyKey, reserved);
  const staleThresholdIso = new Date(nowMs - V0_RESERVATION_TTL_MS).toISOString();
  const reservedInDynamo = await reserveInDynamo(reserved, staleThresholdIso);
  if (!reservedInDynamo) {
    // Lost the race to another instance — resync the local Map with the winner's
    // record so this instance's pre-check stops trusting its own stale reservation.
    const latest = await bestEffortGet(idempotencyKey);
    if (latest) memoryUsage.set(idempotencyKey, latest);
    else memoryUsage.delete(idempotencyKey);
    if (latest?.chatId && latest.status === 'succeeded') return { id: latest.chatId, reused: true };
    throw new Error('A v0 generation for this page is already in progress.');
  }

  try {
    const response = await input.create();
    const chatId = (response as any)?.id;
    if (!chatId) throw new Error('v0 chat creation did not return an id');
    await save({ ...reserved, status: 'succeeded', chatId });
    return response;
  } catch (error: any) {
    await save({ ...reserved, status: 'failed', failureReason: error?.message || String(error) });
    throw error;
  }
}

export async function guardedV0CorrectionMessage<T>(input: {
  userId: string;
  scopeId: string;
  chatId: string;
  send: () => Promise<T>;
}): Promise<T | { skipped: true }> {
  const idempotencyKey = buildV0IdempotencyKey({
    userId: input.userId,
    operation: 'correction_message',
    scopeId: input.scopeId,
    chatId: input.chatId,
  });
  const existing = memoryUsage.get(idempotencyKey) || await bestEffortGet(idempotencyKey);
  if (existing?.status === 'succeeded' || existing?.status === 'skipped') {
    return { skipped: true };
  }
  // A failed or crash-abandoned correction must not skip forever — the validation
  // retry loop depends on being able to send a second correction. Same reclaim
  // semantics as chat-create. (ENG-287 review follow-up)
  const nowMs = Date.now();
  if (isReservationBlocking(existing, nowMs)) {
    return { skipped: true };
  }

  const now = new Date(nowMs).toISOString();
  const reserved: V0UsageRecord = {
    idempotencyKey,
    userId: input.userId,
    operation: 'correction_message',
    scopeId: input.scopeId,
    chatId: input.chatId,
    status: 'reserved',
    createdAt: now,
    updatedAt: now,
  };
  memoryUsage.set(idempotencyKey, reserved);
  const reservedInDynamo = await reserveInDynamo(
    reserved,
    new Date(nowMs - V0_RESERVATION_TTL_MS).toISOString(),
  );
  if (!reservedInDynamo) return { skipped: true };

  try {
    const response = await input.send();
    await save({ ...reserved, status: 'succeeded' });
    return response;
  } catch (error: any) {
    await save({ ...reserved, status: 'failed', failureReason: error?.message || String(error) });
    throw error;
  }
}

export function getV0UsageCountForScope(input: { userId: string; scopeId: string }): number {
  let count = 0;
  for (const record of memoryUsage.values()) {
    if (record.userId === input.userId && record.scopeId === input.scopeId && record.status === 'succeeded') {
      count += 1;
    }
  }
  return count;
}

export function _resetV0UsageGuardForTest(): void {
  memoryUsage.clear();
}
