/**
 * ENG-2927 (catalog slice 4) — Zoma catalog event sources for external agents.
 *
 *   meta_event_source_get                  READ: event sources (pixels / datasets) connected to a catalog
 *   meta_event_source_get_catalogs         READ: catalogs of the business a pixel is connected to
 *   meta_event_source_get_health           READ: a pixel's firing state + its catalog connections
 *   meta_event_source_get_recommendations  READ: what to fix so a catalog's events match its products
 *   meta_event_source_connect              connect a pixel to a catalog     (preview → confirm)
 *   meta_event_source_disconnect           disconnect a pixel from a catalog (preview → confirm)
 *   meta_send_test_event                   ENG-3060: one Conversions API event with a test_event_code (preview → confirm)
 *
 * Ownership: a catalog id must be in the account business's catalog set (readBusinessCatalogs,
 * as in ENG-2918/2925). A pixel id must be one of the resolved ad account's own pixels
 * (act_<id>/adspixels); a caller cannot connect, disconnect or inspect another account's pixel
 * by guessing its id. Connect/disconnect use the shared Zoma guard (zomaWriteGuard): the first
 * call returns a PREVIEW and a single-use preview_token bound to the user, catalog, pixel and the
 * catalog's current connections; the confirm repeats the call with that token. Every write is
 * read back from the catalog's external_event_sources edge; only CONFIRMED is success.
 */
import { createHash } from 'crypto';
import { getJwtSecret } from '../config/jwt';
import { MetaToolkitForbidden, MetaToolkitRefusal } from './metaToolkitErrors';
import { readBusinessCatalogs } from './metaToolkitCatalogs';
import {
  consumeToken, defaultConsumedTokenStore, type ConsumedTokens, previewFingerprint, previewResponse, previewTokenMatches,
  rememberTokenOutcome, replayTokenOutcome, type WriteVerification,
} from './zomaWriteGuard';

export const META_EVENT_SOURCE_TOOL_NAMES = [
  'meta_event_source_get', 'meta_event_source_get_catalogs', 'meta_event_source_get_health',
  'meta_event_source_get_recommendations', 'meta_event_source_connect', 'meta_event_source_disconnect',
  'meta_send_test_event',
] as const;
export type MetaEventSourceToolName = (typeof META_EVENT_SOURCE_TOOL_NAMES)[number];

export function isMetaEventSourceTool(name: string): name is MetaEventSourceToolName {
  return (META_EVENT_SOURCE_TOOL_NAMES as readonly string[]).includes(name);
}

/** Entity + action of the tools that change Meta state (write scope + write metering). */
export const EVENT_SOURCE_WRITE_KIND: Partial<Record<MetaEventSourceToolName, { entityType: 'CATALOG_EVENT_SOURCE' | 'DATASET_TEST_EVENT'; action: 'CREATE' | 'DELETE' }>> = {
  meta_send_test_event: { entityType: 'DATASET_TEST_EVENT', action: 'CREATE' },
  meta_event_source_connect: { entityType: 'CATALOG_EVENT_SOURCE', action: 'CREATE' },
  meta_event_source_disconnect: { entityType: 'CATALOG_EVENT_SOURCE', action: 'DELETE' },
};

export function isMetaEventSourceWrite(name: string): boolean {
  return isMetaEventSourceTool(name) && EVENT_SOURCE_WRITE_KIND[name] !== undefined;
}

const PIXEL_FIELDS = 'id,name,last_fired_time,is_unavailable,creation_time';
const EVENT_SOURCE_FIELDS = 'id,name';
const STALE_FIRE_MS = 24 * 60 * 60 * 1000;

const ACCOUNT_PROP = { account_id: { type: 'string', description: 'Optional Meta ad account id; defaults to the only connected account.' } };
const CATALOG_PROP = { catalog_id: { type: 'string', description: 'Numeric product catalog id (from meta_list_catalogs).' } };
const PIXEL_PROP = { pixel_id: { type: 'string', description: 'Numeric Meta pixel / dataset id owned by this ad account.' } };
const CONFIRM_PROPS = {
  confirm: { type: 'boolean', description: 'Omit to get a PREVIEW (nothing changes). Set true only after the user explicitly approved that preview, together with its preview_token.' },
  preview_token: { type: 'string', description: 'The preview_token of the preview the user approved. Single use, 15 minutes; repeat the previewed arguments exactly.' },
};

export const META_EVENT_SOURCE_TOOL_DEFINITIONS = [
  {
    name: 'meta_event_source_get',
    description: 'Read-only. List the event sources (pixels / datasets) connected to a catalog the ad account\'s business can use.',
    inputSchema: { type: 'object', properties: { ...ACCOUNT_PROP, ...CATALOG_PROP }, required: ['catalog_id'], additionalProperties: false },
  },
  {
    name: 'meta_event_source_get_catalogs',
    description: 'Read-only. List the business catalogs a pixel of this ad account is connected to.',
    inputSchema: { type: 'object', properties: { ...ACCOUNT_PROP, ...PIXEL_PROP }, required: ['pixel_id'], additionalProperties: false },
  },
  {
    name: 'meta_event_source_get_health',
    description: 'Read-only. Health of one pixel of this ad account: whether it is available, when it last fired, and which business catalogs it is connected to. If the business cannot be read, healthy and connected_catalogs are null and connected_catalogs_reason says why.',
    inputSchema: { type: 'object', properties: { ...ACCOUNT_PROP, ...PIXEL_PROP }, required: ['pixel_id'], additionalProperties: false },
  },
  {
    name: 'meta_event_source_get_recommendations',
    description: 'Read-only. Recommendations for a catalog\'s event sources: missing connection, pixels that are not firing, and Meta\'s event-related catalog diagnostics.',
    inputSchema: { type: 'object', properties: { ...ACCOUNT_PROP, ...CATALOG_PROP }, required: ['catalog_id'], additionalProperties: false },
  },
  {
    name: 'meta_event_source_connect',
    description: 'Connect a pixel of this ad account to a business catalog (needed for Advantage+ catalog ads). Two calls: PREVIEW + preview_token, then confirm=true with the token. Verified by read-back.',
    inputSchema: { type: 'object', properties: { ...ACCOUNT_PROP, ...CATALOG_PROP, ...PIXEL_PROP, ...CONFIRM_PROPS }, required: ['catalog_id', 'pixel_id'], additionalProperties: false },
  },
  {
    name: 'meta_event_source_disconnect',
    description: 'Disconnect a pixel of this ad account from a business catalog. Catalog ads lose that pixel\'s event matching. Two calls: PREVIEW + preview_token, then confirm=true with the token. Verified by read-back.',
    inputSchema: { type: 'object', properties: { ...ACCOUNT_PROP, ...CATALOG_PROP, ...PIXEL_PROP, ...CONFIRM_PROPS }, required: ['catalog_id', 'pixel_id'], additionalProperties: false },
  },
  {
    // ENG-3060. The name and description are model-facing copy awaiting approval (see the PR).
    name: 'meta_send_test_event',
    description: 'Send one Conversions API test event to a dataset (pixel) of this ad account, to check that server events arrive. Requires the test_event_code shown in Events Manager > Test Events. Meta does not drop test events: they count toward targeting and ads measurement. Email, phone and external_id are hashed before sending. Two calls: PREVIEW + preview_token, then confirm=true with the token. Returns what Meta answered (events_received, fbtrace_id, messages); it does not check that the event shows in Events Manager.',
    inputSchema: {
      type: 'object',
      properties: {
        ...ACCOUNT_PROP, ...PIXEL_PROP,
        test_event_code: { type: 'string', description: 'Required. The code from Events Manager > Test Events (for example TEST12345).' },
        event_name: { type: 'string', description: 'Standard or custom event name, for example Purchase or Lead.' },
        action_source: { type: 'string', enum: ['website', 'app', 'email', 'phone_call', 'chat', 'physical_store', 'system_generated', 'business_messaging', 'other'], description: 'Where the conversion happened.' },
        event_source_url: { type: 'string', description: 'Page URL of the event. Required when action_source is website.' },
        event_id: { type: 'string', description: 'Optional id Meta uses to deduplicate against the same browser event.' },
        user_data: {
          type: 'object',
          description: 'At least one field. email, phone (with country code) and external_id are hashed (SHA-256) before sending; the others are sent as given, as Meta requires.',
          properties: {
            email: { type: 'string' }, phone: { type: 'string' }, external_id: { type: 'string' },
            client_ip_address: { type: 'string' }, client_user_agent: { type: 'string' }, fbc: { type: 'string' }, fbp: { type: 'string' },
          },
          additionalProperties: false,
        },
        custom_data: {
          type: 'object',
          properties: { value: { type: 'number' }, currency: { type: 'string', description: 'ISO 4217 code, for example USD.' } },
          additionalProperties: false,
        },
        ...CONFIRM_PROPS,
      },
      required: ['pixel_id', 'test_event_code', 'event_name', 'action_source', 'user_data'],
      additionalProperties: false,
    },
  },
];

const ACTION_SOURCES = ['website', 'app', 'email', 'phone_call', 'chat', 'physical_store', 'system_generated', 'business_messaging', 'other'];
const SHA256_RE = /^[a-f0-9]{64}$/;
const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const shortText = (v: unknown, max: number) => (typeof v === 'string' && v.trim() !== '' && v.length <= max ? v.trim() : null);

/**
 * Build the Conversions API user_data from the caller's fields. Meta's customer information
 * parameters: em = trim + lowercase, ph = digits only without leading zeros, both SHA-256
 * (hashing required); external_id hashing recommended; client_ip_address, client_user_agent,
 * fbc and fbp must not be hashed. A value that is already a SHA-256 hex digest is sent as is.
 */
function capiUserData(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new MetaToolkitRefusal('user_data must be an object with at least one field.');
  const input = raw as Record<string, unknown>;
  assertOnlyKeys(input, ['email', 'phone', 'external_id', 'client_ip_address', 'client_user_agent', 'fbc', 'fbp']);
  const out: Record<string, unknown> = {};
  const hashed = (key: string, normalize: (v: string) => string | null) => {
    if (input[key] === undefined) return null;
    const v = shortText(input[key], 320);
    if (!v) throw new MetaToolkitRefusal(`user_data.${key} must be a non-empty string.`);
    if (SHA256_RE.test(v.toLowerCase())) return [v.toLowerCase()];
    const normalized = normalize(v);
    if (!normalized) throw new MetaToolkitRefusal(`user_data.${key} is not a valid value. Nothing was sent.`);
    return [sha256(normalized)];
  };
  const em = hashed('email', (v) => (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? v.toLowerCase() : null));
  const ph = hashed('phone', (v) => { const d = v.replace(/\D/g, '').replace(/^0+/, ''); return d.length >= 7 && d.length <= 15 ? d : null; });
  const externalId = hashed('external_id', (v) => v);
  if (em) out.em = em;
  if (ph) out.ph = ph;
  if (externalId) out.external_id = externalId;
  for (const key of ['client_ip_address', 'client_user_agent', 'fbc', 'fbp']) {
    if (input[key] === undefined) continue;
    const v = shortText(input[key], 1024);
    if (!v) throw new MetaToolkitRefusal(`user_data.${key} must be a non-empty string.`);
    out[key] = v;
  }
  if (Object.keys(out).length === 0) throw new MetaToolkitRefusal('user_data needs at least one field (email, phone, external_id, client_ip_address + client_user_agent, fbc or fbp).');
  return out;
}

const READ_PATH_RE = /^(act_\d+(\/adspixels)?|\d+(\/(owned_product_catalogs|client_product_catalogs|external_event_sources|diagnostics|stats))?)$/;
const WRITE_PATH_RE = /^\d+\/external_event_sources$/;
const TEST_EVENT_PATH_RE = /^\d+\/events$/;

export interface MetaEventSourceDeps {
  readGraph: (userId: string, accountId: string, path: string, params: Record<string, string>) => Promise<any>;
  writeGraph: (userId: string, accountId: string, method: 'POST' | 'DELETE', path: string, params: Record<string, string>) => Promise<any>;
  secret: () => string;
  now: () => number;
  consumedTokens: ConsumedTokens;
  tokenOutcomes: Map<string, { exp: number; outcome: any }>;
}

const ams = async () => (await import('../services/agentModeService')).agentModeService;

const defaultDeps: MetaEventSourceDeps = {
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

type FiringState = 'UNAVAILABLE' | 'NEVER_FIRED' | 'NOT_FIRING' | 'ACTIVE';

/** last_fired_time as epoch ms: Graph's ISO string, or unix seconds / ms if it arrives numeric. */
function parseFiredTime(raw: unknown): number {
  if (raw === undefined || raw === null || raw === '') return NaN;
  if (typeof raw === 'number' || /^\d+$/.test(String(raw))) {
    const n = Number(raw);
    return n < 1e12 ? n * 1000 : n;
  }
  return Date.parse(String(raw));
}

function firingState(pixel: any, now: number): FiringState {
  if (pixel?.is_unavailable === true) return 'UNAVAILABLE';
  const fired = parseFiredTime(pixel?.last_fired_time);
  if (!Number.isFinite(fired)) return 'NEVER_FIRED';
  return now - fired > STALE_FIRE_MS ? 'NOT_FIRING' : 'ACTIVE';
}

/** Events Meta counted for the pixel over its `/stats` buckets (aggregation=event). */
function countEvents(stats: any): number {
  let total = 0;
  for (const bucket of list(stats)) {
    for (const row of Array.isArray(bucket?.data) ? bucket.data : []) {
      const n = Number(row?.count);
      if (Number.isFinite(n) && n > 0) total += n;
    }
  }
  return total;
}

/** Run one ENG-2927 tool. `accountId` is the resolved, ownership-checked ad account. */
export async function runMetaEventSourceTool(
  name: MetaEventSourceToolName, userId: string, accountId: string, rawArgs: any, deps: MetaEventSourceDeps = defaultDeps,
) {
  const { confirm, preview_token: previewToken, ...args } = rawArgs ?? {};
  const rawRead = async (path: string, params: Record<string, string>) => {
    if (!READ_PATH_RE.test(path)) throw new MetaToolkitRefusal('Unsupported event source read.');
    return deps.readGraph(userId, accountId, path, params);
  };
  const read = async (path: string, params: Record<string, string>) => {
    if (!READ_PATH_RE.test(path)) throw new MetaToolkitRefusal('Unsupported event source read.');
    try {
      return await deps.readGraph(userId, accountId, path, params);
    } catch (error: any) {
      throw new MetaToolkitRefusal(`Could not read from Meta: ${metaMessage(error)}. Nothing was changed.`);
    }
  };
  const account = `act_${String(accountId).replace(/^act_/, '')}`;

  // ENG-3060: a test event needs the account's own pixel, not a Business portfolio or catalog.
  if (name === 'meta_send_test_event') {
    assertOnlyKeys(args, ['account_id', 'pixel_id', 'test_event_code', 'event_name', 'action_source', 'event_source_url', 'event_id', 'user_data', 'custom_data']);
    // Checked first, before any Graph request: without the code this would be a production event.
    const code = shortText(args.test_event_code, 64);
    if (!code || !/^[A-Za-z0-9_-]+$/.test(code)) throw new MetaToolkitRefusal('test_event_code is required (the code from Events Manager > Test Events). Nothing was sent.');
    const eventName = shortText(args.event_name, 100);
    if (!eventName) throw new MetaToolkitRefusal('event_name is required.');
    if (!ACTION_SOURCES.includes(args.action_source)) throw new MetaToolkitRefusal(`action_source must be one of: ${ACTION_SOURCES.join(', ')}.`);
    const url = args.event_source_url === undefined ? null : shortText(args.event_source_url, 2000);
    if (args.event_source_url !== undefined && !(url && /^https?:\/\//i.test(url))) throw new MetaToolkitRefusal('event_source_url must be an http(s) URL.');
    if (args.action_source === 'website' && !url) throw new MetaToolkitRefusal('event_source_url is required when action_source is website.');
    const eventId = args.event_id === undefined ? null : shortText(args.event_id, 200);
    if (args.event_id !== undefined && !eventId) throw new MetaToolkitRefusal('event_id must be a non-empty string.');
    const userData = capiUserData(args.user_data);
    let customData: Record<string, unknown> | null = null;
    if (args.custom_data !== undefined) {
      if (!args.custom_data || typeof args.custom_data !== 'object' || Array.isArray(args.custom_data)) throw new MetaToolkitRefusal('custom_data must be an object.');
      assertOnlyKeys(args.custom_data, ['value', 'currency']);
      const { value, currency } = args.custom_data;
      if (value !== undefined && !(typeof value === 'number' && Number.isFinite(value) && value >= 0)) throw new MetaToolkitRefusal('custom_data.value must be a number of 0 or more.');
      if (currency !== undefined && !/^[A-Za-z]{3}$/.test(String(currency))) throw new MetaToolkitRefusal('custom_data.currency must be a 3-letter ISO code.');
      customData = { ...(value !== undefined ? { value } : {}), ...(currency !== undefined ? { currency: String(currency).toUpperCase() } : {}) };
    }

    const pixelId = String(args.pixel_id ?? '');
    if (!numericId(pixelId)) throw new MetaToolkitRefusal('pixel_id must be a numeric Meta pixel / dataset id.');
    const pixels = list(await read(`${account}/adspixels`, { fields: PIXEL_FIELDS, limit: '100' }));
    if (!pixels.some((p: any) => String(p?.id) === pixelId)) throw new MetaToolkitForbidden(`Dataset ${pixelId} is not a dataset of this ad account. Nothing was sent.`);

    const event = {
      event_name: eventName, action_source: args.action_source,
      ...(url ? { event_source_url: url } : {}), ...(eventId ? { event_id: eventId } : {}),
      user_data: userData, ...(customData && Object.keys(customData).length ? { custom_data: customData } : {}),
    };
    const fingerprint = previewFingerprint({ userId, tool: name, accountId, pixelId, code, event });
    const now = deps.now();
    const secret = deps.secret();
    const previewText = [
      'PREVIEW — nothing has been sent yet.',
      `Send one "${eventName}" event (${args.action_source}) to dataset ${pixelId} with test_event_code ${code}.`,
      `User data fields: ${Object.keys(userData).join(', ')} (email, phone and external_id are sent hashed).`,
      'Meta: events sent with test_event_code are not dropped. They flow into Events Manager and are used for targeting and ads measurement. A test Purchase can count as a conversion.',
    ].join('\n');
    const freshPreview = () => previewResponse({ secret, userId, now, fingerprint, preview: previewText });
    if (confirm !== true) return freshPreview();
    if (!previewTokenMatches(previewToken, secret, userId, fingerprint, now)) {
      return {
        ...freshPreview(),
        status: 'PREVIEW_MISMATCH',
        note: 'The confirmation did not match a current preview (missing, expired, or the arguments changed). Nothing was sent. Show this new preview and get approval again.',
      };
    }
    if (!(await consumeToken(deps.consumedTokens, previewToken, now))) {
      const replay = replayTokenOutcome(deps.tokenOutcomes, previewToken, now);
      if (replay) return replay;
      throw new MetaToolkitRefusal('This preview_token was already used. Run a new preview to send another test event.');
    }
    const outcome = await (async () => {
      const path = `${pixelId}/events`;
      if (!TEST_EVENT_PATH_RE.test(path)) throw new MetaToolkitRefusal('Unsupported test event write.');
      let res: any;
      try {
        res = await deps.writeGraph(userId, accountId, 'POST', path, {
          data: JSON.stringify([{ ...event, event_time: Math.floor(now / 1000) }]), test_event_code: code,
        });
      } catch (error: any) {
        const unknown = error?.outcomeUnknown === true || (error?.outcomeUnknown === undefined && !error?.metaError);
        return unknown
          ? { success: false, verification: 'UNCONFIRMED' as WriteVerification, id: pixelId, message: `UNCONFIRMED: the test event send failed without a definite answer from Meta (${metaMessage(error)}). It may or may not have been received; check Events Manager > Test Events before retrying.` }
          : { status: 'FAILED', success: false, id: pixelId, meta_error: error?.metaError ?? null, message: `Meta refused the test event: ${metaMessage(error)}.` };
      }
      const received = Number(res?.events_received);
      const ok = Number.isFinite(received) && received >= 1;
      // There is no Graph read for a single received event, so Meta's own receipt count is the
      // only evidence. CONFIRMED here means "Meta answered events_received >= 1", nothing more.
      return {
        success: ok, verification: (ok ? 'CONFIRMED' : 'MISMATCH') as WriteVerification, id: pixelId, test_event_code: code,
        events_received: Number.isFinite(received) ? received : null, fbtrace_id: res?.fbtrace_id ?? null, messages: Array.isArray(res?.messages) ? res.messages : [],
        message: ok
          ? `Meta answered events_received=${received}. This does not show that the event is visible in Events Manager; look in Events Manager > Test Events for code ${code}.`
          : 'Meta answered without an events_received count. Do not report this as received; check Events Manager > Test Events.',
      };
    })();
    return rememberTokenOutcome(deps.tokenOutcomes, previewToken, outcome);
  }

  // get_health reads the business best-effort, after the pixel's firing state (which needs no business).
  let catalogs = new Map<string, any>();
  if (name !== 'meta_event_source_get_health') {
    const business = await readBusinessCatalogs(read, accountId);
    if (!business.businessId) throw new MetaToolkitRefusal('This ad account is not in a Meta Business portfolio, so it has no product catalogs.');
    catalogs = business.catalogs;
  }

  const ownedCatalog = (raw: unknown): string => {
    const id = String(raw ?? '');
    if (!numericId(id)) throw new MetaToolkitRefusal('catalog_id must be a numeric Meta catalog id (see meta_list_catalogs).');
    if (!catalogs.has(id)) throw new MetaToolkitRefusal(`Catalog ${id} is not available to this ad account's business. Nothing was changed.`);
    return id;
  };
  let pixelsCache: Map<string, any> | null = null;
  const accountPixels = async () => {
    if (!pixelsCache) {
      pixelsCache = new Map(list(await read(`${account}/adspixels`, { fields: PIXEL_FIELDS, limit: '100' })).map((p: any) => [String(p?.id), p]));
    }
    return pixelsCache;
  };
  const ownedPixel = async (raw: unknown) => {
    const id = String(raw ?? '');
    if (!numericId(id)) throw new MetaToolkitRefusal('pixel_id must be a numeric Meta pixel id.');
    const pixel = (await accountPixels()).get(id);
    if (!pixel) throw new MetaToolkitRefusal(`Pixel ${id} is not a pixel of this ad account. Nothing was changed.`);
    return { id, pixel };
  };
  /*
   * The pixel's own last_fired_time can lag far behind (a Zoma user saw "last fired Nov 24" next to
   * 250+ PageViews today in event stats). A stale or missing last_fired_time is therefore only a
   * verdict after the freshest signal — the pixel's event counts for the last 24 hours — also says
   * nothing arrived. A failed stats read keeps the last_fired_time verdict; it never upgrades one.
   */
  const pixelState = async (pixel: any, now: number): Promise<{ state: FiringState; events_last_24h: number | null }> => {
    const base = firingState(pixel, now);
    if (base !== 'NOT_FIRING' && base !== 'NEVER_FIRED') return { state: base, events_last_24h: null };
    let events: number | null = null;
    try {
      events = countEvents(await deps.readGraph(userId, accountId, `${String(pixel?.id)}/stats`, {
        aggregation: 'event', start_time: String(Math.floor((now - STALE_FIRE_MS) / 1000)),
      }));
    } catch {
      events = null;
    }
    return { state: events !== null && events > 0 ? 'ACTIVE' : base, events_last_24h: events };
  };
  const connected = async (catalogId: string) => list(await read(`${catalogId}/external_event_sources`, { fields: EVENT_SOURCE_FIELDS, limit: '100' }))
    .map((s: any) => ({ id: String(s?.id ?? ''), name: s?.name ?? null }));
  const catalogsOf = async (pixelId: string) => {
    const out: Array<{ catalog_id: string; name: unknown }> = [];
    for (const [catalogId, c] of catalogs) {
      if ((await connected(catalogId)).some((s) => s.id === pixelId)) out.push({ catalog_id: catalogId, name: c?.name ?? null });
    }
    return out;
  };

  switch (name) {
    case 'meta_event_source_get': {
      assertOnlyKeys(args, ['account_id', 'catalog_id']);
      const catalogId = ownedCatalog(args.catalog_id);
      return { account_id: accountId, catalog_id: catalogId, event_sources: await connected(catalogId) };
    }

    case 'meta_event_source_get_catalogs': {
      assertOnlyKeys(args, ['account_id', 'pixel_id']);
      const { id } = await ownedPixel(args.pixel_id);
      return { account_id: accountId, pixel_id: id, catalogs: await catalogsOf(id) };
    }

    case 'meta_event_source_get_health': {
      assertOnlyKeys(args, ['account_id', 'pixel_id']);
      const { id, pixel } = await ownedPixel(args.pixel_id);
      const { state, events_last_24h: eventsLast24h } = await pixelState(pixel, deps.now());
      let catalogsUnavailable: string | null = null;
      try {
        // rawRead: the reason carries Meta's own message, not read()'s "Nothing was changed." refusal wrapper.
        const business = await readBusinessCatalogs(rawRead, accountId);
        if (business.businessId) catalogs = business.catalogs;
        else catalogsUnavailable = 'not in a Meta Business portfolio';
      } catch (error: any) {
        const message = metaMessage(error);
        catalogsUnavailable = /business_management/i.test(message)
          ? 'missing business_management permission'
          : `could not read the business or its catalogs (${message})`;
      }
      const connectedCatalogs = catalogsUnavailable ? null : await catalogsOf(id);
      return {
        account_id: accountId, pixel_id: id, name: pixel?.name ?? null, state,
        last_fired_time: pixel?.last_fired_time ?? null,
        ...(eventsLast24h !== null ? { events_last_24h: eventsLast24h } : {}),
        ...(state === 'ACTIVE' && eventsLast24h !== null && eventsLast24h > 0 && firingState(pixel, deps.now()) !== 'ACTIVE'
          ? { state_source: 'event_stats', note: `Meta's last_fired_time is stale, but its event stats show ${eventsLast24h} events in the last 24 hours, so the pixel is firing.` }
          : {}),
        connected_catalogs: connectedCatalogs,
        ...(catalogsUnavailable ? { connected_catalogs_reason: catalogsUnavailable } : {}),
        healthy: connectedCatalogs === null ? null : state === 'ACTIVE' && connectedCatalogs.length > 0,
      };
    }

    case 'meta_event_source_get_recommendations': {
      assertOnlyKeys(args, ['account_id', 'catalog_id']);
      const catalogId = ownedCatalog(args.catalog_id);
      const [sources, pixels, diagnostics] = await Promise.all([
        connected(catalogId), accountPixels(),
        read(`${catalogId}/diagnostics`, { fields: 'type,severity,title,diagnostics,number_of_affected_items,call_to_action', limit: '100' }),
      ]);
      const now = deps.now();
      const recommendations: Array<{ type: string; severity: string; message: string; pixel_id?: string }> = [];
      if (sources.length === 0) {
        // Bounded: one stats read per stale pixel, for at most 20 pixels.
        const states = await Promise.all([...pixels.values()].slice(0, 20).map(async (p) => ({ p, s: (await pixelState(p, now)).state })));
        const candidates = states.filter(({ s }) => s === 'ACTIVE').map(({ p }) => String(p.id));
        recommendations.push({
          type: 'NO_EVENT_SOURCE', severity: 'MUST_FIX',
          message: candidates.length
            ? `No event source is connected. Connect an active pixel of this account (${candidates.join(', ')}) with meta_event_source_connect.`
            : 'No event source is connected, and this account has no pixel that fired in the last 24 hours.',
        });
      }
      for (const s of sources) {
        const own = pixels.get(s.id);
        if (!own) continue; // another account's pixel: not inspected
        const { state } = await pixelState(own, now);
        if (state !== 'ACTIVE') recommendations.push({ type: `PIXEL_${state}`, severity: 'MUST_FIX', pixel_id: s.id, message: `Connected pixel ${s.id} is ${state.toLowerCase().replace(/_/g, ' ')}; catalog events cannot match products.` });
      }
      for (const d of list(diagnostics)) {
        if (!/EVENT/i.test(String(d?.type ?? ''))) continue;
        recommendations.push({ type: String(d.type), severity: String(d?.severity ?? 'UNKNOWN'), message: String(d?.title ?? '') });
      }
      return { account_id: accountId, catalog_id: catalogId, event_sources: sources, recommendations };
    }

    case 'meta_event_source_connect':
    case 'meta_event_source_disconnect': {
      const connecting = name === 'meta_event_source_connect';
      assertOnlyKeys(args, ['account_id', 'catalog_id', 'pixel_id']);
      const catalogId = ownedCatalog(args.catalog_id);
      const { id: pixelId } = await ownedPixel(args.pixel_id);
      const before = await connected(catalogId);
      const isConnected = before.some((s) => s.id === pixelId);
      if (connecting && isConnected) return { success: true, id: pixelId, catalog_id: catalogId, status: 'NO_CHANGE', message: `Pixel ${pixelId} is already connected to catalog ${catalogId}. Nothing was changed.` };
      if (!connecting && !isConnected) return { success: true, id: pixelId, catalog_id: catalogId, status: 'NO_CHANGE', message: `Pixel ${pixelId} is not connected to catalog ${catalogId}. Nothing was changed.` };

      const fingerprint = previewFingerprint({ userId, tool: name, accountId, catalogId, pixelId, before: before.map((s) => s.id).sort() });
      const now = deps.now();
      const secret = deps.secret();
      const previewText = [
        'PREVIEW — nothing has changed yet.',
        connecting
          ? `Connect pixel ${pixelId} to catalog ${catalogId} ("${catalogs.get(catalogId)?.name ?? ''}").`
          : `Disconnect pixel ${pixelId} from catalog ${catalogId} ("${catalogs.get(catalogId)?.name ?? ''}"). Catalog ads stop matching this pixel's events to products.`,
        `Currently connected: ${before.length ? before.map((s) => s.id).join(', ') : 'none'}.`,
      ].join('\n');
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

      const what = connecting ? 'event source connect' : 'event source disconnect';
      const outcome = await (async () => {
        const path = `${catalogId}/external_event_sources`;
        if (!WRITE_PATH_RE.test(path)) throw new MetaToolkitRefusal('Unsupported event source write.');
        try {
          await deps.writeGraph(userId, accountId, connecting ? 'POST' : 'DELETE', path, { external_event_sources: JSON.stringify([pixelId]) });
        } catch (error: any) {
          const unknown = error?.outcomeUnknown === true || (error?.outcomeUnknown === undefined && !error?.metaError);
          return unknown
            ? { success: false, verification: 'UNCONFIRMED' as WriteVerification, id: pixelId, catalog_id: catalogId, message: `UNCONFIRMED: the ${what} failed without a definite answer from Meta (${metaMessage(error)}). Check it before retrying.` }
            : { status: 'FAILED', success: false, id: pixelId, catalog_id: catalogId, message: `Meta refused the ${what}: ${metaMessage(error)}.` };
        }
        let verification: WriteVerification;
        try {
          const present = (await connected(catalogId)).some((s) => s.id === pixelId);
          verification = present === connecting ? 'CONFIRMED' : 'MISMATCH';
        } catch {
          verification = 'UNCONFIRMED';
        }
        return {
          success: verification === 'CONFIRMED', verification, id: pixelId, catalog_id: catalogId,
          message: verification === 'CONFIRMED'
            ? `${what} confirmed by read-back.`
            : verification === 'MISMATCH'
              ? `Meta accepted the ${what}, but the read-back does not show it. Check catalog ${catalogId} before doing anything else.`
              : `UNCONFIRMED: Meta accepted the ${what}, but the read-back failed. Do not report this as done; check it first.`,
        };
      })();
      return rememberTokenOutcome(deps.tokenOutcomes, previewToken, outcome);
    }
  }
}
