import { addDays, isDay, resolveDatePreset, shiftDay, shiftIso, unshiftRange, DayRange } from './dateShift';
import { graphErrors } from './graphError';
import { compareIds, resolveObjects, ResolvedObjects } from './objects';
import type { SandboxAction, SandboxDataset, SandboxInsightsBreakdownDaily, SandboxInsightsDaily, SandboxOverlay } from './types';

/**
 * Pure Meta Insights simulation (ENG-1908 AC 2). Aggregates the frozen daily rows into the
 * exact wire shape the product parses: string metrics, `actions[]` with lead-family aliases,
 * derived ratios to six decimals, `date_start`/`date_stop`, breakdown dimensions as columns,
 * zero-delivery entities omitted, `{data, paging}` envelopes with offset cursors.
 */
export type InsightsLevel = 'account' | 'campaign' | 'adset' | 'ad';
export interface InsightsNode { kind: InsightsLevel; id: string }
export interface InsightsFilter { field: string; operator: string; value: unknown }
export type TimeIncrement = number | 'monthly' | 'all_days';

export interface InsightsParams {
  node: InsightsNode;
  level?: InsightsLevel;
  fields: string[];
  timeRange?: DayRange;
  timeRanges?: DayRange[];
  datePreset?: string;
  timeIncrement?: TimeIncrement;
  breakdowns: string[];
  actionBreakdowns: string[];
  filtering: InsightsFilter[];
  limit?: number;
  after?: string;
  sort?: string[];
  /** Builds `paging.next` for a follow-up page; when absent only the cursor is emitted. */
  nextUrl?: (after: string) => string;
}

export type InsightsRow = Record<string, unknown>;
export interface InsightsEnvelope {
  data: InsightsRow[];
  paging: { cursors: { before: string; after: string }; next?: string };
}

export const FIRST_PAGE_CURSORS = Object.freeze({ before: 'MAAZDZD', after: 'MjQZD' });
const LEVELS: InsightsLevel[] = ['account', 'campaign', 'adset', 'ad'];
const LEVEL_RANK: Record<InsightsLevel, number> = { account: 0, campaign: 1, adset: 2, ad: 3 };
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 5000;
const CONVERSION_PREFIXES = ['offsite_conversion.', 'onsite_conversion.', 'omni_'];

// ---------- parameter parsing (query string, form body, JSON body, nested field args) ----------

function parseJsonish(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith('[') && !trimmed.startsWith('{')) return value;
  try { return JSON.parse(trimmed); } catch {
    // Meta's real Graph API is documented-tolerant of the Python-dict-style single-quoted
    // `time_range={'since':'2026-01-01','until':'2026-01-31'}` shape — real product code
    // (routes/meta.ts, agentModeService.ts, metaMetricsSnapshotCron.ts) builds every
    // time_range param exactly this way for real accounts, so a real account never sees this
    // fail. Found via the ENG-1912 production proof: the sandbox must accept it too, or it
    // diverges from what a real Meta call actually does.
    try { return JSON.parse(trimmed.replace(/'/g, '"')); } catch { throw graphErrors.invalidParam(`Invalid JSON parameter: ${trimmed.slice(0, 60)}`); }
  }
}

function parseList(value: unknown): string[] {
  if (value === undefined || value === null || value === '') return [];
  const parsed = parseJsonish(value);
  if (Array.isArray(parsed)) return parsed.map((v) => String(v).trim()).filter(Boolean);
  return String(parsed).split(',').map((v) => v.trim()).filter(Boolean);
}

function parseRange(value: unknown, name: string): DayRange {
  const parsed = parseJsonish(value) as { since?: unknown; until?: unknown } | null;
  if (!parsed || typeof parsed !== 'object' || !isDay(parsed.since) || !isDay(parsed.until)) {
    throw graphErrors.invalidParam(`${name} must be an object with 'since' and 'until' in YYYY-MM-DD format`);
  }
  if (parsed.since > parsed.until) throw graphErrors.invalidParam(`${name}: 'since' must not be after 'until'`);
  return { since: parsed.since, until: parsed.until };
}

export function parseInsightsParams(raw: Record<string, unknown>, node: InsightsNode): InsightsParams {
  const level = raw.level !== undefined && raw.level !== '' ? String(raw.level) as InsightsLevel : undefined;
  if (level && !LEVELS.includes(level)) throw graphErrors.invalidParam(`The value (${raw.level}) is not a valid insights level`);
  let timeIncrement: TimeIncrement | undefined;
  if (raw.time_increment !== undefined && raw.time_increment !== '') {
    const value = String(raw.time_increment);
    if (value === 'monthly' || value === 'all_days') timeIncrement = value;
    else if (/^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= 90) timeIncrement = Number(value);
    else throw graphErrors.invalidParam(`time_increment must be 'monthly', 'all_days' or an integer between 1 and 90`);
  }
  let limit: number | undefined;
  if (raw.limit !== undefined && raw.limit !== '') {
    limit = Number(raw.limit);
    if (!Number.isInteger(limit) || limit < 1) throw graphErrors.invalidParam('limit must be a positive integer');
    limit = Math.min(limit, MAX_LIMIT);
  }
  const filteringRaw = parseJsonish(raw.filtering);
  if (filteringRaw !== undefined && filteringRaw !== null && filteringRaw !== '' && !Array.isArray(filteringRaw)) {
    throw graphErrors.invalidParam('filtering must be an array of {field, operator, value}');
  }
  const filtering: InsightsFilter[] = Array.isArray(filteringRaw)
    ? filteringRaw.map((f: any) => {
      if (!f || typeof f.field !== 'string' || typeof f.operator !== 'string') throw graphErrors.invalidParam('Each filter needs a field and an operator');
      return { field: f.field, operator: f.operator, value: f.value };
    })
    : [];
  const timeRangesRaw = parseJsonish(raw.time_ranges);
  return {
    node,
    level,
    fields: parseList(raw.fields),
    timeRange: raw.time_range !== undefined && raw.time_range !== '' ? parseRange(raw.time_range, 'time_range') : undefined,
    timeRanges: Array.isArray(timeRangesRaw) ? timeRangesRaw.map((r) => parseRange(r, 'time_ranges')) : undefined,
    datePreset: raw.date_preset !== undefined && raw.date_preset !== '' ? String(raw.date_preset) : undefined,
    timeIncrement,
    breakdowns: parseList(raw.breakdowns),
    actionBreakdowns: parseList(raw.action_breakdowns),
    filtering,
    limit,
    after: typeof raw.after === 'string' && raw.after !== '' ? raw.after : undefined,
    sort: parseList(raw.sort),
  };
}

// ---------- fallback breakdown allocation (dimensions the dataset did not record) ----------

type Bucket = { value: string; share: number };
const DIMENSION_CATALOG: Record<string, Bucket[]> = {
  age: [['18-24', 0.10], ['25-34', 0.27], ['35-44', 0.28], ['45-54', 0.20], ['55-64', 0.10], ['65+', 0.05]].map(([v, s]) => ({ value: v as string, share: s as number })),
  gender: [['female', 0.52], ['male', 0.45], ['unknown', 0.03]].map(([v, s]) => ({ value: v as string, share: s as number })),
  impression_device: [['android_smartphone', 0.38], ['iphone', 0.34], ['desktop', 0.22], ['ipad', 0.03], ['android_tablet', 0.02], ['other', 0.01]].map(([v, s]) => ({ value: v as string, share: s as number })),
  device_platform: [['mobile_app', 0.62], ['desktop', 0.24], ['mobile_web', 0.14]].map(([v, s]) => ({ value: v as string, share: s as number })),
  publisher_platform: [['facebook', 0.58], ['instagram', 0.36], ['audience_network', 0.04], ['messenger', 0.02]].map(([v, s]) => ({ value: v as string, share: s as number })),
  platform_position: [['feed', 0.55], ['instagram_stories', 0.12], ['facebook_reels', 0.10], ['instagram_reels', 0.08], ['marketplace', 0.04], ['right_hand_column', 0.03], ['instagram_explore', 0.03], ['video_feeds', 0.03], ['an_classic', 0.02]].map(([v, s]) => ({ value: v as string, share: s as number })),
  country: [{ value: 'US', share: 1 }],
  region: [['California', 0.14], ['Texas', 0.10], ['New York', 0.09], ['Florida', 0.08], ['Illinois', 0.05], ['Pennsylvania', 0.04], ['Ohio', 0.04], ['Georgia', 0.04], ['Washington', 0.03], ['Other', 0.39]].map(([v, s]) => ({ value: v as string, share: s as number })),
  hourly_stats_aggregated_by_advertiser_time_zone: Array.from({ length: 24 }, (_, h) => {
    const curve = [1, 1, 1, 1, 1, 2, 3, 5, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 5, 5, 4, 3, 2, 1];
    const total = curve.reduce((a, b) => a + b, 0);
    return { value: `${String(h).padStart(2, '0')}:00:00 - ${String(h).padStart(2, '0')}:59:59`, share: curve[h] / total };
  }),
};

/** Largest-remainder split — the parts always sum exactly to `total`. */
export function allocate(total: number, shares: number[]): number[] {
  if (shares.length === 0) return [];
  const raw = shares.map((s) => total * s);
  const floors = raw.map(Math.floor);
  let remainder = total - floors.reduce((a, b) => a + b, 0);
  const order = raw.map((v, i) => [v - floors[i], i] as const).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  // Distribute a positive remainder to the largest fractional parts first; correct a
  // negative one (floating-point error at extreme magnitudes — a synthetic total near
  // Number.MAX_SAFE_INTEGER can floor to a sum that overshoots by more than one) from the
  // smallest fractional parts. Either can need more than one pass over `order` when the
  // excess/shortfall exceeds the bucket count, so wrap with modulo instead of a single scan.
  for (let i = 0; remainder > 0; i++) { floors[order[i % order.length][1]] += 1; remainder -= 1; }
  for (let i = 0; remainder < 0; i++) { floors[order[order.length - 1 - (i % order.length)][1]] -= 1; remainder += 1; }
  return floors;
}

/**
 * Bound on the cartesian product `cartesianBuckets` may materialize. `allocateDaily` runs
 * this once per dataset row on every insights request, and it is entirely caller-controlled
 * (breakdowns is a plain comma-separated string, un-deduped, un-length-capped): a caller who
 * repeats one dimension many times (or lists all nine catalog dimensions at once) can drive
 * this into the millions of buckets. That work is synchronous and runs inside the request
 * handler — on a shared backend process it would stall unrelated requests, not just the
 * caller's own. A sandbox (evaluation) account, whose whole purpose is untrusted use, can
 * reach this path through the same Meta-insights tool a real customer uses. Checked
 * incrementally, during construction, so a request that would exceed the cap never actually
 * allocates the oversized array. 5000 comfortably covers any realistic legitimate combination
 * (the largest sensible real request — every non-hourly catalog dimension at once — is in the
 * hundreds) while blocking the repeated-dimension and all-nine-dimensions cases CodeRabbit
 * found (2,799,360 and unbounded respectively).
 */
const MAX_BREAKDOWN_BUCKETS = 5000;

function cartesianBuckets(dimensions: string[]): Array<{ dims: Record<string, string>; share: number }> {
  let combos: Array<{ dims: Record<string, string>; share: number }> = [{ dims: {}, share: 1 }];
  for (const dimension of dimensions) {
    const catalog = DIMENSION_CATALOG[dimension];
    if (!catalog) throw graphErrors.invalidParam(`breakdowns[0] must be one of the following values: ${Object.keys(DIMENSION_CATALOG).join(', ')}`);
    if (combos.length * catalog.length > MAX_BREAKDOWN_BUCKETS) {
      throw graphErrors.invalidParam(`breakdowns would produce more than ${MAX_BREAKDOWN_BUCKETS} buckets — request fewer dimensions or remove repeats`);
    }
    const next: typeof combos = [];
    for (const combo of combos) for (const bucket of catalog) next.push({ dims: { ...combo.dims, [dimension]: bucket.value }, share: combo.share * bucket.share });
    combos = next;
  }
  return combos;
}

// ---------- aggregation ----------

interface Agg {
  entity: { campaign_id?: string; adset_id?: string; ad_id?: string };
  dims: Record<string, string>;
  bucket: DayRange; // frozen dates
  impressions: number; reach: number; clicks: number; uniqueClicks: number; inlineLinkClicks: number;
  outboundClicks: number; hasOutbound: boolean; spend: number; videoViews: number; hasVideo: boolean;
  dailyReach: Map<string, Map<string, number>>;
  actions: Map<string, number>; actionValues: Map<string, number>;
}

type SourceRow = {
  date: string; ad_id: string; adset_id: string; campaign_id: string; dims: Record<string, string>;
  impressions: number; reach: number; clicks: number; unique_clicks?: number; inline_link_clicks: number;
  outbound_clicks?: number; spend: number; video_views?: number; actions: SandboxAction[]; action_values?: SandboxAction[];
};

function fromDaily(row: SandboxInsightsDaily): SourceRow {
  return { ...row, dims: {} };
}

function fromBreakdown(row: SandboxInsightsBreakdownDaily): SourceRow {
  const linkClicks = row.actions.find((a) => a.action_type === 'link_click')?.value ?? 0;
  return {
    date: row.date, ad_id: row.ad_id, adset_id: row.adset_id, campaign_id: row.campaign_id, dims: row.dims,
    impressions: row.impressions, reach: row.reach, clicks: row.clicks, inline_link_clicks: linkClicks, spend: row.spend, actions: row.actions,
  };
}

function allocateDaily(row: SandboxInsightsDaily, dimensions: string[]): SourceRow[] {
  const buckets = cartesianBuckets(dimensions);
  const shares = buckets.map((b) => b.share);
  const split = (n: number | undefined) => (n === undefined ? undefined : allocate(n, shares));
  const parts = {
    impressions: allocate(row.impressions, shares), reach: allocate(row.reach, shares), clicks: allocate(row.clicks, shares),
    unique_clicks: split(row.unique_clicks), inline_link_clicks: allocate(row.inline_link_clicks, shares), outbound_clicks: split(row.outbound_clicks),
    spend: allocate(row.spend, shares), video_views: split(row.video_views),
    actions: row.actions.map((a) => ({ action_type: a.action_type, values: allocate(a.value, shares) })),
    action_values: (row.action_values ?? []).map((a) => ({ action_type: a.action_type, values: allocate(a.value, shares) })),
  };
  return buckets.map((bucket, k) => ({
    date: row.date, ad_id: row.ad_id, adset_id: row.adset_id, campaign_id: row.campaign_id, dims: bucket.dims,
    impressions: parts.impressions[k], reach: parts.reach[k], clicks: parts.clicks[k], unique_clicks: parts.unique_clicks?.[k],
    inline_link_clicks: parts.inline_link_clicks[k], outbound_clicks: parts.outbound_clicks?.[k], spend: parts.spend[k], video_views: parts.video_views?.[k],
    actions: parts.actions.map((a) => ({ action_type: a.action_type, value: a.values[k] })),
    action_values: row.action_values ? parts.action_values.map((a) => ({ action_type: a.action_type, value: a.values[k] })) : undefined,
  }));
}

function sameSet(a: string[], b: string[]): boolean {
  return a.length === b.length && [...a].sort().every((v, i) => v === [...b].sort()[i]);
}

function sourceRows(dataset: SandboxDataset, breakdowns: string[]): SourceRow[] {
  if (breakdowns.length === 0) return dataset.insightsDaily.map(fromDaily);
  const recorded = dataset.insightsBreakdownDaily.filter((r) => sameSet(r.breakdown.split(','), breakdowns));
  if (recorded.length > 0) return recorded.map(fromBreakdown);
  return dataset.insightsDaily.flatMap((row) => allocateDaily(row, breakdowns));
}

function bucketsFor(range: DayRange, increment: TimeIncrement | undefined): DayRange[] {
  if (increment === undefined || increment === 'all_days') return [range];
  const out: DayRange[] = [];
  if (increment === 'monthly') {
    let start = range.since;
    while (start <= range.until) {
      const nextMonth = addDays(`${start.slice(0, 8)}01`, 32);
      const end = addDays(`${nextMonth.slice(0, 8)}01`, -1);
      out.push({ since: start, until: end < range.until ? end : range.until });
      start = addDays(end, 1);
    }
    return out;
  }
  for (let start = range.since; start <= range.until; start = addDays(start, increment)) {
    const end = addDays(start, increment - 1);
    out.push({ since: start, until: end < range.until ? end : range.until });
  }
  return out;
}

const fmtInt = (n: number) => String(Math.round(n));
const fmtMoney = (cents: number) => (cents / 100).toFixed(2);
const fmtRatio = (n: number) => n.toFixed(6);
const div = (a: number, b: number): number | undefined => (b > 0 ? a / b : undefined);

function actionsList(map: Map<string, number>, format: (v: number) => string = fmtInt): Array<{ action_type: string; value: string }> {
  return [...map.entries()].filter(([, v]) => v > 0).map(([action_type, v]) => ({ action_type, value: format(v) }));
}

function costPer(map: Map<string, number>, spendCents: number): Array<{ action_type: string; value: string }> {
  return [...map.entries()].filter(([, v]) => v > 0).map(([action_type, v]) => ({ action_type, value: fmtRatio(spendCents / 100 / v) }));
}

function conversionsOnly(map: Map<string, number>): Map<string, number> {
  return new Map([...map.entries()].filter(([type]) => CONVERSION_PREFIXES.some((p) => type.startsWith(p))));
}

function videoSeries(views: number, fraction: number) {
  return [{ action_type: 'video_view', value: fmtInt(Math.round(views * fraction)) }];
}

interface EmitContext {
  dataset: SandboxDataset;
  objects: ResolvedObjects;
  level: InsightsLevel;
  shift: number;
}

function emitField(name: string, agg: Agg, ctx: EmitContext): unknown {
  const { dataset, objects, level, shift } = ctx;
  const campaign = agg.entity.campaign_id ? objects.campaigns.get(agg.entity.campaign_id) : undefined;
  const adset = agg.entity.adset_id ? objects.adsets.get(agg.entity.adset_id) : undefined;
  const ad = agg.entity.ad_id ? objects.ads.get(agg.entity.ad_id) : undefined;
  const rank = LEVEL_RANK[level];
  const money = agg.spend / 100;
  switch (name) {
    case 'account_id': return dataset.account.account_id;
    case 'account_name': return dataset.account.name;
    case 'account_currency': return dataset.account.currency;
    case 'campaign_id': return rank >= 1 ? agg.entity.campaign_id : undefined;
    case 'campaign_name': return rank >= 1 ? campaign?.name : undefined;
    case 'adset_id': return rank >= 2 ? agg.entity.adset_id : undefined;
    case 'adset_name': return rank >= 2 ? adset?.name : undefined;
    case 'ad_id': return rank >= 3 ? agg.entity.ad_id : undefined;
    case 'ad_name': return rank >= 3 ? ad?.name : undefined;
    case 'objective': return rank >= 1 ? campaign?.objective : undefined;
    case 'optimization_goal': return rank >= 2 ? adset?.optimization_goal : undefined;
    case 'buying_type': return 'AUCTION';
    case 'attribution_setting': return '7d_click_1d_view';
    case 'created_time': return rank >= 3 && ad ? shiftIso(ad.created_time, shift) : rank >= 1 && campaign ? shiftIso(campaign.created_time, shift) : undefined;
    case 'updated_time': return rank >= 3 && ad ? shiftIso(ad.updated_time, shift) : rank >= 1 && campaign ? shiftIso(campaign.updated_time, shift) : undefined;
    case 'impressions': return fmtInt(agg.impressions);
    case 'reach': return fmtInt(agg.reach);
    case 'clicks': return fmtInt(agg.clicks);
    case 'unique_clicks': return fmtInt(agg.uniqueClicks);
    case 'inline_link_clicks': return fmtInt(agg.inlineLinkClicks);
    case 'unique_inline_link_clicks': return fmtInt(agg.inlineLinkClicks);
    case 'inline_post_engagement': return fmtInt(agg.inlineLinkClicks + (agg.actions.get('post_engagement') ?? 0));
    case 'spend': return fmtMoney(agg.spend);
    case 'social_spend': return '0.00';
    case 'frequency': { const v = div(agg.impressions, agg.reach); return v === undefined ? undefined : fmtRatio(v); }
    case 'ctr': { const v = div(agg.clicks * 100, agg.impressions); return v === undefined ? undefined : fmtRatio(v); }
    case 'unique_ctr': { const v = div(agg.uniqueClicks * 100, agg.reach); return v === undefined ? undefined : fmtRatio(v); }
    case 'inline_link_click_ctr': { const v = div(agg.inlineLinkClicks * 100, agg.impressions); return v === undefined ? undefined : fmtRatio(v); }
    case 'unique_inline_link_click_ctr': { const v = div(agg.inlineLinkClicks * 100, agg.reach); return v === undefined ? undefined : fmtRatio(v); }
    case 'unique_link_clicks_ctr': { const v = div(agg.inlineLinkClicks * 100, agg.reach); return v === undefined ? undefined : fmtRatio(v); }
    case 'cpc': { const v = div(money, agg.clicks); return v === undefined ? undefined : fmtRatio(v); }
    case 'cpm': { const v = div(money * 1000, agg.impressions); return v === undefined ? undefined : fmtRatio(v); }
    case 'cpp': { const v = div(money * 1000, agg.reach); return v === undefined ? undefined : fmtRatio(v); }
    case 'cost_per_inline_link_click': case 'cost_per_unique_inline_link_click': { const v = div(money, agg.inlineLinkClicks); return v === undefined ? undefined : fmtRatio(v); }
    case 'cost_per_unique_click': { const v = div(money, agg.uniqueClicks); return v === undefined ? undefined : fmtRatio(v); }
    case 'cost_per_inline_post_engagement': { const v = div(money, agg.inlineLinkClicks); return v === undefined ? undefined : fmtRatio(v); }
    case 'actions': case 'unique_actions': { const list = actionsList(agg.actions); return list.length ? list : undefined; }
    case 'action_values': case 'conversion_values': {
      const source = name === 'conversion_values' ? conversionsOnly(agg.actionValues) : agg.actionValues;
      const list = actionsList(source, fmtMoney); return list.length ? list : undefined;
    }
    case 'cost_per_action_type': case 'cost_per_unique_action_type': { const list = costPer(agg.actions, agg.spend); return list.length ? list : undefined; }
    case 'conversions': case 'unique_conversions': { const list = actionsList(conversionsOnly(agg.actions)); return list.length ? list : undefined; }
    case 'cost_per_conversion': case 'cost_per_unique_conversion': { const list = costPer(conversionsOnly(agg.actions), agg.spend); return list.length ? list : undefined; }
    case 'website_ctr': { const v = div(agg.inlineLinkClicks * 100, agg.impressions); return v === undefined ? undefined : [{ action_type: 'link_click', value: fmtRatio(v) }]; }
    case 'outbound_clicks': case 'unique_outbound_clicks': return agg.hasOutbound ? [{ action_type: 'outbound_click', value: fmtInt(agg.outboundClicks) }] : undefined;
    case 'outbound_clicks_ctr': case 'unique_outbound_clicks_ctr': { if (!agg.hasOutbound) return undefined; const v = div(agg.outboundClicks * 100, agg.impressions); return v === undefined ? undefined : [{ action_type: 'outbound_click', value: fmtRatio(v) }]; }
    case 'cost_per_outbound_click': case 'cost_per_unique_outbound_click': { if (!agg.hasOutbound) return undefined; const v = div(money, agg.outboundClicks); return v === undefined ? undefined : [{ action_type: 'outbound_click', value: fmtRatio(v) }]; }
    case 'purchase_roas': case 'website_purchase_roas': {
      const purchases = [...agg.actionValues.entries()].filter(([t]) => t === 'omni_purchase' || t === 'purchase' || t === 'offsite_conversion.fb_pixel_purchase');
      if (!purchases.length || agg.spend <= 0) return undefined;
      const value = purchases.reduce((n, [, v]) => n + v, 0);
      return [{ action_type: name === 'purchase_roas' ? 'omni_purchase' : 'offsite_conversion.fb_pixel_purchase', value: fmtRatio(value / agg.spend) }];
    }
    case 'video_play_actions': return agg.hasVideo ? videoSeries(agg.videoViews, 1) : undefined;
    case 'video_p25_watched_actions': return agg.hasVideo ? videoSeries(agg.videoViews, 0.6) : undefined;
    case 'video_p50_watched_actions': return agg.hasVideo ? videoSeries(agg.videoViews, 0.4) : undefined;
    case 'video_p75_watched_actions': return agg.hasVideo ? videoSeries(agg.videoViews, 0.25) : undefined;
    case 'video_p95_watched_actions': return agg.hasVideo ? videoSeries(agg.videoViews, 0.15) : undefined;
    case 'video_p100_watched_actions': return agg.hasVideo ? videoSeries(agg.videoViews, 0.12) : undefined;
    case 'video_30_sec_watched_actions': return agg.hasVideo ? videoSeries(agg.videoViews, 0.2) : undefined;
    case 'video_thruplay_watched_actions': case 'video_15_sec_watched_actions': return agg.hasVideo ? videoSeries(agg.videoViews, 0.3) : undefined;
    case 'video_continuous_2_sec_watched_actions': return agg.hasVideo ? videoSeries(agg.videoViews, 0.7) : undefined;
    case 'video_avg_time_watched_actions': return agg.hasVideo ? [{ action_type: 'video_view', value: '6' }] : undefined;
    case 'cost_per_thruplay': case 'cost_per_15_sec_video_view': { if (!agg.hasVideo) return undefined; const v = div(money, Math.round(agg.videoViews * 0.3)); return v === undefined ? undefined : [{ action_type: 'video_view', value: fmtRatio(v) }]; }
    case 'quality_ranking': case 'engagement_rate_ranking': case 'conversion_rate_ranking':
      return level === 'ad' ? (agg.impressions >= 500 ? 'AVERAGE' : 'UNKNOWN') : undefined;
    default: return undefined;
  }
}

// ---------- filtering ----------

const ENTITY_FILTER_FIELDS = new Set([
  'campaign.id', 'campaign.name', 'campaign.effective_status', 'campaign.objective', 'campaign.delivery_info', 'objective',
  'adset.id', 'adset.name', 'adset.effective_status', 'adset.optimization_goal', 'adset.delivery_info',
  'ad.id', 'ad.name', 'ad.effective_status', 'ad.delivery_info', 'buying_type',
]);
const METRIC_FILTER_FIELDS = new Set(['impressions', 'reach', 'clicks', 'spend', 'inline_link_clicks', 'unique_clicks', 'ctr', 'cpc', 'cpm', 'cpp', 'frequency']);

function operatorMatches(actual: unknown, operator: string, expected: unknown): boolean {
  const value = actual === undefined || actual === null ? '' : String(actual);
  const list = (Array.isArray(expected) ? expected : [expected]).map((v) => String(v));
  const lower = value.toLowerCase();
  switch (operator) {
    case 'EQUAL': return value === list[0];
    case 'NOT_EQUAL': return value !== list[0];
    case 'IN': case 'ANY': return list.includes(value);
    case 'NOT_IN': case 'NONE': return !list.includes(value);
    case 'ALL': return list.every((v) => v === value);
    case 'CONTAIN': return lower.includes(list[0].toLowerCase());
    case 'NOT_CONTAIN': return !lower.includes(list[0].toLowerCase());
    case 'STARTS_WITH': return lower.startsWith(list[0].toLowerCase());
    case 'GREATER_THAN': return Number(value) > Number(list[0]);
    case 'GREATER_THAN_OR_EQUAL': return Number(value) >= Number(list[0]);
    case 'LESS_THAN': return Number(value) < Number(list[0]);
    case 'LESS_THAN_OR_EQUAL': return Number(value) <= Number(list[0]);
    case 'IN_RANGE': return Number(value) >= Number(list[0]) && Number(value) <= Number(list[1]);
    case 'NOT_IN_RANGE': return !(Number(value) >= Number(list[0]) && Number(value) <= Number(list[1]));
    default: throw graphErrors.invalidParam(`Filter operator ${operator} is invalid`);
  }
}

function entityValue(field: string, row: SourceRow, objects: ResolvedObjects): unknown {
  const campaign = objects.campaigns.get(row.campaign_id);
  const adset = objects.adsets.get(row.adset_id);
  const ad = objects.ads.get(row.ad_id);
  switch (field) {
    case 'campaign.id': return row.campaign_id;
    case 'campaign.name': return campaign?.name;
    case 'campaign.effective_status': case 'campaign.delivery_info': return campaign ? objects.campaignEffectiveStatus(campaign) : undefined;
    case 'campaign.objective': case 'objective': return campaign?.objective;
    case 'adset.id': return row.adset_id;
    case 'adset.name': return adset?.name;
    case 'adset.effective_status': case 'adset.delivery_info': return adset ? objects.adsetEffectiveStatus(adset) : undefined;
    case 'adset.optimization_goal': return adset?.optimization_goal;
    case 'ad.id': return row.ad_id;
    case 'ad.name': return ad?.name;
    case 'ad.effective_status': case 'ad.delivery_info': return ad ? objects.adEffectiveStatus(ad) : undefined;
    case 'buying_type': return 'AUCTION';
    default: return undefined;
  }
}

function metricValue(field: string, agg: Agg): number | undefined {
  switch (field) {
    case 'impressions': return agg.impressions;
    case 'reach': return agg.reach;
    case 'clicks': return agg.clicks;
    case 'unique_clicks': return agg.uniqueClicks;
    case 'inline_link_clicks': return agg.inlineLinkClicks;
    case 'spend': return agg.spend / 100;
    case 'ctr': return div(agg.clicks * 100, agg.impressions) ?? 0;
    case 'cpc': return div(agg.spend / 100, agg.clicks) ?? 0;
    case 'cpm': return div(agg.spend / 10, agg.impressions) ?? 0;
    case 'cpp': return div(agg.spend / 10, agg.reach) ?? 0;
    case 'frequency': return div(agg.impressions, agg.reach) ?? 0;
    default: return undefined;
  }
}

function splitFilters(filtering: InsightsFilter[], breakdowns: string[]) {
  const entity: InsightsFilter[] = [], dimension: InsightsFilter[] = [], metric: InsightsFilter[] = [], actionType: InsightsFilter[] = [];
  for (const filter of filtering) {
    if (ENTITY_FILTER_FIELDS.has(filter.field)) entity.push(filter);
    else if (filter.field === 'action_type') actionType.push(filter);
    else if (METRIC_FILTER_FIELDS.has(filter.field)) metric.push(filter);
    else if (breakdowns.includes(filter.field) || DIMENSION_CATALOG[filter.field]) dimension.push(filter);
    else throw graphErrors.invalidParam(`Filter field ${filter.field} is invalid`);
  }
  return { entity, dimension, metric, actionType };
}

// ---------- the engine ----------

function resolveRanges(params: InsightsParams, now: Date, frozen: DayRange, shift: number): DayRange[] {
  if (params.timeRanges && params.timeRanges.length) return params.timeRanges;
  if (params.timeRange) return [params.timeRange];
  const preset = params.datePreset ?? 'last_30d';
  const range = resolveDatePreset(preset, now, frozen, shift);
  if (!range) throw graphErrors.invalidParam(`date_preset must be one of the following values: today, yesterday, this_month, last_month, this_quarter, maximum, data_maximum, last_3d, last_7d, last_14d, last_28d, last_30d, last_90d, last_week_mon_sun, last_week_sun_sat, last_quarter, last_year, this_week_mon_today, this_week_sun_today, this_year`);
  return [range];
}

function entityKey(level: InsightsLevel, row: SourceRow): Agg['entity'] {
  switch (level) {
    case 'account': return {};
    case 'campaign': return { campaign_id: row.campaign_id };
    case 'adset': return { campaign_id: row.campaign_id, adset_id: row.adset_id };
    case 'ad': return { campaign_id: row.campaign_id, adset_id: row.adset_id, ad_id: row.ad_id };
  }
}

function inScope(node: InsightsNode, row: SourceRow, accountId: string): boolean {
  switch (node.kind) {
    case 'account': return node.id === accountId;
    case 'campaign': return row.campaign_id === node.id;
    case 'adset': return row.adset_id === node.id;
    case 'ad': return row.ad_id === node.id;
  }
}

function decodeCursor(after: string | undefined): number {
  if (!after) return 0;
  const offset = Number(Buffer.from(after, 'base64').toString('utf8'));
  if (!Number.isInteger(offset) || offset < 0) throw graphErrors.invalidParam('The cursor is invalid');
  return offset;
}

const encodeCursor = (offset: number) => Buffer.from(String(offset)).toString('base64');

export function runInsights(dataset: SandboxDataset, overlay: SandboxOverlay, params: InsightsParams, shift: number, now: Date): InsightsEnvelope {
  const objects = resolveObjects(dataset, overlay, now);
  const level = params.level ?? params.node.kind;
  if (LEVEL_RANK[level] < LEVEL_RANK[params.node.kind]) throw graphErrors.invalidParam(`Level ${level} is not valid for a ${params.node.kind} node`);
  const filters = splitFilters(params.filtering, params.breakdowns);
  const rows = sourceRows(dataset, params.breakdowns)
    .filter((row) => inScope(params.node, row, dataset.account.account_id))
    .filter((row) => filters.entity.every((f) => operatorMatches(entityValue(f.field, row, objects), f.operator, f.value)))
    ;
  const actionAllowed = (type: string) => filters.actionType.every((f) => operatorMatches(type, f.operator, f.value));
  const ctx: EmitContext = { dataset, objects, level, shift };
  const fields = [...new Set(params.fields)];
  const out: InsightsRow[] = [];

  for (const range of resolveRanges(params, now, dataset.meta.frozenWindow, shift)) {
    const frozenRange = unshiftRange(range, shift);
    const groups = new Map<string, Agg>();
    for (const bucket of bucketsFor(frozenRange, params.timeIncrement)) {
      for (const row of rows) {
        if (row.date < bucket.since || row.date > bucket.until) continue;
        const entity = entityKey(level, row);
        const dimKey = params.breakdowns.map((d) => row.dims[d] ?? '').join('');
        const key = `${bucket.since}|${entity.campaign_id ?? ''}|${entity.adset_id ?? ''}|${entity.ad_id ?? ''}|${dimKey}`;
        let agg = groups.get(key);
        if (!agg) {
          agg = { entity, dims: Object.fromEntries(params.breakdowns.map((d) => [d, row.dims[d] ?? 'unknown'])), bucket, impressions: 0, reach: 0, clicks: 0, uniqueClicks: 0,
            inlineLinkClicks: 0, outboundClicks: 0, hasOutbound: false, spend: 0, videoViews: 0, hasVideo: false, dailyReach: new Map(), actions: new Map(), actionValues: new Map() };
          groups.set(key, agg);
        }
        agg.impressions += row.impressions; agg.clicks += row.clicks;
        const days = agg.dailyReach.get(row.ad_id) ?? new Map<string, number>();
        days.set(row.date, (days.get(row.date) ?? 0) + row.reach);
        agg.dailyReach.set(row.ad_id, days);
        agg.uniqueClicks += row.unique_clicks ?? row.clicks; agg.inlineLinkClicks += row.inline_link_clicks; agg.spend += row.spend;
        if (row.outbound_clicks !== undefined) { agg.hasOutbound = true; agg.outboundClicks += row.outbound_clicks; }
        if (row.video_views !== undefined) { agg.hasVideo = true; agg.videoViews += row.video_views; }
        for (const action of row.actions) if (actionAllowed(action.action_type)) agg.actions.set(action.action_type, (agg.actions.get(action.action_type) ?? 0) + action.value);
        for (const action of row.action_values ?? []) if (actionAllowed(action.action_type)) agg.actionValues.set(action.action_type, (agg.actionValues.get(action.action_type) ?? 0) + action.value);
      }
    }
    // Model unique reach once for the unbroken entity/window. Breakdown
    // dimensions are disjoint synthetic allocations; rounding independently per
    // dimension would manufacture people. Apply dimension filters only AFTER this.
    const unbroken = new Map<string, Agg[]>();
    for (const agg of groups.values()) {
      const key = `${agg.bucket.since}|${JSON.stringify(agg.entity)}`;
      const group = unbroken.get(key);
      if (group) group.push(agg); else unbroken.set(key, [agg]);
    }
    for (const dimensions of unbroken.values()) {
      const byAd = new Map<string, Map<string, number>>();
      const weights = dimensions.map(agg => {
        let weight = 0;
        for (const [adId, days] of agg.dailyReach) {
          const combined = byAd.get(adId) ?? new Map<string, number>();
          for (const [date, reach] of days) { combined.set(date, (combined.get(date) ?? 0) + reach); weight += reach; }
          byAd.set(adId, combined);
        }
        return weight;
      });
      let modeled = 0;
      for (const days of byAd.values()) {
        const daily = [...days.values()], largest = Math.max(0, ...daily);
        modeled += Math.ceil(largest + (daily.reduce((a, b) => a + b, 0) - largest) * 0.35);
      }
      modeled = Math.min(modeled, dimensions.reduce((n, a) => n + a.impressions, 0));
      const totalWeight = weights.reduce((a, b) => a + b, 0);
      const exact = weights.map(weight => totalWeight ? modeled * weight / totalWeight : 0);
      dimensions.forEach((agg, i) => { agg.reach = Math.floor(exact[i]); });
      const remainder = modeled - dimensions.reduce((n, a) => n + a.reach, 0);
      const order = exact.map((v, i) => ({ i, fraction: v - Math.floor(v) }))
        .sort((a, b) => b.fraction - a.fraction || a.i - b.i);
      for (let i = 0; i < remainder; i++) dimensions[order[i].i].reach++;
    }
    const aggs = [...groups.values()]
      .filter(agg => filters.dimension.every(f => operatorMatches(agg.dims[f.field], f.operator, f.value)))
      .filter((agg) => agg.impressions > 0 || agg.spend > 0)
      .filter((agg) => filters.metric.every((f) => operatorMatches(metricValue(f.field, agg), f.operator, f.value)))
      .sort((a, b) => a.bucket.since.localeCompare(b.bucket.since)
        || compareIds(a.entity.campaign_id ?? '', b.entity.campaign_id ?? '')
        || compareIds(a.entity.adset_id ?? '', b.entity.adset_id ?? '')
        || compareIds(a.entity.ad_id ?? '', b.entity.ad_id ?? '')
        || Object.values(a.dims).join().localeCompare(Object.values(b.dims).join()));
    for (const agg of aggs) {
      const row: InsightsRow = {};
      for (const field of fields) {
        const value = emitField(field, agg, ctx);
        if (value !== undefined) row[field] = value;
      }
      for (const [dim, value] of Object.entries(agg.dims)) row[dim] = value;
      row.date_start = shiftDay(agg.bucket.since, shift);
      row.date_stop = shiftDay(agg.bucket.until, shift);
      out.push(row);
    }
  }

  if (params.sort && params.sort.length) {
    const [spec] = params.sort;
    const match = spec.match(/^(.+)_(ascending|descending)$/);
    if (!match) throw graphErrors.invalidParam(`sort must be <field>_ascending or <field>_descending`);
    const [, field, direction] = match;
    const num = (row: InsightsRow) => { const v = row[field]; return typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : String(v ?? ''); };
    out.sort((a, b) => { const x = num(a), y = num(b); const cmp = x < y ? -1 : x > y ? 1 : 0; return direction === 'ascending' ? cmp : -cmp; });
  }

  const offset = decodeCursor(params.after);
  const limit = params.limit ?? DEFAULT_LIMIT;
  const page = out.slice(offset, offset + limit);
  const hasMore = offset + limit < out.length;
  const paging: InsightsEnvelope['paging'] = { cursors: { before: offset === 0 ? FIRST_PAGE_CURSORS.before : encodeCursor(offset), after: hasMore ? encodeCursor(offset + limit) : FIRST_PAGE_CURSORS.after } };
  if (hasMore && params.nextUrl) paging.next = params.nextUrl(encodeCursor(offset + limit));
  return { data: page, paging };
}

// ---------- async report flow (POST /<node>/insights → report_run_id → status → rows) ----------

interface StoredReport {
  envelope: InsightsEnvelope;
  accountId: string;
  dateStart: string;
  dateStop: string;
  createdAtMs: number;
  params: InsightsParams;
  dataset: SandboxDataset;
  overlay: SandboxOverlay;
  shift: number;
  now: Date;
}

export const INSIGHTS_REPORT_TTL_MS = 10 * 60 * 1000;
const reports = new Map<string, StoredReport>();
let reportSequence = 0;

function pruneReports(nowMs: number): void {
  for (const [id, report] of reports) if (nowMs - report.createdAtMs > INSIGHTS_REPORT_TTL_MS) reports.delete(id);
}

export function createInsightsReport(dataset: SandboxDataset, overlay: SandboxOverlay, params: InsightsParams, shift: number, now: Date): { report_run_id: string } {
  pruneReports(now.getTime());
  const { after: _after, nextUrl: _nextUrl, limit: _limit, ...reportParams } = params;
  const ranges = resolveRanges(reportParams, now, dataset.meta.frozenWindow, shift);
  const envelope = runInsights(dataset, overlay, { ...reportParams, limit: MAX_LIMIT }, shift, now);
  reportSequence = (reportSequence + 1) % 1000;
  const report_run_id = `${now.getTime()}${String(reportSequence).padStart(3, '0')}`;
  reports.set(report_run_id, {
    envelope, accountId: dataset.account.account_id, dateStart: ranges[0].since, dateStop: ranges[ranges.length - 1].until,
    createdAtMs: now.getTime(), params: reportParams, dataset, overlay, shift, now,
  });
  return { report_run_id };
}

function requireReport(reportRunId: string, now: Date): StoredReport {
  pruneReports(now.getTime());
  const report = reports.get(reportRunId);
  if (!report) throw graphErrors.unsupportedGet(reportRunId);
  return report;
}

export function hasInsightsReport(reportRunId: string, now: Date): boolean {
  pruneReports(now.getTime());
  return reports.has(reportRunId);
}

export function getInsightsReportStatus(reportRunId: string, now: Date): Record<string, unknown> {
  const report = requireReport(reportRunId, now);
  const seconds = Math.floor(report.createdAtMs / 1000);
  return {
    id: reportRunId, account_id: report.accountId, time_ref: seconds, time_completed: seconds + 1,
    async_status: 'Job Completed', async_percent_completion: 100, date_start: report.dateStart, date_stop: report.dateStop,
    is_running: false, is_bookmarked: false, emails: [], friendly_name: '', schedule_id: '',
  };
}

/** Rows for a completed report; `limit`/`after`/`nextUrl` paginate over the report's own row set. */
export function getInsightsReportRows(reportRunId: string, now: Date, page: { limit?: number; after?: string; nextUrl?: (after: string) => string } = {}): InsightsEnvelope {
  const report = requireReport(reportRunId, now);
  if (page.limit === undefined && page.after === undefined) return report.envelope;
  return runInsights(report.dataset, report.overlay, { ...report.params, limit: page.limit ?? MAX_LIMIT, after: page.after, nextUrl: page.nextUrl }, report.shift, report.now);
}

export function __resetInsightsReportsForTests(): void {
  reports.clear();
  reportSequence = 0;
}
