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
        ? { ...(lead.customFields || {}), ...customFieldUpdates }
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
 * Attio sends a single event per request.
 * We only handle 'people' object events — companies are ignored.
 */
async function handleAttioEvent(
  userId: string,
  listId: string,
  config: ExternalCrmSyncConfig,
  body: any
): Promise<void> {
  const events: any[] = Array.isArray(body?.events) ? body.events : Array.isArray(body) ? body : [body];

  const auth = await externalCrmSyncService.resolveAuthForList(userId, listId, 'attio');
  const svc = auth.type === 'token'
    ? AttioService.fromToken(auth.apiKey!)
    : await AttioService.create(auth.userId!, auth.accountId!);

  for (const event of events) {
    const eventType: string = event?.event_type ?? '';
    const recordId: string = event?.data?.record?.id?.record_id ?? event?.id?.record_id ?? '';
    const actorType: string = event?.actor?.type ?? event?.data?.actor?.type ?? '';
    const objectSlug: string = event?.data?.object?.slug ?? '';

    const relevant = ['record.created', 'record.updated', 'record.deleted'].includes(eventType);
    if (!relevant || !recordId) continue;
    // Only process People records — skip Companies and other object types
    if (objectSlug && objectSlug !== 'people') continue;
    if (actorType === 'api-token') {
      console.log(`[CrmWebhook/Attio] Skipping API-sourced event for recordId=${recordId}`);
      continue;
    }

    if (eventType === 'record.deleted') {
      if (!config.deleteOnPull) {
        console.log(`[CrmWebhook/Attio] deletion event for recordId=${recordId} ignored (deleteOnPull is disabled)`);
        continue;
      }
      try {
        const values = await svc.getPersonValues(recordId);
        const email = values.email_addresses?.[0]?.email_address ?? '';
        if (!email) continue;
        const lead = await crmDb.getLeadByEmail(listId, email.toLowerCase());
        if (lead) {
          await crmDb.deleteLead(listId, lead.leadId);
          console.log(`[CrmWebhook/Attio] Deleted lead ${lead.leadId} from list ${listId}`);
        }
      } catch (err: any) {
        console.error(`[CrmWebhook/Attio] Failed to process deletion for recordId=${recordId}:`, err?.message);
      }
      continue;
    }

    // Fetch person values from Attio for created/updated
    let values: Record<string, any>;
    try {
      values = await svc.getPersonValues(recordId);
    } catch (err: any) {
      console.error(`[CrmWebhook/Attio] Failed to fetch person values for recordId=${recordId}:`, err?.message);
      continue;
    }

    const email = values.email_addresses?.[0]?.email_address ?? '';
    if (!email) {
      console.log(`[CrmWebhook/Attio] No email for recordId=${recordId}, skipping`);
      continue;
    }

    const firstName = values.name?.[0]?.first_name ?? '';
    const lastName = values.name?.[0]?.last_name ?? '';
    const phone = values.phone_numbers?.[0]?.original_phone_number ?? '';
    const title = values.job_title?.[0]?.value ?? '';
    const linkedin = values.linkedin?.[0]?.value ?? '';

    const lead = await crmDb.getLeadByEmail(listId, email.toLowerCase());

    if (!lead) {
      const newLead: Record<string, any> = { email: email.toLowerCase(), syncMetadata: { attio_record_id: recordId } };
      if (firstName) newLead.firstName = firstName;
      if (lastName) newLead.lastName = lastName;
      if (phone) newLead.phone = phone;
      if (title) newLead.title = title;
      if (linkedin) newLead.linkedin = linkedin;
      await crmDb.createLead(listId, newLead);
      console.log(`[CrmWebhook/Attio] Created lead for ${email} in list ${listId}`);
    } else {
      const updates: Record<string, any> = {};
      if (firstName) updates.firstName = firstName;
      if (lastName) updates.lastName = lastName;
      if (phone) updates.phone = phone;
      if (title) updates.title = title;
      if (linkedin) updates.linkedin = linkedin;
      if (Object.keys(updates).length > 0) {
        await crmDb.updateLead(listId, lead.leadId, updates);
        console.log(`[CrmWebhook/Attio] Updated lead ${lead.leadId} in list ${listId}`);
      }
    }
  }
}

export default router;
