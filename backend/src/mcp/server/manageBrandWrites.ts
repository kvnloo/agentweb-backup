/**
 * ENG-2840 wave 1 (PR C): what an outside agent may write to the brand guidelines through `manage_brand`.
 *
 * The tool mapped six fields onto POST /api/brand/guidelines. That route also takes the tagline, the domain, the brand values, the brand personality
 * and the founder profiles, which Emma's own `update_brand_guidelines` writes; over MCP they could not be set. This module adds them.
 *
 * FOUNDERS are the one field where the route and Emma disagree with what is safe for an outside agent. The route REPLACES the stored list (an empty
 * list wipes it). Emma treats a non-empty list as the COMPLETE roster: a stored founder it leaves out is removed (ENG-2875, so the customer who could
 * not remove a founder through Emma can). Emma and the portal hold the whole roster; an outside agent that sends one founder does not, and under
 * Emma's rule it would delete the others. So over MCP (the owner's decision, 2026-11-19):
 *  - `founders` MERGES by name: a stored founder with the same name (case and padding ignored) is updated field by field, a new name is added, and a
 *    stored founder that is not mentioned is kept. An empty list changes nothing. Omission never removes anyone.
 *  - removal is deliberate: `remove_founders: [names]` removes exactly those founders (the same name match as the merge: case, padding, repeated spaces and invisible characters ignored; at most 20
 *    per call), and the answer says which were removed and which were not found. This is the `removeFounders` shape the ENG-2875 card itself proposes.
 * This differs from Emma on purpose, and the PR says so.
 *
 * The REST route is unchanged. The founder merge is read, merge, write through the route, so a founder change made between the read and the write (by
 * the portal, or another session) can be overwritten. Three things keep its baseline honest: calls on one ACCOUNT (the org, when the caller belongs to one)
 * are taken in turn in this process; a read that shows no brand is read once more before it is believed (a missed read of a long-lived account would
 * otherwise turn the write into a replace of the stored founders); and a read older than what this process just saved and read back is not used. Calls
 * that reach different server instances are not covered.
 */

import { mcpFetch } from './httpClient';
import { jsonResult } from './toolHelpers';
import { withAccountLock } from './accountLock';
import { mapManageBrandUpdate } from '../../utils/brandGuidelines';

export const MAX_FOUNDERS_PER_CALL = 20;
export const MAX_REMOVE_FOUNDERS_PER_CALL = 20;
export const MAX_STORED_FOUNDERS = 50;
export const MAX_FOUNDER_NAME_CHARS = 200;
export const MAX_BRAND_VALUES = 50;
export const MAX_BRAND_VALUE_CHARS = 200;
export const MAX_TAGLINE_CHARS = 300;
export const MAX_DOMAIN_CHARS = 253;
export const MAX_BRAND_PERSONALITY_CHARS = 2_000;
/** Most bytes the founder profiles may take together after a call that makes them bigger (the brand sits on one DynamoDB item of at most 400 KB; an oversized save is refused here with a reason). */
export const MAX_FOUNDERS_BYTES = 250_000;

/** The five fields of a stored founder, and the longest text each may hold. */
const FOUNDER_TEXT_LIMITS: Record<string, number> = {
  jobTitle: 200,
  styleTone: 2_000,
  signaturePosts: 10_000,
  voiceExamples: 20_000,
};

type Founder = Record<string, unknown>;

/** The top-level arguments an update takes. Any other argument is refused by name: it would be dropped while the call reported success. */
const UPDATE_ARGUMENTS = ['action', 'company_name', 'mission', 'tone_of_voice', 'target_audience', 'key_messages', 'tagline', 'domain', 'brand_values', 'brand_personality', 'visual_identity', 'founders', 'remove_founders'];
/** Identity-style arguments some callers add to every tool. They are never used (the brand is always the caller's own); the answer says they were ignored. */
const IGNORED_ARGUMENTS = ['client_id', 'clientId', 'user_id', 'userId'];

/** Refuse an argument an update does not take. Returns the identity-style arguments that were sent and will be ignored. */
function checkArguments(args: any): string[] {
  const sent = Object.keys(args ?? {}).filter((k) => args[k] !== undefined);
  const unknown = sent.filter((k) => !UPDATE_ARGUMENTS.includes(k) && !IGNORED_ARGUMENTS.includes(k));
  if (unknown.length > 0) {
    const names = unknown.map((k) => `"${k}"`).join(', ');
    throw new Error(`manage_brand update: ${names} ${unknown.length > 1 ? 'are not inputs' : 'is not an input'} of update (it would be dropped, not saved). Update takes ${UPDATE_ARGUMENTS.filter((a) => a !== 'action').join(', ')}. Nothing was changed.`);
  }
  return sent.filter((k) => IGNORED_ARGUMENTS.includes(k));
}

const fail = (message: string): never => { throw new Error(`manage_brand update: ${message} Nothing was changed.`); };
/** Characters that show nothing (zero-width spaces and joiners, word joiner, byte-order mark, soft hyphen): a name holding one would look like another and not match it. */
const INVISIBLE = /[\u200B-\u200D\u2060\uFEFF\u00AD]/g;
/** A name as it is stored: no invisible characters, no padding. */
const cleanName = (value: string): string => value.replace(INVISIBLE, '').trim();
/** Case, padding, repeated-space and invisible-character insensitive identity of a founder. */
const identity = (value: unknown): string => cleanName(String(value ?? '')).toLowerCase().replace(/\s+/g, ' ');
const hasOwn = (object: object, key: string): boolean => Object.prototype.hasOwnProperty.call(object, key);
const bytesOf = (value: unknown): number => Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');
const plainObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Plain text field: undefined / null = not given; text is trimmed; blank = not given. */
function optionalText(value: unknown, name: string, max: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') return fail(`${name} must be text.`);
  const t = value.trim();
  if (t.length > max) return fail(`${name} must be ${max} characters or fewer.`);
  return t === '' ? undefined : t;
}

/** The founders the caller sent, checked and cleaned (only the five known fields; blank text = not given). Undefined when not sent. */
export function validateFounders(value: unknown): Founder[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) return fail('founders must be a list of objects.');
  if (value.length > MAX_FOUNDERS_PER_CALL) return fail(`founders may hold at most ${MAX_FOUNDERS_PER_CALL} entries per call (got ${value.length}).`);
  return value.map((raw, i) => {
    const at = `founders[${i}]`;
    if (!plainObject(raw)) return fail(`${at} must be an object with a name.`);
    const unknown = Object.keys(raw).filter((k) => k !== 'name' && !hasOwn(FOUNDER_TEXT_LIMITS, k));
    if (unknown.length > 0) return fail(`${at} has fields that are not stored: ${unknown.map((k) => `"${k}"`).join(', ')}. Supported fields: name, ${Object.keys(FOUNDER_TEXT_LIMITS).join(', ')}.`);
    const name = typeof raw.name === 'string' ? cleanName(raw.name) : '';
    if (name === '') return fail(`${at}.name is required and must be text.`);
    if (name.length > MAX_FOUNDER_NAME_CHARS) return fail(`${at}.name must be ${MAX_FOUNDER_NAME_CHARS} characters or fewer.`);
    const clean: Founder = { name };
    for (const [field, max] of Object.entries(FOUNDER_TEXT_LIMITS)) {
      const text = optionalText(raw[field], `${at}.${field}`, max);
      if (text !== undefined) clean[field] = text;
    }
    return clean;
  });
}

/** The names to remove, checked: text, not blank, at most 20. Undefined when not sent. */
export function validateRemoveFounders(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((n) => typeof n !== 'string')) return fail('remove_founders must be a list of founder names (text).');
  if (value.length > MAX_REMOVE_FOUNDERS_PER_CALL) return fail(`remove_founders may hold at most ${MAX_REMOVE_FOUNDERS_PER_CALL} names per call (got ${value.length}).`);
  const names = (value as string[]).map(cleanName);
  if (names.some((n) => n === '')) return fail('remove_founders names must not be blank.');
  if (names.some((n) => n.length > MAX_FOUNDER_NAME_CHARS)) return fail(`remove_founders names must be ${MAX_FOUNDER_NAME_CHARS} characters or fewer.`);
  return names;
}

export interface FounderOutcome {
  founders: Founder[];
  added: string[];
  updated: string[];
  unchanged: string[];
  removed: string[];
  notFound: string[];
}

/**
 * Merge by name, then remove the named ones. Stored order is kept, a matched founder is updated in place (keeping its own spelling of the name and any field
 * the caller did not send), new founders are appended, and a stored founder nobody mentions stays. A founder both sent and listed for removal is refused by
 * the caller of this function, not here.
 */
export function mergeFoundersForMcp(stored: unknown, incoming: Founder[], removeNames: string[]): FounderOutcome {
  const founders: Founder[] = Array.isArray(stored) ? stored.map((f) => (plainObject(f) ? { ...f } : (f as Founder))) : [];
  // Every stored copy of a name (older data can hold the same founder twice): an update lays the sent fields over all of them and a removal drops all of them.
  const index = new Map<string, number[]>();
  founders.forEach((f, i) => {
    const key = plainObject(f) ? identity(f.name) : '';
    if (key) index.set(key, [...(index.get(key) ?? []), i]);
  });
  const added: string[] = [];
  const updated: string[] = [];
  const unchanged: string[] = [];
  for (const entry of incoming) {
    const key = identity(entry.name);
    const copies = index.get(key);
    if (copies === undefined) {
      founders.push({ ...entry });
      index.set(key, [founders.length - 1]);
      added.push(String(entry.name));
      continue;
    }
    let changed = false;
    for (const at of copies) {
      for (const [field, value] of Object.entries(entry)) {
        if (field === 'name') continue;
        if (JSON.stringify(founders[at][field]) !== JSON.stringify(value)) {
          founders[at][field] = value;
          changed = true;
        }
      }
    }
    (changed ? updated : unchanged).push(String(founders[copies[0]].name));
  }
  const removed: string[] = [];
  const notFound: string[] = [];
  const dropped = new Set<number>();
  for (const name of removeNames) {
    const copies = index.get(identity(name))?.filter((at) => !dropped.has(at));
    if (copies === undefined) {
      notFound.push(name);
      continue;
    }
    if (copies.length === 0) continue;
    removed.push(String(founders[copies[0]].name));
    for (const at of copies) dropped.add(at);
  }
  return { founders: founders.filter((_, i) => !dropped.has(i)), added, updated, unchanged, removed, notFound };
}

const storedFoundersOf = (response: any): unknown[] => (Array.isArray(response?.brandData?.founders) ? response.brandData.founders : []);

/** The route's answer to GET /api/brand/guidelines, checked: it answers either `exists: false` or `exists: true` with the brand data; anything else is not a baseline. */
function checkedBrandRead(response: any): any {
  if (!plainObject(response) || typeof response.exists !== 'boolean' || (response.exists && !plainObject(response.brandData))) {
    throw new Error('manage_brand update: the stored brand guidelines could not be read, so nothing was changed. Try again.');
  }
  return response;
}

/**
 * What this process last saved for an account's founders (the roster it meant to save, stamped just before the save, or the one it read back), so a read that
 * is older than that save is not mistaken for the current roster. The org read is eventually consistent, so even the read-back can be older than the save: the
 * intended roster is remembered whether or not the read-back matched it.
 */
const RECENT_WRITE_TTL_MS = 60_000;
const RECENT_WRITE_MAX_ACCOUNTS = 100;
const recentWrites = new Map<string, { at: number; updatedAt: string; founders: unknown[] }>();
export function clearRecentBrandWrites(): void { recentWrites.clear(); }
export function recentBrandWriteKeys(): string[] { return [...recentWrites.keys()]; }
const freshWrite = (key: string) => {
  const mine = recentWrites.get(key);
  if (mine && Date.now() - mine.at > RECENT_WRITE_TTL_MS) { recentWrites.delete(key); return undefined; }
  return mine;
};
function rememberWrite(key: string, updatedAt: string, founders: unknown[]): void {
  recentWrites.delete(key);
  recentWrites.set(key, { at: Date.now(), updatedAt, founders });
  for (const k of [...recentWrites.keys()]) freshWrite(k);
  while (recentWrites.size > RECENT_WRITE_MAX_ACCOUNTS) recentWrites.delete(recentWrites.keys().next().value as string);
}
/** The founders to merge onto: what the read shows, unless it is older than what this process saved a moment ago. */
function baselineFounders(key: string, read: any): unknown[] {
  const mine = freshWrite(key);
  if (!mine) return storedFoundersOf(read);
  return typeof read?.updatedAt === 'string' && read.updatedAt >= mine.updatedAt ? storedFoundersOf(read) : mine.founders;
}

/** What a stored founder holds that this tool writes: the read-back compares all of it, not only the names. */
const fingerprint = (f: any): string => JSON.stringify([f?.name ?? '', f?.jobTitle ?? '', f?.styleTone ?? '', f?.signaturePosts ?? '', f?.voiceExamples ?? '']);
const sameRoster = (stored: unknown[], intended: Founder[]): boolean => stored.length === intended.length && intended.every((f, i) => fingerprint(stored[i]) === fingerprint(f));

/** `read`: unchanged, except that an argument it does not take is refused by name (it would be ignored while the call looked like a read of what was sent). */
export async function executeBrandRead(args: any, c: any): Promise<any> {
  const sent = Object.keys(args ?? {}).filter((k) => args[k] !== undefined && k !== 'action');
  const unknown = sent.filter((k) => !IGNORED_ARGUMENTS.includes(k));
  if (unknown.length > 0) {
    throw new Error(`manage_brand read: ${unknown.map((k) => `"${k}"`).join(', ')} ${unknown.length > 1 ? 'are not inputs' : 'is not an input'} of read (it takes no arguments; to change the brand use action "update").`);
  }
  const data: any = await mcpFetch({ method: 'GET', path: '/api/brand/guidelines', context: c });
  const ignored = sent.filter((k) => IGNORED_ARGUMENTS.includes(k));
  return jsonResult(ignored.length > 0 && plainObject(data) ? { ...data, ignoredArguments: ignored } : data);
}

/** `update`: the six fields the tool always had, plus tagline, domain, brand values, brand personality and founders (merge by name; removal only by name). */
export async function executeBrandUpdate(args: any, c: any): Promise<any> {
  const ignored = checkArguments(args);
  // The six fields the tool always had keep their mapping and behaviour unchanged.
  const body: Record<string, unknown> = mapManageBrandUpdate(args);

  const tagline = optionalText(args.tagline, 'tagline', MAX_TAGLINE_CHARS);
  if (tagline !== undefined) body.tagline = tagline;
  const domain = optionalText(args.domain, 'domain', MAX_DOMAIN_CHARS);
  if (domain !== undefined) body.domain = domain;
  const personality = optionalText(args.brand_personality, 'brand_personality', MAX_BRAND_PERSONALITY_CHARS);
  if (personality !== undefined) body.brandPersonality = personality;
  if (args.brand_values !== undefined && args.brand_values !== null) {
    const values = args.brand_values;
    if (!Array.isArray(values) || values.some((v: unknown) => typeof v !== 'string')) fail('brand_values must be a list of text.');
    const kept = (values as string[]).map((v) => v.trim()).filter((v) => v !== '');
    if (kept.length > MAX_BRAND_VALUES) fail(`brand_values may hold at most ${MAX_BRAND_VALUES} entries.`);
    if (kept.some((v) => v.length > MAX_BRAND_VALUE_CHARS)) fail(`brand_values entries must be ${MAX_BRAND_VALUE_CHARS} characters or fewer.`);
    // An empty list is "not given", as it is for the founders: it never clears the stored values.
    if (kept.length > 0) body.brandValues = kept;
  }

  const incoming = validateFounders(args.founders) ?? [];
  const removeNames = validateRemoveFounders(args.remove_founders) ?? [];
  const sent = new Set(incoming.map((f) => identity(f.name)));
  const both = removeNames.filter((n) => sent.has(identity(n)));
  if (both.length > 0) fail(`${both.map((n) => `"${n}"`).join(', ')} appears in both founders and remove_founders; send one or the other.`);

  const touchesFounders = incoming.length > 0 || removeNames.length > 0;
  if (Object.keys(body).length === 0 && !touchesFounders) {
    fail('send at least one field to change. Blank text and empty lists change nothing, and a founder is only removed with remove_founders.');
  }

  return withAccountLock('brand', c, async (lockKey) => {
    let outcome: FounderOutcome | undefined;
    if (touchesFounders) {
      let current: any = checkedBrandRead(await mcpFetch({ method: 'GET', path: '/api/brand/guidelines', context: c }));
      if (!current.exists) {
        // No brand is stored, per this read. True for an account that never saved one, and also what a missed read of a long-lived account looks like (the
        // route's read can miss the org owner's record for a moment); a write built on a missed read replaces the stored founders. Read once more first.
        await new Promise((resolve) => setTimeout(resolve, 200));
        const again = checkedBrandRead(await mcpFetch({ method: 'GET', path: '/api/brand/guidelines', context: c }));
        if (again.exists) current = again;
      }
      outcome = mergeFoundersForMcp(baselineFounders(lockKey, current), incoming, removeNames);
      if (outcome.added.length > 0 && outcome.founders.length > MAX_STORED_FOUNDERS) {
        fail(`the brand would hold ${outcome.founders.length} founders, over the limit of ${MAX_STORED_FOUNDERS}. Update existing founders instead of adding more.`);
      }
      const changed = outcome.added.length + outcome.updated.length + outcome.removed.length > 0;
      const sizeAfter = bytesOf(outcome.founders);
      if (changed && sizeAfter > MAX_FOUNDERS_BYTES && sizeAfter > bytesOf(baselineFounders(lockKey, current))) {
        fail(`the founder profiles would take ${sizeAfter} bytes, over the limit of ${MAX_FOUNDERS_BYTES} (they sit on the brand record, which has a hard size limit). Shorten entries or update existing ones instead of adding more.`);
      }
      if (changed) body.founders = outcome.founders;
      if (!changed && Object.keys(body).length === 0) {
        return jsonResult({ success: true, changed: false, ...(ignored.length > 0 ? { ignoredArguments: ignored } : {}), founders: foundersAnswer(outcome, outcome.founders.length), message: 'Everything sent is already stored exactly as given; nothing was written.' });
      }
    }
    const savedAt = new Date().toISOString();
    const saved: any = await mcpFetch({ method: 'POST', path: '/api/brand/guidelines', context: c, body });
    const answer: Record<string, unknown> = { ...(plainObject(saved) ? saved : {}), success: true, changed: true, ...(ignored.length > 0 ? { ignoredArguments: ignored } : {}) };
    if (outcome && body.founders !== undefined) {
      const intended = body.founders as Founder[];
      // The route answers with a message only; read the founders back so the answer reports what is stored, not what was intended. The org read can be older than
      // the save (it is eventually consistent), so a read that does not match is repeated once before the answer says it could not be verified.
      let after: any;
      try {
        after = checkedBrandRead(await mcpFetch({ method: 'GET', path: '/api/brand/guidelines', context: c }));
        if (!sameRoster(storedFoundersOf(after), intended)) {
          await new Promise((resolve) => setTimeout(resolve, 300));
          after = checkedBrandRead(await mcpFetch({ method: 'GET', path: '/api/brand/guidelines', context: c }));
        }
      } catch (err) {
        rememberWrite(lockKey, savedAt, intended);
        return jsonResult({ success: false, error: `The brand was saved, but reading the founders back failed (${(err as Error)?.message ?? 'unknown error'}); check them with manage_brand read.`, founders: foundersAnswer(outcome, intended.length) });
      }
      const stored = storedFoundersOf(after);
      if (!sameRoster(stored, intended)) {
        // Whatever the reads showed, the save went through (the route answered): remember the roster it meant, so the next call does not merge onto an older read.
        rememberWrite(lockKey, savedAt, intended);
        return jsonResult({ success: false, error: 'The founders could not be verified on read-back; check them with manage_brand read before retrying.', founders: foundersAnswer(outcome, stored.length) });
      }
      rememberWrite(lockKey, typeof after.updatedAt === 'string' && after.updatedAt > savedAt ? after.updatedAt : savedAt, stored);
      answer.founders = foundersAnswer(outcome, stored.length);
    } else if (outcome) {
      answer.founders = foundersAnswer(outcome, outcome.founders.length);
    }
    return jsonResult(answer);
  });
}

function foundersAnswer(o: FounderOutcome, total: number): Record<string, unknown> {
  return { added: o.added, updated: o.updated, unchanged: o.unchanged, removed: o.removed, notFound: o.notFound, total };
}
