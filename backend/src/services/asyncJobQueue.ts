import AWS from 'aws-sdk';
import dotenv from 'dotenv';
import path from 'path';

/**
 * Generic crash-safety net for a webhook receiver's fire-and-forget processing
 * (ENG-524 fast-follow, Greptile P1). One table for every integration —
 * discriminated by `source`, not one table per integration — so a new integration
 * costs a registered processor function, never a schema change.
 *
 * enqueueJob fails OPEN: any write failure, including the table not existing yet
 * (it's provisioned by a manual script, not the deploy pipeline — see
 * scripts/create-tables.ts), returns 'unavailable' rather than throwing, so a
 * caller can always fall back to processing inline exactly as it did before this
 * queue existed. Durability activates automatically the moment the table exists;
 * nothing needs to be redeployed or coordinated.
 */

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const TABLE_PREFIX = process.env.NODE_ENV === 'development' ? 'Dev-' : '';

AWS.config.update({
  region: process.env.AWS_REGION || 'us-west-2',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
  },
});

const dynamodb = new AWS.DynamoDB.DocumentClient();
const TABLE_NAME = `${TABLE_PREFIX}AW-AsyncJobQueue`;

const MAX_ATTEMPTS = 5;
// A claimed ('processing') job whose updatedAt is older than this is treated as
// abandoned (the instance that claimed it crashed mid-attempt) and re-claimable.
const STALE_PROCESSING_MS = 5 * 60 * 1000;

export type EnqueueResult = 'enqueued' | 'duplicate' | 'unavailable';

interface AsyncJobRecord {
  id: string;
  source: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  payload: string;
  attempts: number;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

function jobId(source: string, dedupeKey: string): string {
  return `${source}_${dedupeKey}`;
}

export async function enqueueJob(source: string, dedupeKey: string, payload: unknown): Promise<EnqueueResult> {
  const id = jobId(source, dedupeKey);
  const now = new Date().toISOString();
  try {
    await dynamodb
      .put({
        TableName: TABLE_NAME,
        ConditionExpression: 'attribute_not_exists(id)',
        Item: {
          id,
          source,
          status: 'pending',
          payload: JSON.stringify(payload),
          attempts: 0,
          createdAt: now,
          updatedAt: now,
        },
      })
      .promise();
    return 'enqueued';
  } catch (error: any) {
    if (error?.code === 'ConditionalCheckFailedException') {
      return 'duplicate';
    }
    console.warn(`[AsyncJobQueue] enqueue unavailable for ${id}:`, error?.message ?? error);
    return 'unavailable';
  }
}

export async function markJobComplete(source: string, dedupeKey: string): Promise<void> {
  const id = jobId(source, dedupeKey);
  try {
    await dynamodb
      .update({
        TableName: TABLE_NAME,
        Key: { id },
        UpdateExpression: 'SET #status = :completed, updatedAt = :now',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':completed': 'completed', ':now': new Date().toISOString() },
      })
      .promise();
  } catch (error: any) {
    // Best-effort — if this fails, the poller will eventually re-claim and
    // re-process the job (safe, since processing is idempotent), not silently lose it.
    console.warn(`[AsyncJobQueue] markJobComplete failed for ${id} (best-effort):`, error?.message ?? error);
  }
}

export async function markJobFailed(source: string, dedupeKey: string, error: unknown): Promise<void> {
  const id = jobId(source, dedupeKey);
  const message = error instanceof Error ? error.message : String(error);
  try {
    const existing = await dynamodb.get({ TableName: TABLE_NAME, Key: { id } }).promise();
    const attempts = ((existing.Item as any)?.attempts ?? 0) + 1;
    const nextStatus = attempts >= MAX_ATTEMPTS ? 'failed' : 'pending';
    await dynamodb
      .update({
        TableName: TABLE_NAME,
        Key: { id },
        UpdateExpression: 'SET #status = :status, attempts = :attempts, lastError = :lastError, updatedAt = :now',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':status': nextStatus,
          ':attempts': attempts,
          ':lastError': message,
          ':now': new Date().toISOString(),
        },
      })
      .promise();
  } catch (err: any) {
    console.warn(`[AsyncJobQueue] markJobFailed failed for ${id} (best-effort):`, err?.message ?? err);
  }
}

type JobProcessor = (payload: any) => Promise<void>;
const processors = new Map<string, JobProcessor>();

/** Populated once per process at module-load time by each integration — mirrors how
 *  server.ts's cron jobs are each set up once, not a runtime registration API. */
export function registerProcessor(source: string, handler: JobProcessor): void {
  processors.set(source, handler);
}

async function claimJob(job: AsyncJobRecord): Promise<boolean> {
  try {
    await dynamodb
      .update({
        TableName: TABLE_NAME,
        Key: { id: job.id },
        // Optimistic lock on the updatedAt we just read: only claim if nothing else
        // has touched this job since. Whether it came from the pending leg or the
        // stale-processing leg of the poll query, this condition is what actually
        // prevents two instances' pollers from both claiming the same job.
        ConditionExpression: 'updatedAt = :expectedUpdatedAt',
        UpdateExpression: 'SET #status = :processing, updatedAt = :now',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':expectedUpdatedAt': job.updatedAt,
          ':processing': 'processing',
          ':now': new Date().toISOString(),
        },
      })
      .promise();
    return true;
  } catch (error: any) {
    // Lost the claim race to another instance — not an error, just skip it.
    return false;
  }
}

async function processClaimedJob(job: AsyncJobRecord): Promise<void> {
  const processor = processors.get(job.source);
  if (!processor) {
    console.warn(`[AsyncJobQueue] No processor registered for source "${job.source}" — leaving job ${job.id} claimed but unprocessed`);
    return;
  }

  try {
    const payload = JSON.parse(job.payload);
    await processor(payload);
    await dynamodb
      .update({
        TableName: TABLE_NAME,
        Key: { id: job.id },
        UpdateExpression: 'SET #status = :completed, updatedAt = :now',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':completed': 'completed', ':now': new Date().toISOString() },
      })
      .promise();
  } catch (error: any) {
    const attempts = (job.attempts ?? 0) + 1;
    const nextStatus = attempts >= MAX_ATTEMPTS ? 'failed' : 'pending';
    await dynamodb
      .update({
        TableName: TABLE_NAME,
        Key: { id: job.id },
        UpdateExpression: 'SET #status = :status, attempts = :attempts, lastError = :lastError, updatedAt = :now',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':status': nextStatus,
          ':attempts': attempts,
          ':lastError': error?.message ?? String(error),
          ':now': new Date().toISOString(),
        },
      })
      .promise()
      .catch(() => {});
    console.error(`[AsyncJobQueue] Processing failed for job ${job.id} (source=${job.source}, attempt ${attempts}):`, error?.message ?? error);
  }
}

/** One poll tick: find claimable jobs (pending, or processing but abandoned), claim
 *  and process each. Exported so server.ts can wire it into the existing cron pattern. */
export async function pollAndProcessOnce(): Promise<void> {
  let claimable: AsyncJobRecord[] = [];
  try {
    const pendingResult = await dynamodb
      .query({
        TableName: TABLE_NAME,
        IndexName: 'StatusCreatedAtIndex',
        KeyConditionExpression: '#status = :pending',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':pending': 'pending' },
      })
      .promise();

    const staleThreshold = new Date(Date.now() - STALE_PROCESSING_MS).toISOString();
    const staleResult = await dynamodb
      .query({
        TableName: TABLE_NAME,
        IndexName: 'StatusCreatedAtIndex',
        KeyConditionExpression: '#status = :processing',
        FilterExpression: 'updatedAt < :staleThreshold',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':processing': 'processing', ':staleThreshold': staleThreshold },
      })
      .promise();

    claimable = [...((pendingResult.Items as AsyncJobRecord[]) ?? []), ...((staleResult.Items as AsyncJobRecord[]) ?? [])];
  } catch (error: any) {
    // Table missing/unreachable — nothing to poll yet. Not worth logging loudly on
    // every tick before the table has even been provisioned.
    return;
  }

  for (const job of claimable) {
    const claimed = await claimJob(job);
    if (claimed) {
      await processClaimedJob(job);
    }
  }
}
