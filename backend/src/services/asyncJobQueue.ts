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
// Well under STALE_PROCESSING_MS so even one missed beat leaves comfortable margin.
const HEARTBEAT_INTERVAL_MS = 60 * 1000;

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

/** `claimImmediately`: the common case, a caller about to process this job inline
 *  in the same request that enqueued it. Writes status='processing' directly in
 *  the SAME put as the enqueue — one atomic call, not enqueue-then-claim — so
 *  there is no window where the row is 'pending' and claimable by the poller,
 *  and no separate claim write that can fail independently of the enqueue
 *  (a prior two-call version of this had exactly that gap: if the claim update
 *  failed after a successful enqueue, the poller could still claim and re-run
 *  the job concurrently with inline processing). Omit it only for a producer
 *  that is not about to process the job itself — there are no such callers yet. */
export async function enqueueJob(
  source: string,
  dedupeKey: string,
  payload: unknown,
  options?: { claimImmediately?: boolean },
): Promise<EnqueueResult> {
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
          status: options?.claimImmediately ? 'processing' : 'pending',
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
  const writeCompleted = () =>
    dynamodb
      .update({
        TableName: TABLE_NAME,
        Key: { id },
        UpdateExpression: 'SET #status = :completed, updatedAt = :now',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':completed': 'completed', ':now': new Date().toISOString() },
      })
      .promise();

  try {
    await writeCompleted();
  } catch (firstError: any) {
    // One immediate retry before falling back to stale-reclamation — a transient
    // write failure (throttling, a brief network blip) is exactly the case a
    // single retry resolves, and every extra successful job here is one the
    // poller never needs to re-claim at all (processing is idempotent per-step
    // even if it does, but avoiding it outright is strictly better: no wasted
    // re-run, no ~5 minute delay before that re-run happens).
    try {
      await writeCompleted();
    } catch (secondError: any) {
      // Still best-effort — if this fails, the poller will eventually re-claim and
      // re-process the job (safe, since processing is idempotent), not silently lose it.
      console.warn(`[AsyncJobQueue] markJobComplete failed for ${id} after retry (best-effort):`, secondError?.message ?? secondError);
    }
  }
}

export async function markJobFailed(source: string, dedupeKey: string, error: unknown): Promise<void> {
  const id = jobId(source, dedupeKey);
  const message = error instanceof Error ? error.message : String(error);

  const writeFailedState = async () => {
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
  };

  try {
    await writeFailedState();
  } catch (firstErr: any) {
    // One immediate retry before falling back to stale-reclamation — same
    // reasoning as markJobComplete's retry: a transient write failure here would
    // otherwise leave a genuinely-failed job stuck in 'processing' until the
    // 5-minute staleness window, delaying its retry for no reason.
    try {
      await writeFailedState();
    } catch (secondErr: any) {
      console.warn(`[AsyncJobQueue] markJobFailed failed for ${id} after retry (best-effort):`, secondErr?.message ?? secondErr);
    }
  }
}

/**
 * Keeps a claimed job's updatedAt fresh while it's genuinely still being
 * processed inline, so the poller's stale-reclamation query never mistakes
 * still-active work for an abandoned claim (Greptile P1 on #2291): without
 * this, inline processing that happens to run longer than
 * STALE_PROCESSING_MS looked identical — to that query — to a claim whose
 * owning instance crashed, and the poller would claim and re-run it
 * concurrently with the still-running original.
 *
 * Call right after a successful claimImmediately enqueue; call the returned
 * stop function in a `finally` block once processing settles (success or
 * failure), before markJobComplete/markJobFailed. Best-effort and
 * conditional on the job still being 'processing' — a missed beat just
 * means the prior (pre-heartbeat) race window reopens for that one tick,
 * never a new failure mode, and the condition means a tick that fires after
 * the job already completed is a safe no-op rather than clobbering state.
 */
function startHeartbeatForId(id: string): () => void {
  const beat = () =>
    dynamodb
      .update({
        TableName: TABLE_NAME,
        Key: { id },
        ConditionExpression: '#status = :processing',
        UpdateExpression: 'SET updatedAt = :now',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':processing': 'processing', ':now': new Date().toISOString() },
      })
      .promise();

  const interval = setInterval(() => {
    // One immediate retry on failure, same reasoning as markJobComplete/markJobFailed
    // — a transient write blip is exactly what a retry resolves, and each tick that
    // actually lands is one the next tick doesn't need to compensate for.
    beat().catch(() => beat().catch(() => {}));
  }, HEARTBEAT_INTERVAL_MS);
  return () => clearInterval(interval);
}

export function startHeartbeat(source: string, dedupeKey: string): () => void {
  return startHeartbeatForId(jobId(source, dedupeKey));
}

type JobProcessor = (payload: any) => Promise<void>;
const processors = new Map<string, JobProcessor>();
const maxAttemptsBySource = new Map<string, number>();

/** Populated once per process at module-load time by each integration — mirrors how
 *  server.ts's cron jobs are each set up once, not a runtime registration API.
 *
 *  `maxAttempts` (default MAX_ATTEMPTS) overrides how many failed attempts this
 *  source gets before a job goes terminally 'failed' and stops being claimable.
 *  Greptile P1 on #2291 (round 9, issue 3): calendly_webhook_cleanup enqueues the
 *  ONLY remaining durable copy of a webhook_id right before the local account
 *  record holding the other copy gets deleted. Once that job hit the shared
 *  5-attempt cap it went 'failed' and was never retried again — silently and
 *  permanently stranding the orphaned subscription, since there is nowhere left
 *  to recover its id from. Pass `maxAttempts: Infinity` for a source whose
 *  failure mode is "the outage/expired-token will eventually clear" rather than
 *  "a human needs to intervene" — it just keeps retrying instead of ever going
 *  terminally inert. */
export function registerProcessor(source: string, handler: JobProcessor, options?: { maxAttempts?: number }): void {
  processors.set(source, handler);
  if (options?.maxAttempts !== undefined) {
    maxAttemptsBySource.set(source, options.maxAttempts);
  }
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

  // Greptile P1 on #2291 (round 9): startHeartbeat was only ever wired into the
  // claimImmediately/inline path. A job the poller itself claims went through
  // this function with no heartbeat, so a poller-owned job running longer than
  // STALE_PROCESSING_MS was indistinguishable from an abandoned claim and got
  // reclaimed and re-run concurrently — the same race the inline heartbeat
  // exists to close, just reopened on this path.
  const stopHeartbeat = startHeartbeatForId(job.id);
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
    const maxAttempts = maxAttemptsBySource.get(job.source) ?? MAX_ATTEMPTS;
    const nextStatus = attempts >= maxAttempts ? 'failed' : 'pending';
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
  } finally {
    stopHeartbeat();
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
