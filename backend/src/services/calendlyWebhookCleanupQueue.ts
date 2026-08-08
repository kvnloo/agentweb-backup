import AWS from 'aws-sdk';
import { enqueueJob } from './asyncJobQueue';
import { CalendlyConfig } from './connectedAccountsDb';

/**
 * Shared with both connectedAccounts.ts (disconnect cleanup) and calendlyAuth.ts
 * (connect-side rollback, Greptile P1 on #2291 round 14) — split into its own module
 * specifically to avoid a circular import: connectedAccounts.ts already imports
 * refreshCalendlyAccessToken from calendlyAuth.ts, so calendlyAuth.ts importing this
 * enqueue helper back FROM connectedAccounts.ts would form a cycle. This file has no
 * dependency on either route module.
 */
export const CALENDLY_WEBHOOK_CLEANUP_SOURCE = 'calendly_webhook_cleanup';

export interface CalendlyWebhookCleanupPayload {
  webhookId: string;
  refreshToken?: string;
}

const TABLE_PREFIX = process.env.NODE_ENV === 'development' ? 'Dev-' : '';
const dynamodb = new AWS.DynamoDB.DocumentClient();
const ORPHANED_WEBHOOKS_TABLE = `${TABLE_PREFIX}AW-CalendlyOrphanedWebhooks`;

function orphanId(userId: string, userUri: string): string {
  return `${userId}_${userUri}`;
}

/**
 * Last-resort durable record of a webhook_id that couldn't be deleted remotely AND
 * couldn't be durably enqueued for cleanup retry — Greptile P1 on #2291 (round 16):
 * the async job queue is itself the thing failing to accept writes in exactly this
 * scenario, so a fallback that ALSO writes to that same table has no value. This is
 * a genuinely separate table, so the fallback has a real chance of succeeding when
 * the queue table specifically (not DynamoDB broadly) is the problem.
 *
 * Best-effort: if even this write fails, there is nowhere else left to record it —
 * logs loudly and gives up, exactly like the queue-enqueue exhaustion case above.
 */
async function recordOrphanedCalendlyWebhook(userId: string, userUri: string, webhookId: string, refreshToken?: string): Promise<void> {
  try {
    await dynamodb.put({
      TableName: ORPHANED_WEBHOOKS_TABLE,
      Item: { id: orphanId(userId, userUri), userId, userUri, webhookId, refreshToken, createdAt: new Date().toISOString() },
    }).promise();
    console.error(`[Calendly] Recorded orphaned webhook ${webhookId} in the fallback durable store (async job queue was unavailable) — a later reconnect for this identity will find and clean it up`);
  } catch (err: any) {
    console.error(
      `[Calendly] LOST webhook cleanup record for ${webhookId} — both the async job queue and the fallback durable store are unavailable; this subscription can no longer be identified for cleanup and requires manual intervention`,
      err?.message ?? err,
    );
  }
}

/**
 * Looked up by /connect's duplicate-webhook self-heal (calendlyAuth.ts) when this
 * AgentWeb account's own LOCAL record has no webhook_id for this exact Calendly
 * identity — e.g. a prior disconnect/rollback recorded the orphan here instead,
 * because the async job queue was unavailable at that moment. Keyed by (userId,
 * userUri) — never by listing Calendly's shared webhook_subscriptions — so this
 * preserves the exact same tenant-safety guarantee as the local-record check: we
 * only ever identify a webhook_id THIS account itself previously recorded.
 */
export async function getOrphanedCalendlyWebhook(userId: string, userUri: string): Promise<{ webhookId: string; refreshToken?: string } | null> {
  try {
    const result = await dynamodb.get({ TableName: ORPHANED_WEBHOOKS_TABLE, Key: { id: orphanId(userId, userUri) } }).promise();
    if (!result.Item) return null;
    return { webhookId: result.Item.webhookId, refreshToken: result.Item.refreshToken };
  } catch (err: any) {
    // Best-effort lookup — table not provisioned yet, or a transient read failure.
    // Behaves exactly like "no orphan record", the same as before this fallback existed.
    return null;
  }
}

/** Best-effort cleanup once an orphan record has been consumed (successfully deleted
 *  and retried, or superseded by a fresh webhook) — a leftover row is harmless, just
 *  a future lookup returning an id Calendly may have already forgotten about. */
export async function clearOrphanedCalendlyWebhook(userId: string, userUri: string): Promise<void> {
  try {
    await dynamodb.delete({ TableName: ORPHANED_WEBHOOKS_TABLE, Key: { id: orphanId(userId, userUri) } }).promise();
  } catch (err: any) {
    console.warn(`[Calendly] Failed to clear orphaned-webhook record for ${userUri} (best-effort):`, err?.message ?? err);
  }
}

/**
 * Durably records a webhook_id (+ refresh_token) for later cleanup retry, when an
 * immediate delete attempt wasn't possible or failed. The poller's own registered
 * processor (connectedAccounts.ts's processCalendlyWebhookCleanupJob, registered with
 * maxAttempts: Infinity — Greptile P1 on #2291 round 9 issue 3) refreshes the token
 * fresh on every attempt and keeps retrying until it succeeds, rather than ever going
 * terminally inert and stranding the subscription.
 */
export async function queueCalendlyWebhookCleanup(userId: string, config: Pick<CalendlyConfig, 'webhook_id' | 'refresh_token' | 'user_uri'>): Promise<void> {
  const payload: CalendlyWebhookCleanupPayload = { webhookId: config.webhook_id!, refreshToken: config.refresh_token };
  let result = await enqueueJob(CALENDLY_WEBHOOK_CLEANUP_SOURCE, config.webhook_id!, payload);
  if (result === 'unavailable') {
    // Greptile P1 on #2291: this enqueue is the LAST chance to durably record
    // webhook_id before the caller's own fallback path proceeds without it — one
    // retry catches a transient write blip distinct from the table not existing yet.
    result = await enqueueJob(CALENDLY_WEBHOOK_CLEANUP_SOURCE, config.webhook_id!, payload);
  }
  if (result === 'unavailable') {
    // Greptile P1 on #2291 (round 16): the caller proceeds without this identifier
    // regardless (disconnect still deletes the local account; connect-rollback still
    // returns the original error) — fall back to the separate orphan-webhook table
    // rather than just logging and discarding it.
    await recordOrphanedCalendlyWebhook(userId, config.user_uri, config.webhook_id!, config.refresh_token);
  }
}
