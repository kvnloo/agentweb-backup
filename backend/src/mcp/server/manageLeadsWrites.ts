/**
 * ENG-2840 wave 1 (PR B): what an outside agent may write to a lead through `manage_leads`, and how the actions report their outcome.
 *
 * Emma's own lead tools (emma/impl/leads.ts) forward eleven standard fields, merge every other key into the lead's customFields, turn a
 * "do-not-contact" status into a real suppression, and can never write the contact-status fields themselves. The MCP actions used to forward
 * the body verbatim to the REST routes the customer portal uses, which accept far more: contact-status fields (an agent could un-suppress a
 * do-not-contact lead), server-owned keys (sync ids, attribution), and identity keys (userId, tenantId) that createLead stores as given.
 * Isolation of WHICH lead is still the REST route's job (it is exercised by mcp.twoTenantIsolation.test.ts); this module decides WHAT may be
 * written and keeps the routes untouched, so the portal's behaviour does not change.
 */

import { mcpFetch } from './httpClient';
import { jsonResult } from './toolHelpers';
import { mergeCustomFields } from '../../utils/customFieldsGuard';
import { leadPutGuardMode, SERVER_OWNED_LEAD_KEYS } from '../../utils/leadWriteGuard';
import { isDoNotContact } from '../../utils/leadContactStatus';

/** Most rows one add or delete call handles (the same cap Emma's bulk tools use). */
export const MAX_LEAD_ROWS_PER_CALL = 100;

/**
 * How long one add or delete call keeps working through its rows. Each row is one or two self-calls with their own side effects, and the
 * caller's connection has its own timeout; past the budget the remaining rows are NOT attempted and are reported as such, so the caller
 * knows exactly which to send again instead of retrying rows that already went through.
 */
export const ROW_WORK_BUDGET_MS = 90_000;

/**
 * One call at a time per key, in arrival order, within this process. The opt-out guards are read-then-write (the guard reads the lead, the write comes later), so
 * two calls from one agent sent in parallel ("mark do-not-contact" and "delete", "mark do-not-contact" and "change the email") could slip a write between a guard's
 * read and its write; so could an update racing a delete (it re-creates a one-field row), or two deletes of one lead (the list count is lowered twice). An MCP
 * session lives in ONE server process (sessions are held in memory), so one agent's parallel calls are serialized here. It does NOT serialize calls from different
 * sessions or different server instances: closing that needs conditional writes in the route and the database layer (stated in the PR; a follow-up).
 */
const keyedChains = new Map<string, Promise<unknown>>();
export async function withLeadLock<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = keyedChains.get(key) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => mine);
  keyedChains.set(key, tail);
  try {
    await previous;
    return await work();
  } finally {
    release();
    if (keyedChains.get(key) === tail) keyedChains.delete(key);
  }
}

/**
 * Fields forwarded as-is. Emma's eleven, plus those the REST routes validate themselves (lifecycle stage, the sender, which must be one the
 * account configured) and two plain profile fields; the review drafts and their format are accepted on update only (see DRAFT_FIELDS).
 */
export const MCP_LEAD_STANDARD_FIELDS: ReadonlySet<string> = new Set([
  'email', 'firstName', 'lastName', 'phone', 'company', 'title', 'notes', 'linkedin', 'status', 'dealValue', 'dealCurrency',
  'lifecycle', 'selectedSenderId', 'website', 'companyLinkedin',
  // CRM fields the verbatim forward used to let through and the create/update layer validates itself (priority, role, lifecycle and the scores are
  // checked by validateLeadCrmExtensions): accepted, so an existing caller that sets them keeps working.
  'domain', 'pocEmails', 'priority', 'role', 'isPrimary', 'expectedClose', 'closedDate', 'heatScore', 'healthScore',
]);

const TEXT_FIELDS: ReadonlySet<string> = new Set([
  'email', 'firstName', 'lastName', 'phone', 'company', 'title', 'notes', 'linkedin', 'status', 'dealCurrency', 'lifecycle', 'selectedSenderId',
  'website', 'companyLinkedin', 'domain', 'priority', 'role', 'expectedClose', 'closedDate',
]);
const NUMBER_FIELDS: ReadonlySet<string> = new Set(['dealValue', 'heatScore', 'healthScore']);
const BOOLEAN_FIELDS: ReadonlySet<string> = new Set(['isPrimary']);
const MAX_POC_EMAILS = 50;

/**
 * An email must be a plain ASCII address. The lead stores the text trimmed and lower-cased, and the opt-out is matched on that exact text, so a decorated form of
 * the same mailbox (`Name <a@b.test>`, `"a@b.test"`, `a@b.test.`) or one with invisible or look-alike characters (zero-width space, soft hyphen, full-width letters,
 * NUL) would be stored as a different string and NOT be flagged even when the address is opted out. (An empty value is allowed: a lead need not have an email.)
 */
const PLAIN_EMAIL_ADDRESS = /^[A-Za-z0-9._%+'!#$&*\/=?^`{|}~-]+@(?:[A-Za-z0-9-]+\.)+[A-Za-z0-9-]{2,}$/;

/**
 * A standard field of the wrong type is refused here: the update route records a status change with the value as given BEFORE the write is
 * validated, so an object in `status` would leave a malformed engagement on the lead (and fail the write). null clears a field, except `status`.
 */
function valueProblem(key: string, value: unknown): string | null {
  if (key === 'status' && (typeof value !== 'string' || !value.trim())) return 'status (must be non-empty text)';
  if (value === null) return null;
  if (key === 'email' && typeof value === 'string' && value.trim() && !PLAIN_EMAIL_ADDRESS.test(value.trim())) {
    return 'email (must be a plain ASCII address such as name@example.com)';
  }
  if (key === 'pocEmails') {
    return Array.isArray(value) && value.length <= MAX_POC_EMAILS && value.every((v) => typeof v === 'string')
      ? null : `pocEmails (must be a list of at most ${MAX_POC_EMAILS} email strings)`;
  }
  if (TEXT_FIELDS.has(key)) return typeof value === 'string' ? null : `${key} (must be text)`;
  if (NUMBER_FIELDS.has(key)) return typeof value === 'number' && Number.isFinite(value) ? null : `${key} (must be a number)`;
  if (BOOLEAN_FIELDS.has(key)) return typeof value === 'boolean' ? null : `${key} (must be true or false)`;
  return null;
}

/**
 * The update layer stores only domain and pocEmails of the CRM fields; the others take effect when a lead is created. On an update they would be
 * accepted and dropped while the call reported success (the same trap as drafts on add), so they are refused there, by name.
 */
const CREATE_ONLY_CRM_FIELDS: ReadonlySet<string> = new Set(['priority', 'role', 'isPrimary', 'expectedClose', 'closedDate', 'heatScore', 'healthScore']);

/**
 * Written by the system and READ as system data: the email validation result (the send-eligibility check reads it: an agent that could write it could mark an
 * undeliverable address deliverable) and the CRM sync ids the HubSpot and Attio adapters fall back to when syncMetadata has none (an agent that could write them
 * could point a lead at another record in the account's CRM).
 */
const SYSTEM_CUSTOM_KEYS: ReadonlySet<string> = new Set([
  'email_validation', 'hubspot_contact_id', 'hubspot_deal_id', 'attio_record_id', 'attio_list_entry_id', 'attio_deal_list_id',
]);

const MAX_DRAFT_CHARS = 200_000;

/**
 * A draft as the lead stores it. The route checks a draft only when status is "pending_review", and the update layer stores whatever it is given, so a
 * string where an object belongs would break the screens that render it: accept only the real shapes and stamp the times here. null clears a draft.
 */
function normalizeDraft(key: string, value: unknown): { value?: unknown; problem?: string } {
  if (value === null) return { value: null };
  const now = new Date().toISOString();
  const short = (v: unknown) => typeof v === 'string' && v.length <= MAX_DRAFT_CHARS;
  if (key === 'emailDraftFormat') return value === 'text' || value === 'html' ? { value } : { problem: 'emailDraftFormat (must be "text" or "html")' };
  if (key === 'messageDraft') {
    const content = isPlainObject(value) && Object.keys(value).every((k) => k === 'content') ? value.content : value;
    return short(content) && (content as string).trim()
      ? { value: { content, createdAt: now, updatedAt: now } }
      : { problem: 'messageDraft (must be non-empty text, or { content })' };
  }
  if (!isPlainObject(value) || !Object.keys(value).every((k) => k === 'subject' || k === 'htmlContent' || k === 'textContent')
    || !short(value.subject) || (value.htmlContent !== undefined && !short(value.htmlContent)) || (value.textContent !== undefined && !short(value.textContent))) {
    return { problem: 'emailDraft (must be { subject, htmlContent?, textContent? } of text)' };
  }
  return { value: { ...value, createdAt: now, updatedAt: now } };
}

/** Saved by an update. The create path never stores them (createLead builds the lead from a fixed field list), so on add they would be dropped while the call reported success. */
const DRAFT_FIELDS: ReadonlySet<string> = new Set(['emailDraft', 'messageDraft', 'emailDraftFormat']);

/**
 * Source tracking, accepted on add only and only as `attribution: { utm: { source, medium, campaign, content, term } }` (short strings). The REST route
 * turns it into the lead's first and last touch. Click ids, referrer, landing URL and the other parts of a touch feed the account's ad-conversion
 * relay, so an outside agent does not set them; the bare `utm` key is not accepted either (the route reads it in a different shape and would drop it).
 */
const ATTRIBUTION_UTM_KEYS: ReadonlySet<string> = new Set(['source', 'medium', 'campaign', 'content', 'term']);
const MAX_UTM_VALUE_CHARS = 200;

/** Contact status is changed only by setting `status` to "do-not-contact" (a suppression); it is never written, or reversed, directly. */
const CONTACT_STATUS_KEYS = [
  'contactStatus', 'contactStatusReason', 'contactStatusNote', 'contactStatusUpdatedAt', 'contactStatusUpdatedBy',
  'unsubscribedFromGroupEmail', 'unsubscribedFromGroupEmailAt',
];

/** Whose lead it is, and where it lives: always taken from the authenticated caller and the list in the request, never from the body. */
const IDENTITY_KEYS = ['userId', 'user_id', 'tenantId', 'accountOwnerUserId', 'orgId', 'listId', 'leadId', 'client_id', 'clientId'];

/** Links to other records (a deal id from another account would be stored as given) and enrichment results the system computes. */
const SYSTEM_OWNED_KEYS = ['dealIds', 'icpMatch', 'enrichmentMetadata'];

const REFUSED_LEAD_KEYS: ReadonlySet<string> = new Set([...SERVER_OWNED_LEAD_KEYS, ...CONTACT_STATUS_KEYS, ...IDENTITY_KEYS, ...SYSTEM_OWNED_KEYS]);

/** A custom field name that could reach the prototype of the object it is merged into. */
const UNSAFE_FIELD_NAMES: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

export interface ClassifiedLeadFields {
  /** Standard fields, forwarded as they are. */
  standard: Record<string, unknown>;
  /** Everything else (and an explicit `customFields` object), to be merged into the lead's custom fields. */
  custom: Record<string, unknown>;
  /** Keys that may not be set through MCP, by name. */
  refused: string[];
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

/** The part of `attribution` an agent may give: only utm, only short strings. Anything else is refused by name. */
function classifyAttribution(value: unknown): { utm?: Record<string, string>; refused: string[] } {
  if (!isPlainObject(value)) return { refused: ['attribution (must be { utm: { source, medium, campaign, content, term } })'] };
  const refused: string[] = [];
  let utm: Record<string, string> | undefined;
  for (const [key, part] of Object.entries(value)) {
    if (key !== 'utm') {
      refused.push(`attribution.${key}`);
    } else if (!isPlainObject(part)) {
      refused.push('attribution.utm (must be an object)');
    } else {
      utm = {};
      for (const [utmKey, utmValue] of Object.entries(part)) {
        if (ATTRIBUTION_UTM_KEYS.has(utmKey) && typeof utmValue === 'string') utm[utmKey] = utmValue.slice(0, MAX_UTM_VALUE_CHARS);
        else refused.push(`attribution.utm.${utmKey}`);
      }
    }
  }
  return { utm, refused };
}

export function classifyLeadFields(input: unknown, opts: { forAdd?: boolean } = {}): ClassifiedLeadFields {
  const out: ClassifiedLeadFields = { standard: {}, custom: {}, refused: [] };
  if (!isPlainObject(input)) return out;
  for (const [key, value] of Object.entries(input)) {
    if (REFUSED_LEAD_KEYS.has(key) || UNSAFE_FIELD_NAMES.has(key)) {
      out.refused.push(key);
    } else if (key === 'utm' || (key === 'attribution' && !opts.forAdd)) {
      out.refused.push(key);
    } else if (key === 'attribution') {
      const { utm, refused } = classifyAttribution(value);
      out.refused.push(...refused);
      if (utm && refused.length === 0) out.standard.attribution = { utm };
    } else if (DRAFT_FIELDS.has(key)) {
      if (opts.forAdd) {
        out.refused.push(key);
      } else {
        const draft = normalizeDraft(key, value);
        if (draft.problem) out.refused.push(draft.problem);
        else out.standard[key] = draft.value;
      }
    } else if (!opts.forAdd && CREATE_ONLY_CRM_FIELDS.has(key)) {
      out.refused.push(key);
    } else if (MCP_LEAD_STANDARD_FIELDS.has(key)) {
      const problem = valueProblem(key, value);
      if (problem) out.refused.push(problem);
      else out.standard[key] = value;
    } else if (key === 'customFields') {
      if (!isPlainObject(value)) {
        out.refused.push('customFields (must be an object)');
        continue;
      }
      for (const [customKey, customValue] of Object.entries(value)) {
        if (UNSAFE_FIELD_NAMES.has(customKey) || SYSTEM_CUSTOM_KEYS.has(customKey) || !customKey.trim()) out.refused.push(`customFields.${customKey || '(empty name)'}`);
        else out.custom[customKey] = customValue;
      }
    } else if (SYSTEM_CUSTOM_KEYS.has(key)) {
      out.refused.push(key);
    } else {
      out.custom[key] = value;
    }
  }
  return out;
}

function refusalError(action: string, refused: string[]): Error {
  const hints: string[] = [];
  if (refused.some((k) => k === 'utm' || k.startsWith('attribution'))) {
    hints.push('Source tracking can be given only when adding a lead, as attribution: { utm: { source, medium, campaign, content, term } }; click ids, referrer and landing URL are set by the system.');
  }
  if (refused.some((k) => DRAFT_FIELDS.has(k))) {
    hints.push('Drafts are saved with an update after the lead exists.');
  }
  if (refused.some((k) => CREATE_ONLY_CRM_FIELDS.has(k))) {
    hints.push('priority, role, isPrimary, expectedClose, closedDate, heatScore and healthScore can be given when a lead is added; an update does not store them.');
  }
  return new Error(
    `manage_leads ${action}: these fields cannot be set as given (refused or not valid): ${refused.join(', ')}. ` +
    'A lead is suppressed by setting status to "do-not-contact" (it cannot be reversed with this tool); who owns a lead, its sync data, its links to deals, ' +
    'its enrichment data and its contact status are set by the system. To store your own data under one of these names, put it inside customFields.' +
    (hints.length > 0 ? ` ${hints.join(' ')}` : '')
  );
}

function requireText(value: unknown, name: string, where: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${where}: ${name} is required and must be a string.`);
  return value;
}

/**
 * The same reading as Emma's suppressionContactStatusUpdates (emma/impl/leads.ts): any case or spacing, or "dnc". Kept here as a plain check so
 * a row can be refused before anything is written; a test pins it to Emma's helper.
 */
export function isDoNotContactStatus(status: unknown): boolean {
  if (typeof status !== 'string') return false;
  const normalized = status.trim().toLowerCase().replace(/[\s_]+/g, '-');
  return normalized === 'do-not-contact' || normalized === 'dnc';
}

/** The body for one lead being created: standard fields plus a customFields object when there are any. Throws, naming the keys, when any is refused. */
export function buildLeadCreateBody(lead: unknown): Record<string, unknown> {
  if (!isPlainObject(lead)) throw new Error('manage_leads add: a lead must be an object with fields (e.g. { email, firstName }).');
  const { standard, custom, refused } = classifyLeadFields(lead, { forAdd: true });
  if (refused.length > 0) throw refusalError('add', refused);
  if (isDoNotContactStatus(standard.status)) {
    // Suppression is applied by an update. A new lead given this status would only carry the label and stay sendable, which is the opposite of
    // what the caller means: refuse it, so an opt-out list is never imported as sendable leads.
    throw new Error('manage_leads add: a new lead cannot be created with status "do-not-contact" (it would be labelled but not suppressed). Add the lead, then update its status.');
  }
  return Object.keys(custom).length > 0 ? { ...standard, customFields: custom } : standard;
}

/** Query string for the list action: the parameters the REST route actually reads (it never read `lastKey`, so pagination by key never worked). */
export function buildLeadListQuery(args: any): Record<string, string> {
  const qp: Record<string, string> = {};
  // A model may send a number as text ("50") or leave an optional value empty or 0. The older list call accepted all of those (it forwarded `limit` as text and
  // skipped a falsy one), so they keep working: digits-only text is a number, and empty, blank or 0 means "not given". Anything else (negative, fractional,
  // words, objects) is refused instead of becoming NaN in the route.
  const wholeNumber = (value: unknown, name: string): string | undefined => {
    if (value === undefined || value === null) return undefined;
    const text = typeof value === 'string' ? value.trim() : undefined;
    const n = text === undefined ? value : text === '' ? 0 : /^\d+$/.test(text) ? Number(text) : NaN;
    if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0) throw new Error(`manage_leads list: ${name} must be a whole number of 1 or more.`);
    return n === 0 ? undefined : String(n);
  };
  const limit = wholeNumber(args.limit, 'limit');
  if (limit !== undefined) qp.limit = limit;
  const page = wholeNumber(args.page, 'page');
  if (page !== undefined) qp.page = page;
  // search and status are text; a number is turned into text (a zip code, a phone number). Anything else is refused: dropping it silently would return the
  // whole page and look like a match.
  const filterText = (value: unknown, name: string): string | undefined => {
    if (value === undefined || value === null) return undefined;
    const t = typeof value === 'number' && Number.isFinite(value) ? String(value) : value;
    if (typeof t !== 'string') throw new Error(`manage_leads list: ${name} must be text.`);
    return t.trim() || undefined;
  };
  const search = filterText(args.search, 'search');
  if (search) qp.search = search;
  const status = filterText(args.status, 'status');
  if (status) qp.status = status;
  if (args.engaged_only !== undefined && args.engaged_only !== null) {
    // true/false, or the text "true"/"false" in any case; an empty value means "not given".
    const flag = typeof args.engaged_only === 'string' ? args.engaged_only.trim().toLowerCase() : args.engaged_only;
    if (flag === true || flag === 'true') qp.engagedOnly = 'true';
    else if (flag === false || flag === 'false') qp.engagedOnly = 'false';
    else if (flag !== '') throw new Error('manage_leads list: engaged_only must be true or false.');
  }
  return qp;
}

const leadPath = (listId: string, leadId?: string) =>
  `/api/crm/lists/${encodeURIComponent(listId)}/leads${leadId ? `/${encodeURIComponent(leadId)}` : ''}`;

const actingUserOf = (c: any): string => c.userId || c.agentUserId;

/**
 * The lead as stored, read CONSISTENTLY. Used where a stale read would be wrong: the opt-out guards and the status decision (a suppression written moments
 * ago must be seen) and, only where the key-level custom-field write is not available (the route's `enforce` mode), the read-merge-write of the custom-field map
 * (a stale read deletes the keys another call just saved). By default a custom-fields-only update writes key by key and does not read the stored lead at all.
 * The REST read the caller is given also has some custom fields removed for viewers who may not see them (card-revenue data), so a merge must not start from THAT
 * copy. Access and existence have already been proved through the REST read; the stored copy is only used to decide and to merge, and is never returned. If it
 * cannot be read, nothing is changed: falling back to the REST copy would reintroduce exactly those losses.
 */
async function readStoredLead(listId: string, leadId: string, action: string): Promise<any> {
  let stored: any;
  try {
    const { crmDb } = await import('../../services/db');
    stored = await crmDb.getLeadById(listId, leadId, { consistentRead: true });
  } catch (err) {
    console.error(`[MCP] manage_leads ${action}: could not read the stored lead:`, (err as Error)?.message);
    throw new Error(`manage_leads ${action}: the lead could not be read, so nothing was changed. Nothing was saved; try again.`);
  }
  if (!stored) throw new Error(`manage_leads ${action}: the lead could not be found when it was read. Nothing was saved.`);
  return stored;
}

/**
 * `update`: Emma's semantics through the REST route. The lead is always read first, through the same route (so its access rules apply and a
 * missing lead is a 404: the REST update would otherwise create a one-field row for an id that does not exist).
 */
export async function executeLeadUpdate(args: any, c: any): Promise<any> {
  const listId = requireText(args.list_id, 'list_id', 'manage_leads update');
  requireText(args.lead_id, 'lead_id', 'manage_leads update');
  if (!isPlainObject(args.updates) || Object.keys(args.updates).length === 0) {
    throw new Error('manage_leads update: provide at least one field in updates.');
  }
  const { standard, custom, refused } = classifyLeadFields(args.updates);
  if (refused.length > 0) throw refusalError('update', refused);
  if (Object.keys(standard).length === 0 && Object.keys(custom).length === 0) {
    throw new Error('manage_leads update: nothing to update: give at least one field (an empty customFields object changes nothing).');
  }

  return withLeadLock(`${listId}/${args.lead_id}`, async () => {
  const existing = await mcpFetch({ method: 'GET', path: leadPath(listId, args.lead_id), context: c });
  const sameAddress = (a: unknown, b: unknown) => (typeof a === 'string' ? a.trim().toLowerCase() : '') === (typeof b === 'string' ? b.trim().toLowerCase() : '');
  // Custom fields are written KEY BY KEY (db.updateLead's customFieldsKeyMerge: `customFields.<key> = value`, no read, nothing to overwrite), so two updates to one
  // lead at the same moment cannot drop each other's keys (a read-merge-write of the whole map can, and silently). That needs the portal route not to drop the flag, which its write
  // guard does in `enforce` mode (this code runs in the same process as that route, so the mode is known); the update layer itself creates a missing map and retries.
  // In enforce mode the whole map is merged from a consistent read and written back: the same race, narrowed to one process by the per-lead lock around this update.
  const customPatch = Object.keys(custom).length > 0;
  const keyByKey = customPatch && leadPutGuardMode() !== 'enforce';
  // The status decision (suppress, or leave an existing opt-out alone) and the address guard also read the STORED lead, consistently: the REST copy can lag a write.
  const needsStored = standard.email !== undefined || typeof standard.status === 'string' || (customPatch && !keyByKey);
  const stored = needsStored ? await readStoredLead(listId, args.lead_id, 'update') : null;
  // The opt-out lives on the lead and is found by its address. Changing or clearing the address of an opted-out lead would let the old address be
  // added again as a sendable lead (the same reason it is not deleted here), so the address of a lead marked do-not-contact stays as it is. Writing the
  // same address is allowed and changes nothing.
  if (standard.email !== undefined && stored && isDoNotContact(stored) && !sameAddress(standard.email, stored.email)) {
    throw new Error('This lead is marked do-not-contact. Its email cannot be changed or cleared here: that would let the address be added again as a sendable lead. Change it in the app if that is really intended.');
  }
  const body: Record<string, unknown> = { ...standard };

  if (keyByKey) {
    body.customFields = custom;
    body.customFieldsKeyMerge = true;
  } else if (customPatch) {
    body.customFields = mergeCustomFields(stored?.customFields ?? {}, custom, {
      source: 'mcp.manageLeads.update', listId, leadId: args.lead_id,
    });
  }
  if (typeof standard.status === 'string') {
    // Loaded here, not at the top: emma/impl modules must not be pulled in when the MCP tool registry loads.
    const { suppressionContactStatusUpdates } = await import('../../emma/impl/leads');
    Object.assign(body, suppressionContactStatusUpdates(standard.status, stored ?? existing, actingUserOf(c)));
  }
  const data = await mcpFetch({ method: 'PUT', path: leadPath(listId, args.lead_id), context: c, body });
  // Changing a lead's address to one the owner already marked do-not-contact must not make it sendable (the same inheritance as an add). Only when the address
  // really changes, and never on a lead that is already opted out: the inheritance rewrites the contact status, its reason, note and actor, which would
  // overwrite the original compliance record of an opted-out lead.
  if (typeof standard.email === 'string' && standard.email.trim() && stored && !sameAddress(standard.email, stored.email) && !isDoNotContact(stored)) {
    const followups = await applyDoNotContactInheritance(listId, [{ leadId: args.lead_id, email: standard.email }], c);
    return jsonResult({
      ...data,
      ...(followups.inheritedDoNotContact.length > 0 ? { inheritedDoNotContact: true } : {}),
      ...(followups.doNotContactCheckFailed > 0 ? { doNotContactCheckFailed: followups.doNotContactCheckFailed, doNotContactUnchecked: followups.uncheckedLeadIds } : {}),
    });
  }
  return jsonResult(data);
  });
}

interface RowOutcome {
  index?: number;
  leadId?: string;
  email?: unknown;
  status: 'created' | 'duplicate' | 'deleted' | 'failed' | 'not_attempted';
  error?: string;
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err)).slice(0, 300);
/** The REST add route answers a same-email lead with 409; nothing else counts as a duplicate. */
const isDuplicate = (message: string): boolean => /^API error \(409\)/.test(message);

function rowList(value: unknown, what: string, action: string): unknown[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`manage_leads ${action}: ${what} must be a non-empty array.`);
  if (value.length > MAX_LEAD_ROWS_PER_CALL) {
    throw new Error(`manage_leads ${action}: at most ${MAX_LEAD_ROWS_PER_CALL} per call; received ${value.length}. Split the work into several calls.`);
  }
  return value;
}

interface Followups {
  inheritedDoNotContact: string[];
  doNotContactCheckFailed: number;
  /** When any check failed, which leads were not checked (all of them: the service counts failures, it does not say which). */
  uncheckedLeadIds: string[];
}

/**
 * What every bulk import does with the leads it just created (services/leadImportFollowups.ts: the portal's bulk import, the CSV import and
 * Emma's add_leads_to_list all call it): a new lead whose address the owner already marked do-not-contact is flagged too, so re-adding an opted-out
 * contact does not make them sendable again. The single-lead REST route does not do this, so it is applied here, to one lead or to many. The
 * route already validates each email in the background, so validation is left off. A check that fails is counted and reported, never read as
 * "not blocked".
 */
export async function applyDoNotContactInheritance(
  listId: string,
  created: Array<{ leadId: string; email?: string }>,
  c: any,
  actingUserId: string = actingUserOf(c),
): Promise<Followups> {
  const withLeadId = created.filter((l) => typeof l.leadId === 'string' && l.leadId);
  if (withLeadId.length === 0) return { inheritedDoNotContact: [], doNotContactCheckFailed: 0, uncheckedLeadIds: [] };
  try {
    const list = await mcpFetch({ method: 'GET', path: `/api/crm/lists/${encodeURIComponent(listId)}`, context: c });
    const { applyLeadImportFollowups } = await import('../../services/leadImportFollowups');
    const result = await applyLeadImportFollowups(listId, list?.userId ?? actingUserOf(c), withLeadId, { actingUserId, validate: false });
    return {
      inheritedDoNotContact: result.inheritedDoNotContact,
      doNotContactCheckFailed: result.doNotContactCheckFailed,
      uncheckedLeadIds: result.doNotContactCheckFailed > 0 ? withLeadId.map((l) => l.leadId) : [],
    };
  } catch (err) {
    console.error('[MCP] manage_leads add: do-not-contact check failed:', (err as Error)?.message);
    return { inheritedDoNotContact: [], doNotContactCheckFailed: withLeadId.length, uncheckedLeadIds: withLeadId.map((l) => l.leadId) };
  }
}

/**
 * `add` of one to MAX_LEAD_ROWS_PER_CALL leads into the caller's own list. One lead answers as before (the created lead, or the error).
 * Several are created one by one, each in its own try/catch, and the answer counts what really happened. Every row is checked before the
 * first is written, so a refused row stops the call with nothing created.
 */
export async function executeLeadAdd(args: any, c: any, opts: { budgetMs?: number } = {}): Promise<any> {
  const listId = requireText(args.list_id, 'list_id', 'manage_leads add');
  const rows = rowList(args.leads, 'leads', 'add');
  const bodies = rows.map((row, i) => {
    if (!isPlainObject(row)) throw new Error(`manage_leads add: row ${i} must be an object with fields (e.g. { email, firstName }).`);
    try {
      return buildLeadCreateBody(row);
    } catch (err) {
      throw new Error(rows.length > 1 ? `${(err as Error).message} (row ${i})` : (err as Error).message);
    }
  });
  if (bodies.length === 1) {
    const lead = await mcpFetch({ method: 'POST', path: leadPath(listId), context: c, body: bodies[0] });
    const followups = await applyDoNotContactInheritance(listId, [{ leadId: lead?.leadId, email: bodies[0].email as string | undefined }], c);
    return jsonResult({
      ...lead,
      ...(followups.inheritedDoNotContact.length > 0 ? { inheritedDoNotContact: true } : {}),
      ...(followups.doNotContactCheckFailed > 0 ? { doNotContactCheckFailed: followups.doNotContactCheckFailed, doNotContactUnchecked: followups.uncheckedLeadIds } : {}),
    });
  }
  const started = Date.now();
  const budgetMs = opts.budgetMs ?? ROW_WORK_BUDGET_MS;
  const results: RowOutcome[] = [];
  const created: Array<{ leadId: string; email?: string }> = [];
  // The route's own duplicate check reads an index that can lag a write by moments, so two rows with the same address in one call are told apart
  // here, by address, without asking it.
  const createdAddresses = new Set<string>();
  for (let index = 0; index < bodies.length; index++) {
    if (Date.now() - started > budgetMs) {
      results.push({ index, email: bodies[index].email, status: 'not_attempted' });
      continue;
    }
    const address = typeof bodies[index].email === 'string' ? (bodies[index].email as string).trim().toLowerCase() : '';
    if (address && createdAddresses.has(address)) {
      results.push({ index, email: bodies[index].email, status: 'duplicate', error: 'The same address as an earlier row in this call.' });
      continue;
    }
    try {
      const lead = await mcpFetch({ method: 'POST', path: leadPath(listId), context: c, body: bodies[index] });
      results.push({ index, leadId: lead?.leadId, email: bodies[index].email, status: 'created' });
      created.push({ leadId: lead?.leadId, email: bodies[index].email as string | undefined });
      if (address) createdAddresses.add(address);
    } catch (err) {
      const message = errorText(err);
      results.push({ index, email: bodies[index].email, status: isDuplicate(message) ? 'duplicate' : 'failed', error: message });
    }
  }
  const followups = await applyDoNotContactInheritance(listId, created, c);
  return summarise('add', results, 'created', {
    inheritedDoNotContact: followups.inheritedDoNotContact,
    doNotContactCheckFailed: followups.doNotContactCheckFailed,
    ...(followups.doNotContactCheckFailed > 0 ? { doNotContactUnchecked: followups.uncheckedLeadIds } : {}),
  });
}

/**
 * Deletes one lead the caller can see in this list. The REST route deletes by key without checking the lead exists, and then lowers the list's
 * lead count, so an id that is not in the list would be reported as deleted and still miscount the list: the lead is read first (through the
 * same route, so its access rules apply) and a missing one is a 404, not a success.
 */
async function deleteExistingLead(listId: string, leadId: string, c: any): Promise<any> {
  return withLeadLock(`${listId}/${leadId}`, () => deleteExistingLeadLocked(listId, leadId, c));
}

async function deleteExistingLeadLocked(listId: string, leadId: string, c: any): Promise<any> {
  await mcpFetch({ method: 'GET', path: leadPath(listId, leadId), context: c });
  const lead = await readStoredLead(listId, leadId, 'delete');
  // The opt-out lives on the lead. Deleting it would let the same address be added again as a sendable lead (an add inherits the flag only from
  // another lead that still exists), so a lead marked do-not-contact is not deleted through this tool.
  if (isDoNotContact(lead)) {
    throw new Error('This lead is marked do-not-contact (or unsubscribed). Deleting it would let the same address be added again as a sendable lead, so it is not deleted here; remove it in the app if that is really intended.');
  }
  return mcpFetch({ method: 'DELETE', path: leadPath(listId, leadId), context: c });
}

/** `delete` of one to MAX_LEAD_ROWS_PER_CALL leads in the caller's own list, counting what was really deleted. */
export async function executeLeadDelete(args: any, c: any, opts: { budgetMs?: number } = {}): Promise<any> {
  const listId = requireText(args.list_id, 'list_id', 'manage_leads delete');
  const ids = rowList(args.lead_ids, 'lead_ids', 'delete');
  if (ids.some((id) => typeof id !== 'string' || !id)) throw new Error('manage_leads delete: every lead_ids entry must be a lead id string.');
  // The same id twice is one lead: the second would otherwise be reported as a failure.
  const uniqueIds = [...new Set(ids as string[])];
  if (uniqueIds.length === 1) {
    const answer = await deleteExistingLead(listId, uniqueIds[0], c);
    const repeated = ids.length - uniqueIds.length;
    return jsonResult(repeated > 0 && answer && typeof answer === 'object' && !Array.isArray(answer) ? { ...answer, duplicateIdsIgnored: repeated } : answer);
  }
  const started = Date.now();
  const budgetMs = opts.budgetMs ?? ROW_WORK_BUDGET_MS;
  const results: RowOutcome[] = [];
  for (const leadId of uniqueIds) {
    if (Date.now() - started > budgetMs) {
      results.push({ leadId, status: 'not_attempted' });
      continue;
    }
    try {
      await deleteExistingLead(listId, leadId, c);
      results.push({ leadId, status: 'deleted' });
    } catch (err) {
      results.push({ leadId, status: 'failed', error: errorText(err) });
    }
  }
  return summarise('delete', results, 'deleted', uniqueIds.length !== ids.length ? { duplicateIdsIgnored: ids.length - uniqueIds.length } : {});
}

/** Most leads read to look for opted-out ones before a whole list is deleted. */
const MAX_LEADS_CHECKED_BEFORE_LIST_DELETE = 20_000;

/**
 * `create_lead_list` action delete. Deleting a list deletes every lead in it, including the ones marked do-not-contact, and an address is flagged
 * on a later add only from a lead that still exists: so a list that holds opted-out leads is not deleted through this tool (the lead delete refuses
 * the same way). Access is proved by the REST read; the leads are read in-process to look for opt-outs; if they cannot all be read, nothing is deleted.
 */
export async function executeLeadListDelete(args: any, c: any): Promise<any> {
  const listId = requireText(args.list_id, 'list_id', 'create_lead_list delete');
  return withLeadLock(`list:${listId}`, () => deleteListLocked(listId, c));
}

async function deleteListLocked(listId: string, c: any): Promise<any> {
  const listPath = `/api/crm/lists/${encodeURIComponent(listId)}`;
  await mcpFetch({ method: 'GET', path: listPath, context: c });
  let optedOut = 0;
  let scanned = 0;
  let more = false;
  try {
    const { crmDb } = await import('../../services/db');
    let lastKey: any;
    do {
      const page: any = await crmDb.getLeadsByListId(listId, 500, lastKey);
      for (const lead of page?.items ?? []) {
        scanned++;
        if (isDoNotContact(lead)) optedOut++;
      }
      lastKey = page?.lastEvaluatedKey;
      more = !!lastKey;
    } while (more && scanned < MAX_LEADS_CHECKED_BEFORE_LIST_DELETE);
  } catch (err) {
    console.error('[MCP] create_lead_list delete: could not read the list\'s leads:', (err as Error)?.message);
    throw new Error('create_lead_list delete: the leads of this list could not be read to look for opted-out ones, so nothing was deleted. Try again.');
  }
  if (optedOut > 0) {
    throw new Error(`create_lead_list delete: this list holds ${optedOut} lead(s) marked do-not-contact. Deleting the list would erase those opt-outs and let the addresses be added again as sendable leads, so it is not deleted here; delete it in the app if that is really intended.`);
  }
  if (more) {
    throw new Error(`create_lead_list delete: this list has more than ${MAX_LEADS_CHECKED_BEFORE_LIST_DELETE} leads, too many to check for opted-out ones first, so it is not deleted here; delete it in the app.`);
  }
  return jsonResult(await mcpFetch({ method: 'DELETE', path: listPath, context: c }));
}

function summarise(action: 'add' | 'delete', results: RowOutcome[], done: 'created' | 'deleted', extra: Record<string, unknown> = {}): any {
  const count = (status: RowOutcome['status']) => results.filter((r) => r.status === status).length;
  const doneCount = count(done);
  const duplicates = count('duplicate');
  const failed = count('failed');
  const notAttempted = count('not_attempted');
  const summary = {
    requested: results.length,
    [done]: doneCount,
    ...(action === 'add' ? { duplicates } : {}),
    failed,
    ...(notAttempted > 0
      ? { notAttempted, note: `The time budget for one call ran out: the ${notAttempted} rows marked not_attempted were not touched. Send only those again.` }
      : {}),
    ...extra,
    results,
  };
  // Every attempted row failed: the call failed, and says so (isError), rather than reporting an empty success. Rows that were all duplicates
  // (nothing to add) are a real answer, not a failure.
  if (doneCount === 0 && failed > 0) {
    throw new Error(`manage_leads ${action}: none of the attempted rows succeeded. ${JSON.stringify(summary)}`);
  }
  return jsonResult(summary);
}

/**
 * Lead-list fields `create_lead_list` action update forwards, by the name the caller uses -> the name the REST route reads. These are the eight
 * Emma's own update_lead_list exposes (the eighth, the auto-draft instruction, travels on its own route below). The route accepts more
 * (auto-send, alert copies to up to ten outside addresses, the list sender, the LinkedIn account, conversion mapping, display fields): none of
 * those is forwarded, so an outside agent cannot turn on sending or add recipients through a list update.
 */
const LIST_UPDATE_FIELDS: Record<string, string> = {
  name: 'name',
  description: 'description',
  icps_only: 'icpsOnly',
  engaged_only: 'engagedOnly',
  auto_draft_enabled: 'autoDraftEnabled',
  status_config: 'statusConfig',
  list_type: 'listType',
};

/** The auto-draft route's own limit; checked here too so a too-long instruction cannot fail AFTER the other fields were saved. */
const MAX_AUTO_DRAFT_INSTRUCTION_CHARS = 2000;

export async function executeLeadListUpdate(args: any, c: any): Promise<any> {
  const listId = args.list_id;
  if (typeof listId !== 'string' || !listId) throw new Error('create_lead_list update: list_id is required.');
  const body: Record<string, unknown> = {};
  for (const [name, restName] of Object.entries(LIST_UPDATE_FIELDS)) {
    if (args[name] !== undefined) body[restName] = args[name];
  }
  const instruction = args.auto_draft_instruction;
  if (instruction !== undefined && typeof instruction !== 'string') throw new Error('create_lead_list update: auto_draft_instruction must be a string.');
  if (typeof instruction === 'string' && instruction.trim().length > MAX_AUTO_DRAFT_INSTRUCTION_CHARS) {
    throw new Error(`create_lead_list update: auto_draft_instruction must be ${MAX_AUTO_DRAFT_INSTRUCTION_CHARS} characters or fewer. Nothing was changed.`);
  }
  if (Object.keys(body).length === 0 && instruction === undefined) {
    throw new Error('create_lead_list update: provide at least one field to update.');
  }
  if (Array.isArray(args.status_config)) {
    // Two stages with the same value would be indistinguishable on a lead (Emma's own status tool refuses this too).
    const seen = new Set<string>();
    const duplicates: string[] = [];
    for (const entry of args.status_config) {
      const value = typeof entry?.value === 'string' ? entry.value.trim().toLowerCase() : '';
      if (value && seen.has(value)) duplicates.push(value);
      if (value) seen.add(value);
    }
    if (duplicates.length > 0) throw new Error(`create_lead_list update: status_config has duplicate status values: ${[...new Set(duplicates)].join(', ')}. Nothing was changed.`);
  }

  // The instruction is saved by the auto-draft route, which needs the on/off switch with it: the one given, else the list's current one.
  let enabled: unknown;
  if (instruction !== undefined) {
    enabled = args.auto_draft_enabled;
    if (enabled === undefined) {
      const list = await mcpFetch({ method: 'GET', path: `/api/crm/lists/${encodeURIComponent(listId)}`, context: c });
      enabled = list?.autoDraftEnabled === true;
    }
    if (typeof enabled !== 'boolean') throw new Error('create_lead_list update: auto_draft_enabled must be true or false.');
    delete body.autoDraftEnabled;
  }

  const listPath = `/api/crm/lists/${encodeURIComponent(listId)}`;
  const updated = Object.keys(body).length > 0 ? await mcpFetch({ method: 'PUT', path: listPath, context: c, body }) : null;
  if (instruction === undefined) return jsonResult(updated);
  let draft: any;
  try {
    draft = await mcpFetch({ method: 'PUT', path: `${listPath}/auto-draft`, context: c, body: { enabled, instruction } });
  } catch (err) {
    if (!updated) throw err;
    throw new Error(`create_lead_list update: the other fields were saved, but the auto-draft instruction was not: ${errorText(err)}`);
  }
  return jsonResult(updated ? { ...updated, autoDraftEnabled: draft?.autoDraftEnabled, autoDraftInstruction: draft?.autoDraftInstruction } : draft);
}
