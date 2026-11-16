import { crmDb } from './db';
import { phoneDedupeKey, phoneNamesConflict } from '../utils/phoneLeadDedupe';

/**
 * ENG-2123. Find the existing email-less lead a repeat phone-only capture belongs to.
 *
 * PhoneKeyIndex is an eventually-consistent, KEYS_ONLY index that updateLead does not maintain, so
 * its entries can be stale (the phone was edited, or an email was added later). Nothing from it is
 * trusted: every candidate is re-read by primary key, consistently, and must STILL be email-less and
 * STILL normalise to the same key. A stale entry therefore costs a missed dedupe (today's behaviour),
 * never a wrong merge.
 */
export type PhoneMatchDecision =
  | 'unavailable'   // index missing / not permitted: treated as a miss
  | 'miss'          // nothing valid on this number
  | 'shared-line'   // more rows than PHONE_FANOUT_CAP: an office/household line, never merge
  | 'name-conflict' // valid rows exist but name a different person
  | 'match';

export interface PhoneMatch {
  decision: PhoneMatchDecision;
  candidates: number;
  valid: number;
  lead?: any;
}

export async function findPhoneMatch(listId: string, phoneKey: string, incoming: any): Promise<PhoneMatch> {
  const found = await crmDb.getLeadIdsByPhoneKey(listId, phoneKey);
  if (!found.available) return { decision: 'unavailable', candidates: 0, valid: 0 };
  if (found.capped) return { decision: 'shared-line', candidates: found.leadIds.length, valid: 0 };

  const valid: any[] = [];
  for (const id of found.leadIds) {
    const row: any = await crmDb.getLeadById(listId, id, { consistentRead: true });
    if (row && !String(row.email ?? '').trim() && phoneDedupeKey(row.phone) === phoneKey) valid.push(row);
  }
  if (valid.length === 0) return { decision: 'miss', candidates: found.leadIds.length, valid: 0 };

  const compatible = valid.filter((row) => !phoneNamesConflict(row, incoming));
  if (compatible.length === 0) return { decision: 'name-conflict', candidates: found.leadIds.length, valid: valid.length };

  // Oldest by creation time; leadId only breaks a tie (ids are not uniformly time-prefixed).
  compatible.sort((a, b) => String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')) || String(a.leadId).localeCompare(String(b.leadId)));
  return { decision: 'match', candidates: found.leadIds.length, valid: valid.length, lead: compatible[0] };
}
