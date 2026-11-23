import * as crypto from 'crypto';
import express from 'express';
import { IncomingMessage } from 'http';
import { WebhookRequiredHeaders } from 'svix';
import { webhookService, ResendWebhookEvent } from '../services/webhookService';
import { emitResendEngagementSignal } from '../services/serverSignalEmitter';
import { emailEventsDb } from '../services/emailEventsDb';
import { leadListAlertService } from '../services/leadListAlertService';
import { crmDb, userDb, tempEmailDb } from '../services/db';
import { dripSequenceDb } from '../services/dripSequenceDb';
import { requiredChannels, leadIsReachable, enrollmentIdentity, enrollmentIdentityCandidates } from '../utils/leadReachability';
import { getUserIdByHubSpotPortalId, getAccountsByAttioWorkspaceId } from '../services/connectedAccountsDb';
import { parseHubSpotMergeEvent, repointMergedContactIds, HubSpotContactMerge } from '../services/hubspotContactMerge';
import { HubSpotService } from '../services/hubspotService';
import { AttioService } from '../services/attioService';
import { AttioAdapter } from '../services/adapters/attioAdapter';
import { applyAttioPersonEvent } from '../utils/attioPersonWebhookEvent';
import { getHubSpotClientSecretForAppId } from '../config/integrations';
import { externalCrmSyncService } from '../services/externalCrmSyncService';
import { agentModeService } from '../services/agentModeService';
import { resendService } from '../services/resendService';
import { sendRoadmapDeliveryEmail } from '../services/roadmapDelivery';
import { emmaEmailService } from '../services/emmaEmailService';
import { TEMP_EMAIL_PREFIX, TEMP_EMAIL_DOMAIN } from '../config';
import { isDoNotContact } from '../utils/leadContactStatus';
import { isPushedToSmartlead } from '../services/smartleadMarkers';
import { pruneClickIds } from '../utils/leadSchema';
import { resolveClientIdentityWithForwarded } from '../utils/clientIdentity';
import { normalizeAttribution, promoteAttributionFromCustomFields } from '../types/attribution';
import { mergeCustomFields } from '../utils/customFieldsGuard';
import { appendNotes, collectOverwrittenValues, mergeWithNotesRetry } from '../utils/leadSubmissionHistory';
import { onPublicFormSubmitted } from '../services/contactCaptureHooks';
import { buildCallConsentRecord, consentPhoneDigits, pageUrlOf, parseCallConsent, type CallConsentRecord } from '../services/voice/callConsent';
import { recordLeadCaptureFailure } from '../services/leadCaptureFailureService';
import { metaService } from '../services/metaService';
import { isSmokeTestLead, isSmokeTestPhone, phoneDigits, phoneLeadId } from '../utils/smokeTestLead';
import { enqueueJob, markJobComplete, markJobFailed, registerProcessor, startHeartbeat } from '../services/asyncJobQueue';
import { handleHardBounceRecipients } from '../services/emailDeliverabilityService';
// ENG-926 §C: the per-list budget and the per-account BUC pause used to live here as
// module-private state. Extracted so the CRM → Meta conversion relay throttles against the
// same counters instead of a second set that drifts out of step with this one.
import { shouldAttemptCapiSend, isCapiAccountPaused, recordCapiUsage } from '../services/capiSendBudget';
import { suppressLeadSideEffects, isSessionList, resolveSessionIdentity } from '../utils/sessionList';
import { getPhoneDedupeMode } from '../utils/phoneLeadDedupeMode';
import { fillBlankCustomFields, phoneDedupeKey, phoneNamesConflict, phoneNameSeed } from '../utils/phoneLeadDedupe';
import { findPhoneMatch } from '../services/phoneLeadMatch';
import { upsertSessionLead } from '../services/sessionUpsertService';
import { claimLeadSubmission, completeLeadSubmission, releaseLeadSubmission, resolveSubmissionKey } from '../services/leadSubmissionIdempotency';

// ─── HubSpot signature helpers ────────────────────────────────────────────────

/**
 * Verifies a HubSpot v1 webhook signature.
 * HubSpot computes: SHA-256(clientSecret + rawBody) and sends it as hex in
 * the X-HubSpot-Signature header. Must use the original raw bytes, not a
 * re-serialized JSON object (key order / whitespace would differ).
 */
function verifyHubSpotSignature(clientSecret: string, rawBody: Buffer, signature: string): boolean {
  try {
    const expected = crypto
      .createHash('sha256')
      .update(clientSecret + rawBody.toString('utf8'))
      .digest('hex');
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

/**
 * Resolve a contact's email for a webhook event that didn't include it.
 * Retries once with a freshly-created HubSpot service so a transient failure
 * (e.g. a concurrent token refresh rotating the access token → a stale 400/401)
 * doesn't silently drop the update. Logs each failure instead of swallowing it.
 */
async function resolveContactEmail(
  userId: string,
  portalId: string,
  objectId: string,
  svc: HubSpotService,
): Promise<string | null> {
  try {
    return await svc.getContactEmailById(objectId);
  } catch (err: any) {
    console.warn(
      `[HubSpot Webhook] getContactEmailById failed for contact ${objectId} (attempt 1, status ${err?.response?.status ?? 'n/a'}): ${err?.message} — retrying with a fresh token`,
    );
    try {
      const fresh = await HubSpotService.create(userId, portalId);
      return await fresh.getContactEmailById(objectId);
    } catch (err2: any) {
      console.error(
        `[HubSpot Webhook] getContactEmailById failed for contact ${objectId} (attempt 2, status ${err2?.response?.status ?? 'n/a'}): ${err2?.message} — skipping`,
      );
      return null;
    }
  }
}

const router = express.Router();


// ENG-449: real client-submission time for CAPI's event_time, instead of server
// CAPI-send time. Never trust client-supplied input raw — defensively bounded before
// ever threading it into a Meta API call. Anything implausible (absent, malformed,
// notably stale, or in the future beyond normal clock skew) resolves to `undefined`,
// letting sendCapiLeadEvent fall back to current server time exactly as it did before
// this field existed — this can only make event_time MORE accurate, never break an
// older/not-yet-regenerated capture route that simply never sends the field at all.
const CAPTURED_AT_MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
const CAPTURED_AT_MAX_PAST_STALENESS_MS = 60 * 60 * 1000;

function validatedEventTimeSeconds(capturedAtMs: unknown): number | undefined {
  if (typeof capturedAtMs !== 'number' || !Number.isFinite(capturedAtMs)) return undefined;
  const now = Date.now();
  if (capturedAtMs > now + CAPTURED_AT_MAX_FUTURE_SKEW_MS) return undefined;
  if (capturedAtMs < now - CAPTURED_AT_MAX_PAST_STALENESS_MS) return undefined;
  return Math.floor(capturedAtMs / 1000);
}


/**
 * ENG-2320: turn an `updateLead` payload that carries the WHOLE merged customFields map into one
 * that carries only the keys this write adds or changes, flagged for per-key atomic writes.
 *
 * A full-map `SET customFields = :map` overwrites every key a concurrent request stored since the
 * snapshot `existingCustomFields` was read (12 concurrent multi-step / double submits kept 1 of
 * 12). A key is picked when it is absent from the snapshot or its value differs by JSON
 * comparison, the same comparison the merges use to decide `changed`, so an unchanged value (and a
 * `source` restored from the stored row) is never rewritten: a stale snapshot cannot revert a key
 * this write does not own. Updates without customFields pass through untouched.
 */
function toKeyMergeUpdate(updates: any, existingCustomFields: Record<string, any>): any {
  if (!updates.customFields) return updates;
  const { customFields: mergedMap, ...rest } = updates;
  const patch = Object.fromEntries(
    Object.entries(mergedMap).filter(
      ([k, v]) =>
        !Object.prototype.hasOwnProperty.call(existingCustomFields, k) ||
        JSON.stringify(existingCustomFields[k]) !== JSON.stringify(v),
    ),
  );
  return { ...rest, customFields: patch, customFieldsKeyMerge: true };
}

/**
 * Fire-and-forget: enroll a single lead into any sequences that have
 * autoEnrollListIds containing this list. Mirrors the authenticated CRM path
 * (routes/crm.ts) so leads captured via the public forward-lead webhook also
 * land in list-bound drip sequences. Errors are logged but never surfaced.
 *
 * Exported for tests only. The crm.ts twin was exported for exactly this reason and
 * then guarded; this copy was left private, so reinstating its `if (!lead.email) return`
 * gate passed 219/219 webhooks tests — half the fix had no regression guard at all.
 */
export async function autoEnrollLeadInSequences(
  userId: string,
  listId: string,
  leadId: string,
  lead: { email?: string; linkedin?: string } | string,
): Promise<void> {
  // Channel-aware, matching the enrol routes and crm.ts's copy of this function.
  //
  // The `if (!leadEmail) return` gate meant that once enrolling a LinkedIn-only list
  // became possible, by-list enrolment switched auto-enroll ON for that list while
  // every lead arriving by webhook afterwards was silently dropped for having no
  // address — the capability worked once, for the leads present at the time.
  const leadObj = typeof lead === 'string' ? { email: lead } : (lead ?? {});
  try {
    const sequences = await dripSequenceDb.getSequencesByAutoEnrollList(userId, listId);
    for (const seq of sequences) {
      const channels = requiredChannels(seq);
      if (!leadIsReachable(leadObj, channels)) continue;
      const identity = enrollmentIdentity(leadObj);
      // An empty identity is invisible to the leadEmail-index dedup, so the row is
      // recreated and the lead re-messaged on every run.
      if (!identity) continue;
      await dripSequenceDb.bulkEnroll([{
        sequenceId: seq.sequenceId,
        userId,
        listId,
        leadId,
        leadEmail: identity,
        identityCandidates: enrollmentIdentityCandidates(leadObj),
      }]);
    }
  } catch (err) {
    console.error('[webhooks] autoEnrollLeadInSequences error:', err);
  }
}

// Resend webhook endpoint
router.post('/resend', async (req: express.Request, res: express.Response) => {
  try {
    // Initialize webhook service if not already done
    await webhookService.initialize();

    // Use the parsed body from Express (since we can't easily get raw body with signature verification)
    const payload = JSON.stringify(req.body);
    const headers = req.headers as IncomingMessage['headers'] & WebhookRequiredHeaders;

    // Verify webhook signature
    const event = webhookService.verifyWebhook(payload, headers);

    console.log(`Received Resend webhook: ${event.type} for email ${event.data.email_id}`);

    // Extract email domain
    // For email.received events, extract from data.to[0] (the recipient is the domain)
    // For all other events, extract from data.from (the sender is the domain)
    let emailDomain: string;
    if (event.type === 'email.received') {
      const recipient = Array.isArray(event.data.to) ? event.data.to[0] : event.data.to;
      emailDomain = webhookService.extractEmailDomain(recipient);
    } else {
      emailDomain = webhookService.extractEmailDomain(event.data.from);
    }

    // Generate deterministic event ID for deduplication
    const eventId = webhookService.generateEventId(event);

    // Check if event already exists (deduplication)
    const existingEvent = await emailEventsDb.getEventById(eventId);
    if (existingEvent) {
      // ENG-720: a prior delivery of this same eventId recorded the event but
      // never durably persisted the hard-bounce account flag (the write failed,
      // the process died, etc.). Retry the flag write on this duplicate instead
      // of silently acking it — otherwise the recipient stays unflagged forever,
      // because Resend never retries an event once we've returned 200 for it.
      if (existingEvent.eventType === 'email.bounced' && existingEvent.hardBounceFlagPending) {
        const bouncedTo = Array.isArray(event.data.to) ? event.data.to : (event.data.to ? [event.data.to] : []);
        const { failedRecipients } = await handleHardBounceRecipients(bouncedTo, event.data.bounce);
        if (failedRecipients.length > 0) {
          throw new Error(
            `[webhooks] retry of handleHardBounceRecipients failed to persist flag for: ${failedRecipients.join(', ')}`
          );
        }
        await emailEventsDb.clearHardBounceFlagPending(eventId);
      }
      console.log(`Event already exists, skipping duplicate: ${eventId}`);
      return res.status(200).json({
        message: 'Event already processed (duplicate)',
        eventId: eventId
      });
    }

    // Skip CRM event storage and alerts for Emma-related emails
    const eventTo = Array.isArray(event.data.to) ? event.data.to : (event.data.to ? [event.data.to] : []);
    const isEmmaEvent = emmaEmailService.isEmmaRelatedEvent(event.data.from || '', eventTo);

    if (!isEmmaEvent) {
      // Store the event in the database. Mark hardBounceFlagPending for bounce
      // events up front (ENG-720) so a duplicate delivery before the flag write
      // below succeeds can retry it instead of being swallowed by dedup.
      let emailEvent;
      try {
        emailEvent = await emailEventsDb.addEmailEvent(
          event, emailDomain, eventId, undefined, event.type === 'email.bounced'
        );
      } catch (error: any) {
        if (error?.isDuplicateEventId) {
          // ENG-720: a concurrent delivery of the same eventId won the write
          // between our existence check above and this put — the winner's
          // row (and its hardBounceFlagPending marker) is now the source of
          // truth. Retry the flag write off it, same as the pre-existing
          // dedup path, instead of silently acking a bounce nobody flagged.
          const winnerEvent = await emailEventsDb.getEventById(eventId);
          if (winnerEvent?.eventType === 'email.bounced' && winnerEvent.hardBounceFlagPending) {
            const bouncedTo = Array.isArray(event.data.to) ? event.data.to : (event.data.to ? [event.data.to] : []);
            const { failedRecipients } = await handleHardBounceRecipients(bouncedTo, event.data.bounce);
            if (failedRecipients.length > 0) {
              throw new Error(
                `[webhooks] retry of handleHardBounceRecipients failed to persist flag for: ${failedRecipients.join(', ')}`
              );
            }
            await emailEventsDb.clearHardBounceFlagPending(eventId);
          }
          console.log(`Event already exists (concurrent write), skipping duplicate: ${eventId}`);
          return res.status(200).json({
            message: 'Event already processed (duplicate)',
            eventId: eventId
          });
        }
        throw error;
      }
      try {
        await leadListAlertService.notifyForEmailEvent(emailEvent);
      } catch (alertError) {
        console.error('Failed to send lead list alert email:', alertError);
      }
    } else {
      console.log(`Skipping CRM event storage for Emma-related email: ${event.data.email_id}`);
    }

    // ENG-2686: platform-email engagement → hireemma.ai session list. The mapper drops anything not
    // sent by the AgentWeb system sender, so customer mail never reaches the funnel. Fire-and-forget.
    void emitResendEngagementSignal(event);

    // Handle specific event types
    switch (event.type) {
      case 'email.delivered':
        console.log(`Email delivered: ${event.data.email_id} to ${event.data.to.join(', ')}`);
        break;

      case 'email.bounced': {
        const bounceReason = event.data.bounce?.reason || 'Unknown reason';
        console.log(`Email bounced: ${event.data.email_id} - ${bounceReason}`);
        // Auto-flag bounced leads as do-not-contact
        const bouncedTo = Array.isArray(event.data.to) ? event.data.to : (event.data.to ? [event.data.to] : []);
        // ENG-720: a hard bounce to an *account's own address* flags the
        // account undeliverable so support/CS can see replies won't land.
        // Awaited (not fire-and-forget) so the flag is persisted before the
        // webhook ack — Resend won't retry a 200, so a dropped process here
        // would otherwise leave the account silently unflagged.
        // Do NOT swallow a persistence failure here: catching it and still
        // acknowledging 200 would tell Resend the event was durably handled
        // when the account flag was actually lost, and Resend never retries
        // a 200. Let a thrown error (or a reported failed recipient) reach
        // the outer catch below so the webhook fails and Resend retries.
        const { failedRecipients } = await handleHardBounceRecipients(bouncedTo, event.data.bounce);
        if (failedRecipients.length > 0) {
          throw new Error(
            `[webhooks] handleHardBounceRecipients failed to persist flag for: ${failedRecipients.join(', ')}`
          );
        }
        if (!isEmmaEvent) {
          await emailEventsDb.clearHardBounceFlagPending(eventId);
        }
        void (async () => {
          try {
            const users = await userDb.getUsersByEmailDomain(emailDomain);
            for (const user of users) {
              const lists = await crmDb.getLeadListsByUserId(user.userId);
              for (const list of (lists || [])) {
                for (const recipientEmail of bouncedTo) {
                  const lead = await crmDb.getLeadByEmail(list.listId, recipientEmail);
                  if (lead && !isDoNotContact(lead)) {
                    await crmDb.updateLead(list.listId, lead.leadId, {
                      contactStatus: 'do-not-contact',
                      contactStatusReason: 'bounced',
                      contactStatusNote: `Email bounced: ${bounceReason}`,
                      contactStatusUpdatedAt: new Date().toISOString(),
                      contactStatusUpdatedBy: 'system',
                      unsubscribedFromGroupEmail: true,
                      unsubscribedFromGroupEmailAt: new Date().toISOString(),
                    });
                    console.log(`Auto-flagged lead ${lead.leadId} in list ${list.listId} as do-not-contact (bounced)`);
                  }
                }
              }
            }
          } catch (err) {
            console.error('Error auto-flagging bounced lead:', err);
          }
        })();
        break;
      }

      case 'email.complained': {
        const complaintReason = event.data.complaint?.reason || 'Unknown reason';
        console.log(`Email complaint: ${event.data.email_id} - ${complaintReason}`);
        // Auto-flag complained leads as do-not-contact (spam report)
        const complainedTo = Array.isArray(event.data.to) ? event.data.to : (event.data.to ? [event.data.to] : []);
        void (async () => {
          try {
            const users = await userDb.getUsersByEmailDomain(emailDomain);
            for (const user of users) {
              const lists = await crmDb.getLeadListsByUserId(user.userId);
              for (const list of (lists || [])) {
                for (const recipientEmail of complainedTo) {
                  const lead = await crmDb.getLeadByEmail(list.listId, recipientEmail);
                  if (lead && !isDoNotContact(lead)) {
                    await crmDb.updateLead(list.listId, lead.leadId, {
                      contactStatus: 'do-not-contact',
                      contactStatusReason: 'complained',
                      contactStatusNote: `Marked email as spam: ${complaintReason}`,
                      contactStatusUpdatedAt: new Date().toISOString(),
                      contactStatusUpdatedBy: 'system',
                      unsubscribedFromGroupEmail: true,
                      unsubscribedFromGroupEmailAt: new Date().toISOString(),
                    });
                    console.log(`Auto-flagged lead ${lead.leadId} in list ${list.listId} as do-not-contact (spam complaint)`);
                  }
                }
              }
            }
          } catch (err) {
            console.error('Error auto-flagging complained lead:', err);
          }
        })();
        break;
      }

      case 'email.clicked':
        console.log(`Email clicked: ${event.data.email_id} - Link: ${event.data.click?.link}`);
        break;

      case 'email.opened':
        console.log(`Email opened: ${event.data.email_id}`);
        break;

      case 'email.received': {
        const toAddresses = Array.isArray(event.data.to) ? event.data.to : [event.data.to];
        console.log(`Email received: ${event.data.email_id} from ${event.data.from} to ${toAddresses.join(', ')}`);
        if (emmaEmailService.isEmmaEmail(toAddresses)) {
          // Process asynchronously - don't block webhook response
          void (async () => {
            try {
              await emmaEmailService.processInboundEmail({
                emailId: event.data.email_id,
                from: event.data.from,
                to: toAddresses,
                subject: event.data.subject,
              });
            } catch (err) {
              console.error('[EmmaEmail] Failed to process:', err);
            }
          })();
        }
        // Store temp emails (test+xxxxxx@updates.agentweb.pro) for Emma to read
        const tempPrefix = `${TEMP_EMAIL_PREFIX}+`;
        const tempRecipients = toAddresses.filter((addr: any) => {
          const bare = addr.toLowerCase().replace(/^.*<|>.*$/g, '').trim();
          return bare.startsWith(tempPrefix) && bare.endsWith(`@${TEMP_EMAIL_DOMAIN}`);
        });
        if (tempRecipients.length > 0) {
          void (async () => {
            try {
              const emailContent = await resendService.getReceivedEmailContent(event.data.email_id);
              for (const recipient of tempRecipients) {
                const bare = recipient.toLowerCase().replace(/^.*<|>.*$/g, '').trim();
                await tempEmailDb.save({
                  emailId: event.data.email_id,
                  toAddress: bare,
                  fromAddress: event.data.from,
                  subject: event.data.subject || '',
                  text: emailContent?.text || emailContent?.html || '',
                  receivedAt: new Date().toISOString(),
                });
                console.log(`[TempEmail] Stored email ${event.data.email_id} for ${bare}`);
              }
            } catch (err) {
              console.error('[TempEmail] Failed to store:', err);
            }
          })();
        }
        break;
      }

      default:
        console.log(`Unhandled event type: ${event.type}`);
    }

    res.status(200).json({
      message: 'Webhook processed successfully',
      eventId: eventId,
      emailDomain: emailDomain
    });

  } catch (error: any) {
    console.error('Webhook processing error:', error);
    res.status(400).json({
      message: 'Webhook processing failed',
      error: error.message
    });
  }
});

// ENG-492: the lead-SAVE path below is never rate-limited — a real customer's real lead must
// never be rejected, no matter how large a traffic spike (viral post, big ad spend, a featured
// TV segment can all legitimately blow past any fixed number we'd pick). Rate limiting here
// used to gate the whole request, including the save; that was reverted in favor of gating
// ONLY the optional, best-effort Meta CAPI send below (capiSendBudget), so the worst case of
// hitting a limit is "this one submission doesn't get forwarded to Meta" — never a lost lead.
//
// (A request-level limiter keyed by listId, as capiSendBudget is below, remains the right
// call regardless: `req.ip` now resolves correctly since app.ts configures `trust proxy`
// (ENG-493), but per-listId is still the meaningful boundary for this endpoint — a spike
// from one list's real traffic shouldn't be able to starve every other list's budget.)

// Public endpoint for forwarding leads to CRM
router.post('/forward-lead', async (req: express.Request, res: express.Response) => {
  // Set CORS headers to allow all origins for this endpoint
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');

  // Handle preflight OPTIONS request
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Extract listId from body
  const { listId } = req.body;

  if (!listId) {
    return res.status(400).json({
      success: false,
      message: 'listId is required in request body'
    });
  }

  // Get lead list and verify public access is enabled
  const leadList = await crmDb.getLeadListById(listId);
  if (!leadList) {
    // A live lander is POSTing to a list that doesn't exist — record the drop
    // so it surfaces instead of vanishing (the client swallows this 404).
    void recordLeadCaptureFailure({
      reason: 'list_not_found',
      listId,
      status: 404,
      source: req.body?.source,
      email: req.body?.email,
    });
    return res.status(404).json({
      success: false,
      message: 'Lead list not found'
    });
  }

  // Public access must be explicitly enabled (true)
  // Default behavior: disabled
  if (leadList.publicAccessEnabled !== true) {
    void recordLeadCaptureFailure({
      reason: 'public_access_disabled',
      listId,
      status: 403,
      source: req.body?.source,
      email: req.body?.email,
      userId: leadList.userId,
    });
    return res.status(403).json({
      success: false,
      message: 'Public access is not enabled for this lead list. Please enable it in the CRM settings.'
    });
  }

  // ENG-2837: the (listId, submission key) claim this request holds, if any, and whether a lead
  // write may have started under it. Declared outside the try so the catch can give the claim
  // back — but ONLY when no write was attempted; otherwise a retry could repeat the write.
  let submissionClaim: { key: string; ownerToken: string } | null = null;
  let leadWriteStarted = false;

  try {

    // ENG-2311: read from the list row the DATABASE returned, never from the body. One
    // decision, made once, consumed by every side-effect gate below.
    const suppressSideEffects = suppressLeadSideEffects(leadList);

    // Extract lead data from request body
    const {
      email,
      firstName,
      lastName,
      phone,
      company,
      title,
      notes,
      linkedin,
      source,
      customFields,
      attribution,
      // ENG-1499. First touch and last touch arrive as separate fields from the
      // lander. `attribution` is the acquiring click and never changes; this is
      // the most recent attributed visit, and for a returning visitor the two
      // genuinely differ. Absent for a single-visit lead.
      lastTouch: incomingLastTouch,
      utm,
      // Baked into the generated app/api/capture/route.ts (see buildCaptureRoute) — not
      // spread through automatically, this handler destructures a fixed field list rather
      // than `...req.body`, so these must be listed explicitly or they're silently dropped.
      pixelId,
      metaAccountId,
      eventId,
      // Meta's own first-party click-id cookies, read server-side from the Cookie header by
      // the platform-owned app/api/capture/route.ts (buildCaptureRoute) and forwarded here —
      // deterministic, no v0-authored client code involved.
      fbp,
      fbc,
      // Real client-submission time (Unix ms), captured at the top of the platform-owned
      // capture route (buildCaptureRoute) — NOT server CAPI-send time. Validated below
      // before ever being trusted.
      capturedAtMs,
      // ENG-926 §B: the visitor's OWN ip/user-agent, declared by the platform-owned capture
      // route (buildCaptureRoute) which is the only place they are knowable — the browser
      // posts to the site's own domain, we only ever see Vercel. Accepted through the
      // guarded path in clientIdentity.ts, never trusted as-is; see its doc comment for why
      // a body-supplied value is safe here only under three conditions.
      //
      // ⚠ NAMED `visitorIp`/`visitorUserAgent`, NOT `clientIp`/`clientUserAgent`, on purpose.
      // Any key this handler starts consuming stops appearing in customFields, where the
      // passthrough collector would otherwise put it. `clientIp` is a plausible enough name
      // that some existing caller may already be sending it and reading it back out of
      // customFields, and this route is public — we cannot enumerate its callers. A name
      // nobody is already using cannot silently take a field away from anyone. It also says
      // what the value actually is: the VISITOR, not whoever made this request.
      visitorIp: declaredClientIp,
      visitorUserAgent: declaredClientUserAgent,
      // ENG-2783: the call-consent notice the visitor agreed to, and the page it was on (declared by the capture
      // route, which is the only place the Referer is knowable). Both are listed in HANDLED_TOP_LEVEL_KEYS below so
      // they never become free-form custom fields, and neither is ever echoed in a response.
      callConsent: rawCallConsent,
      visitorPageUrl: declaredPageUrl,
    } = req.body;

    // ENG-2082: a contactable lead needs an email OR a phone, not specifically an email.
    // Requiring an email made a phone-only lander — an ordinary thing to want, and something
    // the generator will happily build — structurally incapable of ever producing a lead:
    // every submission was rejected here before a row was even constructed, with nothing
    // upstream warning the owner. Everything downstream already tolerated the absence:
    // createLead dedupes only "if email is provided", autoEnrollLeadInSequences returns
    // early on a falsy address, auto-send reports skipped_no_email, and Meta CAPI already
    // normalises `ph` as a first-class match key. This gate was the only thing requiring one.
    const normalizedEmail = typeof email === 'string' ? email.trim() : '';
    const normalizedPhone = typeof phone === 'string' ? phone.trim() : '';
    // Opt-in exception: a lander whose contact field is deliberately optional (e.g. the
    // WaterHeater.app free warranty check) sends `allowAnonymousLead: true` so the
    // submission is still recorded (with its customFields) instead of silently dropped.
    // Default behaviour for every other caller is unchanged.
    const allowAnonymousLead = req.body?.allowAnonymousLead === true;
    if (!normalizedEmail && !normalizedPhone && !allowAnonymousLead) {
      return res.status(400).json({
        success: false,
        message: 'Email or phone is required'
      });
    }

    // ENG-2837: server-side idempotency per (listId, submission key). A lander that lost the
    // response to a successful capture retries with the same key; the repeat must get the
    // ORIGINAL response back and must not write the lead or fire any side effect again.
    // Claimed only after every 4xx above, so a rejected request never holds a key. No key →
    // nothing here runs and the handler behaves exactly as before.
    const submissionKey = resolveSubmissionKey(req.body);
    if (submissionKey) {
      let claim: Awaited<ReturnType<typeof claimLeadSubmission>>;
      try {
        claim = await claimLeadSubmission(leadList.listId, submissionKey);
      } catch (claimErr: any) {
        // Fail CLOSED: the caller asked for exactly-once and we cannot tell whether this key is
        // already taken, so write nothing and fire nothing. The lander keeps the same key and
        // retries; nothing has happened that a retry could repeat.
        console.error(`[forward-lead] ENG-2837 submission claim store unavailable for list ${leadList.listId}; rejecting retryably: ${claimErr?.message || claimErr}`);
        res.setHeader('Retry-After', '2');
        return res.status(503).json({
          success: false,
          retryable: true,
          message: 'Lead capture is temporarily unavailable. Retry with the same submissionId.',
        });
      }
      if (claim.outcome === 'completed') {
        res.setHeader('Idempotent-Replayed', 'true');
        return res.status(claim.record.responseStatus).json(claim.record.responseBody);
      }
      if (claim.outcome === 'in_progress') {
        // Usually the original is still being processed: not a success (we cannot yet name its
        // leadId) and not a failure, and the same key retried shortly gets the original
        // response. But a claim is never taken over, so one left in_progress by a crashed
        // owner or a failure after a lead write may have started 409s forever for THIS
        // submission (other keys are unaffected) until an operator checks the lead and clears
        // the claim. Say so, so a client that keeps getting 409 escalates instead of looping.
        res.setHeader('Retry-After', '2');
        return res.status(409).json({
          success: false,
          retryable: true,
          message: 'This submission is already being processed. Retry with the same submissionId. '
            + 'If 409 persists for this submission, it needs operator reconciliation: contact support with the submissionId.',
        });
      }
      submissionClaim = { key: submissionKey, ownerToken: claim.ownerToken };
    }

    // Prepare lead data
    const leadData: any = {
      // Omitted entirely rather than written as '' when absent: `email` is the key of the
      // email-index GSI, and DynamoDB rejects an empty string for an index key attribute.
      ...(normalizedEmail ? { email: normalizedEmail } : {}),
      firstName: firstName?.trim() || '',
      lastName: lastName?.trim() || '',
      phone: normalizedPhone,
      company: company?.trim() || '',
      title: title?.trim() || '',
      notes: notes?.trim() || '',
      linkedin: linkedin?.trim() || '',
    };

    // ENG-926 §C: persist Meta's browser id so a conversion relayed WEEKS later (a deal
    // closing in the CRM) can still be matched to this person. `fbp` is a first-party
    // cookie read here at capture time and used immediately for the Lead event; by the
    // time the deal closes the cookie is long gone, and it is the strongest match signal
    // that survives nothing else.
    //
    // Stored as its own field rather than inside `firstTouch.clickIds`: every visitor gets
    // an fbp, including organic ones, so filing it under click IDs would make an organic
    // lead satisfy `attribute_exists(clickIds)` and read as paid-attributed — the exact
    // failure pruneClickIds's own contract warns about.
    if (typeof fbp === 'string' && fbp.trim()) {
      leadData.metaFbp = fbp.trim();
    }

    // ENG-926 §B: the other two Event Match Quality signals, kept for the same reason as
    // `fbp` above. Both were already read here, spent on the immediate Lead event, and then
    // discarded — so a conversion §C relays weeks later went to Meta with LESS identity than
    // we held at capture, for no reason other than nothing persisted them.
    //
    // Computed once here rather than inside the CAPI block below, because the lead write
    // needs them too and re-deriving the same value twice is how the two drift apart.
    // Reads x-forwarded-for directly rather than relying on req.ip: this endpoint is public
    // and wants the ORIGINATING address (leftmost of the chain), which is what callers here
    // expect regardless of the app-wide `trust proxy` hop count (ENG-493) used elsewhere for
    // rate-limit keying.
    //
    // ⚠ Landing pages do NOT reach this route from the browser — they POST to their own
    // Next.js route, which calls us server-side from Vercel (both `hireemma.ai`'s
    // /api/lead and the platform's own generated /api/capture). So this resolution is
    // frequently the FORWARDER, not the visitor: a real end-to-end run recorded
    // `44.202.76.171` + `node` for a lead that came from an actual iPhone. A wrong IP is
    // worse than no IP — Meta reads it as a match signal and a datacenter address matches
    // nobody — and these attributes are WRITE-ONCE in db.ts, so a wrong one is permanent.
    // resolveClientIdentityWithForwarded drops BOTH when the caller is not a browser AND has
    // declared nothing — and when it HAS declared, validates the declaration before use.
    const rawClientIp = (
      req.headers['x-forwarded-for']?.toString().split(',')[0] ?? req.ip ?? ''
    ).trim();
    const { clientIp: capturedClientIp, clientUserAgent: capturedUserAgent } =
      resolveClientIdentityWithForwarded(req.headers['user-agent'], rawClientIp, {
        clientIp: declaredClientIp,
        clientUserAgent: declaredClientUserAgent,
      });
    if (capturedClientIp) leadData.clientIp = capturedClientIp;
    if (capturedUserAgent) leadData.clientUserAgent = capturedUserAgent;

    // ENG-2783: validate and stamp the call consent BEFORE any lead write, so a new lead is created with it already
    // in the row and the call gates (which run from the create hook) can never see the lead without it. Anything
    // that does not validate is ignored (never a 400: the lead is still created) with one warning of the reason code
    // only; the lead then has no consent and the hot-lead call gate skips it (`no_call_consent`).
    let callConsentRecord: CallConsentRecord | null = null;
    const consentParse = parseCallConsent(rawCallConsent);
    if (consentParse.ok && !consentPhoneDigits(normalizedPhone)) {
      // Consent is for a number; with no usable phone in the same submission there is nothing to bind it to.
      console.warn('[forward-lead] call consent ignored: no_phone');
    } else if (consentParse.ok) {
      callConsentRecord = buildCallConsentRecord(consentParse, {
        phone: normalizedPhone,
        pageUrl: pageUrlOf(req.headers['referer']) ?? pageUrlOf(req.headers['origin']) ?? pageUrlOf(declaredPageUrl),
        ip: capturedClientIp,
        userAgent: capturedUserAgent,
      });
      leadData.system = { callConsent: callConsentRecord };
    } else if (consentParse.reason !== 'absent' && consentParse.reason !== 'unchecked') {
      console.warn(`[forward-lead] call consent ignored: ${consentParse.reason}`);
    }

    // Any top-level key this handler did NOT destructure above is caller data, and used to
    // be silently discarded. A landing page that posts its own fields flat (rather than
    // nested under `customFields`) got a 201 and a visible lead row with the data gone.
    // Real incident 2026-08-07: the healthcare lander's entire qualification payload
    // (qualified / annual_revenue / total_funding / can_start_tomorrow) vanished, so the
    // page's gate answers never reached the CRM while everything looked successful.
    //
    // Collected rather than added to the destructure list, because "remember to add your
    // field name here" is the failure mode itself — it has already been forgotten at least
    // once, and the miss is invisible.
    //
    // BOUNDED on purpose. This route is public, CORS-open and unauthenticated. Express
    // already rejects an oversized body with 413, but total size is not key count: a
    // compact payload can still carry hundreds of keys straight into storage.
    const HANDLED_TOP_LEVEL_KEYS = new Set([
      'listId', 'email', 'firstName', 'lastName', 'phone', 'company', 'title', 'notes',
      'linkedin', 'source', 'customFields', 'attribution', 'lastTouch', 'utm', 'pixelId',
      'metaAccountId', 'eventId', 'fbp', 'fbc', 'capturedAtMs',
      // ENG-926 §B. Absent from this set they would fall through into customFields as junk
      // instead of being read as identity — the passthrough collector is deliberately
      // "anything not handled above", so a newly-handled key MUST be added here too.
      // (`clientIp`/`clientUserAgent` are deliberately NOT handled — see the destructure.)
      'visitorIp', 'visitorUserAgent',
      'allowAnonymousLead',
      // ENG-2312. The session's start time, consumed below as part of the session identity
      // (it becomes the leadId's time prefix). Absent from this set it would be written into
      // customFields as junk on every event. `sessionId` is deliberately NOT added: LPs
      // already post it (flat or in customFields) and read it back out of customFields.
      'sessionStartMs',
      // ENG-2783: consumed above, never stored as free-form data.
      'callConsent', 'visitorPageUrl',
    ]);
    const PASSTHROUGH_MAX_KEYS = 50;
    const PASSTHROUGH_MAX_VALUE_LENGTH = 1000;

    const passthroughFields: Record<string, any> = {};
    let passthroughCount = 0;
    for (const [key, value] of Object.entries(req.body || {})) {
      if (HANDLED_TOP_LEVEL_KEYS.has(key)) continue;
      if (passthroughCount >= PASSTHROUGH_MAX_KEYS) break;
      passthroughFields[key] =
        typeof value === 'string' && value.length > PASSTHROUGH_MAX_VALUE_LENGTH
          ? value.slice(0, PASSTHROUGH_MAX_VALUE_LENGTH)
          : value;
      passthroughCount++;
    }

    // Add custom fields with source tracking. Explicit nested `customFields` wins over
    // top-level passthrough — an intentional shape beats an inferred one.
    const incomingCustomFields: Record<string, any> = {
      ...passthroughFields,
      ...(customFields && typeof customFields === 'object' ? customFields : {}),
      // Add source field (from request or default to 'api')
      source: source?.trim() || customFields?.source || 'api',
    };

    // ENG-2082: did the CALLER name a source, or did the line above invent one? The adopt
    // path needs the distinction. `source` is never absent from incomingCustomFields, so
    // merging it blindly lets the synthesized 'api' overwrite a real stored value whenever
    // some other field changes — step 1 of a multi-step lander posts "hero-form", step 2
    // posts only its answers, and the row ends up reading "api".
    const callerSuppliedSource = !!(source?.trim() || customFields?.source);

    // Attribution — accept either the new `attribution` shape or the legacy
    // flat `utm` shape (same normaliser controllers/auth.ts uses for signup).
    // If the client sends nothing, we stamp nothing; the CSV import and other
    // internal paths won't carry attribution.
    //
    // ENG-926 §A: then fill any keys still absent from allowlisted click IDs and
    // utm_* values sitting in customFields. A lander can capture attribution
    // perfectly and still deliver a lead with none, by posting it into the free-form
    // bag rather than the structured envelope — `hireemma.ai` forwards no
    // `attribution` and no `utm` at all, so its leads arrived with no firstTouch
    // whatsoever while the site, the POST and the resulting row all looked correct.
    //
    // Sourced from `incomingCustomFields` rather than the raw `customFields`, so a
    // lander that posts its click IDs FLAT at the top level is covered too — those
    // land in passthrough, and this handler's fixed destructure never reads them.
    // This is why the block sits here rather than above: it needs that merge.
    const touch = promoteAttributionFromCustomFields(
      incomingCustomFields,
      normalizeAttribution(attribution) ?? normalizeAttribution(utm),
    );
    if (touch) {
      leadData.firstTouch = touch;
      // ENG-1499. Prefer the lander's own last-touch when it sent one. Falling back
      // to `touch` keeps a single-visit lead's lastTouch populated rather than
      // empty — but where the two differ, storing first touch in both is exactly
      // the bug this closes: last-touch reporting silently showed first-touch
      // numbers, with nothing to indicate it.
      leadData.lastTouch = normalizeAttribution(incomingLastTouch) ?? touch;
    }

    // Check if lead already exists by email - merge instead of dropping.
    // ENG-2082: email is the only identity with an index to look it up by (email-index).
    // A phone-only lead is instead deduped at write time by a deterministic leadId below,
    // so two submissions of the same number collapse onto one row without needing a second
    // GSI. A phone-only lead that later submits WITH an email becomes its own row, which is
    // the same thing that already happens for two different emails.
    //
    // ENG-2312: a SESSION list with a valid session identity skips this lookup entirely.
    // email-index is an eventually-consistent GSI, so events 3–128 ms apart for one session
    // all missed each other here and each created its own row. Such a request instead targets
    // one deterministic (listId, leadId) item and lets a conditional put decide (see the
    // sessionIdentity branch below). Gated on the list row the DB returned, never on the body:
    // the body only supplies the identity to use, and an invalid or missing identity falls back
    // to exactly the behaviour below, so LPs that do not send sessionStartMs yet are unchanged.
    const sessionIdentity = isSessionList(leadList) ? resolveSessionIdentity(req.body) : null;
    let existingLead: any = normalizedEmail && !sessionIdentity
      ? await crmDb.getLeadByEmail(leadList.listId, normalizedEmail.toLowerCase())
      : null;

    // ENG-2123: an EMAIL-LESS capture can be a repeat of an earlier one on the same number. Off unless the
    // LEAD_PHONE_DEDUPE_MODE setting says otherwise (utils/phoneLeadDedupeMode.ts), never for session lists
    // or the synthetic smoke-test numbers (which have their own deterministic-id path below).
    const phoneMode = !normalizedEmail && !leadData.linkedin && normalizedPhone && !sessionIdentity && !isSessionList(leadList) && !isSmokeTestPhone(normalizedPhone)
      ? await getPhoneDedupeMode()
      : 'off';
    const phoneKey = phoneMode === 'off' ? '' : phoneDedupeKey(normalizedPhone);
    let phoneSharedLine = false;
    let existingFoundByPhone = false;
    if (phoneKey && (phoneMode === 'shadow' || phoneMode === 'on')) {
      try {
        const match = await findPhoneMatch(leadList.listId, phoneKey, leadData);
        // No phone number, name or lead id in this line: only counts and the decision.
        console.log(`[phone-dedupe] mode=${phoneMode} list=${leadList.listId} decision=${match.decision} candidates=${match.candidates} valid=${match.valid}`);
        if (phoneMode === 'on' && match.decision === 'match') { existingLead = match.lead; existingFoundByPhone = true; }
        // A known shared line is never collapsed, not even by the same-bucket exactly-once create.
        phoneSharedLine = match.decision === 'shared-line';
      } catch (lookupErr: any) {
        // A failed lookup must never fail the capture: create normally.
        console.warn(`[phone-dedupe] lookup failed, creating normally: ${lookupErr?.message || lookupErr}`);
      }
    }

    // Only stamp forwardedAt for new leads; for existing leads, preserve the original timestamp
    let mergedCustomFields: Record<string, any> = existingLead
      ? incomingCustomFields
      : { ...incomingCustomFields, forwardedAt: new Date().toISOString() };
    leadData.customFields = mergedCustomFields;

    let lead: any;
    let isNew = false;
    let isUpdated = false;
    let overwrittenValues: Record<string, unknown> = {};
    // ENG-2783: the phone the EXISTING lead held before this submission merged into it (consent binding, see below).
    let consentBasePhone: unknown;

    // The one merge routine for an EXISTING lead. Two entry points reach it: the
    // getLeadByEmail hit at the top of this handler, and a createLead that lost a race to a
    // concurrent submission of the same email (the adopt in the create branch below). Sharing
    // it keeps both on identical merge / attribution / isUpdated semantics. Assigns the
    // enclosing `lead` and `isUpdated`.
    const mergeIntoExistingLeadOnce = async (existingLead: any, opts: { fillBlanksOnly?: boolean } = {}): Promise<void> => {
      // ENG-2123: a lead matched by PHONE (not email) only has its blanks filled, never overwritten.
      const fillBlanksOnly = opts.fillBlanksOnly === true;
      consentBasePhone = existingLead.phone;
      // Merge new data into existing lead (only overwrite with non-empty values)
      const normalize = (value: any): string => {
        if (value === null || value === undefined) return '';
        return String(value).trim();
      };

      const updates: any = {};
      let changed = false;

      const standardFields = ['firstName', 'lastName', 'phone', 'company', 'title', 'notes', 'linkedin'] as const;
      for (const field of standardFields) {
        const newValue = normalize(leadData[field]);
        if (newValue) {
          const existingValue = normalize(existingLead[field]);
          if (existingValue !== newValue && !(fillBlanksOnly && existingValue)) {
            // ENG-2936: notes from a second form append; replacing lost the first submission.
            const value = field === 'notes' ? appendNotes(existingValue, newValue) : newValue;
            if (value !== existingValue) {
              updates[field] = value;
              changed = true;
            }
          }
        }
      }

      // Merge custom fields
      const existingCustomFields = existingLead.customFields || {};
      const mergedCf = fillBlanksOnly
        ? fillBlankCustomFields(existingCustomFields, mergedCustomFields)
        : { ...existingCustomFields, ...mergedCustomFields };
      // `source` is defaulted to 'api' whenever the caller omits it, so a blind spread lets
      // that synthesized value overwrite a real stored source on every repeat submission —
      // the same data loss the phone adopt path was fixed for, on the far more common email
      // path. Restore it unless THIS submission actually named one.
      if (!callerSuppliedSource && 'source' in existingCustomFields) {
        mergedCf.source = existingCustomFields.source;
      }
      // A phone-matched merge must not stamp the DEFAULTED 'api' source onto a row that never had one.
      if (fillBlanksOnly && !callerSuppliedSource && !('source' in existingCustomFields)) {
        delete mergedCf.source;
      }
      if (JSON.stringify(existingCustomFields) !== JSON.stringify(mergedCf)) {
        updates.customFields = mergedCf;
        changed = true;
      }

      // ENG-2123: what the caller's own data changed, before the attribution refresh below flips `changed`.
      const fieldsChanged = changed;
      // ENG-2936: keep what this submission overwrites in its history entry.
      overwrittenValues = collectOverwrittenValues(existingLead, updates);

      // Attribution merge (Lead UTM — mirrors the User schema contract).
      // The new-lead path stamps firstTouch+lastTouch via createLead; the merge
      // path previously dropped attribution entirely, leaving lastTouch DOA
      // (lastTouch === firstTouch forever for any repeat-touch lead).
      //   - lastTouch  : ALWAYS refreshed when this touch carries attribution.
      //   - firstTouch : immutable — only backfilled if the lead has none yet.
      //   - utmSource / utmMedium / clickIds : denormalized from firstTouch —
      //     only backfilled when absent, never overwritten.
      if (touch) {
        updates.lastTouch = touch;
        changed = true;
        if (!existingLead.firstTouch) {
          updates.firstTouch = touch;
          if (!existingLead.utmSource && touch.utm?.source) {
            updates.utmSource = touch.utm.source;
          }
          if (!existingLead.utmMedium && touch.utm?.medium) {
            updates.utmMedium = touch.utm.medium;
          }
          // ENG-1176. Same immutability contract as the UTM denorm above: the
          // click that acquired the lead is stamped once. A later touch
          // carrying a fresh gclid refreshes lastTouch and nothing else.
          const derivedClickIds = pruneClickIds(touch.clickIds);
          if (!existingLead.clickIds && derivedClickIds) {
            updates.clickIds = derivedClickIds;
          }
        }
      }

      // ENG-926 §B: backfill the match-quality signals on a repeat touch, and only when the
      // lead has none. A returning visitor's IP and device are not the ones that acquired
      // them, so overwriting would quietly degrade the very signal this is here to
      // strengthen.
      //
      // These checks are an OPTIMISATION, not the guarantee — they avoid issuing a write
      // that would change nothing, and keep the `lead.unchanged` response honest. The
      // write-once contract itself is enforced atomically in db.ts via `if_not_exists`,
      // because a read here followed by a write there is TOCTOU: two repeat submissions
      // racing while the field is absent would both pass this check.
      //
      // `metaFbp` is included because it was accepted by createLead alone: a lead that first
      // arrived WITHOUT an fbp and later submitted WITH one never got one. That is the
      // silent-drop failure db.ts's own comment describes, and this is the path it needed.
      //
      // Tracked SEPARATELY from `changed`, and that separation is load-bearing. `changed`
      // becomes `isUpdated`, which gates drip-sequence auto-enrolment, external CRM push and
      // the owner notification — real outbound email. Counting a silent metadata backfill as
      // a lead update would enrol a returning visitor into a sequence and notify the owner
      // because we quietly stored an IP, which is a side effect nobody asked for and the
      // caller cannot see coming. The write still happens; only the "this lead changed"
      // claim is withheld.
      let matchQualityBackfilled = false;
      if (!existingLead.metaFbp && leadData.metaFbp) {
        updates.metaFbp = leadData.metaFbp;
        matchQualityBackfilled = true;
      }
      if (!existingLead.clientIp && leadData.clientIp) {
        updates.clientIp = leadData.clientIp;
        matchQualityBackfilled = true;
      }
      if (!existingLead.clientUserAgent && leadData.clientUserAgent) {
        updates.clientUserAgent = leadData.clientUserAgent;
        matchQualityBackfilled = true;
      }

      if (changed || matchQualityBackfilled) {
        // ENG-2320: customFields goes to DynamoDB PER KEY (see toKeyMergeUpdate). `updates` keeps
        // the full merged map because `lead` below (what the response cascade renders) is built
        // from it.
        // ENG-2936: an appended note is read-modify-write, so guard it on the notes we read;
        // a concurrent same-email submission makes this throw and the caller re-merges.
        const write: any = { ...toKeyMergeUpdate(updates, existingCustomFields) };
        if (updates.notes !== undefined) write.expectedNotes = existingLead.notes === undefined ? '' : existingLead.notes;
        await crmDb.updateLead(leadList.listId, existingLead.leadId, write);
        // Only a user-visible change makes this an "update". See the ENG-926 §B note above:
        // isUpdated drives sequence enrolment, CRM sync and owner alerts, so a silent
        // metadata backfill deliberately does not set it.
        // A phone-matched repeat that filled nothing is not an update: the lastTouch refresh is still saved,
        // but it must not re-run drip enrolment, CRM sync or the owner alert.
        isUpdated = fillBlanksOnly ? fieldsChanged : changed;
      }

      lead = { ...existingLead, ...updates };
    };

    // Share the retry across email hits, phone matches, and create-race adoption.
    const mergeIntoExistingLead = (initial: any, opts: { fillBlanksOnly?: boolean } = {}): Promise<void> =>
      mergeWithNotesRetry<any>(
        initial,
        (current) => mergeIntoExistingLeadOnce(current, opts),
        (current) => crmDb.getLeadById(leadList.listId, current.leadId, { consistentRead: true }),
      );

    // ENG-2837: everything above is a read; from here on a lead write may happen (and may
    // succeed even if its call then throws), so a claimed key can no longer be given back.
    leadWriteStarted = true;

    if (sessionIdentity) {
      // ENG-2312. Exactly-once create + atomic merge for one (list, session): the shared
      // implementation (also used by the tracker ingest) lives in sessionUpsertService.
      ({ lead, isNew, isUpdated } = await upsertSessionLead({
        listId: leadList.listId,
        identity: sessionIdentity,
        leadData,
        customFields: mergedCustomFields,
        callerSuppliedSource,
        touch,
      }));
    } else if (existingLead) {
      await mergeIntoExistingLead(existingLead, { fillBlanksOnly: existingFoundByPhone });
    } else {
      // Create a new lead.
      // ENG-2082: with no email there is nothing to query on beforehand, so a phone-only
      // lead can key on its own normalized number and let the conditional create dedupe —
      // the ENG-787 mechanism createLead exposes for exactly this ("a caller that keys a
      // lead on a stable identity"). phoneDigits is the shared normalizer, so
      // +1 (415) 555-0142 and 4155550142 resolve to the same row. Derived by the shared
      // helper, never inline: the smoke test reads this id back to find the row it just
      // created, and a drift between the two would make it silently miss every capture.
      //
      // SYNTHETIC NUMBERS ONLY, deliberately. leadId is the table's RANGE key and
      // getLeadsByListId pages it with ScanIndexForward:false — "newest leadId
      // (timestamp-prefixed) first". `lead_ph_…` breaks that assumption: 'p' (0x70) beats
      // every digit, so a deterministic id sorts ABOVE every lead_<timestamp>_… row. Giving
      // real captures one would pin every phone-only lead to the top of the customer's list
      // forever, ordered by hash rather than recency, and — because the query caps at 1MB a
      // page regardless of Limit — eventually push their email leads off page one entirely.
      // Worst for phone-first landers, which are precisely who this path was built for.
      //
      // Real captures therefore take an ordinary timestamp id and lose the dedupe. This is a
      // FIX, not a precaution: 61cc335ea opened this endpoint to phone-only submissions and
      // is already an ancestor of main and deployed, so the deterministic id is live right
      // now and the first real phone-only capture writes a row that pins to the top of that
      // customer's list forever. AW-Leads currently holds zero lead_ph_ rows only because
      // none has landed yet.
      //
      // Losing the dedupe costs nothing measurable: 17.5k phone-only rows are already in
      // production (7.5% of all leads, 100 lists, created continuously Feb-Sep) and not one
      // has ever been deduped. Email leads dedupe through email-index; phone has no
      // equivalent GSI, which is the actual gap — ENG-2123 adds that index and restores
      // dedupe on top of it. Until then the primary key stops doubling as an index.
      const deterministicLeadId =
        !normalizedEmail && isSmokeTestPhone(normalizedPhone) ? phoneLeadId(normalizedPhone) : '';
      const createInput: any = {
        ...(deterministicLeadId ? { ...leadData, leadId: deterministicLeadId, failIfExists: true } : leadData),
        // Only added when true, so every non-session list passes byte-identical input.
        ...(suppressSideEffects ? { suppressSideEffects: true } : {}),
        // ENG-2321: an email lead on an ordinary list takes the exactly-once create (db.createLead).
        ...(normalizedEmail && !isSessionList(leadList) ? { emailUniqueCreate: true } : {}),
        // ENG-2123: the phone twin, when the rollout mode is not 'off' and the number is specific enough.
        ...(phoneKey && !phoneSharedLine ? { phoneUniqueCreate: true } : {}),
        // ENG-2837: a keyed capture fires the new-lead notification itself, AFTER its replay
        // record is durable, instead of createLead firing it at the write.
        ...(submissionClaim ? { deferCreatedNotification: true } : {}),
      };
      try {
        lead = await crmDb.createLead(leadList.listId, createInput, 'form_fill');
        isNew = true;
      } catch (createErr: any) {
        // The conditional create lost to an earlier submission of the same number. That is
        // this path's DEDUPE succeeding, not a fault: adopt the row that already exists and
        // report it as a duplicate. isNew stays false, so none of the new-lead side effects
        // (sequence enrolment, auto-draft/auto-send, owner notify, CAPI) fire a second time
        // for one person — which is the whole reason the number is keyed deterministically.
        // The winner is re-read by primary key: the carried row may predate an edit made since (a corrected
        // phone, an added email), and a row that no longer qualifies must not be merged into.
        const phoneWinner: any = createErr?.duplicatePhone && createErr.existingLead
          ? (await crmDb.getLeadById(leadList.listId, createErr.existingLead.leadId, { consistentRead: true })) || createErr.existingLead
          : null;
        if (phoneWinner && (
          phoneNamesConflict(phoneWinner, leadData)
          || String(phoneWinner.email ?? '').trim() !== ''
          || phoneDedupeKey(phoneWinner.phone) !== phoneKey
        )) {
          // ENG-2123: a concurrent submission on the same number that names a DIFFERENT person (a shared
          // household/office line). Merging would overwrite the first person's name and answers with the
          // second's, so keep two rows - exactly what happened before this feature - on an ordinary id.
          //
          // Everyone who names that same other person shares ONE separate row: the id is bucketed on the number
          // AND the normalized names, so a burst of same-named submissions collapses instead of writing one row each.
          let separateHandled = false;
          if (phoneNamesConflict(phoneWinner, leadData)) {
            try {
              lead = await crmDb.createLead(leadList.listId, { ...createInput, phoneUniqueIdSeed: phoneNameSeed(leadData) }, 'form_fill');
              isNew = true;
              separateHandled = true;
            } catch (nameErr: any) {
              if (!(nameErr?.duplicatePhone && nameErr.existingLead)) throw nameErr;
              const sameName = (await crmDb.getLeadById(leadList.listId, nameErr.existingLead.leadId, { consistentRead: true })) || nameErr.existingLead;
              if (String(sameName.email ?? '').trim() === '' && phoneDedupeKey(sameName.phone) === phoneKey && !phoneNamesConflict(sameName, leadData)) {
                mergedCustomFields = incomingCustomFields;
                leadData.customFields = mergedCustomFields;
                await mergeIntoExistingLead(sameName, { fillBlanksOnly: true });
                separateHandled = true;
              }
            }
          }
          if (!separateHandled) {
            const { phoneUniqueCreate: _separate, ...separateInput } = createInput;
            lead = await crmDb.createLead(leadList.listId, separateInput, 'form_fill');
            isNew = true;
          }
        } else if ((createErr?.duplicateEmail || createErr?.duplicatePhone) && createErr.existingLead) {
          // The email twin of the case below: getLeadByEmail (eventually-consistent GSI) missed
          // above, but createLead's own pre-check found a row a concurrent submission wrote in
          // between. That is a REPEAT submission of an existing lead, not a failure — throwing
          // here returned 500 plus an api.lead_failed owner alert and dropped the visitor's
          // data. Adopt the carried row through the same merge an existing lead gets from the
          // start. forwardedAt was minted for a create; an existing lead keeps its original, so
          // drop it exactly as the existing-lead stamp above does.
          mergedCustomFields = incomingCustomFields;
          leadData.customFields = mergedCustomFields;
          // The carried row came off the eventually-consistent email-index GSI, so it can be
          // OLDER than what the race winner is still writing. The merge below writes per key
          // (ENG-2320), so a stale snapshot no longer drops the winner's keys, but it still
          // decides `changed` and the write-once backfills — so re-read by primary key,
          // consistently (one GetItem, race path only); fall back to the carried row only if
          // that read comes back empty.
          const fresh = phoneWinner || await crmDb.getLeadById(leadList.listId, createErr.existingLead.leadId, { consistentRead: true });
          await mergeIntoExistingLead(fresh || createErr.existingLead, { fillBlanksOnly: !!createErr?.duplicatePhone });
        } else if (!createErr?.leadAlreadyExists) {
          throw createErr;
        } else {
          // Consistent read: the conditional write just told us this exact key exists, so an
          // eventually-consistent miss here would be a lie, not an answer.
          lead = await crmDb.getLeadById(leadList.listId, deterministicLeadId, { consistentRead: true });
          if (!lead) {
            // Still nothing — the winner's row was deleted between its write and this read, or
            // the read failed in a way that returned empty. Do NOT throw: throwing reaches the
            // handler's catch and returns 500 to the lander for a submission that was, from
            // the visitor's point of view, accepted. Degrade to the id we know, the same way
            // linkedInInviteCrmMirror does on this identical race.
            console.warn(
              `[webhooks] ENG-2082: adopted lead ${deterministicLeadId} not readable after a ` +
                `losing conditional create in ${leadList.listId} — reporting the duplicate anyway.`
            );
            lead = { leadId: deterministicLeadId, listId: leadList.listId, ...leadData };
          }

          // ENG-2082 follow-up: this path is not only the concurrent race. A deterministic id
          // plus failIfExists means EVERY repeat submission from the same number lands here,
          // forever. Without a merge the second submission returns success and silently drops
          // whatever it carried — the exact failure this file documents for flat custom fields
          // ("a 201 and a visible lead row with the data gone"), reproduced for a multi-step
          // phone-only lander whose step 2 posts the qualification answers.
          //
          // Mirrors the existingLead branch's rules deliberately rather than sharing them:
          // that branch is the well-trodden email path and is not worth destabilising here.
          const normalizeAdopted = (value: any): string =>
            value === null || value === undefined ? '' : String(value).trim();
          consentBasePhone = lead.phone;
          const adoptedUpdates: any = {};
          let adoptedChanged = false;

          for (const field of ['firstName', 'lastName', 'phone', 'company', 'title', 'notes', 'linkedin'] as const) {
            const newValue = normalizeAdopted(leadData[field]);
            if (newValue && normalizeAdopted(lead[field]) !== newValue) {
              adoptedUpdates[field] = newValue;
              adoptedChanged = true;
            }
          }

          const adoptedExistingCustom = lead.customFields || {};
          const adoptedIncomingCustom = leadData.customFields || {};
          const adoptedMergedCustom: Record<string, any> = { ...adoptedExistingCustom };
          let customChanged = false;
          // Stamped by this handler rather than sent by the visitor: `forwardedAt` is minted
          // fresh on every submission because this branch builds leadData as if creating, and
          // `source` defaults to 'api' when the caller sends none (see the destructure above).
          // Neither is visitor data, and letting either mark a resubmission as a real update
          // would drive CRM sync and owner alerts off a duplicate that carried nothing new.
          // They are still merged through — they just do not, alone, constitute a change.
          const SYSTEM_CUSTOM_KEYS = new Set(['forwardedAt', 'source']);
          for (const [key, value] of Object.entries(adoptedIncomingCustom)) {
            if (value === undefined || value === null || value === '') continue;
            if (normalizeAdopted(adoptedExistingCustom[key]) !== normalizeAdopted(value)) {
              adoptedMergedCustom[key] = value;
              if (!SYSTEM_CUSTOM_KEYS.has(key)) customChanged = true;
            }
          }
          if (customChanged) {
            // Put the STORED system values back before writing. `forwardedAt` is minted fresh
            // on this branch (existingLead is null, so line ~700 stamps a new one), and the
            // merged object would otherwise carry it — overwriting the lead's real capture
            // time whenever anything else changed. That contradicts the invariant stated at
            // the stamp site ("for existing leads, preserve the original timestamp") and is
            // customer-visible: forwardedAt is what the owner alert renders as the received
            // time. The email branch avoids this by omitting the key entirely; this branch
            // cannot, so it restores it.
            // forwardedAt unconditionally: it is minted by THIS handler on every submission
            // (existingLead is null on this branch), so the merged copy is never the
            // visitor's data and the stored capture time must win. `source` is handled by
            // provenance just below, exactly as the email branch now does — a caller-supplied
            // source wins, a defaulted one never overwrites.
            if ('forwardedAt' in adoptedExistingCustom) {
              adoptedMergedCustom.forwardedAt = adoptedExistingCustom.forwardedAt;
            }
            // Restore `source` ONLY when this submission did not name one. A caller-supplied
            // source is real data and must win (that is the multi-step case); a defaulted one
            // must never overwrite what is already stored.
            if (!callerSuppliedSource && 'source' in adoptedExistingCustom) {
              adoptedMergedCustom.source = adoptedExistingCustom.source;
            }
            adoptedUpdates.customFields = adoptedMergedCustom;
            adoptedChanged = true;
          }

          if (adoptedChanged) {
            // ENG-2320: per key, like the email branch (only the keys this adopt adds or changes).
            await crmDb.updateLead(leadList.listId, lead.leadId, toKeyMergeUpdate(adoptedUpdates, adoptedExistingCustom));
            lead = { ...lead, ...adoptedUpdates };
            // A real, user-visible change — same meaning the email branch gives isUpdated.
            isUpdated = true;
          }
        }
      }
    }

    // ENG-2783: consent on a REPEAT submission. A new lead already carries it (written in the create input above). An
    // existing lead that has none gets it recorded now, with a write that creates `system.callConsent` only if absent:
    // the FIRST granted record is kept forever and a later one (same or different text) is IGNORED, not appended, so
    // the proof of what the person first agreed to is never replaced. This runs before the dispatch below, which
    // re-reads the lead consistently. A repeat submission DOES dispatch the call gates (notifyRepeatSubmission ->
    // dispatchLeadCreated(..., submission)), and the only call-specific refusal that sticks is `has_record` (a call
    // already happened), so a lead first skipped as `no_call_consent` and now resubmitting WITH consent is called by
    // THAT submission, if every other gate passes. That is intended and visible: the earlier `call.skipped` stays on the
    // timeline and the new `call.started` follows it. A failed write only warns: the lead is then skipped, never called.
    // Phone binding. The record is consent for the number the visitor typed, and is only recorded on an existing lead when that
    // number is the one the lead ALREADY held before this submission: otherwise anyone who knows a lead's email could tick the box
    // with their own number and attach it to the lead. Can a resubmission CHANGE the stored phone? Yes: an email-matched merge
    // overwrites a differing phone with the submitted one, a phone-matched merge (fillBlanksOnly) and the adopt path only fill blanks or
    // overwrite on the same key. A changed phone never inherits an old record because the gate (hasCallConsent) requires the
    // record's phoneDigits to equal the lead's CURRENT phone.
    if (callConsentRecord && !isNew && lead?.leadId && !lead.system?.callConsent) {
      if (!callConsentRecord.phoneDigits || consentPhoneDigits(consentBasePhone) !== callConsentRecord.phoneDigits) {
        console.warn('[forward-lead] call consent ignored: phone_mismatch');
      } else try {
        const created = await crmDb.createLeadSystemRecordOnce(leadList.listId, lead.leadId, 'callConsent', callConsentRecord);
        if (created) lead = { ...lead, system: { ...(lead.system || {}), callConsent: callConsentRecord } };
      } catch (consentErr: unknown) {
        console.warn(`[forward-lead] call consent not recorded on existing lead: ${consentErr instanceof Error ? consentErr.name : 'error'}`);
      }
    }

    // Inserts already notify at the CRM write boundary. Every accepted repeat form
    // submission also notifies, even when it merges into an unchanged existing row.
    // A server-generated event ID keeps distinct submissions separate on recovery.
    //
    // Gated on the synthetic check for the same reason as the cascade far below: this is a
    // real org lead notification (Slack/email) and the smoke test must not send one. It
    // sits ABOVE that gate, so it was firing — and `!isNew` is now EXCLUSIVELY the
    // smoke-test adopt path for a phone-only capture, since deterministicLeadId was
    // narrowed to synthetic numbers. buildSmokeTestPhone picks one of only 100 reserved
    // numbers at random, so collisions are routine by construction and every colliding
    // resubmission notified a real human about a fake lead. The gate's own comment claims
    // it skips "the whole cascade"; this is the part that escaped it.
    // ENG-2837: dispatched below, after the replay record (if any) is durable.
    const notifyRepeatSubmission = !suppressSideEffects && !isNew && !isSmokeTestLead(lead) && !isSmokeTestLead(leadData);

    // Send API response immediately so caller is not blocked
    const responseStatus = isNew ? 201 : 200;
    const responseBody = isNew
      ? { success: true, message: 'Lead forwarded successfully', event: 'lead.created', leadId: lead.leadId, listId: leadList.listId }
      : isUpdated
        ? { success: true, message: 'Lead updated successfully', event: 'lead.updated', leadId: lead.leadId, listId: leadList.listId }
        : { success: true, message: 'Lead already exists with no changes', event: 'lead.unchanged', leadId: lead.leadId, listId: leadList.listId };

    // ENG-2837: make the replay record durable BEFORE answering and before ANY side effect
    // (the notifications just below, CAPI / CRM sync / email further down), so a retry can
    // only ever see "completed" and replay. If it cannot be recorded, the lead is saved but
    // the claim stays in_progress for good: we fire nothing and answer retryably. Retries
    // then get 409 instead of a second write or a second round of side effects. Safety over
    // liveness — the owner is not notified about this lead until the claim is cleared by hand.
    if (submissionClaim) {
      const claim = submissionClaim;
      submissionClaim = null;
      let recorded = false;
      try {
        recorded = await completeLeadSubmission(leadList.listId, claim.key, claim.ownerToken, {
          leadId: lead.leadId, responseStatus, responseBody,
        });
      } catch (completeErr: any) {
        console.error(`[forward-lead] ENG-2837 completion store error for lead ${lead.leadId}: ${completeErr?.message || completeErr}`);
      }
      if (!recorded) {
        console.error(`[forward-lead] ENG-2837 lead ${lead.leadId} saved on list ${leadList.listId} but its submission record was not written; claim left in_progress, side effects withheld`);
        res.setHeader('Retry-After', '2');
        return res.status(503).json({
          success: false,
          retryable: true,
          message: 'This submission could not be confirmed. Retry with the same submissionId.',
        });
      }
    }

    if (isNew && submissionKey && !sessionIdentity) {
      // The keyed create deferred this out of createLead (deferCreatedNotification); same call
      // createLead would have made, so the notifier's own gates (session lists etc.) still apply.
      void import('../services/orgLeadNotificationService')
        .then(({ dispatchLeadCreated }) => dispatchLeadCreated(leadList.listId, lead.leadId, 'form_fill'))
        .catch(() => console.warn('[leadNotifications] hook failed', { listId: leadList.listId, leadId: lead.leadId }));
    }
    if (notifyRepeatSubmission) {
      // A caller-supplied key makes the notification id deterministic, so the notifier dedupes
      // it too. Otherwise a server-generated id keeps distinct submissions separate on recovery.
      const submission = {
        submissionId: submissionKey ? `client:${submissionKey}` : crypto.randomUUID(),
        submittedAt: new Date().toISOString(),
      };
      void import('../services/orgLeadNotificationService')
        .then(({ dispatchLeadCreated }) => dispatchLeadCreated(leadList.listId, lead.leadId, 'form_fill', submission))
        .catch(() => console.warn('[leadNotifications] submission hook failed', { listId: leadList.listId, leadId: lead.leadId }));
    }
    // ENG-2936: one append-only history entry per distinct submission on the contact's
    // AW-ContactEvents timeline (existing table; logEvent dedupes on sourceRecordId, and a
    // replayed submissionId already returned above from the ENG-2837 claim).
    if (!suppressSideEffects && lead?.email && !isSmokeTestLead(lead) && !isSmokeTestLead(leadData)) {
      void onPublicFormSubmitted({
        email: String(lead.email),
        sourceRecordId: `forward-lead:${leadList.listId}:${submissionKey ? `client:${submissionKey}` : crypto.randomUUID()}`,
        formName: (incomingCustomFields?.formName || incomingCustomFields?.form_name || leadData.customFields?.source || null) as string | null,
        payload: {
          listId: leadList.listId,
          leadId: lead.leadId,
          event: responseBody.event,
          submittedAt: new Date().toISOString(),
          pageUrl: incomingCustomFields?.page_url || incomingCustomFields?.pageUrl || touch?.landingUrl || pageUrlOf(declaredPageUrl) || null,
          notes: leadData.notes || '',
          fields: {
            firstName: leadData.firstName, lastName: leadData.lastName, phone: leadData.phone,
            company: leadData.company, title: leadData.title, linkedin: leadData.linkedin,
            customFields: incomingCustomFields,
          },
          overwrittenValues,
        },
      }).catch(() => undefined);
    }
    res.status(responseStatus).json(responseBody);

    // Server-side Meta Conversions API send. Fire-and-forget (same pattern as the
    // roadmap-delivery email below) — this must never delay or affect the lead-save response
    // already sent above, and a Meta-side failure must never be surfaced as a lead-capture
    // failure (the lead itself already saved successfully).
    // ENG-449 gap #3: never send a real CAPI conversion event for the automated smoke test's
    // synthetic lead — CAPI's correctness is already covered by unit tests (metaService.capi
    // .test.ts) and doesn't depend on v0-authored code, so there's nothing extra to verify
    // live here, only real-ad-account conversion data to needlessly pollute.
    if (!suppressSideEffects && pixelId && metaAccountId && eventId && !isSmokeTestLead(leadData) && shouldAttemptCapiSend(leadList.listId) && !isCapiAccountPaused(metaAccountId)) {
      void (async () => {
        try {
          const owner = await userDb.getUserById(leadList.userId);
          const { getMetaAccountCredentials } = await import('../services/metaAccountCredentials');
          const { accessToken } = await getMetaAccountCredentials(owner, leadList.userId, metaAccountId);
          // Resolved once at capture (see the ENG-926 §B block above) so the value sent here
          // and the value stored on the lead are the same one, not two independent reads.
          //
          // OMITTED rather than defaulted when the caller was a forwarding server. This
          // previously passed `'unknown'`, which metaService treats as truthy and sends
          // verbatim as `client_ip_address` — a literal placeholder string presented to
          // Meta as a match signal. Before that it sent the forwarder's real datacenter IP,
          // which is worse: it looks valid and matches nobody. Sending neither is correct.
          const result = await metaService.sendCapiLeadEvent(pixelId, accessToken, {
            eventId,
            email: leadData.email,
            firstName: leadData.firstName,
            lastName: leadData.lastName,
            phone: leadData.phone,
            clientIp: capturedClientIp,
            userAgent: capturedUserAgent,
            sourceUrl: req.headers['referer'],
            fbp: typeof fbp === 'string' ? fbp : undefined,
            fbc: typeof fbc === 'string' ? fbc : undefined,
            eventTimeSeconds: validatedEventTimeSeconds(capturedAtMs),
          });
          if (!result.success) {
            console.error(`[CAPI] Lead event send failed for pixel ${pixelId}: ${result.error}`);
          }
          recordCapiUsage(metaAccountId, result.usage);
        } catch (err: any) {
          console.error(`[CAPI] Unexpected error sending Lead event for pixel ${pixelId}: ${err?.message}`);
        }
      })();
    }

    // WORKAROUND (2026-06-04): deliver the AI Readiness roadmap PDF directly.
    // The proper path (list-bound drip sequence) is not usable yet — the
    // sequence feature is not production ready and this webhook does not
    // auto-enroll (AGW-37509247-c951-8108-9545-fb47c0914bdc). Do not gate this
    // only on `isNew`: popup partials / AI Eval pretriggers can create the lead
    // before the final roadmap submit arrives with a valid stage.
    const roadmapCustomFields = lead.customFields || mergedCustomFields || {};
    if (!suppressSideEffects && !roadmapCustomFields.roadmapEmailSentAt) {
      void (async () => {
        const sent = await sendRoadmapDeliveryEmail({
          to: lead.email,
          stage: roadmapCustomFields.stage,
          source: roadmapCustomFields.source,
          firstName: lead.firstName,
        });

        if (!sent) return;

        try {
          // ENG-2320: write ONLY the two keys this marker owns, per key. It runs seconds after
          // the merge, from an in-memory snapshot; spreading that snapshot back as the whole map
          // overwrote every key a concurrent submission stored in the meantime (it could undo
          // the merge's own per-key writes).
          await crmDb.updateLead(leadList.listId, lead.leadId, {
            customFields: {
              roadmapEmailSentAt: new Date().toISOString(),
              roadmapEmailStage: Number(roadmapCustomFields.stage),
            },
            customFieldsKeyMerge: true,
          });
        } catch (markError) {
          console.error('[roadmapDelivery] sent but failed to mark lead:', markError);
        }
      })();
    }

    // After response is sent: auto-draft, auto-send, and alert (fire-and-forget, fully awaited internally)
    // Deliberately not `isNew &&`. Before the phone-only adopt path existed, a synthetic
    // lead could only arrive as a new row, so gating on isNew was equivalent. That path can
    // now set isUpdated, which reaches the side-effect cascade below — HubSpot/Attio sync,
    // sequence enrolment, an agent-mode draft — for a lead in the reserved smoke-test range.
    // `leadData` is checked too: on the adopt path `lead` may be the stored row, whose phone
    // formatting can differ from the synthetic value this submission actually carried.
    if (isSmokeTestLead(lead) || isSmokeTestLead(leadData)) {
      // ENG-449 gap #3: the automated post-deploy smoke test submits a REAL lead through a
      // customer's real form to verify the pipeline works, then deletes the row. But deleting
      // the row doesn't undo an already-fired side effect — HubSpot/Attio sync, drip-sequence
      // enrollment, and (worse) a real auto-sent email to a fake address would all have
      // already fired by the time the row is deleted, since they're dispatched fire-and-forget
      // the instant the lead is created. Skip the whole cascade for a recognized synthetic
      // lead; the lead row itself is still created/returned normally above so the smoke
      // test's CRM-landing check still works.
      console.log(`[webhooks] Synthetic smoke-test lead (${lead.email || lead.phone || lead.leadId}) — skipping CRM sync/sequence enrollment/auto-draft/auto-send/owner-notify side effects`);
    } else if ((isNew || isUpdated) && !suppressSideEffects) {
      // ENG-2311: a session list is skipped here (HubSpot/Attio sync, sequence enrolment,
      // auto-draft/auto-send, owner alert) — see utils/sessionList.ts. The lead row itself
      // is still created/updated and the response is unchanged.
      //
      // Real-time push to any connected external CRM (HubSpot / Attio). The
      // authenticated UI create/update routes do this inline; inbound capture
      // (landing pages, lead-forward webhooks) did not, so form leads only ever
      // reached HubSpot on a manual push. Use the list owner's userId since the
      // webhook request is unauthenticated. Fire-and-forget — autoSyncLead
      // swallows its own errors and no-ops when auto-sync is off / unconfigured.
      const crmSyncEvent = isNew ? 'created' : 'updated';
      void externalCrmSyncService.autoSyncLead(leadList.userId, leadList.listId, lead, 'hubspot', crmSyncEvent)
        .catch((err) => console.error('[webhooks] HubSpot auto-sync error:', err?.message ?? err));
      void externalCrmSyncService.autoSyncLead(leadList.userId, leadList.listId, lead, 'attio', crmSyncEvent)
        .catch((err) => console.error('[webhooks] Attio auto-sync error:', err?.message ?? err));

      // Enroll the lead into any list-bound drip sequences (uses the list
      // owner's userId since the public webhook request is unauthenticated).
      // Pass the LEAD, not just its address: a LinkedIn-only lead arriving by webhook
      // was dropped by the old email-only gate even when the watching sequence is
      // LinkedIn-only.
      void autoEnrollLeadInSequences(leadList.userId, leadList.listId, lead.leadId, {
        email: (lead as any).email ?? '', linkedin: (lead as any).linkedin ?? '',
      });

      void (async () => {
        try {
          let autoDraftStatus: string | undefined;
          let autoDraftError: string | undefined;
          let autoSendStatus: string | undefined;

          if (leadList.autoDraftEnabled === true) {
            const sourceLabel = String(mergedCustomFields.source || 'API form submission');
            const configuredInstruction = typeof leadList.autoDraftInstruction === 'string'
              ? leadList.autoDraftInstruction.trim()
              : '';
            const autoDraftInstruction = `Create an initial outreach message for this new lead from ${sourceLabel}. Keep it concise, personalized, and include a clear next step.${configuredInstruction ? `\n\nAdditional instruction:\n${configuredInstruction}` : ''}`;
            const autoDraftSessionId = `auto_draft_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

            try {
              const autoDraftResult = await agentModeService.updateEmailDraftForLead(
                leadList.listId,
                lead.leadId,
                autoDraftInstruction,
                autoDraftSessionId,
                leadList.userId,
                'text'
              );
              if (autoDraftResult?.skipped) {
                // Nothing to draft is not a failure. Without this, a lead with no contact
                // channel reports autoDraftStatus='failed' and the reason lands in the
                // owner alert — so every phone-only capture into an autoDraft list would
                // email its owner a failure notice. Mirrors autoSend's 'skipped_no_email'.
                console.log(`Auto draft skipped (${autoDraftResult.reason || 'no_contact_channel'}) for lead ${lead.leadId}`);
                autoDraftStatus = 'skipped_no_email';
              } else if (!autoDraftResult?.success) {
                const errMsg = autoDraftResult?.error || autoDraftResult?.message || 'Unknown auto-draft error';
                console.error('Auto draft creation failed:', errMsg);
                autoDraftStatus = 'failed';
                autoDraftError = errMsg;
              } else {
                autoDraftStatus = 'created';

                // Auto-send the draft if enabled
                if (leadList.autoSendEnabled === true && autoDraftResult?.data?.email) {
                  const draftEmail = autoDraftResult.data.email;
                  const leadEmail = lead.email;

                  if (!leadEmail) {
                    console.error('Auto send skipped: lead has no email address');
                    autoSendStatus = 'skipped_no_email';
                  } else {
                    // Check if an email was already auto-sent to this lead today
                    const freshLead = await crmDb.getLeadById(leadList.listId, lead.leadId);
                    if (freshLead?.lastAutoSendAt) {
                      const lastSendDate = new Date(freshLead.lastAutoSendAt).toDateString();
                      const todayDate = new Date().toDateString();
                      if (lastSendDate === todayDate) {
                        console.log(`Auto send skipped: email already sent today to lead ${lead.leadId} in list ${leadList.listId}`);
                        autoSendStatus = 'skipped_already_sent_today';
                      }
                    }

                    // ENG-673: this block also runs for an EXISTING lead that resubmits a form (isUpdated), and that lead keeps its Smartlead
                    // marker. A lead being emailed through the customer's Smartlead campaign is not also auto-emailed from here.
                    // An existing lead that opted out and then resubmits a form must not be auto-emailed either: the auto-draft step has no
                    // do-not-contact check of its own, and neither did this one (found by a review of ENG-673; older than that work).
                    if (!autoSendStatus && isDoNotContact(freshLead ?? lead)) {
                      console.log(`Auto send skipped: lead ${lead.leadId} in list ${leadList.listId} is do-not-contact`);
                      autoSendStatus = 'skipped_do_not_contact';
                    }

                    if (!autoSendStatus && isPushedToSmartlead(freshLead ?? lead)) {
                      console.log(`Auto send skipped: lead ${lead.leadId} in list ${leadList.listId} is being emailed through Smartlead`);
                      autoSendStatus = 'skipped_smartlead';
                    }

                    if (!autoSendStatus) {
                      // Resolve sender
                      const sendersResult = await agentModeService.getCrmSenders(leadList.userId);
                      let senderEmail: string | undefined;
                      let senderFromName: string | undefined;

                      if (sendersResult?.success && sendersResult.senders.length > 0) {
                        const sender = (leadList.listSenderId
                          ? sendersResult.senders.find((s: any) => s.id === leadList.listSenderId)
                          : null)
                          || (sendersResult.defaultSenderId
                            ? sendersResult.senders.find((s: any) => s.id === sendersResult.defaultSenderId)
                            : null)
                          || sendersResult.senders[0];

                        // GUARD, intentionally NOT migrated in ENG-266 Part 3: this whole
                        // auto-draft/auto-reply flow is only ever entered from the inbound
                        // email.received Resend webhook above — which structurally cannot fire
                        // for a mailbox sender (Graph produces no Resend webhooks). So a mailbox
                        // sender can never actually reach this branch; the check stays as a
                        // defensive backstop, not because this path lacks provider routing.
                        if (sender && sender.senderProvider && sender.senderProvider !== 'resend') {
                          console.error(
                            `Auto send skipped: sender ${sender.id} uses a connected ${sender.senderProvider} mailbox, which this path cannot send through yet`,
                            leadList.userId,
                          );
                          autoSendStatus = 'skipped_mailbox_sender_unsupported';
                        } else if (sender) {
                          senderEmail = sender.email;
                          senderFromName = sender.fromName;
                        }
                      }

                      if (autoSendStatus === 'skipped_mailbox_sender_unsupported') {
                        // already handled above
                      } else if (!senderEmail || !senderFromName) {
                        console.error('Auto send skipped: no sender configured for user', leadList.userId);
                        autoSendStatus = 'skipped_no_sender';
                      } else {
                        try {
                          const from = `${senderFromName} <${senderEmail}>`;
                          await resendService.sendEmail({
                            from,
                            to: leadEmail,
                            subject: draftEmail.subject,
                            text: draftEmail.textContent,
                            html: draftEmail.htmlContent,
                          });
                          await crmDb.updateLead(leadList.listId, lead.leadId, { emailDraft: null, lastAutoSendAt: new Date().toISOString() });
                          console.log(`Auto send succeeded for lead ${lead.leadId} in list ${leadList.listId}`);
                          autoSendStatus = 'sent';
                        } catch (sendError: any) {
                          console.error('Auto send failed:', sendError?.message || 'Unknown auto-send error');
                          autoSendStatus = 'failed';
                        }
                      }
                    }
                  }
                }
              }
            } catch (draftError: any) {
              console.error('Auto draft creation failed:', draftError?.message || 'Unknown auto-draft error');
              autoDraftStatus = 'failed';
              autoDraftError = draftError?.message || 'Unknown error';
            }
          }

          // Send alert with accurate draft/send status
          const alertEventType = isUpdated ? 'api.lead_updated' : 'api.lead_added';
          await leadListAlertService.notifyLeadListOwnerIfConfigured(
            leadList,
            lead,
            alertEventType,
            {
              orgLeadSubmission: true,
              source: mergedCustomFields.source,
              forwardedAt: mergedCustomFields.forwardedAt,
              company: leadData.company,
              phone: leadData.phone,
              ...(autoDraftStatus ? { autoDraftStatus } : {}),
              ...(autoDraftError ? { autoDraftError } : {}),
              ...(autoSendStatus ? { autoSendStatus } : {}),
            },
            new Date().toISOString()
          );
        } catch (err) {
          console.error('Post-response processing error:', err);
        }
      })();
    }

  } catch (error: any) {
    console.error('Lead forwarding error:', error);

    // ENG-2837: the capture failed before its response was recorded. Give the key back ONLY
    // if no lead write was attempted — then nothing happened and the retry is processed fresh.
    // Once a write may have happened, the claim stays in_progress (retries get 409) so a retry
    // can never repeat the write or its side effects.
    if (submissionClaim) {
      const claim = submissionClaim;
      submissionClaim = null;
      if (!leadWriteStarted) {
        await releaseLeadSubmission(leadList.listId, claim.key, claim.ownerToken).catch((releaseErr: any) =>
          console.error(`[forward-lead] ENG-2837 failed to release submission claim (key stays in_progress): ${releaseErr?.message || releaseErr}`));
      } else {
        console.error(`[forward-lead] ENG-2837 capture failed after a lead write may have started on list ${leadList.listId}; claim left in_progress`);
      }
    }

    // Trigger api.lead_failed alert if configured
    try {
      await leadListAlertService.notifyLeadListOwnerIfConfigured(
        leadList,
        {
          leadId: 'failed',
          email: req.body.email || 'unknown',
          firstName: req.body.firstName || '',
          lastName: req.body.lastName || '',
        },
        'api.lead_failed',
        {
          error: error.message || 'Unknown error',
          source: req.body.source || req.body.customFields?.source || 'api',
          email: req.body.email || 'unknown',
        },
        new Date().toISOString()
      );
    } catch (alertError) {
      console.error('Failed to send api.lead_failed alert:', alertError);
    }

    res.status(500).json({
      success: false,
      message: error.message || 'Failed to forward lead'
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ATTIO WEBHOOK RECEIVER
//
// Attio's model is per-workspace (each connected account registers its own
// webhook subscription via AttioService.registerWebhook — see
// utils/attioWebhookSubscription.ts) rather than HubSpot's single app-wide
// subscription list, but the request-handling shape mirrors HubSpot's
// handler below: ACK 200 immediately, verify the signature, dedup via the
// durable job queue, then demux across every list bound to the matched
// workspace.
//
// Events handled: record.created/updated/deleted (People only — Companies
// are skipped, matching HubSpot's own webhook scope, which doesn't touch
// Companies either) and list-entry.created/updated/deleted (the Deal-analog,
// for parity with HubSpot's deal.propertyChange handling).
// ─────────────────────────────────────────────────────────────────────────────

const attioAdapter = new AttioAdapter();

function verifyAttioSignature(signingKey: string, rawBody: Buffer, signature: string): boolean {
  try {
    const expected = crypto.createHmac('sha256', signingKey).update(rawBody).digest('hex');
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

interface AttioJobPayload {
  workspaceId: string;
  accountId: string; // the specific matched account's id — resolved at signature-verification time
  userId: string;
  events: any[];
}

export async function processAttioWebhookJob(payload: AttioJobPayload): Promise<void> {
  const svc = await AttioService.create(payload.userId, payload.accountId);
  const lists = await crmDb.getLeadListsByUserId(payload.userId);
  const matchingLists = (lists as any[]).filter(
    l => l.externalCrmSyncConfigs?.attio?.accountId === payload.accountId,
  );

  // Person attribute types are workspace-wide, not list-scoped, and
  // loadAttributeTypes has no cache of its own — without sharing one fetch
  // across this whole job, every record.* event (times every matching list)
  // reissues the same Attio HTTP request. Fetched lazily (only if the
  // delivery actually contains a record.* event) and once, then handed to
  // every applyAttioPersonEvent call below.
  let peopleAttrCache: Map<string, string> | undefined;
  if (payload.events.some(e => (e?.event_type ?? '').startsWith('record.'))) {
    peopleAttrCache = await svc.loadAttributeTypes('people');
  }
  // Deal-list attribute types ARE list-scoped (config.attioDealListId), so
  // cache per distinct deal list id instead — different AgentWeb lists can
  // point at different Attio deal lists.
  const dealAttrCacheByListId = new Map<string, Map<string, string>>();

  // CodeRabbit finding (ENG-1380): a per-event failure was recorded into
  // lastSyncStatus but the job itself still resolved normally, so the
  // durable job queue called markJobComplete instead of markJobFailed —
  // a transient failure (Attio fetch error, DynamoDB delete error) was
  // never retried by the queue's bounded-retry mechanism. OR'd across every
  // list, not reset per-list, and only thrown after the loop below finishes
  // — every matching list must still be fully attempted regardless of an
  // earlier list's failure, exactly as before; only whether the job as a
  // whole gets retried changes.
  let anyJobEventFailed = false;

  for (const list of matchingLists) {
    const syncConfig = await externalCrmSyncService.getConfig(payload.userId, list.listId, 'attio');
    if (!syncConfig || syncConfig.webhookEnabled === false) continue;

    // Live-caught gap: a webhook-driven update applies correctly (the lead's
    // data genuinely changes), but nothing stamped lastPullSyncAt/lastSyncStatus
    // for it — only a manual "Pull" click did. The CRM Sync dialog's "last
    // pulled" indicator looked permanently stale even while auto-pull was
    // working. Stamp once per list per job (not per event) once at least one
    // relevant event was actually attempted against it — set before the call,
    // not after, so a thrown error still counts as an attempt (and correctly
    // marks the stamp as a failure, not skips it entirely).
    let appliedAnyEvent = false;
    let anyEventFailed = false;

    for (const event of payload.events) {
      const eventType: string = event?.event_type ?? '';
      try {
        if (eventType.startsWith('record.')) {
          appliedAnyEvent = true;
          // applyAttioPersonEvent catches its own fetch/deletion failures
          // internally and returns false rather than throwing (CodeRabbit
          // finding, ENG-1380) — check the return value, not just the catch.
          const applied = await applyAttioPersonEvent(list.listId, syncConfig, svc, event, peopleAttrCache);
          if (!applied) anyEventFailed = true;
        } else if (eventType.startsWith('list-entry.')) {
          const entryId: string = event?.id?.entry_id ?? event?.data?.entry_id ?? '';
          if (entryId) {
            appliedAnyEvent = true;
            const dealListId = syncConfig.attioDealListId;
            let dealAttrCache = dealListId ? dealAttrCacheByListId.get(dealListId) : undefined;
            if (dealListId && !dealAttrCache) {
              dealAttrCache = await svc.loadAttributeTypes('people', dealListId);
              dealAttrCacheByListId.set(dealListId, dealAttrCache);
            }
            await attioAdapter.applyListEntryWebhookEvent(list.listId, syncConfig, svc, entryId, eventType, dealAttrCache);
          }
        }
      } catch (err: any) {
        console.error(`[Attio Webhook] Failed to apply ${eventType} to list ${list.listId}:`, err?.message ?? err);
        anyEventFailed = true;
      }
    }

    if (appliedAnyEvent) {
      await externalCrmSyncService.updateSyncTimestamp(syncConfig, 'pull', !anyEventFailed);
    }
    if (anyEventFailed) anyJobEventFailed = true;
  }

  // Thrown only after every matching list has been attempted — the caller's
  // markJobFailed/retry path re-processes this same payload later. Safe to
  // retry the whole delivery: every event application here (person create/
  // update, list-entry field merge) is an idempotent upsert, so re-applying
  // an event that already succeeded on a prior attempt is a no-op, not a
  // duplicate side effect.
  if (anyJobEventFailed) {
    throw new Error('[Attio Webhook] One or more events failed to apply — see prior logs for detail');
  }
}

registerProcessor('attio_webhook', processAttioWebhookJob);

router.post('/attio', (req: express.Request, res: express.Response) => {
  // Attio's webhook-URL verification handshake, if it applies here — echo
  // X-Hook-Secret back so the subscription activates. (Also handled in
  // crmWebhook.ts's per-list endpoint; kept defensively for this endpoint
  // too since it's cheap and the create-webhook flow doesn't rule it out.)
  const hookSecret = req.headers['x-hook-secret'] as string | undefined;
  if (hookSecret) {
    res.set('X-Hook-Secret', hookSecret);
    return res.status(200).json({ received: true });
  }

  // Return 200 immediately — Attio retries on non-2xx or timeout (at-least-once
  // delivery, up to 10 retries over ~3 days). All processing is fire-and-forget.
  res.status(200).json({ received: true });

  void (async () => {
    try {
      const rawBody = req.body as Buffer;
      const payload: any = JSON.parse(rawBody.toString('utf8'));
      // Real shape (live-verified, ENG-1380): { webhook_id, events: [{ event_type,
      // id: { workspace_id, object_id, record_id, ... }, actor }] }. workspace_id
      // lives on each individual event's `id`, not at the top level — the original
      // stub's `event?.workspace_id` assumption never matched a real delivery.
      const rawEvents: any[] = Array.isArray(payload?.events) ? payload.events : [payload];
      // Real deliveries carry a handful of events at most; cap defensively so a
      // malformed or oversized body can't fan out into an unbounded number of
      // per-event Attio API calls and DB writes in processAttioWebhookJob.
      const MAX_EVENTS_PER_DELIVERY = 200;
      if (rawEvents.length > MAX_EVENTS_PER_DELIVERY) {
        console.warn(`[Attio Webhook] Delivery carries ${rawEvents.length} events — processing only the first ${MAX_EVENTS_PER_DELIVERY}`);
      }
      const events = rawEvents.slice(0, MAX_EVENTS_PER_DELIVERY);
      const workspaceId: string = events[0]?.id?.workspace_id ?? '';
      if (!workspaceId) {
        console.warn('[Attio Webhook] No workspace_id on delivery — ignored');
        return;
      }

      const candidates = await getAccountsByAttioWorkspaceId(workspaceId);
      if (candidates.length === 0) {
        console.warn(`[Attio Webhook] No connected account found for workspace ${workspaceId}`);
        return;
      }

      // Attio-Signature (duplicated as X-Attio-Signature for legacy support) —
      // HMAC-SHA256 of the raw body with the matched account's own signing
      // key. Try each candidate's key rather than committing to a single
      // guess (same multi-tenant-collision defense as getAccountsByAttioWorkspaceId
      // itself documents).
      const signature = (req.headers['attio-signature'] ?? req.headers['x-attio-signature']) as string | undefined;
      // Fail closed: the unsigned-request bypass is only allowed when
      // NODE_ENV is explicitly 'development', mirroring this codebase's own
      // TABLE_PREFIX convention (constants.ts) of treating anything that
      // isn't exactly 'development' as needing production-safe behavior.
      // The previous `isProd = NODE_ENV === 'production'` check was
      // fail-open: an unset, staging, mistyped, or otherwise non-'production'
      // NODE_ENV value in a real deployment let a completely unauthenticated
      // request through, matched against the first candidate account, and
      // processed as if legitimate.
      const isDev = process.env.NODE_ENV === 'development';
      let matched: { userId: string; accountId: string } | null = null;

      if (signature) {
        for (const { userId, account } of candidates) {
          const signingKey = (account.config as any).webhook_signing_key;
          if (signingKey && verifyAttioSignature(signingKey, rawBody, signature)) {
            matched = { userId, accountId: account.account_id };
            break;
          }
        }
        if (!matched) {
          console.warn(`[Attio Webhook] Signature did not verify against any connected account for workspace ${workspaceId} — request ignored`);
          return;
        }
      } else if (!isDev) {
        console.warn('[Attio Webhook] Missing Attio-Signature — request rejected (unsigned requests are only allowed when NODE_ENV=development)');
        return;
      } else {
        console.warn('[Attio Webhook] No Attio-Signature header — proceeding without verification (dev only)');
        matched = { userId: candidates[0].userId, accountId: candidates[0].account.account_id };
      }

      const dedupeKey = (req.headers['idempotency-key'] as string | undefined)
        ?? crypto.createHash('sha256').update(rawBody).digest('hex');
      const jobPayload: AttioJobPayload = { workspaceId, accountId: matched.accountId, userId: matched.userId, events };

      const enqueueResult = await enqueueJob('attio_webhook', dedupeKey, jobPayload, { claimImmediately: true });
      if (enqueueResult === 'duplicate') {
        console.log(`[Attio Webhook] Duplicate delivery (${dedupeKey.slice(0, 12)}...) — already queued, skipping`);
        return;
      }

      const stopHeartbeat = enqueueResult === 'enqueued' ? startHeartbeat('attio_webhook', dedupeKey) : () => {};
      try {
        await processAttioWebhookJob(jobPayload);
        if (enqueueResult === 'enqueued') {
          await markJobComplete('attio_webhook', dedupeKey);
        }
      } catch (processingError: any) {
        if (enqueueResult === 'enqueued') {
          await markJobFailed('attio_webhook', dedupeKey, processingError);
        } else {
          console.error('[Attio Webhook] Processing failed with no durable record (queue unavailable):', processingError?.message ?? processingError);
        }
      } finally {
        stopHeartbeat();
      }
    } catch (error: any) {
      console.error('[Attio Webhook] error:', error);
    }
  })();
});

// ─────────────────────────────────────────────────────────────────────────────
// HUBSPOT WEBHOOK RECEIVER
//
// HubSpot sends events here for ALL connected portals (configured once in
// the HubSpot Developer Portal — not per user). Each event includes a
// portalId to identify which customer's data changed.
//
// To configure in HubSpot Developer Portal:
//   App Settings → Webhooks → Target URL → ${BACKEND_URL}/api/webhooks/hubspot
//   Subscribe to: contact.creation, contact.propertyChange, contact.deletion
//   For contact.propertyChange, watch: email, phone, firstname, lastname,
//   jobtitle, company, hs_linkedin_url
//
// Events handled:
//   contact.creation        → pull new contact into matching user's leads
//   contact.propertyChange  → update matching lead's fields
//   contact.deletion        → flag matching lead as removed
// ─────────────────────────────────────────────────────────────────────────────
interface HubspotContactChange {
  portalId: number;
  properties: Record<string, string>;
  isCreation: boolean;
  isDeleted: boolean;
  isDealChange: boolean;
}

interface HubspotJobPayload {
  changesByObjectId: Record<string, HubspotContactChange>;
  /** contact.merge events (ENG-2465). Optional: jobs queued before this field existed lack it. */
  merges?: Array<HubSpotContactMerge & { portalId: number }>;
}

/** Contact/deal sync, run either inline (same request, the common case) or later by
 *  the async job queue's poller if the process crashed before finishing (ENG-524
 *  fast-follow, Greptile P1 — same fire-and-forget crash-loss risk the Calendly
 *  receiver had, since this handler acks HubSpot's webhook before this runs). */
export async function processHubspotWebhookJob(payload: HubspotJobPayload): Promise<void> {
  // ── contact.merge: re-point stored contact ids at the survivor ───────────
  let mergeFailures = 0;
  for (const merge of payload.merges ?? []) {
    try {
      const userId = await getUserIdByHubSpotPortalId(merge.portalId);
      if (!userId) {
        console.log(`[HubSpot Webhook] contact.merge: no user found for portal ${merge.portalId}`);
        continue;
      }
      const lists = (await crmDb.getLeadListsByUserId(userId)) || [];
      for (const list of lists) {
        const cfgs = (list as any).externalCrmSyncConfigs as Record<string, any> | undefined;
        if (String(cfgs?.hubspot?.accountId) !== String(merge.portalId)) continue;
        const r = await repointMergedContactIds(list.listId, merge);
        mergeFailures += r.lookupFailed;
      }
    } catch (err: any) {
      mergeFailures++;
      console.error(`[HubSpot Webhook] contact.merge handling failed for survivor ${merge.survivorId}: ${err?.message || err}`);
    }
  }

  await processHubspotContactChanges(payload);

  // A merge whose lookup or write failed throws AFTER the rest of the delivery is applied, so the
  // durable queue retries the job (the repoint is idempotent; the contact changes are idempotent
  // updates, as for any retry of this job). Attempts are capped by the queue.
  if (mergeFailures > 0) {
    throw new Error(`contact.merge: ${mergeFailures} stored contact id(s) could not be re-pointed`);
  }
}

async function processHubspotContactChanges(payload: HubspotJobPayload): Promise<void> {
  // ── Process each contact / deal ─────────────────────────────────────────
  for (const [objectId, data] of Object.entries(payload.changesByObjectId)) {
        const userId = await getUserIdByHubSpotPortalId(data.portalId);
        if (!userId) {
          console.log(`[HubSpot Webhook] No user found for portal ${data.portalId}`);
          continue;
        }

        const portalIdStr = String(data.portalId);
        const svc = await HubSpotService.create(userId, portalIdStr).catch(() => null);

        // Discard all events when the OAuth account is unavailable (expired token,
        // revoked refresh, or account removed). Prevents webhook updates from landing
        // on lists whose connection is broken (Type 1 disconnect — expired or manual).
        if (!svc) {
          console.log(`[HubSpot Webhook] OAuth token unavailable for portal ${portalIdStr} (user ${userId}) — discarding events`);
          continue;
        }

        // ── Deal.propertyChange: resolve contacts via deal associations ──────────
        if (data.isDealChange && svc) {
          try {
            const contactIds = await svc.getDealContactAssociations(objectId).catch(() => [] as string[]);
            if (contactIds.length === 0) {
              console.log(`[HubSpot Webhook] deal ${objectId} has no contact association, skipping`);
              continue;
            }

            const allLists = await crmDb.getLeadListsByUserId(userId);
            if (!allLists) continue;
            const dealLists = allLists.filter(l => {
              const cfgs = (l as any).externalCrmSyncConfigs as Record<string, any> | undefined;
              return String(cfgs?.hubspot?.accountId) === portalIdStr;
            });

            // Fetch syncConfig per list once — doesn't vary per contact
            const activeDealLists = (await Promise.all(
              dealLists.map(async list => {
                const syncConfig = await externalCrmSyncService.getConfig(userId, list.listId, 'hubspot').catch(() => null);
                return syncConfig && syncConfig.webhookEnabled !== false ? { list, syncConfig } : null;
              })
            )).filter(Boolean) as Array<{ list: any; syncConfig: any }>;

            const emailMap = await svc.getContactEmailsByIds(contactIds).catch(() => new Map<string, string>());
            await Promise.all(contactIds.map(async (contactId) => {
              const contactEmail = emailMap.get(contactId) ?? null;
              if (!contactEmail) return;

              for (const { list, syncConfig } of activeDealLists) {
                const lead = await crmDb.getLeadByEmail(list.listId, contactEmail.toLowerCase());
                if (!lead) continue;
                const dealUpdates: any = {};
                if (data.properties.amount !== undefined) dealUpdates.dealValue = data.properties.amount;
                if (data.properties.deal_currency_code !== undefined) dealUpdates.dealCurrency = data.properties.deal_currency_code;
                if (data.properties.dealstage !== undefined) {
                  const mapped = syncConfig.hubspotDealStageMap
                    ? Object.entries(syncConfig.hubspotDealStageMap).find(([, id]) => id === data.properties.dealstage)?.[0]
                    : undefined;
                  dealUpdates.status = mapped ?? data.properties.dealstage;
                }
                if (Object.keys(dealUpdates).length > 0) {
                  await crmDb.updateLead(list.listId, lead.leadId, dealUpdates);
                  console.log(`[HubSpot Webhook] Deal update synced to lead ${lead.leadId} in list ${list.listId}`);
                }
              }
            }));
          } catch (err: any) {
            console.error(`[HubSpot Webhook] deal.propertyChange error for deal ${objectId}:`, err.message);
          }
          continue;
        }

        // ── Contact events ──────────────────────────────────────────────────────
        // For contact.creation: fetch full contact to populate all standard fields
        // (the creation event payload contains no property values).
        if (data.isCreation && svc) {
          try {
            const fullContact = await svc.getContactById(objectId);
            Object.entries(fullContact).forEach(([k, v]) => {
              if (data.properties[k] === undefined && v) data.properties[k] = v;
            });
          } catch { /* non-fatal */ }
        }

        // Resolve email from payload or API fallback. A contact.propertyChange
        // event only carries the changed property, so a name/phone edit arrives
        // without an email and must be resolved via the API. Don't swallow the
        // failure silently (that drops the update invisibly) — log it and retry
        // once with a freshly-created service so a transient token blip (e.g. a
        // concurrent refresh rotating the access token) doesn't lose the event.
        let email = data.properties.email;
        if (!email && svc) {
          const resolved = await resolveContactEmail(userId, portalIdStr, objectId, svc);
          if (resolved) email = resolved;
        }

        if (!email) {
          console.log(`[HubSpot Webhook] Could not determine email for contact ${objectId}, skipping`);
          continue;
        }

        const allLists = await crmDb.getLeadListsByUserId(userId);
        if (!allLists) continue;

        // Only process lists explicitly linked to this portal — prevents a contact
        // update in portal A from incorrectly updating a list linked to portal B
        // when the same email happens to exist in both.
        const contactLists = allLists.filter(l => {
          const cfgs = (l as any).externalCrmSyncConfigs as Record<string, any> | undefined;
          return String(cfgs?.hubspot?.accountId) === portalIdStr;
        });
        if (contactLists.length === 0) {
          console.log(`[HubSpot Webhook] No lists linked to portal ${portalIdStr} for user ${userId}, skipping`);
          continue;
        }

        for (const list of contactLists) {
          // Check per-list webhook preference — skip if user has disabled webhook updates
          const syncConfig = await externalCrmSyncService.getConfig(userId, list.listId, 'hubspot').catch(() => null);
          if (syncConfig?.webhookEnabled === false) {
            console.log(`[HubSpot Webhook] webhookEnabled=false for list ${list.listId}, skipping`);
            continue;
          }

          // Email first, then the contact id we already stored when WE pushed this lead.
          // Email alone is not an identity for a lead that has none: ENG-2082 leads sync to
          // HubSpot with a hubspot_contact_id and no address, so the moment HubSpot returns
          // one this lookup missed, the edit was dropped and — on a creation event — a
          // SECOND row was created carrying the same hubspot_contact_id as the first. The
          // Attio path and crmWebhook.ts:136 already resolve by id; this one did not.
          // Email first, then the contact id — UNCONDITIONALLY. An earlier version gated the
          // fallback on `isCreation || isDeleted` to save the partition walk, which quietly
          // disabled the whole feature: a HubSpot creation event for a lead we pushed
          // without an address carries no email, so the handler `continue`s at `if (!email)`
          // above before any lookup happens. The address therefore only ever arrives as a
          // contact.propertyChange — precisely the case that gate excluded. The walk is
          // bounded by MAX_PAGES inside the lookup; correctness is not negotiable for it.
          const leadByEmail = await crmDb.getLeadByEmail(list.listId, email.toLowerCase());
          let lead = leadByEmail;
          if (!lead) {
            try {
              lead = await crmDb.getLeadByHubSpotContactId(list.listId, String(objectId));
            } catch (lookupErr: any) {
              // ANY failure means we cannot prove the lead is absent, and the branches
              // below act on that assumption. `lookupExhausted` is only the page-cap case;
              // a throttle or timeout used to fall through as `lead = null`. Less severe
              // here than in crmWebhook — creation is gated on data.isCreation — but the
              // edit is still applied to the wrong row or dropped, so skip either way.
              const why = lookupErr?.lookupExhausted
                ? lookupErr.message
                : `contact-id lookup failed (${lookupErr?.message || lookupErr})`;
              console.warn(`[HubSpot Webhook] ${why} — skipping list ${list.listId}`);
              continue;
            }
          }

          // Deletion: flag an existing lead as CRM-removed (nothing to do if absent).
          if (data.isDeleted) {
            if (!lead) continue;
            await crmDb.updateLead(list.listId, lead.leadId, {
              syncMetadata: { ...(lead.syncMetadata || {}), crmRemovedAt: new Date().toISOString() },
            });
            console.log(`[HubSpot Webhook] Marked lead ${lead.leadId} as CRM-removed`);
            continue;
          }

          // Map standard HubSpot properties → lead fields (shared by create + update).
          const fields: any = {};
          if (data.properties.firstname       !== undefined) fields.firstName = data.properties.firstname;
          if (data.properties.lastname        !== undefined) fields.lastName  = data.properties.lastname;
          if (data.properties.phone           !== undefined) fields.phone     = data.properties.phone;
          if (data.properties.jobtitle        !== undefined) fields.title     = data.properties.jobtitle;
          if (data.properties.company         !== undefined) fields.company   = data.properties.company;
          if (data.properties.hs_linkedin_url !== undefined) fields.linkedin  = data.properties.hs_linkedin_url;
          // Adopt the address when we resolved this lead by CONTACT ID rather than by email.
          // The whole point of that fallback is the lead had no email and HubSpot now has
          // one — writing every other property but not that one leaves the row address-less,
          // so getLeadByEmail misses again on the next webhook and the fallback (a full
          // partition walk) runs forever. Only when it is genuinely new: never clobber a
          // different address we already hold.
          if (email && !lead?.email) fields.email = email.toLowerCase();

          const standardHubspotProps = ['email', 'firstname', 'lastname', 'phone', 'jobtitle', 'company', 'hs_linkedin_url'];
          const customFieldUpdates: any = {};
          Object.entries(data.properties).forEach(([key, val]) => {
            if (standardHubspotProps.includes(key)) return;
            let matchedKey = key;
            if (lead?.customFields) {
              const found = Object.keys(lead.customFields).find(
                k => k.toLowerCase().replace(/[^a-z0-9]/g, '_') === key
              );
              if (found) matchedKey = found;
            }
            customFieldUpdates[matchedKey] = val;
          });

          if (!lead) {
            // New contact in HubSpot → create the lead. Only on creation events:
            // a property change to a contact we've never seen isn't ours to add.
            if (!data.isCreation) continue;
            const newLead: any = { email: email.toLowerCase(), ...fields, syncMetadata: { hubspot_contact_id: objectId } };
            if (Object.keys(customFieldUpdates).length > 0) newLead.customFields = customFieldUpdates;
            try {
              await crmDb.createLead(list.listId, newLead, 'integration');
              console.log(`[HubSpot Webhook] Created lead for ${email} in list ${list.listId}`);
              continue;
            } catch (createErr: any) {
              // The lookups above said "absent" but createLead's own email pre-check found the
              // row (a concurrent create won). Throwing would abandon every remaining list and
              // contact in this job; adopt the row and apply the event as an update below.
              if (!createErr?.duplicateEmail || !createErr.existingLead) throw createErr;
              lead = createErr.existingLead as Record<string, any>;
              if (lead.email) delete fields.email;
              console.log(`[HubSpot Webhook] Lead for ${email} already existed in list ${list.listId} (lost create race) — updating ${lead.leadId}`);
            }
          }

          const updates: any = { ...fields };
          if (Object.keys(customFieldUpdates).length > 0) {
            updates.customFields = mergeCustomFields(
              lead.customFields,
              customFieldUpdates,
              { source: 'webhooks.hubspot', listId: list.listId, leadId: lead.leadId },
            );
          }

          if (Object.keys(updates).length > 0) {
            await crmDb.updateLead(list.listId, lead.leadId, updates);
            console.log(`[HubSpot Webhook] Synced updates to lead ${lead.leadId} in list ${list.listId}`);
          }
        }
      }
    }

registerProcessor('hubspot_webhook', processHubspotWebhookJob);

// invitee.created delivery shapes handled:
//   contact.creation         → fetch full contact, create lead
//   contact.propertyChange   → resolve email if absent, create or update lead
//   contact.deletion         → flag matching lead as removed
//   deal.propertyChange      → resolve associated contacts, sync deal fields
router.post('/hubspot', (req: express.Request, res: express.Response) => {
  // Return 200 immediately — HubSpot retries on non-2xx or timeout.
  // All processing happens asynchronously (fire-and-forget).
  res.status(200).json({ received: true });

  void (async () => {
    try {
      // Raw body captured by express.raw() — parse once for processing.
      const rawBody = req.body as Buffer;
      const parsedBody: any = JSON.parse(rawBody.toString('utf8'));

      // ── Signature verification ──────────────────────────────────────────────
      // Verify X-HubSpot-Signature when present. If the header is missing we
      // log a warning and continue (supports local dev / test environments).
      const signature = req.headers['x-hubspot-signature'] as string | undefined;
      const isProd = process.env.NODE_ENV === 'production';
      // HubSpot signs each event with the secret of the app that owns the
      // subscription. Resolve the secret by the event's appId so events from an
      // app we don't manage (e.g. a stray delivery from a different app pointed at
      // this URL) are ignored — not verified against our app's secret.
      const eventAppId: string | number | undefined = Array.isArray(parsedBody)
        ? parsedBody[0]?.appId
        : parsedBody?.appId;
      if (signature) {
        const clientSecret = await getHubSpotClientSecretForAppId(eventAppId).catch(() => null);
        if (!clientSecret) {
          console.warn(`[HubSpot Webhook] No managed client secret for appId=${eventAppId ?? 'absent'} — request ignored (unmanaged app or missing creds)`);
          return;
        }
        if (!verifyHubSpotSignature(clientSecret, rawBody, signature)) {
          console.warn('[HubSpot Webhook] Signature mismatch — request ignored');
          return;
        }
      } else if (isProd) {
        console.warn('[HubSpot Webhook] Missing X-HubSpot-Signature in production — request rejected');
        return;
      } else {
        console.warn('[HubSpot Webhook] No X-HubSpot-Signature header — proceeding without verification (dev only)');
      }

      // ── Aggregate events by objectId ────────────────────────────────────────
      const events: any[] = Array.isArray(parsedBody) ? parsedBody : [parsedBody];
      const changesByObjectId: Record<string, HubspotContactChange> = {};
      const merges: Array<HubSpotContactMerge & { portalId: number }> = [];

      for (const event of events) {
        const eventType: string = event?.subscriptionType ?? 'unknown';
        const portalId: number = event?.portalId;
        const objectId: string = String(event?.objectId ?? '');
        const propertyName: string = event?.propertyName ?? '';
        const propertyValue: string = event?.propertyValue ?? '';

        console.log(`[HubSpot Webhook] event=${eventType} portal=${portalId} object=${objectId}${propertyName ? ` property=${propertyName}` : ''}`);

        const merge = parseHubSpotMergeEvent(event);
        if (merge) {
          merges.push({ ...merge, portalId });
          continue;
        }

        const isContactEvent = ['contact.creation', 'contact.propertyChange', 'contact.deletion'].includes(eventType);
        const isDealEvent = eventType === 'deal.propertyChange';
        if (!isContactEvent && !isDealEvent) continue;
        if (!objectId) continue;

        if (!changesByObjectId[objectId]) {
          changesByObjectId[objectId] = { portalId, properties: {}, isCreation: false, isDeleted: false, isDealChange: false };
        }
        if (eventType === 'contact.creation') changesByObjectId[objectId].isCreation = true;
        if (eventType === 'contact.deletion') changesByObjectId[objectId].isDeleted = true;
        if (isDealEvent) changesByObjectId[objectId].isDealChange = true;
        if (propertyName && propertyValue !== undefined) {
          changesByObjectId[objectId].properties[propertyName] = propertyValue;
        }
      }

      // Dedupe key: HubSpot payloads are arrays of events, not a single-booking id
      // like Calendly's invitee URI, so there's no natural per-delivery identifier —
      // a hash of the raw body is stable across a genuine redelivery of the exact
      // same payload and distinct for any payload with different actual content.
      const dedupeKey = crypto.createHash('sha256').update(rawBody).digest('hex');
      const jobPayload: HubspotJobPayload = merges.length > 0 ? { changesByObjectId, merges } : { changesByObjectId };

      // claimImmediately: this same request processes the job right below, so the
      // enqueue writes it straight in as 'processing' — no separate claim call, no
      // window where it sits 'pending' and claimable by the poller.
      const enqueueResult = await enqueueJob('hubspot_webhook', dedupeKey, jobPayload, { claimImmediately: true });
      if (enqueueResult === 'duplicate') {
        console.log(`[HubSpot Webhook] Duplicate delivery (${dedupeKey.slice(0, 12)}...) — already queued, skipping`);
        return;
      }

      // Keeps the claim's updatedAt fresh for as long as this inline call actually
      // runs — without it, processing slower than the poller's stale threshold
      // looks identical to an abandoned claim, and the poller would claim and
      // re-run this same delivery concurrently (Greptile P1 on #2291).
      const stopHeartbeat = enqueueResult === 'enqueued' ? startHeartbeat('hubspot_webhook', dedupeKey) : () => {};
      try {
        await processHubspotWebhookJob(jobPayload);
        if (enqueueResult === 'enqueued') {
          await markJobComplete('hubspot_webhook', dedupeKey);
        }
      } catch (processingError: any) {
        if (enqueueResult === 'enqueued') {
          // Durable record exists — the poller will retry, so don't lose this silently.
          await markJobFailed('hubspot_webhook', dedupeKey, processingError);
        } else {
          // Queue unavailable (e.g. table not provisioned yet) — no durable record to
          // retry from, so this is exactly today's fire-and-forget failure behavior.
          console.error('[HubSpot Webhook] Processing failed with no durable record (queue unavailable):', processingError?.message ?? processingError);
        }
      } finally {
        stopHeartbeat();
      }
    } catch (error: any) {
      console.error('[HubSpot Webhook] error:', error);
    }
  })();
});

export default router;
