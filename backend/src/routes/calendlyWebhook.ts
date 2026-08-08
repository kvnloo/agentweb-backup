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
import { enqueueJob, markJobComplete, markJobFailed, registerProcessor, startHeartbeat, EnqueueResult } from '../services/asyncJobQueue';

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
        // sendCapiLeadEvent returns { success: false }, it doesn't throw — a soft
        // failure like this was silently swallowed here (Greptile P1 on #2291),
        // recorded nowhere, so the job still completed and the poller never retried.
        failures.push(`CAPI: ${result.error}`);
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

      // Idempotency, split into per-step questions rather than one combined flag:
      //   1. Has the lead record itself already been mutated for this booking?
      //      bookingUri covers a redelivery of the very first booking (create path,
      //      before any update happened); lastBookingUri covers every booking after
      //      that. Only used to avoid a duplicate create/update.
      //   2. Has EACH downstream step (HubSpot sync, Attio sync, lead alert)
      //      individually already succeeded for this booking? Tracked with its own
      //      marker, written immediately after that specific step succeeds.
      // A single combined flag for #2 (Greptile P1 on #2291, round 2) is wrong: if
      // the alert succeeds but a sync fails afterward, the combined flag never gets
      // set, so a retry re-runs EVERYTHING including the alert that already
      // succeeded — sending the customer a duplicate, non-idempotent notification.
      // Persisting each step's own marker right after it succeeds means a retry
      // only ever re-attempts the specific step(s) that didn't complete.
      const leadAlreadyRecordedForThisBooking =
        existingLead?.customFields?.lastBookingUri === payload.uri ||
        existingLead?.customFields?.bookingUri === payload.uri;

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
        // Greptile P1 on #2291 (round 9): two different bookings for the same lead
        // (email) processed concurrently each read their own pre-update
        // customFields snapshot, so a plain crmDb.updateLead full-map SET here —
        // even with `lead` correctly reflecting this write's own result — would
        // still let the LATER-committing booking's write silently overwrite
        // whatever the other one had just persisted (its own lastBookedAt/
        // lastBookingUri, or any step marker written by a job that raced ahead of
        // this one). crmDb.setLeadFields writes only these two customFields
        // sub-keys via a DynamoDB document-path SET
        // (`customFields.lastBookedAt = :v`), so two concurrent bookings' writes
        // to the SAME lead no longer clobber each other's fields.
        const bookedFields = { lastBookedAt: new Date().toISOString(), lastBookingUri: payload.uri };
        await crmDb.setLeadFields(listId, existingLead.leadId, { customFields: bookedFields });
        lead = { ...existingLead, customFields: { ...(existingLead.customFields || {}), ...bookedFields } };
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

      // Greptile P1 on #2291 (round 12): the previous version tracked each step's
      // completion under a SCALAR key (hubspotSyncedUri, attioSyncedUri,
      // alertSentUri) shared by every booking this lead ever gets. Even with
      // setLeadFields's atomic per-key write (round 9's fix), a scalar key can
      // only remember ONE booking's URI at a time — if a DIFFERENT booking for
      // the same lead completes that same step afterward, its write replaces the
      // marker, so a later retry of the FIRST booking sees a URI that isn't its
      // own, concludes the step was never done, and repeats it (a duplicate
      // HubSpot/Attio sync or a duplicate customer alert). The fix is to key each
      // marker by (step, booking URI) — namespaced into `system` (not
      // customFields) so these internal flags never surface in CSV exports or
      // the Configure Display Fields UI. Two different bookings now own two
      // entirely distinct map entries and can never collide.
      const stepMarkerKey = (step: 'hubspot' | 'attio' | 'alert') => `${step}Synced::${payload.uri}`;
      const leadSystemMarkers: Record<string, any> = { ...(lead.system || {}) };

      // Greptile P1 on #2291 (round 15): the per-booking marker above (round 12's
      // fix) stops a THIRD run from repeating a step once one instance finishes it,
      // but if a stale-reclamation race in the async job queue (asyncJobQueue.ts —
      // every heartbeat write failing across the whole staleness window) ever lets
      // TWO instances start processing the SAME booking concurrently, both would
      // pass the "not yet done" check below and both fire the real side effect
      // before either gets to write "done". claimLeadStepOnce is an actual mutex —
      // a DynamoDB conditional write, not a probability reduction — so only ONE of
      // two concurrent claimants can ever win, regardless of how the race happened.
      // On failure, the claim is released so a legitimate future retry (this same
      // job re-run by the poller after markJobFailed) can still re-attempt the step.
      //
      // Greptile P1 on #2291 (round 17): that release write is itself best-effort —
      // if it fails too, the previous version just swallowed it, wedging the claim
      // 'in_progress' forever and silently skipping this step on every future
      // retry (a real failure disguised as "someone else is handling it"). Retried
      // once here as the fast path; claimLeadStepOnce's own staleness window
      // (CLAIM_STALE_MS in db.ts) is the structural backstop if both attempts fail —
      // a still-wedged claim becomes reclaimable on its own once it's old enough,
      // rather than staying stuck indefinitely.
      // Greptile P1 on #2291 (round 18): losing the claim below used to resolve
      // runStepOnce NORMALLY — "someone else has it, not my problem" — but that's
      // only safe if that someone else actually finishes. If the current claim
      // owner crashes before writing its own done marker, this job would still
      // complete with zero failures recorded (nothing else was watching this
      // step), the queue marks it 'completed', and the poller never revisits a
      // completed job — permanently omitting the sync/alert with no trace. A lost
      // claim is treated as a failure for THIS attempt too, so the job gets
      // retried later regardless of which instance actually finishes it: a retry
      // that finds the step genuinely done skips cleanly (leadSystemMarkers check
      // above), and a retry that finds it still stuck tries again.
      const runStepOnce = async (step: 'hubspot' | 'attio' | 'alert', work: () => Promise<void>): Promise<void> => {
        const key = stepMarkerKey(step);
        if (leadSystemMarkers[key]?.status === 'done') return;
        const claimed = await crmDb.claimLeadStepOnce(listId!, lead.leadId, key);
        if (!claimed) {
          throw new Error(`${step} step for ${payload.uri} could not be claimed (held by another run) — retrying to confirm completion`);
        }
        try {
          await work();
          leadSystemMarkers[key] = { status: 'done' };
          await crmDb.setLeadFields(listId!, lead.leadId, { system: { [key]: { status: 'done' } } });
        } catch (err: any) {
          const release = () => crmDb.setLeadFields(listId!, lead.leadId, { removeSystemKeys: [key] });
          await release().catch(() => release().catch((releaseErr: any) => {
            console.error(`[Calendly Webhook] Failed to release ${step} claim for ${payload.uri} after retry — will self-heal once the claim goes stale:`, releaseErr?.message ?? releaseErr);
          }));
          throw err;
        }
      };

      try {
        await runStepOnce('hubspot', () => externalCrmSyncService.autoSyncLead(payload.userId, listId, lead, 'hubspot', eventType));
      } catch (err: any) {
        console.error('[Calendly Webhook] HubSpot auto-sync error:', err?.message ?? err);
        failures.push(`HubSpot sync: ${err?.message ?? err}`);
      }

      try {
        await runStepOnce('attio', () => externalCrmSyncService.autoSyncLead(payload.userId, listId, lead, 'attio', eventType));
      } catch (err: any) {
        console.error('[Calendly Webhook] Attio auto-sync error:', err?.message ?? err);
        failures.push(`Attio sync: ${err?.message ?? err}`);
      }

      // Same alert mechanism /forward-lead already uses — per-list opt-in via
      // list.alertEvents, so this only notifies the customer if they've already
      // configured this specific list to alert on lead-added/updated.
      try {
        await runStepOnce('alert', async () => {
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
        });
      } catch (alertError: any) {
        console.error('[Calendly Webhook] Lead alert failed:', alertError?.message ?? alertError);
        failures.push(`Lead alert: ${alertError?.message ?? alertError}`);
      }

      console.log(`[Calendly Webhook] CRM-forward: lead ${eventType} in list ${listId} for user ${payload.userId}`);
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

type PreparedCalendlyDelivery =
  | { kind: 'ignored' }
  | { kind: 'ready'; jobPayload: CalendlyJobPayload; enqueueResult: EnqueueResult };

/** Verification + resolution + the enqueue attempt — everything that must finish
 *  BEFORE deciding how (and whether) to ack, since that decision now depends on
 *  enqueueResult (see the route handler below). All fast: DB lookups + HMAC, no
 *  external API calls, same as this file always documented for the verification
 *  step alone — moving the enqueue attempt in here too doesn't change that. */
async function prepareCalendlyDelivery(req: express.Request): Promise<PreparedCalendlyDelivery> {
  const rawBody = req.body as Buffer;
  const parsed = JSON.parse(rawBody.toString('utf8')) as CalendlyInviteePayload;

  if (parsed.event !== 'invitee.created') {
    console.log(`[Calendly Webhook] Ignored event: ${parsed.event}`);
    return { kind: 'ignored' };
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
    return { kind: 'ignored' };
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

  // claimImmediately: the common case ('enqueued') processes the job in this same
  // request, so the enqueue writes it straight in as 'processing' — no separate
  // claim call, no window where it sits 'pending' and claimable by the poller.
  let enqueueResult = await enqueueJob(QUEUE_SOURCE, jobPayload.uri, jobPayload, { claimImmediately: true });
  if (enqueueResult === 'unavailable') {
    // Greptile P1 on #2291 (round 10/11): this is the LAST chance at a durable
    // record before falling back to the synchronous path below — one retry
    // catches a transient write blip distinct from the table genuinely not
    // existing yet, same reasoning as the webhook-cleanup queue's enqueue retry.
    enqueueResult = await enqueueJob(QUEUE_SOURCE, jobPayload.uri, jobPayload, { claimImmediately: true });
  }

  return { kind: 'ready', jobPayload, enqueueResult };
}

router.post('/', async (req: express.Request, res: express.Response) => {
  let prepared: PreparedCalendlyDelivery;
  try {
    prepared = await prepareCalendlyDelivery(req);
  } catch (error: any) {
    console.error('[Calendly Webhook] Unexpected error:', error?.message ?? error);
    res.status(200).json({ received: true });
    return;
  }

  if (prepared.kind === 'ignored') {
    res.status(200).json({ received: true });
    return;
  }

  const { jobPayload, enqueueResult } = prepared;

  if (enqueueResult === 'duplicate') {
    console.log(`[Calendly Webhook] Duplicate delivery for ${jobPayload.uri} — already queued, skipping`);
    res.status(200).json({ received: true });
    return;
  }

  if (enqueueResult === 'enqueued') {
    // A durable row exists — ack now and process fire-and-forget, same pattern as
    // the HubSpot receiver. A crash after this point is recoverable by the poller
    // from that row, so there's no reason to make Calendly wait on it.
    res.status(200).json({ received: true });
    // Keeps the claim's updatedAt fresh for as long as this inline call actually
    // runs — without it, processing slower than the poller's stale threshold
    // looks identical to an abandoned claim, and the poller would claim and
    // re-run this same booking concurrently (Greptile P1 on #2291).
    const stopHeartbeat = startHeartbeat(QUEUE_SOURCE, jobPayload.uri);
    try {
      await processCalendlyWebhookJob(jobPayload);
      await markJobComplete(QUEUE_SOURCE, jobPayload.uri);
    } catch (processingError: any) {
      // Durable record exists — the poller will retry, so don't lose this silently.
      await markJobFailed(QUEUE_SOURCE, jobPayload.uri, processingError);
    } finally {
      stopHeartbeat();
    }
    return;
  }

  // enqueueResult === 'unavailable' (even after the retry in prepareCalendlyDelivery):
  // no durable record exists anywhere for this delivery. Greptile P1 on #2291
  // (round 10/11): acking 200 immediately and THEN processing fire-and-forget — the
  // pattern every other branch above uses — meant a crash in that exact window
  // silently lost the booking's attribution/CRM-forward with nothing left to
  // recover from, identical to the pre-ENG-524 gap this entire feature exists to
  // close. This is the one branch where there is no durable fallback, so it's the
  // one branch that can't afford to ack before finishing: process fully first, then
  // ack on success. On failure, respond 500 instead of a false 200 — Calendly's own
  // delivery-retry becomes the fallback durability mechanism in exactly this
  // degraded window, since processing here is already safe to re-run (CAPI dedupes
  // by eventId on Meta's side; CRM-forward dedupes via its own per-step markers).
  try {
    await processCalendlyWebhookJob(jobPayload);
    res.status(200).json({ received: true });
  } catch (processingError: any) {
    console.error('[Calendly Webhook] Processing failed with no durable record (queue unavailable):', processingError?.message ?? processingError);
    res.status(500).json({ error: 'Processing failed; please retry this delivery' });
  }
});

export default router;
