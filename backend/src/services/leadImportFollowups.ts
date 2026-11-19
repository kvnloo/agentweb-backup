/**
 * ENG-2996: what every bulk lead import (bulk-import route, CSV import, Emma
 * add_leads_to_list) does with the leads it just CREATED.
 *
 * 1. Do-not-contact inheritance (awaited): a new lead whose email already
 *    belongs to a do-not-contact lead of the same owner is flagged
 *    do-not-contact too. Re-importing an opted-out contact must not quietly
 *    make them sendable again. A lookup that fails is counted and reported,
 *    never read as "not blocked".
 * 2. Email validation (fire-and-forget): one validateLeadEmailInBackground per
 *    distinct address, bounded concurrency, same as single-lead create.
 */

import { crmDb } from './db';
import { validateLeadEmailInBackground } from './enrichSoLeadValidation';
import { isDoNotContact } from '../utils/leadContactStatus';

export interface ImportedLead {
  leadId: string;
  email?: string;
}

export interface LeadImportFollowupResult {
  /** leadIds flagged do-not-contact because the owner already blocked that address. */
  inheritedDoNotContact: string[];
  /** Addresses whose do-not-contact lookup failed (lead left as imported). */
  doNotContactCheckFailed: number;
}

const CONCURRENCY = 8;

const normalize = (email: unknown): string => (typeof email === 'string' ? email.trim().toLowerCase() : '');

async function forEachBounded<T>(items: T[], worker: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
    while (i < items.length) await worker(items[i++]);
  }));
}

export async function applyLeadImportFollowups(
  listId: string,
  ownerUserId: string,
  created: ImportedLead[],
  opts: { actingUserId?: string; validate?: boolean } = {},
): Promise<LeadImportFollowupResult> {
  const byAddress = new Map<string, ImportedLead[]>();
  for (const lead of created) {
    const address = normalize(lead.email);
    if (!address) continue;
    byAddress.set(address, [...(byAddress.get(address) ?? []), lead]);
  }

  const result: LeadImportFollowupResult = { inheritedDoNotContact: [], doNotContactCheckFailed: 0 };
  const createdIds = new Set(created.map(l => l.leadId));
  const listOwners = new Map<string, Promise<string | undefined>>();
  // The owner of a matching lead is the owner of the LIST it sits in, never the lead's own `userId`: that is a field a caller can supply when creating
  // a lead (the single-lead route stores the body as given), so another tenant could plant a do-not-contact lead that names THIS owner and have it
  // flag this owner's later adds. (For a lead created normally the two are the same.)
  const ownerOf = async (lead: any): Promise<string | undefined> => {
    if (!lead.listId) return undefined;
    if (!listOwners.has(lead.listId)) {
      listOwners.set(lead.listId, crmDb.getLeadListById(lead.listId).then((l: any) => l?.userId));
    }
    return listOwners.get(lead.listId);
  };

  const now = new Date().toISOString();
  await forEachBounded([...byAddress.entries()], async ([address, leads]) => {
    let source: any;
    try {
      for (const existing of (await crmDb.findAllLeadsByEmail(address)) as any[]) {
        if (createdIds.has(existing.leadId) || !isDoNotContact(existing)) continue;
        if ((await ownerOf(existing)) === ownerUserId) { source = existing; break; }
      }
    } catch (err) {
      result.doNotContactCheckFailed++;
      console.error(`[leadImport] do-not-contact lookup failed for an imported address in list ${listId}:`, (err as Error).message);
      return;
    }
    if (!source) return;
    for (const lead of leads) {
      try {
        await crmDb.updateLead(listId, lead.leadId, {
          contactStatus: 'do-not-contact',
          contactStatusReason: source.contactStatusReason || 'other',
          contactStatusNote: 'Inherited on import: this email is already marked do-not-contact on another of your leads',
          contactStatusUpdatedAt: now,
          contactStatusUpdatedBy: opts.actingUserId ?? 'system',
          unsubscribedFromGroupEmail: true,
          unsubscribedFromGroupEmailAt: now,
        } as any);
        result.inheritedDoNotContact.push(lead.leadId);
      } catch (err) {
        result.doNotContactCheckFailed++;
        console.error(`[leadImport] failed to flag inherited do-not-contact on ${lead.leadId}:`, (err as Error).message);
      }
    }
  });

  if (opts.validate !== false) {
    const firstPerAddress = [...byAddress.values()].map(leads => leads[0]);
    void forEachBounded(firstPerAddress, async (lead) => {
      try {
        await validateLeadEmailInBackground(listId, lead.leadId, lead.email as string, opts.actingUserId);
      } catch (err) {
        console.error('[leadImport] background validation failed:', (err as Error).message);
      }
    });
  }

  return result;
}
