import * as crypto from 'crypto';
import express from 'express';
import { IncomingMessage } from 'http';
import { WebhookRequiredHeaders } from 'svix';
import { webhookService, ResendWebhookEvent } from '../services/webhookService';
import { emailEventsDb } from '../services/emailEventsDb';
import { leadListAlertService } from '../services/leadListAlertService';
import { crmDb, userDb, tempEmailDb } from '../services/db';
import { dripSequenceDb } from '../services/dripSequenceDb';
import { getUserIdByHubSpotPortalId } from '../services/connectedAccountsDb';
import { HubSpotService } from '../services/hubspotService';
import { getHubSpotClientSecretForAppId } from '../config/integrations';
import { externalCrmSyncService } from '../services/externalCrmSyncService';
import { agentModeService } from '../services/agentModeService';
import { resendService } from '../services/resendService';
import { sendRoadmapDeliveryEmail } from '../services/roadmapDelivery';
import { emmaEmailService } from '../services/emmaEmailService';
import { TEMP_EMAIL_PREFIX, TEMP_EMAIL_DOMAIN } from '../config';
import { isDoNotContact } from '../utils/leadContactStatus';
import { normalizeAttribution } from '../types/attribution';
import { mergeCustomFields } from '../utils/customFieldsGuard';
import { recordLeadCaptureFailure } from '../services/leadCaptureFailureService';
import { metaService } from '../services/metaService';
import { isSmokeTestEmail } from '../utils/smokeTestLead';
import { enqueueJob, markJobComplete, markJobFailed, registerProcessor, startHeartbeat } from '../services/asyncJobQueue';

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

// ENG-492: bounds how often the Meta CAPI send (below, in the forward-lead handler) is
// actually ATTEMPTED per lead list, so a scripted flood against one customer's list can't
// pollute their live ad account with unlimited fake "Lead" conversions. Deliberately NOT an
// HTTP-level rate limiter (like express-rate-limit) — this only ever gates the optional,
// fire-and-forget CAPI call, never the lead save/response itself, so hitting the cap has
// zero customer-visible effect: the lead still saves normally, the response is still 201,
// the only consequence is that this one submission doesn't get forwarded to Meta.
const capiSendTimestampsByListId = new Map<string, number[]>();
const CAPI_SEND_BUDGET_MAX = 100;
const CAPI_SEND_BUDGET_WINDOW_MS = 15 * 60 * 1000;

function shouldAttemptCapiSend(listId: string): boolean {
  const now = Date.now();
  const recent = (capiSendTimestampsByListId.get(listId) || []).filter(
    (t) => now - t < CAPI_SEND_BUDGET_WINDOW_MS,
  );
  if (recent.length >= CAPI_SEND_BUDGET_MAX) {
    capiSendTimestampsByListId.set(listId, recent);
    // Logged every time (not just on the first overflow) so the actual overflow VOLUME is
    // visible in logs, not just that it happened once — that's what tells us whether
    // CAPI_SEND_BUDGET_MAX is too low for a real customer's real traffic (tune it up) vs.
    // a genuine flood (leave it, or investigate the source).
    console.warn(
      `[CAPI] Send budget exhausted for list ${listId} (${recent.length}/${CAPI_SEND_BUDGET_MAX} ` +
      `in the last ${CAPI_SEND_BUDGET_WINDOW_MS / 60000}min) — this submission's Lead event will NOT be forwarded to Meta. Lead itself still saved normally.`
    );
    return false;
  }
  recent.push(now);
  capiSendTimestampsByListId.set(listId, recent);
  return true;
}

// Second, independent layer on top of the per-listId budget above: that budget is an
// invented internal number, not Meta's actual rate limit. Meta documents NO fixed CAPI
// rate limit of its own — CAPI calls count against the ad account's dynamic Business Use
// Case (BUC) allowance, reported on every response via the X-Business-Use-Case-Usage
// header (see metaService.sendCapiLeadEvent's CapiUsage return). A customer with many
// lists, each individually within its own per-list budget, could still collectively
// exceed what THEIR OWN Meta access token is actually allowed. This tracks that real
// signal per ad account and pauses sends for that account using Meta's own reported
// cooldown — Meta's own documented advice is to stop calling once throttled, since
// calling through it only extends the throttle.
const capiAccountPausedUntil = new Map<string, number>();

function isCapiAccountPaused(accountId: string): boolean {
  const pausedUntil = capiAccountPausedUntil.get(accountId);
  return !!pausedUntil && Date.now() < pausedUntil;
}

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

function recordCapiUsage(accountId: string, usage?: { callCountPct: number; totalTimePct: number; totalCpuTimePct: number; estimatedMinutesToRegainAccess?: number }): void {
  if (!usage || usage.estimatedMinutesToRegainAccess === undefined) return;
  const atLimit = usage.callCountPct >= 100 || usage.totalTimePct >= 100 || usage.totalCpuTimePct >= 100;
  if (!atLimit) return;
  const pausedUntil = Date.now() + usage.estimatedMinutesToRegainAccess * 60_000;
  capiAccountPausedUntil.set(accountId, pausedUntil);
  console.warn(
    `[CAPI] Meta ad account ${accountId} at its Business Use Case rate limit ` +
    `(call_count=${usage.callCountPct}%, total_time=${usage.totalTimePct}%, total_cputime=${usage.totalCpuTimePct}%) — ` +
    `pausing CAPI sends for this account for ~${usage.estimatedMinutesToRegainAccess}min. Leads still save normally.`
  );
}

/**
 * Fire-and-forget: enroll a single lead into any sequences that have
 * autoEnrollListIds containing this list. Mirrors the authenticated CRM path
 * (routes/crm.ts) so leads captured via the public forward-lead webhook also
 * land in list-bound drip sequences. Errors are logged but never surfaced.
 */
async function autoEnrollLeadInSequences(
  userId: string,
  listId: string,
  leadId: string,
  leadEmail: string,
): Promise<void> {
  if (!leadEmail) return;
  try {
    const sequences = await dripSequenceDb.getSequencesByAutoEnrollList(userId, listId);
    for (const seq of sequences) {
      await dripSequenceDb.bulkEnroll([{
        sequenceId: seq.sequenceId,
        userId,
        listId,
        leadId,
        leadEmail,
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
    const eventExists = await emailEventsDb.eventExists(eventId);
    if (eventExists) {
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
      // Store the event in the database
      const emailEvent = await emailEventsDb.addEmailEvent(event, emailDomain, eventId);
      try {
        await leadListAlertService.notifyForEmailEvent(emailEvent);
      } catch (alertError) {
        console.error('Failed to send lead list alert email:', alertError);
      }
    } else {
      console.log(`Skipping CRM event storage for Emma-related email: ${event.data.email_id}`);
    }

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
// (Keying any future request-level limiter here by IP would also be unsound: this app never
// configures Express's `trust proxy`, so `req.ip` collapses to the same value for every
// caller — confirmed live in both prod and the test env. See ENG-493.)

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

  try {

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
    } = req.body;

    // Validate required field (email)
    if (!email || typeof email !== 'string' || !email.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Email is required'
      });
    }

    // Prepare lead data
    const leadData: any = {
      email: email.trim(),
      firstName: firstName?.trim() || '',
      lastName: lastName?.trim() || '',
      phone: phone?.trim() || '',
      company: company?.trim() || '',
      title: title?.trim() || '',
      notes: notes?.trim() || '',
      linkedin: linkedin?.trim() || '',
    };

    // Attribution — accept either the new `attribution` shape or the legacy
    // flat `utm` shape (same normaliser controllers/auth.ts uses for signup).
    // If the client sends nothing, we stamp nothing; the CSV import and other
    // internal paths won't carry attribution.
    const touch = normalizeAttribution(attribution) ?? normalizeAttribution(utm);
    if (touch) {
      leadData.firstTouch = touch;
      leadData.lastTouch = touch;
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
      'linkedin', 'source', 'customFields', 'attribution', 'utm', 'pixelId',
      'metaAccountId', 'eventId', 'fbp', 'fbc', 'capturedAtMs',
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

    // Check if lead already exists by email - merge instead of dropping
    const existingLead = await crmDb.getLeadByEmail(leadList.listId, email.trim().toLowerCase());

    // Only stamp forwardedAt for new leads; for existing leads, preserve the original timestamp
    const mergedCustomFields: Record<string, any> = existingLead
      ? incomingCustomFields
      : { ...incomingCustomFields, forwardedAt: new Date().toISOString() };

    leadData.customFields = mergedCustomFields;

    let lead: any;
    let isNew = false;
    let isUpdated = false;

    if (existingLead) {
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
          if (existingValue !== newValue) {
            updates[field] = newValue;
            changed = true;
          }
        }
      }

      // Merge custom fields
      const existingCustomFields = existingLead.customFields || {};
      const mergedCf = { ...existingCustomFields, ...mergedCustomFields };
      if (JSON.stringify(existingCustomFields) !== JSON.stringify(mergedCf)) {
        updates.customFields = mergedCf;
        changed = true;
      }

      // Attribution merge (Lead UTM — mirrors the User schema contract).
      // The new-lead path stamps firstTouch+lastTouch via createLead; the merge
      // path previously dropped attribution entirely, leaving lastTouch DOA
      // (lastTouch === firstTouch forever for any repeat-touch lead).
      //   - lastTouch  : ALWAYS refreshed when this touch carries attribution.
      //   - firstTouch : immutable — only backfilled if the lead has none yet.
      //   - utmSource / utmMedium : denormalized from firstTouch — only
      //     backfilled when absent, never overwritten.
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
        }
      }

      if (changed) {
        await crmDb.updateLead(leadList.listId, existingLead.leadId, updates);
        isUpdated = true;
      }

      lead = { ...existingLead, ...updates };
    } else {
      // Create a new lead
      lead = await crmDb.createLead(leadList.listId, leadData);
      isNew = true;
    }

    // Send API response immediately so caller is not blocked
    if (isNew) {
      res.status(201).json({
        success: true,
        message: 'Lead forwarded successfully',
        event: 'lead.created',
        leadId: lead.leadId,
        listId: leadList.listId
      });
    } else if (isUpdated) {
      res.status(200).json({
        success: true,
        message: 'Lead updated successfully',
        event: 'lead.updated',
        leadId: lead.leadId,
        listId: leadList.listId
      });
    } else {
      res.status(200).json({
        success: true,
        message: 'Lead already exists with no changes',
        event: 'lead.unchanged',
        leadId: lead.leadId,
        listId: leadList.listId
      });
    }

    // Server-side Meta Conversions API send. Fire-and-forget (same pattern as the
    // roadmap-delivery email below) — this must never delay or affect the lead-save response
    // already sent above, and a Meta-side failure must never be surfaced as a lead-capture
    // failure (the lead itself already saved successfully).
    // ENG-449 gap #3: never send a real CAPI conversion event for the automated smoke test's
    // synthetic lead — CAPI's correctness is already covered by unit tests (metaService.capi
    // .test.ts) and doesn't depend on v0-authored code, so there's nothing extra to verify
    // live here, only real-ad-account conversion data to needlessly pollute.
    if (pixelId && metaAccountId && eventId && !isSmokeTestEmail(leadData.email) && shouldAttemptCapiSend(leadList.listId) && !isCapiAccountPaused(metaAccountId)) {
      void (async () => {
        try {
          const owner = await userDb.getUserById(leadList.userId);
          const { getMetaAccountCredentials } = await import('../services/metaAccountCredentials');
          const { accessToken } = await getMetaAccountCredentials(owner, leadList.userId, metaAccountId);
          // ENG-493 is deferred (flipping Express's global `trust proxy` also changes
          // auth.ts's IP-keyed rate limiters — a separate, riskier change). Scope the fix to
          // just this CAPI call site instead, same pattern as loopEvents.ts/assetController.ts.
          const clientIp = (req.headers['x-forwarded-for']?.toString().split(',')[0] ?? req.ip ?? 'unknown').trim();
          const result = await metaService.sendCapiLeadEvent(pixelId, accessToken, {
            eventId,
            email: leadData.email,
            firstName: leadData.firstName,
            lastName: leadData.lastName,
            phone: leadData.phone,
            clientIp,
            userAgent: req.headers['user-agent'],
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
    if (!roadmapCustomFields.roadmapEmailSentAt) {
      void (async () => {
        const sent = await sendRoadmapDeliveryEmail({
          to: lead.email,
          stage: roadmapCustomFields.stage,
          source: roadmapCustomFields.source,
          firstName: lead.firstName,
        });

        if (!sent) return;

        try {
          await crmDb.updateLead(leadList.listId, lead.leadId, {
            customFields: {
              ...roadmapCustomFields,
              roadmapEmailSentAt: new Date().toISOString(),
              roadmapEmailStage: Number(roadmapCustomFields.stage),
            },
          });
        } catch (markError) {
          console.error('[roadmapDelivery] sent but failed to mark lead:', markError);
        }
      })();
    }

    // After response is sent: auto-draft, auto-send, and alert (fire-and-forget, fully awaited internally)
    if (isNew && isSmokeTestEmail(lead.email)) {
      // ENG-449 gap #3: the automated post-deploy smoke test submits a REAL lead through a
      // customer's real form to verify the pipeline works, then deletes the row. But deleting
      // the row doesn't undo an already-fired side effect — HubSpot/Attio sync, drip-sequence
      // enrollment, and (worse) a real auto-sent email to a fake address would all have
      // already fired by the time the row is deleted, since they're dispatched fire-and-forget
      // the instant the lead is created. Skip the whole cascade for a recognized synthetic
      // lead; the lead row itself is still created/returned normally above so the smoke
      // test's CRM-landing check still works.
      console.log(`[webhooks] Synthetic smoke-test lead (${lead.email}) — skipping CRM sync/sequence enrollment/auto-draft/auto-send/owner-notify side effects`);
    } else if (isNew || isUpdated) {
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
      void autoEnrollLeadInSequences(leadList.userId, leadList.listId, lead.leadId, lead.email);

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
              if (!autoDraftResult?.success) {
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
// Attio sends events here for each user who has registered a webhook.
// The payload identifies the workspace via workspace_id — matched against
// connected accounts to find the user.
//
// Events handled:
//   record.created  → log for future sync (pull new person into leads)
//   record.updated  → log for future sync (update matching lead)
//   record.deleted  → log for future sync (flag lead as removed)
// ─────────────────────────────────────────────────────────────────────────────
router.post('/attio', async (req: express.Request, res: express.Response) => {
  try {
    const event = req.body;
    const eventType: string = event?.event_type ?? event?.type ?? 'unknown';
    const workspaceId: string = event?.workspace_id ?? '';
    const objectType: string = event?.data?.object?.slug ?? '';
    const recordId: string = event?.data?.record?.id?.record_id ?? '';

    console.log(`[Attio Webhook] event=${eventType} object=${objectType} record=${recordId} workspace=${workspaceId}`);

    // Only process people and companies record events
    const isRelevantObject = objectType === 'people' || objectType === 'companies';
    const isRelevantEvent = ['record.created', 'record.updated', 'record.deleted'].includes(eventType);

    if (!isRelevantObject || !isRelevantEvent) {
      return res.status(200).json({ received: true, processed: false, reason: 'event not in scope' });
    }

    // TODO: Trigger sync handler when sync service is implemented
    // await attioSyncService.handleWebhookEvent(workspaceId, eventType, event.data);

    res.status(200).json({ received: true, processed: true });
  } catch (error: any) {
    console.error('[Attio Webhook] error:', error);
    res.status(200).json({ received: true, processed: false, error: error.message });
  }
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
}

/** Contact/deal sync, run either inline (same request, the common case) or later by
 *  the async job queue's poller if the process crashed before finishing (ENG-524
 *  fast-follow, Greptile P1 — same fire-and-forget crash-loss risk the Calendly
 *  receiver had, since this handler acks HubSpot's webhook before this runs). */
export async function processHubspotWebhookJob(payload: HubspotJobPayload): Promise<void> {
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

          const lead = await crmDb.getLeadByEmail(list.listId, email.toLowerCase());

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
            await crmDb.createLead(list.listId, newLead);
            console.log(`[HubSpot Webhook] Created lead for ${email} in list ${list.listId}`);
            continue;
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

      for (const event of events) {
        const eventType: string = event?.subscriptionType ?? 'unknown';
        const portalId: number = event?.portalId;
        const objectId: string = String(event?.objectId ?? '');
        const propertyName: string = event?.propertyName ?? '';
        const propertyValue: string = event?.propertyValue ?? '';

        console.log(`[HubSpot Webhook] event=${eventType} portal=${portalId} object=${objectId}${propertyName ? ` property=${propertyName}` : ''}`);

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
      const jobPayload: HubspotJobPayload = { changesByObjectId };

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
