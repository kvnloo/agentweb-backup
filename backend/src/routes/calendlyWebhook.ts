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
import { getAccountByCalendlyUserUri, updateAccountConfig } from '../services/connectedAccountsDb';
import { userDb, crmDb } from '../services/db';
import { metaService } from '../services/metaService';
import { externalCrmSyncService } from '../services/externalCrmSyncService';

const router = express.Router();

// ── CRM-forward: target-list resolution ─────────────────────────────────
//
// A customer's booking gets created/updated as a lead in one of their own
// lead lists, so it forwards to their connected HubSpot/Attio the same way
// any other lead does (externalCrmSyncService.autoSyncLead, already
// triggered generically off whatever list a lead lands in — no new CRM-sync
// logic needed here, just landing the lead in the right list).
//
// When the customer hasn't explicitly picked a list (CalendlyConfig's
// booking_lead_list_id is unset), fall back to an idempotent, system-managed
// "Calendly Bookings" list — created once per user and reused from then on.
// Mirrors resolveOrCreateDefaultLeadList in routes/landingPageGeneration.ts
// exactly (find-by-name+isSystemManaged, singleflight per user, retry once
// on transient failure, never silently swallow a persistent failure).

const BOOKING_LIST_NAME = 'Calendly Bookings';

const inFlightBookingListResolutions = new Map<string, Promise<string>>();

async function resolveBookingListOnce(userId: string): Promise<string> {
  const existing = await crmDb.getLeadListsByUserId(userId);
  const match = (existing || []).find(
    (l: any) => l && l.isSystemManaged === true && l.name === BOOKING_LIST_NAME,
  );
  if (match) return match.listId;

  console.log(`[Calendly Webhook] No booking lead list found for user ${userId} — creating "${BOOKING_LIST_NAME}"`);
  const created = await crmDb.createLeadList(
    userId,
    BOOKING_LIST_NAME,
    'Auto-created default list for Calendly bookings with no explicitly chosen list. System-managed.',
    undefined, // alertEvents
    null, // listSenderId
    undefined, // autoDraftEnabled
    undefined, // autoDraftInstruction
    undefined, // autoSendEnabled
    undefined, // statusConfig — defaults to sales-style
    'sales', // listType
    true, // isSystemManaged
  );
  return (created as any).listId;
}

export async function resolveOrCreateBookingList(userId: string): Promise<string> {
  let inFlight = inFlightBookingListResolutions.get(userId);
  if (!inFlight) {
    inFlight = (async () => {
      try {
        return await resolveBookingListOnce(userId);
      } catch (firstError) {
        console.warn('[Calendly Webhook] Booking list resolution failed once, retrying:', firstError);
        return await resolveBookingListOnce(userId);
      }
    })();
    inFlightBookingListResolutions.set(userId, inFlight);
    inFlight.finally(() => inFlightBookingListResolutions.delete(userId)).catch(() => {});
  }
  return inFlight;
}

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

      const { firstName, lastName } = splitName(parsed.payload);
      const createdAtMs = parsed.payload.created_at ? Date.parse(parsed.payload.created_at) : NaN;
      const eventTimeSeconds = Number.isFinite(createdAtMs) ? Math.floor(createdAtMs / 1000) : undefined;

      // Two independent legs from here — CAPI attribution and CRM-forward. Each gets
      // its own try/catch so a failure in one (e.g. no Meta ad account connected, or a
      // CRM write error) never prevents the other from running.

      try {
        const pixelResolution = await metaService.resolveMetaPixelForUser(owner, resolved.userId);
        if ('unresolved' in pixelResolution) {
          console.log(`[Calendly Webhook] Meta pixel unresolved for user ${resolved.userId}: ${pixelResolution.reason} — booking saved, CAPI skipped`);
        } else {
          const { getMetaAccountCredentials } = await import('../services/metaAccountCredentials');
          const { accessToken } = await getMetaAccountCredentials(owner, resolved.userId, pixelResolution.accountId);

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
        }
      } catch (capiError: any) {
        console.error('[Calendly Webhook] CAPI leg failed:', capiError?.message ?? capiError);
      }

      try {
        const email = parsed.payload.email;
        if (!email) {
          console.warn('[Calendly Webhook] No invitee email — skipping CRM-forward');
        } else {
          let listId = resolved.account.config?.booking_lead_list_id as string | undefined;
          if (!listId) {
            listId = await resolveOrCreateBookingList(resolved.userId);
            await updateAccountConfig(resolved.userId, 'calendly', resolved.account.account_id, {
              booking_lead_list_id: listId,
            });
          }

          const existingLead = await crmDb.getLeadByEmail(listId, email.trim().toLowerCase());
          let lead: any;
          let eventType: 'created' | 'updated';
          if (existingLead) {
            await crmDb.updateLead(listId, existingLead.leadId, {
              customFields: {
                ...(existingLead.customFields || {}),
                lastBookedAt: new Date().toISOString(),
                lastBookingUri: parsed.payload.uri,
              },
            });
            lead = existingLead;
            eventType = 'updated';
          } else {
            lead = await crmDb.createLead(listId, {
              email: email.trim(),
              firstName,
              lastName,
              customFields: {
                source: 'calendly_booking',
                bookedAt: new Date().toISOString(),
                bookingUri: parsed.payload.uri,
              },
            });
            eventType = 'created';
          }

          void externalCrmSyncService.autoSyncLead(resolved.userId, listId, lead, 'hubspot', eventType)
            .catch((err: any) => console.error('[Calendly Webhook] HubSpot auto-sync error:', err?.message ?? err));
          void externalCrmSyncService.autoSyncLead(resolved.userId, listId, lead, 'attio', eventType)
            .catch((err: any) => console.error('[Calendly Webhook] Attio auto-sync error:', err?.message ?? err));

          console.log(`[Calendly Webhook] CRM-forward: lead ${eventType} in list ${listId} for user ${resolved.userId}`);
        }
      } catch (crmError: any) {
        console.error('[Calendly Webhook] CRM-forward leg failed:', crmError?.message ?? crmError);
      }
    } catch (error: any) {
      console.error('[Calendly Webhook] Unexpected error:', error?.message ?? error);
    }
  })();
});

export default router;
