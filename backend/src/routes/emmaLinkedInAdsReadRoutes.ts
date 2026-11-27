/**
 * ENG-2840 (W2-9): the /api/emma routes behind the two LinkedIn Ads reads for outside agents (mcp/server/linkedInAdsReadTools.ts):
 *   POST /linkedin-ads/insights  call_linkedin_ads_insights_api (LinkedIn adAnalytics)
 *   POST /linkedin-ads/read      call_linkedin_marketing_api, its READ actions only (LINKEDIN_READ_ACTIONS below)
 *
 * Each route checks the body by name and by value (the same checks as the MCP tools, exported from here: a route can also be called
 * directly with any user's token), checks that `account_id` is a LinkedIn ad account the caller connected or one a teammate shared with the
 * organization, then calls Emma's own implementation (emma/impl/adsApis.ts) with `req.user.userId` and the checked fields only. No identity
 * is ever read from the body. Emma resolves the token the same way (own plus org-shared accounts; a refreshed token is saved on the owner's
 * record) and refuses an evaluation sandbox's denied tool classes through her registry; these routes call her implementation directly, so
 * they apply that sandbox check themselves.
 *
 * Why every value is checked so strictly: Emma's LinkedIn client puts some values into LinkedIn query strings unencoded (adAnalytics `fields`
 * and the dateRange numbers, the campaign `status` list), so `impressions&accounts=urn:li:sponsoredAccount:1` would add a RestLI parameter.
 * Every value here is an enum, a whole number in range, digits, or a URN of one exact shape.
 *
 * Scoped to the checked account only. An org-shared connection lends the owner's token, and that token can see ad accounts that were never
 * shared (an agency owner's token sees its clients' accounts). So nothing here names an entity outside the checked account:
 *  - insights take no campaign_groups / campaigns / creatives filters (it is not verified that LinkedIn ANDs those with `accounts=`, so a
 *    filter id of an unshared account might be answered); the rows are scoped by `accounts=` alone, and a per-campaign or per-ad breakdown
 *    comes from `pivot` (CAMPAIGN_GROUP, CAMPAIGN, CREATIVE);
 *  - Emma's POST GET (any post URN the token can read) is not offered; CREATIVE LIST's referenced posts are the checked account's own ads';
 *  - AD_ACCOUNT LIST answers only the ad accounts the caller has connected or that are shared with them.
 *
 * Bounds (Emma has none of them): each LinkedIn request gives up after 30 s (the token refresh too); a list reads at most 5 pages and 500
 * elements; CREATIVE LIST expands at most 10 referenced posts (Emma expands every one, all at once).
 *
 * Answers are fixed fields, each list cut to about 55 KB of JSON with `truncated: true`. A bad body is a 400; an account that is not the
 * caller's a 404; a LinkedIn 4xx passes with its status and short words (a 401 becomes a 403 that says to reconnect); a LinkedIn 5xx, a
 * timeout or any other failure is a fixed text (502, 504, 500). Budget class: registered on the emmaApi router, after its auth and
 * token-budget middleware. A share-link visitor may run these: Emma allows them estimate-reach and get, list and search actions.
 */
import type { Router, Request, Response } from 'express';
import type { AuthenticatedRequest } from '../middleware/auth';
import type { LinkedInReadBounds } from '../emma/impl/adsApis';
import { EvaluationDenied, enforceEvaluationTool } from '../services/evaluationPolicy';

// ─────────────────────────────────────────────────────────────────────────────────────────────────── argument checks

/** A refusal of the arguments: a 400 here, a tool error (nothing called) in the MCP tool. */
export class LinkedInReadArgError extends Error {}

function bad(message: string): never {
  throw new LinkedInReadArgError(message);
}

/** No campaign_groups / campaigns / creatives filters (see the header): they are refused by name. */
export const LINKEDIN_INSIGHTS_INPUTS = ['account_id', 'pivot', 'dateRange', 'timeGranularity', 'fields'] as const;
export const LINKEDIN_READ_INPUTS = ['entity_type', 'action', 'account_id', 'params'] as const;

/** Emma's pivot list (emma/tools.ts, call_linkedin_ads_insights_api) plus MEMBER_JOB_TITLE (the service's own example and Zoma's list). */
export const LINKEDIN_PIVOTS = [
  'CAMPAIGN_GROUP', 'CAMPAIGN', 'CREATIVE', 'COMPANY', 'ACCOUNT', 'MEMBER_COMPANY_SIZE', 'MEMBER_INDUSTRY', 'MEMBER_SENIORITY',
  'MEMBER_JOB_FUNCTION', 'MEMBER_JOB_TITLE', 'MEMBER_COUNTRY_V2', 'MEMBER_REGION_V2', 'PLACEMENT_NAME', 'IMPRESSION_DEVICE_TYPE',
] as const;
/** Emma's enum. */
export const LINKEDIN_TIME_GRANULARITIES = ['ALL', 'DAILY', 'MONTHLY', 'YEARLY'] as const;
/** Emma's status enum plus LinkedIn's PENDING_DELETION and REMOVED (Zoma's list). */
export const LINKEDIN_LIST_STATUSES = ['ACTIVE', 'PAUSED', 'ARCHIVED', 'DRAFT', 'CANCELED', 'COMPLETED', 'PENDING_DELETION', 'REMOVED'] as const;
/** Emma's default metrics plus the two fields that say which row is which (dateRange, pivotValues). */
export const LINKEDIN_DEFAULT_FIELDS = ['impressions', 'clicks', 'costInLocalCurrency', 'dateRange', 'pivotValues'] as const;
export const LINKEDIN_MAX_FIELDS = 20;
/** About three years (one leap day included). */
export const LINKEDIN_MAX_RANGE_DAYS = 1096;
export const LINKEDIN_MAX_TARGETING_FACETS = 10;
/** Values in all, across the facets of one list (targeting_include, or targeting_exclude). */
export const LINKEDIN_MAX_TARGETING_VALUES = 50;
export const LINKEDIN_MAX_QUERY_CHARS = 100;

/**
 * The read actions (`ENTITY ACTION`) and the params each takes, by name. Every other pair, every write among them, is refused; so is Emma's
 * POST GET (see the header).
 */
export const LINKEDIN_READ_ACTIONS: ReadonlyMap<string, readonly string[]> = new Map<string, readonly string[]>([
  ['AD_ACCOUNT LIST', []],
  ['CAMPAIGN_GROUP LIST', ['status']],
  ['CAMPAIGN LIST', ['status', 'campaign_group_id']],
  ['CREATIVE LIST', ['campaign_id']],
  ['TARGETING LIST_FACETS', []],
  ['TARGETING SEARCH', ['facet', 'query']],
  ['TARGETING ESTIMATE_REACH', ['targeting_include', 'targeting_exclude']],
]);

const DIGITS_RE = /^\d{1,20}$/;
const FIELD_RE = /^[A-Za-z0-9]{1,64}$/;
export const LINKEDIN_FACET_RE = /^urn:li:adTargetingFacet:[A-Za-z]{1,60}$/;
/** A targeting value URN (urn:li:geo:103644278, urn:li:staffCountRange:(11,50)); the service percent-encodes it as well. */
const VALUE_URN_RE = /^urn:li:[A-Za-z]{1,40}:[A-Za-z0-9_(),.:-]{1,120}$/;
// Control, line-separator, zero-width and bidirectional characters: never part of a search an agent means.
const UNSAFE_TEXT_RE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/;
const ACCOUNT_URN = 'urn:li:sponsoredAccount:';

const absent = (value: unknown) => value === undefined || value === null;

function plainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** A key as it may be shown back: printable ASCII, at most 40 characters. */
const shown = (key: string) => key.replace(/[^\x20-\x7e]/g, '?').slice(0, 40);

/** `value` as an object holding only the `allowed` keys. */
function onlyKeys(field: string, value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!plainObject(value)) bad(`${field} must be an object`);
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    const names = unknown.slice(0, 5).map((key) => `"${shown(key)}"`).join(', ');
    bad(`${field} does not take ${names}; ${allowed.length > 0 ? `it takes ${allowed.join(', ')}` : 'it takes nothing'}`);
  }
  return value;
}

/** A positive whole number, or digits, as digits; with `urnPrefix`, `<urnPrefix><digits>` too. */
function idValue(field: string, value: unknown, what: string, urnPrefix?: string): string {
  const text = typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value) : value;
  if (typeof text === 'string') {
    const bare = urnPrefix && text.startsWith(urnPrefix) ? text.slice(urnPrefix.length) : text;
    if (DIGITS_RE.test(bare)) return bare;
  }
  bad(`${field} must be ${what}`);
}

export function normalizeLinkedInAccountId(value: unknown): string {
  return String(value ?? '').trim().replace(/^urn:li:sponsoredAccount:/i, '');
}

/** The numeric LinkedIn Ads account id (urn:li:sponsoredAccount:<id> is accepted and read as its number). */
export function checkAccountId(value: unknown): string {
  if (absent(value) || value === '') bad('account_id is required: the LinkedIn Ads account id from list_connected_accounts');
  return idValue('account_id', value, 'the numeric LinkedIn Ads account id from list_connected_accounts', ACCOUNT_URN);
}

export interface LinkedInDate { year: number; month: number; day: number }

function datePart(field: string, value: unknown): LinkedInDate & { ms: number } {
  const d = onlyKeys(field, value, ['year', 'month', 'day']);
  const whole = (key: 'year' | 'month' | 'day', min: number, max: number): number => {
    const n = d[key];
    if (typeof n !== 'number' || !Number.isInteger(n) || n < min || n > max) bad(`${field}.${key} must be a whole number from ${min} to ${max}`);
    return n;
  };
  const year = whole('year', 2000, 2100);
  const month = whole('month', 1, 12);
  const day = whole('day', 1, 31);
  const ms = Date.UTC(year, month - 1, day);
  if (new Date(ms).getUTCDate() !== day) bad(`${field} is not a real calendar date`);
  return { year, month, day, ms };
}

export interface LinkedInInsightsRequest {
  account_id: string;
  pivot: string;
  timeGranularity: string;
  dateRange: { start: LinkedInDate; end: LinkedInDate };
  fields: string[];
}

/** The insights arguments, checked; what the route sends Emma. Checking the result again gives the same result. */
export function checkInsightsArgs(args: unknown): LinkedInInsightsRequest {
  const a = onlyKeys('the arguments', absent(args) ? {} : args, LINKEDIN_INSIGHTS_INPUTS);
  const account_id = checkAccountId(a.account_id);
  const pivot = a.pivot;
  if (typeof pivot !== 'string' || !(LINKEDIN_PIVOTS as readonly string[]).includes(pivot)) bad(`pivot must be one of ${LINKEDIN_PIVOTS.join(', ')}`);
  let timeGranularity = 'ALL';
  if (!absent(a.timeGranularity)) {
    const g = a.timeGranularity;
    if (typeof g !== 'string' || !(LINKEDIN_TIME_GRANULARITIES as readonly string[]).includes(g)) bad(`timeGranularity must be one of ${LINKEDIN_TIME_GRANULARITIES.join(', ')}`);
    timeGranularity = g;
  }
  if (absent(a.dateRange)) bad('dateRange is required: { start: { year, month, day }, end: { year, month, day } }');
  const range = onlyKeys('dateRange', a.dateRange, ['start', 'end']);
  const start = datePart('dateRange.start', range.start);
  const end = datePart('dateRange.end', range.end);
  if (end.ms < start.ms) bad('dateRange.end is before dateRange.start');
  if ((end.ms - start.ms) / 86_400_000 > LINKEDIN_MAX_RANGE_DAYS) bad(`dateRange is longer than ${LINKEDIN_MAX_RANGE_DAYS} days (about three years)`);
  let fields: string[] = [...LINKEDIN_DEFAULT_FIELDS];
  if (!absent(a.fields)) {
    const list = a.fields;
    if (!Array.isArray(list) || list.length < 1 || list.length > LINKEDIN_MAX_FIELDS) bad(`fields must be a list of 1 to ${LINKEDIN_MAX_FIELDS} LinkedIn metric names`);
    fields = list.map((f, i) => {
      if (typeof f !== 'string' || !FIELD_RE.test(f)) bad(`fields[${i}] must be a LinkedIn metric name: letters and digits only, at most 64`);
      return f;
    });
    if (new Set(fields).size !== fields.length) bad('fields has the same name twice');
  }
  return {
    account_id,
    pivot,
    timeGranularity,
    dateRange: { start: { year: start.year, month: start.month, day: start.day }, end: { year: end.year, month: end.month, day: end.day } },
    fields,
  };
}

export interface LinkedInTargetingClause { facet_urn: string; values: string[] }

function targeting(field: string, value: unknown, required: boolean): LinkedInTargetingClause[] | undefined {
  if (absent(value)) {
    if (required) bad(`${field} is required: a list of { facet_urn, values }`);
    return undefined;
  }
  if (!Array.isArray(value) || value.length > LINKEDIN_MAX_TARGETING_FACETS || (required && value.length === 0)) {
    bad(`${field} must be a list of ${required ? 1 : 0} to ${LINKEDIN_MAX_TARGETING_FACETS} facets`);
  }
  if (value.length === 0) return undefined;
  let total = 0;
  const facets = new Set<string>();
  return value.map((clause, i) => {
    const c = onlyKeys(`${field}[${i}]`, clause, ['facet_urn', 'values']);
    const facet = c.facet_urn;
    if (typeof facet !== 'string' || !LINKEDIN_FACET_RE.test(facet)) bad(`${field}[${i}].facet_urn must be a facet URN such as urn:li:adTargetingFacet:locations`);
    if (facets.has(facet)) bad(`${field} has the facet ${facet} twice`);
    facets.add(facet);
    const list = c.values;
    if (!Array.isArray(list) || list.length < 1) bad(`${field}[${i}].values must be a list of 1 or more LinkedIn URNs`);
    total += list.length;
    if (total > LINKEDIN_MAX_TARGETING_VALUES) bad(`${field} has more than ${LINKEDIN_MAX_TARGETING_VALUES} values in all`);
    const values = list.map((v, j) => {
      if (typeof v !== 'string' || !VALUE_URN_RE.test(v)) bad(`${field}[${i}].values[${j}] must be a LinkedIn URN such as urn:li:geo:103644278 (from TARGETING SEARCH)`);
      return v;
    });
    if (new Set(values).size !== values.length) bad(`${field}[${i}].values has the same URN twice`);
    return { facet_urn: facet, values };
  });
}

function statusList(value: unknown): string[] | undefined {
  if (absent(value)) return undefined;
  const list = typeof value === 'string' ? [value] : value;
  const known = LINKEDIN_LIST_STATUSES as readonly unknown[];
  if (!Array.isArray(list) || list.length < 1 || list.length > LINKEDIN_LIST_STATUSES.length || !list.every((s) => known.includes(s))) {
    bad(`params.status must be one of ${LINKEDIN_LIST_STATUSES.join(', ')}, or a list of them`);
  }
  if (new Set(list).size !== list.length) bad('params.status has the same status twice');
  return list as string[];
}

export interface LinkedInReadRequest {
  entity_type: string;
  action: string;
  account_id: string;
  /** Checked params; `status` is a list here (Emma takes it comma-joined, see emmaReadParams). */
  params: Record<string, unknown>;
}

/** The marketing-read arguments, checked (the read allow-list first); what the route sends Emma. Checking the result again gives the same. */
export function checkReadArgs(args: unknown): LinkedInReadRequest {
  const a = onlyKeys('the arguments', absent(args) ? {} : args, LINKEDIN_READ_INPUTS);
  const entity = a.entity_type;
  const action = a.action;
  if (typeof entity !== 'string' || typeof action !== 'string') bad('entity_type and action are required (text)');
  const key = `${entity} ${action}`;
  const allowed = LINKEDIN_READ_ACTIONS.get(key);
  if (!allowed) {
    const named = /^[A-Z_]{1,40}$/.test(entity) && /^[A-Z_]{1,40}$/.test(action) ? `${entity} ${action}` : 'that entity_type and action';
    bad(`${named} is not available here: this tool only reads, and takes ${[...LINKEDIN_READ_ACTIONS.keys()].join(', ')}`);
  }
  const account_id = checkAccountId(a.account_id);
  const p: Record<string, unknown> = absent(a.params) ? {} : onlyKeys(`params of ${key}`, a.params, allowed);
  const params: Record<string, unknown> = {};
  switch (key) {
    case 'CAMPAIGN_GROUP LIST':
    case 'CAMPAIGN LIST': {
      const status = statusList(p.status);
      if (status) params.status = status;
      if (!absent(p.campaign_group_id)) {
        // LinkedIn cannot filter campaigns by group and status together (the service would drop the status).
        if (status) bad('give params.status or params.campaign_group_id, not both: LinkedIn filters campaigns by one of them');
        params.campaign_group_id = idValue('params.campaign_group_id', p.campaign_group_id, 'a numeric campaign group id (digits)');
      }
      break;
    }
    case 'CREATIVE LIST':
      if (absent(p.campaign_id)) bad('params.campaign_id is required for CREATIVE LIST');
      params.campaign_id = idValue('params.campaign_id', p.campaign_id, 'a numeric campaign id (digits)');
      break;
    case 'TARGETING SEARCH': {
      const facet = p.facet;
      if (typeof facet !== 'string' || !LINKEDIN_FACET_RE.test(facet)) bad('params.facet is required: a facet URN such as urn:li:adTargetingFacet:locations');
      params.facet = facet;
      if (!absent(p.query)) {
        const query = p.query;
        if (typeof query !== 'string' || query.length > LINKEDIN_MAX_QUERY_CHARS || UNSAFE_TEXT_RE.test(query)) {
          bad(`params.query must be text of at most ${LINKEDIN_MAX_QUERY_CHARS} characters, on one line`);
        }
        if (query.trim() !== '') params.query = query;
      }
      break;
    }
    case 'TARGETING ESTIMATE_REACH': {
      params.targeting_include = targeting('params.targeting_include', p.targeting_include, true);
      const exclude = targeting('params.targeting_exclude', p.targeting_exclude, false);
      if (exclude) params.targeting_exclude = exclude;
      break;
    }
    default:
      break; // AD_ACCOUNT LIST, TARGETING LIST_FACETS: no params
  }
  return { entity_type: entity, action, account_id, params };
}

/** The params as Emma's implementation takes them (the status list comma-joined: values from the enum only). */
export function emmaReadParams(request: LinkedInReadRequest): Record<string, unknown> {
  const { status, ...rest } = request.params;
  return Array.isArray(status) ? { ...rest, status: status.join(',') } : rest;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────── answers

/** The most a list may take, in bytes of its JSON as the MCP tool prints it; the rest of an answer is small (about 60 KB in all). */
export const LINKEDIN_MAX_LIST_BYTES = 55_000;

/** `items` cut at the first one that would take the list past `maxBytes` (measured two-space indented, at the depth an answer nests it). */
export function fitList(items: readonly unknown[], maxBytes = LINKEDIN_MAX_LIST_BYTES): { items: unknown[]; truncated: boolean } {
  const kept: unknown[] = [];
  let used = 2;
  for (const item of items) {
    const text = JSON.stringify(item, null, 2) ?? 'null';
    const size = Buffer.byteLength(text, 'utf8') + 4 * (text.split('\n').length) + 2;
    if (used + size > maxBytes) return { items: kept, truncated: true };
    used += size;
    kept.push(item);
  }
  return { items: kept, truncated: false };
}

/** The fields of an ad account that are answered. */
const AD_ACCOUNT_FIELDS = ['id', 'name', 'currency', 'status', 'type', 'reference', 'test'] as const;
export const AD_ACCOUNT_CUT_NOTE = 'The list of ad accounts this LinkedIn sign-in can see was too long to read in full, so some of your accounts may be missing here. '
  + 'list_connected_accounts lists all of them.';
/** Where each read action's list is answered (Emma's own keys). */
export const LINKEDIN_READ_LIST_KEYS: Readonly<Record<string, string>> = {
  'AD_ACCOUNT LIST': 'adAccounts',
  'CAMPAIGN_GROUP LIST': 'campaignGroups',
  'CAMPAIGN LIST': 'campaigns',
  'CREATIVE LIST': 'creatives',
  'TARGETING LIST_FACETS': 'facets',
  'TARGETING SEARCH': 'entities',
};

function pick(source: unknown, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!plainObject(source)) return out;
  for (const key of keys) if (source[key] !== undefined) out[key] = source[key];
  return out;
}

const countOrNull = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/** The LinkedIn ad account ids among the caller's own and org-shared connections. */
export function linkedInAdAccountIds(accounts: ReadonlyArray<{ platform?: unknown; account_id?: unknown; config?: unknown }>): Set<string> {
  const ids = new Set<string>();
  for (const account of accounts) {
    if (account?.platform !== 'linkedin_ads' || (account.config as { account_type?: unknown } | undefined)?.account_type !== 'ad_account') continue;
    const id = normalizeLinkedInAccountId(account.account_id);
    if (id !== '') ids.add(id);
  }
  return ids;
}

/** The answer of a marketing read: fixed fields; AD_ACCOUNT LIST holds only the caller's own and org-shared ad accounts. */
export function readAnswer(request: LinkedInReadRequest, result: any, visibleAccountIds: ReadonlySet<string>): Record<string, unknown> {
  const key = `${request.entity_type} ${request.action}`;
  const head = { account_id: request.account_id, entity_type: request.entity_type, action: request.action };
  const list = (items: unknown, fetchTruncated: boolean, extra: Record<string, unknown> = {}) => {
    const fit = fitList(Array.isArray(items) ? items : []);
    return { ...head, count: fit.items.length, truncated: fetchTruncated || fit.truncated, [LINKEDIN_READ_LIST_KEYS[key]]: fit.items, ...extra };
  };
  switch (key) {
    case 'AD_ACCOUNT LIST': {
      const accounts = (Array.isArray(result?.adAccounts) ? result.adAccounts : [])
        .filter((account: any) => visibleAccountIds.has(normalizeLinkedInAccountId(account?.id)))
        .map((account: any) => pick(account, AD_ACCOUNT_FIELDS));
      // When the 500-element bound cut the token's list, some of the caller's own accounts may be missing: say so, with no page or count.
      const cutShort = result?.truncated === true;
      return list(accounts, cutShort, cutShort ? { note: AD_ACCOUNT_CUT_NOTE } : {});
    }
    case 'CAMPAIGN_GROUP LIST':
      return list(result?.campaignGroups, result?.truncated === true);
    case 'CAMPAIGN LIST':
      return list(result?.campaigns, result?.truncated === true);
    case 'CREATIVE LIST':
      return list(result?.creatives, result?.truncated === true, { referenced_posts_not_expanded: countOrNull(result?.referencedPostsNotExpanded) ?? 0 });
    case 'TARGETING LIST_FACETS':
      return list(result?.facets, false);
    case 'TARGETING SEARCH':
      return list(result?.entities, false);
    case 'TARGETING ESTIMATE_REACH': {
      const data = result?.audienceCount;
      const row = Array.isArray(data?.elements) ? data.elements[0] : data;
      return { ...head, audience: { active: countOrNull(row?.active), total: countOrNull(row?.total) } };
    }
    default:
      return head;
  }
}

/** The answer of an insights read: the checked request echoed, and the rows. */
export function insightsAnswer(request: LinkedInInsightsRequest, result: any): Record<string, unknown> {
  const fit = fitList(Array.isArray(result?.analytics) ? result.analytics : []);
  return {
    account_id: request.account_id,
    pivot: request.pivot,
    timeGranularity: request.timeGranularity,
    dateRange: request.dateRange,
    fields: request.fields,
    count: fit.items.length,
    truncated: fit.truncated,
    elements: fit.items,
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────── failures

const MAX_MESSAGE_CHARS = 300;
const TIMEOUT_RE = /timeout|ECONNABORTED|ETIMEDOUT/i;
const RECONNECT = 'Reconnect LinkedIn Ads in AgentWeb, then try again';

/** Provider text on one line (no control or invisible characters), at most 300 characters. */
function shortText(value: unknown): string {
  const flat = String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]+/g, ' ').replace(/\s+/g, ' ').trim();
  return flat.length > MAX_MESSAGE_CHARS ? `${flat.slice(0, MAX_MESSAGE_CHARS)}...` : flat;
}

/** The HTTP status and words for a failure of Emma's implementation. Only our own short texts and LinkedIn's (cut) words reach the caller. */
export function linkedInFailure(err: any): { status: number; message: string } {
  if (err instanceof EvaluationDenied) return { status: 403, message: 'This tool is not available in this sandbox workspace' };
  const message = typeof err?.message === 'string' ? err.message : '';
  // A LinkedIn call that failed (emma/impl/adsApis.ts linkedInReadError): LinkedIn's status, or none for a timeout or a network failure.
  if (err && typeof err === 'object' && 'linkedInStatus' in err) {
    const status = typeof err.linkedInStatus === 'number' ? err.linkedInStatus : undefined;
    if (status === 401) return { status: 403, message: `LinkedIn no longer accepts this LinkedIn Ads sign-in (HTTP 401). ${RECONNECT}` };
    if (status === 429) return { status: 429, message: 'LinkedIn is limiting requests from AgentWeb\'s LinkedIn app right now (HTTP 429). Try again in a few minutes' };
    if (status !== undefined && status >= 400 && status < 500) return { status, message: `LinkedIn refused the request (HTTP ${status}): ${shortText(message) || 'no details'}` };
    if (status === undefined && TIMEOUT_RE.test(message)) return { status: 504, message: 'LinkedIn did not answer in time. Try again later' };
    return { status: 502, message: status !== undefined ? `LinkedIn could not answer (HTTP ${status}). Try again later` : 'LinkedIn could not be reached. Try again later' };
  }
  // Emma's own account texts (getLinkedInAdsCredentials).
  if (/^LinkedIn Ads account (not connected|".*" not found)/.test(message)) return { status: 404, message: shortText(message) };
  if (/^LinkedIn Ads access token expired and no refresh token/.test(message)) return { status: 409, message: `The LinkedIn Ads sign-in for this account has expired. ${RECONNECT}` };
  // The token refresh (an axios call): LinkedIn refusing the refresh token, a timeout, or a network failure.
  const refreshStatus = err?.response?.status;
  if (err?.isAxiosError === true || typeof refreshStatus === 'number') {
    if (refreshStatus === 400 || refreshStatus === 401) return { status: 409, message: `LinkedIn did not renew the sign-in of this LinkedIn Ads account. ${RECONNECT}` };
    if (refreshStatus === undefined && TIMEOUT_RE.test(`${message} ${err?.code ?? ''}`)) return { status: 504, message: 'LinkedIn did not answer in time. Try again later' };
    return { status: 502, message: 'LinkedIn could not be reached. Try again later' };
  }
  return { status: 500, message: 'The LinkedIn Ads read failed. Try again later' };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────── routes

/** What the read route asks of Emma's implementation (she has no bounds of her own). */
export const LINKEDIN_READ_ROUTE_BOUNDS: Readonly<LinkedInReadBounds> = Object.freeze({ timeoutMs: 30_000, maxPages: 5, maxElements: 500, maxReferencedPosts: 10 });
/** The insights route: one adAnalytics request (and maybe a token refresh), each cut at 30 s. */
export const LINKEDIN_INSIGHTS_ROUTE_BOUNDS: Readonly<LinkedInReadBounds> = Object.freeze({ timeoutMs: 30_000 });

function userId(req: Request): string {
  return (req as AuthenticatedRequest).user.userId;
}

/** The ad account ids the caller may read: their own LinkedIn Ads connections and those a teammate shared with the organization. */
async function visibleAccountIds(caller: string): Promise<Set<string>> {
  const { getAccountsWithOwnerIncludingOrgShared } = await import('../services/connectedAccountsDb');
  return linkedInAdAccountIds(await getAccountsWithOwnerIncludingOrgShared(caller));
}

function notConnected(accountId: string): string {
  return `LinkedIn Ads account ${accountId} is not connected to your account or shared with your organization. Use an account_id from list_connected_accounts`;
}

function fail(res: Response, path: string, err: unknown): void {
  if (err instanceof LinkedInReadArgError) {
    res.status(400).json({ message: err.message });
    return;
  }
  const failure = linkedInFailure(err);
  if (failure.status >= 500) console.error(`[emma] ${path} failed:`, shortText((err as any)?.message));
  res.status(failure.status).json({ message: failure.message });
}

/** Registers the two routes on the emmaApi router (after its authentication and token-budget middleware). */
export function registerLinkedInAdsReadRoutes(router: Router): void {
  router.post('/linkedin-ads/insights', async (req: Request, res: Response) => {
    try {
      const request = checkInsightsArgs(req.body);
      const caller = userId(req);
      await enforceEvaluationTool(caller, 'call_linkedin_ads_insights_api');
      if (!(await visibleAccountIds(caller)).has(request.account_id)) {
        res.status(404).json({ message: notConnected(request.account_id) });
        return;
      }
      const { callLinkedInAdsInsightsApi } = await import('../emma/impl/adsApis');
      const result = await callLinkedInAdsInsightsApi(caller, request.account_id, {
        pivot: request.pivot,
        dateRange: request.dateRange,
        timeGranularity: request.timeGranularity,
        fields: request.fields,
      }, LINKEDIN_INSIGHTS_ROUTE_BOUNDS);
      res.json({ success: true, ...insightsAnswer(request, result) });
    } catch (err) {
      fail(res, '/linkedin-ads/insights', err);
    }
  });

  router.post('/linkedin-ads/read', async (req: Request, res: Response) => {
    try {
      const request = checkReadArgs(req.body);
      const caller = userId(req);
      await enforceEvaluationTool(caller, 'call_linkedin_marketing_api');
      const visible = await visibleAccountIds(caller);
      if (!visible.has(request.account_id)) {
        res.status(404).json({ message: notConnected(request.account_id) });
        return;
      }
      const { callLinkedInMarketingApi } = await import('../emma/impl/adsApis');
      const result = await callLinkedInMarketingApi(
        caller,
        request.entity_type as Parameters<typeof callLinkedInMarketingApi>[1],
        request.action,
        request.account_id,
        emmaReadParams(request),
        LINKEDIN_READ_ROUTE_BOUNDS,
      );
      res.json({ success: true, ...readAnswer(request, result, visible) });
    } catch (err) {
      fail(res, '/linkedin-ads/read', err);
    }
  });
}
