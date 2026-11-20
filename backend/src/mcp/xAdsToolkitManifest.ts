/**
 * ENG-3142 — Zoma X (Twitter) Ads toolkit: manifest + reads (provider #3; Google's is
 * googleToolkitManifest.ts). Dark until ZOMA_X_ADS_ENABLED=true.
 *
 * Two tools, split so MCP annotations are honest (toolkitToolAnnotations.ts):
 *   - x_ads_read  (read-only): LIST_ACCOUNTS, LIST_FUNDING_INSTRUMENTS, LIST_CAMPAIGNS,
 *     LIST_LINE_ITEMS, LIST_PROMOTED_TWEETS, GET_STATS (synchronous stats, chunked into
 *     <=7-day windows — X's sync limit — and merged).
 *   - x_ads_write (guarded, xAdsToolkitWrites.ts): CAMPAIGN CREATE/UPDATE/PAUSE/ACTIVATE,
 *     LINE_ITEM CREATE/UPDATE/PAUSE/ACTIVATE, PROMOTED_TWEET CREATE.
 * Everything else is refused before any account or X call.
 */
import { MetaToolkitRefusal } from './metaToolkitErrors';
import { xAdsListAll, xAdsRequest, type XFetch } from '../services/xAdsClient';
import type { OAuth1Credentials } from '../utils/oauth1';

export const X_ADS_READ_TOOL = 'x_ads_read';
export const X_ADS_WRITE_TOOL = 'x_ads_write';
export const X_ADS_TOOL_NAMES = [X_ADS_READ_TOOL, X_ADS_WRITE_TOOL] as const;
export type XAdsToolName = (typeof X_ADS_TOOL_NAMES)[number];

export const X_ADS_READ_ACTIONS = [
  'LIST_ACCOUNTS', 'LIST_FUNDING_INSTRUMENTS', 'LIST_CAMPAIGNS', 'LIST_LINE_ITEMS', 'LIST_PROMOTED_TWEETS', 'GET_STATS',
] as const;

export const X_ADS_WRITES: Record<string, readonly string[]> = {
  CAMPAIGN: ['CREATE', 'UPDATE', 'PAUSE', 'ACTIVATE'],
  LINE_ITEM: ['CREATE', 'UPDATE', 'PAUSE', 'ACTIVATE'],
  PROMOTED_TWEET: ['CREATE'],
};

export const X_ADS_LINE_ITEM_OBJECTIVES = [
  'ENGAGEMENTS', 'WEBSITE_CLICKS', 'REACH', 'FOLLOWERS', 'VIDEO_VIEWS', 'APP_INSTALLS', 'APP_ENGAGEMENTS', 'PREROLL_VIEWS',
] as const;

export const X_ADS_STATS_ENTITIES = ['ACCOUNT', 'FUNDING_INSTRUMENT', 'CAMPAIGN', 'LINE_ITEM', 'PROMOTED_TWEET'] as const;
export const X_ADS_METRIC_GROUPS = ['ENGAGEMENT', 'BILLING', 'VIDEO', 'MEDIA', 'WEB_CONVERSION', 'MOBILE_CONVERSION', 'LIFE_TIME_VALUE_MOBILE_CONVERSION'] as const;

/** X's synchronous stats endpoint accepts at most 7 days per request. */
export const X_ADS_SYNC_STATS_MAX_DAYS = 7;
/** Longest range one GET_STATS call will chunk (bounds the number of X requests). */
export const X_ADS_STATS_MAX_RANGE_DAYS = 90;
/** X accepts at most 20 entity_ids per stats request. */
export const X_ADS_STATS_MAX_IDS = 20;

export function isXAdsToolkitTool(name: string): name is XAdsToolName {
  return (X_ADS_TOOL_NAMES as readonly string[]).includes(name);
}

export function isXAdsToolkitWrite(name: string): boolean {
  return name === X_ADS_WRITE_TOOL;
}

/** Throws MetaToolkitRefusal (the toolkit's tool-level refusal) when outside the surface. */
export function assertXAdsToolkitCall(name: string, args: any): void {
  if (!isXAdsToolkitTool(name)) throw new MetaToolkitRefusal(`Tool ${name} is not part of the X Ads toolkit.`);
  if (name === X_ADS_READ_TOOL) {
    if (!(X_ADS_READ_ACTIONS as readonly string[]).includes(String(args?.action))) {
      throw new MetaToolkitRefusal(`x_ads_read action must be one of ${X_ADS_READ_ACTIONS.join(', ')}.`);
    }
    return;
  }
  const entity = String(args?.entity_type ?? '');
  const action = String(args?.action ?? '');
  if (!(X_ADS_WRITES[entity] ?? []).includes(action)) {
    throw new MetaToolkitRefusal(`${entity} ${action} is not part of the X Ads toolkit surface.`);
  }
}

const ACCOUNT_ID = { type: 'string', description: 'X Ads account id; needed only when more than one is connected.' };

export function getXAdsToolkitManifest() {
  return [
    {
      name: X_ADS_READ_TOOL,
      description:
        'X (Twitter) Ads reads on the connected X Ads account. LIST_ACCOUNTS (ad accounts this X login can manage); ' +
        'LIST_FUNDING_INSTRUMENTS; LIST_CAMPAIGNS (campaign_ids?); LIST_LINE_ITEMS (campaign_ids? | line_item_ids?); ' +
        'LIST_PROMOTED_TWEETS (line_item_ids?); GET_STATS (entity, entity_ids 1-20, start_date, end_date as YYYY-MM-DD in the account time zone, ' +
        'granularity DAY|TOTAL, metric_groups default ENGAGEMENT+BILLING). Ranges longer than 7 days are fetched in 7-day windows and merged (max 90 days). ' +
        'Money fields ending in _local_micro are micros of the account currency (1,000,000 = 1.00).',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: [...X_ADS_READ_ACTIONS] },
          account_id: ACCOUNT_ID,
          campaign_ids: { type: 'array', items: { type: 'string' }, description: 'LIST_CAMPAIGNS / LIST_LINE_ITEMS filter.' },
          line_item_ids: { type: 'array', items: { type: 'string' }, description: 'LIST_LINE_ITEMS / LIST_PROMOTED_TWEETS filter.' },
          entity: { type: 'string', enum: [...X_ADS_STATS_ENTITIES], description: 'GET_STATS: entity type of entity_ids.' },
          entity_ids: { type: 'array', items: { type: 'string' }, description: 'GET_STATS: 1-20 ids (ACCOUNT: the account id).' },
          start_date: { type: 'string', description: 'GET_STATS: YYYY-MM-DD (inclusive).' },
          end_date: { type: 'string', description: 'GET_STATS: YYYY-MM-DD (exclusive).' },
          granularity: { type: 'string', enum: ['DAY', 'TOTAL'], description: 'GET_STATS: default DAY.' },
          metric_groups: { type: 'array', items: { type: 'string', enum: [...X_ADS_METRIC_GROUPS] }, description: 'GET_STATS: default ["ENGAGEMENT","BILLING"].' },
        },
        required: ['action'],
        additionalProperties: false,
      },
    },
    {
      name: X_ADS_WRITE_TOOL,
      description:
        'X (Twitter) Ads guarded writes. Every write is two calls: first without confirm (returns a PREVIEW and preview_token, nothing changes), ' +
        'show the preview to the user, then after their explicit approval repeat the exact same call with confirm=true and the preview_token. ' +
        'CAMPAIGN CREATE (name, funding_instrument_id, daily_budget, total_budget?, start_time?, end_time?) / UPDATE (campaign_id, name? daily_budget? total_budget?); ' +
        'LINE_ITEM CREATE (campaign_id, name, objective, bid_amount? — omit for automatic bidding, placements? default ALL_ON_TWITTER, ' +
        'targeting? {locations: X location targeting_values, keywords: broad keywords, follower_lookalike_user_ids: X user ids}) / UPDATE (line_item_id, name? bid_amount?); ' +
        'PROMOTED_TWEET CREATE (line_item_id, tweet_ids 1-50 of existing posts); PAUSE / ACTIVATE (CAMPAIGN campaign_id | LINE_ITEM line_item_id). ' +
        'Budgets and bids are MAJOR units of the account currency (daily_budget: 50 = 50.00/day); the preview echoes the micros. ' +
        'New campaigns and line items are always created PAUSED; activating is its own ACTIVATE preview and approval. ' +
        'A write is done only when the result says verification CONFIRMED.',
      inputSchema: {
        type: 'object',
        properties: {
          entity_type: { type: 'string', enum: Object.keys(X_ADS_WRITES) },
          action: { type: 'string', enum: ['CREATE', 'UPDATE', 'PAUSE', 'ACTIVATE'] },
          account_id: ACCOUNT_ID,
          campaign_id: { type: 'string' },
          line_item_id: { type: 'string' },
          funding_instrument_id: { type: 'string', description: 'CAMPAIGN CREATE: from LIST_FUNDING_INSTRUMENTS.' },
          name: { type: 'string' },
          daily_budget: { type: 'number', description: 'CAMPAIGN: daily budget in MAJOR currency units.' },
          total_budget: { type: 'number', description: 'CAMPAIGN: optional lifetime budget in MAJOR currency units.' },
          start_time: { type: 'string', description: 'CAMPAIGN CREATE: optional ISO 8601 start.' },
          end_time: { type: 'string', description: 'CAMPAIGN CREATE: optional ISO 8601 end.' },
          objective: { type: 'string', enum: [...X_ADS_LINE_ITEM_OBJECTIVES], description: 'LINE_ITEM CREATE.' },
          bid_amount: { type: 'number', description: 'LINE_ITEM: max bid in MAJOR currency units; omit on CREATE for automatic bidding.' },
          placements: { type: 'array', items: { type: 'string', enum: ['ALL_ON_TWITTER', 'PUBLISHER_NETWORK', 'TWITTER_PROFILE', 'TWITTER_SEARCH', 'TWITTER_TIMELINE'] } },
          targeting: {
            type: 'object',
            description: 'LINE_ITEM CREATE: optional basic targeting.',
            properties: {
              locations: { type: 'array', items: { type: 'string' }, description: 'X location targeting_values (e.g. "96683cc9126741d1" = United States).' },
              keywords: { type: 'array', items: { type: 'string' }, description: 'Broad-match keywords (max 100).' },
              follower_lookalike_user_ids: { type: 'array', items: { type: 'string' }, description: 'Numeric X user ids: target people similar to their followers.' },
            },
            additionalProperties: false,
          },
          tweet_ids: { type: 'array', items: { type: 'string' }, description: 'PROMOTED_TWEET CREATE: 1-50 numeric post ids.' },
          confirm: { type: 'boolean', description: 'Omit to get a PREVIEW (nothing changes). Set true only after the user explicitly approved that preview, together with its preview_token.' },
          preview_token: { type: 'string', description: 'The preview_token returned by the preview the user approved. Single use, 15 minutes; the call must repeat the previewed arguments exactly.' },
        },
        required: ['entity_type', 'action'],
        additionalProperties: false,
      },
    },
  ];
}

// ── Reads ──────────────────────────────────────────────────────────────────────

export interface XAdsSession {
  /** Resolved X Ads account id (owned by the caller, connection usable). */
  accountId: string;
  credentials: OAuth1Credentials;
  fetchImpl?: XFetch;
}

const ID = /^[A-Za-z0-9]{1,32}$/;

function idList(raw: unknown, field: string, max: number): string[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > max || !raw.every((v) => typeof v === 'string' && ID.test(v))) {
    throw new MetaToolkitRefusal(`${field} must be 1-${max} X ids (letters and digits).`);
  }
  return raw as string[];
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Split [start, end) into consecutive windows of at most `maxDays` days (dates as YYYY-MM-DD). */
export function chunkDateRange(startDate: string, endDate: string, maxDays = X_ADS_SYNC_STATS_MAX_DAYS): Array<{ start: string; end: string }> {
  if (!DATE.test(startDate) || !DATE.test(endDate)) throw new MetaToolkitRefusal('start_date and end_date must be YYYY-MM-DD.');
  const start = Date.parse(`${startDate}T00:00:00Z`);
  const end = Date.parse(`${endDate}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw new MetaToolkitRefusal('end_date must be after start_date.');
  if ((end - start) / DAY_MS > X_ADS_STATS_MAX_RANGE_DAYS) {
    throw new MetaToolkitRefusal(`GET_STATS covers at most ${X_ADS_STATS_MAX_RANGE_DAYS} days per call; split the range.`);
  }
  const windows: Array<{ start: string; end: string }> = [];
  for (let t = start; t < end; t += maxDays * DAY_MS) {
    const stop = Math.min(t + maxDays * DAY_MS, end);
    windows.push({ start: new Date(t).toISOString().slice(0, 10), end: new Date(stop).toISOString().slice(0, 10) });
  }
  return windows;
}

/**
 * Merge per-window stats responses: per entity id, each metric's series is concatenated in
 * window order (DAY), or summed to one value (TOTAL). A metric null in every window stays null.
 */
export function mergeStatsWindows(responses: any[], granularity: 'DAY' | 'TOTAL'): Array<{ id: string; metrics: Record<string, Array<number | null> | number | null> }> {
  const byId = new Map<string, Record<string, Array<number | null>>>();
  for (const body of responses) {
    for (const row of Array.isArray(body?.data) ? body.data : []) {
      const merged = byId.get(row.id) ?? {};
      const metrics = row?.id_data?.[0]?.metrics ?? {};
      for (const [key, series] of Object.entries(metrics)) {
        merged[key] = [...(merged[key] ?? []), ...(Array.isArray(series) ? series as Array<number | null> : [null])];
      }
      byId.set(row.id, merged);
    }
  }
  return [...byId.entries()].map(([id, metrics]) => ({
    id,
    metrics: granularity === 'DAY'
      ? metrics
      : Object.fromEntries(Object.entries(metrics).map(([k, series]) => {
        const nums = series.filter((v): v is number => typeof v === 'number');
        return [k, nums.length ? nums.reduce((a, b) => a + b, 0) : null];
      })),
  }));
}

/** Execute one x_ads_read call against the resolved account. */
export async function executeXAdsRead(args: any, session: XAdsSession) {
  assertXAdsToolkitCall(X_ADS_READ_TOOL, args);
  const acct = encodeURIComponent(session.accountId);
  const base = { credentials: session.credentials, fetchImpl: session.fetchImpl };
  const list = async (path: string, query: Record<string, unknown> = {}) => {
    const data = await xAdsListAll({ ...base, path, query });
    return { success: true, account_id: session.accountId, count: data.length, data };
  };

  switch (args.action) {
    case 'LIST_ACCOUNTS':
      return { success: true, data: await xAdsListAll({ ...base, path: '/accounts' }) };
    case 'LIST_FUNDING_INSTRUMENTS':
      return list(`/accounts/${acct}/funding_instruments`);
    case 'LIST_CAMPAIGNS':
      return list(`/accounts/${acct}/campaigns`, { campaign_ids: idList(args.campaign_ids, 'campaign_ids', 200) });
    case 'LIST_LINE_ITEMS':
      return list(`/accounts/${acct}/line_items`, {
        campaign_ids: idList(args.campaign_ids, 'campaign_ids', 200),
        line_item_ids: idList(args.line_item_ids, 'line_item_ids', 200),
      });
    case 'LIST_PROMOTED_TWEETS':
      return list(`/accounts/${acct}/promoted_tweets`, { line_item_ids: idList(args.line_item_ids, 'line_item_ids', 200) });
    case 'GET_STATS': {
      if (!(X_ADS_STATS_ENTITIES as readonly string[]).includes(String(args.entity))) {
        throw new MetaToolkitRefusal(`entity must be one of ${X_ADS_STATS_ENTITIES.join(', ')}.`);
      }
      const ids = idList(args.entity_ids, 'entity_ids', X_ADS_STATS_MAX_IDS);
      if (!ids) throw new MetaToolkitRefusal('entity_ids is required for GET_STATS.');
      const granularity = args.granularity === 'TOTAL' ? 'TOTAL' : 'DAY';
      const groups = args.metric_groups === undefined ? ['ENGAGEMENT', 'BILLING'] : args.metric_groups;
      if (!Array.isArray(groups) || !groups.length || !groups.every((g) => (X_ADS_METRIC_GROUPS as readonly string[]).includes(g))) {
        throw new MetaToolkitRefusal(`metric_groups must be from ${X_ADS_METRIC_GROUPS.join(', ')}.`);
      }
      const windows = chunkDateRange(String(args.start_date ?? ''), String(args.end_date ?? ''));
      const responses = [];
      for (const w of windows) {
        // Sequential on purpose: X rate-limits stats per account; parallel windows would trip it.
        responses.push(await xAdsRequest({
          ...base,
          path: `/stats/accounts/${acct}`,
          query: {
            entity: args.entity, entity_ids: ids, granularity, metric_groups: groups, placement: 'ALL_ON_TWITTER',
            start_time: w.start, end_time: w.end,
          },
        }));
      }
      return {
        success: true,
        account_id: session.accountId,
        entity: args.entity,
        granularity,
        start_date: windows[0].start,
        end_date: windows[windows.length - 1].end,
        windows: windows.length,
        data: mergeStatsWindows(responses, granularity),
      };
    }
    default:
      throw new MetaToolkitRefusal(`x_ads_read action ${String(args.action)} is not supported.`);
  }
}
