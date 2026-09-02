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
        const lead = await crmDb.getLeadByHubSpotContactId(listId, objectId);
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

    const lead = await crmDb.getLeadByEmail(listId, email.toLowerCase());

    if (!lead) {
      // New contact in HubSpot — create it in our list
      await crmDb.createLead(listId, leadFields);
      console.log(`[CrmWebhook/HubSpot] Created lead for ${email} in list ${listId}`);
    } else {
      // Merge custom fields with existing ones
      const mergedCustomFields = Object.keys(customFieldUpdates).length > 0
        ? mergeCustomFields(
            lead.customFields,
            customFieldUpdates,
            { source: 'crmWebhook.hubspot', listId, leadId: lead.leadId },
          )
        : undefined;

      const updates: Record<string, any> = { ...leadFields };
      delete updates.email;
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
