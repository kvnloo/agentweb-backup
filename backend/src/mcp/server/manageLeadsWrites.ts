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
 * Fields forwarded as-is. Emma's eleven, plus the four the REST routes validate themselves (lifecycle stage, the review drafts that the
 * "review" status requires, and the sender, which must be one the account configured).
 */
export const MCP_LEAD_STANDARD_FIELDS: ReadonlySet<string> = new Set([
  'email', 'firstName', 'lastName', 'phone', 'company', 'title', 'notes', 'linkedin', 'status', 'dealValue', 'dealCurrency',
  'lifecycle', 'emailDraft', 'messageDraft', 'selectedSenderId',
]);

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

export function classifyLeadFields(input: unknown): ClassifiedLeadFields {
  const out: ClassifiedLeadFields = { standard: {}, custom: {}, refused: [] };
  if (!isPlainObject(input)) return out;
  for (const [key, value] of Object.entries(input)) {
    if (REFUSED_LEAD_KEYS.has(key) || UNSAFE_FIELD_NAMES.has(key)) {
      out.refused.push(key);
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
  return new Error(
    `manage_leads ${action}: these fields cannot be set through this tool: ${refused.join(', ')}. ` +
    'A lead is suppressed by setting status to "do-not-contact" (it cannot be reversed here); who owns a lead, its sync and attribution data, ' +
    'and its contact status are set by the system.'
  );
}

/** The body for one lead being created: standard fields plus a customFields object when there are any. Throws, naming the keys, when any is refused. */
export function buildLeadCreateBody(lead: unknown): Record<string, unknown> {
  const { standard, custom, refused } = classifyLeadFields(lead);
  if (refused.length > 0) throw refusalError('add', refused);
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

/** `update`: Emma's semantics through the REST route. Reads the lead first (through the same route, so its access rules apply) to merge custom fields. */
export async function executeLeadUpdate(args: any, c: any): Promise<any> {
  const listId = args.list_id;
  if (typeof args.lead_id !== 'string' || !args.lead_id) throw new Error('manage_leads update: lead_id is required.');
  if (!isPlainObject(args.updates) || Object.keys(args.updates).length === 0) {
    throw new Error('manage_leads update: provide at least one field in updates.');
  }
  const { standard, custom, refused } = classifyLeadFields(args.updates);
  if (refused.length > 0) throw refusalError('update', refused);

  const body: Record<string, unknown> = { ...standard };
  const needsExisting = Object.keys(custom).length > 0 || typeof standard.status === 'string';
  const existing = needsExisting ? await mcpFetch({ method: 'GET', path: leadPath(listId, args.lead_id), context: c }) : null;

  if (Object.keys(custom).length > 0) {
    body.customFields = mergeCustomFields(existing?.customFields, custom, { source: 'mcp.manageLeads.update', listId, leadId: args.lead_id });
  }
  if (typeof standard.status === 'string') {
    // Loaded here, not at the top: emma/impl modules must not be pulled in when the MCP tool registry loads.
    const { suppressionContactStatusUpdates } = await import('../../emma/impl/leads');
    Object.assign(body, suppressionContactStatusUpdates(standard.status, existing, c.userId || c.agentUserId));
  }
  const data = await mcpFetch({ method: 'PUT', path: leadPath(listId, args.lead_id), context: c, body });
  return jsonResult(data);
}

interface RowOutcome {
  index?: number;
  leadId?: string;
  email?: unknown;
  status: 'created' | 'duplicate' | 'deleted' | 'failed';
  error?: string;
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err)).slice(0, 300);
const isDuplicate = (message: string): boolean => /\(409\)|already exists|duplicate/i.test(message);

function rowList(value: unknown, what: string, action: string): unknown[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`manage_leads ${action}: ${what} must be a non-empty array.`);
  if (value.length > MAX_LEAD_ROWS_PER_CALL) {
    throw new Error(`manage_leads ${action}: at most ${MAX_LEAD_ROWS_PER_CALL} per call; received ${value.length}. Split the work into several calls.`);
  }
  return value;
}

/**
 * `add` of one to MAX_LEAD_ROWS_PER_CALL leads into the caller's own list. One lead answers exactly as before (the created lead, or the error).
 * Several are created one by one, each in its own try/catch, and the answer counts what really happened.
 */
export async function executeLeadAdd(args: any, c: any): Promise<any> {
  const listId = args.list_id;
  const rows = rowList(args.leads, 'leads', 'add');
  const bodies = rows.map((row, i) => {
    if (!isPlainObject(row)) throw new Error(`manage_leads add: row ${i} must be an object with fields (e.g. { email, firstName }).`);
    return buildLeadCreateBody(row);
  });
  if (bodies.length === 1) {
    return jsonResult(await mcpFetch({ method: 'POST', path: leadPath(listId), context: c, body: bodies[0] }));
  }
  const results: RowOutcome[] = [];
  for (let index = 0; index < bodies.length; index++) {
    try {
      const created = await mcpFetch({ method: 'POST', path: leadPath(listId), context: c, body: bodies[index] });
      results.push({ index, leadId: created?.leadId, email: bodies[index].email, status: 'created' });
    } catch (err) {
      const message = errorText(err);
      results.push({ index, email: bodies[index].email, status: isDuplicate(message) ? 'duplicate' : 'failed', error: message });
    }
  }
  return summarise('add', results, 'created');
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
export async function executeLeadDelete(args: any, c: any): Promise<any> {
  const listId = args.list_id;
  const ids = rowList(args.lead_ids, 'lead_ids', 'delete');
  if (ids.some((id) => typeof id !== 'string' || !id)) throw new Error('manage_leads delete: every lead_ids entry must be a lead id string.');
  if (ids.length === 1) return jsonResult(await deleteExistingLead(listId, ids[0] as string, c));
  const results: RowOutcome[] = [];
  for (const leadId of ids as string[]) {
    try {
      await deleteExistingLead(listId, leadId, c);
      results.push({ leadId, status: 'deleted' });
    } catch (err) {
      results.push({ leadId, status: 'failed', error: errorText(err) });
    }
  }
  return summarise('delete', results, 'deleted');
}

function summarise(action: 'add' | 'delete', results: RowOutcome[], done: 'created' | 'deleted'): any {
  const count = (status: RowOutcome['status']) => results.filter((r) => r.status === status).length;
  const doneCount = count(done);
  const duplicates = count('duplicate');
  const summary = {
    requested: results.length,
    [done]: doneCount,
    ...(action === 'add' ? { duplicates } : {}),
    failed: count('failed'),
    results,
  };
  // Nothing happened at all: the call failed, and says so (isError), rather than reporting an empty success. Rows that all turned out to
  // be duplicates are a real answer (nothing to add), not a failure.
  if (doneCount === 0 && duplicates === 0) {
    throw new Error(`manage_leads ${action}: none of the ${results.length} rows succeeded. ${JSON.stringify(summary)}`);
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

export async function executeLeadListUpdate(args: any, c: any): Promise<any> {
  const listId = args.list_id;
  if (typeof listId !== 'string' || !listId) throw new Error('create_lead_list update: list_id is required.');
  const body: Record<string, unknown> = {};
  for (const [name, restName] of Object.entries(LIST_UPDATE_FIELDS)) {
    if (args[name] !== undefined) body[restName] = args[name];
  }
  const instruction = args.auto_draft_instruction;
  if (instruction !== undefined && typeof instruction !== 'string') throw new Error('create_lead_list update: auto_draft_instruction must be a string.');
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
  const draft = await mcpFetch({ method: 'PUT', path: `${listPath}/auto-draft`, context: c, body: { enabled, instruction } });
  return jsonResult(updated ? { ...updated, autoDraftEnabled: draft?.autoDraftEnabled, autoDraftInstruction: draft?.autoDraftInstruction } : draft);
}
