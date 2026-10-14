import { crmDb } from './db';

export interface HubSpotContactMerge {
  survivorId: string;
  mergedIds: string[];
}

const MAX_LEADS_PER_ID = 25;
const asId = (v: unknown): string => (v === undefined || v === null ? '' : String(v).trim());

/**
 * Reads a HubSpot `contact.merge` webhook event (primaryObjectId, mergedObjectIds[],
 * newObjectId). Returns null for any other event type or a payload that names no
 * survivor or no merged-away contact.
 */
export function parseHubSpotMergeEvent(event: any): HubSpotContactMerge | null {
  if (event?.subscriptionType !== 'contact.merge') return null;
  const survivorId = asId(event.newObjectId) || asId(event.primaryObjectId);
  if (!survivorId) return null;
  const raw: unknown[] = Array.isArray(event.mergedObjectIds) ? event.mergedObjectIds : [];
  const mergedIds = [...new Set(raw.map(asId).filter((id) => id && id !== survivorId))];
  return mergedIds.length > 0 ? { survivorId, mergedIds } : null;
}

/**
 * After a merge in HubSpot, a lead's stored hubspot_contact_id can point at the
 * merged-away contact. Since ENG-2171 the push updates by that id, so a dead id would
 * fail every push. Rewrite it to the survivor. Idempotent: once rewritten, the lookup
 * for the old id finds nothing. A lookup or write failure is logged and counted in
 * `lookupFailed`, never thrown, so one bad list cannot abandon the rest of a delivery
 * that HubSpot already acked; the shared webhook turns a non-zero count into a queue retry.
 * Not covered: a lead whose id lives only in customFields.hubspot_contact_id (the lookup
 * filters on syncMetadata).
 */
export async function repointMergedContactIds(
  listId: string,
  merge: HubSpotContactMerge,
): Promise<{ rewritten: number; lookupFailed: number }> {
  let rewritten = 0;
  let lookupFailed = 0;
  for (const mergedId of merge.mergedIds) {
    // The lookup returns one lead per call. Rewriting a lead makes it stop matching, so
    // asking again surfaces the next lead holding the same id (duplicate leads for one
    // contact). Bounded so a write that silently does not take cannot loop forever.
    for (let n = 0; n < MAX_LEADS_PER_ID; n++) {
      let lead: any;
      try {
        lead = await crmDb.getLeadByHubSpotContactId(listId, mergedId);
      } catch (err: any) {
        lookupFailed++;
        console.warn(`[HubSpot merge] lookup of contact ${mergedId} in list ${listId} failed (${err?.message || err}) — stored id not rewritten.`);
        break;
      }
      if (!lead) break;
      try {
        await crmDb.updateLead(listId, lead.leadId, {
          syncMetadata: { ...(lead.syncMetadata || {}), hubspot_contact_id: merge.survivorId },
        } as any);
        rewritten++;
        console.log(`[HubSpot merge] lead ${lead.leadId} in list ${listId}: stored contact ${mergedId} merged into ${merge.survivorId}.`);
      } catch (err: any) {
        lookupFailed++;
        console.warn(`[HubSpot merge] could not rewrite stored id for lead ${lead.leadId} in list ${listId} (${err?.message || err}).`);
        break;
      }
    }
  }
  return { rewritten, lookupFailed };
}
