/**
 * Per-list CRM Webhook endpoint
 *
 * Allows external CRM systems (HubSpot private apps, Attio) to push real-time
 * record-change events to a unique per-list URL:
 *
 *   POST /api/crm/:provider/:listId/webhook
 *
 * Security: the webhook secret is verified from the `X-Webhook-Secret` request
 * header, matched against the `webhookSecret` stored in the sync config
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
  const secret = req.headers['x-webhook-secret'] as string | undefined;

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

    const relevant = ['contact.creation', 'contact.propertyChange', 'contact.deletion'].includes(eventType);
    if (!relevant || !objectId) continue;

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
    // Resolve email — may be in the event payload or require an API call
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

    const lead = await crmDb.getLeadByEmail(listId, email.toLowerCase());
    if (!lead) continue;

    // Handle deletion
    if (data.isDeleted && config.deleteOnPull) {
      await crmDb.updateLead(listId, lead.leadId, {
        syncMetadata: { ...(lead.syncMetadata || {}), crmRemoved: true },
      });
      console.log(`[CrmWebhook/HubSpot] Marked lead ${lead.leadId} as CRM-removed`);
      continue;
    }

    // Map standard HubSpot property names → lead fields
    const STANDARD_HUBSPOT_PROPS = ['email', 'firstname', 'lastname', 'phone', 'jobtitle', 'company', 'hs_linkedin_url'];
    const updates: Record<string, any> = {};

    if (data.properties.firstname !== undefined) updates.firstName = data.properties.firstname;
    if (data.properties.lastname  !== undefined) updates.lastName  = data.properties.lastname;
    if (data.properties.phone     !== undefined) updates.phone     = data.properties.phone;
    if (data.properties.jobtitle  !== undefined) updates.title     = data.properties.jobtitle;
    if (data.properties.company   !== undefined) updates.company   = data.properties.company;
    if (data.properties.hs_linkedin_url !== undefined) updates.linkedin = data.properties.hs_linkedin_url;

    // Non-standard properties go into customFields
    const customFieldUpdates: Record<string, any> = {};
    for (const [key, val] of Object.entries(data.properties)) {
      if (STANDARD_HUBSPOT_PROPS.includes(key)) continue;
      // Attempt to match an existing custom field key (case-insensitive slug comparison)
      let matchedKey = key;
      if (lead.customFields) {
        const found = Object.keys(lead.customFields).find(
          k => k.toLowerCase().replace(/[^a-z0-9]/g, '_') === key
        );
        if (found) matchedKey = found;
      }
      customFieldUpdates[matchedKey] = val;
    }

    if (Object.keys(customFieldUpdates).length > 0) {
      updates.customFields = { ...(lead.customFields || {}), ...customFieldUpdates };
    }

    if (Object.keys(updates).length > 0) {
      await crmDb.updateLead(listId, lead.leadId, updates);
      console.log(`[CrmWebhook/HubSpot] Updated lead ${lead.leadId} in list ${listId}`);
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
  const eventType: string = body?.event_type ?? '';
  const objectSlug: string = body?.data?.object?.slug ?? '';
  const recordId: string   = body?.data?.record?.id?.record_id ?? '';

  // Only process people records
  if (objectSlug !== 'people' || !recordId) return;

  const relevant = ['record.created', 'record.updated', 'record.deleted'].includes(eventType);
  if (!relevant) return;

  // Handle deletion without fetching record values
  if (eventType === 'record.deleted') {
    if (!config.deleteOnPull) return;
    // Find lead by attio_record_id in syncMetadata
    console.log(`[CrmWebhook/Attio] record.deleted for recordId=${recordId} — deleteOnPull is enabled`);
    // Note: finding by record_id requires a list scan — left as a future enhancement.
    // For now, log and skip.
    return;
  }

  // Get the Attio service instance for this config
  const auth = await externalCrmSyncService.resolveAuthForList(userId, listId, 'attio');
  const svc = auth.type === 'token'
    ? AttioService.fromToken(auth.apiKey!)
    : await AttioService.create(auth.userId!, auth.accountId!);

  // Fetch person values from Attio
  let values: Record<string, any>;
  try {
    values = await svc.getPersonValues(recordId);
  } catch (err: any) {
    console.error(`[CrmWebhook/Attio] Failed to fetch person values for recordId=${recordId}:`, err?.message);
    return;
  }

  // Extract standard fields using the same known paths as AttioService.mapPerson()
  const email     = values.email_addresses?.[0]?.email_address ?? '';
  const firstName = values.name?.[0]?.first_name ?? '';
  const lastName  = values.name?.[0]?.last_name  ?? '';
  const phone     = values.phone_numbers?.[0]?.original_phone_number ?? '';
  const title     = values.job_title?.[0]?.value ?? '';
  const linkedin  = values.linkedin?.[0]?.value  ?? '';

  if (!email) {
    console.log(`[CrmWebhook/Attio] No email for recordId=${recordId}, skipping`);
    return;
  }

  const lead = await crmDb.getLeadByEmail(listId, email.toLowerCase());
  if (!lead) return;

  const updates: Record<string, any> = {};
  if (firstName) updates.firstName = firstName;
  if (lastName)  updates.lastName  = lastName;
  if (phone)     updates.phone     = phone;
  if (title)     updates.title     = title;
  if (linkedin)  updates.linkedin  = linkedin;

  if (Object.keys(updates).length > 0) {
    await crmDb.updateLead(listId, lead.leadId, updates);
    console.log(`[CrmWebhook/Attio] Updated lead ${lead.leadId} in list ${listId}`);
  }
}

export default router;
