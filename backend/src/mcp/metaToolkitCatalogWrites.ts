/**
 * ENG-2925 (catalog slice 3) — Zoma product + product-set writes for external agents.
 *
 *   meta_product_create         create one product in a catalog
 *   meta_update_product         change fields of one product (retailer_id is immutable)
 *   meta_delete_product         delete one product            (preview → confirm)
 *   meta_get_suggested_filter   READ: build a product-set filter from simple criteria and
 *                               show which products it matches (nothing is written)
 *   meta_product_set_create     create a product set (name + filter) in a catalog
 *   meta_product_set_update     change a product set's name and/or filter
 *   meta_product_set_delete     delete a product set          (preview → confirm)
 *
 * Ownership: catalog ids are global, so every catalog id must be in the account business's
 * catalog set (readBusinessCatalogs, the same set the ENG-2918 reads enforce). A product or
 * product-set id is resolved to its parent catalog by reading the node, and that catalog must
 * be in the set too; a caller cannot touch a foreign product by guessing its id.
 *
 * Deletes use the shared Zoma guard (zomaWriteGuard): the first call returns a PREVIEW and a
 * single-use preview_token bound to the user, the target and its current state; the confirm
 * must repeat the call with that token. A product set used by an ACTIVE ad set of the account
 * (promoted_object.product_set_id) is refused unless confirm_in_use=true, which is itself bound
 * into the token. Creates and updates cannot spend and are applied directly.
 *
 * Every write is read back independently; result.verification (CONFIRMED / MISMATCH /
 * UNCONFIRMED) is what the gateway's write metering keys on. Only CONFIRMED is success.
 * No storage: tokens are single-use per process, like the other Zoma writes.
 */
import { getJwtSecret } from '../config/jwt';
import { MetaToolkitRefusal } from './metaToolkitErrors';
import { readBusinessCatalogs } from './metaToolkitCatalogs';
import { targetingApplied } from './metaToolkitWrites';
import {
  consumeToken, defaultConsumedTokenStore, type ConsumedTokens, previewFingerprint, previewResponse, previewTokenMatches,
  rememberTokenOutcome, replayTokenOutcome, type WriteVerification,
} from './zomaWriteGuard';

export const META_CATALOG_WRITE_TOOL_NAMES = [
  'meta_product_create', 'meta_update_product', 'meta_delete_product', 'meta_get_suggested_filter',
  'meta_product_set_create', 'meta_product_set_update', 'meta_product_set_delete',
] as const;
export type MetaCatalogWriteToolName = (typeof META_CATALOG_WRITE_TOOL_NAMES)[number];

/** Routed by this module (includes the one read, meta_get_suggested_filter). */
export function isMetaCatalogWriteTool(name: string): name is MetaCatalogWriteToolName {
  return (META_CATALOG_WRITE_TOOL_NAMES as readonly string[]).includes(name);
}

/** Entity + action of each tool that changes Meta state (write scope + write metering). */
export const CATALOG_WRITE_KIND: Partial<Record<MetaCatalogWriteToolName, { entityType: 'PRODUCT' | 'PRODUCT_SET'; action: 'CREATE' | 'UPDATE' | 'DELETE' }>> = {
  meta_product_create: { entityType: 'PRODUCT', action: 'CREATE' },
  meta_update_product: { entityType: 'PRODUCT', action: 'UPDATE' },
  meta_delete_product: { entityType: 'PRODUCT', action: 'DELETE' },
  meta_product_set_create: { entityType: 'PRODUCT_SET', action: 'CREATE' },
  meta_product_set_update: { entityType: 'PRODUCT_SET', action: 'UPDATE' },
  meta_product_set_delete: { entityType: 'PRODUCT_SET', action: 'DELETE' },
};

/** True for the tools that change Meta state; they need the write scope. */
export function isMetaCatalogWrite(name: string): boolean {
  return isMetaCatalogWriteTool(name) && CATALOG_WRITE_KIND[name] !== undefined;
}

const AVAILABILITY = ['in stock', 'out of stock', 'preorder', 'available for order', 'discontinued'];
const CONDITION = ['new', 'refurbished', 'used'];
const PRODUCT_FIELDS = ['retailer_id', 'name', 'description', 'price', 'currency', 'availability', 'condition', 'url', 'image_url', 'brand'] as const;
const PRODUCT_REQUIRED = ['retailer_id', 'name', 'price', 'currency', 'url', 'image_url'];
/** Fields compared on read-back. price is reformatted by Meta and image_url is re-hosted, so they are not. */
const PRODUCT_VERIFIED = ['retailer_id', 'name', 'description', 'availability', 'condition', 'url', 'brand', 'currency'];
const PRODUCT_READ_FIELDS = 'id,retailer_id,name,description,price,currency,availability,condition,url,image_url,brand,product_catalog{id}';
const SET_READ_FIELDS = 'id,name,filter,product_count,product_catalog{id}';
const IN_USE_SCAN_LIMIT = '500';

const ACCOUNT_PROP = { account_id: { type: 'string', description: 'Optional Meta ad account id; defaults to the only connected account.' } };
const CATALOG_PROP = { catalog_id: { type: 'string', description: 'Numeric product catalog id (from meta_list_catalogs).' } };
const PRODUCT_ID_PROP = { product_id: { type: 'string', description: 'Numeric Meta product id (the id from meta_list_products, not the retailer_id).' } };
const SET_ID_PROP = { product_set_id: { type: 'string', description: 'Numeric product set id (from meta_list_product_sets).' } };
const FILTER_PROP = {
  filter: {
    type: 'object',
    description: 'Meta product set filter, e.g. {"retailer_id":{"is_any":["sku1","sku2"]}} or {"and":[{"brand":{"i_contains":"acme"}},{"availability":{"eq":"in stock"}}]}. ' +
      'Use meta_get_suggested_filter to build one and see what it matches.',
  },
};
const CONFIRM_PROPS = {
  confirm: { type: 'boolean', description: 'Omit to get a PREVIEW (nothing changes). Set true only after the user explicitly approved that preview, together with its preview_token.' },
  preview_token: { type: 'string', description: 'The preview_token of the preview the user approved. Single use, 15 minutes; repeat the previewed arguments exactly.' },
};
const PRODUCT_PROPS = {
  retailer_id: { type: 'string', description: 'Your SKU / content id; must be unique in the catalog.' },
  name: { type: 'string' },
  description: { type: 'string' },
  price: { type: 'integer', minimum: 0, description: 'Price in MINOR units of currency (e.g. 1299 = $12.99).' },
  currency: { type: 'string', description: 'ISO 4217 code, e.g. USD.' },
  availability: { type: 'string', enum: AVAILABILITY },
  condition: { type: 'string', enum: CONDITION },
  url: { type: 'string', description: 'Product page URL (http/https).' },
  image_url: { type: 'string', description: 'Main product image URL (http/https).' },
  brand: { type: 'string' },
};
const { retailer_id: _immutableRetailerId, ...PRODUCT_UPDATE_PROPS } = PRODUCT_PROPS;

export const META_CATALOG_WRITE_TOOL_DEFINITIONS = [
  {
    name: 'meta_product_create',
    description: 'Create one product in a catalog the ad account\'s business can use. Applied directly (a product cannot spend) and verified by read-back; done only when verification is CONFIRMED.',
    inputSchema: { type: 'object', properties: { ...ACCOUNT_PROP, ...CATALOG_PROP, ...PRODUCT_PROPS }, required: ['catalog_id', ...PRODUCT_REQUIRED], additionalProperties: false },
  },
  {
    name: 'meta_update_product',
    description: 'Change fields of one product (name, description, price, currency, availability, condition, url, image_url, brand). retailer_id cannot be changed. Verified by read-back.',
    inputSchema: { type: 'object', properties: { ...ACCOUNT_PROP, ...PRODUCT_ID_PROP, ...PRODUCT_UPDATE_PROPS }, required: ['product_id'], additionalProperties: false },
  },
  {
    name: 'meta_delete_product',
    description: 'Delete one product. Two calls: first without confirm returns a PREVIEW and preview_token (nothing changes); after the user approves, repeat with confirm=true and the token.',
    inputSchema: { type: 'object', properties: { ...ACCOUNT_PROP, ...PRODUCT_ID_PROP, ...CONFIRM_PROPS }, required: ['product_id'], additionalProperties: false },
  },
  {
    name: 'meta_get_suggested_filter',
    description: 'Read-only. Build a product set filter from simple criteria (retailer ids, brand, availability, product type, name, price range in minor units) and list sample products it matches. Nothing is written; pass the filter to meta_product_set_create.',
    inputSchema: {
      type: 'object',
      properties: {
        ...ACCOUNT_PROP, ...CATALOG_PROP,
        retailer_ids: { type: 'array', items: { type: 'string' }, maxItems: 500 },
        brand: { type: 'string', description: 'Brand contains (case-insensitive).' },
        availability: { type: 'string', enum: AVAILABILITY },
        product_type: { type: 'string', description: 'Product type contains (case-insensitive).' },
        name_contains: { type: 'string' },
        price_min: { type: 'integer', minimum: 0, description: 'Minimum price, minor units.' },
        price_max: { type: 'integer', minimum: 0, description: 'Maximum price, minor units.' },
      },
      required: ['catalog_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'meta_product_set_create',
    description: 'Create a product set (name + filter) in a catalog the ad account\'s business can use. Advantage+ catalog ads target a product set. Verified by read-back.',
    inputSchema: { type: 'object', properties: { ...ACCOUNT_PROP, ...CATALOG_PROP, name: { type: 'string' }, ...FILTER_PROP }, required: ['catalog_id', 'name', 'filter'], additionalProperties: false },
  },
  {
    name: 'meta_product_set_update',
    description: 'Change a product set\'s name and/or filter. A new filter replaces the old one and changes which products running ads can show. Verified by read-back.',
    inputSchema: { type: 'object', properties: { ...ACCOUNT_PROP, ...SET_ID_PROP, name: { type: 'string' }, ...FILTER_PROP }, required: ['product_set_id'], additionalProperties: false },
  },
  {
    name: 'meta_product_set_delete',
    description: 'Delete a product set. Two calls (PREVIEW + preview_token, then confirm=true with the token). Refused while an ACTIVE ad set of this account promotes the set, unless confirm_in_use=true (those ad sets will stop delivering).',
    inputSchema: {
      type: 'object',
      properties: {
        ...ACCOUNT_PROP, ...SET_ID_PROP, ...CONFIRM_PROPS,
        confirm_in_use: { type: 'boolean', description: 'Delete even though ACTIVE ad sets of this account use the set. Only after the user explicitly accepted that those ad sets stop delivering.' },
      },
      required: ['product_set_id'],
      additionalProperties: false,
    },
  },
];

/** Graph paths this module reads (account, business catalogs, a node, the account's ad sets). */
const READ_PATH_RE = /^(act_\d+(\/adsets)?|\d+(\/(owned_product_catalogs|client_product_catalogs|products))?)$/;
const POST_PATH_RE = /^\d+(\/(products|product_sets))?$/;
const DELETE_PATH_RE = /^\d+$/;

export interface MetaCatalogWriteDeps {
  /** Graph GET with the account's own token (agentModeService.readToolkitMetaCatalogGraph). */
  readGraph: (userId: string, accountId: string, path: string, params: Record<string, string>) => Promise<any>;
  /** Graph POST/DELETE with the account's own token (agentModeService.writeToolkitMetaCatalogGraph). */
  writeGraph: (userId: string, accountId: string, method: 'POST' | 'DELETE', path: string, params: Record<string, string>) => Promise<any>;
  secret: () => string;
  now: () => number;
  consumedTokens: ConsumedTokens;
  tokenOutcomes: Map<string, { exp: number; outcome: any }>;
}

const ams = async () => (await import('../services/agentModeService')).agentModeService;

const defaultDeps: MetaCatalogWriteDeps = {
  readGraph: async (userId, accountId, path, params) => (await ams()).readToolkitMetaCatalogGraph(userId, accountId, path, params),
  writeGraph: async (userId, accountId, method, path, params) => (await ams()).writeToolkitMetaCatalogGraph(userId, accountId, method, path, params),
  secret: () => getJwtSecret(),
  now: () => Date.now(),
  consumedTokens: defaultConsumedTokenStore,
  tokenOutcomes: new Map(),
};

const metaMessage = (error: any) => String(error?.metaError?.message || error?.message || 'Meta request failed');
const isNotFound = (error: any) => Number(error?.metaError?.code) === 100;
const numericId = (v: unknown) => /^\d+$/.test(String(v ?? ''));

function assertOnlyKeys(args: any, allowed: string[]) {
  const extra = Object.keys(args).filter((k) => args[k] !== undefined && !allowed.includes(k));
  if (extra.length) throw new MetaToolkitRefusal(`Not allowed: ${extra.join(', ')}. Allowed: ${allowed.join(', ')}.`);
}

/** Validates product fields and returns them as Graph form params. */
function productParams(args: any, creating: boolean): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of PRODUCT_FIELDS) {
    const v = args[f];
    if (v === undefined) continue;
    if (f === 'retailer_id' && !creating) throw new MetaToolkitRefusal('retailer_id cannot be changed. Create a new product instead.');
    if (f === 'price') {
      if (!Number.isSafeInteger(v) || v < 0) throw new MetaToolkitRefusal('price must be a non-negative integer in minor units (e.g. 1299 = $12.99).');
      out.price = String(v);
      continue;
    }
    if (typeof v !== 'string' || !v.trim()) throw new MetaToolkitRefusal(`${f} must be a non-empty string.`);
    if (f === 'currency' && !/^[A-Z]{3}$/.test(v)) throw new MetaToolkitRefusal('currency must be a 3-letter ISO 4217 code, e.g. USD.');
    if (f === 'availability' && !AVAILABILITY.includes(v)) throw new MetaToolkitRefusal(`availability must be one of: ${AVAILABILITY.join(', ')}.`);
    if (f === 'condition' && !CONDITION.includes(v)) throw new MetaToolkitRefusal(`condition must be one of: ${CONDITION.join(', ')}.`);
    if ((f === 'url' || f === 'image_url') && !/^https?:\/\/\S+$/i.test(v)) throw new MetaToolkitRefusal(`${f} must be an http(s) URL.`);
    out[f] = v;
  }
  if (creating) {
    const missing = PRODUCT_REQUIRED.filter((f) => out[f] === undefined);
    if (missing.length) throw new MetaToolkitRefusal(`meta_product_create requires: ${missing.join(', ')}.`);
  } else if (Object.keys(out).length === 0) {
    throw new MetaToolkitRefusal('Nothing to change: pass at least one product field.');
  }
  return out;
}

function validFilter(filter: unknown): Record<string, unknown> {
  if (!filter || typeof filter !== 'object' || Array.isArray(filter) || Object.keys(filter).length === 0) {
    throw new MetaToolkitRefusal('filter must be a non-empty Meta product set filter object (see meta_get_suggested_filter).');
  }
  return filter as Record<string, unknown>;
}

function setParams(args: any, creating: boolean): Record<string, string> {
  const out: Record<string, string> = {};
  if (args.name !== undefined) {
    if (typeof args.name !== 'string' || !args.name.trim()) throw new MetaToolkitRefusal('name must be a non-empty string.');
    out.name = args.name;
  }
  if (args.filter !== undefined) out.filter = JSON.stringify(validFilter(args.filter));
  if (creating && (!out.name || !out.filter)) throw new MetaToolkitRefusal('meta_product_set_create requires name and filter.');
  if (!creating && Object.keys(out).length === 0) throw new MetaToolkitRefusal('Nothing to change: pass name and/or filter.');
  return out;
}

/** Meta returns a set's filter as a JSON string; anything unparseable is unverifiable. */
function parseFilter(raw: unknown): any {
  if (raw && typeof raw === 'object') return raw;
  try {
    return typeof raw === 'string' ? JSON.parse(raw) : undefined;
  } catch {
    return undefined;
  }
}

export function buildSuggestedFilter(args: any): Record<string, unknown> {
  const rules: Record<string, unknown>[] = [];
  if (args.retailer_ids !== undefined) {
    if (!Array.isArray(args.retailer_ids) || args.retailer_ids.length === 0 || args.retailer_ids.length > 500
      || args.retailer_ids.some((r: unknown) => typeof r !== 'string' || !r.trim())) {
      throw new MetaToolkitRefusal('retailer_ids must be a list of 1 to 500 non-empty strings.');
    }
    rules.push({ retailer_id: { is_any: args.retailer_ids } });
  }
  for (const [arg, field] of [['brand', 'brand'], ['product_type', 'product_type'], ['name_contains', 'name']] as const) {
    if (args[arg] === undefined) continue;
    if (typeof args[arg] !== 'string' || !args[arg].trim()) throw new MetaToolkitRefusal(`${arg} must be a non-empty string.`);
    rules.push({ [field]: { i_contains: args[arg] } });
  }
  if (args.availability !== undefined) {
    if (!AVAILABILITY.includes(args.availability)) throw new MetaToolkitRefusal(`availability must be one of: ${AVAILABILITY.join(', ')}.`);
    rules.push({ availability: { eq: args.availability } });
  }
  for (const [arg, op] of [['price_min', 'gte'], ['price_max', 'lte']] as const) {
    if (args[arg] === undefined) continue;
    if (!Number.isSafeInteger(args[arg]) || args[arg] < 0) throw new MetaToolkitRefusal(`${arg} must be a non-negative integer in minor units.`);
    rules.push({ price: { [op]: args[arg] } });
  }
  if (args.price_min !== undefined && args.price_max !== undefined && args.price_min > args.price_max) {
    throw new MetaToolkitRefusal('price_min must not exceed price_max.');
  }
  if (rules.length === 0) throw new MetaToolkitRefusal('Give at least one criterion: retailer_ids, brand, availability, product_type, name_contains, price_min or price_max.');
  return rules.length === 1 ? rules[0] : { and: rules };
}

function verifyProduct(sent: Record<string, string>, got: any, catalogId: string): WriteVerification {
  if (!got) return 'UNCONFIRMED';
  if (got.product_catalog?.id !== undefined && String(got.product_catalog.id) !== catalogId) return 'MISMATCH';
  for (const f of PRODUCT_VERIFIED) {
    if (sent[f] === undefined) continue;
    if (got[f] === undefined || got[f] === null) return 'UNCONFIRMED';
    if (String(got[f]) !== sent[f]) return 'MISMATCH';
  }
  return 'CONFIRMED';
}

function verifySet(sent: Record<string, string>, got: any, catalogId: string): WriteVerification {
  if (!got) return 'UNCONFIRMED';
  if (got.product_catalog?.id !== undefined && String(got.product_catalog.id) !== catalogId) return 'MISMATCH';
  if (sent.name !== undefined) {
    if (got.name === undefined || got.name === null) return 'UNCONFIRMED';
    if (String(got.name) !== sent.name) return 'MISMATCH';
  }
  if (sent.filter !== undefined) {
    const filter = parseFilter(got.filter);
    if (filter === undefined) return 'UNCONFIRMED';
    // Containment: Meta may enrich a filter on read, but every rule sent must be there.
    if (!targetingApplied(JSON.parse(sent.filter), filter)) return 'MISMATCH';
  }
  return 'CONFIRMED';
}

function writeMessage(verification: WriteVerification, what: string, id: string | null): string {
  if (verification === 'CONFIRMED') return `${what} confirmed by read-back${id ? `: id ${id}` : ''}.`;
  if (verification === 'MISMATCH') return `Meta accepted the ${what}, but the read-back does not match what was sent. Review ${id ?? 'it'} before doing anything else.`;
  return `UNCONFIRMED: Meta accepted the ${what}${id ? ` (id ${id})` : ''}, but the read-back could not confirm it. Do not report this as done and do not retry blindly — check it first.`;
}

/**
 * Run one ENG-2925 catalog tool. `accountId` is the resolved, ownership-checked ad account
 * (the gateway resolves it before calling here).
 */
export async function runMetaCatalogWriteTool(
  name: MetaCatalogWriteToolName, userId: string, accountId: string, rawArgs: any, deps: MetaCatalogWriteDeps = defaultDeps,
) {
  const { confirm, preview_token: previewToken, confirm_in_use: confirmInUse, ...args } = rawArgs ?? {};
  const read = async (path: string, params: Record<string, string>) => {
    if (!READ_PATH_RE.test(path)) throw new MetaToolkitRefusal('Unsupported catalog read.');
    return deps.readGraph(userId, accountId, path, params);
  };
  const readOrRefuse = async (path: string, params: Record<string, string>) => {
    try {
      return await read(path, params);
    } catch (error: any) {
      if (error instanceof MetaToolkitRefusal) throw error;
      throw new MetaToolkitRefusal(`Could not read catalogs from Meta: ${metaMessage(error)}. Nothing was changed.`);
    }
  };
  const write = async (method: 'POST' | 'DELETE', path: string, params: Record<string, string>) => {
    if (!(method === 'POST' ? POST_PATH_RE : DELETE_PATH_RE).test(path)) throw new MetaToolkitRefusal('Unsupported catalog write.');
    return deps.writeGraph(userId, accountId, method, path, params);
  };

  const { businessId, catalogs } = await readBusinessCatalogs(readOrRefuse, accountId);
  if (!businessId) throw new MetaToolkitRefusal('This ad account is not in a Meta Business portfolio, so it has no product catalogs.');

  const ownedCatalog = (raw: unknown): string => {
    const id = String(raw ?? '');
    if (!numericId(id)) throw new MetaToolkitRefusal('catalog_id must be a numeric Meta catalog id (see meta_list_catalogs).');
    if (!catalogs.has(id)) throw new MetaToolkitRefusal(`Catalog ${id} is not available to this ad account's business. Nothing was changed.`);
    return id;
  };
  /** Reads a product / set node and requires its parent catalog to be in the owned set. */
  const ownedNode = async (raw: unknown, kind: 'product' | 'product set', fields: string) => {
    const id = String(raw ?? '');
    const idField = kind === 'product' ? 'product_id' : 'product_set_id';
    if (!numericId(id)) throw new MetaToolkitRefusal(`${idField} must be a numeric Meta id.`);
    let node: any;
    try {
      node = await read(id, { fields });
    } catch (error: any) {
      if (isNotFound(error)) throw new MetaToolkitRefusal(`The ${kind} ${id} was not found. Nothing was changed.`);
      throw new MetaToolkitRefusal(`Could not read ${kind} ${id} from Meta: ${metaMessage(error)}. Nothing was changed.`);
    }
    const catalogId = String(node?.product_catalog?.id ?? '');
    if (!catalogId || !catalogs.has(catalogId)) {
      throw new MetaToolkitRefusal(`The ${kind} ${id} is not in a catalog available to this ad account's business. Nothing was changed.`);
    }
    return { id, catalogId, node };
  };
  const readBack = async (id: string, fields: string) => {
    try {
      return await read(id, { fields });
    } catch {
      return null;
    }
  };
  /** A write call that threw: a definite Meta refusal is FAILED, anything else is outcome-unknown. */
  const writeFailure = (error: any, what: string, id: string | null) => (error?.outcomeUnknown === true
    || (error?.outcomeUnknown === undefined && !error?.metaError && !(error instanceof MetaToolkitRefusal))
    ? {
        success: false, verification: 'UNCONFIRMED' as WriteVerification, id,
        message: `UNCONFIRMED: the ${what} failed without a definite answer from Meta (${metaMessage(error)}), so it may or may not have been applied. Do not report this as done and do not retry blindly — check it first.`,
      }
    : { status: 'FAILED', success: false, id, message: `Meta refused the ${what}: ${metaMessage(error)}.` });

  switch (name) {
    case 'meta_get_suggested_filter': {
      assertOnlyKeys(args, ['account_id', 'catalog_id', 'retailer_ids', 'brand', 'availability', 'product_type', 'name_contains', 'price_min', 'price_max']);
      const catalogId = ownedCatalog(args.catalog_id);
      const filter = buildSuggestedFilter(args);
      let res: any;
      try {
        res = await read(`${catalogId}/products`, { fields: 'id,retailer_id,name,availability,price', filter: JSON.stringify(filter), limit: '10' });
      } catch (error: any) {
        throw new MetaToolkitRefusal(`Meta could not evaluate this filter: ${metaMessage(error)}.`);
      }
      const matches = Array.isArray(res?.data) ? res.data : [];
      return {
        account_id: accountId, catalog_id: catalogId, filter, sample_matches: matches,
        ...(res?.paging?.next ? { more_matches: true } : {}),
        note: matches.length
          ? 'Pass this filter to meta_product_set_create (or meta_product_set_update). Nothing was written.'
          : 'No products currently match this filter. A set created with it would be empty.',
      };
    }

    case 'meta_product_create': {
      assertOnlyKeys(args, ['account_id', 'catalog_id', ...PRODUCT_FIELDS]);
      const catalogId = ownedCatalog(args.catalog_id);
      const params = productParams(args, true);
      let res: any;
      try {
        res = await write('POST', `${catalogId}/products`, params);
      } catch (error) {
        return writeFailure(error, 'product create', null);
      }
      const id = res?.id ? String(res.id) : null;
      const verification = verifyProduct(params, id ? await readBack(id, PRODUCT_READ_FIELDS) : null, catalogId);
      return { success: verification === 'CONFIRMED', verification, id, catalog_id: catalogId, message: writeMessage(verification, 'product create', id) };
    }

    case 'meta_update_product': {
      assertOnlyKeys(args, ['account_id', 'product_id', ...PRODUCT_FIELDS]);
      const params = productParams(args, false);
      const { id, catalogId } = await ownedNode(args.product_id, 'product', 'id,product_catalog{id}');
      try {
        await write('POST', id, params);
      } catch (error) {
        return writeFailure(error, 'product update', id);
      }
      const verification = verifyProduct(params, await readBack(id, PRODUCT_READ_FIELDS), catalogId);
      return { success: verification === 'CONFIRMED', verification, id, catalog_id: catalogId, message: writeMessage(verification, 'product update', id) };
    }

    case 'meta_product_set_create': {
      assertOnlyKeys(args, ['account_id', 'catalog_id', 'name', 'filter']);
      const catalogId = ownedCatalog(args.catalog_id);
      const params = setParams(args, true);
      let res: any;
      try {
        res = await write('POST', `${catalogId}/product_sets`, params);
      } catch (error) {
        return writeFailure(error, 'product set create', null);
      }
      const id = res?.id ? String(res.id) : null;
      const got = id ? await readBack(id, SET_READ_FIELDS) : null;
      const verification = verifySet(params, got, catalogId);
      return {
        success: verification === 'CONFIRMED', verification, id, catalog_id: catalogId,
        product_count: got?.product_count ?? null, message: writeMessage(verification, 'product set create', id),
      };
    }

    case 'meta_product_set_update': {
      assertOnlyKeys(args, ['account_id', 'product_set_id', 'name', 'filter']);
      const params = setParams(args, false);
      const { id, catalogId } = await ownedNode(args.product_set_id, 'product set', 'id,product_catalog{id}');
      try {
        await write('POST', id, params);
      } catch (error) {
        return writeFailure(error, 'product set update', id);
      }
      const got = await readBack(id, SET_READ_FIELDS);
      const verification = verifySet(params, got, catalogId);
      return {
        success: verification === 'CONFIRMED', verification, id, catalog_id: catalogId,
        product_count: got?.product_count ?? null, message: writeMessage(verification, 'product set update', id),
      };
    }

    case 'meta_delete_product':
    case 'meta_product_set_delete': {
      const isSet = name === 'meta_product_set_delete';
      const kind = isSet ? 'product set' : 'product';
      assertOnlyKeys(args, ['account_id', isSet ? 'product_set_id' : 'product_id']);
      if (!isSet && confirmInUse !== undefined) throw new MetaToolkitRefusal('confirm_in_use applies only to meta_product_set_delete.');
      if (confirmInUse !== undefined && typeof confirmInUse !== 'boolean') throw new MetaToolkitRefusal('confirm_in_use must be true or false.');
      const { id, catalogId, node } = await ownedNode(
        isSet ? args.product_set_id : args.product_id, kind,
        isSet ? SET_READ_FIELDS : 'id,retailer_id,name,product_catalog{id}',
      );

      let inUse: Array<{ id: string; name: string }> = [];
      let inUseUnknown = false;
      if (isSet) {
        const adsets = await readOrRefuse(`act_${String(accountId).replace(/^act_/, '')}/adsets`, {
          fields: 'id,name,status,effective_status,promoted_object', limit: IN_USE_SCAN_LIMIT,
        });
        inUse = (Array.isArray(adsets?.data) ? adsets.data : [])
          .filter((a: any) => (a?.status === 'ACTIVE' || a?.effective_status === 'ACTIVE') && String(a?.promoted_object?.product_set_id ?? '') === id)
          .map((a: any) => ({ id: String(a.id), name: String(a?.name ?? '') }));
        // Not every ad set was read, so "not in use" cannot be proven: fail closed.
        inUseUnknown = Boolean(adsets?.paging?.next);
        if ((inUse.length || inUseUnknown) && confirmInUse !== true) {
          throw new MetaToolkitRefusal(inUse.length
            ? `Product set ${id} is used by ${inUse.length} ACTIVE ad set(s) of this account (${inUse.map((a) => `${a.name || a.id} [${a.id}]`).join(', ')}); deleting it stops their delivery. Nothing was changed. Pause or retarget them first, or repeat with confirm_in_use=true after the user explicitly accepts that.`
            : `This account has more than ${IN_USE_SCAN_LIMIT} ad sets, so Zoma could not prove product set ${id} is unused. Nothing was changed. Repeat with confirm_in_use=true only after the user explicitly accepts that ACTIVE ad sets may stop delivering.`);
        }
      }

      const state = isSet
        ? { name: node?.name ?? null, filter: node?.filter ?? null }
        : { retailer_id: node?.retailer_id ?? null, name: node?.name ?? null };
      const fingerprint = previewFingerprint({
        userId, tool: name, accountId, id, catalogId, state,
        ...(isSet ? { inUse: inUse.map((a) => a.id), inUseUnknown, confirmInUse: confirmInUse === true } : {}),
      });
      const now = deps.now();
      const secret = deps.secret();
      const previewText = [
        'PREVIEW — nothing has changed yet.',
        isSet
          ? `Delete product set ${id} "${state.name ?? ''}" from catalog ${catalogId}.`
          : `Delete product ${id} (retailer_id ${state.retailer_id ?? '?'}, "${state.name ?? ''}") from catalog ${catalogId}.`,
        inUse.length ? `In use: ${inUse.length} ACTIVE ad set(s) of this account promote this set (${inUse.map((a) => a.id).join(', ')}); they will stop delivering.` : '',
        inUseUnknown ? 'Could not check every ad set of this account; ACTIVE ad sets may use this set.' : '',
        isSet ? 'Ad sets in other ad accounts of the business were not checked.' : 'Ads showing this product will no longer show it.',
        'This cannot be undone.',
      ].filter(Boolean).join('\n');
      const freshPreview = () => previewResponse({ secret, userId, now, fingerprint, preview: previewText });

      if (confirm !== true) return freshPreview();
      if (!previewTokenMatches(previewToken, secret, userId, fingerprint, now)) {
        return {
          ...freshPreview(),
          status: 'PREVIEW_MISMATCH',
          note: 'The confirmation did not match a current preview (missing, expired, or the arguments or Meta state changed). Nothing was sent. Show this new preview and get approval again.',
        };
      }
      if (!(await consumeToken(deps.consumedTokens, previewToken, now))) {
        const replay = replayTokenOutcome(deps.tokenOutcomes, previewToken, now);
        if (replay) return replay;
        throw new MetaToolkitRefusal('This preview_token was already used. Run a new preview for another change.');
      }

      const outcome = await (async () => {
        try {
          await write('DELETE', id, {});
        } catch (error) {
          return writeFailure(error, `${kind} delete`, id);
        }
        // Independent read-back: only Meta's "does not exist" (code 100) confirms the delete.
        let verification: WriteVerification;
        try {
          await read(id, { fields: 'id' });
          verification = 'MISMATCH';
        } catch (error: any) {
          verification = isNotFound(error) ? 'CONFIRMED' : 'UNCONFIRMED';
        }
        return {
          success: verification === 'CONFIRMED', verification, id, catalog_id: catalogId,
          message: verification === 'CONFIRMED'
            ? `${kind} delete confirmed by read-back: ${id} no longer exists.`
            : verification === 'MISMATCH'
              ? `Meta accepted the ${kind} delete, but ${id} can still be read. Check it before doing anything else.`
              : `UNCONFIRMED: Meta accepted the ${kind} delete, but the read-back could not confirm ${id} is gone. Check it before retrying.`,
        };
      })();
      return rememberTokenOutcome(deps.tokenOutcomes, previewToken, outcome);
    }
  }
}
