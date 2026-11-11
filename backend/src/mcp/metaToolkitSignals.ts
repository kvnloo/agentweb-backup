import axios from 'axios';
import { MetaToolkitRefusal } from './metaToolkitErrors';
import { classifyMetaReadFailure, META_PERMISSION_MESSAGE, META_RECONNECT_MESSAGE } from '../utils/metaReadErrorClass';

export const SIGNAL_FIELDS = {
  datasets: 'id,name,last_fired_time,is_created_by_business',
  details: 'id,name,last_fired_time,is_created_by_business,owner_business',
  conversions: 'id,name,pixel,rule,custom_event_type,is_archived',
};

const names = ['ads_get_datasets', 'ads_get_dataset_details', 'ads_get_dataset_stats', 'ads_pixel_event_read', 'ads_get_customconversions'] as const;
export function isSignalsRead(name: string): boolean { return (names as readonly string[]).includes(name); }
export const SIGNAL_READ_DEFINITIONS = names.map((name) => ({
  name,
  description: ({
    ads_get_datasets: 'List datasets (ad pixels) connected to the selected Meta ad account. Read-only; returns one page and paging cursors.',
    ads_get_dataset_details: 'Read a dataset/pixel belonging to the selected ad account.',
    ads_get_dataset_stats: 'Read dataset/pixel event stats for the selected ad account.',
    ads_pixel_event_read: 'Read existing pixel event rules through the documented event_rules edge. Availability depends on Meta permissions and API version.',
    ads_get_customconversions: 'List custom conversions in the selected Meta ad account. Read-only; returns one page and paging cursors.',
  })[name],
  inputSchema: {
    type: 'object',
    properties: {
      account_id: { type: 'string', description: 'Connected Meta ad account; optional when exactly one is connected.' },
      ...(!['ads_get_datasets', 'ads_get_customconversions'].includes(name) ? { pixel_id: { type: 'string', pattern: '^[0-9]+$' } } : {}),
      ...(['ads_get_datasets', 'ads_get_customconversions', 'ads_pixel_event_read'].includes(name) ? {
        limit: { type: 'integer', minimum: 1, maximum: 100 }, after: { type: 'string' },
      } : {}),
      ...(name === 'ads_get_dataset_stats' ? {
        aggregation: { type: 'string', enum: ['event', 'match_keys', 'url', 'host', 'device_type', 'pixel_fire'] },
        start_time: { type: 'string' }, end_time: { type: 'string' },
      } : {}),
    },
    ...(!['ads_get_datasets', 'ads_get_customconversions'].includes(name) ? { required: ['pixel_id'] } : {}),
    additionalProperties: false,
  },
}));

/**
 * Graph pages go back to an external caller: keep the cursors (enough to page with `after`)
 * and drop paging.next / previous, whose URLs carry the access token.
 */
export function sanitizePaging<T>(body: T): T {
  const b: any = body;
  if (!b || typeof b !== 'object' || !b.paging) return body;
  const { paging, ...rest } = b;
  const cursors = paging?.cursors;
  return {
    ...rest,
    paging: {
      ...(cursors ? { cursors: { ...(cursors.before !== undefined ? { before: cursors.before } : {}), ...(cursors.after !== undefined ? { after: cursors.after } : {}) } } : {}),
      has_next: !!paging?.next,
      has_previous: !!paging?.previous,
    },
  } as T;
}

/** Unix seconds or an ISO date; NaN when neither. */
function toEpochSeconds(v: string): number {
  return /^\d{9,10}$/.test(v) ? Number(v) : Date.parse(v) / 1000;
}

// Only an upstream HTTP response or a recognized transport code is evidence of
// a Meta/network failure. Local exceptions must propagate to the HTTP 500 path.
const NETWORK_ERROR_CODES = new Set([
  'ECONNABORTED', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT',
  'ESOCKETTIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'ENETUNREACH',
  'EHOSTUNREACH', 'ERR_NETWORK',
]);
function isUpstreamFailure(error: any): boolean {
  return !!error?.response || NETWORK_ERROR_CODES.has(error?.code);
}

/** Uses the existing Graph HTTP client; credentials are resolved server-side, never caller supplied. */
export async function executeSignalsRead(
  name: string, args: any, credentials: { accountId: string; accessToken: string },
  graph: Pick<typeof axios, 'get'> = axios,
) {
  try {
    return sanitizePaging(await runSignalsRead(name, args, credentials, graph));
  } catch (error: any) {
    if (error instanceof MetaToolkitRefusal || !isUpstreamFailure(error)) throw error;
    return signalsReadFailure(error);
  }
}

/**
 * Meta refusing or failing a signals read is a result the caller can act on (same shape as
 * list_meta_ads_campaigns), not a 500. Only Meta's own error message is surfaced — never the
 * request URL, which carries the access token.
 */
export function signalsReadFailure(error: any) {
  const failure = classifyMetaReadFailure(error);
  const graphError = error?.response?.data?.error;
  const base = typeof graphError?.message === 'string' && graphError.message
    ? graphError.message
    : failure.errorClass === 'timeout' ? 'Meta did not respond in time.' : 'Meta could not complete this read.';
  const message = failure.kind === 'credential'
    ? `${base} ${failure.tokenInvalid ? META_RECONNECT_MESSAGE : META_PERMISSION_MESSAGE}`
    : failure.kind === 'transient' ? `${base} Meta is temporarily unavailable or throttling; try again shortly.` : base;
  return {
    success: false,
    message,
    error: base,
    errorClass: failure.errorClass,
    errorType: failure.kind === 'credential' ? 'configuration' : failure.kind,
    ...(graphError?.code !== undefined ? { metaErrorCode: graphError.code } : {}),
    ...(error?.response?.status ? { code: error.response.status } : {}),
  };
}

async function runSignalsRead(
  name: string, args: any, credentials: { accountId: string; accessToken: string },
  graph: Pick<typeof axios, 'get'>,
) {
  const def = SIGNAL_READ_DEFINITIONS.find((d) => d.name === name);
  if (!def) throw new MetaToolkitRefusal('Unknown signals read tool.');
  // LLM-driven clients often fill optional fields with ""; treat blank optional strings as absent.
  args = Object.fromEntries(Object.entries(args ?? {}).filter(([k, v]) => !(k !== 'pixel_id' && typeof v === 'string' && v.trim() === '')));
  for (const key of Object.keys(args)) {
    if (!Object.prototype.hasOwnProperty.call(def.inputSchema.properties, key)) throw new MetaToolkitRefusal(`Unsupported signals argument: ${key}`);
  }
  // Credential fallback must never silently switch accounts: the resolved account has to be the one asked for.
  const bare = (id: unknown) => String(id).replace(/^act_/, '');
  if (args.account_id !== undefined && bare(args.account_id) !== bare(credentials.accountId)) {
    throw new MetaToolkitRefusal('Resolved Meta credentials do not match the selected ad account.');
  }
  if (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 100)) throw new MetaToolkitRefusal('limit must be an integer from 1 to 100.');
  for (const key of ['after', 'start_time', 'end_time', 'aggregation']) {
    if (args[key] !== undefined && typeof args[key] !== 'string') throw new MetaToolkitRefusal(`${key} must be a string.`);
  }
  if (args.aggregation !== undefined && !['event', 'match_keys', 'url', 'host', 'device_type', 'pixel_fire'].includes(args.aggregation)) throw new MetaToolkitRefusal('Unsupported aggregation.');
  for (const key of ['start_time', 'end_time']) {
    if (args[key] !== undefined && !Number.isFinite(toEpochSeconds(args[key]))) throw new MetaToolkitRefusal(`${key} must be a unix timestamp or an ISO 8601 date.`);
  }
  if (args.start_time !== undefined && args.end_time !== undefined && toEpochSeconds(args.start_time) > toEpochSeconds(args.end_time)) {
    throw new MetaToolkitRefusal('start_time must be before end_time.');
  }
  const base = `https://graph.facebook.com/${process.env.META_API_VERSION || 'v25.0'}`;
  const account = `act_${credentials.accountId.replace(/^act_/, '')}`;
  // A single transient Meta failure (5xx, throttle, timeout) is retried briefly, like the campaign list.
  const get = async (path: string, params: Record<string, unknown> = {}) => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return (await graph.get(`${base}/${path}`, { params: { ...params, access_token: credentials.accessToken }, timeout: 15_000 })).data;
      } catch (error: any) {
        if (!isUpstreamFailure(error) || attempt >= 2 || classifyMetaReadFailure(error).kind !== 'transient') throw error;
        await new Promise((resolve) => setTimeout(resolve, process.env.NODE_ENV === 'test' ? 0 : 500 * (attempt + 1)));
      }
    }
  };
  const page = { limit: args.limit ?? 100, ...(args.after !== undefined ? { after: args.after } : {}) };
  if (name === 'ads_get_datasets') return get(`${account}/adspixels`, { fields: SIGNAL_FIELDS.datasets, ...page });
  if (name === 'ads_get_customconversions') return get(`${account}/customconversions`, { fields: SIGNAL_FIELDS.conversions, ...page });
  if (typeof args.pixel_id !== 'string' || !/^\d+$/.test(args.pixel_id)) throw new MetaToolkitRefusal('pixel_id must be a numeric string.');
  // Pixel nodes are globally addressed: prove membership in this selected account before reading.
  let after: string | undefined;
  const seen = new Set<string>();
  for (let pages = 0; ; pages += 1) {
    if (pages >= 50) throw new MetaToolkitRefusal('That pixel is not in the selected ad account.');
    const owned = await get(`${account}/adspixels`, { fields: 'id', limit: 100, ...(after ? { after } : {}) });
    if (owned?.data?.some((p: any) => String(p.id) === args.pixel_id)) break;
    const next = owned?.paging?.next ? owned?.paging?.cursors?.after : undefined;
    if (typeof next !== 'string' || !next || seen.has(next)) throw new MetaToolkitRefusal('That pixel is not in the selected ad account.');
    seen.add(next); after = next;
  }
  if (name === 'ads_get_dataset_details') return get(args.pixel_id, { fields: SIGNAL_FIELDS.details });
  if (name === 'ads_pixel_event_read') return get(`${args.pixel_id}/event_rules`, page);
  return get(`${args.pixel_id}/stats`, Object.fromEntries(['aggregation', 'start_time', 'end_time'].filter((k) => args[k] !== undefined).map((k) => [k, args[k]])));
}
