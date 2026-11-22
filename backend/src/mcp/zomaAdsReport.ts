/**
 * ENG-3134 — zoma_ads_report: the one obvious reporting tool. Spend, impressions, clicks, CTR,
 * CPC, conversions and ROAS per campaign (or account total) for a date range, read from the
 * user's own connected Meta ad account. Read-only: one Graph insights read (paged), no writes,
 * nothing stored.
 *
 * Metrics are computed from Meta's raw counts so every row and the totals use one definition:
 *   CTR  = clicks / impressions × 100     CPC  = spend / clicks
 *   ROAS = purchase value / spend         conversions = the account's primary conversion action
 * The conversion action is chosen once per report (purchases, else leads, else registrations;
 * or the caller's conversion_event) so rows are comparable and totals are a true sum.
 */
import type { ConnectedAccount } from '../services/connectedAccountsDb';
import { MetaToolkitRefusal } from './metaToolkitErrors';

export const ZOMA_ADS_REPORT_TOOL = 'zoma_ads_report';
export const isZomaAdsReportTool = (name: string) => name === ZOMA_ADS_REPORT_TOOL;

export const ZOMA_REPORT_DATE_PRESETS = [
  'today', 'yesterday', 'last_7d', 'last_14d', 'last_30d', 'last_90d', 'this_month', 'last_month', 'maximum',
] as const;
const LEVELS = ['campaign', 'account'] as const;
const MAX_PAGES = 10;
const MAX_CAMPAIGN_IDS = 50;

/** Conversion actions tried in order when the caller does not name one. Each group is one concept. */
const CONVERSION_PRIORITY: ReadonlyArray<readonly string[]> = [
  ['omni_purchase', 'purchase', 'offsite_conversion.fb_pixel_purchase'],
  ['lead', 'onsite_conversion.lead_grouped', 'offsite_conversion.fb_pixel_lead'],
  ['complete_registration', 'offsite_conversion.fb_pixel_complete_registration'],
];
const PURCHASE_TYPES = new Set(CONVERSION_PRIORITY[0]);

/** ENG-3156: the KPI each CONVERSION_PRIORITY group measures, in the same order. */
export const CONVERSION_KPIS = ['purchase', 'lead', 'registration'] as const;
export type ConversionKpi = (typeof CONVERSION_KPIS)[number];

/** The KPI a Meta action type counts toward, or null when it is outside the priority groups. */
export function kpiOfConversionEvent(event: string | null): ConversionKpi | null {
  if (!event) return null;
  const i = CONVERSION_PRIORITY.findIndex((group) => group.includes(event));
  return i < 0 ? null : CONVERSION_KPIS[i];
}

export const ZOMA_ADS_REPORT_DEFINITION = {
  name: ZOMA_ADS_REPORT_TOOL,
  description:
    'Ad performance report for the connected Meta ad account: spend, impressions, clicks, CTR, CPC, conversions and ROAS, per campaign (or the account total), for a date range. ' +
    'Use this for any "how are my ads doing" / "what did I spend" / "which campaign has the best ROAS" question. Read-only. ' +
    'Pick a date_preset (default last_7d) or since + until (YYYY-MM-DD). Optional campaign_ids narrows to those campaigns. ' +
    'Conversions use the account\'s purchases (else leads, else registrations) unless conversion_event names a Meta action type; ROAS is purchase value / spend.',
  inputSchema: {
    type: 'object',
    properties: {
      date_preset: { type: 'string', enum: [...ZOMA_REPORT_DATE_PRESETS], description: 'Relative range in the ad account time zone. Default last_7d. Ignored when since/until are set.' },
      since: { type: 'string', description: 'Start date YYYY-MM-DD (inclusive). Needs until.' },
      until: { type: 'string', description: 'End date YYYY-MM-DD (inclusive). Needs since.' },
      campaign_ids: { type: 'array', items: { type: 'string' }, description: `Only these campaign ids (up to ${MAX_CAMPAIGN_IDS}).` },
      level: { type: 'string', enum: [...LEVELS], description: 'campaign (default): one row per campaign. account: one total row.' },
      conversion_event: { type: 'string', description: 'Optional Meta action type to count as a conversion, e.g. purchase, lead, complete_registration.' },
      account_id: { type: 'string', description: 'Meta ad account id; needed only when more than one is connected.' },
    },
    additionalProperties: false,
  },
};

export interface ZomaAdsReportRow {
  campaign_id?: string;
  campaign_name?: string;
  spend: number;
  impressions: number;
  clicks: number;
  ctr: number | null;
  cpc: number | null;
  conversions: number;
  conversion_value: number;
  roas: number | null;
}

export interface ZomaAdsReport {
  account_id: string;
  currency?: string;
  level: (typeof LEVELS)[number];
  date_range: { preset: string } | { since: string; until: string };
  conversion_event: string | null;
  rows: ZomaAdsReportRow[];
  totals: Omit<ZomaAdsReportRow, 'campaign_id' | 'campaign_name'>;
  summary: string;
}

export interface ZomaAdsReportDeps {
  fetch: (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<any> }>;
  graphBaseUrl: string;
}

const defaultDeps = (): ZomaAdsReportDeps => ({
  fetch: (url, init) => fetch(url, init),
  graphBaseUrl: `https://graph.facebook.com/${process.env.META_API_VERSION || 'v25.0'}`,
});

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const validDate = (v: string) => DATE.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().startsWith(v);

interface ParsedArgs {
  range: { preset: string } | { since: string; until: string };
  level: (typeof LEVELS)[number];
  campaignIds: string[];
  conversionEvent: string | null;
}

export function parseZomaAdsReportArgs(args: any): ParsedArgs {
  const a = args && typeof args === 'object' ? args : {};
  const since = a.since === undefined ? undefined : String(a.since);
  const until = a.until === undefined ? undefined : String(a.until);
  let range: ParsedArgs['range'];
  if (since !== undefined || until !== undefined) {
    if (!since || !until || !validDate(since) || !validDate(until)) {
      throw new MetaToolkitRefusal('since and until must both be dates in YYYY-MM-DD form (or use date_preset).');
    }
    if (since > until) throw new MetaToolkitRefusal('since must be on or before until.');
    range = { since, until };
  } else {
    const preset = a.date_preset === undefined ? 'last_7d' : String(a.date_preset);
    if (!(ZOMA_REPORT_DATE_PRESETS as readonly string[]).includes(preset)) {
      throw new MetaToolkitRefusal(`date_preset must be one of: ${ZOMA_REPORT_DATE_PRESETS.join(', ')}.`);
    }
    range = { preset };
  }
  const level = a.level === undefined ? 'campaign' : String(a.level);
  if (!(LEVELS as readonly string[]).includes(level)) throw new MetaToolkitRefusal('level must be campaign or account.');
  let campaignIds: string[] = [];
  if (a.campaign_ids !== undefined) {
    if (!Array.isArray(a.campaign_ids) || a.campaign_ids.length > MAX_CAMPAIGN_IDS || !a.campaign_ids.every((id: unknown) => typeof id === 'string' && /^\d{1,32}$/.test(id))) {
      throw new MetaToolkitRefusal(`campaign_ids must be a list of up to ${MAX_CAMPAIGN_IDS} numeric Meta campaign ids.`);
    }
    campaignIds = a.campaign_ids;
  }
  let conversionEvent: string | null = null;
  if (a.conversion_event !== undefined) {
    if (typeof a.conversion_event !== 'string' || !/^[a-z0-9_.]{1,100}$/.test(a.conversion_event)) {
      throw new MetaToolkitRefusal('conversion_event must be a Meta action type such as purchase, lead or complete_registration.');
    }
    conversionEvent = a.conversion_event;
  }
  return { range, level: level as ParsedArgs['level'], campaignIds, conversionEvent };
}

const num = (v: unknown) => {
  const n = typeof v === 'number' ? v : Number.parseFloat(String(v ?? ''));
  return Number.isFinite(n) ? n : 0;
};
const round = (v: number, places = 2) => Math.round(v * 10 ** places) / 10 ** places;
const actionValue = (list: unknown, type: string) =>
  Array.isArray(list) ? list.filter((x: any) => x?.action_type === type).reduce((s: number, x: any) => s + num(x?.value), 0) : 0;
const hasAction = (rows: any[], type: string) =>
  rows.some((r) => Array.isArray(r?.actions) && r.actions.some((x: any) => x?.action_type === type));

/**
 * The one conversion action for this report: the caller's, else the first present by priority.
 * With a kpi, only that KPI's group is searched (ENG-3156).
 */
export function chooseConversionEvent(rows: any[], requested: string | null, kpi?: ConversionKpi): string | null {
  if (requested) return requested;
  const groups = kpi ? [CONVERSION_PRIORITY[CONVERSION_KPIS.indexOf(kpi)]] : CONVERSION_PRIORITY;
  for (const group of groups) {
    const found = group.find((type) => hasAction(rows, type));
    if (found) return found;
  }
  return null;
}

function metrics(spend: number, impressions: number, clicks: number, conversions: number, value: number) {
  return {
    spend: round(spend),
    impressions,
    clicks,
    ctr: impressions > 0 ? round((clicks / impressions) * 100) : null,
    cpc: clicks > 0 ? round(spend / clicks) : null,
    conversions: round(conversions, 4),
    conversion_value: round(value),
    roas: spend > 0 && value > 0 ? round(value / spend) : null,
  };
}

const money = (v: number | null, currency?: string) => (v === null ? '—' : `${v.toFixed(2)}${currency ? ` ${currency}` : ''}`);

function summarize(r: Omit<ZomaAdsReport, 'summary'>): string {
  const range = 'preset' in r.date_range ? r.date_range.preset : `${r.date_range.since} to ${r.date_range.until}`;
  const t = r.totals;
  const line = (label: string, m: Omit<ZomaAdsReportRow, 'campaign_id' | 'campaign_name'>) =>
    `${label}: spend ${money(m.spend, r.currency)}, ${m.impressions} impressions, ${m.clicks} clicks, CTR ${m.ctr === null ? '—' : `${m.ctr}%`}, ` +
    `CPC ${money(m.cpc, r.currency)}, ${m.conversions} conversions, ROAS ${m.roas === null ? '—' : m.roas}`;
  const head = `Meta ads report for act_${r.account_id}, ${range}${r.conversion_event ? ` (conversions = ${r.conversion_event})` : ' (no conversion actions recorded)'}:`;
  if (r.rows.length === 0) return `${head}\nNo delivery in this range (no spend or impressions).`;
  return [
    head,
    line('Total', t),
    ...(r.level === 'campaign' ? r.rows.map((row) => `• ${line(row.campaign_name || row.campaign_id || 'campaign', row)}`) : []),
  ].join('\n');
}

function graphError(status: number, body: any): MetaToolkitRefusal {
  const err = body?.error ?? {};
  if (err.code === 190) {
    return new MetaToolkitRefusal('The Meta connection expired or was revoked, so no report was read. Reconnect Meta with a fresh Zoma connect link (call zoma_status).');
  }
  const detail = typeof err.message === 'string' && err.message ? err.message.slice(0, 300) : `HTTP ${status}`;
  return new MetaToolkitRefusal(`Meta did not return the report (${detail}${err.code ? `, code ${err.code}` : ''}). Nothing was changed.`);
}

export async function runZomaAdsReport(
  account: ConnectedAccount,
  accountId: string,
  args: unknown,
  deps: ZomaAdsReportDeps = defaultDeps(),
  options: { kpi?: ConversionKpi } = {},
): Promise<ZomaAdsReport> {
  const parsed = parseZomaAdsReportArgs(args);
  const token = (account.config as any)?.access_token;
  if (typeof token !== 'string' || !token) {
    throw new MetaToolkitRefusal('This Meta connection has no usable access token, so no report was read. Reconnect Meta with a fresh Zoma connect link (call zoma_status).');
  }
  const params = new URLSearchParams({
    level: parsed.level,
    fields: [...(parsed.level === 'campaign' ? ['campaign_id', 'campaign_name'] : []), 'spend', 'impressions', 'clicks', 'actions', 'action_values', 'account_currency'].join(','),
    limit: '500',
  });
  if ('preset' in parsed.range) params.set('date_preset', parsed.range.preset);
  else params.set('time_range', JSON.stringify(parsed.range));
  if (parsed.campaignIds.length) params.set('filtering', JSON.stringify([{ field: 'campaign.id', operator: 'IN', value: parsed.campaignIds }]));
  params.set('access_token', token);

  const raw: any[] = [];
  let url: string | undefined = `${deps.graphBaseUrl.replace(/\/+$/, '')}/act_${accountId}/insights?${params.toString()}`;
  for (let page = 0; url; page++) {
    // Never present a partial read as complete totals.
    if (page >= MAX_PAGES) {
      throw new MetaToolkitRefusal(`This report has more than ${MAX_PAGES * 500} rows. Narrow it with campaign_ids or a shorter date range, or use level "account".`);
    }
    const res = await deps.fetch(url, { signal: AbortSignal.timeout(20000) });
    let body: any;
    try {
      body = await res.json();
    } catch {
      throw new MetaToolkitRefusal(`Meta returned an unreadable report (HTTP ${res.status}). Nothing was changed; try again shortly.`);
    }
    if (!res.ok || body?.error) throw graphError(res.status, body);
    if (!Array.isArray(body?.data)) throw new MetaToolkitRefusal('Meta returned a report without data rows. Nothing was changed; try again shortly.');
    raw.push(...body.data);
    url = typeof body?.paging?.next === 'string' ? body.paging.next : undefined;
  }

  const conversionEvent = chooseConversionEvent(raw, parsed.conversionEvent, options.kpi);
  // ROAS is always purchase value / spend, whatever is counted as a conversion.
  const valueEvent = conversionEvent && PURCHASE_TYPES.has(conversionEvent)
    ? conversionEvent
    : CONVERSION_PRIORITY[0].find((type) => raw.some((r) => Array.isArray(r?.action_values) && r.action_values.some((x: any) => x?.action_type === type))) ?? null;
  const rows: ZomaAdsReportRow[] = raw.map((r) => ({
    ...(parsed.level === 'campaign' ? { campaign_id: String(r.campaign_id ?? ''), campaign_name: r.campaign_name } : {}),
    ...metrics(
      num(r.spend),
      Math.round(num(r.impressions)),
      Math.round(num(r.clicks)),
      conversionEvent ? actionValue(r.actions, conversionEvent) : 0,
      valueEvent ? actionValue(r.action_values, valueEvent) : 0,
    ),
  }));
  rows.sort((a, b) => b.spend - a.spend);
  const sum = (k: 'spend' | 'impressions' | 'clicks' | 'conversions' | 'conversion_value') => rows.reduce((s, r) => s + r[k], 0);
  const totals = metrics(sum('spend'), sum('impressions'), sum('clicks'), sum('conversions'), sum('conversion_value'));
  const currency = raw.find((r) => typeof r?.account_currency === 'string')?.account_currency ?? (account.config as any)?.currency;
  const report = {
    account_id: accountId,
    ...(currency ? { currency } : {}),
    level: parsed.level,
    date_range: parsed.range,
    conversion_event: conversionEvent,
    rows,
    totals,
  };
  return { ...report, summary: summarize(report) };
}


// ---------------------------------------------------------------------------------------------
// ENG-3133: a per-day series for the weekly email. Additive: the tool above is unchanged.
// ---------------------------------------------------------------------------------------------

export interface ZomaAdsDailyRow {
  /** YYYY-MM-DD in the ad account's time zone (Meta's `date_start`). */
  date: string;
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  conversion_value: number;
}

export interface ZomaAdsDaily {
  account_id: string;
  currency?: string;
  conversion_event: string | null;
  /** Only days Meta returned a row for: a day with no delivery is absent, so callers fill the gaps with zeros. */
  rows: ZomaAdsDailyRow[];
}

const MAX_DAILY_SPAN_DAYS = 31;

/**
 * Account-level insights, one row per day, for an inclusive date window (at most 31 days). One conversion
 * event is chosen over the whole window so two weeks inside it compare like with like.
 */
export async function runZomaAdsDaily(
  account: ConnectedAccount,
  accountId: string,
  range: { since: string; until: string },
  deps: ZomaAdsReportDeps = defaultDeps(),
): Promise<ZomaAdsDaily> {
  if (!validDate(range.since) || !validDate(range.until) || range.since > range.until) {
    throw new MetaToolkitRefusal('since and until must be dates in YYYY-MM-DD form, with since on or before until.');
  }
  const days = (Date.parse(`${range.until}T00:00:00Z`) - Date.parse(`${range.since}T00:00:00Z`)) / 86_400_000 + 1;
  if (days > MAX_DAILY_SPAN_DAYS) throw new MetaToolkitRefusal(`A daily report covers at most ${MAX_DAILY_SPAN_DAYS} days.`);
  const token = (account.config as any)?.access_token;
  if (typeof token !== 'string' || !token) {
    throw new MetaToolkitRefusal('This Meta connection has no usable access token, so no report was read. Reconnect Meta with a fresh Zoma connect link (call zoma_status).');
  }
  const params = new URLSearchParams({
    level: 'account',
    fields: ['spend', 'impressions', 'clicks', 'actions', 'action_values', 'account_currency'].join(','),
    time_increment: '1',
    time_range: JSON.stringify(range),
    limit: '100',
    access_token: token,
  });
  const raw: any[] = [];
  let url: string | undefined = `${deps.graphBaseUrl.replace(/\/+$/, '')}/act_${accountId}/insights?${params.toString()}`;
  for (let page = 0; url; page++) {
    if (page >= MAX_PAGES) throw new MetaToolkitRefusal('Meta returned more daily rows than expected. Nothing was changed; try again shortly.');
    const res = await deps.fetch(url, { signal: AbortSignal.timeout(20000) });
    let body: any;
    try {
      body = await res.json();
    } catch {
      throw new MetaToolkitRefusal(`Meta returned an unreadable report (HTTP ${res.status}). Nothing was changed; try again shortly.`);
    }
    if (!res.ok || body?.error) throw graphError(res.status, body);
    if (!Array.isArray(body?.data)) throw new MetaToolkitRefusal('Meta returned a report without data rows. Nothing was changed; try again shortly.');
    raw.push(...body.data);
    url = typeof body?.paging?.next === 'string' ? body.paging.next : undefined;
  }
  const conversionEvent = chooseConversionEvent(raw, null);
  const valueEvent = conversionEvent && PURCHASE_TYPES.has(conversionEvent)
    ? conversionEvent
    : CONVERSION_PRIORITY[0].find((type) => raw.some((r) => Array.isArray(r?.action_values) && r.action_values.some((x: any) => x?.action_type === type))) ?? null;
  const rows: ZomaAdsDailyRow[] = raw
    .filter((r) => typeof r?.date_start === 'string' && DATE.test(r.date_start))
    .map((r) => ({
      date: r.date_start,
      spend: round(num(r.spend)),
      impressions: Math.round(num(r.impressions)),
      clicks: Math.round(num(r.clicks)),
      conversions: round(conversionEvent ? actionValue(r.actions, conversionEvent) : 0, 4),
      conversion_value: round(valueEvent ? actionValue(r.action_values, valueEvent) : 0),
    }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  const currency = raw.find((r) => typeof r?.account_currency === 'string')?.account_currency ?? (account.config as any)?.currency;
  return { account_id: accountId, ...(currency ? { currency } : {}), conversion_event: conversionEvent, rows };
}
