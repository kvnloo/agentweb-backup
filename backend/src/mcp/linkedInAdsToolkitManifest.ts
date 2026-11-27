/**
 * Zoma LinkedIn Ads toolkit: manifest + reads (provider #4; X's is xAdsToolkitManifest.ts).
 * Dark until ZOMA_LINKEDIN_ADS_ENABLED is "read" (reads only) or "true" (reads and writes).
 *
 * Two tools, split so MCP annotations are honest (toolkitToolAnnotations.ts):
 *   - linkedin_ads_read  (read-only): LIST_ACCOUNTS, LIST_CAMPAIGN_GROUPS, LIST_CAMPAIGNS,
 *     LIST_CREATIVES, LIST_TARGETING_FACETS, SEARCH_TARGETING_ENTITIES, ESTIMATE_AUDIENCE,
 *     GET_ANALYTICS (LinkedIn adAnalytics, synchronous).
 *   - linkedin_ads_write (guarded, linkedInAdsToolkitWrites.ts): CAMPAIGN_GROUP / CAMPAIGN
 *     CREATE, UPDATE, PAUSE, ACTIVATE; CREATIVE CREATE, PAUSE, ACTIVATE.
 * Everything else is refused before any account or LinkedIn call.
 *
 * The surface is enforced twice: narrowed in the advertised schema (additionalProperties false)
 * AND refused at call time (assertLinkedInAdsToolkitCall), so a client that ignores the schema
 * still cannot reach an argument the schema does not list.
 *
 * Reads touch only the resolved (connected, usable) ad account: every id in a path or filter comes
 * from validated input and the account id comes from the connection, never from the caller's text.
 * What LinkedIn has confirmed IN WRITING for an ad account that is not on the app's Account Management
 * list is adAnalytics GET (GET_ANALYTICS) only. Campaign, creative, targeting and audience-count reads
 * are NOT assumed to work for such an account, and there is deliberately NO pre-check that blocks a
 * read: the call is made, and if LinkedIn answers 403 "not configured to access the related
 * advertiser account(s)" the result says, per endpoint, that LinkedIn has not enabled the app for
 * that ad account yet (see linkedInAdsErrors.ts). Writes are explained in linkedInAdsToolkitWrites.ts.
 */
import * as linkedInAdsService from '../services/linkedInAdsService';
import { MetaToolkitRefusal } from './metaToolkitErrors';
import { linkedInAdsWritesEnabled } from './zomaToolDefinitions';
import { withUseWhen } from './zomaUseWhen';
import {
  callLinkedIn, classifyLinkedInFailure, linkedInNotEnabledReadResult, linkedInRateLimitedResult, redactLinkedInText, type LinkedInAdsSession,
  type LinkedInCallResult,
} from './linkedInAdsCall';

export const LINKEDIN_ADS_READ_TOOL = 'linkedin_ads_read';
export const LINKEDIN_ADS_WRITE_TOOL = 'linkedin_ads_write';
export const LINKEDIN_ADS_TOOL_NAMES = [LINKEDIN_ADS_READ_TOOL, LINKEDIN_ADS_WRITE_TOOL] as const;
export type LinkedInAdsToolName = (typeof LINKEDIN_ADS_TOOL_NAMES)[number];

export const LINKEDIN_ADS_READ_ACTIONS = [
  'LIST_ACCOUNTS', 'LIST_CAMPAIGN_GROUPS', 'LIST_CAMPAIGNS', 'LIST_CREATIVES',
  'LIST_TARGETING_FACETS', 'SEARCH_TARGETING_ENTITIES', 'ESTIMATE_AUDIENCE', 'GET_ANALYTICS',
] as const;

export const LINKEDIN_ADS_WRITES: Record<string, readonly string[]> = {
  CAMPAIGN_GROUP: ['CREATE', 'UPDATE', 'PAUSE', 'ACTIVATE'],
  CAMPAIGN: ['CREATE', 'UPDATE', 'PAUSE', 'ACTIVATE'],
  CREATIVE: ['CREATE', 'PAUSE', 'ACTIVATE'],
};

/** Campaign types the toolkit creates. DYNAMIC, message and conversation ads are not part of it. */
export const LINKEDIN_CAMPAIGN_TYPES = ['SPONSORED_UPDATES', 'TEXT_AD'] as const;
export const LINKEDIN_COST_TYPES = ['CPC', 'CPM', 'CPV'] as const;
export const LINKEDIN_OBJECTIVE_TYPES = [
  'BRAND_AWARENESS', 'WEBSITE_VISIT', 'ENGAGEMENT', 'VIDEO_VIEW', 'LEAD_GENERATION', 'WEBSITE_CONVERSION', 'JOB_APPLICANT',
] as const;
export const LINKEDIN_POLITICAL_INTENTS = ['NOT_POLITICAL', 'POLITICAL'] as const;
const LIST_STATUSES = ['ACTIVE', 'PAUSED', 'DRAFT', 'ARCHIVED', 'CANCELED', 'COMPLETED', 'PENDING_DELETION', 'REMOVED'] as const;
export const LINKEDIN_PIVOTS = [
  'ACCOUNT', 'CAMPAIGN_GROUP', 'CAMPAIGN', 'CREATIVE', 'MEMBER_COMPANY_SIZE', 'MEMBER_INDUSTRY', 'MEMBER_SENIORITY',
  'MEMBER_JOB_FUNCTION', 'MEMBER_JOB_TITLE', 'MEMBER_COUNTRY_V2', 'MEMBER_REGION_V2',
] as const;
export const LINKEDIN_TIME_GRANULARITIES = ['ALL', 'DAILY', 'MONTHLY', 'YEARLY'] as const;
const DEFAULT_ANALYTICS_FIELDS = ['impressions', 'clicks', 'costInLocalCurrency', 'dateRange', 'pivotValues'];

export function isLinkedInAdsToolkitTool(name: string): name is LinkedInAdsToolName {
  return (LINKEDIN_ADS_TOOL_NAMES as readonly string[]).includes(name);
}

export function isLinkedInAdsToolkitWrite(name: string): boolean {
  return name === LINKEDIN_ADS_WRITE_TOOL;
}

const ACCOUNT_ID = { type: 'string', description: 'LinkedIn ad account id (numeric); needed only when more than one is connected.' };

const TARGETING_CLAUSE = {
  type: 'object',
  properties: {
    facet_urn: { type: 'string', description: 'e.g. urn:li:adTargetingFacet:locations (from LIST_TARGETING_FACETS).' },
    values: { type: 'array', items: { type: 'string' }, description: 'Entity URNs from SEARCH_TARGETING_ENTITIES, e.g. urn:li:geo:103644278.' },
  },
  required: ['facet_urn', 'values'],
  additionalProperties: false,
};

const READ_PROPERTIES: Record<string, any> = {
  action: { type: 'string', enum: [...LINKEDIN_ADS_READ_ACTIONS] },
  account_id: ACCOUNT_ID,
  status: { type: 'array', items: { type: 'string', enum: [...LIST_STATUSES] }, description: 'LIST_CAMPAIGN_GROUPS / LIST_CAMPAIGNS: statuses to include (default ACTIVE, PAUSED, DRAFT, ARCHIVED). Ignored on LIST_CAMPAIGNS when campaign_group_id is given.' },
  campaign_group_id: { type: 'string', description: 'LIST_CAMPAIGNS: only the campaigns of this campaign group (numeric id or urn:li:sponsoredCampaignGroup:...).' },
  campaign_id: { type: 'string', description: 'LIST_CREATIVES (required): the campaign whose creatives to list (numeric id or urn:li:sponsoredCampaign:...).' },
  facet_urn: { type: 'string', description: 'SEARCH_TARGETING_ENTITIES (required): a facet from LIST_TARGETING_FACETS, e.g. urn:li:adTargetingFacet:locations.' },
  query: { type: 'string', description: 'SEARCH_TARGETING_ENTITIES: text to search inside the facet (not every facet supports a search).' },
  locale_language: { type: 'string', description: 'SEARCH_TARGETING_ENTITIES: two-letter language, e.g. en.' },
  locale_country: { type: 'string', description: 'SEARCH_TARGETING_ENTITIES: two-letter country, e.g. US.' },
  targeting_include: { type: 'array', items: TARGETING_CLAUSE, description: 'ESTIMATE_AUDIENCE (required): facets AND-ed together; the values inside one facet are OR-ed.' },
  targeting_exclude: { type: 'array', items: TARGETING_CLAUSE, description: 'ESTIMATE_AUDIENCE: facets to exclude.' },
  pivot: { type: 'string', enum: [...LINKEDIN_PIVOTS], description: 'GET_ANALYTICS (required): what the rows are grouped by.' },
  time_granularity: { type: 'string', enum: [...LINKEDIN_TIME_GRANULARITIES], description: 'GET_ANALYTICS: default ALL (one row per pivot value).' },
  start_date: { type: 'string', description: 'GET_ANALYTICS (required): YYYY-MM-DD, inclusive.' },
  end_date: { type: 'string', description: 'GET_ANALYTICS (required): YYYY-MM-DD, inclusive.' },
  fields: { type: 'array', items: { type: 'string' }, description: `GET_ANALYTICS: LinkedIn metric names. Default ${DEFAULT_ANALYTICS_FIELDS.join(', ')}.` },
  campaign_group_ids: { type: 'array', items: { type: 'string' }, description: 'GET_ANALYTICS filter: numeric campaign group ids.' },
  campaign_ids: { type: 'array', items: { type: 'string' }, description: 'GET_ANALYTICS filter: numeric campaign ids.' },
  creative_ids: { type: 'array', items: { type: 'string' }, description: 'GET_ANALYTICS filter: numeric creative ids.' },
};

const WRITE_PROPERTIES: Record<string, any> = {
  entity_type: { type: 'string', enum: Object.keys(LINKEDIN_ADS_WRITES) },
  action: { type: 'string', enum: ['CREATE', 'UPDATE', 'PAUSE', 'ACTIVATE'] },
  account_id: ACCOUNT_ID,
  campaign_group_id: { type: 'string', description: 'CAMPAIGN_GROUP UPDATE / PAUSE / ACTIVATE: the group. CAMPAIGN CREATE (required): the group the campaign belongs to. Numeric id or urn:li:sponsoredCampaignGroup:...' },
  campaign_id: { type: 'string', description: 'CAMPAIGN UPDATE / PAUSE / ACTIVATE: the campaign. CREATIVE CREATE (required): the campaign the creative belongs to. Numeric id or urn:li:sponsoredCampaign:...' },
  creative_id: { type: 'string', description: 'CREATIVE PAUSE / ACTIVATE: numeric id or urn:li:sponsoredCreative:...' },
  name: { type: 'string', description: 'CAMPAIGN_GROUP / CAMPAIGN CREATE (required) and UPDATE (rename), 1-100 characters.' },
  daily_budget: { type: 'number', description: 'CAMPAIGN CREATE (required) / UPDATE: daily budget in MAJOR units of the account currency (50 = 50.00 per day).' },
  total_budget: { type: 'number', description: 'CAMPAIGN_GROUP / CAMPAIGN: optional lifetime budget in MAJOR units of the account currency.' },
  unit_cost: { type: 'number', description: 'CAMPAIGN CREATE (required) / UPDATE: max bid per click / impression / view in MAJOR units of the account currency.' },
  cost_type: { type: 'string', enum: [...LINKEDIN_COST_TYPES], description: 'CAMPAIGN CREATE (required): what the unit cost is charged per.' },
  campaign_type: { type: 'string', enum: [...LINKEDIN_CAMPAIGN_TYPES], description: 'CAMPAIGN CREATE (required).' },
  objective_type: { type: 'string', enum: [...LINKEDIN_OBJECTIVE_TYPES], description: 'CAMPAIGN CREATE (required).' },
  political_intent: { type: 'string', enum: [...LINKEDIN_POLITICAL_INTENTS], description: 'CAMPAIGN CREATE (required): whether the ads are political. Ask the user; Zoma never decides this.' },
  locale_country: { type: 'string', description: 'CAMPAIGN CREATE (required): two-letter country of the campaign locale, e.g. US.' },
  locale_language: { type: 'string', description: 'CAMPAIGN CREATE (required): two-letter language of the campaign locale, e.g. en.' },
  targeting_include: { type: 'array', items: TARGETING_CLAUSE, description: 'CAMPAIGN CREATE (required, at least one facet): from LIST_TARGETING_FACETS / SEARCH_TARGETING_ENTITIES.' },
  targeting_exclude: { type: 'array', items: TARGETING_CLAUSE, description: 'CAMPAIGN CREATE: facets to exclude.' },
  start_time: { type: 'string', description: 'CAMPAIGN_GROUP / CAMPAIGN CREATE (required): ISO 8601 start. CAMPAIGN UPDATE / ACTIVATE: a new start when the stored one has passed (LinkedIn rejects any update of a campaign whose start is in the past).' },
  end_time: { type: 'string', description: 'CAMPAIGN_GROUP / CAMPAIGN CREATE: optional ISO 8601 end. CAMPAIGN UPDATE: only together with start_time.' },
  post_urn: { type: 'string', description: 'CREATIVE CREATE: an existing post to run as the ad (urn:li:share:... or urn:li:ugcPost:...). Use this OR headline + description + landing_page.' },
  headline: { type: 'string', description: 'CREATIVE CREATE text ad: headline, up to 25 characters.' },
  description: { type: 'string', description: 'CREATIVE CREATE text ad: description, up to 75 characters.' },
  landing_page: { type: 'string', description: 'CREATIVE CREATE text ad: https URL. LinkedIn UTM tags are added to it.' },
  image_urn: { type: 'string', description: 'CREATIVE CREATE text ad: optional image URN (urn:li:image:...).' },
  confirm: { type: 'boolean', description: 'Omit to get a PREVIEW (nothing changes). Set true only after the user explicitly approved that preview, together with its preview_token.' },
  preview_token: { type: 'string', description: 'The preview_token returned by the preview the user approved. Single use, 15 minutes; the call must repeat the previewed arguments exactly.' },
};

const READ_KEYS = new Set(Object.keys(READ_PROPERTIES));
const WRITE_KEYS = new Set(Object.keys(WRITE_PROPERTIES));

/** Throws MetaToolkitRefusal (the toolkit's tool-level refusal) when outside the surface. */
export function assertLinkedInAdsToolkitCall(name: string, args: any): void {
  if (!isLinkedInAdsToolkitTool(name)) throw new MetaToolkitRefusal(`Tool ${name} is not part of the LinkedIn Ads toolkit.`);
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new MetaToolkitRefusal(`${name} arguments must be an object.`);
  // Plain strings only: an array, object or number would be coerced differently by different readers
  // (the paywall, this table, the validator), and that is how a write can slip past one of them.
  if (typeof args.action !== 'string') throw new MetaToolkitRefusal(`${name} action must be a string.`);
  if (name === LINKEDIN_ADS_WRITE_TOOL && typeof args.entity_type !== 'string') throw new MetaToolkitRefusal(`${name} entity_type must be a string.`);
  const allowed = name === LINKEDIN_ADS_READ_TOOL ? READ_KEYS : WRITE_KEYS;
  const unknown = Object.keys(args).filter((key) => !allowed.has(key));
  if (unknown.length) {
    // A status on a write is the one unknown argument worth explaining: creates are never live.
    if (name === LINKEDIN_ADS_WRITE_TOOL && unknown.some((k) => /status/i.test(k))) {
      throw new MetaToolkitRefusal('Status is not an argument. New campaign groups, campaigns and creatives are always created as DRAFT; to start delivery use a separate ACTIVATE (its own preview and approval).');
    }
    throw new MetaToolkitRefusal(`${name} does not accept: ${unknown.slice(0, 5).join(', ')}.`);
  }
  if (name === LINKEDIN_ADS_READ_TOOL) {
    if (!(LINKEDIN_ADS_READ_ACTIONS as readonly string[]).includes(String(args.action))) {
      throw new MetaToolkitRefusal(`linkedin_ads_read action must be one of ${LINKEDIN_ADS_READ_ACTIONS.join(', ')}.`);
    }
    return;
  }
  const entity = String(args.entity_type ?? '');
  const action = String(args.action ?? '');
  if (!Object.prototype.hasOwnProperty.call(LINKEDIN_ADS_WRITES, entity) || !LINKEDIN_ADS_WRITES[entity].includes(action)) {
    throw new MetaToolkitRefusal(`${entity} ${action} is not part of the LinkedIn Ads toolkit surface.`);
  }
}

/**
 * The advertised tools. `writes` false (read mode, or off) lists linkedin_ads_read only: the write
 * tool is not advertised, so a client cannot even see it. The default follows the flag.
 */
export function getLinkedInAdsToolkitManifest(writes: boolean = linkedInAdsWritesEnabled()) {
  const read = {
    name: LINKEDIN_ADS_READ_TOOL,
    description:
      'LinkedIn Ads reads on the connected LinkedIn ad account (nothing is changed). LIST_ACCOUNTS (the LinkedIn ad accounts connected to Zoma); ' +
      'LIST_CAMPAIGN_GROUPS (status?); LIST_CAMPAIGNS (campaign_group_id? | status?); LIST_CREATIVES (campaign_id); LIST_TARGETING_FACETS; ' +
      'SEARCH_TARGETING_ENTITIES (facet_urn, query?, locale_language?, locale_country?); ESTIMATE_AUDIENCE (targeting_include, targeting_exclude?: the matching member count); ' +
      'GET_ANALYTICS (pivot, start_date, end_date as YYYY-MM-DD, time_granularity ALL|DAILY|MONTHLY|YEARLY, fields?, campaign_group_ids? campaign_ids? creative_ids?: LinkedIn adAnalytics). ' +
      'Money fields are in the account currency in major units (costInLocalCurrency "12.50" = 12.50). ' +
      'Reporting (GET_ANALYTICS) is what LinkedIn confirmed for every connected ad account; for an ad account LinkedIn has not enabled for the Zoma app yet, ' +
      'the other reads can be refused, and the result then says so (reporting still works).',
    inputSchema: {
      type: 'object',
      properties: READ_PROPERTIES,
      required: ['action'],
      additionalProperties: false,
    },
  };
  if (!writes) return withUseWhen([read]);
  return withUseWhen([
    read,
    {
      name: LINKEDIN_ADS_WRITE_TOOL,
      description:
        'LinkedIn Ads guarded writes. Every write is two calls: first without confirm (returns a PREVIEW and preview_token, nothing changes), ' +
        'show the preview to the user, then after their explicit approval repeat the exact same call with confirm=true and the preview_token. ' +
        'CAMPAIGN_GROUP CREATE (name, start_time, end_time?, total_budget?) / UPDATE (campaign_group_id, name? total_budget?); ' +
        'CAMPAIGN CREATE (campaign_group_id, name, campaign_type, objective_type, cost_type, unit_cost, daily_budget, total_budget?, start_time, end_time?, locale_country, locale_language, political_intent, targeting_include, targeting_exclude?) / ' +
        'UPDATE (campaign_id, name? daily_budget? total_budget? unit_cost?, or start_time with end_time?); ' +
        'CREATIVE CREATE (campaign_id and either post_urn, or headline + description + landing_page + image_urn?); PAUSE / ACTIVATE (campaign_group_id | campaign_id | creative_id). ' +
        'Budgets and bids are MAJOR units of the account currency (daily_budget: 50 = 50.00 per day); every value is sent explicitly and echoed in the preview, nothing is defaulted. ' +
        'New campaign groups, campaigns and creatives are always created as DRAFT and never go live; ACTIVATE is its own preview and approval ' +
        '(activating can spend up to the daily budget it unlocks). ' +
        'Creating and editing only works on ad accounts LinkedIn has enabled for the Zoma app; for any other ad account the result says write access is not enabled for it yet ' +
        '(reading and reporting still work), and nothing was changed. ' +
        'A write is done only when the result says verification CONFIRMED (read back from LinkedIn; UNCONFIRMED means re-read before retrying).',
      inputSchema: {
        type: 'object',
        properties: WRITE_PROPERTIES,
        required: ['entity_type', 'action'],
        additionalProperties: false,
      },
    },
  ]);
}

// ── Reads ──────────────────────────────────────────────────────────────────────

export type { LinkedInAdsSession };

/** The slice of linkedInAdsService the toolkit uses; injectable so tests need no HTTP. */
export type LinkedInAdsReadApi = Pick<
  typeof linkedInAdsService,
  'listAdAccounts' | 'listCampaignGroups' | 'listCampaigns' | 'listCreatives' | 'listTargetingFacets' | 'searchTargetingEntities'
  | 'getAudienceCount' | 'getAdAnalytics' | 'resolveTargetingCriteria'
>;

const NUMERIC_ID = /^\d{1,20}$/;
const URN_PREFIX: Record<'group' | 'campaign' | 'creative', string> = {
  group: 'urn:li:sponsoredCampaignGroup:',
  campaign: 'urn:li:sponsoredCampaign:',
  creative: 'urn:li:sponsoredCreative:',
};

/** A numeric id, or the matching urn:li:sponsored...: URN, as the bare numeric id. Anything else is refused. */
export function linkedInId(raw: unknown, kind: 'group' | 'campaign' | 'creative', field: string): string {
  const text = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw.trim() : '';
  const bare = text.startsWith(URN_PREFIX[kind]) ? text.slice(URN_PREFIX[kind].length) : text;
  if (!NUMERIC_ID.test(bare)) throw new MetaToolkitRefusal(`${field} must be a numeric LinkedIn id (from a LIST read) or its urn:li:sponsored...: URN.`);
  return bare;
}

function idList(raw: unknown, kind: 'group' | 'campaign' | 'creative', field: string, max = 50): string[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > max) throw new MetaToolkitRefusal(`${field} must be 1-${max} LinkedIn ids.`);
  return raw.map((v) => linkedInId(v, kind, field));
}

const FACET_URN = /^urn:li:adTargetingFacet:[A-Za-z0-9_]{1,60}$/;
const VALUE_URN = /^urn:li:[A-Za-z]{1,40}:[^\s"'<>\\]{1,120}$/;

/** targeting_include / targeting_exclude → the flat shape the service understands, validated. */
export function validateTargetingClauses(raw: unknown, field: string, opts: { required: boolean }): Array<{ facet_urn: string; values: string[] }> | undefined {
  if (raw === undefined) {
    if (opts.required) throw new MetaToolkitRefusal(`${field} is required (at least one facet).`);
    return undefined;
  }
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 20) throw new MetaToolkitRefusal(`${field} must be 1-20 facets.`);
  return raw.map((clause, i) => {
    const facet = clause?.facet_urn;
    const values = clause?.values;
    if (typeof facet !== 'string' || !FACET_URN.test(facet)) throw new MetaToolkitRefusal(`${field}[${i}].facet_urn must look like urn:li:adTargetingFacet:locations.`);
    if (!Array.isArray(values) || values.length === 0 || values.length > 200 || !values.every((v) => typeof v === 'string' && VALUE_URN.test(v))) {
      throw new MetaToolkitRefusal(`${field}[${i}].values must be 1-200 LinkedIn URNs (e.g. urn:li:geo:103644278).`);
    }
    return { facet_urn: facet, values: [...new Set(values as string[])] };
  });
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
function dateParts(raw: unknown, field: string) {
  const m = typeof raw === 'string' ? DATE.exec(raw) : null;
  const parts = m ? { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) } : null;
  const valid = parts && !Number.isNaN(Date.parse(`${raw}T00:00:00Z`)) && new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDate() === parts.day;
  if (!parts || !valid) throw new MetaToolkitRefusal(`${field} must be a real date, YYYY-MM-DD.`);
  return parts;
}

const FIELD_NAME = /^[A-Za-z][A-Za-z0-9]{0,60}$/;

/** Execute one linkedin_ads_read call against the resolved account. */
export async function executeLinkedInAdsRead(args: any, session: LinkedInAdsSession, api: LinkedInAdsReadApi = linkedInAdsService) {
  assertLinkedInAdsToolkitCall(LINKEDIN_ADS_READ_TOOL, args);
  const account = { success: true, account_id: session.accountId };

  /**
   * One LinkedIn read. A 403 "not configured to access the related advertiser account(s)" is returned
   * as a structured, per-endpoint "not enabled for this ad account yet" (never assumed away, never
   * pre-checked), a 429 as a structured rate_limited; any other failure is a refusal that says why.
   */
  const step = async <T extends LinkedInCallResult>(
    what: string, endpoint: string, call: (token: string) => Promise<T>,
  ): Promise<{ ok: true; result: T } | { ok: false; body: Record<string, unknown> }> => {
    const result = await callLinkedIn(session, call);
    if (result.success) return { ok: true, result };
    const kind = classifyLinkedInFailure(result);
    if (kind === 'not_enabled') return { ok: false, body: linkedInNotEnabledReadResult(endpoint) };
    if (kind === 'rate_limited') return { ok: false, body: linkedInRateLimitedResult(`the ${what} read`, false) };
    throw new MetaToolkitRefusal(`LinkedIn could not ${what}: ${redactLinkedInText(result.error || 'no details', [session.accessToken])}`);
  };

  const statuses = (): string | undefined => {
    if (args.status === undefined) return undefined;
    if (!Array.isArray(args.status) || args.status.length === 0 || !args.status.every((s: unknown) => (LIST_STATUSES as readonly string[]).includes(String(s)))) {
      throw new MetaToolkitRefusal(`status must be a list from ${LIST_STATUSES.join(', ')}.`);
    }
    return [...new Set<string>(args.status)].join(',');
  };

  switch (args.action) {
    case 'LIST_ACCOUNTS': {
      const r = await step('list ad accounts', 'ad accounts', (t) => api.listAdAccounts(t));
      if (!r.ok) return r.body;
      // Only the ad accounts this caller has connected: an org-shared connection's token also sees its owner's other accounts.
      const mine = new Set(session.connectedAccountIds ?? [session.accountId]);
      const data = (r.result.data?.elements ?? []).filter((a: any) => mine.has(String(a?.id).replace(/^urn:li:sponsoredAccount:/, '')));
      return { success: true, count: data.length, data };
    }
    case 'LIST_CAMPAIGN_GROUPS': {
      const status = statuses();
      const r = await step('list campaign groups', 'campaign groups', (t) => api.listCampaignGroups(t, session.accountId, status ? { status } : {}));
      if (!r.ok) return r.body;
      const data = r.result.data?.elements ?? [];
      return { ...account, count: data.length, data };
    }
    case 'LIST_CAMPAIGNS': {
      const status = statuses();
      const groupId = args.campaign_group_id === undefined ? undefined : linkedInId(args.campaign_group_id, 'group', 'campaign_group_id');
      const r = await step('list campaigns', 'campaigns', (t) => api.listCampaigns(t, session.accountId, { ...(groupId ? { campaign_group_id: groupId } : {}), ...(status ? { status } : {}) }));
      if (!r.ok) return r.body;
      const data = r.result.data?.elements ?? [];
      return { ...account, count: data.length, data };
    }
    case 'LIST_CREATIVES': {
      if (args.campaign_id === undefined) throw new MetaToolkitRefusal('campaign_id is required for LIST_CREATIVES.');
      const campaignId = linkedInId(args.campaign_id, 'campaign', 'campaign_id');
      const r = await step('list creatives', 'creatives', (t) => api.listCreatives(t, session.accountId, campaignId));
      if (!r.ok) return r.body;
      const data = r.result.data?.elements ?? [];
      return { ...account, count: data.length, data };
    }
    case 'LIST_TARGETING_FACETS': {
      const r = await step('list targeting facets', 'targeting facets', (t) => api.listTargetingFacets(t));
      if (!r.ok) return r.body;
      const data = r.result.data?.elements ?? [];
      return { success: true, count: data.length, data };
    }
    case 'SEARCH_TARGETING_ENTITIES': {
      if (typeof args.facet_urn !== 'string' || !FACET_URN.test(args.facet_urn)) throw new MetaToolkitRefusal('facet_urn is required, like urn:li:adTargetingFacet:locations.');
      if (args.query !== undefined && (typeof args.query !== 'string' || args.query.length > 100)) throw new MetaToolkitRefusal('query must be text of at most 100 characters.');
      if (args.locale_language !== undefined && !/^[a-z]{2}$/.test(String(args.locale_language))) throw new MetaToolkitRefusal('locale_language must be a two-letter code, e.g. en.');
      if (args.locale_country !== undefined && !/^[A-Z]{2}$/.test(String(args.locale_country))) throw new MetaToolkitRefusal('locale_country must be a two-letter code, e.g. US.');
      const r = await step('search targeting entities', 'targeting entities', (t) => api.searchTargetingEntities(t, {
        facet_urn: args.facet_urn, query: args.query, locale_language: args.locale_language, locale_country: args.locale_country,
      }));
      if (!r.ok) return r.body;
      const data = r.result.data?.elements ?? [];
      return { success: true, count: data.length, data };
    }
    case 'ESTIMATE_AUDIENCE': {
      const include = validateTargetingClauses(args.targeting_include, 'targeting_include', { required: true });
      const exclude = validateTargetingClauses(args.targeting_exclude, 'targeting_exclude', { required: false });
      const criteria = api.resolveTargetingCriteria({ targeting_include: include, targeting_exclude: exclude });
      const r = await step('estimate the audience', 'audience count', (t) => api.getAudienceCount(t, criteria));
      if (!r.ok) return r.body;
      return { success: true, audience: r.result.data };
    }
    case 'GET_ANALYTICS': {
      if (!(LINKEDIN_PIVOTS as readonly string[]).includes(String(args.pivot))) throw new MetaToolkitRefusal(`pivot must be one of ${LINKEDIN_PIVOTS.join(', ')}.`);
      const granularity = args.time_granularity === undefined ? 'ALL' : String(args.time_granularity);
      if (!(LINKEDIN_TIME_GRANULARITIES as readonly string[]).includes(granularity)) throw new MetaToolkitRefusal(`time_granularity must be one of ${LINKEDIN_TIME_GRANULARITIES.join(', ')}.`);
      const start = dateParts(args.start_date, 'start_date');
      const end = dateParts(args.end_date, 'end_date');
      if (Date.UTC(end.year, end.month - 1, end.day) < Date.UTC(start.year, start.month - 1, start.day)) throw new MetaToolkitRefusal('end_date must not be before start_date.');
      const fields = args.fields === undefined ? DEFAULT_ANALYTICS_FIELDS : args.fields;
      if (!Array.isArray(fields) || fields.length === 0 || fields.length > 40 || !fields.every((f) => typeof f === 'string' && FIELD_NAME.test(f))) {
        throw new MetaToolkitRefusal('fields must be 1-40 LinkedIn metric names (letters and digits).');
      }
      const filters = {
        campaign_group_ids: idList(args.campaign_group_ids, 'group', 'campaign_group_ids'),
        campaign_ids: idList(args.campaign_ids, 'campaign', 'campaign_ids'),
        creative_ids: idList(args.creative_ids, 'creative', 'creative_ids'),
      };
      const r = await step('fetch analytics', 'analytics', (t) => api.getAdAnalytics(t, session.accountId, args.pivot, granularity, { start, end }, fields, filters));
      if (!r.ok) return r.body;
      const data = r.result.data?.elements ?? r.result.data;
      return { ...account, pivot: args.pivot, time_granularity: granularity, start_date: args.start_date, end_date: args.end_date, data };
    }
    default:
      throw new MetaToolkitRefusal(`linkedin_ads_read action ${String(args.action)} is not supported.`);
  }
}
