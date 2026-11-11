/**
 * ENG-2918 (slice 1) — Zoma read-only product catalog tools for external agents.
 *
 *   meta_list_catalogs        catalogs of the ad account's business (owned + client-shared)
 *   meta_list_products        products of one catalog
 *   meta_list_product_sets    product sets of one catalog
 *   meta_list_product_feeds   feeds of one catalog (with last upload status)
 *
 * Ownership: catalogs are business-owned, not ad-account-owned, and catalog ids are global.
 * Every catalog-level read first lists the catalogs of the resolved (owned) ad account's
 * business and refuses any catalog_id outside that set, so a caller cannot read a foreign
 * catalog by guessing its id. Reads only: no preview, no write gate, no storage. Writes
 * (create/update/delete, feeds, rules, event sources) are later slices.
 */

import { MetaToolkitRefusal } from './metaToolkitErrors';

export const META_CATALOG_TOOL_NAMES = ['meta_list_catalogs', 'meta_list_products', 'meta_list_product_sets', 'meta_list_product_feeds'] as const;
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
];

export const CATALOG_FIELDS = 'id,name,product_count,vertical';
export const PRODUCT_FIELDS = 'id,retailer_id,name,price,currency,availability,review_status,url';
export const PRODUCT_SET_FIELDS = 'id,name,filter,product_count';
export const FEED_FIELDS = 'id,name,schedule,product_count,latest_upload{id,start_time,end_time,error_count,warning_count}';

/** The only Graph paths this module reads: the account node or a numeric node's catalog edge. */
export const CATALOG_PATH_RE = /^(act_\d+|\d+\/(owned_product_catalogs|client_product_catalogs|products|product_sets|product_feeds))$/;

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

export async function runMetaCatalogTool(name: MetaCatalogToolName, userId: string, accountId: string, args: any, deps: MetaCatalogDeps = defaultDeps) {
  const read = async (path: string, params: Record<string, string>) => {
    if (!CATALOG_PATH_RE.test(path)) throw new MetaToolkitRefusal('Unsupported catalog read.');
    try {
      return await deps.readGraph(userId, accountId, path, params);
    } catch (error: any) {
      throw new MetaToolkitRefusal(`Could not read catalogs from Meta: ${error?.metaError?.message || error?.message || 'Meta request failed'}.`);
    }
  };
  const acct = `act_${String(accountId).replace(/^act_/, '')}`;

  const account = await read(acct, { fields: 'business{id,name}' });
  const businessId = account?.business?.id ? String(account.business.id) : '';
  if (!/^\d+$/.test(businessId)) {
    if (name === 'meta_list_catalogs') {
      return { account_id: accountId, catalogs: [], note: 'This ad account is not in a Meta Business portfolio, so it has no product catalogs. Catalogs require Meta Business Manager.' };
    }
    throw new MetaToolkitRefusal('This ad account is not in a Meta Business portfolio, so it has no product catalogs.');
  }
  const catalogParams = { fields: CATALOG_FIELDS, limit: '100' };
  const [owned, shared] = await Promise.all([
    read(`${businessId}/owned_product_catalogs`, catalogParams),
    read(`${businessId}/client_product_catalogs`, catalogParams),
  ]);
  const catalogs = new Map<string, any>();
  for (const [list, access] of [[owned, 'owned'], [shared, 'shared']] as const) {
    for (const c of Array.isArray(list?.data) ? list.data : []) {
      const id = String(c?.id ?? '');
      if (id && !catalogs.has(id)) catalogs.set(id, { catalog_id: id, name: c?.name, product_count: c?.product_count, vertical: c?.vertical, access });
    }
  }

  if (name === 'meta_list_catalogs') {
    return { account_id: accountId, business_id: businessId, catalogs: [...catalogs.values()] };
  }

  const catalogId = String(args?.catalog_id ?? '');
  if (!/^\d+$/.test(catalogId)) throw new MetaToolkitRefusal('catalog_id must be a numeric Meta catalog id (see meta_list_catalogs).');
  if (!catalogs.has(catalogId)) throw new MetaToolkitRefusal(`Catalog ${catalogId} is not available to this ad account's business.`);
  const limit = parseLimit(args?.limit);
  const edge = name === 'meta_list_products' ? 'products' : name === 'meta_list_product_sets' ? 'product_sets' : 'product_feeds';
  const fields = edge === 'products' ? PRODUCT_FIELDS : edge === 'product_sets' ? PRODUCT_SET_FIELDS : FEED_FIELDS;
  const res = await read(`${catalogId}/${edge}`, { fields, limit });
  const data = Array.isArray(res?.data) ? res.data : [];
  return { account_id: accountId, catalog_id: catalogId, [edge]: data, ...(res?.paging?.next ? { truncated: true, note: `Only the first ${limit} rows were read.` } : {}) };
}
