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
 *    cached ICP search filters, so a no-op write must not do that);
 *  - Emma also fills empty brand fields from the strategy after each write (`populateEmptyBrandGuidelines`); the route does not, so this tool does not;
 *  - the route rebuilds the stored strategy from its six known keys (businessOverview, competitors, icp, createdAt, updatedAt, icpUpdatedAt), where Emma's
 *    merge keeps any other top-level key the record happens to hold.
 *
 * The merge is read, merge, write through the route. Three things keep its baseline honest: calls on one ACCOUNT (the org, when the caller belongs to one)
 * are taken in turn in this process; a read that shows nothing stored is read once more before it is believed (a missed read of a long-lived account would
 * otherwise turn the write into a replace); and a read older than what this process saved a moment ago is not used (the route reads through an eventually
 * consistent index). Calls that reach different server instances are not covered.
 */

import { mcpFetch } from './httpClient';
import { jsonResult } from './toolHelpers';
import { withAccountLock } from './accountLock';

/** Most entries one update call may carry, per list. */
export const MAX_STRATEGY_ENTRIES_PER_CALL = 100;
/** Most entries a list may hold after a merge that adds to it. */
export const MAX_STORED_COMPETITORS = 500;
export const MAX_STORED_ICPS = 100;
/**
 * Most bytes the overview and both lists may take together after a merge that makes them bigger. The strategy sits on the account record, one DynamoDB item
 * of at most 400 KB that also holds everything else of the account; a save that cannot fit is refused here with a reason instead of coming back from the route
 * as an unexplained 500. A record that is already over this limit can still be edited, as long as the edit does not make it bigger.
 */
export const MAX_STRATEGY_BYTES = 250_000;
/** How long this process remembers what it last saved for an account, to recognise a read that is older than that save. */
const RECENT_WRITE_TTL_MS = 60_000;
const RECENT_WRITE_MAX_ACCOUNTS = 100;
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

/** The top-level arguments each action takes. Any other argument is refused by name: it would be dropped while the call reported success. */
const UPDATE_ARGUMENTS = ['action', 'businessOverview', 'competitors', 'icp'];
const READ_ARGUMENTS = ['action', 'competitorOffset', 'competitorNames'];
/** Identity-style arguments some callers add to every tool. They are never used (the strategy is always the caller's own); the answer says they were ignored. */
const IGNORED_ARGUMENTS = ['client_id', 'clientId', 'user_id', 'userId'];

/** Refuse an argument this action does not take. Returns the identity-style arguments that were sent and will be ignored. */
function checkArguments(args: any, action: 'read' | 'update'): string[] {
  const accepted = action === 'update' ? UPDATE_ARGUMENTS : READ_ARGUMENTS;
  const sent = Object.keys(args ?? {}).filter((k) => args[k] !== undefined && args[k] !== null);
  // The three never-stored arguments of an update have their own, more specific refusal below.
  const unknown = sent.filter((k) => !accepted.includes(k) && !IGNORED_ARGUMENTS.includes(k) && !(action === 'update' && Object.prototype.hasOwnProperty.call(NEVER_STORED_ARGUMENTS, k)));
  if (unknown.length > 0) {
    const names = unknown.map((k) => `"${k}"`).join(', ');
    const takes = accepted.filter((a) => a !== 'action').join(', ');
    throw new Error(`manage_market_strategy ${action}: ${names} ${unknown.length > 1 ? 'are not inputs' : 'is not an input'} of ${action} (it would be dropped, not saved). ${action === 'update' ? 'Update' : 'Read'} takes ${takes}.${action === 'update' ? ' Nothing was changed.' : ''}`);
  }
  return sent.filter((k) => IGNORED_ARGUMENTS.includes(k));
}

const fail = (message: string): never => { throw new Error(`manage_market_strategy update: ${message} Nothing was changed.`); };

/** Characters that show nothing (zero-width spaces and joiners, word joiner, byte-order mark, soft hyphen): a name holding one would look like another and not match it. */
const INVISIBLE = /[\u200B-\u200D\u2060\uFEFF\u00AD]/g;
/** A name as it is stored: no invisible characters, no padding. */
const cleanName = (value: string): string => value.replace(INVISIBLE, '').trim();
/** Case, padding, repeated-space and invisible-character insensitive identity of an entry (Emma's stored / not-stored lookup ignores case and padding). */
const identity = (value: unknown): string => cleanName(String(value ?? '')).toLowerCase().replace(/\s+/g, ' ');

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
    if (unknownKeys.length > 0) return fail(`${at} has fields that are not stored: ${unknownKeys.map((k) => `"${k}"`).join(', ')}. Supported fields: ${known.join(', ')}. Other fields shown when you read an entry (such as extractedFilters) are kept for you: leave them out.`);
    const key = raw[keyField];
    const name = typeof key === 'string' ? cleanName(key) : '';
    if (name === '') return fail(`${at}.${keyField} is required and must be text.`);
    if (name.length > MAX_ENTRY_KEY_CHARS) return fail(`${at}.${keyField} must be ${MAX_ENTRY_KEY_CHARS} characters or fewer.`);
    const clean: Entry = { [keyField]: name };
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

/** Is `incoming` (already trimmed) what is stored? Stored text and persona lists are compared trimmed too, so stored padding never makes a repeat look like a change. */
function sameValue(stored: unknown, incoming: unknown): boolean {
  if (typeof incoming === 'string' && typeof stored === 'string') return stored.trim() === incoming;
  if (Array.isArray(incoming) && Array.isArray(stored)) return JSON.stringify(stored.map((v) => (typeof v === 'string' ? v.trim() : v))) === JSON.stringify(incoming);
  return JSON.stringify(stored) === JSON.stringify(incoming);
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
  const exact = new Map<string, number>();
  merged.forEach((entry, i) => {
    // A stored entry can be a bare string (the old tool's schema was a bare array, and Emma's own lookup reads such entries as names): it is an entry named by that text.
    const named = typeof entry === 'string' ? entry : plainObject(entry) ? entry[keyField] : undefined;
    const key = identity(named);
    if (key && !index.has(key)) index.set(key, i);
    const spelled = cleanName(String(named ?? ''));
    if (spelled && !exact.has(spelled)) exact.set(spelled, i);
  });
  const added: string[] = [];
  const updated: string[] = [];
  const unchanged: string[] = [];
  for (const entry of incoming) {
    const key = identity(entry[keyField]);
    // The entry stored under exactly this spelling wins over a stored entry that differs only in case or spacing.
    const at = exact.get(String(entry[keyField])) ?? index.get(key);
    if (at === undefined) {
      merged.push(entry);
      index.set(key, merged.length - 1);
      exact.set(String(entry[keyField]), merged.length - 1);
      added.push(String(entry[keyField]));
      continue;
    }
    // A bare string becomes an entry holding that name, with what the caller sent laid over it.
    const current: Entry = typeof merged[at] === 'string' ? { [keyField]: cleanName(merged[at] as string) } : (merged[at] as Entry);
    const next: Entry = { ...current };
    let changed = false;
    for (const [field, value] of Object.entries(entry)) {
      if (field === keyField) continue;
      if (!sameValue(current[field], value)) {
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
const bytesOf = (value: unknown): number => Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');

/** The route's answer to GET /api/market-strategy, checked: anything that is not a success carrying a strategy object is not a baseline to merge onto. */
function checkedStrategy(response: any, action: 'read' | 'update'): Record<string, any> {
  if (!plainObject(response) || response.success !== true || !plainObject(response.data)) {
    throw new Error(`manage_market_strategy ${action}: the stored market strategy could not be read, so nothing was changed. Try again.`);
  }
  return response.data;
}

/** What this process last saved for an account (the route's own answer), so a read that is older than that save is not mistaken for the current strategy. */
const recentWrites = new Map<string, { at: number; updatedAt: string; data: Record<string, any>; saves: Array<{ at: number; parts: string[] }> }>();
export function clearRecentStrategyWrites(): void { recentWrites.clear(); }
const freshWrite = (key: string) => {
  const mine = recentWrites.get(key);
  if (mine && Date.now() - mine.at > RECENT_WRITE_TTL_MS) { recentWrites.delete(key); return undefined; }
  return mine;
};
/**
 * Remember a save (the route's answer) and which parts the call itself changed. A part counts for one minute from the save that changed it: parts that were
 * only carried along by a later call do not start a new minute, so the memory does not chain.
 */
function rememberWrite(key: string, data: Record<string, any>, ownParts: string[]): void {
  if (typeof data.updatedAt !== 'string') return;
  const now = Date.now();
  const saves = [...(freshWrite(key)?.saves ?? []).filter((x) => now - x.at <= RECENT_WRITE_TTL_MS), { at: now, parts: ownParts }];
  recentWrites.delete(key);
  recentWrites.set(key, { at: now, updatedAt: data.updatedAt, data, saves });
  for (const k of [...recentWrites.keys()]) freshWrite(k);
  while (recentWrites.size > RECENT_WRITE_MAX_ACCOUNTS) recentWrites.delete(recentWrites.keys().next().value as string);
}
/** The parts a save of the last minute changed. */
function recentlyChangedParts(key: string): Set<string> {
  const now = Date.now();
  return new Set((freshWrite(key)?.saves ?? []).filter((x) => now - x.at <= RECENT_WRITE_TTL_MS).flatMap((x) => x.parts));
}
function newestOf(key: string, read: Record<string, any>): Record<string, any> {
  const mine = freshWrite(key);
  if (!mine) return read;
  return typeof read.updatedAt === 'string' && read.updatedAt >= mine.updatedAt ? read : mine.data;
}

/** `update`: read the stored strategy, merge, and send the route only the parts that changed. */
export async function executeStrategyUpdate(args: any, c: any): Promise<any> {
  const ignored = checkArguments(args, 'update');
  for (const [name, advice] of Object.entries(NEVER_STORED_ARGUMENTS)) {
    if (args[name] !== undefined && args[name] !== null) fail(`"${name}" is not stored by the market strategy (${advice}). The market strategy holds businessOverview, competitors and icp.`);
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

  // One call at a time per ACCOUNT (the org, for a member of one) within this process: the merge below is read, merge, write, so two calls sent together
  // (one agent's parallel calls, or two members' agents) would each merge onto the same stored lists and the second write would drop the first one's entries.
  return withAccountLock('strategy', c, async (lockKey) => {
    let stored = checkedStrategy(await mcpFetch({ method: 'GET', path: '/api/market-strategy', context: c }), 'update');
    if (typeof stored.createdAt !== 'string') {
      // The read shows no strategy stored. That is true for an account that never saved one, and also what a missed read of a long-lived account looks like (the
      // route's read can miss the org owner's record for a moment); a write built on a missed read replaces the real lists. Read once more before believing it.
      await new Promise((resolve) => setTimeout(resolve, 200));
      const again = checkedStrategy(await mcpFetch({ method: 'GET', path: '/api/market-strategy', context: c }), 'update');
      if (typeof again.createdAt === 'string') stored = again;
    }
    stored = newestOf(lockKey, stored);
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
      if (stored[kind] !== undefined && stored[kind] !== null && !Array.isArray(stored[kind])) {
        fail(`the stored ${kind} are not a list, so they cannot be merged safely.`);
      }
      const outcome = mergeStrategyEntries(stored[kind], incoming, keyField);
      if (outcome.added.length > 0 && outcome.merged.length > cap) {
        fail(`${kind} would hold ${outcome.merged.length} entries, over the limit of ${cap}. Update existing entries instead of adding more.`);
      }
      if (outcome.added.length > 0 || outcome.updated.length > 0) body[kind] = outcome.merged;
      answer[kind] = { added: outcome.added, updated: outcome.updated, unchanged: outcome.unchanged, total: outcome.merged.length };
    }

    if (Object.keys(body).length === 0) {
      return jsonResult({ ...answer, changed: false, ...(ignored.length > 0 ? { ignoredArguments: ignored } : {}), message: 'Everything sent is already stored exactly as given; nothing was written.' });
    }
    // The route fills every part this call does not send from its OWN read of the account, which can be older than a save made a moment ago (it reads through an
    // eventually consistent index) and would write that older part back over the saved one. So a part that a save of the last minute changed is sent again
    // from the checked baseline, whatever this call changes.
    const ownParts = Object.keys(body);
    for (const part of recentlyChangedParts(lockKey)) {
      if (body[part] === undefined && stored[part] !== undefined && stored[part] !== null) body[part] = stored[part];
    }
    const sizeBefore = bytesOf({ businessOverview: stored.businessOverview, competitors: stored.competitors, icp: stored.icp });
    const sizeAfter = bytesOf({ businessOverview: body.businessOverview ?? stored.businessOverview, competitors: body.competitors ?? stored.competitors, icp: body.icp ?? stored.icp });
    if (sizeAfter > MAX_STRATEGY_BYTES && sizeAfter > sizeBefore) {
      fail(`the strategy would take ${sizeAfter} bytes, over the limit of ${MAX_STRATEGY_BYTES} (it sits on the account record, which has a hard size limit). Shorten entries or update existing ones instead of adding more.`);
    }
    const saved = strategyOf(await mcpFetch({ method: 'POST', path: '/api/market-strategy', context: c, body }));
    rememberWrite(lockKey, saved, ownParts);
    // Totals are what the route reports as saved, not what was computed here.
    for (const kind of ['competitors', 'icp'] as const) {
      const section = answer[kind] as Record<string, unknown> | undefined;
      if (section && Array.isArray(saved[kind])) section.total = (saved[kind] as unknown[]).length;
    }
    return jsonResult({ ...answer, changed: true, ...(ignored.length > 0 ? { ignoredArguments: ignored } : {}) });
  });
}

/** Whole number of 0 or more from a number or digits-only text; anything else is refused by name. */
function offsetOf(value: unknown): number {
  if (value === undefined || value === null || value === '') return 0;
  const n = typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value.trim()) : value;
  // A number too big to be exact is still "past the end": it lands on the last entry like any other offset past the end.
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) throw new Error('manage_market_strategy read: competitorOffset must be a whole number of 0 or more.');
  return Math.min(n, Number.MAX_SAFE_INTEGER);
}

/**
 * `read`: the stored strategy with the competitor list paged by size. A large roster used to come back whole; now a page holds about
 * COMPETITOR_PAGE_CHAR_BUDGET characters of competitors, the true total is always reported, and `nextCompetitorOffset` says where the next page starts
 * (null on the last). `competitorNames` answers stored / not stored for up to 50 names whatever the page shows, so a caller can check before adding.
 */
export async function executeStrategyRead(args: any, c: any): Promise<any> {
  const ignored = checkArguments(args, 'read');
  const names = args.competitorNames;
  if (names !== undefined && names !== null && (!Array.isArray(names) || names.some((n: unknown) => typeof n !== 'string'))) {
    throw new Error('manage_market_strategy read: competitorNames must be a list of text.');
  }
  const requested = offsetOf(args.competitorOffset);
  const response: any = await mcpFetch({ method: 'GET', path: '/api/market-strategy', context: c });
  const strategy = checkedStrategy(response, 'read');
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
    ...(strategy.competitors !== undefined && strategy.competitors !== null && !Array.isArray(strategy.competitors) ? { warning: 'The stored competitors are not a list; totalCompetitors counts none of them. They are shown as stored.' } : {}),
    ...response,
    data: { ...strategy, competitors: all.slice(start, end) },
    totalCompetitors: all.length,
    competitorOffset: start,
    competitorsReturned: end - start,
    nextCompetitorOffset: end < all.length ? end : null,
    ...(ignored.length > 0 ? { ignoredArguments: ignored } : {}),
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
