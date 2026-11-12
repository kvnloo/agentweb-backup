/**
 * ENG-2926 (catalog slice 3) — Zoma catalog create/update, product feeds, feed upload sessions
 * and feed rules for external agents.
 *
 *   meta_catalog_create             create a catalog in the account's business       (read-back)
 *   meta_catalog_update             rename a business-owned catalog                   (read-back)
 *   meta_product_feed_create        create a scheduled https feed on a catalog       (read-back)
 *   meta_product_feed_update        rename / reschedule a feed                        (read-back)
 *   meta_product_feed_delete        delete a feed                          (preview → confirm)
 *   meta_feed_upload_create         start a one-off upload session from an https URL  (read-back)
 *   meta_feed_upload_get            READ: one upload session (or the feed's recent sessions)
 *   meta_feed_rule_create           add a feed rule                                    (read-back)
 *   meta_feed_rule_get              READ: a feed's rules
 *   meta_feed_rule_delete           delete a feed rule                      (preview → confirm)
 *
 * Listing feeds is the existing read-only meta_list_product_feeds (ENG-2918); it is not
 * duplicated here.
 *
 * Ownership: every catalog id must be in the account business's catalog set
 * (readBusinessCatalogs); writes to a catalog additionally require `owned` access. A feed id
 * must be on that catalog's product_feeds edge, and a rule id on that feed's rules edge, so a
 * caller cannot reach another business's feed by guessing an id. Feed URLs must be https and
 * may not embed credentials (user:pass@); a URL is never echoed back with its query string.
 * Deletes use the shared Zoma guard (zomaWriteGuard): PREVIEW + single-use preview_token, then
 * confirm. Every write is read back from Meta; only CONFIRMED is success.
 */
import { getJwtSecret } from '../config/jwt';
import { MetaToolkitRefusal } from './metaToolkitErrors';
import { readBusinessCatalogs } from './metaToolkitCatalogs';
import {
  consumeToken, defaultConsumedTokenStore, type ConsumedTokens, previewFingerprint, previewResponse, previewTokenMatches,
  rememberTokenOutcome, replayTokenOutcome, type WriteVerification,
} from './zomaWriteGuard';

export const META_CATALOG_FEED_TOOL_NAMES = [
  'meta_catalog_create', 'meta_catalog_update',
  'meta_product_feed_create', 'meta_product_feed_update', 'meta_product_feed_delete',
  'meta_feed_upload_create', 'meta_feed_upload_get',
  'meta_feed_rule_create', 'meta_feed_rule_get', 'meta_feed_rule_delete',
] as const;
export type MetaCatalogFeedToolName = (typeof META_CATALOG_FEED_TOOL_NAMES)[number];

export function isMetaCatalogFeedTool(name: string): name is MetaCatalogFeedToolName {
  return (META_CATALOG_FEED_TOOL_NAMES as readonly string[]).includes(name);
}

type Kind = { entityType: 'CATALOG' | 'PRODUCT_FEED' | 'FEED_UPLOAD' | 'FEED_RULE'; action: 'CREATE' | 'UPDATE' | 'DELETE' };
/** Entity + action of the tools that change Meta state (write scope + write metering). */
export const CATALOG_FEED_WRITE_KIND: Partial<Record<MetaCatalogFeedToolName, Kind>> = {
  meta_catalog_create: { entityType: 'CATALOG', action: 'CREATE' },
  meta_catalog_update: { entityType: 'CATALOG', action: 'UPDATE' },
  meta_product_feed_create: { entityType: 'PRODUCT_FEED', action: 'CREATE' },
  meta_product_feed_update: { entityType: 'PRODUCT_FEED', action: 'UPDATE' },
  meta_product_feed_delete: { entityType: 'PRODUCT_FEED', action: 'DELETE' },
  meta_feed_upload_create: { entityType: 'FEED_UPLOAD', action: 'CREATE' },
  meta_feed_rule_create: { entityType: 'FEED_RULE', action: 'CREATE' },
  meta_feed_rule_delete: { entityType: 'FEED_RULE', action: 'DELETE' },
};

export function isMetaCatalogFeedWrite(name: string): boolean {
  return isMetaCatalogFeedTool(name) && CATALOG_FEED_WRITE_KIND[name] !== undefined;
}

const FEED_FIELDS = 'id,name,schedule,update_schedule,product_count';
const UPLOAD_FIELDS = 'id,start_time,end_time,url,num_detected_items,num_invalid_items,num_persisted_items,error_count,warning_count';
const RULE_FIELDS = 'id,attribute,rule_type,params';
const INTERVALS = ['HOURLY', 'DAILY', 'WEEKLY'] as const;
const RULE_TYPES = ['mapping_rule', 'value_mapping_rule', 'letter_case_rule', 'fallback_rule', 'regex_replace_rule'] as const;
const VERTICALS = ['commerce', 'hotels', 'flights', 'destinations', 'home_listings', 'vehicles'] as const;

const ACCOUNT_PROP = { account_id: { type: 'string', description: 'Optional Meta ad account id; defaults to the only connected account.' } };
const CATALOG_PROP = { catalog_id: { type: 'string', description: 'Numeric product catalog id (from meta_list_catalogs).' } };
const FEED_PROP = { feed_id: { type: 'string', description: 'Numeric product feed id (from meta_list_product_feeds).' } };
const SCHEDULE_PROPS = {
  url: { type: 'string', description: 'https URL Meta fetches the feed file from. No embedded user:password.' },
  interval: { type: 'string', enum: [...INTERVALS], description: 'How often Meta fetches the URL.' },
  hour: { type: 'integer', minimum: 0, maximum: 23, description: 'Hour of day (UTC) for DAILY / WEEKLY fetches.' },
};
const CONFIRM_PROPS = {
  confirm: { type: 'boolean', description: 'Omit to get a PREVIEW (nothing changes). Set true only after the user explicitly approved that preview, together with its preview_token.' },
  preview_token: { type: 'string', description: 'The preview_token of the preview the user approved. Single use, 15 minutes; repeat the previewed arguments exactly.' },
};
const obj = (properties: Record<string, unknown>, required: string[]) => ({ type: 'object', properties, required, additionalProperties: false });

export const META_CATALOG_FEED_TOOL_DEFINITIONS = [
  { name: 'meta_catalog_create', description: 'Create a product catalog in this ad account\'s Meta Business portfolio. Verified by read-back.', inputSchema: obj({ ...ACCOUNT_PROP, name: { type: 'string' }, vertical: { type: 'string', enum: [...VERTICALS] } }, ['name']) },
  { name: 'meta_catalog_update', description: 'Rename a catalog owned by this ad account\'s business. Verified by read-back.', inputSchema: obj({ ...ACCOUNT_PROP, ...CATALOG_PROP, name: { type: 'string' } }, ['catalog_id', 'name']) },
  { name: 'meta_product_feed_create', description: 'Create a product feed on an owned catalog, optionally fetched on a schedule from an https URL. Verified by read-back. List feeds with meta_list_product_feeds.', inputSchema: obj({ ...ACCOUNT_PROP, ...CATALOG_PROP, name: { type: 'string' }, ...SCHEDULE_PROPS }, ['catalog_id', 'name']) },
  { name: 'meta_product_feed_update', description: 'Rename or reschedule a product feed of an owned catalog. Verified by read-back.', inputSchema: obj({ ...ACCOUNT_PROP, ...CATALOG_PROP, ...FEED_PROP, name: { type: 'string' }, ...SCHEDULE_PROPS }, ['catalog_id', 'feed_id']) },
  { name: 'meta_product_feed_delete', description: 'Delete a product feed (its products stop updating from it). Two calls: PREVIEW + preview_token, then confirm=true with the token. Verified by read-back.', inputSchema: obj({ ...ACCOUNT_PROP, ...CATALOG_PROP, ...FEED_PROP, ...CONFIRM_PROPS }, ['catalog_id', 'feed_id']) },
  { name: 'meta_feed_upload_create', description: 'Start a one-off upload session: Meta fetches the given https URL into the feed now. Check progress with meta_feed_upload_get.', inputSchema: obj({ ...ACCOUNT_PROP, ...CATALOG_PROP, ...FEED_PROP, url: SCHEDULE_PROPS.url, update_only: { type: 'boolean', description: 'Only update existing items; do not create or delete.' } }, ['catalog_id', 'feed_id', 'url']) },
  { name: 'meta_feed_upload_get', description: 'Read-only. One upload session of a feed (upload_id), or the feed\'s recent sessions with item/error counts.', inputSchema: obj({ ...ACCOUNT_PROP, ...CATALOG_PROP, ...FEED_PROP, upload_id: { type: 'string' } }, ['catalog_id', 'feed_id']) },
  { name: 'meta_feed_rule_create', description: 'Add a rule that transforms a feed attribute on ingest (e.g. map a column, set a fallback). Verified by read-back.', inputSchema: obj({ ...ACCOUNT_PROP, ...CATALOG_PROP, ...FEED_PROP, attribute: { type: 'string' }, rule_type: { type: 'string', enum: [...RULE_TYPES] }, params: { type: 'object', additionalProperties: { type: 'string' } } }, ['catalog_id', 'feed_id', 'attribute', 'rule_type', 'params']) },
  { name: 'meta_feed_rule_get', description: 'Read-only. List a feed\'s rules.', inputSchema: obj({ ...ACCOUNT_PROP, ...CATALOG_PROP, ...FEED_PROP }, ['catalog_id', 'feed_id']) },
  { name: 'meta_feed_rule_delete', description: 'Delete a feed rule. Two calls: PREVIEW + preview_token, then confirm=true with the token. Verified by read-back.', inputSchema: obj({ ...ACCOUNT_PROP, ...CATALOG_PROP, ...FEED_PROP, rule_id: { type: 'string' }, ...CONFIRM_PROPS }, ['catalog_id', 'feed_id', 'rule_id']) },
];

const READ_PATH_RE = /^(act_\d+|\d+(\/(owned_product_catalogs|client_product_catalogs|product_feeds|uploads|rules))?)$/;
const WRITE_PATH_RE = { POST: /^\d+(\/(owned_product_catalogs|product_feeds|uploads|rules))?$/, DELETE: /^\d+$/ };

export interface MetaCatalogFeedDeps {
  readGraph: (userId: string, accountId: string, path: string, params: Record<string, string>) => Promise<any>;
  writeGraph: (userId: string, accountId: string, method: 'POST' | 'DELETE', path: string, params: Record<string, string>) => Promise<any>;
  secret: () => string;
  now: () => number;
  consumedTokens: ConsumedTokens;
  tokenOutcomes: Map<string, { exp: number; outcome: any }>;
}

const ams = async () => (await import('../services/agentModeService')).agentModeService;

const defaultDeps: MetaCatalogFeedDeps = {
  readGraph: async (userId, accountId, path, params) => (await ams()).readToolkitMetaCatalogGraph(userId, accountId, path, params),
  writeGraph: async (userId, accountId, method, path, params) => (await ams()).writeToolkitMetaCatalogGraph(userId, accountId, method, path, params),
  secret: () => getJwtSecret(),
  now: () => Date.now(),
  consumedTokens: defaultConsumedTokenStore,
  tokenOutcomes: new Map(),
};

const metaMessage = (error: any) => String(error?.metaError?.message || error?.message || 'Meta request failed');
const numericId = (v: unknown) => /^\d+$/.test(String(v ?? ''));
const list = (res: any): any[] => (Array.isArray(res?.data) ? res.data : []);

function assertOnlyKeys(args: any, allowed: string[]) {
  const extra = Object.keys(args).filter((k) => args[k] !== undefined && !allowed.includes(k));
  if (extra.length) throw new MetaToolkitRefusal(`Not allowed: ${extra.join(', ')}. Allowed: ${allowed.join(', ')}.`);
}

function requireName(raw: unknown, what: string): string {
  const name = String(raw ?? '').trim();
  if (!name || name.length > 200) throw new MetaToolkitRefusal(`${what} name must be 1-200 characters.`);
  return name;
}

/** https only, no embedded credentials. Returns the URL plus a redacted form safe to echo/log. */
export function validateFeedUrl(raw: unknown): { url: string; display: string } {
  let parsed: URL;
  try {
    parsed = new URL(String(raw ?? ''));
  } catch {
    throw new MetaToolkitRefusal('url must be a valid https URL.');
  }
  if (parsed.protocol !== 'https:') throw new MetaToolkitRefusal('url must use https.');
  if (parsed.username || parsed.password) throw new MetaToolkitRefusal('url must not embed a username or password. Host the feed at a URL without credentials.');
  return { url: parsed.toString(), display: `${parsed.origin}${parsed.pathname}${parsed.search ? '?…' : ''}` };
}

function scheduleParam(args: any): string | undefined {
  if (args.url === undefined && args.interval === undefined && args.hour === undefined) return undefined;
  if (args.url === undefined || args.interval === undefined) throw new MetaToolkitRefusal('A schedule needs both url and interval.');
  const { url } = validateFeedUrl(args.url);
  if (!(INTERVALS as readonly string[]).includes(String(args.interval))) throw new MetaToolkitRefusal(`interval must be one of ${INTERVALS.join(', ')}.`);
  const schedule: Record<string, unknown> = { url, interval: String(args.interval) };
  if (args.hour !== undefined) {
    const hour = Number(args.hour);
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) throw new MetaToolkitRefusal('hour must be an integer 0-23.');
    schedule.hour = hour;
  }
  return JSON.stringify(schedule);
}

const scheduleUrl = (feed: any): string | undefined => feed?.schedule?.url ?? feed?.update_schedule?.url;

/** Run one ENG-2926 tool. `accountId` is the resolved, ownership-checked ad account. */
export async function runMetaCatalogFeedTool(
  name: MetaCatalogFeedToolName, userId: string, accountId: string, rawArgs: any, deps: MetaCatalogFeedDeps = defaultDeps,
) {
  const { confirm, preview_token: previewToken, ...args } = rawArgs ?? {};
  const read = async (path: string, params: Record<string, string>) => {
    if (!READ_PATH_RE.test(path)) throw new MetaToolkitRefusal('Unsupported catalog feed read.');
    try {
      return await deps.readGraph(userId, accountId, path, params);
    } catch (error: any) {
      throw new MetaToolkitRefusal(`Could not read from Meta: ${metaMessage(error)}. Nothing was changed.`);
    }
  };

  const { businessId, catalogs } = await readBusinessCatalogs(read, accountId);
  if (!businessId) throw new MetaToolkitRefusal('This ad account is not in a Meta Business portfolio, so it has no product catalogs.');

  const ownedCatalog = (raw: unknown, forWrite: boolean): string => {
    const id = String(raw ?? '');
    if (!numericId(id)) throw new MetaToolkitRefusal('catalog_id must be a numeric Meta catalog id (see meta_list_catalogs).');
    const c = catalogs.get(id);
    if (!c) throw new MetaToolkitRefusal(`Catalog ${id} is not available to this ad account's business. Nothing was changed.`);
    if (forWrite && c.access !== 'owned') throw new MetaToolkitRefusal(`Catalog ${id} is shared with this business, not owned by it; only its owner can change it. Nothing was changed.`);
    return id;
  };
  const feedsOf = async (catalogId: string) => list(await read(`${catalogId}/product_feeds`, { fields: FEED_FIELDS, limit: '100' }));
  const ownedFeed = async (catalogId: string, raw: unknown) => {
    const id = String(raw ?? '');
    if (!numericId(id)) throw new MetaToolkitRefusal('feed_id must be a numeric Meta product feed id.');
    const feed = (await feedsOf(catalogId)).find((f) => String(f?.id) === id);
    if (!feed) throw new MetaToolkitRefusal(`Feed ${id} is not a feed of catalog ${catalogId}. Nothing was changed.`);
    return { id, feed };
  };
  const rulesOf = async (feedId: string) => list(await read(`${feedId}/rules`, { fields: RULE_FIELDS, limit: '100' }));

  /** Execute one write and verify it by read-back; never throws for a Meta outcome. */
  const write = async (
    what: string, method: 'POST' | 'DELETE', path: string, params: Record<string, string>,
    verify: (response: any) => Promise<{ ok: boolean; id?: string }>, extra: Record<string, unknown> = {},
  ) => {
    if (!WRITE_PATH_RE[method].test(path)) throw new MetaToolkitRefusal('Unsupported catalog feed write.');
    let response: any;
    try {
      response = await deps.writeGraph(userId, accountId, method, path, params);
    } catch (error: any) {
      const unknown = error?.outcomeUnknown === true || (error?.outcomeUnknown === undefined && !error?.metaError);
      return unknown
        ? { success: false, verification: 'UNCONFIRMED' as WriteVerification, ...extra, message: `UNCONFIRMED: the ${what} failed without a definite answer from Meta (${metaMessage(error)}). Check it before retrying.` }
        : { status: 'FAILED', success: false, ...extra, message: `Meta refused the ${what}: ${metaMessage(error)}.` };
    }
    let verification: WriteVerification;
    let id = (extra.id as string | undefined) ?? (response?.id ? String(response.id) : undefined);
    try {
      const v = await verify(response);
      if (v.id) id = v.id;
      verification = v.ok ? 'CONFIRMED' : 'MISMATCH';
    } catch {
      verification = 'UNCONFIRMED';
    }
    return {
      success: verification === 'CONFIRMED', verification, ...extra, id,
      message: verification === 'CONFIRMED'
        ? `${what} confirmed by read-back.`
        : verification === 'MISMATCH'
          ? `Meta accepted the ${what}, but the read-back does not show it. Check it before doing anything else.`
          : `UNCONFIRMED: Meta accepted the ${what}, but the read-back failed. Do not report this as done; check it first.`,
    };
  };

  /** Preview → confirm wrapper for deletes (shared zomaWriteGuard semantics). */
  const guarded = async (fingerprintInput: Record<string, unknown>, previewText: string, run: () => Promise<any>) => {
    const fingerprint = previewFingerprint({ userId, tool: name, accountId, ...fingerprintInput });
    const now = deps.now();
    const secret = deps.secret();
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
    return rememberTokenOutcome(deps.tokenOutcomes, previewToken, await run());
  };
  if (confirm !== undefined || previewToken !== undefined) {
    if (name !== 'meta_product_feed_delete' && name !== 'meta_feed_rule_delete') throw new MetaToolkitRefusal(`${name} takes no confirm / preview_token.`);
  }

  switch (name) {
    case 'meta_catalog_create': {
      assertOnlyKeys(args, ['account_id', 'name', 'vertical']);
      const catalogName = requireName(args.name, 'Catalog');
      const params: Record<string, string> = { name: catalogName };
      if (args.vertical !== undefined) {
        if (!(VERTICALS as readonly string[]).includes(String(args.vertical))) throw new MetaToolkitRefusal(`vertical must be one of ${VERTICALS.join(', ')}.`);
        params.vertical = String(args.vertical);
      }
      return write('catalog create', 'POST', `${businessId}/owned_product_catalogs`, params, async (res) => {
        const id = String(res?.id ?? '');
        const after = await readBusinessCatalogs(read, accountId);
        return { ok: numericId(id) && after.catalogs.get(id)?.name === catalogName, id };
      }, { name: catalogName });
    }

    case 'meta_catalog_update': {
      assertOnlyKeys(args, ['account_id', 'catalog_id', 'name']);
      const catalogId = ownedCatalog(args.catalog_id, true);
      const catalogName = requireName(args.name, 'Catalog');
      return write('catalog update', 'POST', catalogId, { name: catalogName }, async () => {
        const after = await readBusinessCatalogs(read, accountId);
        return { ok: after.catalogs.get(catalogId)?.name === catalogName };
      }, { id: catalogId });
    }

    case 'meta_product_feed_create': {
      assertOnlyKeys(args, ['account_id', 'catalog_id', 'name', 'url', 'interval', 'hour']);
      const catalogId = ownedCatalog(args.catalog_id, true);
      const feedName = requireName(args.name, 'Feed');
      const schedule = scheduleParam(args);
      const params: Record<string, string> = { name: feedName, ...(schedule ? { schedule } : {}) };
      return write('product feed create', 'POST', `${catalogId}/product_feeds`, params, async (res) => {
        const id = String(res?.id ?? '');
        const feed = (await feedsOf(catalogId)).find((f) => String(f?.id) === id);
        return { ok: !!feed && feed.name === feedName, id };
      }, { catalog_id: catalogId });
    }

    case 'meta_product_feed_update': {
      assertOnlyKeys(args, ['account_id', 'catalog_id', 'feed_id', 'name', 'url', 'interval', 'hour']);
      const catalogId = ownedCatalog(args.catalog_id, true);
      const { id: feedId } = await ownedFeed(catalogId, args.feed_id);
      const params: Record<string, string> = {};
      if (args.name !== undefined) params.name = requireName(args.name, 'Feed');
      const schedule = scheduleParam(args);
      if (schedule) params.schedule = schedule;
      if (!Object.keys(params).length) throw new MetaToolkitRefusal('Nothing to update: pass name and/or url + interval.');
      return write('product feed update', 'POST', feedId, params, async () => {
        const feed = (await feedsOf(catalogId)).find((f) => String(f?.id) === feedId);
        const nameOk = params.name === undefined || feed?.name === params.name;
        const urlOk = !schedule || scheduleUrl(feed) === undefined || scheduleUrl(feed) === JSON.parse(schedule).url;
        return { ok: !!feed && nameOk && urlOk };
      }, { id: feedId, catalog_id: catalogId });
    }

    case 'meta_product_feed_delete': {
      assertOnlyKeys(args, ['account_id', 'catalog_id', 'feed_id']);
      const catalogId = ownedCatalog(args.catalog_id, true);
      const { id: feedId, feed } = await ownedFeed(catalogId, args.feed_id);
      const preview = [
        'PREVIEW — nothing has changed yet.',
        `Delete feed ${feedId} ("${feed?.name ?? ''}", ${feed?.product_count ?? 'unknown'} products) from catalog ${catalogId}. Its products stop updating from this feed.`,
      ].join('\n');
      return guarded({ catalogId, feedId }, preview, () => write('product feed delete', 'DELETE', feedId, {}, async () => ({
        ok: !(await feedsOf(catalogId)).some((f) => String(f?.id) === feedId),
      }), { id: feedId, catalog_id: catalogId }));
    }

    case 'meta_feed_upload_create': {
      assertOnlyKeys(args, ['account_id', 'catalog_id', 'feed_id', 'url', 'update_only']);
      const catalogId = ownedCatalog(args.catalog_id, true);
      const { id: feedId } = await ownedFeed(catalogId, args.feed_id);
      const { url, display } = validateFeedUrl(args.url);
      const params: Record<string, string> = { url, ...(args.update_only === true ? { update_only: 'true' } : {}) };
      return write('feed upload', 'POST', `${feedId}/uploads`, params, async (res) => {
        const id = String(res?.id ?? '');
        const uploads = list(await read(`${feedId}/uploads`, { fields: 'id', limit: '25' }));
        return { ok: numericId(id) && uploads.some((u) => String(u?.id) === id), id };
      }, { feed_id: feedId, url: display });
    }

    case 'meta_feed_upload_get': {
      assertOnlyKeys(args, ['account_id', 'catalog_id', 'feed_id', 'upload_id']);
      const catalogId = ownedCatalog(args.catalog_id, false);
      const { id: feedId } = await ownedFeed(catalogId, args.feed_id);
      const redact = (u: any) => ({ ...u, url: u?.url ? (() => { try { return validateFeedUrl(u.url).display; } catch { return undefined; } })() : undefined });
      const uploads = list(await read(`${feedId}/uploads`, { fields: UPLOAD_FIELDS, limit: '25' })).map(redact);
      if (args.upload_id === undefined) return { account_id: accountId, catalog_id: catalogId, feed_id: feedId, uploads };
      const uploadId = String(args.upload_id);
      const upload = uploads.find((u) => String(u?.id) === uploadId);
      if (!upload) throw new MetaToolkitRefusal(`Upload ${uploadId} is not a recent upload session of feed ${feedId}.`);
      return { account_id: accountId, catalog_id: catalogId, feed_id: feedId, upload };
    }

    case 'meta_feed_rule_create': {
      assertOnlyKeys(args, ['account_id', 'catalog_id', 'feed_id', 'attribute', 'rule_type', 'params']);
      const catalogId = ownedCatalog(args.catalog_id, true);
      const { id: feedId } = await ownedFeed(catalogId, args.feed_id);
      const attribute = String(args.attribute ?? '').trim();
      if (!/^[A-Za-z0-9_.\-]{1,100}$/.test(attribute)) throw new MetaToolkitRefusal('attribute must be a feed column / attribute name.');
      if (!(RULE_TYPES as readonly string[]).includes(String(args.rule_type))) throw new MetaToolkitRefusal(`rule_type must be one of ${RULE_TYPES.join(', ')}.`);
      const ruleParams = args.params;
      if (!ruleParams || typeof ruleParams !== 'object' || Array.isArray(ruleParams) || !Object.values(ruleParams).every((v) => typeof v === 'string')) {
        throw new MetaToolkitRefusal('params must be an object of string values.');
      }
      return write('feed rule create', 'POST', `${feedId}/rules`, { attribute, rule_type: String(args.rule_type), params: JSON.stringify(ruleParams) }, async (res) => {
        const id = String(res?.id ?? '');
        return { ok: numericId(id) && (await rulesOf(feedId)).some((r) => String(r?.id) === id), id };
      }, { feed_id: feedId });
    }

    case 'meta_feed_rule_get': {
      assertOnlyKeys(args, ['account_id', 'catalog_id', 'feed_id']);
      const catalogId = ownedCatalog(args.catalog_id, false);
      const { id: feedId } = await ownedFeed(catalogId, args.feed_id);
      return { account_id: accountId, catalog_id: catalogId, feed_id: feedId, rules: await rulesOf(feedId) };
    }

    case 'meta_feed_rule_delete': {
      assertOnlyKeys(args, ['account_id', 'catalog_id', 'feed_id', 'rule_id']);
      const catalogId = ownedCatalog(args.catalog_id, true);
      const { id: feedId } = await ownedFeed(catalogId, args.feed_id);
      const ruleId = String(args.rule_id ?? '');
      if (!numericId(ruleId)) throw new MetaToolkitRefusal('rule_id must be a numeric Meta feed rule id.');
      const rule = (await rulesOf(feedId)).find((r) => String(r?.id) === ruleId);
      if (!rule) throw new MetaToolkitRefusal(`Rule ${ruleId} is not a rule of feed ${feedId}. Nothing was changed.`);
      const preview = [
        'PREVIEW — nothing has changed yet.',
        `Delete ${rule?.rule_type ?? 'rule'} ${ruleId} on attribute "${rule?.attribute ?? ''}" from feed ${feedId}. Future ingests no longer apply it.`,
      ].join('\n');
      return guarded({ catalogId, feedId, ruleId }, preview, () => write('feed rule delete', 'DELETE', ruleId, {}, async () => ({
        ok: !(await rulesOf(feedId)).some((r) => String(r?.id) === ruleId),
      }), { id: ruleId, feed_id: feedId }));
    }
  }
}
