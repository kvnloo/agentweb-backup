/**
 * Calendly booking webhook receiver (ENG-524).
 *
 * Receives `invitee.created` deliveries from the per-customer webhook
 * subscriptions auto-provisioned in calendlyAuth.ts's /connect handler, and
 * fires a server-side Meta CAPI `Lead` conversion through the connected
 * customer's own pixel — generalizing the single-account mechanism ENG-522
 * already built for AgentWeb's own funnel.
 *
 * Structure mirrors the HubSpot receiver in routes/webhooks.ts: respond 200
 * immediately, then verify + process in a fire-and-forget async block,
 * silently dropping (console.warn, no throw) on any verification/resolution
 * failure — Calendly retries on non-2xx, and a per-customer OAuth webhook is
 * closer to HubSpot's model than Fathom's shared-secret one, so a hard
 * failure risks a retry storm against a broken/misconfigured connection
 * rather than protecting anything.
 *
 * No new persistent dedup store: `eventId` (the invitee URI, stable per
 * booking) is passed straight through to metaService.sendCapiLeadEvent,
 * which already documents that Meta collapses matching event_ids into one
 * conversion on its own side — that's the correctness mechanism for
 * Calendly's webhook retries, not anything built here.
 *
 * Field paths below were confirmed against a real invitee.created delivery
 * captured during a live test booking, not assumed from Calendly's docs
 * (which this integration has already found unreliable once — see the
 * OAuth-scope confusion resolved in calendlyAuth.ts's history). Notably:
 * organization_uri does NOT appear anywhere in the payload, which is why
 * user resolution below matches on user_uri (via event_memberships) instead.
 */
import express from 'express';
import crypto from 'crypto';
import { getAccountByCalendlyUserUri } from '../services/connectedAccountsDb';
import { userDb } from '../services/db';
import { metaService } from '../services/metaService';

const router = express.Router();

interface CalendlyInviteePayload {
  event: string;
  payload: {
    email?: string;
    name?: string;
    first_name?: string | null;
    last_name?: string | null;
    created_at?: string;
    uri: string;
    scheduled_event?: {
      event_memberships?: Array<{ user?: string }>;
    };
  };
}

/**
 * Calendly signs as header `t=<unix-ts>,v1=<hex-hmac-sha256>` over the string
 * `${t}.${rawBody}`, HMAC'd with the per-connection webhook_signing_key we
 * generate and hand to Calendly at subscription-create time (calendlyAuth.ts).
 * Confirmed against a live delivery, not assumed from docs.
 */
function verifyCalendlySignature(signingKey: string, rawBody: Buffer, header: string | undefined): boolean {
  if (!header) return false;
  const match = /^t=(\d+),v1=([0-9a-f]+)$/.exec(header.trim());
  if (!match) return false;
  const [, timestamp, providedSignature] = match;
  const expected = crypto
    .createHmac('sha256', signingKey)
    .update(`${timestamp}.${rawBody.toString('utf8')}`)
    .digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(providedSignature, 'hex'));
  } catch {
    // Buffer length mismatch (malformed signature) — timingSafeEqual throws rather than
    // returning false, so treat a throw the same as "did not match".
    return false;
  }
}

/**
 * Calendly's first_name/last_name are frequently null even when the full
 * `name` is populated (confirmed live). Fall back to splitting `name` on
 * the first whitespace boundary when the pre-split fields are absent.
 */
function splitName(payload: CalendlyInviteePayload['payload']): { firstName?: string; lastName?: string } {
  if (payload.first_name || payload.last_name) {
    return { firstName: payload.first_name ?? undefined, lastName: payload.last_name ?? undefined };
  }
  const name = payload.name?.trim();
  if (!name) return {};
  const spaceIndex = name.indexOf(' ');
  if (spaceIndex === -1) return { firstName: name };
  return { firstName: name.slice(0, spaceIndex), lastName: name.slice(spaceIndex + 1) };
}

router.post('/', (req: express.Request, res: express.Response) => {
  // Respond immediately — all processing below is fire-and-forget, same
  // pattern as the HubSpot receiver. Calendly must never see a slow/failed
  // response as a reason to retry a delivery we're already handling async.
  res.status(200).json({ received: true });

  void (async () => {
    try {
      const rawBody = req.body as Buffer;
      const parsed = JSON.parse(rawBody.toString('utf8')) as CalendlyInviteePayload;

      if (parsed.event !== 'invitee.created') {
        console.log(`[Calendly Webhook] Ignored event: ${parsed.event}`);
        return;
      }

      const memberships = parsed.payload?.scheduled_event?.event_memberships ?? [];
      const signatureHeader = req.headers['calendly-webhook-signature'] as string | undefined;

      let resolved: { userId: string; account: any } | null = null;
      for (const membership of memberships) {
        if (!membership.user) continue;
        const candidate = await getAccountByCalendlyUserUri(membership.user);
        if (candidate) {
          resolved = candidate;
          break;
        }
      }

      if (!resolved) {
        console.warn('[Calendly Webhook] No connected account found for any event_memberships user_uri — dropping');
        return;
      }

      const signingKey: string | undefined = resolved.account.config?.webhook_signing_key;
      if (!signingKey || !verifyCalendlySignature(signingKey, rawBody, signatureHeader)) {
        console.warn(`[Calendly Webhook] Signature verification failed for user ${resolved.userId} — dropping`);
        return;
      }

      const owner = await userDb.getUserById(resolved.userId);
      if (!owner) {
        console.warn(`[Calendly Webhook] Resolved user ${resolved.userId} not found — dropping`);
        return;
      }

      const pixelResolution = await metaService.resolveMetaPixelForUser(owner, resolved.userId);
      if ('unresolved' in pixelResolution) {
        console.log(`[Calendly Webhook] Meta pixel unresolved for user ${resolved.userId}: ${pixelResolution.reason} — booking saved, CAPI skipped`);
        return;
      }

      const { getMetaAccountCredentials } = await import('../services/metaAccountCredentials');
      const { accessToken } = await getMetaAccountCredentials(owner, resolved.userId, pixelResolution.accountId);

      const { firstName, lastName } = splitName(parsed.payload);
      const createdAtMs = parsed.payload.created_at ? Date.parse(parsed.payload.created_at) : NaN;
      const eventTimeSeconds = Number.isFinite(createdAtMs) ? Math.floor(createdAtMs / 1000) : undefined;

      const result = await metaService.sendCapiLeadEvent(pixelResolution.pixelId, accessToken, {
        eventId: parsed.payload.uri,
        email: parsed.payload.email,
        firstName,
        lastName,
        eventTimeSeconds,
      });

      if (result.success) {
        console.log(`[Calendly Webhook] CAPI Lead event sent for user ${resolved.userId} (fbtrace_id=${result.fbtraceId ?? 'n/a'})`);
      } else {
        console.error(`[Calendly Webhook] CAPI send failed for user ${resolved.userId}: ${result.error}`);
      }
    } catch (error: any) {
      console.error('[Calendly Webhook] Unexpected error:', error?.message ?? error);
    }
  })();
});

export default router;
