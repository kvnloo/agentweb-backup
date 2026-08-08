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

/**
 * Durably records a webhook_id (+ refresh_token) for later cleanup retry, when an
 * immediate delete attempt wasn't possible or failed. The poller's own registered
 * processor (connectedAccounts.ts's processCalendlyWebhookCleanupJob, registered with
 * maxAttempts: Infinity — Greptile P1 on #2291 round 9 issue 3) refreshes the token
 * fresh on every attempt and keeps retrying until it succeeds, rather than ever going
 * terminally inert and stranding the subscription.
 */
export async function queueCalendlyWebhookCleanup(config: Pick<CalendlyConfig, 'webhook_id' | 'refresh_token'>): Promise<void> {
  const payload: CalendlyWebhookCleanupPayload = { webhookId: config.webhook_id!, refreshToken: config.refresh_token };
  let result = await enqueueJob(CALENDLY_WEBHOOK_CLEANUP_SOURCE, config.webhook_id!, payload);
  if (result === 'unavailable') {
    // Greptile P1 on #2291: this enqueue is the LAST chance to durably record
    // webhook_id before the caller's own fallback path proceeds without it — one
    // retry catches a transient write blip distinct from the table not existing yet.
    result = await enqueueJob(CALENDLY_WEBHOOK_CLEANUP_SOURCE, config.webhook_id!, payload);
  }
  if (result === 'unavailable') {
    // Greptile P1 on #2291 (round 10): the caller proceeds without this identifier
    // regardless (disconnect still deletes the local account; connect-rollback still
    // returns the original error) — this is the last point where the fact that this
    // subscription is now permanently unrecoverable is observable anywhere.
    // console.error (not warn) so it's actionable/alertable in production monitoring
    // rather than silently lost in an info-level log stream.
    console.error(`[Calendly] LOST webhook cleanup record for ${config.webhook_id} — queue unavailable after retry; this subscription can no longer be identified for cleanup and requires manual intervention`);
  }
}
