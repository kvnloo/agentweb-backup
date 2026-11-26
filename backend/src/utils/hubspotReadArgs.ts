/**
 * ENG-2840 (W2-9): the read-only subset of Emma's `call_hubspot_api` that outside agents may call, and the check of its arguments.
 *
 * One check, used twice: by the MCP tool `call_hubspot_api` (mcp/server/hubspotReadTool.ts) before anything is called, and again by the
 * route it self-calls (`POST /api/emma/hubspot-read`, routes/emmaHubspotReadRoutes.ts), which any portal token can reach directly. The
 * route hands Emma's handler (`handleHubspotApi`) ONLY the object this returns, never the request body.
 *
 * Why every value is checked (research `eng-2840-w29-research-2026-11-26.md` section 1): the handler is a fixed (entity_type, action)
 * matrix, but HubSpotService interpolates ids RAW into HubSpot URL paths (`/marketing/v3/emails/${emailId}`, `/crm/lists/2026-03/${listId}`,
 * `/automation/v3/performance/workflow/${workflowId}?start=${start}&end=${end}&bucket=${bucket}` ...) and the CONTACTS LIST cursor raw into a
 * query string (`&after=${cursor}`). A value such as `../../<other endpoint>` or `1?x=` would reach HubSpot endpoints outside the matrix with
 * the portal's token. So: ids are 1 to 64 letters, digits, `_` or `-`; the cursor is a short token without `&`, `?`, `#`, `/` or spaces;
 * enums are exact; dates are checked and sent on as epoch milliseconds (or YYYY-MM-DD where HubSpot wants a day).
 *
 * The allow-list is explicit pairs, not a prefix rule, and only upper case is accepted: no lower-case enums, no aliases (`id`, `listId`,
 * `dealstage`) and no raw-REST shape (`endpoint` + `method`), which Emma's normaliser would otherwise map onto actions.
 */

export class HubspotReadArgsError extends Error {}

function refuse(message: string): never {
  throw new HubspotReadArgsError(message);
}

export const HUBSPOT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** A HubSpot paging token (`paging.next.after`): numbers, or base64 written URL-encoded. No `&`, `?`, `#`, `/`, `+`, `.` or spaces. */
export const HUBSPOT_CURSOR_RE = /^[A-Za-z0-9_=%-]{1,200}$/;
export const HUBSPOT_PROPERTY_RE = /^[a-z0-9_]{1,100}$/;
export const HUBSPOT_MAX_PROPERTIES = 20;
export const HUBSPOT_MAX_EMAIL_IDS = 20;
export const HUBSPOT_LIMIT_MAX = 100;
/** CONTACTS / DEALS SEARCH page size when none is given (Emma's handler would ask HubSpot for 100). */
export const HUBSPOT_DEFAULT_SEARCH_LIMIT = 25;
export const HUBSPOT_COUNT_MAX = 100;
/** DEALS GET_CONTACTS reads at most this many of the deal's contacts (one HubSpot batch read). */
export const HUBSPOT_DEAL_CONTACTS_MAX = 100;
/** 2001-09-09: the first 13-digit epoch millisecond. Emma's handler reads a 9 to 12 digit number as epoch SECONDS, so nothing shorter is sent. */
export const HUBSPOT_MIN_EPOCH_MS = 1_000_000_000_000;
/** 2100-01-01. */
export const HUBSPOT_MAX_EPOCH_MS = 4_102_444_800_000;
const MAX_LABEL_CHARS = 100;
const MAX_QUERY_CHARS = 200;

/** The same list as HubSpotService.CAMPAIGN_ASSET_TYPES (not imported: that module pulls in the database layer). The value goes into a URL path. */
export const HUBSPOT_CAMPAIGN_ASSET_TYPES = [
  'MARKETING_EMAIL', 'LANDING_PAGE', 'BLOG_POST', 'FORM', 'WEB_INTERACTIVE', 'CTA', 'SOCIAL_BROADCAST', 'WORKFLOW',
] as const;
export const HUBSPOT_WORKFLOW_BUCKETS = ['DAY', 'WEEK', 'MONTH'] as const;

interface PairSpec {
  /** Inputs this pair reads (besides entity_type, action and account_id). Any other input is refused. */
  params: readonly string[];
  required?: readonly string[];
}

/** Every (entity_type, action) the outside tool may call. Each is a pure read in Emma's handler and HubSpotService (GET, or a POST search). */
export const HUBSPOT_READ_PAIRS: Readonly<Record<string, Readonly<Record<string, PairSpec>>>> = {
  CONTACTS: {
    LIST: { params: ['cursor'] },
    SEARCH: { params: ['created_after', 'created_before', 'properties', 'limit', 'cursor'] },
  },
  DEALS: {
    LIST_PIPELINES: { params: [] },
    SEARCH: { params: ['created_after', 'created_before', 'pipeline', 'deal_stage', 'properties', 'limit', 'cursor'] },
    GET_CONTACTS: { params: ['deal_id', 'properties'], required: ['deal_id'] },
  },
  CONTACT_LIST: {
    LIST: { params: ['query', 'cursor', 'count'] },
    GET: { params: ['list_id'], required: ['list_id'] },
  },
  CAMPAIGN: {
    LIST: { params: ['cursor'] },
    GET: { params: ['guid'], required: ['guid'] },
    GET_METRICS: { params: ['guid'], required: ['guid'] },
    LIST_ASSETS: { params: ['guid', 'asset_type', 'start_date', 'end_date', 'cursor'], required: ['guid'] },
  },
  EMAIL: {
    LIST: { params: ['cursor'] },
    GET: { params: ['email_id'], required: ['email_id'] },
    GET_STATS: { params: ['email_ids', 'start_timestamp', 'end_timestamp'], required: ['email_ids'] },
    LIST_SUBSCRIPTION_TYPES: { params: [] },
  },
  FORM: {
    LIST: { params: ['cursor'] },
    GET: { params: ['form_id'], required: ['form_id'] },
    GET_FORM_FIELDS: { params: ['form_id'], required: ['form_id'] },
    GET_SUBMISSIONS: { params: ['form_id', 'cursor'], required: ['form_id'] },
  },
  LANDING_PAGE: {
    LIST: { params: ['cursor'] },
    GET: { params: ['page_id'], required: ['page_id'] },
  },
  BLOG_POST: {
    LIST: { params: ['cursor'] },
    GET: { params: ['post_id'], required: ['post_id'] },
  },
  WORKFLOW: {
    LIST: { params: [] },
    GET: { params: ['workflow_id'], required: ['workflow_id'] },
    GET_PERFORMANCE: { params: ['workflow_id', 'start', 'end', 'bucket'], required: ['workflow_id', 'start', 'end', 'bucket'] },
  },
  SOCIAL: {
    LIST_CHANNELS: { params: [] },
    LIST_BROADCASTS: { params: [] },
  },
};

const ENTITIES = Object.keys(HUBSPOT_READ_PAIRS);
const PAIR_PARAMS = [...new Set(Object.values(HUBSPOT_READ_PAIRS).flatMap((actions) => Object.values(actions).flatMap((s) => s.params)))];

/** Every input name the tool accepts. */
export const HUBSPOT_READ_INPUTS: readonly string[] = ['entity_type', 'action', 'account_id', ...PAIR_PARAMS];

/** The allowed pairs as text, e.g. "CONTACTS: LIST, SEARCH; DEALS: ...". */
export function describeHubspotReadPairs(): string {
  return ENTITIES.map((e) => `${e}: ${Object.keys(HUBSPOT_READ_PAIRS[e]).join(', ')}`).join('; ');
}

function own(record: Readonly<Record<string, unknown>>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/;
const INVISIBLE_RE = /[\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\u2028\u2029\ufeff]/;

/** An id: text of 1 to 64 letters, digits, `_` or `-` (a positive whole number is taken as its digits). */
function idArg(field: string, value: unknown): string {
  const text = typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value) : value;
  if (typeof text !== 'string' || !HUBSPOT_ID_RE.test(text)) refuse(`${field} must be an id of 1 to 64 letters, digits, _ or - (as HubSpot returned it).`);
  return text as string;
}

function cursorArg(field: string, value: unknown): string {
  if (typeof value !== 'string' || !HUBSPOT_CURSOR_RE.test(value)) {
    refuse(`${field} must be the paging token HubSpot returned (at most 200 letters, digits, _, -, = or %).`);
  }
  return value as string;
}

function wholeArg(field: string, value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) refuse(`${field} must be a whole number from ${min} to ${max}.`);
  return value as number;
}

/** One line of text, not padded, no control or invisible characters. */
function lineArg(field: string, value: unknown, max: number): string {
  if (typeof value !== 'string' || value.trim() === '') refuse(`${field} must be text.`);
  const text = value as string;
  if (text.length > max) refuse(`${field} is ${text.length} characters; at most ${max}.`);
  if (text !== text.trim() || CONTROL_RE.test(text) || INVISIBLE_RE.test(text)) refuse(`${field} holds spaces at the ends or control or invisible characters.`);
  return text;
}

function enumArg<T extends string>(field: string, value: unknown, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) refuse(`${field} must be one of ${allowed.join(', ')}.`);
  return value as T;
}

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})?)?$/;

function realDay(y: number, m: number, d: number): boolean {
  const back = new Date(Date.UTC(y, m - 1, d));
  return back.getUTCFullYear() === y && back.getUTCMonth() === m - 1 && back.getUTCDate() === d;
}

/** A moment: epoch milliseconds (a whole number, or its 13 digits as text) or an ISO 8601 date or date-time. Answers epoch milliseconds. */
function momentArg(field: string, value: unknown): number {
  const what = `${field} must be epoch milliseconds (13 digits) or an ISO 8601 date or date-time (2026-11-01 or 2026-11-01T09:00:00Z), between 2001-09-09 and 2100.`;
  let ms: number;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) refuse(what);
    ms = value;
  } else if (typeof value === 'string' && /^\d{13}$/.test(value)) {
    ms = Number(value);
  } else if (typeof value === 'string') {
    const m = ISO_RE.exec(value);
    if (!m || !realDay(Number(m[1]), Number(m[2]), Number(m[3]))) refuse(what);
    if (m![4] !== undefined && (Number(m![4]) > 23 || Number(m![5]) > 59 || (m![6] !== undefined && Number(m![6]) > 59))) refuse(what);
    ms = Date.parse(value);
  } else {
    refuse(what);
  }
  if (!Number.isFinite(ms!) || ms! < HUBSPOT_MIN_EPOCH_MS || ms! > HUBSPOT_MAX_EPOCH_MS) refuse(what);
  return ms!;
}

/** A day written YYYY-MM-DD. */
function dayArg(field: string, value: unknown): string {
  const m = typeof value === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value) : null;
  if (!m || !realDay(Number(m[1]), Number(m[2]), Number(m[3])) || Number(m[1]) < 2000 || Number(m[1]) > 2100) refuse(`${field} must be a real day written YYYY-MM-DD.`);
  return value as string;
}

function propertiesArg(field: string, value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > HUBSPOT_MAX_PROPERTIES) {
    refuse(`${field} must be a list of 1 to ${HUBSPOT_MAX_PROPERTIES} HubSpot property names.`);
  }
  for (const name of value as unknown[]) {
    if (typeof name !== 'string' || !HUBSPOT_PROPERTY_RE.test(name)) refuse(`${field} holds a value that is not a HubSpot property name (1 to 100 lower-case letters, digits or _).`);
  }
  return [...new Set(value as string[])];
}

function emailIdsArg(field: string, value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > HUBSPOT_MAX_EMAIL_IDS) refuse(`${field} must be a list of 1 to ${HUBSPOT_MAX_EMAIL_IDS} email ids.`);
  const ids = (value as unknown[]).map((v) => idArg(field, v));
  if (new Set(ids).size !== ids.length) refuse(`${field} has the same id twice.`);
  return ids;
}

/** CONTACT_LIST LIST `query`: a name to search for. An id-shaped query ("list_id=12") is refused: Emma's normaliser would turn it into a GET. */
function listQueryArg(field: string, value: unknown): string {
  const text = lineArg(field, value, MAX_QUERY_CHARS);
  if (/^(?:list_?id|id|guid)\s*[=:]/i.test(text)) refuse(`${field} is a list name to search for; to read one list use action GET with list_id.`);
  return text;
}

/** How each input is checked; what it answers is what Emma's handler is given. */
const CHECKS: Record<string, (field: string, value: unknown) => unknown> = {
  cursor: cursorArg,
  created_after: (f, v) => String(momentArg(f, v)),
  created_before: (f, v) => String(momentArg(f, v)),
  properties: propertiesArg,
  limit: (f, v) => wholeArg(f, v, 1, HUBSPOT_LIMIT_MAX),
  pipeline: idArg,
  deal_stage: (f, v) => lineArg(f, v, MAX_LABEL_CHARS),
  deal_id: idArg,
  query: listQueryArg,
  count: (f, v) => wholeArg(f, v, 1, HUBSPOT_COUNT_MAX),
  list_id: idArg,
  guid: idArg,
  asset_type: (f, v) => enumArg(f, v, HUBSPOT_CAMPAIGN_ASSET_TYPES),
  start_date: dayArg,
  end_date: dayArg,
  email_id: idArg,
  email_ids: emailIdsArg,
  start_timestamp: (f, v) => String(momentArg(f, v)),
  end_timestamp: (f, v) => String(momentArg(f, v)),
  form_id: idArg,
  page_id: idArg,
  post_id: idArg,
  workflow_id: idArg,
  start: momentArg,
  end: momentArg,
  bucket: (f, v) => enumArg(f, v, HUBSPOT_WORKFLOW_BUCKETS),
};

export interface HubspotReadArgs {
  entity_type: string;
  action: string;
  account_id?: string;
  [param: string]: unknown;
}

const present = (v: unknown) => v !== undefined && v !== null;

/**
 * The arguments to hand Emma's handler, built fresh from checked values only, or a HubspotReadArgsError with a short message (the input is
 * never echoed beyond 40 characters of a name). `null` counts as absent.
 */
export function validateHubspotReadArgs(raw: unknown): HubspotReadArgs {
  if (raw === undefined || raw === null || typeof raw !== 'object' || Array.isArray(raw)) refuse('the arguments must be an object with entity_type and action.');
  const args = raw as Record<string, unknown>;
  const unknown = Object.keys(args).filter((k) => !HUBSPOT_READ_INPUTS.includes(k));
  if (unknown.length > 0) {
    const names = unknown.map((k) => `"${k.slice(0, 40)}"`).join(', ');
    refuse(`${names} ${unknown.length > 1 ? 'are not inputs' : 'is not an input'} of this read-only HubSpot tool (no aliases, no endpoint or method).`);
  }

  const entity = args.entity_type;
  if (typeof entity !== 'string' || !own(HUBSPOT_READ_PAIRS, entity)) refuse(`entity_type must be one of ${ENTITIES.join(', ')} (upper case).`);
  const actions = HUBSPOT_READ_PAIRS[entity as string];
  const action = args.action;
  if (typeof action !== 'string' || !own(actions, action)) {
    const shown = typeof action === 'string' && /^[A-Za-z_]{1,40}$/.test(action) ? `${entity} ${action} is not available here: this tool only reads. ` : 'action is not one this tool allows. ';
    refuse(`${shown}Allowed actions for ${entity} (upper case): ${Object.keys(actions).join(', ')}.`);
  }
  const spec = actions[action as string];

  const out: HubspotReadArgs = { entity_type: entity as string, action: action as string };
  if (present(args.account_id)) out.account_id = idArg('account_id', args.account_id);

  for (const name of PAIR_PARAMS) {
    if (!present(args[name])) continue;
    if (!spec.params.includes(name)) refuse(`${name} is not used by ${entity} ${action}. Its inputs are: ${spec.params.length ? spec.params.join(', ') : 'none'} (and account_id).`);
    out[name] = CHECKS[name](name, args[name]);
  }
  for (const name of spec.required ?? []) {
    if (!present(out[name])) refuse(`${name} is required for ${entity} ${action}.`);
  }

  if (out.created_after !== undefined && out.created_before !== undefined && Number(out.created_after) >= Number(out.created_before)) {
    refuse('created_after must be before created_before.');
  }
  if (out.start_timestamp !== undefined && out.end_timestamp !== undefined && Number(out.start_timestamp) > Number(out.end_timestamp)) {
    refuse('start_timestamp must not be after end_timestamp.');
  }
  if (out.start_date !== undefined && out.end_date !== undefined && (out.start_date as string) > (out.end_date as string)) {
    refuse('start_date must not be after end_date.');
  }
  if (out.start !== undefined && out.end !== undefined && (out.start as number) >= (out.end as number)) refuse('start must be before end.');
  if ((entity === 'CONTACTS' || entity === 'DEALS') && action === 'SEARCH' && out.limit === undefined) out.limit = HUBSPOT_DEFAULT_SEARCH_LIMIT;
  return out;
}
