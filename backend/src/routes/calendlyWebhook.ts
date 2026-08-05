/**
 * Calendly booking webhook receiver (ENG-524).
 *
 * Receives `invitee.created` deliveries from the per-customer webhook
 * subscriptions auto-provisioned in calendlyAuth.ts's /connect handler, and
 * fires a server-side Meta CAPI `Schedule` conversion through the connected
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
import { leadListAlertService } from '../services/leadListAlertService';

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
//
// Race-safety: uses a DETERMINISTIC listId (not a name+isSystemManaged scan
// like the sibling pattern in landingPageGeneration.ts's
// resolveOrCreateDefaultLeadList) plus crmDb.createLeadList's conditional
// write support, so two concurrent callers — even across different backend
// instances, not just within one process — can't create duplicate lists. A
// caller that loses the create race gets a ConditionalCheckFailedException
// and falls back to fetching the winner's record directly. The in-memory
// singleflight map below is kept only as a same-process optimization to
// avoid redundant DB round trips; it's no longer the sole thing preventing
// duplicates, unlike the sibling pattern (documented there as a known,
// accepted single-instance-only limitation — this closes it for Calendly).

const BOOKING_LIST_NAME = 'Calendly Bookings';

function bookingListId(userId: string): string {
  return `list_calendly_bookings_${userId}`;
}

async function resolveBookingListOnce(userId: string): Promise<string> {
  const id = bookingListId(userId);
  const existing = await crmDb.getLeadListById(id);
  if (existing) return existing.listId;

  console.log(`[Calendly Webhook] No booking lead list found for user ${userId} — creating "${BOOKING_LIST_NAME}"`);
  try {
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
      id, // explicitListId — makes the write conditional on not already existing
    );
    return (created as any).listId;
  } catch (err: any) {
    if (err?.code === 'ConditionalCheckFailedException') {
      console.log(`[Calendly Webhook] Lost the create race for booking list ${id} — fetching the winner`);
      const winner = await crmDb.getLeadListById(id);
      if (winner) return winner.listId;
    }
    throw err;
  }
}

const inFlightBookingListResolutions = new Map<string, Promise<string>>();

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

      // Each customer's webhook subscription is scope:'user' (calendlyAuth.ts), so an event
      // with 2+ independently-connected hosts produces a SEPARATE delivery per subscription —
      // identical payload, but each signed with that host's own webhook_signing_key. We can't
      // know in advance which membership this particular delivery belongs to, so try every
      // connected candidate's key rather than committing to the first membership that resolves
      // to a connected account — otherwise a later host's delivery is silently dropped whenever
      // an earlier-listed host is also connected (confirmed as a real gap, not just untested).
      let resolved: { userId: string; account: any } | null = null;
      for (const membership of memberships) {
        if (!membership.user) continue;
        const candidate = await getAccountByCalendlyUserUri(membership.user);
        if (!candidate) continue;
        const candidateKey: string | undefined = (candidate.account.config as any)?.webhook_signing_key;
        if (candidateKey && verifyCalendlySignature(candidateKey, rawBody, signatureHeader)) {
          resolved = candidate;
          break;
        }
      }

      if (!resolved) {
        console.warn('[Calendly Webhook] No connected account\'s key verified this delivery — dropping');
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
            // A booking is Meta's 'Schedule' standard event, not 'Lead' (this function's
            // default) — PRD §6 step 3, matches ENG-522's sendScheduleEvent.
            eventName: 'Schedule',
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
          if (listId) {
            const configuredList = await crmDb.getLeadListById(listId);
            // Ownership check, not a truthiness check: createLead's list-metadata update
            // has no attribute_exists guard, so writing a lead against a deleted listId
            // partially RESURRECTS a ghost record there (fieldNames/leadCount/listId/
            // updatedAt only — no userId, no name). A plain "does a row exist" check gets
            // fooled by that ghost and never falls back (confirmed live). Checking userId
            // ownership is what actually distinguishes a real list from a ghost.
            if (!configuredList || configuredList.userId !== resolved.userId) {
              console.warn(`[Calendly Webhook] Configured booking list ${listId} no longer exists — falling back`);
              listId = undefined;
            }
          }
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

          // Same alert mechanism /forward-lead already uses — per-list opt-in via
          // list.alertEvents, so this only notifies the customer if they've already
          // configured this specific list to alert on lead-added/updated.
          try {
            const list = await crmDb.getLeadListById(listId);
            if (list) {
              const alertEventType = eventType === 'created' ? 'api.lead_added' : 'api.lead_updated';
              await leadListAlertService.notifyLeadListOwnerIfConfigured(
                list,
                lead,
                alertEventType,
                { source: 'calendly_booking', bookingUri: parsed.payload.uri },
                new Date().toISOString(),
              );
            }
          } catch (alertError: any) {
            console.error('[Calendly Webhook] Lead alert failed:', alertError?.message ?? alertError);
          }

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
