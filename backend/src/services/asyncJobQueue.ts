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
 *
 * ── Why a stale-reclamation race here can never cause duplicate side effects ──
 * (Greptile P1 on #2291, rounds 9/17/24 — restated across several rounds as "can
 * still allow concurrent processing." This is the full argument in one place,
 * since the individual pieces landed in separate commits over many rounds.)
 *
 * The heartbeat (startHeartbeat/startHeartbeatForId below) keeps a claimed job's
 * updatedAt fresh so the stale-reclamation query in pollAndProcessOnce doesn't
 * mistake still-active work for an abandoned claim. For that race to fire at all,
 * EVERY heartbeat tick across the full STALE_PROCESSING_MS window has to fail
 * both its attempt and its retry (see HEARTBEAT_INTERVAL_MS below for exactly how
 * many independent chances that is) — already a compound, low-probability event.
 *
 * But even if it DOES fire — two instances genuinely processing the same booking
 * concurrently — every actual external side effect downstream is independently
 * idempotent, not just this heartbeat:
 *   - Lead creation: a deterministic (listId, email)-derived id + a fail-if-exists
 *     conditional put (calendlyWebhook.ts, round 19, mirroring the same pattern
 *     ENG-787 already proved for linkedInInviteCrmMirror.ts) — two concurrent
 *     creates for a brand-new lead collide on the same DynamoDB item; the loser
 *     adopts the winner's lead instead of spawning a duplicate.
 *   - HubSpot sync, Attio sync, and the customer alert: each gated behind
 *     crmDb.claimLeadStepOnce (db.ts, round 15) — an actual DynamoDB conditional-
 *     write mutex, not a probability reduction — so only ONE of two concurrent
 *     claimants can ever perform the real side effect. Losing that claim now
 *     FAILS the job too (round 18), so a retry always re-checks rather than
 *     silently assuming "someone else has it."
 *   - Meta CAPI attribution: deduped by Meta's own event_id collapsing on their
 *     side (the invitee URI is passed straight through as eventId) — documented
 *     in calendlyWebhook.ts's own header comment, independent of anything here.
 *
 * So the honest worst case if this race ever fires: one wasted retry cycle
 * (`markJobComplete`/`markJobFailed` racing on which lands last just means a
 * later poll re-verifies already-complete work and finds every marker already
 * set — see the "does not clobber concurrent state" tests in
 * calendlyWebhook.test.ts). Not data loss, not a duplicate lead, not a duplicate
 * customer-facing notification.
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
// Greptile P1 on #2291 (round 24): for the stale-reclamation query to ever
// mistake a still-active job for an abandoned one, EVERY heartbeat tick across
// the whole STALE_PROCESSING_MS window must fail both its attempt and its
// retry. At the previous 60s interval that's 5 ticks x 2 attempts = 10
// independent write failures in a row; at 15s it's 20 ticks x 2 = 40 — the same
// underlying per-write reliability now needs to fail four times as many
// consecutive times before the race can even become possible. Cheap to lower
// further (still well under STALE_PROCESSING_MS, still one DynamoDB write per
// tick), and worth doing since the actual consequence even IF this race did
// fire is already fully absorbed by claimLeadStepOnce + the lost-claim-fails-
// the-job fix (rounds 15/18) — this interval is pure additional margin on top
// of a state that's already safe, not the last line of defense.
const HEARTBEAT_INTERVAL_MS = 15 * 1000;

/** Small delay helper — only used by updateJobPayload's backoff below (matching
 *  calendlyWebhookCleanupQueue.ts's recordOrphanedCalendlyWebhook), injectable so
 *  tests never actually sleep. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
 * Overwrites a durable job's stored payload — for a processor that discovers,
 * mid-attempt, that part of its own input has changed in a way future retries
 * need to know about (Greptile P1 on #2291, round 20): Calendly's cleanup-retry
 * job may refresh an OAuth token that Calendly rotates on every use. If that
 * refresh succeeds but the actual cleanup call then fails for an unrelated
 * reason, the NEXT retry re-reads the ORIGINAL enqueue-time payload — which
 * still has the now-invalid pre-rotation token — and can never successfully
 * refresh again. For a job registered with maxAttempts: Infinity this isn't
 * just a wasted attempt, it's an infinite loop that can never make progress.
 *
 * Greptile P1 on #2291 (round 21): the first version of this was best-effort
 * with NO retry — every sibling write in this file (markJobComplete,
 * markJobFailed, the heartbeat beat) retries once before giving up, and this
 * one didn't, purely an oversight. A transient write blip here is exactly
 * what those retries exist to absorb. If BOTH attempts still fail, this is
 * the last point where "the stored refresh token is about to become
 * permanently unusable" is observable anywhere — console.error, not warn, so
 * it's actionable in production monitoring rather than silently lost.
 */
// Greptile P1 on #2291 (third pass): returns whether the write actually landed —
// this used to be void, so a caller persisting something irrecoverable-if-lost (e.g.
// connectedAccounts.ts persisting a rotated Calendly refresh token before the old one
// becomes permanently invalid) had no way to know whether it needs a DIFFERENT
// fallback when this best-effort write fails. Still never throws — callers that don't
// care about the outcome can keep ignoring the return value exactly as before.
//
// Greptile P1 on #2291 (fourth pass): a single retry (2 total attempts) was weaker
// than the caller's OTHER durable write for the same rotated-token scenario
// (recordOrphanedCalendlyWebhook already had a 3-attempt backoff, round 23) — bumped
// to match, since a payload that fails to persist here means every future retry of
// the job that owns it reloads a stale, invalidated Calendly refresh token and can
// never succeed. This is the ONLY store connectedAccounts.ts's rotation-persistence
// still relies on for jobs claimed via the poller (not claimImmediately), so it's
// worth the same latency-tolerant backoff as the orphan-table fallback (this path is
// never latency-sensitive — it runs from the poller's background retry, not inline).
export async function updateJobPayload(source: string, dedupeKey: string, payload: unknown): Promise<boolean> {
  const id = jobId(source, dedupeKey);
  const writePayload = () =>
    dynamodb
      .update({
        TableName: TABLE_NAME,
        Key: { id },
        UpdateExpression: 'SET payload = :payload, updatedAt = :now',
        ExpressionAttributeValues: { ':payload': JSON.stringify(payload), ':now': new Date().toISOString() },
      })
      .promise();

  const backoffMs = [0, 200, 600];
  for (let attempt = 0; attempt < backoffMs.length; attempt++) {
    if (backoffMs[attempt] > 0) await delay(backoffMs[attempt]);
    try {
      await writePayload();
      return true;
    } catch (err: any) {
      if (attempt === backoffMs.length - 1) {
        console.error(`[AsyncJobQueue] updateJobPayload failed for ${id} after ${backoffMs.length} attempts — future retries will use the stale payload:`, err?.message ?? err);
      }
    }
  }
  return false;
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
    //
    // Greptile P1 on #2291 (fourth pass): a double-failure here used to be swallowed
    // silently — every OTHER write in this file (markJobComplete, markJobFailed,
    // updateJobPayload, the failure-state write) logs loudly on double-failure; this
    // one didn't, purely an inconsistency. This doesn't change the underlying
    // accepted-and-bounded race (see the module doc-comment above — claimLeadStepOnce
    // is the actual mutex preventing a duplicate side effect even if this job gets
    // concurrently reclaimed), but sustained heartbeat failures are exactly the
    // precondition for that race, so they deserve to be visible rather than silent.
    beat().catch(() =>
      beat().catch((err: any) => {
        console.warn(`[AsyncJobQueue] Heartbeat failed twice in a row for job ${id} — if this persists past the staleness window, the poller may reclaim and concurrently reprocess this job:`, err?.message ?? err);
      }),
    );
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
    const writeFailureState = () =>
      dynamodb
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
        .promise();
    try {
      await writeFailureState();
    } catch (firstError: any) {
      // Greptile P1 on #2291 (round 25): this used to be a bare
      // `.promise().catch(() => {})` with zero retry — every sibling write in
      // this file (markJobComplete, markJobFailed, updateJobPayload) already
      // retries once before giving up. Losing this specific write is worse
      // than those: the job is left stuck in 'processing' with its attempt
      // count never advanced, so stale reclamation (STALE_PROCESSING_MS
      // later) picks it back up as if this attempt never happened — re-running
      // a finite-attempts job's side effects more times than its own
      // maxAttempts configuration allows.
      try {
        await writeFailureState();
      } catch (secondError: any) {
        console.error(
          `[AsyncJobQueue] LOST failure-state write for job ${job.id} after retry — job remains 'processing' and will be re-run via stale reclamation, potentially exceeding maxAttempts:`,
          secondError?.message ?? secondError,
        );
      }
    }
    console.error(`[AsyncJobQueue] Processing failed for job ${job.id} (source=${job.source}, attempt ${attempts}):`, error?.message ?? error);
    if (nextStatus === 'failed') {
      // ENG-992: a job that exhausts its attempts used to just blend into the
      // same "Processing failed" line above every other retry logs — nothing
      // distinguished the terminal attempt from the 4 before it, so a
      // permanently-stuck job (as opposed to a still-retrying one) had no way
      // to surface itself for a human to notice. This line is deliberately
      // distinct and greppable.
      console.error(`[AsyncJobQueue] TERMINAL FAILURE: job ${job.id} (source=${job.source}) exhausted all ${attempts} attempts and will not be retried again.`);
    }
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
