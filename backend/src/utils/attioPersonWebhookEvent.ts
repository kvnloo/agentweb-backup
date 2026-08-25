import { crmDb } from '../services/db';
import { AttioService } from '../services/attioService';
import { ExternalCrmSyncConfig } from '../services/externalCrmSyncService';
import { getAttioConfig } from '../config/integrations';
import { extractAttioValue } from '../services/adapters/attioAdapter';

/**
 * Applies a single Attio `record.*` (People only — Companies are skipped,
 * matching HubSpot's own webhook scope, which doesn't touch Companies
 * either) webhook event to the given list. Shared by both webhook receivers:
 * the per-list endpoint (`crmWebhook.ts`, one list per URL) and the shared
 * OAuth endpoint (`webhooks.ts`, demuxed across every list bound to the
 * matched workspace) — extracted so the actual event-handling logic isn't
 * duplicated between them.
 *
 * Echo-suppression: skips events created by AgentWeb's own writes, so a
 * push doesn't immediately trigger a redundant "pull" of the same data back.
 * Live-verified (ENG-1380, direct read of a record we'd just written)
 * that AgentWeb's own writes carry `actor.type: 'app'` with `actor.id`
 * equal to our own Attio app's client_id — NOT `actor.type: 'api-token'`,
 * which the original assumption in this codebase had checked and which
 * never actually matched.
 */
export async function applyAttioPersonEvent(
  listId: string,
  config: ExternalCrmSyncConfig,
  svc: AttioService,
  event: any,
): Promise<void> {
  const eventType: string = event?.event_type ?? '';
  const recordId: string = event?.data?.record?.id?.record_id ?? event?.id?.record_id ?? '';
  const actorType: string = event?.actor?.type ?? event?.data?.actor?.type ?? '';
  const actorId: string = event?.actor?.id ?? event?.data?.actor?.id ?? '';
  // Real deliveries never carry a slug directly (live-verified, ENG-1380) —
  // only an object_id UUID at event.id.object_id. Check for a direct slug
  // first (cheap, and covers any payload shape that does include one),
  // falling back to resolving the UUID via AttioService.getObjectSlug.
  const objectSlugDirect: string = event?.data?.object?.slug ?? '';
  const objectId: string = event?.id?.object_id ?? event?.data?.object?.id ?? '';

  const relevant = ['record.created', 'record.updated', 'record.deleted'].includes(eventType);
  if (!relevant || !recordId) return;

  // Only process People records — skip Companies and other object types.
  let objectSlug = objectSlugDirect;
  if (!objectSlug && objectId) {
    objectSlug = (await svc.getObjectSlug(objectId).catch(() => null)) ?? '';
  }
  if (objectSlug && objectSlug !== 'people') return;

  if (actorType === 'app') {
    const { clientId } = await getAttioConfig();
    if (actorId === clientId) {
      console.log(`[AttioWebhook] Skipping self-authored event for recordId=${recordId}`);
      return;
    }
  }

  if (eventType === 'record.deleted') {
    if (!config.deleteOnPull) {
      console.log(`[AttioWebhook] deletion event for recordId=${recordId} ignored (deleteOnPull is disabled)`);
      return;
    }
    try {
      // Live-caught bug (ENG-1380): a deleted record can no longer be
      // fetched from Attio, so looking up its email via getPersonValues()
      // (the original approach here) 404s every time and the deletion
      // silently never applies. Look the lead up directly by the
      // attio_record_id we already stamped on it instead — no live fetch
      // needed, matches the same pattern applyListEntryWebhookEvent already
      // uses for list-entry.deleted.
      const lead = await crmDb.getLeadByAttioRecordId(listId, recordId);
      if (lead) {
        await crmDb.deleteLead(listId, lead.leadId);
        console.log(`[AttioWebhook] Deleted lead ${lead.leadId} from list ${listId}`);
      }
    } catch (err: any) {
      console.error(`[AttioWebhook] Failed to process deletion for recordId=${recordId}:`, err?.message);
    }
    return;
  }

  let values: Record<string, any>;
  try {
    values = await svc.getPersonValues(recordId);
  } catch (err: any) {
    console.error(`[AttioWebhook] Failed to fetch person values for recordId=${recordId}:`, err?.message);
    return;
  }

  // Config-driven field extraction, mirroring attioAdapter.ts's pullContacts
  // exactly (same mapping filters, same 'first_name'/'last_name'/'company'
  // special cases, same extractAttioValue value-shape interpretation) — so a
  // webhook-triggered auto-pull covers the same fields a manual Pull would,
  // rather than a narrower hardcoded set. Live-caught gap (ENG-1380): the
  // previous hardcoded firstName/lastName/phone/title/linkedin list silently
  // dropped company and every custom-field mapping, and ignored each field's
  // configured pull direction (e.g. the default mapping's linkedin is
  // push-only, but the old code synced it on every webhook event anyway).
  const pullContactMappings = config.contactFieldMapping.filter(m => m.enabled && m.direction !== 'push');
  const pullCustomMappings = config.customFieldMapping.filter(m => m.enabled && m.direction !== 'push');
  const attrCache = await svc.loadAttributeTypes('people');
  // Mirrors attioAdapter.ts's pullContacts nativeFields allow-list exactly —
  // a contactFieldMapping targeting any other agentwebField must route to
  // customFields, since crmDb.createLead/updateLead silently drop anything
  // outside this fixed whitelist of top-level lead columns.
  const nativeFields = ['firstName', 'lastName', 'email', 'phone', 'company', 'title', 'linkedin', 'notes'];

  const leadData: Record<string, any> = {};
  const customFields: Record<string, any> = {};
  for (const m of pullContactMappings) {
    const slug = m.crmProperty;
    let val: any;
    if (slug === 'first_name' || slug === 'last_name') {
      const nameAttr = values['name'];
      if (Array.isArray(nameAttr) && nameAttr.length > 0) val = nameAttr[0][slug];
    } else if (slug === 'company') {
      const companyRef = values['company']?.[0]?.target_record_id;
      if (companyRef) {
        const comp = await svc.getCompanyById(companyRef);
        val = comp?.name;
      }
    } else {
      const type = attrCache.get(`object:people:${slug}`) || 'text';
      val = extractAttioValue(values[slug], type);
    }
    if (val != null && val !== '') {
      if (nativeFields.includes(m.agentwebField)) {
        leadData[m.agentwebField] = val;
      } else {
        customFields[m.agentwebField] = val;
      }
    }
  }

  for (const m of pullCustomMappings) {
    const slug = m.crmProperty;
    const type = attrCache.get(`object:people:${slug}`) || 'text';
    const val = extractAttioValue(values[slug], type);
    if (val != null && val !== '') customFields[m.agentwebField] = val;
  }

  const email: string | undefined = leadData.email;
  if (!email) {
    console.log(`[AttioWebhook] No email for recordId=${recordId}, skipping`);
    return;
  }
  delete leadData.email; // used only as the lookup key / stamped separately below

  const lead = await crmDb.getLeadByEmail(listId, email.toLowerCase());

  if (!lead) {
    const newLead: Record<string, any> = {
      email: email.toLowerCase(),
      ...leadData,
      syncMetadata: { attio_record_id: recordId },
    };
    if (Object.keys(customFields).length > 0) newLead.customFields = customFields;
    await crmDb.createLead(listId, newLead);
    console.log(`[AttioWebhook] Created lead for ${email} in list ${listId}`);
  } else {
    const updates: Record<string, any> = { ...leadData };
    if (Object.keys(customFields).length > 0) {
      updates.customFields = { ...(lead.customFields || {}), ...customFields };
    }
    if (Object.keys(updates).length > 0) {
      await crmDb.updateLead(listId, lead.leadId, updates);
      console.log(`[AttioWebhook] Updated lead ${lead.leadId} in list ${listId}`);
    }
  }
}
