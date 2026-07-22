/**
 * runStore — durable run records and idempotency submit-locks on ONE
 * DynamoDB table (AW-AgentRuns). The run-survival core for
 * ENG-40 / ENG-147 / ENG-145 / ENG-146.
 *
 * Item kinds (single `pk` hash key):
 *   run#<runId>       — durable run record {kind, sessionId, scheduleId?,
 *                        userId, status: running|interrupted|completed|failed,
 *                        startedAt, finishedAt?, finishReason?, ledgerSummary?,
 *                        ttl 30d}
 *   idem#<key>        — idempotency submit-lock, conditional put. Interactive
 *                        key = sha256(sessionId+userMessage+llmModel), ttl 10m.
 *                        Scheduled key = sha256(scheduleId+fireTime), ttl 24h.
 *                        The in-memory activeSessionGenerations Set stays as
 *                        the in-process concurrency guard — this item is the
 *                        cross-restart / cross-retry dedupe. Same concept, two
 *                        enforcement points.
 *
 * Config gate: the whole store is behind AGENT_RUN_STORE=true (an A-or-B
 * migration switch — flag absent = feature off; NOT an on-error fallback).
 * Callers check isRunStoreEnabled() before calling in.
 *
 * Failure policy (NO hidden fallbacks):
 *   - createRunRecord / claimIdempotency THROW on real DynamoDB failures —
 *     run-record creation is core state and the caller aborts the request
 *     loudly.
 *   - markRunTerminal is the one sanctioned best-effort step: a terminal
 *     status update cannot retro-fail a chat that was already delivered, so
 *     it retries once and then fires a single deduped oncall alert. It is
 *     conditioned on the run record existing (attribute_exists(pk)) — if
 *     createRunRecord threw, the caller's outer catch still fires
 *     markRunTerminal, and without the condition update() would UPSERT a
 *     phantom run#<id> item with no ttl. Condition failure = documented
 *     no-op (nothing to mark).
 *   - releaseIdempotency is best-effort: on delete failure the lock's
 *     staleness is bounded by its ttl WINDOW — not by DynamoDB's TTL reaper
 *     (which is eventual, minutes to hours) but by claimIdempotency itself,
 *     whose conditional put treats an expired-but-unreaped item as absent.
 */
import AWS from 'aws-sdk';
import crypto from 'crypto';

const TABLE_PREFIX = process.env.NODE_ENV === 'development' ? 'Dev-' : '';
export const AGENT_RUNS_TABLE = `${TABLE_PREFIX}AW-AgentRuns`;

/** Idempotency lock TTLs (seconds). */
export const IDEM_TTL_INTERACTIVE_S = 600; // 10 minutes
export const IDEM_TTL_SCHEDULED_S = 24 * 3600; // 24 hours

const RUN_RECORD_TTL_S = 30 * 24 * 3600; // 30 days

export type AgentRunKind = 'interactive' | 'scheduled' | 'test';
export type AgentRunTerminalStatus = 'interrupted' | 'completed' | 'failed';

export interface LedgerSummary {
  invoked: number;
  succeeded: number;
  failed: number;
}

export interface CreateRunRecordParams {
  runId: string;
  kind: AgentRunKind;
  sessionId: string;
  userId: string;
  scheduleId?: string;
  traceId?: string;
}

export type IdempotencyClaim =
  | { claimed: true }
  | { claimed: false; inFlightRunId?: string; sessionId?: string };

/** The run store is a config-gated feature: env flag absent = OFF. */
export function isRunStoreEnabled(): boolean {
  return process.env.AGENT_RUN_STORE === 'true';
}

let documentClient: AWS.DynamoDB.DocumentClient | null = null;

function getClient(): AWS.DynamoDB.DocumentClient {
  if (!documentClient) {
    documentClient = new AWS.DynamoDB.DocumentClient({
      region: process.env.AWS_REGION || 'us-west-2',
      httpOptions: { timeout: 10_000, connectTimeout: 3_000 },
    });
  }
  return documentClient;
}

/** Test seam: inject a DocumentClient fake. Pass null to restore the default. */
export function __setDocumentClientForTests(client: AWS.DynamoDB.DocumentClient | null): void {
  documentClient = client;
}

function nowEpochS(): number {
  return Math.floor(Date.now() / 1000);
}

function isConditionalCheckFailed(err: any): boolean {
  return err?.code === 'ConditionalCheckFailedException' || err?.name === 'ConditionalCheckFailedException';
}

/** Interactive submit-lock key: identical resubmits of the same message dedupe. */
export function interactiveIdempotencyKey(sessionId: string, userMessage: string, llmModel: string): string {
  return crypto.createHash('sha256').update(`${sessionId}|${userMessage}|${llmModel}`).digest('hex');
}

/** Scheduled submit-lock key: one run per (schedule, fire window). */
export function scheduledIdempotencyKey(scheduleId: string, fireTime: string): string {
  return crypto.createHash('sha256').update(`${scheduleId}|${fireTime}`).digest('hex');
}

/**
 * Session-creation submit-lock key (the exact ENG-147 storm seam: one client
 * "send" retried into ~30 create-session calls). Scoped by userId so one
 * user's client key can never attach another user to their session.
 */
export function createSessionIdempotencyKey(userId: string, clientKey: string): string {
  return crypto.createHash('sha256').update(`create-session|${userId}|${clientKey}`).digest('hex');
}

/**
 * Create the durable run record at intake. THROWS on failure — run-record
 * creation is core state (dedupe and interruption disclosure would lie
 * without it), so the caller must abort the request loudly.
 */
export async function createRunRecord(p: CreateRunRecordParams): Promise<void> {
  await getClient()
    .put({
      TableName: AGENT_RUNS_TABLE,
      Item: {
        pk: `run#${p.runId}`,
        runId: p.runId,
        kind: p.kind,
        sessionId: p.sessionId,
        userId: p.userId,
        ...(p.scheduleId ? { scheduleId: p.scheduleId } : {}),
        ...(p.traceId ? { traceId: p.traceId } : {}),
        status: 'running',
        startedAt: new Date().toISOString(),
        ttl: nowEpochS() + RUN_RECORD_TTL_S,
      },
    })
    .promise();
}

/**
 * Mark a run terminal (completed / failed / interrupted).
 *
 * Best-effort BY DESIGN (documented at every call site): a terminal-update
 * failure cannot retro-fail a chat that was already delivered to the user.
 * Retries once; if the retry also fails, fires ONE deduped oncall alert and
 * returns. Never throws.
 *
 * NEVER upserts: the update is conditioned on the run record existing. If
 * createRunRecord threw (the documented loud-500 path), the controller's
 * outer catch still fires `void markRunTerminal(runId, 'failed')` — the
 * condition makes that a no-op instead of writing a phantom run#<id> item
 * with only status/finishedAt and NO ttl (which would never expire).
 */
export async function markRunTerminal(
  runId: string,
  status: AgentRunTerminalStatus,
  extra?: { finishReason?: string; ledgerSummary?: LedgerSummary }
): Promise<void> {
  const update = () =>
    getClient()
      .update({
        TableName: AGENT_RUNS_TABLE,
        Key: { pk: `run#${runId}` },
        // No upsert: only mark runs that were actually created (see doc above).
        ConditionExpression: 'attribute_exists(pk)',
        UpdateExpression:
          'SET #status = :status, finishedAt = :finishedAt' +
          (extra?.finishReason ? ', finishReason = :finishReason' : '') +
          (extra?.ledgerSummary ? ', ledgerSummary = :ledgerSummary' : ''),
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':status': status,
          ':finishedAt': new Date().toISOString(),
          ...(extra?.finishReason ? { ':finishReason': extra.finishReason } : {}),
          ...(extra?.ledgerSummary ? { ':ledgerSummary': extra.ledgerSummary } : {}),
        },
      })
      .promise();

  try {
    await update();
    return;
  } catch (firstErr) {
    if (isConditionalCheckFailed(firstErr)) {
      // Documented no-op: the run record was never created (createRunRecord
      // threw before intake completed), so there is nothing to mark — and we
      // must not upsert a ttl-less phantom record. No retry, no alert.
      console.warn(`[runStore] markRunTerminal(${runId}, ${status}) no-op — run record does not exist`);
      return;
    }
    console.error(`[runStore] markRunTerminal(${runId}, ${status}) failed — retrying once:`, firstErr);
  }

  try {
    await update();
  } catch (secondErr) {
    if (isConditionalCheckFailed(secondErr)) {
      console.warn(`[runStore] markRunTerminal(${runId}, ${status}) no-op — run record does not exist`);
      return;
    }
    console.error(`[runStore] markRunTerminal(${runId}, ${status}) failed after retry:`, secondErr);
    try {
      // Dynamic import keeps this module light and avoids a load-time cycle
      // (agentModeAlerts -> chatbotService).
      const { sendAgentModeOncallAlert } = await import('../../utils/agentModeAlerts');
      // Accepted trade-off: the dedupeKey is scoped to the TABLE, not the
      // runId — oncall gets ONE alert per store per window even if a systemic
      // DynamoDB failure leaves dozens of runs stale. Per-run keys would flood
      // oncall during exactly that brownout; the alert signals the failure
      // CLASS, and the per-run detail lives in the console.error above (one
      // line per affected run, greppable by "markRunTerminal").
      await sendAgentModeOncallAlert({
        subject: 'Agent run store: terminal status update failed',
        message:
          `Failed to mark run ${runId} as ${status} in ${AGENT_RUNS_TABLE} after one retry. ` +
          `The run's durable record is stale until its ttl expires.\n\n` +
          `NOTE: this alert is deduped per table — further terminal-update failures in the next ` +
          `hour are suppressed. Check server logs ("[runStore] markRunTerminal") for the full ` +
          `list of affected runs.\n\nError: ${(secondErr as Error)?.message}`,
        dedupeKey: `run_store:terminal_update_failed:${AGENT_RUNS_TABLE}`,
        dedupeWindowMs: 60 * 60 * 1000,
        context: { 'Run ID': runId, 'Intended Status': status },
      });
    } catch (alertErr) {
      console.error('[runStore] markRunTerminal alert failed:', alertErr);
    }
  }
}

/**
 * Claim the idempotency submit-lock. Conditional put — exactly one claimant
 * wins per key. Losers get the in-flight runId (for the 409 body). THROWS on
 * real DynamoDB failures (same core-state policy as createRunRecord).
 */
export async function claimIdempotency(key: string, runId: string, ttlSeconds: number): Promise<IdempotencyClaim> {
  const pk = `idem#${key}`;
  const now = nowEpochS();
  try {
    await getClient()
      .put({
        TableName: AGENT_RUNS_TABLE,
        Item: { pk, runId, ttl: now + ttlSeconds },
        // DynamoDB native TTL deletion is EVENTUAL (minutes to hours of reaper
        // lag) — an expired item still exists at this pk. Tolerating it here
        // (`OR #ttl < :now`) is what actually bounds a leaked lock's staleness
        // to the ttl window; relying on the reaper would not.
        ConditionExpression: 'attribute_not_exists(pk) OR #ttl < :now',
        ExpressionAttributeNames: { '#ttl': 'ttl' },
        ExpressionAttributeValues: { ':now': now },
      })
      .promise();
    return { claimed: true };
  } catch (err) {
    if (!isConditionalCheckFailed(err)) throw err;
    // Best-effort read of the winner's runId (for the 409 body) and — on the
    // session-creation lane — the winner's sessionId so the loser can attach.
    // ConsistentRead: the put just lost against this item; an eventually
    // consistent read could miss the winner's stamped sessionId and turn an
    // attachable duplicate into a spurious 409.
    try {
      const existing = await getClient()
        .get({ TableName: AGENT_RUNS_TABLE, Key: { pk }, ConsistentRead: true })
        .promise();
      const item = existing.Item;
      if (!item || (typeof item.ttl === 'number' && item.ttl < nowEpochS())) {
        // Expired in the race window between the put and this read — stale
        // data; expose nothing. The caller 409s and the client's retry wins.
        return { claimed: false };
      }
      return {
        claimed: false,
        inFlightRunId: item.runId,
        ...(item.sessionId ? { sessionId: item.sessionId } : {}),
      };
    } catch {
      return { claimed: false };
    }
  }
}

/**
 * Session-creation lane: after the claim winner creates the session, stamp its
 * sessionId on the idem item so duplicate losers ATTACH to that session
 * instead of getting a bare busy response. Best-effort BY DESIGN: on failure
 * the losers keep getting 409 until the item's ttl bounds the staleness —
 * never upserts a phantom idem item, never throws.
 */
export async function recordIdempotencySessionId(key: string, sessionId: string): Promise<void> {
  try {
    await getClient()
      .update({
        TableName: AGENT_RUNS_TABLE,
        Key: { pk: `idem#${key}` },
        // No upsert: only stamp claims that actually exist (released/expired
        // claims must not resurrect as phantom un-TTLed items).
        ConditionExpression: 'attribute_exists(pk)',
        UpdateExpression: 'SET sessionId = :sessionId',
        ExpressionAttributeValues: { ':sessionId': sessionId },
      })
      .promise();
  } catch (err) {
    if (isConditionalCheckFailed(err)) {
      console.warn(`[runStore] recordIdempotencySessionId(${key}) no-op — idem claim does not exist`);
      return;
    }
    console.error(`[runStore] recordIdempotencySessionId(${key}) failed — duplicates get 409 until the ttl expires:`, err);
  }
}

/**
 * Release an idempotency lock when its run reaches a terminal state, so a
 * legitimate identical resubmit is accepted. Best-effort: on failure the item
 * expires via ttl (bounded staleness — 10 min interactive / 24h scheduled).
 */
export async function releaseIdempotency(key: string): Promise<void> {
  try {
    await getClient().delete({ TableName: AGENT_RUNS_TABLE, Key: { pk: `idem#${key}` } }).promise();
  } catch (err) {
    console.error(`[runStore] releaseIdempotency(${key}) failed — lock expires via ttl:`, err);
  }
}
