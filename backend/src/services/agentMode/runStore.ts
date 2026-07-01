/**
 * runStore — durable run records, idempotency submit-locks, and incident
 * dedupe on ONE DynamoDB table (AW-AgentRuns). The run-survival core for
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
 *   incident#<runId>  — incident-filed claim, conditional put, ttl 24h. One
 *                        run can never file two Linear/Notion incidents.
 *
 * Config gate: the whole store is behind AGENT_RUN_STORE=true (an A-or-B
 * migration switch — flag absent = feature off; NOT an on-error fallback).
 * Callers check isRunStoreEnabled() before calling in.
 *
 * Failure policy (NO hidden fallbacks):
 *   - createRunRecord / claimIdempotency / claimIncident THROW on real
 *     DynamoDB failures — run-record creation is core state and the caller
 *     aborts the request loudly.
 *   - markRunTerminal is the one sanctioned best-effort step: a terminal
 *     status update cannot retro-fail a chat that was already delivered, so
 *     it retries once and then fires a single deduped oncall alert.
 *   - releaseIdempotency is best-effort: on delete failure the item expires
 *     via its ttl (bounded staleness, logged loudly).
 */
import AWS from 'aws-sdk';
import crypto from 'crypto';

const TABLE_PREFIX = process.env.NODE_ENV === 'development' ? 'Dev-' : '';
export const AGENT_RUNS_TABLE = `${TABLE_PREFIX}AW-AgentRuns`;

/** Idempotency lock TTLs (seconds). */
export const IDEM_TTL_INTERACTIVE_S = 600; // 10 minutes
export const IDEM_TTL_SCHEDULED_S = 24 * 3600; // 24 hours

const RUN_RECORD_TTL_S = 30 * 24 * 3600; // 30 days
const INCIDENT_TTL_S = 24 * 3600; // 24 hours

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
  | { claimed: false; inFlightRunId?: string };

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
    console.error(`[runStore] markRunTerminal(${runId}, ${status}) failed — retrying once:`, firstErr);
  }

  try {
    await update();
  } catch (secondErr) {
    console.error(`[runStore] markRunTerminal(${runId}, ${status}) failed after retry:`, secondErr);
    try {
      // Dynamic import keeps this module light and avoids a load-time cycle
      // (agentModeAlerts -> chatbotService).
      const { sendAgentModeOncallAlert } = await import('../../utils/agentModeAlerts');
      await sendAgentModeOncallAlert({
        subject: 'Agent run store: terminal status update failed',
        message:
          `Failed to mark run ${runId} as ${status} in ${AGENT_RUNS_TABLE} after one retry. ` +
          `The run's durable record is stale until its ttl expires.\n\nError: ${(secondErr as Error)?.message}`,
        dedupeKey: 'run_store:terminal_update_failed',
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
  try {
    await getClient()
      .put({
        TableName: AGENT_RUNS_TABLE,
        Item: { pk, runId, ttl: nowEpochS() + ttlSeconds },
        ConditionExpression: 'attribute_not_exists(pk)',
      })
      .promise();
    return { claimed: true };
  } catch (err) {
    if (!isConditionalCheckFailed(err)) throw err;
    // Best-effort read of the winner's runId for the 409 body.
    try {
      const existing = await getClient().get({ TableName: AGENT_RUNS_TABLE, Key: { pk } }).promise();
      return { claimed: false, inFlightRunId: existing.Item?.runId };
    } catch {
      return { claimed: false };
    }
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

/**
 * Claim the right to file THE incident for a run. Conditional put — returns
 * true exactly once per runId. THROWS on real DynamoDB failures so the
 * caller's existing best-effort wrapper logs it (no silent double-file, no
 * silent drop).
 */
export async function claimIncident(runId: string): Promise<boolean> {
  try {
    await getClient()
      .put({
        TableName: AGENT_RUNS_TABLE,
        Item: { pk: `incident#${runId}`, runId, ttl: nowEpochS() + INCIDENT_TTL_S },
        ConditionExpression: 'attribute_not_exists(pk)',
      })
      .promise();
    return true;
  } catch (err) {
    if (isConditionalCheckFailed(err)) return false;
    throw err;
  }
}
