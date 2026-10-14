/**
 * Per-list CRM Webhook endpoint
 *
 * Receives real-time record-change events from HubSpot private apps and Attio workspaces.
 * Each list config has its own URL:
 *
 *   POST /api/crm/:provider/:listId/webhook
 *
 * Security: the webhook secret is verified from the `secret` query parameter in the URL
 * (e.g. /webhook?secret=xxx), matched against the `webhookSecret` stored in the sync config
 * (generated once on first saveConfig(), never rotated).
 *
 * For HubSpot OAuth app users the existing shared endpoint (/api/webhooks/hubspot)
 * continues to handle events — this endpoint is for API-key users who configure
 * the URL themselves in their HubSpot private app or Attio workspace settings.
 */

import express from 'express';
import { crmDb } from '../services/db';
import { externalCrmSyncService, ExternalCrmSyncConfig } from '../services/externalCrmSyncService';
import { HubSpotService } from '../services/hubspotService';
import { AttioService } from '../services/attioService';
import { mergeCustomFields } from '../utils/customFieldsGuard';
import { parseHubSpotMergeEvent, repointMergedContactIds } from '../services/hubspotContactMerge';
import { applyAttioPersonEvent } from '../utils/attioPersonWebhookEvent';

const router = express.Router();

const SUPPORTED_PROVIDERS = ['hubspot', 'attio'] as const;
type SupportedProvider = typeof SUPPORTED_PROVIDERS[number];

// ─── Main route ───────────────────────────────────────────────────────────────

router.post('/:provider/:listId/webhook', async (req: express.Request, res: express.Response) => {
  const { provider, listId } = req.params;
  const secret = (req.query.secret as string | undefined) || (req.headers['x-webhook-secret'] as string | undefined);

  // 1. Validate provider early (this is the only non-silent error)
  if (!SUPPORTED_PROVIDERS.includes(provider as SupportedProvider)) {
    return res.status(400).json({ error: `Unsupported provider "${provider}". Supported: ${SUPPORTED_PROVIDERS.join(', ')}` });
  }

  // 2. Look up the list — silently ignore unknown IDs (don't leak info)
  const list = await crmDb.getLeadListById(listId).catch(() => null);
  if (!list) return res.status(200).json({ received: true });

  // 3. Look up sync config — silently ignore if not configured
  const config = await externalCrmSyncService.getConfig((list as any).userId, listId, provider).catch(() => null);
  if (!config?.webhookSecret) return res.status(200).json({ received: true });

  // 3a. Respect the user's webhookEnabled preference (defaults true if unset)
  if (config.webhookEnabled === false) return res.status(200).json({ received: true });

  // 4. Verify secret — silently ignore mismatches (don't leak info)
  if (!secret || secret !== config.webhookSecret) {
    return res.status(200).json({ received: true });
  }

  // 5. Handle Attio handshake — when Attio verifies the webhook URL it sends
  //    X-Hook-Secret; we must echo it back in the response header to activate.
  const hookSecret = req.headers['x-hook-secret'] as string | undefined;
  if (provider === 'attio' && hookSecret) {
    res.set('X-Hook-Secret', hookSecret);
    return res.status(200).json({ received: true });
  }

  // 6. Dispatch to provider handler (fire-and-forget — always return 200 fast)
  res.status(200).json({ received: true });

  void (async () => {
    try {
      if (provider === 'hubspot') {
        await handleHubSpotEvent((list as any).userId, listId, config, req.body);
      } else if (provider === 'attio') {
        await handleAttioEvent((list as any).userId, listId, config, req.body);
      }
    } catch (err: any) {
      console.error(`[CrmWebhook] Error processing ${provider} event for list ${listId}:`, err?.message || err);
    }
  })();
});

// ─── HubSpot event handler ────────────────────────────────────────────────────

/**
 * HubSpot sends an array of events per request.
 * We aggregate all property changes for each objectId before updating leads.
 */
async function handleHubSpotEvent(
  userId: string,
  listId: string,
  config: ExternalCrmSyncConfig,
  body: any
): Promise<void> {
  const events: any[] = Array.isArray(body) ? body : [body];

  // contact.merge: re-point stored contact ids at the survivor (ENG-2465). Needs no API call.
  for (const event of events) {
    const merge = parseHubSpotMergeEvent(event);
    if (merge) await repointMergedContactIds(listId, merge);
  }

  // Group all property changes by contact objectId
  const byObjectId: Record<string, { properties: Record<string, string>; isDeleted: boolean }> = {};
  for (const event of events) {
    const eventType: string = event?.subscriptionType ?? '';
    const objectId: string = String(event?.objectId ?? '');
    const propertyName: string = event?.propertyName ?? '';
    const propertyValue: string = event?.propertyValue ?? '';

    const changeSource: string = event?.changeSource ?? '';
    const relevant = ['contact.creation', 'contact.propertyChange', 'contact.deletion'].includes(eventType);
    if (!relevant || !objectId) continue;
    if (changeSource === 'API') {
      console.log(`[CrmWebhook/HubSpot] Skipping API-sourced event for objectId=${objectId}`);
      continue;
    }

    if (!byObjectId[objectId]) {
      byObjectId[objectId] = { properties: {}, isDeleted: false };
    }
    if (eventType === 'contact.deletion') {
      byObjectId[objectId].isDeleted = true;
    }
    if (propertyName && propertyValue !== undefined) {
      byObjectId[objectId].properties[propertyName] = propertyValue;
    }
  }

  if (Object.keys(byObjectId).length === 0) return;

  // Get the HubSpot service instance for this config
  const auth = await externalCrmSyncService.resolveAuthForList(userId, listId, 'hubspot');
  const svc = auth.type === 'token'
    ? HubSpotService.fromToken(auth.apiKey!)
    : await HubSpotService.create(auth.userId!, auth.accountId!);

  for (const [objectId, data] of Object.entries(byObjectId)) {
    // Handle deletion first — the contact is already gone so the HubSpot API
    // can't resolve its email. Find the lead by stored hubspot_contact_id instead.
    if (data.isDeleted) {
      if (config.deleteOnPull) {
        // THIRD call site. The other two catch `lookupExhausted`; this one did not, and an
        // uncaught throw here does not just skip this contact — it escapes
        // handleHubSpotEvent into the fire-and-forget wrapper, abandoning every remaining
        // objectId in the same batch. HubSpot already has its 200, so nothing retries and
        // those events are gone. Before the cap started throwing this returned null and the
        // loop simply moved on, which is the behaviour restored here.
        let lead: any = null;
        try {
          lead = await crmDb.getLeadByHubSpotContactId(listId, objectId);
        } catch (lookupErr: any) {
          // Same reasoning as the property-change branch, and the same blast radius as
          // before: a throw here escapes handleHubSpotEvent into the fire-and-forget
          // wrapper and abandons every remaining objectId in this delivery — HubSpot
          // already has its 200, so nothing retries. The previous version only caught the
          // page-cap case, so a throttle still took the whole batch down.
          const why = lookupErr?.lookupExhausted
            ? lookupErr.message
            : `contact-id lookup failed (${lookupErr?.message || lookupErr})`;
          console.warn(`[CrmWebhook/HubSpot] ${why} — cannot confirm which lead objectId=${objectId} refers to; not deleting.`);
          continue;
        }
        console.log(`[CrmWebhook/HubSpot] deletion lookup for objectId=${objectId}: lead=${lead?.leadId ?? 'not found'}`);
        if (lead) {
          await crmDb.deleteLead(listId, lead.leadId);
          console.log(`[CrmWebhook/HubSpot] Deleted lead ${lead.leadId} from list ${listId}`);
        }
      } else {
        console.log(`[CrmWebhook/HubSpot] deletion event for objectId=${objectId} ignored (deleteOnPull is disabled)`);
      }
      continue;
    }

    // Resolve email for creation/update — may be in the event payload or require an API call
    let email: string | null = data.properties.email || null;
    if (!email) {
      try {
        email = await svc.getContactEmailById(objectId);
      } catch {
        // Non-fatal — skip this contact if we can't resolve the email
      }
    }
    if (!email) {
      console.log(`[CrmWebhook/HubSpot] Could not resolve email for objectId=${objectId}, skipping`);
      continue;
    }

    // Build field updates from the event payload
    const STANDARD_HUBSPOT_PROPS = ['email', 'firstname', 'lastname', 'phone', 'jobtitle', 'company', 'hs_linkedin_url'];
    const leadFields: Record<string, any> = { email: email.toLowerCase() };

    if (data.properties.firstname !== undefined) leadFields.firstName = data.properties.firstname;
    if (data.properties.lastname !== undefined) leadFields.lastName = data.properties.lastname;
    if (data.properties.phone !== undefined) leadFields.phone = data.properties.phone;
    if (data.properties.jobtitle !== undefined) leadFields.title = data.properties.jobtitle;
    if (data.properties.company !== undefined) leadFields.company = data.properties.company;
    if (data.properties.hs_linkedin_url !== undefined) leadFields.linkedin = data.properties.hs_linkedin_url;

    const customFieldUpdates: Record<string, any> = {};
    for (const [key, val] of Object.entries(data.properties)) {
      if (STANDARD_HUBSPOT_PROPS.includes(key)) continue;
      customFieldUpdates[key] = val;
    }
    if (Object.keys(customFieldUpdates).length > 0) {
      leadFields.customFields = customFieldUpdates;
    }
    leadFields.syncMetadata = { hubspot_contact_id: objectId };

    // Email first, then the contact id we stored when WE pushed this lead. Email alone is
    // not an identity for a lead that has none — an ENG-2082 lead syncs to HubSpot with a
    // hubspot_contact_id and no address, so once HubSpot returns one this missed and
    // created a SECOND row carrying the same hubspot_contact_id. Worse here than in
    // webhooks.ts: that path at least gates creation on data.isCreation, this one does not,
    // so a bare property change was enough to duplicate the lead.
    let lead = await crmDb.getLeadByEmail(listId, email.toLowerCase());
    if (!lead) {
      try {
        lead = await crmDb.getLeadByHubSpotContactId(listId, String(objectId));
      } catch (lookupErr: any) {
        // ANY failure here means we could not prove the lead is absent, and this path has
        // no isCreation gate — falling through to `if (!lead) createLead` mints a second
        // row carrying an already-used hubspot_contact_id, which is the exact duplicate
        // this lookup exists to prevent.
        //
        // `lookupExhausted` is only the page-cap case. A throttle, a timeout or anything
        // handleDynamoDbError rethrows used to land on `lead = null` and create — under
        // precisely the load the cap was designed for, since a bulk import into the
        // customer's HubSpot fires thousands of these, each missing on email and walking
        // the partition. Skipping loses an edit; creating corrupts the list.
        const why = lookupErr?.lookupExhausted
          ? lookupErr.message
          : `contact-id lookup failed (${lookupErr?.message || lookupErr})`;
        console.warn(`[CrmWebhook/HubSpot] ${why} — skipping objectId=${objectId}`);
        continue;
      }
    }

    if (!lead) {
      // New contact in HubSpot — create it in our list
      try {
        await crmDb.createLead(listId, leadFields, 'integration');
        console.log(`[CrmWebhook/HubSpot] Created lead for ${email} in list ${listId}`);
      } catch (createErr: any) {
        // The lookups above said "absent" but createLead's own pre-check found the address — a
        // concurrent delivery/import created it in between. Throwing here escapes the loop and
        // abandons every remaining objectId in this delivery (HubSpot already has its 200), so
        // adopt the row we lost to and fall through to the update path instead.
        if (!createErr?.duplicateEmail || !createErr.existingLead) throw createErr;
        lead = createErr.existingLead as Record<string, any>;
        console.log(`[CrmWebhook/HubSpot] Lead for ${email} already existed in list ${listId} (lost create race) — updating ${lead.leadId}`);
      }
    }
    if (lead) {
      // Merge custom fields with existing ones
      const mergedCustomFields = Object.keys(customFieldUpdates).length > 0
        ? mergeCustomFields(
            lead.customFields,
            customFieldUpdates,
            { source: 'crmWebhook.hubspot', listId, leadId: lead.leadId },
          )
        : undefined;

      const updates: Record<string, any> = { ...leadFields };
      // Keep the address ONLY when the lead does not already have one — i.e. when it was
      // resolved by hubspot_contact_id, which is exactly the case this delete was written
      // before. Dropping it unconditionally assumed "we found it BY email, so email already
      // matches"; the contact-id fallback broke that assumption and left the row
      // permanently address-less.
      if (lead?.email) delete updates.email;
      delete updates.syncMetadata;
      delete updates.customFields;
      if (mergedCustomFields) updates.customFields = mergedCustomFields;

      if (Object.keys(updates).length > 0) {
        await crmDb.updateLead(listId, lead.leadId, updates);
        console.log(`[CrmWebhook/HubSpot] Updated lead ${lead.leadId} in list ${listId}`);
      }
    }
  }
}

// ─── Attio event handler ──────────────────────────────────────────────────────

/**
 * Attio sends a single event per request. Per-event handling lives in
 * `applyAttioPersonEvent` (shared with the OAuth-app shared endpoint in
 * `webhooks.ts`) — this just normalizes the payload shape and resolves auth.
 */
async function handleAttioEvent(
  userId: string,
  listId: string,
  config: ExternalCrmSyncConfig,
  body: any
): Promise<void> {
  const events: any[] = Array.isArray(body?.events) ? body.events : Array.isArray(body) ? body : [body];
  if (events.length === 0) return;

  // try/catch around auth/service resolution too, not just the per-event
  // loop below — without it, a throw here (e.g. a bad/expired manual token)
  // skipped the updateSyncTimestamp call at the bottom entirely, the same
  // invisible-failure problem the per-event try/catch exists to prevent,
  // just one step earlier.
  let anyEventFailed = false;
  try {
    const auth = await externalCrmSyncService.resolveAuthForList(userId, listId, 'attio');
    const svc = auth.type === 'token'
      ? AttioService.fromToken(auth.apiKey!)
      : await AttioService.create(auth.userId!, auth.accountId!);

    // Per-event try/catch — without it, a single throw aborted the whole
    // loop and skipped every remaining event, not just the failed one.
    // applyAttioPersonEvent also catches its own fetch/deletion failures
    // internally and returns false rather than throwing (CodeRabbit finding,
    // ENG-1380) — the boolean check below, not just the catch, is what
    // detects those.
    for (const event of events) {
      try {
        const applied = await applyAttioPersonEvent(listId, config, svc, event);
        if (!applied) anyEventFailed = true;
      } catch (err: any) {
        console.error(`[CrmWebhook] Failed to apply Attio event for list ${listId}:`, err?.message ?? err);
        anyEventFailed = true;
      }
    }
  } catch (err: any) {
    console.error(`[CrmWebhook] Failed to resolve Attio auth/service for list ${listId}:`, err?.message ?? err);
    anyEventFailed = true;
  }

  // Stamp lastPullSyncAt/lastSyncStatus so the CRM Sync dialog reflects this
  // webhook-driven auto-pull, not only a manual Pull click — same gap fixed
  // for the shared OAuth-app endpoint's processAttioWebhookJob.
  await externalCrmSyncService.updateSyncTimestamp(config, 'pull', !anyEventFailed);
}

export default router;
