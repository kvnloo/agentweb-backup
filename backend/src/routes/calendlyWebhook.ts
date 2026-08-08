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
 * immediately, verify synchronously first (fast — DB lookups + HMAC, no
 * external API calls), then enqueue + process fire-and-forget. Signature
 * verification and multi-host resolution stay here, before enqueueing, so
 * the queue never has to re-touch signing keys — only already-verified work
 * gets a durable row (ENG-524 fast-follow, Greptile P1: an unenqueued
 * fire-and-forget silently loses a booking's attribution/CRM-forward if the
 * process crashes between the 200 response and finishing the work, since
 * Calendly saw success and never retries).
 *
 * No new persistent dedup store for CAPI specifically: `eventId` (the
 * invitee URI, stable per booking) is passed straight through to
 * metaService.sendCapiLeadEvent, which already documents that Meta collapses
 * matching event_ids into one conversion on its own side. CRM-forward has
 * its own idempotency check (see processCalendlyWebhookJob) since it has no
 * equivalent built-in dedup.
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
import { enqueueJob, markJobComplete, markJobFailed, registerProcessor } from '../services/asyncJobQueue';

const router = express.Router();

const QUEUE_SOURCE = 'calendly_webhook';

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

/** What actually gets enqueued/processed — already-resolved and verified, so the
 *  queue (and any retry by the poller) never needs to re-touch signing keys. */
interface CalendlyJobPayload {
  userId: string;
  accountId: string;
  bookingLeadListId?: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  uri: string;
  eventTimeSeconds?: number;
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

/** CAPI attribution + CRM-forward, run either inline (same request, the common case)
 *  or later by the async job queue's poller if the process crashed before finishing.
 *  Re-fetches the owner and treats bookingLeadListId as a snapshot to verify, not
 *  trust — both cheap, and avoids ever acting on stale data on a delayed retry. */
export async function processCalendlyWebhookJob(payload: CalendlyJobPayload): Promise<void> {
  const owner = await userDb.getUserById(payload.userId);
  if (!owner) {
    console.warn(`[Calendly Webhook] Resolved user ${payload.userId} not found — dropping`);
    return;
  }

  // Two independent legs — CAPI attribution and CRM-forward. Each gets its own
  // try/catch so a failure in one (e.g. no Meta ad account connected, or a CRM
  // write error) never prevents the other from running.
  //
  // A genuine failure in either leg (or the HubSpot/Attio syncs or lead alert
  // nested inside CRM-forward) is recorded here rather than only logged. All
  // legs still run to completion regardless of an earlier one failing, but if
  // anything failed we throw once at the end — so the caller's catch (and
  // therefore markJobFailed) actually fires, letting the queue's poller retry.
  // Before this, a leg's failure was logged and swallowed, the caller saw a
  // clean resolve, and the job was marked 'completed' — permanently losing
  // that attribution/CRM-forward/alert with no retry (Greptile P1 on #2291).
  // An "expected skip" (no Meta pixel connected, no invitee email, a delivery
  // already processed) is not a failure and must not be recorded as one.
  const failures: string[] = [];

  try {
    const pixelResolution = await metaService.resolveMetaPixelForUser(owner, payload.userId);
    if ('unresolved' in pixelResolution) {
      console.log(`[Calendly Webhook] Meta pixel unresolved for user ${payload.userId}: ${pixelResolution.reason} — booking saved, CAPI skipped`);
    } else {
      const { getMetaAccountCredentials } = await import('../services/metaAccountCredentials');
      const { accessToken } = await getMetaAccountCredentials(owner, payload.userId, pixelResolution.accountId);

      const result = await metaService.sendCapiLeadEvent(pixelResolution.pixelId, accessToken, {
        eventId: payload.uri,
        email: payload.email,
        firstName: payload.firstName,
        lastName: payload.lastName,
        eventTimeSeconds: payload.eventTimeSeconds,
        // A booking is Meta's 'Schedule' standard event, not 'Lead' (this function's
        // default) — PRD §6 step 3, matches ENG-522's sendScheduleEvent.
        eventName: 'Schedule',
      });

      if (result.success) {
        console.log(`[Calendly Webhook] CAPI Schedule event sent for user ${payload.userId} (fbtrace_id=${result.fbtraceId ?? 'n/a'})`);
      } else {
        console.error(`[Calendly Webhook] CAPI send failed for user ${payload.userId}: ${result.error}`);
      }
    }
  } catch (capiError: any) {
    console.error('[Calendly Webhook] CAPI leg failed:', capiError?.message ?? capiError);
    failures.push(`CAPI: ${capiError?.message ?? capiError}`);
  }

  try {
    const email = payload.email;
    if (!email) {
      console.warn('[Calendly Webhook] No invitee email — skipping CRM-forward');
    } else {
      let listId = payload.bookingLeadListId;
      if (listId) {
        const configuredList = await crmDb.getLeadListById(listId);
        // Ownership check, not a truthiness check: createLead's list-metadata update
        // has no attribute_exists guard, so writing a lead against a deleted listId
        // partially RESURRECTS a ghost record there (fieldNames/leadCount/listId/
        // updatedAt only — no userId, no name). A plain "does a row exist" check gets
        // fooled by that ghost and never falls back (confirmed live). Checking userId
        // ownership is what actually distinguishes a real list from a ghost.
        if (!configuredList || configuredList.userId !== payload.userId) {
          console.warn(`[Calendly Webhook] Configured booking list ${listId} no longer exists — falling back`);
          listId = undefined;
        }
      }
      if (!listId) {
        listId = await resolveOrCreateBookingList(payload.userId);
        await updateAccountConfig(payload.userId, 'calendly', payload.accountId, {
          booking_lead_list_id: listId,
        });
      }

      const existingLead = await crmDb.getLeadByEmail(listId, email.trim().toLowerCase());

      // Idempotency, split into two separate questions rather than one:
      //   1. Has the lead record itself already been mutated for this booking?
      //      bookingUri covers a redelivery of the very first booking (create path,
      //      before any update happened); lastBookingUri covers every booking after
      //      that. Only used to avoid a duplicate create/update.
      //   2. Have the downstream steps (HubSpot/Attio sync, lead alert) already
      //      completed for this booking? Tracked separately via syncCompletedUri,
      //      written only once none of them failed.
      // A single combined "alreadyProcessed" flag used to gate BOTH — correct for a
      // genuine Calendly redelivery (nothing happened yet either way), but wrong for
      // a queue retry after a downstream failure: the lead mutation had already
      // landed, so the retry saw its own marker and skipped the ENTIRE block,
      // silently losing whichever sync/alert actually failed with no way to ever
      // retry it (Greptile P1 on #2291).
      const leadAlreadyRecordedForThisBooking =
        existingLead?.customFields?.lastBookingUri === payload.uri ||
        existingLead?.customFields?.bookingUri === payload.uri;
      const downstreamAlreadyCompletedForThisBooking =
        existingLead?.customFields?.syncCompletedUri === payload.uri;

      if (downstreamAlreadyCompletedForThisBooking) {
        console.log(`[Calendly Webhook] Duplicate delivery for already fully-processed booking ${payload.uri} — skipping CRM-forward re-processing`);
      } else {
        let lead: any;
        let eventType: 'created' | 'updated';
        if (leadAlreadyRecordedForThisBooking) {
          // A prior attempt already mutated the lead for this exact booking (the
          // downstream steps below are what's being retried) — reuse it as-is
          // rather than writing lastBookedAt/lastBookingUri again. bookingUri is
          // set once at create time and never overwritten, so it still tells us
          // whether that original attempt created or updated the lead.
          lead = existingLead;
          eventType = existingLead.customFields?.bookingUri === payload.uri ? 'created' : 'updated';
        } else if (existingLead) {
          await crmDb.updateLead(listId, existingLead.leadId, {
            customFields: {
              ...(existingLead.customFields || {}),
              lastBookedAt: new Date().toISOString(),
              lastBookingUri: payload.uri,
            },
          });
          lead = existingLead;
          eventType = 'updated';
        } else {
          lead = await crmDb.createLead(listId, {
            email: email.trim(),
            firstName: payload.firstName,
            lastName: payload.lastName,
            customFields: {
              source: 'calendly_booking',
              bookedAt: new Date().toISOString(),
              bookingUri: payload.uri,
            },
          });
          eventType = 'created';
        }

        let downstreamStepFailed = false;

        // Awaited (not fire-and-forget) so a genuine sync failure is counted below —
        // each still independently caught, so one platform's failure never blocks
        // the other's sync from being attempted.
        await externalCrmSyncService.autoSyncLead(payload.userId, listId, lead, 'hubspot', eventType)
          .catch((err: any) => {
            console.error('[Calendly Webhook] HubSpot auto-sync error:', err?.message ?? err);
            failures.push(`HubSpot sync: ${err?.message ?? err}`);
            downstreamStepFailed = true;
          });
        await externalCrmSyncService.autoSyncLead(payload.userId, listId, lead, 'attio', eventType)
          .catch((err: any) => {
            console.error('[Calendly Webhook] Attio auto-sync error:', err?.message ?? err);
            failures.push(`Attio sync: ${err?.message ?? err}`);
            downstreamStepFailed = true;
          });

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
              { source: 'calendly_booking', bookingUri: payload.uri },
              new Date().toISOString(),
            );
          }
        } catch (alertError: any) {
          console.error('[Calendly Webhook] Lead alert failed:', alertError?.message ?? alertError);
          failures.push(`Lead alert: ${alertError?.message ?? alertError}`);
          downstreamStepFailed = true;
        }

        // Only mark this booking as fully synced once every downstream step this
        // attempt actually ran has succeeded — a retry re-checks this same flag, so
        // a step recorded here as done is never re-attempted, and a step NOT
        // recorded here still will be.
        if (!downstreamStepFailed) {
          await crmDb.updateLead(listId, lead.leadId, {
            customFields: { ...(lead.customFields || {}), syncCompletedUri: payload.uri },
          });
        }

        console.log(`[Calendly Webhook] CRM-forward: lead ${eventType} in list ${listId} for user ${payload.userId}`);
      }
    }
  } catch (crmError: any) {
    console.error('[Calendly Webhook] CRM-forward leg failed:', crmError?.message ?? crmError);
    failures.push(`CRM-forward: ${crmError?.message ?? crmError}`);
  }

  if (failures.length > 0) {
    throw new Error(`processCalendlyWebhookJob had ${failures.length} failure(s): ${failures.join('; ')}`);
  }
}

registerProcessor(QUEUE_SOURCE, processCalendlyWebhookJob);

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

      // The real event_memberships shape for 2+ hosts has never been observed live — the
      // resolution logic below only assumes "more entries, same per-entry shape" as the
      // single-host payload this receiver was originally verified against. Log the raw
      // shape the first time this actually happens in production, cheap insurance against
      // that assumption being wrong (ENG-524 multi-host fix, no live multi-host account
      // available to verify against directly).
      if (memberships.length > 1) {
        console.log(
          `[Calendly Webhook] Multi-host event detected (${memberships.length} members) — logging payload shape for verification:`,
          JSON.stringify(memberships),
        );
      }

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

      const { firstName, lastName } = splitName(parsed.payload);
      const createdAtMs = parsed.payload.created_at ? Date.parse(parsed.payload.created_at) : NaN;
      const eventTimeSeconds = Number.isFinite(createdAtMs) ? Math.floor(createdAtMs / 1000) : undefined;

      const jobPayload: CalendlyJobPayload = {
        userId: resolved.userId,
        accountId: resolved.account.account_id,
        bookingLeadListId: resolved.account.config?.booking_lead_list_id,
        email: parsed.payload.email,
        firstName,
        lastName,
        uri: parsed.payload.uri,
        eventTimeSeconds,
      };

      // claimImmediately: this same request processes the job right below, so the
      // enqueue writes it straight in as 'processing' — no separate claim call, no
      // window where it sits 'pending' and claimable by the poller.
      const enqueueResult = await enqueueJob(QUEUE_SOURCE, parsed.payload.uri, jobPayload, { claimImmediately: true });
      if (enqueueResult === 'duplicate') {
        console.log(`[Calendly Webhook] Duplicate delivery for ${parsed.payload.uri} — already queued, skipping`);
        return;
      }

      try {
        await processCalendlyWebhookJob(jobPayload);
        if (enqueueResult === 'enqueued') {
          await markJobComplete(QUEUE_SOURCE, parsed.payload.uri);
        }
      } catch (processingError: any) {
        if (enqueueResult === 'enqueued') {
          // Durable record exists — the poller will retry, so don't lose this silently.
          await markJobFailed(QUEUE_SOURCE, parsed.payload.uri, processingError);
        } else {
          // Queue unavailable (e.g. table not provisioned yet) — no durable record to
          // retry from, so this is exactly today's fire-and-forget failure behavior.
          console.error('[Calendly Webhook] Processing failed with no durable record (queue unavailable):', processingError?.message ?? processingError);
        }
      }
    } catch (error: any) {
      console.error('[Calendly Webhook] Unexpected error:', error?.message ?? error);
    }
  })();
});

export default router;
