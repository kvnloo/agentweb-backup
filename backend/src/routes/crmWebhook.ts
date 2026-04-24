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
  const byObjectId: Record<string, { properties: Record<string, string>; isDeleted: boolean; isDeal?: boolean }> = {};
  for (const event of events) {
    const eventType: string = event?.subscriptionType ?? '';
    const objectId: string = String(event?.objectId ?? '');
    const propertyName: string = event?.propertyName ?? '';
    const propertyValue: string = event?.propertyValue ?? '';

    const changeSource: string = event?.changeSource ?? '';
    const relevant = ['contact.creation', 'contact.propertyChange', 'contact.deletion', 'deal.propertyChange'].includes(eventType);
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
    if (eventType === 'deal.propertyChange') {
      byObjectId[objectId].isDeal = true;
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
        if (data.isDeal) {
          console.log(`[CrmWebhook/HubSpot] Fetching associations for deal ${objectId}`);
          const contactIds = await svc.getDealContactAssociations(objectId);
          console.log(`[CrmWebhook/HubSpot] Found ${contactIds.length} associated contacts for deal ${objectId}:`, contactIds);
          if (contactIds.length > 0) {
            const fetchedEmail = await svc.getContactEmailById(contactIds[0]);
            console.log(`[CrmWebhook/HubSpot] Resolved email ${fetchedEmail} for contact ${contactIds[0]}`);
            if (fetchedEmail) email = fetchedEmail;
          }
        } else {
          const fetchedEmail = await svc.getContactEmailById(objectId);
          if (fetchedEmail) email = fetchedEmail;
        }
      } catch (err: any) {
        console.error(`[CrmWebhook/HubSpot] Error resolving email for ${data.isDeal ? 'deal' : 'contact'} ${objectId}:`, err.response?.data || err.message);
      }
    }
    if (!email) {
      console.log(`[CrmWebhook/HubSpot] Could not resolve email for ${data.isDeal ? 'deal' : 'contact'} ${objectId}, skipping`);
      continue;
    }

    if (data.isDeal) {
      // Apply deal mapping configuration updates
      if (!config.dealFieldMapping) continue;
      const dealUpdates: any = {};
      const dealCustomUpdates: any = {};
      const nativeDealFields = ['status', 'dealValue', 'dealCurrency'];

      const reverseStageMapping = (val: string) => {
        if (!config.hubspotDealStageMap) return val;
        const reverseEntry = Object.entries(config.hubspotDealStageMap).find(([, stageId]) => stageId === val);
        return reverseEntry?.[0] || val;
      };

      const pullDealMappings = config.dealFieldMapping.filter(m => m.enabled && m.direction !== 'push');
      for (const [key, val] of Object.entries(data.properties)) {
        const mapping = pullDealMappings.find(m => m.crmProperty === key);
        if (mapping) {
          // 'dealstage' is HubSpot's fixed system field for pipeline stage — not a custom property
          const mappedVal = key === 'dealstage' ? reverseStageMapping(val) : val;
          if (nativeDealFields.includes(mapping.agentwebField)) {
            dealUpdates[mapping.agentwebField] = mappedVal;
          } else {
            dealCustomUpdates[mapping.agentwebField] = mappedVal;
          }
        }
      }

      const lead = await crmDb.getLeadByEmail(listId, email.toLowerCase());
      if (lead) {
        if (Object.keys(dealCustomUpdates).length > 0) {
          dealUpdates.customFields = { ...(lead.customFields || {}), ...dealCustomUpdates };
        }
        if (Object.keys(dealUpdates).length > 0) {
          await crmDb.updateLead(listId, lead.leadId, dealUpdates);
          console.log(`[CrmWebhook/HubSpot] Updated deal properties for lead ${lead.leadId} in list ${listId}`);
        }
      }
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

function extractAttioValue(values: any[] | undefined, type: string): any {
  if (!values || !values.length) return undefined;
  const entry = values[0];
  const cleanType = type.replace(/-/g, '_');
  switch (cleanType) {
    case 'status': return entry.status?.title ?? entry.status?.target;
    case 'select': return entry.select?.title ?? entry.select?.target;
    case 'currency': return entry.currency_value;
    case 'number': return entry.number_value;
    case 'email_address': return entry.email_address;
    case 'phone_number': return entry.original_phone_number;
    case 'personal_name':
    case 'name':
      return `${entry.first_name || ''} ${entry.last_name || ''}`.trim();
    default: return entry.value ?? entry.target_record_id;
  }
}

// ─── Attio event handler ──────────────────────────────────────────────────────

/**
 * Attio sends a single event per request.
 * We handle 'people' and 'deals' object events.
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
    const objectId: string = event?.id?.object_id ?? event?.data?.record?.id?.object_id ?? '';
    const actorType: string = event?.actor?.type ?? event?.data?.actor?.type ?? '';

    const relevant = ['record.created', 'record.updated', 'record.deleted'].includes(eventType);
    if (!relevant || !recordId) continue;

    // Resolve object_id UUID → api_slug since Attio's webhook payload does not include slug
    const objectSlug: string = objectId
      ? await svc.resolveObjectSlug(objectId)
      : (event?.data?.object?.slug ?? '');
    console.log(`[CrmWebhook/Attio] eventType=${eventType} objectSlug=${objectSlug} recordId=${recordId} actorType=${actorType}`);

    // Only process People and Deals — skip companies, notes, and anything unknown
    if (objectSlug !== 'people' && objectSlug !== 'deals') continue;
    if (actorType === 'api-token') {
      console.log(`[CrmWebhook/Attio] Skipping API-sourced event for recordId=${recordId}`);
      continue;
    }

    if (eventType === 'record.deleted') {
      if (objectSlug === 'deals') continue; // We do not delete leads when a deal is deleted

      if (!config.deleteOnPull) {
        console.log(`[CrmWebhook/Attio] deletion event for recordId=${recordId} ignored (deleteOnPull is disabled)`);
        continue;
      }
      const lead = await crmDb.getLeadByAttioRecordId(listId, recordId);
      if (lead) {
        await crmDb.deleteLead(listId, lead.leadId);
        console.log(`[CrmWebhook/Attio] Deleted lead ${lead.leadId} from list ${listId}`);
      }
      continue;
    }

    if (objectSlug === 'deals') {
      const deal = await svc.getDealById(recordId);
      if (!deal) continue;

      const pullDealMappings = (config.dealFieldMapping || []).filter(m => m.enabled && m.direction !== 'push');
      if (pullDealMappings.length === 0) continue;

      for (const personId of (deal.associatedPeopleIds || [])) {
        const pValues = await svc.getPersonValues(personId).catch(() => null);
        if (!pValues) continue;
        const email = extractAttioValue(pValues.email_addresses, 'email_address');
        if (!email) continue;

        const lead = await crmDb.getLeadByEmail(listId, email.toLowerCase());
        if (!lead) continue;

        const dealUpdates: any = {};
        const dealCustomFields: any = {};
        const nativeDealFields = ['status', 'dealValue', 'dealCurrency'];

        for (const m of pullDealMappings) {
          if (m.crmProperty === 'stage' && deal.stage) {
            if (nativeDealFields.includes(m.agentwebField)) dealUpdates[m.agentwebField] = deal.stage;
            else dealCustomFields[m.agentwebField] = deal.stage;
          } else if (m.crmProperty === 'value' && deal.value != null) {
            if (nativeDealFields.includes(m.agentwebField)) dealUpdates[m.agentwebField] = deal.value;
            else dealCustomFields[m.agentwebField] = deal.value;
          } else if (m.crmProperty === 'name' && deal.name) {
            if (nativeDealFields.includes(m.agentwebField)) dealUpdates[m.agentwebField] = deal.name;
            else dealCustomFields[m.agentwebField] = deal.name;
          }
        }

        if (Object.keys(dealCustomFields).length > 0) {
          dealUpdates.customFields = { ...(lead.customFields || {}), ...dealCustomFields };
        }

        if (Object.keys(dealUpdates).length > 0) {
          await crmDb.updateLead(listId, lead.leadId, dealUpdates);
          console.log(`[CrmWebhook/Attio] Updated deal properties for lead ${lead.leadId} in list ${listId}`);
        }
      }
      continue;
    }

    // Process People updates (including custom fields)
    let values: Record<string, any>;
    try {
      values = await svc.getPersonValues(recordId);
    } catch (err: any) {
      console.error(`[CrmWebhook/Attio] Failed to fetch person values for recordId=${recordId}:`, err?.message);
      continue;
    }

    const email = extractAttioValue(values.email_addresses, 'email_address');
    if (!email) {
      console.log(`[CrmWebhook/Attio] No email for recordId=${recordId}, skipping`);
      continue;
    }

    const attrCache = await svc.loadAttributeTypes('people');
    const pullContactMappings = config.contactFieldMapping.filter(m => m.enabled && m.direction !== 'push');
    const pullCustomMappings = config.customFieldMapping.filter(m => m.enabled && m.direction !== 'push');

    const leadFields: Record<string, any> = { email: email.toLowerCase(), syncMetadata: { attio_record_id: recordId } };
    const customFields: Record<string, any> = {};

    for (const m of pullContactMappings) {
      if (m.crmProperty === 'company') continue; // Handled separately or explicitly pulled otherwise
      const type = attrCache.get(`object:people:${m.crmProperty}`) || 'text';
      const val = extractAttioValue(values[m.crmProperty], type);
      if (val != null && val !== '') {
        leadFields[m.agentwebField] = val;
      }
    }

    for (const m of pullCustomMappings) {
      const type = attrCache.get(`object:people:${m.crmProperty}`) || 'text';
      const val = extractAttioValue(values[m.crmProperty], type);
      if (val != null && val !== '') {
        customFields[m.agentwebField] = val;
      }
    }

    if (Object.keys(customFields).length > 0) {
      leadFields.customFields = customFields;
    }

    const lead = await crmDb.getLeadByEmail(listId, email.toLowerCase());

    if (!lead) {
      await crmDb.createLead(listId, leadFields);
      console.log(`[CrmWebhook/Attio] Created lead for ${email} in list ${listId}`);
    } else {
      const mergedCustomFields = Object.keys(customFields).length > 0
        ? { ...(lead.customFields || {}), ...customFields }
        : undefined;

      const updates: Record<string, any> = { ...leadFields };
      delete updates.email;
      delete updates.syncMetadata;
      delete updates.customFields;
      if (mergedCustomFields) updates.customFields = mergedCustomFields;

      if (Object.keys(updates).length > 0) {
        await crmDb.updateLead(listId, lead.leadId, updates);
        console.log(`[CrmWebhook/Attio] Updated lead ${lead.leadId} in list ${listId}`);
      }
    }
  }
}

export default router;
