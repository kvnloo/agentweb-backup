/**
 * Unipile `account_status` webhook receiver (ENG-1197 fast-follow).
 *
 * Closes the detection-latency gap in the existing polling-only health check
 * (`cron/linkedInConnectionSyncCron.ts`, ~10 min while healthy, backing off to
 * 30 min once flagged dead): Unipile pushes this event near-instantly on a
 * LinkedIn session status transition instead of us discovering it on the next
 * poll cycle. This is a detection-SPEED upgrade only — the polling cron stays
 * on unchanged as a safety net for a missed/mis-registered delivery, and this
 * route deliberately reuses the exact same, already-idempotent pipeline
 * (`recordUnipileAccountHealth`) rather than building a second notify path —
 * see ENG-1351 for what happens when two independent "notify on disconnect"
 * implementations drift out of sync with each other.
 *
 * Root cause of WHY sessions die (LinkedIn's own automation detection,
 * confirmed against Unipile's docs — see ENG-1197) is NOT fixed by this
 * route; a `CREDENTIALS` status still requires the end user to manually
 * re-authenticate. This route only makes us find out sooner.
 *
 * Payload shape (confirmed against Unipile's live docs):
 *   { "AccountStatus": { "account_id": "...", "account_type": "LINKEDIN", "message": "CREDENTIALS" } }
 *
 * Auth: Unipile's webhook auth is a plain shared header value (not HMAC) —
 * whatever `key`/`value` we supplied at webhook-creation time
 * (`scripts/register-unipile-account-status-webhook.ts`) is echoed back
 * verbatim on every delivery. Verified via SHA-256 + timingSafeEqual, same
 * technique as `routes/fathomWebhook.ts`. Unlike Fathom, this endpoint FAILS
 * CLOSED when UNIPILE_WEBHOOK_SECRET is unset: a forged `CREDENTIALS`
 * delivery pages oncall and (after the existing 9-minute confirm debounce)
 * emails a paying customer their account is broken, and a forged
 * `OK`/`RECONNECTED` would silently clear a genuinely-dead account's
 * needs_reconnect flag — both are worse than rejecting traffic while
 * misconfigured.
 *
 * Retry: Unipile retries up to 5 times within 30s on any non-200 response, so
 * on an unexpected processing error we return non-200 rather than swallowing
 * it into a false 200 — that redelivery is the crash-durability mechanism,
 * standing in for a job queue (recordUnipileAccountHealth's own compare-and-
 * swap write already makes redelivery safe to process twice).
 *
 * Mounted at /api/webhooks/unipile in app.ts.
 */

import crypto from 'crypto';
import express from 'express';
import { getAllUnipileAccountIds } from '../cron/linkedInConnectionSyncCron';
import { recordUnipileAccountHealth, SessionState } from '../services/linkedInConnectionHealth';
import { sendAgentModeOncallAlert } from '../utils/agentModeAlerts';

const router = express.Router();
const TAG = '[Unipile Webhook]';
const AUTH_HEADER = 'unipile-auth';

/** Constant-time string comparison (hash first so lengths never leak). */
function timingSafeEqualStr(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function isAuthorized(req: express.Request): boolean {
  const secret = process.env.UNIPILE_WEBHOOK_SECRET;
  if (!secret) {
    console.error(`${TAG} UNIPILE_WEBHOOK_SECRET not configured — rejecting all deliveries`);
    return false;
  }
  const presented = req.get(AUTH_HEADER);
  return typeof presented === 'string' && presented.length > 0 && timingSafeEqualStr(presented, secret);
}

type MappedStatus =
  | { kind: 'health'; state: SessionState }
  | { kind: 'investigate' }
  | { kind: 'ignore' };

/**
 * Maps Unipile's AccountStatus.message to our own health signal.
 *
 * Mirrors linkedInOutreachService.isProvenDisconnectError's philosophy:
 * exactly one signal (`CREDENTIALS`) may prove disconnected. ERROR/STOPPED is
 * Unipile's own "investigate" status, not proof of a dead session — routed to
 * an internal-only alert instead, never the customer-facing pipeline.
 */
export function mapAccountStatusMessage(message: string): MappedStatus {
  switch (message) {
    case 'OK':
    case 'SYNC_SUCCESS':
    case 'RECONNECTED':
      return { kind: 'health', state: 'connected' };
    case 'CREDENTIALS':
      return { kind: 'health', state: 'disconnected' };
    case 'CONNECTING':
    case 'CREATION_SUCCESS':
    case 'DELETED':
      return { kind: 'ignore' };
    case 'ERROR':
    case 'STOPPED':
      return { kind: 'investigate' };
    default:
      console.warn(`${TAG} Unrecognized AccountStatus.message "${message}" — treating as no-op`);
      return { kind: 'ignore' };
  }
}

interface AccountStatusPayload {
  AccountStatus?: {
    account_id?: string;
    account_type?: string;
    message?: string;
  };
}

router.post('/account-status', async (req: express.Request, res: express.Response) => {
  if (!isAuthorized(req)) {
    return res.status(401).json({ error: 'Missing or invalid webhook credential' });
  }

  const status = (req.body as AccountStatusPayload)?.AccountStatus;
  const accountId = status?.account_id;
  const message = status?.message;

  if (!status || typeof accountId !== 'string' || !accountId || typeof message !== 'string' || !message) {
    console.warn(`${TAG} Malformed payload:`, JSON.stringify(req.body));
    return res.status(400).json({ error: 'Missing AccountStatus.account_id or .message' });
  }

  // This webhook is registered unscoped (no account_ids filter — see the
  // registration script), so deliveries for any platform Unipile supports
  // (WhatsApp, Instagram, ...) reach this handler, not just LinkedIn. Require
  // an exact match rather than only excluding a known non-LinkedIn value —
  // a missing/malformed account_type must be ignored, not default to
  // "treat as LinkedIn," matching the auth check's own fail-closed posture.
  if (status.account_type !== 'LINKEDIN') {
    console.log(`${TAG} Ignoring non-LinkedIn account_type "${status.account_type ?? '(missing)'}" for ${accountId}`);
    return res.status(200).json({ received: true });
  }

  const verdict = mapAccountStatusMessage(message);

  try {
    if (verdict.kind === 'ignore') {
      console.log(`${TAG} account=${accountId} message=${message} — no health signal`);
      return res.status(200).json({ received: true });
    }

    const { ownerByAccountId } = await getAllUnipileAccountIds();
    const ownerUserId = ownerByAccountId.get(accountId);

    if (verdict.kind === 'investigate') {
      await sendAgentModeOncallAlert({
        subject: `Unipile account_status ${message}: ${accountId}`,
        message: `Unipile reported message="${message}" for account ${accountId} — Unipile's docs call this "investigate", not a proven dead session. No customer-facing action taken.`,
        context: { accountId, ownerUserId: ownerUserId ?? null, message },
        dedupeKey: `unipile-account-status-investigate:${accountId}`,
        dedupeWindowMs: 24 * 60 * 60 * 1000,
      }).catch((err) => console.error(`${TAG} investigate alert failed for ${accountId}:`, err));
      return res.status(200).json({ received: true });
    }

    const outcome = await recordUnipileAccountHealth({
      accountId,
      ownerUserId,
      state: verdict.state,
    });
    console.log(`${TAG} account=${accountId} message=${message} -> state=${verdict.state} outcome=${outcome}`);
    return res.status(200).json({ received: true });
  } catch (error: any) {
    console.error(`${TAG} Failed to process delivery for ${accountId}:`, error?.message ?? error);
    return res.status(500).json({ error: 'Processing failed; please retry this delivery' });
  }
});

export default router;
