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
 *  - removal is deliberate: `remove_founders: [names]` removes exactly those founders (exact name match after trimming and ignoring case, at most 20
 *    per call), and the answer says which were removed and which were not found. This is the `removeFounders` shape the ENG-2875 card itself proposes.
 * This differs from Emma on purpose, and the PR says so.
 *
 * The REST route is unchanged. The founder merge is read, merge, write through the route, so a founder change made between the read and the write (by
 * the portal, or another session) can be overwritten; one agent's parallel calls are serialized in this process (the same lock the lead tools use).
 */

import { mcpFetch } from './httpClient';
import { jsonResult } from './toolHelpers';
import { withLeadLock } from './manageLeadsWrites';
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

/** The five fields of a stored founder, and the longest text each may hold. */
const FOUNDER_TEXT_LIMITS: Record<string, number> = {
  jobTitle: 200,
  styleTone: 2_000,
  signaturePosts: 10_000,
  voiceExamples: 20_000,
};

type Founder = Record<string, unknown>;

const fail = (message: string): never => { throw new Error(`manage_brand update: ${message} Nothing was changed.`); };
const identity = (value: unknown): string => String(value ?? '').trim().toLowerCase();
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
    const unknown = Object.keys(raw).filter((k) => k !== 'name' && !(k in FOUNDER_TEXT_LIMITS));
    if (unknown.length > 0) return fail(`${at} has fields that are not stored: ${unknown.map((k) => `"${k}"`).join(', ')}. Supported fields: name, ${Object.keys(FOUNDER_TEXT_LIMITS).join(', ')}.`);
    if (typeof raw.name !== 'string' || raw.name.trim() === '') return fail(`${at}.name is required and must be text.`);
    if (raw.name.trim().length > MAX_FOUNDER_NAME_CHARS) return fail(`${at}.name must be ${MAX_FOUNDER_NAME_CHARS} characters or fewer.`);
    const clean: Founder = { name: raw.name.trim() };
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
  if (value.some((n: string) => n.trim() === '')) return fail('remove_founders names must not be blank.');
  return (value as string[]).map((n) => n.trim());
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
  const index = new Map<string, number>();
  founders.forEach((f, i) => {
    const key = plainObject(f) ? identity(f.name) : '';
    if (key && !index.has(key)) index.set(key, i);
  });
  const added: string[] = [];
  const updated: string[] = [];
  const unchanged: string[] = [];
  for (const entry of incoming) {
    const key = identity(entry.name);
    const at = index.get(key);
    if (at === undefined) {
      founders.push({ ...entry });
      index.set(key, founders.length - 1);
      added.push(String(entry.name));
      continue;
    }
    const current = founders[at];
    let changed = false;
    for (const [field, value] of Object.entries(entry)) {
      if (field === 'name') continue;
      if (JSON.stringify(current[field]) !== JSON.stringify(value)) {
        current[field] = value;
        changed = true;
      }
    }
    (changed ? updated : unchanged).push(String(current.name));
  }
  const removed: string[] = [];
  const notFound: string[] = [];
  const dropped = new Set<number>();
  for (const name of removeNames) {
    const at = index.get(identity(name));
    if (at === undefined || dropped.has(at)) {
      if (at === undefined) notFound.push(name);
      continue;
    }
    dropped.add(at);
    removed.push(String(founders[at].name));
  }
  return { founders: founders.filter((_, i) => !dropped.has(i)), added, updated, unchanged, removed, notFound };
}

const storedFoundersOf = (response: any): unknown[] => (Array.isArray(response?.brandData?.founders) ? response.brandData.founders : []);

/** `update`: the six fields the tool always had, plus tagline, domain, brand values, brand personality and founders (merge by name; removal only by name). */
export async function executeBrandUpdate(args: any, c: any): Promise<any> {
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

  const who = c?.userId || c?.agentUserId || 'unknown';
  return withLeadLock(`brand:${who}`, async () => {
    let outcome: FounderOutcome | undefined;
    if (touchesFounders) {
      const current: any = await mcpFetch({ method: 'GET', path: '/api/brand/guidelines', context: c });
      outcome = mergeFoundersForMcp(storedFoundersOf(current), incoming, removeNames);
      if (outcome.added.length > 0 && outcome.founders.length > MAX_STORED_FOUNDERS) {
        fail(`the brand would hold ${outcome.founders.length} founders, over the limit of ${MAX_STORED_FOUNDERS}. Update existing founders instead of adding more.`);
      }
      const changed = outcome.added.length + outcome.updated.length + outcome.removed.length > 0;
      if (changed) body.founders = outcome.founders;
      if (!changed && Object.keys(body).length === 0) {
        return jsonResult({ success: true, changed: false, founders: foundersAnswer(outcome, outcome.founders.length), message: 'Everything sent is already stored exactly as given; nothing was written.' });
      }
    }
    const saved: any = await mcpFetch({ method: 'POST', path: '/api/brand/guidelines', context: c, body });
    const answer: Record<string, unknown> = { ...(plainObject(saved) ? saved : {}), success: true, changed: true };
    if (outcome && body.founders !== undefined) {
      // The route answers with a message only; read the founders back so the answer reports what is stored, not what was intended.
      const after: any = await mcpFetch({ method: 'GET', path: '/api/brand/guidelines', context: c });
      const stored = storedFoundersOf(after);
      const wanted = (body.founders as Founder[]).map((f) => identity(f.name));
      const got = stored.map((f: any) => identity(f?.name));
      if (wanted.length !== got.length || wanted.some((n, i) => n !== got[i])) {
        return jsonResult({ success: false, error: 'The founders could not be verified on read-back; check them with manage_brand read before retrying.', founders: foundersAnswer(outcome, stored.length) });
      }
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
