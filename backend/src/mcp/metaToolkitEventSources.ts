/**
 * ENG-2927 (catalog slice 4) — Zoma catalog event sources for external agents.
 *
 *   meta_event_source_get                  READ: event sources (pixels / datasets) connected to a catalog
 *   meta_event_source_get_catalogs         READ: catalogs of the business a pixel is connected to
 *   meta_event_source_get_health           READ: a pixel's firing state + its catalog connections
 *   meta_event_source_get_recommendations  READ: what to fix so a catalog's events match its products
 *   meta_event_source_connect              connect a pixel to a catalog     (preview → confirm)
 *   meta_event_source_disconnect           disconnect a pixel from a catalog (preview → confirm)
 *
 * Ownership: a catalog id must be in the account business's catalog set (readBusinessCatalogs,
 * as in ENG-2918/2925). A pixel id must be one of the resolved ad account's own pixels
 * (act_<id>/adspixels); a caller cannot connect, disconnect or inspect another account's pixel
 * by guessing its id. Connect/disconnect use the shared Zoma guard (zomaWriteGuard): the first
 * call returns a PREVIEW and a single-use preview_token bound to the user, catalog, pixel and the
 * catalog's current connections; the confirm repeats the call with that token. Every write is
 * read back from the catalog's external_event_sources edge; only CONFIRMED is success.
 */
import { getJwtSecret } from '../config/jwt';
import { MetaToolkitRefusal } from './metaToolkitErrors';
import { readBusinessCatalogs } from './metaToolkitCatalogs';
import {
  consumeToken, defaultConsumedTokenStore, type ConsumedTokens, previewFingerprint, previewResponse, previewTokenMatches,
  rememberTokenOutcome, replayTokenOutcome, type WriteVerification,
} from './zomaWriteGuard';

export const META_EVENT_SOURCE_TOOL_NAMES = [
  'meta_event_source_get', 'meta_event_source_get_catalogs', 'meta_event_source_get_health',
  'meta_event_source_get_recommendations', 'meta_event_source_connect', 'meta_event_source_disconnect',
] as const;
export type MetaEventSourceToolName = (typeof META_EVENT_SOURCE_TOOL_NAMES)[number];

export function isMetaEventSourceTool(name: string): name is MetaEventSourceToolName {
  return (META_EVENT_SOURCE_TOOL_NAMES as readonly string[]).includes(name);
}

/** Entity + action of the tools that change Meta state (write scope + write metering). */
export const EVENT_SOURCE_WRITE_KIND: Partial<Record<MetaEventSourceToolName, { entityType: 'CATALOG_EVENT_SOURCE'; action: 'CREATE' | 'DELETE' }>> = {
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
    description: 'Read-only. Health of one pixel of this ad account: whether it is available, when it last fired, and which business catalogs it is connected to.',
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
];

const READ_PATH_RE = /^(act_\d+(\/adspixels)?|\d+(\/(owned_product_catalogs|client_product_catalogs|external_event_sources|diagnostics|stats))?)$/;
const WRITE_PATH_RE = /^\d+\/external_event_sources$/;

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
  const read = async (path: string, params: Record<string, string>) => {
    if (!READ_PATH_RE.test(path)) throw new MetaToolkitRefusal('Unsupported event source read.');
    try {
      return await deps.readGraph(userId, accountId, path, params);
    } catch (error: any) {
      throw new MetaToolkitRefusal(`Could not read from Meta: ${metaMessage(error)}. Nothing was changed.`);
    }
  };
  const account = `act_${String(accountId).replace(/^act_/, '')}`;

  const { businessId, catalogs } = await readBusinessCatalogs(read, accountId);
  if (!businessId) throw new MetaToolkitRefusal('This ad account is not in a Meta Business portfolio, so it has no product catalogs.');

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
      const connectedCatalogs = await catalogsOf(id);
      return {
        account_id: accountId, pixel_id: id, name: pixel?.name ?? null, state,
        last_fired_time: pixel?.last_fired_time ?? null,
        ...(eventsLast24h !== null ? { events_last_24h: eventsLast24h } : {}),
        ...(state === 'ACTIVE' && firingState(pixel, deps.now()) !== 'ACTIVE'
          ? { state_source: 'event_stats', note: `Meta's last_fired_time is stale, but its event stats show ${eventsLast24h} events in the last 24 hours, so the pixel is firing.` }
          : {}),
        connected_catalogs: connectedCatalogs,
        healthy: state === 'ACTIVE' && connectedCatalogs.length > 0,
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
