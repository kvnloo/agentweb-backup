/**
 * ENG-2918 (slice 1) — Zoma read-only product catalog tools for external agents.
 *
 *   meta_list_catalogs        catalogs of the ad account's business (owned + client-shared)
 *   meta_list_products        products of one catalog
 *   meta_list_product_sets    product sets of one catalog
 *   meta_list_product_feeds   feeds of one catalog (with last upload status)
 *
 * ENG-2924 (slice 2) adds catalog health reads on the same ownership-checked path:
 *   meta_list_dpa_eligible_catalogs  catalogs that can run Advantage+ catalog ads (products + a set)
 *   meta_get_catalog_diagnostics     Meta's catalog diagnostics (errors/warnings by type)
 *   meta_get_dynamic_ads_health      one-call readiness summary (products, sets, feeds, events)
 *   meta_get_catalog_data_sources    feeds + connected pixel/app event sources of a catalog
 *
 * Ownership: catalogs are business-owned, not ad-account-owned, and catalog ids are global.
 * Every catalog-level read first lists the catalogs of the resolved (owned) ad account's
 * business and refuses any catalog_id outside that set, so a caller cannot read a foreign
 * catalog by guessing its id. Reads only: no preview, no write gate, no storage. Product and
 * product-set writes are metaToolkitCatalogWrites.ts (ENG-2925); feeds, rules and event
 * sources are later slices.
 */

import { MetaToolkitRefusal } from './metaToolkitErrors';

export const META_CATALOG_TOOL_NAMES = [
  'meta_list_catalogs', 'meta_list_products', 'meta_list_product_sets', 'meta_list_product_feeds',
  'meta_list_dpa_eligible_catalogs', 'meta_get_catalog_diagnostics', 'meta_get_dynamic_ads_health', 'meta_get_catalog_data_sources',
] as const;
export type MetaCatalogToolName = (typeof META_CATALOG_TOOL_NAMES)[number];

export function isMetaCatalogTool(name: string): name is MetaCatalogToolName {
  return (META_CATALOG_TOOL_NAMES as readonly string[]).includes(name);
}

const ACCOUNT_PROP = { account_id: { type: 'string', description: 'Optional Meta ad account id; defaults to the only connected account.' } };
const CATALOG_PROP = { catalog_id: { type: 'string', description: 'Numeric product catalog id (from meta_list_catalogs).' } };
const LIMIT_PROP = { limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Max rows (default 25, max 100).' } };

export const META_CATALOG_TOOL_DEFINITIONS = [
  {
    name: 'meta_list_catalogs',
    description:
      'Read-only list of the product catalogs available to the ad account (owned by or shared with its Meta business), with product count and vertical. ' +
      'Use the catalog id with meta_list_products / meta_list_product_sets / meta_list_product_feeds, and for Advantage+ catalog (dynamic product) ads.',
    inputSchema: { type: 'object', properties: { ...ACCOUNT_PROP }, additionalProperties: false },
  },
  {
    name: 'meta_list_products',
    description: 'Read-only list of products in one catalog: retailer id, name, price, availability and review status (rejected products do not deliver).',
    inputSchema: { type: 'object', properties: { ...ACCOUNT_PROP, ...CATALOG_PROP, ...LIMIT_PROP }, required: ['catalog_id'], additionalProperties: false },
  },
  {
    name: 'meta_list_product_sets',
    description: 'Read-only list of product sets in one catalog with their filter and product count. Advantage+ catalog ads target a product set.',
    inputSchema: { type: 'object', properties: { ...ACCOUNT_PROP, ...CATALOG_PROP, ...LIMIT_PROP }, required: ['catalog_id'], additionalProperties: false },
  },
  {
    name: 'meta_list_product_feeds',
    description: 'Read-only list of data feeds in one catalog: schedule, product count and the latest upload (time, errors, warnings). Use to explain stale or missing products.',
    inputSchema: { type: 'object', properties: { ...ACCOUNT_PROP, ...CATALOG_PROP, ...LIMIT_PROP }, required: ['catalog_id'], additionalProperties: false },
  },
  {
    name: 'meta_list_dpa_eligible_catalogs',
    description:
      'Read-only list of the account\'s catalogs that can run Advantage+ catalog (dynamic product) ads now: at least one product and at least one product set. ' +
      'Ineligible catalogs are returned separately with the reason.',
    inputSchema: { type: 'object', properties: { ...ACCOUNT_PROP }, additionalProperties: false },
  },
  {
    name: 'meta_get_catalog_diagnostics',
    description: 'Read-only Meta diagnostics for one catalog: issue type, severity, affected product count and how to fix. Use to explain rejected or non-delivering products.',
    inputSchema: { type: 'object', properties: { ...ACCOUNT_PROP, ...CATALOG_PROP, ...LIMIT_PROP }, required: ['catalog_id'], additionalProperties: false },
  },
  {
    name: 'meta_get_dynamic_ads_health',
    description:
      'Read-only readiness summary for Advantage+ catalog ads on one catalog: product count, product sets, feed upload errors, connected event sources and diagnostics, ' +
      'with a ready flag and a list of blocking issues.',
    inputSchema: { type: 'object', properties: { ...ACCOUNT_PROP, ...CATALOG_PROP }, required: ['catalog_id'], additionalProperties: false },
  },
  {
    name: 'meta_get_catalog_data_sources',
    description: 'Read-only list of one catalog\'s data sources: product feeds (schedule, latest upload) and connected pixel/app event sources used for retargeting.',
    inputSchema: { type: 'object', properties: { ...ACCOUNT_PROP, ...CATALOG_PROP }, required: ['catalog_id'], additionalProperties: false },
  },
];

export const CATALOG_FIELDS = 'id,name,product_count,vertical';
export const PRODUCT_FIELDS = 'id,retailer_id,name,price,currency,availability,review_status,url';
export const PRODUCT_SET_FIELDS = 'id,name,filter,product_count';
export const FEED_FIELDS = 'id,name,schedule,product_count,latest_upload{id,start_time,end_time,error_count,warning_count}';
export const DIAGNOSTIC_FIELDS = 'type,severity,title,diagnostics,number_of_affected_items,call_to_action';
export const EVENT_SOURCE_FIELDS = 'id,name';

/** The only Graph paths this module reads: the account node or a numeric node's catalog edge. */
export const CATALOG_PATH_RE = /^(act_\d+|\d+\/(owned_product_catalogs|client_product_catalogs|products|product_sets|product_feeds|diagnostics|external_event_sources))$/;

export interface MetaCatalogDeps {
  /** Read-only Graph GET of an allow-listed path (CATALOG_PATH_RE) with the account's own token. */
  readGraph: (userId: string, accountId: string, path: string, params: Record<string, string>) => Promise<any>;
}

const defaultDeps: MetaCatalogDeps = {
  readGraph: async (userId, accountId, path, params) => {
    const { agentModeService } = await import('../services/agentModeService');
    return agentModeService.readToolkitMetaCatalogGraph(userId, accountId, path, params);
  },
};

function parseLimit(raw: unknown): string {
  if (raw === undefined) return '25';
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 100) throw new MetaToolkitRefusal('limit must be an integer between 1 and 100.');
  return String(n);
}

/**
 * The catalogs of the ad account's business (owned + client-shared), deduped. This is the
 * ownership set: every catalog-level read or write (ENG-2925) refuses a catalog outside it.
 * businessId is '' when the account is not in a Business portfolio (then catalogs is empty).
 */
export async function readBusinessCatalogs(
  read: (path: string, params: Record<string, string>) => Promise<any>, accountId: string,
): Promise<{ businessId: string; catalogs: Map<string, any> }> {
  const account = await read(`act_${String(accountId).replace(/^act_/, '')}`, { fields: 'business{id,name}' });
  const businessId = account?.business?.id ? String(account.business.id) : '';
  const catalogs = new Map<string, any>();
  if (!/^\d+$/.test(businessId)) return { businessId: '', catalogs };
  const catalogParams = { fields: CATALOG_FIELDS, limit: '100' };
  const [owned, shared] = await Promise.all([
    read(`${businessId}/owned_product_catalogs`, catalogParams),
    read(`${businessId}/client_product_catalogs`, catalogParams),
  ]);
  for (const [list, access] of [[owned, 'owned'], [shared, 'shared']] as const) {
    for (const c of Array.isArray(list?.data) ? list.data : []) {
      const id = String(c?.id ?? '');
      if (id && !catalogs.has(id)) catalogs.set(id, { catalog_id: id, name: c?.name, product_count: c?.product_count, vertical: c?.vertical, access });
    }
  }
  return { businessId, catalogs };
}

export async function runMetaCatalogTool(name: MetaCatalogToolName, userId: string, accountId: string, args: any, deps: MetaCatalogDeps = defaultDeps) {
  const read = async (path: string, params: Record<string, string>) => {
    if (!CATALOG_PATH_RE.test(path)) throw new MetaToolkitRefusal('Unsupported catalog read.');
    try {
      return await deps.readGraph(userId, accountId, path, params);
    } catch (error: any) {
      throw new MetaToolkitRefusal(`Could not read catalogs from Meta: ${error?.metaError?.message || error?.message || 'Meta request failed'}.`);
    }
  };
  const { businessId, catalogs } = await readBusinessCatalogs(read, accountId);
  if (!businessId) {
    if (name === 'meta_list_catalogs') {
      return { account_id: accountId, catalogs: [], note: 'This ad account is not in a Meta Business portfolio, so it has no product catalogs. Catalogs require Meta Business Manager.' };
    }
    throw new MetaToolkitRefusal('This ad account is not in a Meta Business portfolio, so it has no product catalogs.');
  }

  if (name === 'meta_list_catalogs') {
    return { account_id: accountId, business_id: businessId, catalogs: [...catalogs.values()] };
  }

  if (name === 'meta_list_dpa_eligible_catalogs') {
    const eligible: any[] = [];
    const ineligible: any[] = [];
    for (const c of catalogs.values()) {
      if (!(Number(c.product_count) > 0)) { ineligible.push({ ...c, reason: 'Catalog has no products.' }); continue; }
      const sets = await read(`${c.catalog_id}/product_sets`, { fields: 'id', limit: '1' });
      if (Array.isArray(sets?.data) && sets.data.length > 0) eligible.push(c);
      else ineligible.push({ ...c, reason: 'Catalog has no product set; Advantage+ catalog ads target a product set.' });
    }
    return { account_id: accountId, business_id: businessId, eligible, ineligible };
  }

  const catalogId = String(args?.catalog_id ?? '');
  if (!/^\d+$/.test(catalogId)) throw new MetaToolkitRefusal('catalog_id must be a numeric Meta catalog id (see meta_list_catalogs).');
  if (!catalogs.has(catalogId)) throw new MetaToolkitRefusal(`Catalog ${catalogId} is not available to this ad account's business.`);
  if (name === 'meta_get_catalog_diagnostics') {
    const limit = parseLimit(args?.limit);
    const res = await read(`${catalogId}/diagnostics`, { fields: DIAGNOSTIC_FIELDS, limit });
    return { account_id: accountId, catalog_id: catalogId, diagnostics: Array.isArray(res?.data) ? res.data : [] };
  }

  if (name === 'meta_get_catalog_data_sources') {
    const [feeds, events] = await Promise.all([
      read(`${catalogId}/product_feeds`, { fields: FEED_FIELDS, limit: '100' }),
      read(`${catalogId}/external_event_sources`, { fields: EVENT_SOURCE_FIELDS, limit: '100' }),
    ]);
    return {
      account_id: accountId, catalog_id: catalogId,
      product_feeds: Array.isArray(feeds?.data) ? feeds.data : [],
      event_sources: Array.isArray(events?.data) ? events.data : [],
    };
  }

  if (name === 'meta_get_dynamic_ads_health') {
    const [sets, feeds, events, diags] = await Promise.all([
      read(`${catalogId}/product_sets`, { fields: PRODUCT_SET_FIELDS, limit: '100' }),
      read(`${catalogId}/product_feeds`, { fields: FEED_FIELDS, limit: '100' }),
      read(`${catalogId}/external_event_sources`, { fields: EVENT_SOURCE_FIELDS, limit: '100' }),
      read(`${catalogId}/diagnostics`, { fields: DIAGNOSTIC_FIELDS, limit: '100' }),
    ]);
    const list = (r: any) => (Array.isArray(r?.data) ? r.data : []);
    const productCount = Number(catalogs.get(catalogId)?.product_count) || 0;
    const feedErrors = list(feeds).filter((f: any) => Number(f?.latest_upload?.error_count) > 0).map((f: any) => ({ feed_id: f.id, name: f.name, error_count: Number(f.latest_upload.error_count) }));
    const errorDiagnostics = list(diags).filter((d: any) => String(d?.severity ?? '').toUpperCase() === 'MUST_FIX');
    const blocking: string[] = [];
    if (productCount === 0) blocking.push('Catalog has no products.');
    if (list(sets).length === 0) blocking.push('Catalog has no product set.');
    const warnings: string[] = [];
    if (list(events).length === 0) warnings.push('No pixel or app event source is connected; retargeting audiences cannot be built from this catalog.');
    if (feedErrors.length) warnings.push(`${feedErrors.length} feed(s) had errors on their latest upload.`);
    if (errorDiagnostics.length) warnings.push(`${errorDiagnostics.length} must-fix diagnostic(s) reported by Meta.`);
    return {
      account_id: accountId, catalog_id: catalogId, ready: blocking.length === 0,
      product_count: productCount, product_set_count: list(sets).length, feed_count: list(feeds).length,
      event_source_count: list(events).length, feed_errors: feedErrors, must_fix_diagnostics: errorDiagnostics,
      blocking_issues: blocking, warnings,
    };
  }

  const limit = parseLimit(args?.limit);
  const edge = name === 'meta_list_products' ? 'products' : name === 'meta_list_product_sets' ? 'product_sets' : 'product_feeds';
  const fields = edge === 'products' ? PRODUCT_FIELDS : edge === 'product_sets' ? PRODUCT_SET_FIELDS : FEED_FIELDS;
  const res = await read(`${catalogId}/${edge}`, { fields, limit });
  const data = Array.isArray(res?.data) ? res.data : [];
  return { account_id: accountId, catalog_id: catalogId, [edge]: data, ...(res?.paging?.next ? { truncated: true, note: `Only the first ${limit} rows were read.` } : {}) };
}
