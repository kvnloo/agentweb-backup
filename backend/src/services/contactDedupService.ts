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

export interface DedupedContact {
  /** Canonical email (lowercased, trimmed) — the dedup key. */
  email: string;
  /** Display name, or email fallback. */
  name: string;
  company: string;
  /** 0-10 coarse heat score derived from engagement count + recency. */
  heatScore: number;
  /** ISO timestamp of the last engagement / updatedAt. */
  lastContactAt: string;
  /** List memberships this email appears in. */
  lists: Array<{ listId: string; name: string }>;
  /** Concrete lead row used for click-through / promote actions. */
  primaryLead: any;
}

export interface DedupQuery {
  userId: string;
  /** Optional: restrict to a specific listType (e.g. "sales"). */
  listType?: 'sales' | 'customers';
  /** Optional: restrict to a specific list id subset. */
  listIds?: string[];
  /** Optional: max number of deduped rows to return (after sort). */
  limit?: number;
  /** Optional sort order. Defaults to heatScore desc then lastContactAt desc. */
  sort?: 'heat' | 'recent';
  /**
   * Max total raw leads to process across all lists (default: 5000).
   * Distributed evenly across lists. Prevents loading all 100k+ records.
   */
  rawFetchLimit?: number;
  /**
   * Opaque pagination cursor: base64-encoded JSON map of
   * { [listId]: lastEvaluatedKey | null } indicating where to resume per list.
   * Omit for the first page.
   */
  cursor?: string;
}

export interface DedupResult {
  contacts: DedupedContact[];
  /** Total deduped rows in this window (before limit). */
  total: number;
  /** Total raw lead rows processed (for observability). */
  rawCount: number;
  /** Lists consulted. */
  listsCount: number;
  /** Cursor to pass for the next window. Undefined when all lists are exhausted. */
  nextCursor?: string;
  /** True when at least one list has more leads beyond this window. */
  hasMore: boolean;
}

/** Coarse heat score — mirrors the frontend computeHeatScore utility. */
export function computeHeatScore(lead: any): number {
  const engagementCount =
    lead?.engagementCount ?? (Array.isArray(lead?.engagements) ? lead.engagements.length : 0) ?? 0;
  let score = Math.min(engagementCount, 5);

  const lastContactRaw = pickLastContact(lead);
  if (lastContactRaw) {
    const age = Date.now() - new Date(lastContactRaw).getTime();
    const days = age / (1000 * 60 * 60 * 24);
    if (days < 1) score += 5;
    else if (days < 3) score += 4;
    else if (days < 7) score += 3;
    else if (days < 14) score += 2;
    else if (days < 30) score += 1;
  }
  return Math.min(10, Math.max(0, score));
}

function pickLastContact(lead: any): string | undefined {
  const engs = Array.isArray(lead?.engagements) ? lead.engagements : [];
  let latest: string | undefined;
  for (const e of engs) {
    if (!e?.createdAt) continue;
    if (!latest || new Date(e.createdAt).getTime() > new Date(latest).getTime()) {
      latest = e.createdAt;
    }
  }
  return latest ?? lead?.updatedAt ?? lead?.createdAt;
}

const RAW_FETCH_DEFAULT = 5000;
const BATCH_SIZE = 500;

/**
 * Fetch leads across a user's lists and dedupe by lowercased email.
 * Returns deduped contacts sorted by heat score (desc) by default.
 *
 * Supports cursor-based windowed fetching so callers can page through
 * large datasets (100k+ leads) without loading everything at once.
 */
export async function dedupContactsForUser(query: DedupQuery): Promise<DedupResult> {
  const { userId } = query;
  if (!userId || typeof userId !== 'string') {
    throw new Error('userId is required');
  }

  const rawFetchLimit = query.rawFetchLimit ?? RAW_FETCH_DEFAULT;
  if (rawFetchLimit < 1) {
    throw new Error('rawFetchLimit must be >= 1');
  }

  // Decode cursor: map of { [listId]: lastEvaluatedKey | null }
  let startCursors: Record<string, any> = {};
  if (query.cursor) {
    try {
      const parsed = JSON.parse(Buffer.from(query.cursor, 'base64').toString('utf8'));
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('not an object');
      }
      startCursors = parsed;
    } catch {
      throw new Error('Invalid cursor');
    }
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

  // Budget: distribute rawFetchLimit evenly across lists.
  const perListBudget = Math.max(1, Math.ceil(rawFetchLimit / Math.max(1, filteredLists.length)));

  // Track ending cursor position per list for the nextCursor response.
  const endCursors: Record<string, any> = {};

  const perListResults = await Promise.all(
    filteredLists.map(async (list: any) => {
      try {
        const leads: any[] = [];
        let lastKey: any = startCursors[list.listId] ?? undefined;
        let fetched = 0;
        let safety = 0;

        while (fetched < perListBudget && safety < 20) {
          safety++;
          const batchSize = Math.min(BATCH_SIZE, perListBudget - fetched);
          const page: any = await crmDb.getLeadsByListId(list.listId, batchSize, lastKey);
          const items = Array.isArray(page?.items) ? page.items : [];
          leads.push(...items);
          fetched += items.length;
          lastKey = page?.lastEvaluatedKey ?? null;
          if (!lastKey) break;
        }

        endCursors[list.listId] = lastKey ?? null;
        return { list, leads };
      } catch (err) {
        console.error(`[contactDedupService] list ${list?.listId} fetch failed:`, err);
        endCursors[list.listId] = null;
        return { list, leads: [] as any[] };
      }
    }),
  );

  // Group by lowercased email.
  const map = new Map<string, DedupedContact>();
  let rawCount = 0;

  for (const { list, leads } of perListResults) {
    for (const lead of leads) {
      rawCount += 1;
      const email = String(lead?.email ?? '').trim().toLowerCase();
      if (!email) continue;

      const membership = {
        listId: list.listId,
        name: list.name ?? 'Unnamed list',
      };
      const displayName =
        [lead.firstName, lead.lastName].filter(Boolean).join(' ').trim() || email;

      const existing = map.get(email);
      if (!existing) {
        map.set(email, {
          email,
          name: displayName,
          company: lead.company ?? '',
          heatScore: computeHeatScore(lead),
          lastContactAt: pickLastContact(lead) ?? lead.updatedAt ?? lead.createdAt ?? '',
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
        existing.lastContactAt = pickLastContact(lead) ?? existing.lastContactAt;
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

  const hasMore = Object.values(endCursors).some((k) => k !== null);
  const nextCursor = hasMore
    ? Buffer.from(JSON.stringify(endCursors)).toString('base64')
    : undefined;

  return {
    contacts: limited,
    total,
    rawCount,
    listsCount: filteredLists.length,
    nextCursor,
    hasMore,
  };
}
