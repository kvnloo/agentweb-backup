import { AttioService } from '../services/attioService';
import { updateAccountConfig, getAccountById } from '../services/connectedAccountsDb';

/**
 * Registers a real-time webhook subscription for a connected Attio workspace,
 * covering Person/Company record changes and Deal-analog (List Entry)
 * changes — the same event scope HubSpot's app-wide webhook already covers
 * for contacts + deals.
 *
 * Attio's model is per-workspace (register against this account's own OAuth
 * token), not HubSpot's single app-wide subscription list — mirrors the
 * existing Calendly per-account registration pattern (`calendlyAuth.ts`'s
 * `createWebhookSubscription`/`provisionCalendlyWebhook`), not
 * `ensureWebhookSubscriptions`'s HubSpot app-wide diffing loop.
 *
 * Idempotent by construction: no-ops if this account already has a
 * `webhook_id` on record, so it's safe to call on every CRM sync config
 * save (mirroring HubSpot's `ensureWebhookSubscriptions` trigger point)
 * without ever hitting Attio's 409 duplicate-subscription error in normal
 * operation. Never throws — fire-and-forget-safe.
 */
export async function ensureAttioWebhook(userId: string, accountId: string): Promise<void> {
  try {
    const account = await getAccountById(accountId, userId);
    if (!account || account.platform !== 'attio') {
      console.warn(`[Attio Webhook] ensureAttioWebhook: account ${accountId} not found or not Attio`);
      return;
    }
    if ((account.config as any).webhook_id) {
      return; // already registered
    }
    if ((account.config as any).needs_reconnect) {
      // Already flagged from a prior 403 (missing webhook:read-write scope).
      // Without this guard, every config save re-attempts registration and
      // silently re-403s forever until the user reconnects — reconnecting
      // clears this flag (createAccount replaces config wholesale, not
      // merges), which naturally lets the next save retry.
      return;
    }

    const baseUrl = process.env.BACKEND_URL;
    if (!baseUrl) {
      // Registering a localhost URL would still persist webhook_id, and the
      // idempotency guard above would then permanently no-op every later
      // attempt for this account — a silent, self-locking failure.
      console.warn(`[Attio Webhook] BACKEND_URL unset — skipping registration for account ${accountId}`);
      return;
    }
    const svc = await AttioService.create(userId, accountId);
    const targetUrl = `${baseUrl}/api/webhooks/attio`;
    const { webhookId, secret } = await svc.registerWebhook(targetUrl);

    if (!webhookId || !secret) {
      console.warn(`[Attio Webhook] registerWebhook returned an unexpected shape for account ${accountId}`);
      return;
    }

    await updateAccountConfig(userId, 'attio', accountId, {
      webhook_id: webhookId,
      webhook_signing_key: secret,
    });
    console.log(`[Attio Webhook] Registered webhook ${webhookId} for account ${accountId}`);
  } catch (error: any) {
    if (error?.response?.status === 403) {
      // Missing webhook:read-write scope — connected before the scope was
      // added to the app. Flag for reconnect rather than retrying forever.
      console.warn(`[Attio Webhook] 403 registering webhook for account ${accountId} — flagging needs_reconnect`);
      await updateAccountConfig(userId, 'attio', accountId, { needs_reconnect: true }).catch(() => {});
      return;
    }
    console.warn(`[Attio Webhook] Webhook registration failed for account ${accountId}:`, error?.response?.data || error?.message);
  }
}
