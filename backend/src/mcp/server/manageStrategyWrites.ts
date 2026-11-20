/**
 * ENG-2840 wave 1 (PR C): what an outside agent may write to the market strategy through `manage_market_strategy`, and how the read pages.
 *
 * The tool used to forward its arguments to POST /api/market-strategy as they came. That route reads only `businessOverview`, `competitors` and
 * `icp` (the other three arguments the tool advertised, positioning, differentiators and channels, were dropped without a word), and it
 * REPLACES the stored competitor and ICP lists with whatever it is given: an agent that sent one new competitor deleted all the others. Emma's
 * own tool (emma/impl/brandMarketStrategy.ts) reads the strategy first and merges by name (competitors) and by title (ICPs). This module does
 * the same through the REST route, which stays as it is, so the customer portal's behaviour does not change: the route's replace is harmless
 * because the lists it is given are already the merged ones.
 *
 * Differences from Emma, on purpose:
 *  - only the known fields of an entry are accepted (the route and the stored type know name/description and title/description/valueProposition/
 *    buyerPersonas); Emma spreads any extra key onto the stored strategy, which would let an outside agent write arbitrary keys into the account record;
 *  - blank text means "not given" and never overwrites a stored value; an empty list changes nothing (Emma's spread would blank a description);
 *  - names match without regard to case and padding, as Emma's own stored/not-stored lookup does, so "hubspot" does not become a second "HubSpot";
 *  - a call that changes nothing writes nothing (a write that carries `icp` marks the ICP as hand-edited, which switches the account off its
 *    cached ICP search filters, so a no-op write must not do that).
 */

import { mcpFetch } from './httpClient';
import { jsonResult } from './toolHelpers';
import { withLeadLock } from './manageLeadsWrites';

/** Most entries one update call may carry, per list. */
export const MAX_STRATEGY_ENTRIES_PER_CALL = 100;
/** Most entries a list may hold after a merge that adds to it (the account record is one DynamoDB item; an update that cannot be saved should fail here, clearly). */
export const MAX_STORED_COMPETITORS = 500;
export const MAX_STORED_ICPS = 100;
export const MAX_ENTRY_KEY_CHARS = 200;
export const MAX_ENTRY_TEXT_CHARS = 5_000;
export const MAX_BUYER_PERSONAS = 50;
export const MAX_BUYER_PERSONA_CHARS = 500;
export const MAX_BUSINESS_OVERVIEW_CHARS = 20_000;
/** Characters of competitor entries one read page may hold (at least one entry is always returned). */
export const COMPETITOR_PAGE_CHAR_BUDGET = 12_000;
/** Names one read checks against the stored list (the same limit Emma's read has). */
export const COMPETITOR_LOOKUP_MAX = 50;

const COMPETITOR_FIELDS = ['name', 'description'] as const;
const ICP_FIELDS = ['title', 'description', 'valueProposition', 'buyerPersonas'] as const;

/** Arguments the tool advertised that the route never stored. Refused by name, so a caller does not believe they were saved. */
const NEVER_STORED_ARGUMENTS: Record<string, string> = {
  positioning: 'put the positioning in businessOverview',
  differentiators: 'put the differentiators in businessOverview',
  channels: 'the market strategy does not store channels',
};

type Entry = Record<string, unknown>;
type KeyField = 'name' | 'title';

const fail = (message: string): never => { throw new Error(`manage_market_strategy update: ${message} Nothing was changed.`); };

/** Case and padding insensitive identity of an entry (what Emma's stored/not-stored lookup compares). */
const identity = (value: unknown): string => String(value ?? '').trim().toLowerCase();

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * One list from the caller, checked and cleaned: only known fields, text where text belongs, blank text dropped (= not given), sizes bounded.
 * Returns undefined when the caller did not send the list at all.
 */
export function validateStrategyEntries(kind: 'competitors' | 'icp', value: unknown): Entry[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) return fail(`${kind} must be a list of objects.`);
  if (value.length > MAX_STRATEGY_ENTRIES_PER_CALL) return fail(`${kind} may hold at most ${MAX_STRATEGY_ENTRIES_PER_CALL} entries per call (got ${value.length}); send them in several calls.`);
  const keyField: KeyField = kind === 'competitors' ? 'name' : 'title';
  const known: readonly string[] = kind === 'competitors' ? COMPETITOR_FIELDS : ICP_FIELDS;
  return value.map((raw, i) => {
    const at = `${kind}[${i}]`;
    if (!plainObject(raw)) return fail(`${at} must be an object with a ${keyField}.`);
    const unknownKeys = Object.keys(raw).filter((k) => !known.includes(k));
    if (unknownKeys.length > 0) return fail(`${at} has fields that are not stored: ${unknownKeys.map((k) => `"${k}"`).join(', ')}. Supported fields: ${known.join(', ')}.`);
    const key = raw[keyField];
    if (typeof key !== 'string' || key.trim() === '') return fail(`${at}.${keyField} is required and must be text.`);
    if (key.trim().length > MAX_ENTRY_KEY_CHARS) return fail(`${at}.${keyField} must be ${MAX_ENTRY_KEY_CHARS} characters or fewer.`);
    const clean: Entry = { [keyField]: key.trim() };
    for (const field of known) {
      if (field === keyField || raw[field] === undefined || raw[field] === null) continue;
      if (field === 'buyerPersonas') {
        const personas = raw[field];
        if (!Array.isArray(personas) || personas.some((p) => typeof p !== 'string')) return fail(`${at}.buyerPersonas must be a list of text.`);
        const kept = (personas as string[]).map((p) => p.trim()).filter((p) => p !== '');
        if (kept.length > MAX_BUYER_PERSONAS) return fail(`${at}.buyerPersonas may hold at most ${MAX_BUYER_PERSONAS} entries.`);
        if (kept.some((p) => p.length > MAX_BUYER_PERSONA_CHARS)) return fail(`${at}.buyerPersonas entries must be ${MAX_BUYER_PERSONA_CHARS} characters or fewer.`);
        if (kept.length > 0) clean[field] = kept;
        continue;
      }
      const text = raw[field];
      if (typeof text !== 'string') return fail(`${at}.${field} must be text.`);
      if (text.trim().length > MAX_ENTRY_TEXT_CHARS) return fail(`${at}.${field} must be ${MAX_ENTRY_TEXT_CHARS} characters or fewer.`);
      if (text.trim() !== '') clean[field] = text.trim();
    }
    return clean;
  });
}

export interface MergeOutcome {
  merged: unknown[];
  added: string[];
  updated: string[];
  unchanged: string[];
}

/**
 * Emma's merge: an incoming entry whose name (competitors) or title (ICPs) is already stored is laid over that entry, field by field (fields the caller did
 * not send stay as stored, including fields this tool cannot write, such as the ICP's cached search filters); any other entry is appended. The stored entry
 * keeps its own spelling of the name. Nothing stored is removed.
 */
export function mergeStrategyEntries(stored: unknown, incoming: Entry[], keyField: KeyField): MergeOutcome {
  const merged: unknown[] = Array.isArray(stored) ? stored.slice() : [];
  const index = new Map<string, number>();
  merged.forEach((entry, i) => {
    if (!plainObject(entry)) return;
    const key = identity(entry[keyField]);
    if (key && !index.has(key)) index.set(key, i);
  });
  const added: string[] = [];
  const updated: string[] = [];
  const unchanged: string[] = [];
  for (const entry of incoming) {
    const key = identity(entry[keyField]);
    const at = index.get(key);
    if (at === undefined) {
      merged.push(entry);
      index.set(key, merged.length - 1);
      added.push(String(entry[keyField]));
      continue;
    }
    const current = merged[at] as Entry;
    const next: Entry = { ...current };
    let changed = false;
    for (const [field, value] of Object.entries(entry)) {
      if (field === keyField) continue;
      if (JSON.stringify(current[field]) !== JSON.stringify(value)) {
        next[field] = value;
        changed = true;
      }
    }
    if (changed) merged[at] = next;
    (changed ? updated : unchanged).push(String(current[keyField]));
  }
  return { merged, added, updated, unchanged };
}

const strategyOf = (response: any): Record<string, any> => (plainObject(response?.data) ? response.data : {});
const listOf = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** `update`: read the stored strategy, merge, and send the route only the parts that changed. */
export async function executeStrategyUpdate(args: any, c: any): Promise<any> {
  for (const [name, advice] of Object.entries(NEVER_STORED_ARGUMENTS)) {
    if (args[name] !== undefined) fail(`"${name}" is not stored by the market strategy (${advice}). The market strategy holds businessOverview, competitors and icp.`);
  }
  let overview: string | undefined;
  if (args.businessOverview !== undefined && args.businessOverview !== null) {
    if (typeof args.businessOverview !== 'string') fail('businessOverview must be text.');
    if (args.businessOverview.trim().length > MAX_BUSINESS_OVERVIEW_CHARS) fail(`businessOverview must be ${MAX_BUSINESS_OVERVIEW_CHARS} characters or fewer.`);
    if (args.businessOverview.trim() !== '') overview = args.businessOverview.trim();
  }
  const competitors = validateStrategyEntries('competitors', args.competitors);
  const icp = validateStrategyEntries('icp', args.icp);
  if (overview === undefined && !(competitors && competitors.length > 0) && !(icp && icp.length > 0)) {
    fail('send at least one of businessOverview, competitors or icp with content. Blank text and empty lists change nothing, and this tool cannot remove an entry.');
  }

  // One call at a time per account within this process: the merge below is read, merge, write, so two of one agent's parallel calls would otherwise each merge
  // onto the same stored lists and the second write would drop the first one's entries. The key is the acting user (org members share one strategy; two members
  // writing at once, and calls reaching different server instances, are not covered).
  const who = c?.userId || c?.agentUserId || 'unknown';
  return withLeadLock(`strategy:${who}`, async () => {
    const stored = strategyOf(await mcpFetch({ method: 'GET', path: '/api/market-strategy', context: c }));
    const body: Record<string, unknown> = {};
    const answer: Record<string, unknown> = { success: true };

    if (overview !== undefined) {
      const same = typeof stored.businessOverview === 'string' && stored.businessOverview.trim() === overview;
      if (!same) body.businessOverview = overview;
      answer.businessOverview = same ? 'unchanged' : 'updated';
    }
    const lists: Array<['competitors' | 'icp', Entry[] | undefined, KeyField, number]> = [
      ['competitors', competitors, 'name', MAX_STORED_COMPETITORS],
      ['icp', icp, 'title', MAX_STORED_ICPS],
    ];
    for (const [kind, incoming, keyField, cap] of lists) {
      if (!incoming || incoming.length === 0) continue;
      const outcome = mergeStrategyEntries(stored[kind], incoming, keyField);
      if (outcome.added.length > 0 && outcome.merged.length > cap) {
        fail(`${kind} would hold ${outcome.merged.length} entries, over the limit of ${cap}. Update existing entries instead of adding more.`);
      }
      if (outcome.added.length > 0 || outcome.updated.length > 0) body[kind] = outcome.merged;
      answer[kind] = { added: outcome.added, updated: outcome.updated, unchanged: outcome.unchanged, total: outcome.merged.length };
    }

    if (Object.keys(body).length === 0) {
      return jsonResult({ ...answer, changed: false, message: 'Everything sent is already stored exactly as given; nothing was written.' });
    }
    const saved = strategyOf(await mcpFetch({ method: 'POST', path: '/api/market-strategy', context: c, body }));
    // Totals are what the route reports as saved, not what was computed here.
    for (const kind of ['competitors', 'icp'] as const) {
      const section = answer[kind] as Record<string, unknown> | undefined;
      if (section && Array.isArray(saved[kind])) section.total = (saved[kind] as unknown[]).length;
    }
    return jsonResult({ ...answer, changed: true });
  });
}

/** Whole number of 0 or more from a number or digits-only text; anything else is refused by name. */
function offsetOf(value: unknown): number {
  if (value === undefined || value === null || value === '') return 0;
  const n = typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value.trim()) : value;
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0) throw new Error('manage_market_strategy read: competitorOffset must be a whole number of 0 or more.');
  return n;
}

/**
 * `read`: the stored strategy with the competitor list paged by size. A large roster used to come back whole; now a page holds about
 * COMPETITOR_PAGE_CHAR_BUDGET characters of competitors, the true total is always reported, and `nextCompetitorOffset` says where the next page starts
 * (null on the last). `competitorNames` answers stored / not stored for up to 50 names whatever the page shows, so a caller can check before adding.
 */
export async function executeStrategyRead(args: any, c: any): Promise<any> {
  const names = args.competitorNames;
  if (names !== undefined && names !== null && (!Array.isArray(names) || names.some((n: unknown) => typeof n !== 'string'))) {
    throw new Error('manage_market_strategy read: competitorNames must be a list of text.');
  }
  const requested = offsetOf(args.competitorOffset);
  const response: any = await mcpFetch({ method: 'GET', path: '/api/market-strategy', context: c });
  const strategy = strategyOf(response);
  const all = listOf(strategy.competitors);
  // An offset past the end lands on the last entry rather than an empty page: an empty page reads as "no competitors".
  const start = all.length === 0 ? 0 : Math.min(requested, all.length - 1);
  let end = start;
  let used = 0;
  while (end < all.length) {
    const cost = JSON.stringify(all[end]).length;
    if (end > start && used + cost > COMPETITOR_PAGE_CHAR_BUDGET) break;
    used += cost;
    end++;
  }
  const out: Record<string, unknown> = {
    ...response,
    data: { ...strategy, competitors: all.slice(start, end) },
    totalCompetitors: all.length,
    competitorOffset: start,
    competitorsReturned: end - start,
    nextCompetitorOffset: end < all.length ? end : null,
  };
  if (Array.isArray(names) && names.length > 0) {
    const byName = new Map<string, number>();
    all.forEach((entry, i) => {
      const key = identity(plainObject(entry) ? entry.name : entry);
      if (key && !byName.has(key)) byName.set(key, i);
    });
    out.competitorLookup = (names as string[]).slice(0, COMPETITOR_LOOKUP_MAX).map((name) => {
      const at = byName.get(identity(name));
      return { name, stored: at !== undefined, offset: at ?? null };
    });
    out.competitorNamesNotChecked = Math.max(0, names.length - COMPETITOR_LOOKUP_MAX);
  }
  return jsonResult(out);
}
