/**
 * ENG-2920 (slice 1) — Zoma read-only Pages / Instagram / Ad Library tools for external agents.
 *
 *   ads_get_ad_account_pages     Pages the ad account can promote
 *   ads_get_pages_for_business   Pages owned by / shared with the ad account's Meta business
 *   ads_get_user_pages           Pages the connected Meta user manages (no page tokens returned)
 *   ads_get_ig_accounts          Instagram accounts usable by the ad account
 *   ads_get_ig_media             Recent media of one of those Instagram accounts
 *   ads_library_search           Public Meta Ad Library search
 *
 * Ownership: every id-addressed read is checked against the resolved (owned) ad account —
 * ig_account_id must be one of the account's Instagram accounts, and business pages are read
 * only for the account's own business. Reads only. `ads_boost_ig_post` (spend: preview + token,
 * created paused) is slice 2.
 */

import { MetaToolkitRefusal } from './metaToolkitErrors';

export const META_PAGES_TOOL_NAMES = [
  'ads_get_ad_account_pages',
  'ads_get_pages_for_business',
  'ads_get_user_pages',
  'ads_get_ig_accounts',
  'ads_get_ig_media',
  'ads_library_search',
] as const;
export type MetaPagesToolName = (typeof META_PAGES_TOOL_NAMES)[number];

export function isMetaPagesTool(name: string): name is MetaPagesToolName {
  return (META_PAGES_TOOL_NAMES as readonly string[]).includes(name);
}

const ACCOUNT_PROP = { account_id: { type: 'string', description: 'Optional Meta ad account id; defaults to the only connected account.' } };
const LIMIT_PROP = { limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Max rows (default 25, max 100).' } };

export const META_PAGES_TOOL_DEFINITIONS = [
  {
    name: 'ads_get_ad_account_pages',
    description: 'Read-only list of Facebook Pages the ad account can run ads for (use the page id as the ad identity).',
    inputSchema: { type: 'object', properties: { ...ACCOUNT_PROP, ...LIMIT_PROP }, additionalProperties: false },
  },
  {
    name: 'ads_get_pages_for_business',
    description: "Read-only list of Facebook Pages owned by or shared with the ad account's Meta business.",
    inputSchema: { type: 'object', properties: { ...ACCOUNT_PROP, ...LIMIT_PROP }, additionalProperties: false },
  },
  {
    name: 'ads_get_user_pages',
    description: 'Read-only list of Facebook Pages the connected Meta user manages, with their tasks. Page access tokens are never returned.',
    inputSchema: { type: 'object', properties: { ...ACCOUNT_PROP, ...LIMIT_PROP }, additionalProperties: false },
  },
  {
    name: 'ads_get_ig_accounts',
    description: 'Read-only list of Instagram accounts the ad account can use as an ad identity.',
    inputSchema: { type: 'object', properties: { ...ACCOUNT_PROP, ...LIMIT_PROP }, additionalProperties: false },
  },
  {
    name: 'ads_get_ig_media',
    description: 'Read-only list of recent posts of one Instagram account (from ads_get_ig_accounts): caption, media type, permalink, time and engagement counts.',
    inputSchema: {
      type: 'object',
      properties: { ...ACCOUNT_PROP, ig_account_id: { type: 'string', description: 'Numeric Instagram account id from ads_get_ig_accounts.' }, ...LIMIT_PROP },
      required: ['ig_account_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'ads_library_search',
    description: 'Search the public Meta Ad Library for ads by keyword or advertiser Page ids in given countries. Read-only; returns ad copy, page, and delivery dates.',
    inputSchema: {
      type: 'object',
      properties: {
        ...ACCOUNT_PROP,
        search_terms: { type: 'string', description: 'Keywords to search ad copy for.' },
        search_page_ids: { type: 'array', items: { type: 'string' }, maxItems: 10, description: 'Advertiser Page ids (up to 10).' },
        ad_reached_countries: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 10, description: 'ISO country codes, e.g. ["US"].' },
        ad_active_status: { type: 'string', enum: ['ACTIVE', 'INACTIVE', 'ALL'] },
        ...LIMIT_PROP,
      },
      required: ['ad_reached_countries'],
      additionalProperties: false,
    },
  },
];

export const PAGE_FIELDS = 'id,name,category,link,verification_status';
export const USER_PAGE_FIELDS = 'id,name,category,tasks';
export const IG_ACCOUNT_FIELDS = 'id,username,profile_pic';
export const IG_MEDIA_FIELDS = 'id,caption,media_type,permalink,timestamp,like_count,comments_count';
export const AD_LIBRARY_FIELDS = 'id,page_id,page_name,ad_creative_bodies,ad_creative_link_titles,ad_delivery_start_time,ad_delivery_stop_time,ad_snapshot_url,publisher_platforms';

/** The only Graph paths this module reads. */
export const PAGES_PATH_RE = /^(act_\d+(\/(promote_pages|instagram_accounts))?|\d+\/(owned_pages|client_pages|media)|me\/accounts|ads_archive)$/;

export interface MetaPagesDeps {
  /** Read-only Graph GET of an allow-listed path (PAGES_PATH_RE) with the account's own token. */
  readGraph: (userId: string, accountId: string, path: string, params: Record<string, string>) => Promise<any>;
}

/** Unverified: third-party guides say the Ad Library API needs the Facebook user to have confirmed their identity (facebook.com/ID). */
const AD_LIBRARY_ACCESS_HINT =
  ' Meta may require the connected Facebook account to have confirmed its identity at https://www.facebook.com/ID before it allows Ad Library searches.';

const defaultDeps: MetaPagesDeps = {
  readGraph: async (userId, accountId, path, params) => {
    const { agentModeService } = await import('../services/agentModeService');
    return agentModeService.readToolkitMetaPagesGraph(userId, accountId, path, params);
  },
};

function parseLimit(raw: unknown): string {
  if (raw === undefined) return '25';
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 100) throw new MetaToolkitRefusal('limit must be an integer between 1 and 100.');
  return String(n);
}

const rows = (res: any) => (Array.isArray(res?.data) ? res.data : []);
const truncation = (res: any, limit: string) => (res?.paging?.next ? { truncated: true, note: `Only the first ${limit} rows were read.` } : {});

function idList(raw: unknown, field: string, re: RegExp): string[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.some((v) => typeof v !== 'string' || !re.test(v))) throw new MetaToolkitRefusal(`${field} has an invalid value.`);
  return raw as string[];
}

export async function runMetaPagesTool(name: MetaPagesToolName, userId: string, accountId: string, args: any, deps: MetaPagesDeps = defaultDeps) {
  const read = async (path: string, params: Record<string, string>) => {
    if (!PAGES_PATH_RE.test(path)) throw new MetaToolkitRefusal('Unsupported Pages/Instagram read.');
    try {
      return await deps.readGraph(userId, accountId, path, params);
    } catch (error: any) {
      const meta = error?.metaError;
      const detail = String(meta?.message || error?.message || 'Meta request failed');
      // A refusal is not logged anywhere else, so a Meta rejection of the Ad Library read left no trace (ENG-2747).
      // Meta's error fields only: the raw axios error carries the access token and is never logged.
      if (path === 'ads_archive') {
        console.warn('[meta-toolkit] ads_library_search rejected by Meta', { code: meta?.code, subcode: meta?.error_subcode, message: detail.slice(0, 300) });
      }
      // Only Meta's "application does not have permission" (code 10) or an explicit identity message: a plain
      // missing-scope error ("Requires ads_read permission") is a different problem and gets no hint.
      const needsIdentity = path === 'ads_archive' && (meta?.code === 10 || /identity/i.test(detail));
      throw new MetaToolkitRefusal(`Could not read from Meta: ${detail}.${needsIdentity ? AD_LIBRARY_ACCESS_HINT : ''}`);
    }
  };
  const acct = `act_${String(accountId).replace(/^act_/, '')}`;
  const limit = parseLimit(args?.limit);

  switch (name) {
    case 'ads_get_ad_account_pages': {
      const res = await read(`${acct}/promote_pages`, { fields: PAGE_FIELDS, limit });
      return { account_id: accountId, pages: rows(res), ...truncation(res, limit) };
    }
    case 'ads_get_pages_for_business': {
      const account = await read(acct, { fields: 'business{id,name}' });
      const businessId = account?.business?.id ? String(account.business.id) : '';
      if (!/^\d+$/.test(businessId)) {
        return { account_id: accountId, pages: [], note: 'This ad account is not in a Meta Business portfolio, so it has no business-owned Pages.' };
      }
      const [owned, shared] = await Promise.all([
        read(`${businessId}/owned_pages`, { fields: PAGE_FIELDS, limit }),
        read(`${businessId}/client_pages`, { fields: PAGE_FIELDS, limit }),
      ]);
      const pages = new Map<string, any>();
      for (const [list, access] of [[owned, 'owned'], [shared, 'shared']] as const) {
        for (const p of rows(list)) if (p?.id && !pages.has(String(p.id))) pages.set(String(p.id), { ...p, access });
      }
      return { account_id: accountId, business_id: businessId, pages: [...pages.values()], ...(owned?.paging?.next || shared?.paging?.next ? { truncated: true } : {}) };
    }
    case 'ads_get_user_pages': {
      const res = await read('me/accounts', { fields: USER_PAGE_FIELDS, limit });
      // Defence in depth: me/accounts can carry page access tokens; never return them.
      const pages = rows(res).map(({ access_token: _t, ...p }: any) => p);
      return { account_id: accountId, pages, ...truncation(res, limit) };
    }
    case 'ads_get_ig_accounts': {
      const res = await read(`${acct}/instagram_accounts`, { fields: IG_ACCOUNT_FIELDS, limit });
      return { account_id: accountId, instagram_accounts: rows(res), ...truncation(res, limit) };
    }
    case 'ads_get_ig_media': {
      const igId = String(args?.ig_account_id ?? '');
      if (!/^\d+$/.test(igId)) throw new MetaToolkitRefusal('ig_account_id must be a numeric Instagram account id (see ads_get_ig_accounts).');
      const owned = await read(`${acct}/instagram_accounts`, { fields: 'id', limit: '100' });
      if (!rows(owned).some((a: any) => String(a?.id) === igId)) {
        throw new MetaToolkitRefusal(`Instagram account ${igId} is not available to this ad account.`);
      }
      const res = await read(`${igId}/media`, { fields: IG_MEDIA_FIELDS, limit });
      return { account_id: accountId, ig_account_id: igId, media: rows(res), ...truncation(res, limit) };
    }
    case 'ads_library_search': {
      const countries = idList(args?.ad_reached_countries, 'ad_reached_countries', /^[A-Z]{2}$/);
      if (!countries?.length) throw new MetaToolkitRefusal('ad_reached_countries must list at least one ISO country code, e.g. ["US"].');
      const pageIds = idList(args?.search_page_ids, 'search_page_ids', /^\d+$/);
      const terms = args?.search_terms === undefined ? '' : String(args.search_terms).trim();
      if (!terms && !pageIds?.length) throw new MetaToolkitRefusal('Provide search_terms or search_page_ids.');
      if (terms.length > 100) throw new MetaToolkitRefusal('search_terms must be at most 100 characters.');
      const status = args?.ad_active_status ?? 'ALL';
      if (!['ACTIVE', 'INACTIVE', 'ALL'].includes(status)) throw new MetaToolkitRefusal('ad_active_status must be ACTIVE, INACTIVE or ALL.');
      const params: Record<string, string> = {
        fields: AD_LIBRARY_FIELDS,
        ad_reached_countries: JSON.stringify(countries),
        ad_active_status: status,
        limit,
      };
      if (terms) params.search_terms = terms;
      if (pageIds?.length) params.search_page_ids = JSON.stringify(pageIds);
      const res = await read('ads_archive', params);
      return { ads: rows(res), ...truncation(res, limit) };
    }
  }
}
