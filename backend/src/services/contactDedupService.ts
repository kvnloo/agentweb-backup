/**
 * contactDedupService
 *
 * Server-side dedup of CRM leads across all of a user's lead lists.
 *
 * Background:
 *   The /crm Inbox tab previously deduped ~5000 leads across 20+ lists
 *   client-side, which made the page take 30-90s to load. This service
 *   fetches all of a user's lists, flattens their leads, groups by the
 *   lowercased email, computes a coarse heat score, and returns the
 *   deduped InboxLead shape the customer-portal's InboxView expects.
 *
 *   The dedup key matches the frontend's dedupeByEmail utility
 *   (lowercased + trimmed email). Leads with no email are dropped.
 */

import { crmDb } from './db';
import { phoneDigits, isDedupablePhone } from '../utils/smokeTestLead';
import type { LeadListType } from '../utils/leadSchema';

export interface DedupedContact {
  /**
   * What this contact is deduped ON. Email when there is one, else the phone, else the
   * lead itself. Callers that re-dedup across users MUST key on this and not on `email`:
   * every email-less contact has `email: ''`, so keying on the address collapses all of
   * them into a single row.
   */
  dedupKey: string;
  /** Canonical email (lowercased, trimmed). Empty for a phone-only contact. */
  email: string;
  /** Display name, or email fallback. */
  name: string;
  company: string;
  /** 0-10 coarse heat score derived from engagement count + recency. */
  heatScore: number;
  /** ISO timestamp of the last engagement / updatedAt. */
  lastContactAt: string;
  /** eventType of the most recent engagement (e.g. "email.received", "linkedin.message.received"). */
  latestEventType?: string;
  /** List memberships this email appears in. */
  lists: Array<{ listId: string; name: string }>;
  /** Concrete lead row used for click-through / promote actions. */
  primaryLead: any;
}

/** Safety cap on raw lead rows fetched across all lists. Prevents OOM on
 *  large accounts (e.g. 130k-lead lists). Inbox only needs a useful top-N. */
const DEFAULT_MAX_RAW_LEADS = 50_000;

export interface DedupQuery {
  userId: string;
  /** Optional: restrict to a specific listType (e.g. "sales"). When omitted, session lists
   *  are still excluded (ENG-2311) — pass "session" to read them deliberately. */
  listType?: LeadListType;
  /** Optional: restrict to a specific list id subset. */
  listIds?: string[];
  /** Optional: max number of deduped rows to return (after sort). */
  limit?: number;
  /** Optional sort order. Defaults to heatScore desc then lastContactAt desc. */
  sort?: 'heat' | 'recent';
  /** Optional: max raw lead rows to load across all lists before stopping.
   *  Defaults to DEFAULT_MAX_RAW_LEADS. Prevents OOM on very large accounts. */
  maxRawLeads?: number;
  /** Alias for maxRawLeads — used by the /contacts route. */
  rawFetchLimit?: number;
  /** Opaque base64 pagination cursor returned by a previous call. */
  cursor?: string;
}

export interface DedupResult {
  contacts: DedupedContact[];
  /** Total deduped rows (before limit). */
  total: number;
  /** Total raw lead rows processed (for observability). */
  rawCount: number;
  /** How many of those rows have no email address. They are included, not dropped. */
  noEmailCount: number;
  /** Lists consulted. */
  listsCount: number;
  /** Opaque cursor for fetching the next page (if pagination is active). */
  nextCursor?: string;
  /** Whether more pages are available. */
  hasMore?: boolean;
}

/** Coarse heat score — mirrors the frontend computeHeatScore utility. */
export function computeHeatScore(lead: any): number {
  const engagementCount =
    lead?.engagementCount ?? (Array.isArray(lead?.engagements) ? lead.engagements.length : 0) ?? 0;
  let score = Math.min(engagementCount, 5);

  const lastContact = pickLastContact(lead);
  if (lastContact) {
    const age = Date.now() - new Date(lastContact.at).getTime();
    const days = age / (1000 * 60 * 60 * 24);
    if (days < 1) score += 5;
    else if (days < 3) score += 4;
    else if (days < 7) score += 3;
    else if (days < 14) score += 2;
    else if (days < 30) score += 1;
  }
  return Math.min(10, Math.max(0, score));
}

function pickLastContact(lead: any): { at: string; eventType?: string } | undefined {
  const engs = Array.isArray(lead?.engagements) ? lead.engagements : [];
  let latestAt: string | undefined;
  let latestEventType: string | undefined;
  for (const e of engs) {
    if (!e?.createdAt) continue;
    if (!latestAt || new Date(e.createdAt).getTime() > new Date(latestAt).getTime()) {
      latestAt = e.createdAt;
      latestEventType = e.eventType;
    }
  }
  if (latestAt) return { at: latestAt, eventType: latestEventType };
  if (lead?.createdAt) return { at: lead.createdAt };
  return undefined;
}

/**
 * Fetch all leads across a user's lists and dedupe by lowercased email.
 * Returns deduped contacts sorted by heat score (desc) by default.
 *
 * Performance: replaces the client-side per-list fetch the Inbox tab used
 * to do. Calls run in parallel across lists.
 */
export async function dedupContactsForUser(query: DedupQuery): Promise<DedupResult> {
  const { userId } = query;
  if (!userId || typeof userId !== 'string') {
    throw new Error('userId is required');
  }

  const allLists = await crmDb.getLeadListsByUserId(userId);

  let filteredLists = Array.isArray(allLists) ? allLists : [];
  if (query.listType) {
    filteredLists = filteredLists.filter((l: any) => (l.listType ?? 'sales') === query.listType);
  }
  if (query.listIds && query.listIds.length > 0) {
    const allowed = new Set(query.listIds);
    filteredLists = filteredLists.filter((l: any) => allowed.has(l.listId));
  }

  const maxRawLeads = query.rawFetchLimit ?? query.maxRawLeads ?? DEFAULT_MAX_RAW_LEADS;

  // Sort lists by updatedAt desc so recently-active lists get their leads
  // fetched first when the cap would otherwise leave some lists unread.
  filteredLists = [...filteredLists].sort((a: any, b: any) => {
    const at = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
    const bt = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
    return bt - at;
  });

  // Distribute the raw-lead cap evenly across lists so no single huge list
  // starves out others.
  const perListCap = filteredLists.length > 0
    ? Math.ceil(maxRawLeads / filteredLists.length)
    : maxRawLeads;

  // Fetch leads for each list in parallel. Individual list failures are
  // swallowed so one bad list doesn't kill the whole call.
  const perListResults = await Promise.all(
    filteredLists.map(async (list: any) => {
      try {
        const leads: any[] = [];
        let lastKey: any = undefined;
        let safety = 0;
        do {
          const pageSize = Math.min(500, perListCap - leads.length);
          const page: any = await crmDb.getLeadsByListId(list.listId, pageSize, lastKey);
          if (Array.isArray(page?.items)) leads.push(...page.items);
          lastKey = page?.lastEvaluatedKey;
          safety += 1;
          if (safety > 50) break; // hard safety: 500 * 50 = 25k absolute max per list
          if (leads.length >= perListCap) break; // per-list cap hit
        } while (lastKey);
        return { list, leads };
      } catch (err) {
        console.error(`[contactDedupService] list ${list?.listId} fetch failed:`, err);
        return { list, leads: [] as any[] };
      }
    }),
  );

  // Group by lowercased email.
  const map = new Map<string, DedupedContact>();
  let rawCount = 0;
  let noEmailCount = 0;

  for (const { list, leads } of perListResults) {
    for (const lead of leads) {
      rawCount += 1;
      const email = String(lead?.email ?? '').trim().toLowerCase();
      // ENG-2082: a phone-only capture used to be counted in rawCount and then dropped, so
      // the Contacts/Inbox tab answered `{ total: 99, rawCount: 100 }` and the customer
      // watched a submission land and could not find it. Dedup on the strongest identity
      // the row actually has. Phone is a real one — two rows sharing a number are one
      // person — and the per-lead fallback can never collapse two distinct people.
      // isDedupablePhone, not just "has digits". `+1` and `1` both reduce to `1`, so every
      // lead across the account carrying only a country code collapsed into ONE row — the
      // others vanish from the Inbox and their list memberships are grafted onto the
      // survivor. A merge is destructive in a way a split is not, so the bar is "could this
      // be one person's number".
      const phone = phoneDigits(String(lead?.phone ?? ''));
      const dedupKey = email
        || (isDedupablePhone(lead?.phone) ? `phone:${phone}` : `lead:${list.listId}/${lead?.leadId}`);
      if (!email) noEmailCount += 1;

      const membership = {
        listId: list.listId,
        name: list.name ?? 'Unnamed list',
      };
      const displayName =
        [lead.firstName, lead.lastName].filter(Boolean).join(' ').trim() ||
        email ||
        String(lead?.phone ?? '').trim() ||
        'Unknown contact';

      const lastContact = pickLastContact(lead);
      const existing = map.get(dedupKey);
      if (!existing) {
        map.set(dedupKey, {
          dedupKey,
          email,
          name: displayName,
          company: lead.company ?? '',
          heatScore: computeHeatScore(lead),
          lastContactAt: lastContact?.at ?? '',
          latestEventType: lastContact?.eventType,
          lists: [membership],
          primaryLead: lead,
        });
        continue;
      }

      if (!existing.lists.some((l) => l.listId === membership.listId)) {
        existing.lists.push(membership);
      }

      const candidateHeat = computeHeatScore(lead);
      if (candidateHeat > existing.heatScore) {
        existing.heatScore = candidateHeat;
        existing.primaryLead = lead;
        existing.name = displayName || existing.name;
        existing.company = lead.company || existing.company;
        existing.lastContactAt = lastContact?.at ?? existing.lastContactAt;
        existing.latestEventType = lastContact?.eventType ?? existing.latestEventType;
      }
    }
  }

  const contacts = Array.from(map.values());

  // Sort.
  if (query.sort === 'recent') {
    contacts.sort((a, b) => {
      const at = new Date(a.lastContactAt || 0).getTime();
      const bt = new Date(b.lastContactAt || 0).getTime();
      return bt - at;
    });
  } else {
    contacts.sort((a, b) => {
      if (b.heatScore !== a.heatScore) return b.heatScore - a.heatScore;
      const at = new Date(a.lastContactAt || 0).getTime();
      const bt = new Date(b.lastContactAt || 0).getTime();
      return bt - at;
    });
  }

  const total = contacts.length;
  const limited =
    query.limit && query.limit > 0 ? contacts.slice(0, query.limit) : contacts;

  return {
    contacts: limited,
    total,
    rawCount,
    noEmailCount,
    listsCount: filteredLists.length,
  };
}
