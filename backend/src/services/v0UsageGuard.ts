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
const RESERVED_LOCK_TTL_MS = 30 * 60 * 1000;

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
  return [
    input.operation,
    input.userId,
    input.scopeId,
    input.slug || '',
    input.chatId || '',
  ].join('#');
}

function isFreshReserved(record: V0UsageRecord, nowMs = Date.now()): boolean {
  if (record.status !== 'reserved') return false;
  const updatedAtMs = new Date(record.updatedAt || record.createdAt).getTime();
  if (!Number.isFinite(updatedAtMs)) return true;
  return nowMs - updatedAtMs < RESERVED_LOCK_TTL_MS;
}

async function bestEffortPut(
  record: V0UsageRecord,
  condition?: string,
  expressionAttributeNames?: Record<string, string>,
  expressionAttributeValues?: Record<string, any>
): Promise<boolean> {
  if (!persistenceEnabled()) return true;
  try {
    await dynamodb.put({
      TableName: TABLE_NAME,
      Item: record,
      ...(condition ? { ConditionExpression: condition } : {}),
      ...(expressionAttributeNames ? { ExpressionAttributeNames: expressionAttributeNames } : {}),
      ...(expressionAttributeValues ? { ExpressionAttributeValues: expressionAttributeValues } : {}),
    }).promise();
    return true;
  } catch (error: any) {
    if (error?.code === 'ConditionalCheckFailedException') return false;
    console.warn('[V0_USAGE] Persistence skipped:', error?.message || error);
    return true;
  }
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
  if (existing && isFreshReserved(existing)) {
    throw new Error('A v0 generation with the same idempotency key is already in flight.');
  }

  const now = new Date().toISOString();
  const staleBefore = new Date(Date.now() - RESERVED_LOCK_TTL_MS).toISOString();
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
  const reservedInDynamo = await bestEffortPut(
    reserved,
    'attribute_not_exists(idempotencyKey) OR #status <> :reserved OR updatedAt < :staleBefore',
    { '#status': 'status' },
    { ':reserved': 'reserved', ':staleBefore': staleBefore }
  );
  if (!reservedInDynamo) {
    const latest = await bestEffortGet(idempotencyKey);
    if (latest) memoryUsage.set(idempotencyKey, latest);
    else memoryUsage.delete(idempotencyKey);
    if (latest?.chatId && latest.status === 'succeeded') return { id: latest.chatId, reused: true };
    throw new Error('A v0 generation with the same idempotency key is already in flight.');
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

  const now = new Date().toISOString();
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
  const reservedInDynamo = await bestEffortPut(reserved, 'attribute_not_exists(idempotencyKey)');
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
