import { crmDb } from '../services/db';
import { AttioService } from '../services/attioService';
import { ExternalCrmSyncConfig } from '../services/externalCrmSyncService';
import { getAttioConfig } from '../config/integrations';
import { extractAttioValue } from '../services/adapters/attioAdapter';
import { mergeCustomFields } from './customFieldsGuard';

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
 *
 * Returns `false` only for a genuine failure to apply the event (fetch or
 * deletion threw) — every other early return (irrelevant event type, wrong
 * object type, self-authored echo, deleteOnPull disabled, no email on the
 * record) is an intentional no-op and returns `true`. CodeRabbit correctly
 * flagged (ENG-1380) that these internal try/catches log-and-return rather
 * than rethrow, so a caller relying on a caught exception to detect failure
 * (the per-event try/catch in crmWebhook.ts/webhooks.ts) never saw it and
 * stamped lastPullSyncAt/lastSyncStatus as a false 'success'. Callers must
 * check this return value, not just catch.
 */
export async function applyAttioPersonEvent(
  listId: string,
  config: ExternalCrmSyncConfig,
  svc: AttioService,
  event: any,
  // Person attribute types are workspace-wide (not list-scoped), so a caller
  // processing many events/lists in one job (the shared OAuth webhook) can
  // fetch this once and share it — otherwise every single event refetches it
  // fresh from Attio with no cache, turning one delivery into hundreds of
  // repeated identical API calls. Callers that only ever handle one event at
  // a time (the per-list webhook endpoint) can omit this and it's fetched
  // internally, unchanged from before.
  sharedAttrCache?: Map<string, string>,
): Promise<boolean> {
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
  if (!relevant || !recordId) return true;

  // Only process People records — skip Companies and other object types.
  let objectSlug = objectSlugDirect;
  if (!objectSlug && objectId) {
    objectSlug = (await svc.getObjectSlug(objectId).catch(() => null)) ?? '';
  }
  if (objectSlug && objectSlug !== 'people') return true;

  if (actorType === 'app') {
    const { clientId } = await getAttioConfig();
    if (actorId === clientId) {
      console.log(`[AttioWebhook] Skipping self-authored event for recordId=${recordId}`);
      return true;
    }
  }
  // Note: AttioService.fromToken (manual/PAT) connections write as actor.type
  // 'api-token', not 'app', so this guard doesn't suppress their own echoes —
  // Attio's API has no self-identify endpoint to learn a token's own actor id
  // and compare it here. Not a correctness bug: this function never triggers
  // an outbound push, so an unsuppressed echo is at worst one redundant local
  // pull, not a loop. Revisit if manual-token Attio connections see real usage.

  if (eventType === 'record.deleted') {
    if (!config.deleteOnPull) {
      console.log(`[AttioWebhook] deletion event for recordId=${recordId} ignored (deleteOnPull is disabled)`);
      return true;
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
      return true;
    } catch (err: any) {
      console.error(`[AttioWebhook] Failed to process deletion for recordId=${recordId}:`, err?.message);
      return false;
    }
  }

  let values: Record<string, any>;
  try {
    values = await svc.getPersonValues(recordId);
  } catch (err: any) {
    console.error(`[AttioWebhook] Failed to fetch person values for recordId=${recordId}:`, err?.message);
    return false;
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
  const attrCache = sharedAttrCache ?? await svc.loadAttributeTypes('people');
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
    return true;
  }
  delete leadData.email; // used only as the lookup key / stamped separately below

  // Match by attio_record_id first, same as record.deleted above — an email
  // edit in Attio must still resolve to the same AgentWeb lead, not silently
  // create a duplicate (the pre-existing email-only lookup here missed the
  // lead once its email changed, since it's now keyed on the old address).
  // Fall back to email only for a lead that predates being linked to this
  // record at all (e.g. created via a lead-capture form, now syncing to
  // Attio for the first time).
  let lead = await crmDb.getLeadByAttioRecordId(listId, recordId);
  if (!lead) {
    lead = await crmDb.getLeadByEmail(listId, email.toLowerCase());
  }

  if (!lead) {
    const newLead: Record<string, any> = {
      email: email.toLowerCase(),
      ...leadData,
      syncMetadata: { attio_record_id: recordId },
    };
    if (Object.keys(customFields).length > 0) newLead.customFields = customFields;
    try {
      const created = await crmDb.createLead(listId, newLead, 'integration');
      console.log(`[AttioWebhook] Created lead ${created?.leadId ?? '(unknown)'} for recordId=${recordId} in list ${listId}`);
    } catch (createErr: any) {
      // The lookups above said "absent" but createLead's own pre-check found the address — a
      // concurrent create won in between. Adopt that row and apply this event as an update
      // instead of failing the event (which marks the whole sync run failed).
      if (!createErr?.duplicateEmail || !createErr.existingLead) throw createErr;
      lead = createErr.existingLead as Record<string, any>;
      console.log(`[AttioWebhook] Lead for recordId=${recordId} already existed in list ${listId} (lost create race) — updating ${lead.leadId}`);
    }
  }
  if (lead) {
    const updates: Record<string, any> = { ...leadData };
    // Keep AgentWeb's stored email in sync with an email change made in
    // Attio, and stamp attio_record_id when this lead was only just matched
    // by email (first time this record is linked) — neither is covered by
    // leadData, which had email deleted from it above.
    if (email.toLowerCase() !== lead.email) {
      updates.email = email.toLowerCase();
    }
    if (lead.syncMetadata?.attio_record_id !== recordId) {
      updates.syncMetadata = { ...(lead.syncMetadata || {}), attio_record_id: recordId };
    }
    if (Object.keys(customFields).length > 0) {
      updates.customFields = mergeCustomFields(
        lead.customFields,
        customFields,
        { source: 'attioPersonWebhookEvent', listId, leadId: lead.leadId },
      );
    }
    if (Object.keys(updates).length > 0) {
      await crmDb.updateLead(listId, lead.leadId, updates);
      console.log(`[AttioWebhook] Updated lead ${lead.leadId} in list ${listId}`);
    }
  }
  return true;
}
