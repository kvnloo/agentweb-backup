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
import { SERVER_OWNED_LEAD_KEYS } from '../../utils/leadWriteGuard';

/** Most rows one add or delete call handles (the same cap Emma's bulk tools use). */
export const MAX_LEAD_ROWS_PER_CALL = 100;

/**
 * How long one add or delete call keeps working through its rows. Each row is one or two self-calls with their own side effects, and the
 * caller's connection has its own timeout; past the budget the remaining rows are NOT attempted and are reported as such, so the caller
 * knows exactly which to send again instead of retrying rows that already went through.
 */
export const ROW_WORK_BUDGET_MS = 90_000;

/**
 * Fields forwarded as-is. Emma's eleven, plus those the REST routes validate themselves (lifecycle stage, the sender, which must be one the
 * account configured) and two plain profile fields; the review drafts and their format are accepted on update only (see DRAFT_FIELDS).
 */
export const MCP_LEAD_STANDARD_FIELDS: ReadonlySet<string> = new Set([
  'email', 'firstName', 'lastName', 'phone', 'company', 'title', 'notes', 'linkedin', 'status', 'dealValue', 'dealCurrency',
  'lifecycle', 'selectedSenderId', 'website', 'companyLinkedin',
]);

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

const REFUSED_LEAD_KEYS: ReadonlySet<string> = new Set([...SERVER_OWNED_LEAD_KEYS, ...CONTACT_STATUS_KEYS, ...IDENTITY_KEYS]);

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
      if (opts.forAdd) out.refused.push(key);
      else out.standard[key] = value;
    } else if (MCP_LEAD_STANDARD_FIELDS.has(key)) {
      out.standard[key] = value;
    } else if (key === 'customFields') {
      if (!isPlainObject(value)) {
        out.refused.push('customFields (must be an object)');
        continue;
      }
      for (const [customKey, customValue] of Object.entries(value)) {
        if (UNSAFE_FIELD_NAMES.has(customKey)) out.refused.push(`customFields.${customKey}`);
        else out.custom[customKey] = customValue;
      }
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
  return new Error(
    `manage_leads ${action}: these fields cannot be set through this tool: ${refused.join(', ')}. ` +
    'A lead is suppressed by setting status to "do-not-contact" (it cannot be reversed here); who owns a lead, its sync data and its contact status ' +
    'are set by the system. To store your own data under one of these names, put it inside customFields.' +
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
  if (args.limit !== undefined && args.limit !== null) qp.limit = String(args.limit);
  if (args.page !== undefined && args.page !== null) qp.page = String(args.page);
  if (typeof args.search === 'string' && args.search.trim()) qp.search = args.search.trim();
  if (typeof args.status === 'string' && args.status.trim()) qp.status = args.status.trim();
  if (args.engaged_only !== undefined && args.engaged_only !== null) {
    if (typeof args.engaged_only !== 'boolean') throw new Error('manage_leads list: engaged_only must be true or false.');
    qp.engagedOnly = String(args.engaged_only);
  }
  return qp;
}

const leadPath = (listId: string, leadId?: string) =>
  `/api/crm/lists/${encodeURIComponent(listId)}/leads${leadId ? `/${encodeURIComponent(leadId)}` : ''}`;

const actingUserOf = (c: any): string => c.userId || c.agentUserId;

/**
 * The lead's custom fields as stored, for the merge. The REST read the caller is given has some custom fields removed for viewers who may not
 * see them (card-revenue data), and writing a merged map built from THAT would delete them from the lead for good. Access and existence have
 * already been proved through the REST read; the stored copy only builds the merge and is never returned. If it cannot be read, nothing is
 * written: falling back to the REST copy would reintroduce exactly that loss.
 */
async function storedCustomFields(listId: string, leadId: string): Promise<unknown> {
  let stored: any;
  try {
    const { crmDb } = await import('../../services/db');
    stored = await crmDb.getLeadById(listId, leadId);
  } catch (err) {
    console.error('[MCP] manage_leads update: could not read the stored lead:', (err as Error)?.message);
    throw new Error('manage_leads update: the lead could not be read, so its custom fields were not changed. Nothing was saved; try again.');
  }
  if (!stored) throw new Error('manage_leads update: the lead could not be found when its custom fields were read. Nothing was saved.');
  return stored.customFields;
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

  const existing = await mcpFetch({ method: 'GET', path: leadPath(listId, args.lead_id), context: c });
  const body: Record<string, unknown> = { ...standard };

  if (Object.keys(custom).length > 0) {
    body.customFields = mergeCustomFields(await storedCustomFields(listId, args.lead_id), custom, {
      source: 'mcp.manageLeads.update', listId, leadId: args.lead_id,
    });
  }
  if (typeof standard.status === 'string') {
    // Loaded here, not at the top: emma/impl modules must not be pulled in when the MCP tool registry loads.
    const { suppressionContactStatusUpdates } = await import('../../emma/impl/leads');
    Object.assign(body, suppressionContactStatusUpdates(standard.status, existing, actingUserOf(c)));
  }
  const data = await mcpFetch({ method: 'PUT', path: leadPath(listId, args.lead_id), context: c, body });
  return jsonResult(data);
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
  if (withLeadId.length === 0) return { inheritedDoNotContact: [], doNotContactCheckFailed: 0 };
  try {
    const list = await mcpFetch({ method: 'GET', path: `/api/crm/lists/${encodeURIComponent(listId)}`, context: c });
    const { applyLeadImportFollowups } = await import('../../services/leadImportFollowups');
    const result = await applyLeadImportFollowups(listId, list?.userId ?? actingUserOf(c), withLeadId, { actingUserId, validate: false });
    return { inheritedDoNotContact: result.inheritedDoNotContact, doNotContactCheckFailed: result.doNotContactCheckFailed };
  } catch (err) {
    console.error('[MCP] manage_leads add: do-not-contact check failed:', (err as Error)?.message);
    return { inheritedDoNotContact: [], doNotContactCheckFailed: withLeadId.length };
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
    return buildLeadCreateBody(row);
  });
  if (bodies.length === 1) {
    const lead = await mcpFetch({ method: 'POST', path: leadPath(listId), context: c, body: bodies[0] });
    const followups = await applyDoNotContactInheritance(listId, [{ leadId: lead?.leadId, email: bodies[0].email as string | undefined }], c);
    return jsonResult({
      ...lead,
      ...(followups.inheritedDoNotContact.length > 0 ? { inheritedDoNotContact: true } : {}),
      ...(followups.doNotContactCheckFailed > 0 ? { doNotContactCheckFailed: followups.doNotContactCheckFailed } : {}),
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
  });
}

/**
 * Deletes one lead the caller can see in this list. The REST route deletes by key without checking the lead exists, and then lowers the list's
 * lead count, so an id that is not in the list would be reported as deleted and still miscount the list: the lead is read first (through the
 * same route, so its access rules apply) and a missing one is a 404, not a success.
 */
async function deleteExistingLead(listId: string, leadId: string, c: any): Promise<any> {
  await mcpFetch({ method: 'GET', path: leadPath(listId, leadId), context: c });
  return mcpFetch({ method: 'DELETE', path: leadPath(listId, leadId), context: c });
}

/** `delete` of one to MAX_LEAD_ROWS_PER_CALL leads in the caller's own list, counting what was really deleted. */
export async function executeLeadDelete(args: any, c: any, opts: { budgetMs?: number } = {}): Promise<any> {
  const listId = requireText(args.list_id, 'list_id', 'manage_leads delete');
  const ids = rowList(args.lead_ids, 'lead_ids', 'delete');
  if (ids.some((id) => typeof id !== 'string' || !id)) throw new Error('manage_leads delete: every lead_ids entry must be a lead id string.');
  if (ids.length === 1) return jsonResult(await deleteExistingLead(listId, ids[0] as string, c));
  const started = Date.now();
  const budgetMs = opts.budgetMs ?? ROW_WORK_BUDGET_MS;
  const results: RowOutcome[] = [];
  for (const leadId of ids as string[]) {
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
  return summarise('delete', results, 'deleted');
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
