/**
 * ENG-3155 — zoma_measurement_report: the proactive measurement report, native to Zoma.
 *
 * One read-only report per Meta ad account and window (default the last 30 complete days):
 *   - every campaign that spent in the window, with spend, impressions, clicks, CTR, CPC, conversions
 *     and ROAS (the zoma_ads_report definitions, reused, not re-implemented);
 *   - CRM leads and cost per lead per campaign, from the same ENG-916 snapshot store and pure builder
 *     monitor_lead_volume uses (scoped to the caller's own account, so no admin lookup);
 *   - ad-level, demographics, placement and device breakdowns, each only when Meta returned rows;
 *   - findings that never misread a campaign: OUTCOME_ENGAGEMENT / LINK_CLICKS campaigns with no
 *     destination URL are listed as excluded (they cannot record conversions by design), and a
 *     campaign or account that started delivering in the last 7 days gets the new-delivery caveat
 *     and no winner/loser or pause/scale call.
 *
 * Rendered deterministically into a Zoma-owned HTML template (the public
 * multi_campaign_performance_report layout plus Conversions and ROAS columns; that public template is
 * a prod data row filled by an LLM, so extending it would be a data write and a non-deterministic
 * render) and hosted with the same S3 upload create_html_from_template uses. Empty sections are left
 * out; no number is ever invented. Dark until ZOMA_MEASUREMENT_REPORTS_ENABLED=true.
 */
import type { ConnectedAccount } from '../services/connectedAccountsDb';
import { MetaToolkitRefusal } from './metaToolkitErrors';
import { kpiOfConversionEvent, runZomaAdsReport, type ZomaAdsReport, type ZomaAdsReportDeps } from './zomaAdsReport';
import { BENCHMARK_NA, type BenchmarkFigure, compareCpa } from './zomaIndustryBenchmark';
import {
  BENCHMARK_INDUSTRIES,
  type BenchmarkIndustry,
  getIndustryBenchmark,
  INDUSTRY_BENCHMARK_TABLE_VERSION,
  isBenchmarkIndustry,
} from './zomaIndustryBenchmarks';

export const ZOMA_MEASUREMENT_REPORTS_FLAG = 'ZOMA_MEASUREMENT_REPORTS_ENABLED';
export function measurementReportsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[ZOMA_MEASUREMENT_REPORTS_FLAG] === 'true';
}

/**
 * Per-user rollout while the global flag is off: comma-separated userIds, orgIds and/or email domains
 * ('@slashy.com'). Matching is exact (domains case-insensitive, no subdomain match).
 */
export const ZOMA_MEASUREMENT_REPORTS_ALLOWLIST = 'ZOMA_MEASUREMENT_REPORTS_ALLOWLIST';

export interface MeasurementReportsSubject {
  userId?: string;
  email?: string;
  orgId?: string;
}

function parseAllowlist(env: NodeJS.ProcessEnv): { ids: Set<string>; domains: Set<string> } {
  const ids = new Set<string>();
  const domains = new Set<string>();
  for (const raw of String(env[ZOMA_MEASUREMENT_REPORTS_ALLOWLIST] ?? '').split(',')) {
    const entry = raw.trim();
    if (!entry) continue;
    if (entry.startsWith('@')) {
      if (entry.length > 1) domains.add(entry.slice(1).toLowerCase());
    } else ids.add(entry);
  }
  return { ids, domains };
}

/** True when the flag is on or the allowlist names at least one subject (the runner's pass-level gate). */
export function measurementReportsMaybeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (measurementReportsEnabled(env)) return true;
  const { ids, domains } = parseAllowlist(env);
  return ids.size > 0 || domains.size > 0;
}

/** The one gate: the global flag, or this user (by userId, orgId or email domain) is on the allowlist. */
export function measurementReportsEnabledFor(user: MeasurementReportsSubject | null | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  if (measurementReportsEnabled(env)) return true;
  if (!user) return false;
  const { ids, domains } = parseAllowlist(env);
  if (user.userId && ids.has(user.userId)) return true;
  if (user.orgId && ids.has(user.orgId)) return true;
  const at = user.email?.lastIndexOf('@') ?? -1;
  return at >= 0 && domains.has(user.email!.slice(at + 1).trim().toLowerCase());
}

export type LoadMeasurementReportsSubject = (userId: string) => Promise<MeasurementReportsSubject | undefined>;

const loadSubjectFromDb: LoadMeasurementReportsSubject = async (userId) => {
  const { userDb } = await import('../services/db');
  const user: any = await userDb.getUserByIdConsistent(userId);
  return user ? { userId, email: user.email, orgId: user.orgId } : undefined;
};

/**
 * measurementReportsEnabledFor, resolving the user's email/orgId only when needed: flag on or empty allowlist
 * decides without a read (so flag-off + empty allowlist is exactly the old flag check). A failed read fails closed.
 */
export async function measurementReportsEnabledForUserId(
  userId: string,
  env: NodeJS.ProcessEnv = process.env,
  loadUser: LoadMeasurementReportsSubject = loadSubjectFromDb,
): Promise<boolean> {
  if (!measurementReportsMaybeEnabled(env)) return false;
  if (measurementReportsEnabledFor({ userId }, env)) return true;
  try {
    return measurementReportsEnabledFor({ ...(await loadUser(userId)), userId }, env);
  } catch (error) {
    console.error('[zoma-measurement-report] allowlist user read failed:', error instanceof Error ? error.message : error);
    return false;
  }
}

export const ZOMA_MEASUREMENT_REPORT_TOOL = 'zoma_measurement_report';
export const isZomaMeasurementReportTool = (name: string) => name === ZOMA_MEASUREMENT_REPORT_TOOL;

/** The visible note on any account or campaign that started delivering in the last NEW_DELIVERY_DAYS days. */
export const NEW_DELIVERY_CAVEAT =
  'New account/campaign: delivery metrics typically take up to one week to stabilize. Best practice is to treat these results as qualitative signals rather than definitive performance.';
export const NEW_DELIVERY_DAYS = 7;
/** The exact 'vs. industry' line when there is no published benchmark row (ENG-3156 table). */
export const INDUSTRY_BENCHMARK_NA_LINE = 'Industry benchmark: N/A';
/** How the agent sets or corrects the industry (stored on the report schedule, used by scheduled and on-demand reports). */
const SET_INDUSTRY_HINT = 'Agent: set or correct it with zoma_report_schedule (action SET_INDUSTRY, industry), or pass industry to zoma_measurement_report.';

const DAY_MS = 24 * 60 * 60 * 1000;
const PRESET_DAYS = { last_7d: 7, last_14d: 14, last_30d: 30, last_90d: 90 } as const;
type Preset = keyof typeof PRESET_DAYS;
const MAX_SPAN_DAYS = 92;
const MAX_PAGES = 10;
const TOP_ADS = 10;
/** Objectives that are not built to produce conversions unless they send people somewhere. */
const NON_CONVERSION_OBJECTIVES = new Set(['OUTCOME_ENGAGEMENT', 'LINK_CLICKS', 'POST_ENGAGEMENT', 'PAGE_LIKES']);
const EXCLUSION_OBJECTIVES = new Set(['OUTCOME_ENGAGEMENT', 'LINK_CLICKS']);

export const ZOMA_MEASUREMENT_REPORT_DEFINITION = {
  name: ZOMA_MEASUREMENT_REPORT_TOOL,
  description:
    'Full measurement report for the connected Meta ad account: every campaign that spent in the window with spend, impressions, clicks, CTR, CPC, conversions, ROAS, ' +
    'CRM leads and cost per lead (when CRM data exists), plus top ads, demographics, placement and device breakdowns when Meta has them. ' +
    'Returns structured JSON and a hosted HTML report link (report_url) to share with the user. Read-only. Default window: last_30d. ' +
    'Campaigns that started delivering in the last 7 days carry a caveat: treat them as qualitative signals, never as winners or losers.',
  inputSchema: {
    type: 'object',
    properties: {
      date_preset: { type: 'string', enum: Object.keys(PRESET_DAYS), description: 'Window of complete days ending yesterday (UTC). Default last_30d. Ignored when since/until are set.' },
      since: { type: 'string', description: 'Start date YYYY-MM-DD (inclusive). Needs until.' },
      until: { type: 'string', description: 'End date YYYY-MM-DD (inclusive). Needs since.' },
      account_id: { type: 'string', description: 'Meta ad account id; needed only when more than one is connected.' },
      industry: { type: 'string', enum: [...BENCHMARK_INDUSTRIES], description: "The user's industry, for the vs. industry CPA line. Omit to use the industry stored on the report schedule (zoma_report_schedule SET_INDUSTRY); with none stored the line is N/A and asks the user for it." },
    },
    additionalProperties: false,
  },
};

// ---------------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------------

export interface MeasurementCampaign {
  campaign_id: string;
  campaign_name: string;
  objective?: string;
  /** First day it could deliver (Meta start_time, else created_time), when Meta returned one. */
  started_at?: string;
  new_delivery: boolean;
  spend: number;
  impressions: number;
  clicks: number;
  ctr: number | null;
  cpc: number | null;
  conversions: number;
  roas: number | null;
  /** CRM leads attributed to this campaign in the window; null when there is no CRM data for it. */
  crm_leads: number | null;
  cost_per_lead: number | null;
}

export interface ExcludedCampaign {
  campaign_id: string;
  campaign_name: string;
  reason: string;
}

export type FindingType = 'no_conversions' | 'lowest_cost_per_conversion' | 'highest_cost_per_conversion';
export interface MeasurementFinding {
  type: FindingType;
  campaign_id: string;
  campaign_name: string;
  text: string;
  /** Only on cost-per-conversion findings, and never for a new-delivery campaign or account. */
  recommendation?: 'scale' | 'review_or_pause';
}

export interface MeasurementCaveat {
  scope: 'account' | 'campaign';
  campaign_id?: string;
  campaign_name?: string;
  text: string;
}

export interface BreakdownRow {
  label: string;
  spend: number;
  impressions: number;
  clicks: number;
  ctr: number | null;
}
export interface AdRow extends BreakdownRow {
  ad_id: string;
  campaign_id?: string;
  conversions: number;
}

/** The report's 'vs. industry' comparison (ENG-3156 benchmark table; customer numbers from this report's own totals). */
export interface MeasurementIndustryBenchmark {
  /** The rendered line; exactly INDUSTRY_BENCHMARK_NA_LINE when no benchmark row applies. */
  line: string;
  industry: BenchmarkIndustry | null;
  kpi: string | null;
  customer_cpa: number | null;
  benchmark: BenchmarkFigure | typeof BENCHMARK_NA;
  comparison: { difference_percent: number; verdict: 'better' | 'worse' | 'same' } | null;
  /** Why there is no comparison (unknown industry, no conversions, currency mismatch, new account). */
  note: string | null;
}

export interface MeasurementReport {
  account_id: string;
  currency?: string;
  date_range: { since: string; until: string };
  conversion_event: string | null;
  new_account: boolean;
  totals: { spend: number; impressions: number; clicks: number; ctr: number | null; cpc: number | null; conversions: number; roas: number | null; crm_leads: number | null; cost_per_lead: number | null };
  campaigns: MeasurementCampaign[];
  excluded_from_conversion_findings: ExcludedCampaign[];
  findings: MeasurementFinding[];
  caveats: MeasurementCaveat[];
  /** Only sections with rows are present. */
  breakdowns: { top_ads?: AdRow[]; demographics?: BreakdownRow[]; placements?: BreakdownRow[]; devices?: BreakdownRow[] };
  /** CRM leads that landed on the account but on no campaign (never folded into a campaign's count). */
  unattributed_crm_leads?: number;
  industryBenchmark: MeasurementIndustryBenchmark;
  report_url?: string;
  summary: string;
}

/** Campaign + account facts Meta returns outside insights. */
export interface CampaignMeta {
  id: string;
  name?: string;
  objective?: string;
  start_time?: string;
  created_time?: string;
}

export interface LeadFigures {
  /** campaign id -> leads in the window. */
  byCampaign: Map<string, number>;
  unattributed: number;
}

export interface MeasurementReportDeps extends ZomaAdsReportDeps {
  now: () => number;
  runAdsReport: (account: ConnectedAccount, accountId: string, args: any) => Promise<ZomaAdsReport>;
  /** CRM leads for the user's own account in the window; null when there is no CRM data at all. */
  getLeads: (userId: string, accountId: string, range: { since: string; until: string }) => Promise<LeadFigures | null>;
  uploadHtml: (html: string, filename: string, userId: string) => Promise<string>;
}

export const defaultMeasurementReportDeps = (): MeasurementReportDeps => ({
  fetch: (url, init) => fetch(url, init),
  graphBaseUrl: `https://graph.facebook.com/${process.env.META_API_VERSION || 'v25.0'}`,
  now: () => Date.now(),
  runAdsReport: (account, accountId, args) => runZomaAdsReport(account, accountId, args),
  getLeads: defaultGetLeads,
  uploadHtml: defaultUploadHtml,
});

// ---------------------------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------------------------

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const validDate = (v: string) => DATE.test(v) && new Date(`${v}T00:00:00Z`).toISOString().startsWith(v);
const isoDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export function measurementRange(args: any, nowMs: number): { since: string; until: string } {
  const a = args && typeof args === 'object' ? args : {};
  if (a.since !== undefined || a.until !== undefined) {
    const since = String(a.since ?? '');
    const until = String(a.until ?? '');
    if (!validDate(since) || !validDate(until)) throw new MetaToolkitRefusal('since and until must both be dates in YYYY-MM-DD form (or use date_preset).');
    if (since > until) throw new MetaToolkitRefusal('since must be on or before until.');
    const span = (Date.parse(`${until}T00:00:00Z`) - Date.parse(`${since}T00:00:00Z`)) / DAY_MS + 1;
    if (span > MAX_SPAN_DAYS) throw new MetaToolkitRefusal(`A measurement report covers at most ${MAX_SPAN_DAYS} days.`);
    return { since, until };
  }
  const preset = a.date_preset === undefined ? 'last_30d' : String(a.date_preset);
  if (!(preset in PRESET_DAYS)) throw new MetaToolkitRefusal(`date_preset must be one of: ${Object.keys(PRESET_DAYS).join(', ')}.`);
  const until = Date.parse(`${isoDate(nowMs)}T00:00:00Z`) - DAY_MS;
  return { since: isoDate(until - (PRESET_DAYS[preset as Preset] - 1) * DAY_MS), until: isoDate(until) };
}

// ---------------------------------------------------------------------------------------------
// Pure rules
// ---------------------------------------------------------------------------------------------

/** True when `startIso` is within the last NEW_DELIVERY_DAYS days of `nowMs` (a missing or bad date is not new). */
export function startedRecently(startIso: string | undefined, nowMs: number): boolean {
  const t = startIso ? Date.parse(startIso) : NaN;
  return Number.isFinite(t) && t > nowMs - NEW_DELIVERY_DAYS * DAY_MS;
}

const round = (v: number, places = 2) => Math.round(v * 10 ** places) / 10 ** places;

/**
 * Findings, exclusions and caveats from campaign rows. Deterministic; facts only.
 *  - excluded: OUTCOME_ENGAGEMENT / LINK_CLICKS campaigns with no destination URL (never a conversion failure).
 *  - new-delivery campaigns (or every campaign, on a new account) get the caveat and nothing else.
 *  - no_conversions: an established campaign that spent with zero of the report's conversion event.
 *  - lowest / highest cost per conversion: needs two established campaigns with at least one whole conversion each.
 */
export function measurementFindings(
  campaigns: MeasurementCampaign[],
  opts: { conversionEvent: string | null; newAccount: boolean; withDestination: Set<string> | null; currency?: string },
): { findings: MeasurementFinding[]; excluded: ExcludedCampaign[]; caveats: MeasurementCaveat[] } {
  const excluded: ExcludedCampaign[] = [];
  const caveats: MeasurementCaveat[] = [];
  const findings: MeasurementFinding[] = [];
  if (opts.newAccount) caveats.push({ scope: 'account', text: NEW_DELIVERY_CAVEAT });
  const eligible: MeasurementCampaign[] = [];
  for (const c of campaigns) {
    const objective = String(c.objective ?? '').toUpperCase();
    if (EXCLUSION_OBJECTIVES.has(objective) && !(opts.withDestination?.has(c.campaign_id))) {
      excluded.push({
        campaign_id: c.campaign_id,
        campaign_name: c.campaign_name,
        reason: opts.withDestination
          ? `${objective} campaign with no destination URL: it records zero conversions by design, so that is not a failure.`
          : `${objective} campaign whose destination URL could not be checked: not judged on conversions.`,
      });
      continue;
    }
    if (c.new_delivery && !opts.newAccount) {
      caveats.push({ scope: 'campaign', campaign_id: c.campaign_id, campaign_name: c.campaign_name, text: NEW_DELIVERY_CAVEAT });
      continue;
    }
    if (opts.newAccount) continue;
    eligible.push(c);
  }
  if (opts.newAccount) return { findings, excluded, caveats };

  const event = opts.conversionEvent;
  const money = (n: number) => `${n.toFixed(2)}${opts.currency ? ` ${opts.currency}` : ''}`;
  if (event) {
    for (const c of eligible) {
      // Engagement-type campaigns that DO have a destination still are not built for this event: say nothing.
      if (c.spend > 0 && c.conversions === 0 && !NON_CONVERSION_OBJECTIVES.has(String(c.objective ?? '').toUpperCase())) {
        findings.push({
          type: 'no_conversions',
          campaign_id: c.campaign_id,
          campaign_name: c.campaign_name,
          text: `${c.campaign_name} spent ${money(c.spend)} with no ${event} conversions recorded in this window. If you expect some, check that conversion tracking is set up.`,
        });
      }
    }
    const priced = eligible.filter((c) => c.conversions >= 1).map((c) => ({ c, cost: c.spend / c.conversions }));
    if (priced.length >= 2) {
      priced.sort((x, y) => x.cost - y.cost);
      const lo = priced[0];
      const hi = priced[priced.length - 1];
      if (round(lo.cost) !== round(hi.cost)) {
        findings.push({ type: 'lowest_cost_per_conversion', campaign_id: lo.c.campaign_id, campaign_name: lo.c.campaign_name, recommendation: 'scale',
          text: `${lo.c.campaign_name} had the lowest cost per conversion (${money(lo.cost)}): a candidate for more budget.` });
        findings.push({ type: 'highest_cost_per_conversion', campaign_id: hi.c.campaign_id, campaign_name: hi.c.campaign_name, recommendation: 'review_or_pause',
          text: `${hi.c.campaign_name} had the highest cost per conversion (${money(hi.cost)}): review it, and consider pausing it or moving its budget.` });
      }
    }
  }
  return { findings, excluded, caveats };
}

/** The caller-named industry, or null. Never classified here: no extra Graph read or LLM call. */
export function measurementIndustry(args: any): BenchmarkIndustry | null {
  const v = args && typeof args === 'object' ? args.industry : undefined;
  if (v === undefined) return null;
  if (!isBenchmarkIndustry(v)) throw new MetaToolkitRefusal(`industry must be one of: ${BENCHMARK_INDUSTRIES.join(', ')}.`);
  return v;
}

/**
 * The vs. industry comparison from the report's own totals (customer CPA = spend / conversions of the
 * report's conversion event) and getIndustryBenchmark. No row -> exactly INDUSTRY_BENCHMARK_NA_LINE; a
 * new-delivery account is not compared at all (the caveat is shown instead).
 */
export function measurementIndustryBenchmark(input: {
  industry: BenchmarkIndustry | null;
  conversionEvent: string | null;
  spend: number;
  conversions: number;
  currency: string | null;
  newAccount: boolean;
}): MeasurementIndustryBenchmark {
  const kpi = kpiOfConversionEvent(input.conversionEvent);
  const customerCpa = input.conversions > 0 ? round(input.spend / input.conversions) : null;
  const base = { industry: input.industry, kpi, customer_cpa: customerCpa, benchmark: BENCHMARK_NA as typeof BENCHMARK_NA, comparison: null };
  if (input.newAccount) {
    return { ...base, line: `Industry benchmark: not compared. ${NEW_DELIVERY_CAVEAT}`, note: NEW_DELIVERY_CAVEAT };
  }
  if (!input.industry) {
    return {
      ...base,
      line: INDUSTRY_BENCHMARK_NA_LINE,
      note: `Tell us your industry (one of: ${BENCHMARK_INDUSTRIES.join(', ')}) to compare your CPA with an industry benchmark. ${SET_INDUSTRY_HINT}`,
    };
  }
  const row = kpi ? getIndustryBenchmark(input.industry, 'meta', kpi) : null;
  if (!row) {
    return { ...base, line: INDUSTRY_BENCHMARK_NA_LINE, note: `No published ${kpi ?? 'conversion'} benchmark for the ${input.industry} industry. If that industry is wrong: ${SET_INDUSTRY_HINT}` };
  }
  const benchmark: BenchmarkFigure = {
    cpa: row.cpa, currency: row.currency, metric: row.metric, source_name: row.sourceName, year: row.year, url: row.url, table_version: INDUSTRY_BENCHMARK_TABLE_VERSION,
  };
  const money = (v: number, c: string | null) => `${v.toFixed(2)}${c ? ` ${c}` : ''}`;
  const source = `source: ${row.sourceName}, ${row.year}, ${row.url}`;
  let note: string | null = null;
  if (customerCpa === null) note = `No ${kpi} conversions in this window, so your CPA is undefined and is not compared.`;
  else if (input.currency && input.currency !== row.currency) note = `Your account reports in ${input.currency} and the benchmark is in ${row.currency}; they are not compared without an exchange rate.`;
  if (note || customerCpa === null) {
    return { ...base, benchmark, note, line: `Industry benchmark (${input.industry}): ${money(row.cpa, row.currency)} ${row.metric}; not compared: ${note} (${source})` };
  }
  const comparison = compareCpa(customerCpa, row.cpa);
  const d = Math.abs(comparison.difference_percent);
  const diff = comparison.verdict === 'same' ? 'equal to the benchmark' : `${d}% ${comparison.verdict === 'better' ? 'below' : 'above'} the benchmark (${comparison.verdict}; lower CPA is better)`;
  return {
    ...base,
    benchmark,
    comparison,
    note: null,
    line: `vs. industry (${input.industry}): your CPA ${money(customerCpa, input.currency)} vs ${money(row.cpa, row.currency)} benchmark ${row.metric}, ${diff} (${source})`,
  };
}

/** A destination is a real http(s) URL off Facebook/Instagram (a link back to the Page is not one). */
export function creativeDestination(creative: any): string | null {
  const candidates = [
    creative?.object_story_spec?.link_data?.link,
    creative?.object_story_spec?.video_data?.call_to_action?.value?.link,
    creative?.object_story_spec?.link_data?.call_to_action?.value?.link,
    creative?.link_url,
    creative?.object_url,
    ...(Array.isArray(creative?.asset_feed_spec?.link_urls) ? creative.asset_feed_spec.link_urls.map((l: any) => l?.website_url) : []),
  ];
  for (const raw of candidates) {
    if (typeof raw !== 'string') continue;
    try {
      const u = new URL(raw);
      if (!/^https?:$/.test(u.protocol)) continue;
      if (/(^|\.)(facebook\.com|fb\.me|instagram\.com|fb\.com)$/i.test(u.hostname)) continue;
      return raw;
    } catch {
      /* not a URL */
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Graph reads (each optional section fails soft: no rows -> no section)
// ---------------------------------------------------------------------------------------------

const num = (v: unknown) => {
  const n = typeof v === 'number' ? v : Number.parseFloat(String(v ?? ''));
  return Number.isFinite(n) ? n : 0;
};
const actionCount = (list: unknown, type: string | null) =>
  type && Array.isArray(list) ? list.filter((x: any) => x?.action_type === type).reduce((s: number, x: any) => s + num(x?.value), 0) : 0;

async function graphAll(deps: ZomaAdsReportDeps, path: string, params: Record<string, string>, token: string): Promise<any[]> {
  const qs = new URLSearchParams({ ...params, access_token: token });
  let url: string | undefined = `${deps.graphBaseUrl.replace(/\/+$/, '')}/${path}?${qs.toString()}`;
  const out: any[] = [];
  for (let page = 0; url; page++) {
    if (page >= MAX_PAGES) throw new Error(`more than ${MAX_PAGES} pages`);
    const res = await deps.fetch(url, { signal: AbortSignal.timeout(20000) });
    const body = await res.json();
    if (!res.ok || body?.error) throw new Error(`Meta read failed (${body?.error?.message ?? `HTTP ${res.status}`})`);
    if (Array.isArray(body?.data)) out.push(...body.data);
    else return [body];
    url = typeof body?.paging?.next === 'string' ? body.paging.next : undefined;
  }
  return out;
}

const breakdownRow = (label: string, r: any): BreakdownRow => {
  const impressions = Math.round(num(r.impressions));
  const clicks = Math.round(num(r.clicks));
  return { label, spend: round(num(r.spend)), impressions, clicks, ctr: impressions > 0 ? round((clicks / impressions) * 100) : null };
};

const nonEmpty = <T extends { spend: number; impressions: number }>(rows: T[]) => rows.filter((r) => r.spend > 0 || r.impressions > 0).sort((a, b) => b.spend - a.spend);

async function optional<T>(label: string, read: () => Promise<T>): Promise<T | undefined> {
  try {
    return await read();
  } catch (error) {
    console.warn(`[zoma-measurement-report] ${label} skipped:`, error instanceof Error ? error.message : error);
    return undefined;
  }
}

// ---------------------------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------------------------

export async function buildZomaMeasurementReport(
  userId: string,
  account: ConnectedAccount,
  accountId: string,
  args: unknown,
  deps: MeasurementReportDeps = defaultMeasurementReportDeps(),
): Promise<MeasurementReport> {
  const nowMs = deps.now();
  const range = measurementRange(args, nowMs);
  const industry = measurementIndustry(args);
  const token = (account.config as any)?.access_token;
  if (typeof token !== 'string' || !token) {
    throw new MetaToolkitRefusal('This Meta connection has no usable access token, so no report was read. Reconnect Meta with a fresh Zoma connect link (call zoma_status).');
  }
  // The core numbers are required: a failure here is the tool's failure, never an empty report.
  const ads = await deps.runAdsReport(account, accountId, { level: 'campaign', since: range.since, until: range.until });
  const spending = ads.rows.filter((r) => r.spend > 0);
  const ids = spending.map((r) => r.campaign_id).filter((id): id is string => !!id);
  const timeRange = JSON.stringify(range);
  const insights = (extra: Record<string, string>) => graphAll(deps, `act_${accountId}/insights`, { time_range: timeRange, limit: '500', ...extra }, token);

  const [campaignMeta, accountMeta, destinations, leads, adRows, demo, placement, device] = await Promise.all([
    ids.length
      ? optional('campaign details', () => graphAll(deps, `act_${accountId}/campaigns`, {
        fields: 'id,name,objective,start_time,created_time',
        filtering: JSON.stringify([{ field: 'id', operator: 'IN', value: ids }]),
        limit: '500',
      }, token) as Promise<CampaignMeta[]>)
      : Promise.resolve([] as CampaignMeta[]),
    optional('account details', () => graphAll(deps, `act_${accountId}`, { fields: 'created_time' }, token)),
    ids.length
      ? optional('ad destinations', async () => {
        const rows = await graphAll(deps, `act_${accountId}/ads`, {
          fields: 'campaign_id,creative{link_url,object_url,object_story_spec,asset_feed_spec}',
          filtering: JSON.stringify([{ field: 'campaign.id', operator: 'IN', value: ids }]),
          limit: '200',
        }, token);
        return new Set(rows.filter((r) => creativeDestination(r?.creative)).map((r) => String(r.campaign_id)));
      })
      : Promise.resolve(new Set<string>()),
    optional('CRM leads', () => deps.getLeads(userId, accountId, range)),
    spending.length ? optional('ad-level', () => insights({ level: 'ad', fields: 'ad_id,ad_name,campaign_id,spend,impressions,clicks,actions' })) : Promise.resolve(undefined),
    spending.length ? optional('demographics', () => insights({ level: 'account', breakdowns: 'age,gender', fields: 'spend,impressions,clicks' })) : Promise.resolve(undefined),
    spending.length ? optional('placement', () => insights({ level: 'account', breakdowns: 'publisher_platform,platform_position', fields: 'spend,impressions,clicks' })) : Promise.resolve(undefined),
    spending.length ? optional('device', () => insights({ level: 'account', breakdowns: 'impression_device', fields: 'spend,impressions,clicks' })) : Promise.resolve(undefined),
  ]);

  const metaById = new Map((campaignMeta ?? []).map((c) => [String(c.id), c]));
  const newAccount = startedRecently(accountMeta?.[0]?.created_time, nowMs);
  const campaigns: MeasurementCampaign[] = spending.map((r) => {
    const meta = metaById.get(String(r.campaign_id));
    const startedAt = meta?.start_time ?? meta?.created_time;
    const crm = leads ? leads.byCampaign.get(String(r.campaign_id)) : undefined;
    return {
      campaign_id: String(r.campaign_id ?? ''),
      campaign_name: String(r.campaign_name || meta?.name || r.campaign_id || 'Untitled campaign'),
      ...(meta?.objective ? { objective: meta.objective } : {}),
      ...(startedAt ? { started_at: startedAt } : {}),
      new_delivery: newAccount || startedRecently(startedAt, nowMs),
      spend: r.spend,
      impressions: r.impressions,
      clicks: r.clicks,
      ctr: r.ctr,
      cpc: r.cpc,
      conversions: r.conversions,
      roas: r.roas,
      crm_leads: crm === undefined ? null : crm,
      cost_per_lead: crm !== undefined && crm > 0 ? round(r.spend / crm) : null,
    };
  });
  const { findings, excluded, caveats } = measurementFindings(campaigns, {
    conversionEvent: ads.conversion_event,
    newAccount,
    withDestination: destinations ?? null,
    currency: ads.currency,
  });

  const leadTotal = campaigns.some((c) => c.crm_leads !== null) ? campaigns.reduce((s, c) => s + (c.crm_leads ?? 0), 0) : null;
  const totals = {
    spend: ads.totals.spend, impressions: ads.totals.impressions, clicks: ads.totals.clicks, ctr: ads.totals.ctr, cpc: ads.totals.cpc,
    conversions: ads.totals.conversions, roas: ads.totals.roas,
    crm_leads: leadTotal,
    cost_per_lead: leadTotal && leadTotal > 0 ? round(ads.totals.spend / leadTotal) : null,
  };

  const breakdowns: MeasurementReport['breakdowns'] = {};
  const topAds = adRows && nonEmpty(adRows.map((r) => ({
    ...breakdownRow(String(r.ad_name || r.ad_id || 'Ad'), r),
    ad_id: String(r.ad_id ?? ''),
    ...(r.campaign_id ? { campaign_id: String(r.campaign_id) } : {}),
    conversions: round(actionCount(r.actions, ads.conversion_event), 4),
  }))).slice(0, TOP_ADS);
  if (topAds?.length) breakdowns.top_ads = topAds;
  const demographics = demo && nonEmpty(demo.map((r) => breakdownRow(`${r.age ?? 'unknown'} · ${r.gender ?? 'unknown'}`, r)));
  if (demographics?.length) breakdowns.demographics = demographics;
  const placements = placement && nonEmpty(placement.map((r) => breakdownRow(`${r.publisher_platform ?? 'unknown'} · ${String(r.platform_position ?? 'unknown').replace(/_/g, ' ')}`, r)));
  if (placements?.length) breakdowns.placements = placements;
  const devices = device && nonEmpty(device.map((r) => breakdownRow(String(r.impression_device ?? 'unknown').replace(/_/g, ' '), r)));
  if (devices?.length) breakdowns.devices = devices;

  const report: MeasurementReport = {
    account_id: accountId,
    ...(ads.currency ? { currency: ads.currency } : {}),
    date_range: range,
    conversion_event: ads.conversion_event,
    new_account: newAccount,
    totals,
    campaigns,
    excluded_from_conversion_findings: excluded,
    findings,
    caveats,
    breakdowns,
    ...(leads && leads.unattributed > 0 ? { unattributed_crm_leads: leads.unattributed } : {}),
    industryBenchmark: measurementIndustryBenchmark({
      industry, conversionEvent: ads.conversion_event, spend: totals.spend, conversions: totals.conversions, currency: ads.currency ?? null, newAccount,
    }),
    summary: '',
  };
  report.summary = measurementSummary(report);
  return report;
}

/** Build, render and host. The hosted link is part of the answer; an upload failure fails the call loudly. */
export async function runZomaMeasurementReport(
  userId: string,
  account: ConnectedAccount,
  accountId: string,
  args: unknown,
  deps: MeasurementReportDeps = defaultMeasurementReportDeps(),
): Promise<MeasurementReport> {
  const report = await buildZomaMeasurementReport(userId, account, accountId, args, deps);
  const html = renderMeasurementReportHtml(report);
  report.report_url = await deps.uploadHtml(html, `zoma_measurement_report_${accountId}_${report.date_range.until}.html`, userId);
  return report;
}

export function measurementSummary(r: MeasurementReport): string {
  const money = (v: number | null) => (v === null ? '—' : `${v.toFixed(2)}${r.currency ? ` ${r.currency}` : ''}`);
  const head = `Measurement report for act_${r.account_id}, ${r.date_range.since} to ${r.date_range.until}.`;
  if (!r.campaigns.length) return `${head} No campaign spent in this window.`;
  const t = r.totals;
  const lines = [
    head,
    `${r.campaigns.length} campaign${r.campaigns.length === 1 ? '' : 's'} with spend: ${money(t.spend)}, ${t.impressions} impressions, ${t.clicks} clicks, ` +
      `${t.conversions} conversions${r.conversion_event ? ` (${r.conversion_event})` : ''}, ROAS ${t.roas ?? '—'}` +
      `${t.crm_leads !== null ? `, ${t.crm_leads} CRM leads (cost per lead ${money(t.cost_per_lead)})` : ''}.`,
  ];
  if (r.caveats.length) lines.push(`${r.new_account ? 'This ad account' : `${r.caveats.length} campaign${r.caveats.length === 1 ? '' : 's'}`} started delivering in the last ${NEW_DELIVERY_DAYS} days: ${NEW_DELIVERY_CAVEAT}`);
  for (const f of r.findings) lines.push(`• ${f.text}`);
  for (const e of r.excluded_from_conversion_findings) lines.push(`• Not judged on conversions: ${e.campaign_name} (${e.reason})`);
  // The new-account caveat is already stated above; repeating it here would say it twice.
  if (!r.new_account) {
    lines.push(r.industryBenchmark.line);
    if (r.industryBenchmark.note && r.industryBenchmark.line === INDUSTRY_BENCHMARK_NA_LINE) lines.push(r.industryBenchmark.note);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------------------------
// HTML (Zoma-owned template: the multi_campaign_performance_report layout + Conversions and ROAS)
// ---------------------------------------------------------------------------------------------

const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

export const ZOMA_MEASUREMENT_REPORT_TEMPLATE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>{{report_title}}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #1F2937; background: #F9FAFB; margin: 0; padding: 32px; }
  .report { max-width: 1040px; margin: 0 auto; background: #fff; border-radius: 12px; padding: 32px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
  header h1 { margin: 0 0 4px; font-size: 24px; }
  header p { margin: 0; color: #6B7280; }
  .caveat { margin: 20px 0; padding: 12px 16px; background: #FFF8E1; border-left: 4px solid #F9AB00; font-size: 14px; }
  .summary-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 16px; margin: 28px 0; }
  .stat-tile { background: #F9FAFB; border: 1px solid #E5E7EB; border-radius: 8px; padding: 16px; text-align: center; }
  .stat-tile span { display: block; font-size: 20px; font-weight: 700; color: #2563EB; }
  .stat-tile label { display: block; font-size: 12px; color: #6B7280; margin-top: 4px; }
  section { margin: 28px 0; }
  section h2 { font-size: 18px; margin-bottom: 12px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #E5E7EB; font-size: 13px; }
  th { color: #6B7280; font-weight: 600; }
  .tag { display: inline-block; font-size: 11px; padding: 1px 6px; border-radius: 4px; background: #FFF8E1; color: #5B4A00; margin-left: 6px; }
  ul { padding-left: 20px; }
  footer { color: #6B7280; font-size: 12px; margin-top: 28px; }
</style>
</head>
<body>
<div class="report">
  <header>
    <h1>{{report_title}}</h1>
    <p>act_{{account_id}} &middot; {{date_range}}</p>
  </header>
{{caveat_section}}
  <section class="summary-grid">{{summary_tiles}}</section>
{{findings_section}}
{{campaign_section}}
{{excluded_section}}
{{ads_section}}
{{demographics_section}}
{{placements_section}}
{{devices_section}}
{{industry_section}}
  <footer>Generated by Zoma {{generated_date}}</footer>
</div>
</body>
</html>`;

function industrySection(ib: MeasurementIndustryBenchmark): string {
  const link = ib.benchmark !== BENCHMARK_NA ? ` <a href="${esc(ib.benchmark.url)}">${esc(ib.benchmark.source_name)}, ${esc(ib.benchmark.year)}</a>` : '';
  const note = ib.note && ib.line === INDUSTRY_BENCHMARK_NA_LINE ? `<p>${esc(ib.note)}</p>` : '';
  return `  <section><h2>vs. Industry</h2><p>${esc(ib.line)}</p>${link ? `<p>Source:${link}</p>` : ''}${note}</section>`;
}

const fill = (template: string, slots: Record<string, string>) => template.replace(/\{\{(\w+)\}\}/g, (_m, k: string) => slots[k] ?? '');

export function renderMeasurementReportHtml(r: MeasurementReport): string {
  const money = (v: number | null) => (v === null ? '—' : `${v.toFixed(2)}${r.currency ? ` ${r.currency}` : ''}`);
  const pct = (v: number | null) => (v === null ? '—' : `${v}%`);
  const n = (v: number | null) => (v === null ? '—' : v.toLocaleString('en-US'));
  const tile = (label: string, value: string) => `<div class="stat-tile"><span>${esc(value)}</span><label>${esc(label)}</label></div>`;
  const t = r.totals;
  const tiles = [
    tile('Campaigns', String(r.campaigns.length)), tile('Total Spend', money(t.spend)), tile('Impressions', n(t.impressions)), tile('Clicks', n(t.clicks)),
    tile('CTR', pct(t.ctr)), tile('CPC', money(t.cpc)), tile('Conversions', n(t.conversions)), tile('ROAS', t.roas === null ? '—' : `${t.roas}x`),
    ...(t.crm_leads !== null ? [tile('CRM Leads', n(t.crm_leads)), tile('Cost / Lead', money(t.cost_per_lead))] : []),
  ].join('');
  const showLeads = r.campaigns.some((c) => c.crm_leads !== null);
  const campaignRows = r.campaigns.map((c) => `<tr><td>${esc(c.campaign_name)}${c.new_delivery ? '<span class="tag">new</span>' : ''}</td><td>${esc(money(c.spend))}</td><td>${esc(n(c.impressions))}</td><td>${esc(n(c.clicks))}</td><td>${esc(pct(c.ctr))}</td><td>${esc(money(c.cpc))}</td><td>${esc(n(c.conversions))}</td><td>${esc(c.roas === null ? '—' : `${c.roas}x`)}</td>${showLeads ? `<td>${esc(n(c.crm_leads))}</td><td>${esc(money(c.cost_per_lead))}</td>` : ''}</tr>`).join('');
  const table = (title: string, rows: BreakdownRow[]) =>
    `  <section><h2>${esc(title)}</h2><table><thead><tr><th></th><th>Spend</th><th>Impressions</th><th>Clicks</th><th>CTR</th></tr></thead><tbody>${rows.map((x) => `<tr><td>${esc(x.label)}</td><td>${esc(money(x.spend))}</td><td>${esc(n(x.impressions))}</td><td>${esc(n(x.clicks))}</td><td>${esc(pct(x.ctr))}</td></tr>`).join('')}</tbody></table></section>`;
  const caveatText = r.new_account
    ? NEW_DELIVERY_CAVEAT
    : r.caveats.length ? `${NEW_DELIVERY_CAVEAT} Applies to: ${r.caveats.map((c) => c.campaign_name).join(', ')}.` : '';
  const b = r.breakdowns;
  return fill(ZOMA_MEASUREMENT_REPORT_TEMPLATE, {
    report_title: esc('Meta Ads Measurement Report'),
    account_id: esc(r.account_id),
    date_range: esc(`${r.date_range.since} to ${r.date_range.until}`),
    caveat_section: caveatText ? `  <div class="caveat">${esc(caveatText)}</div>` : '',
    summary_tiles: tiles,
    findings_section: r.findings.length ? `  <section><h2>Findings</h2><ul>${r.findings.map((f) => `<li>${esc(f.text)}</li>`).join('')}</ul></section>` : '',
    campaign_section: r.campaigns.length
      ? `  <section><h2>Campaign Breakdown</h2><table><thead><tr><th>Campaign</th><th>Spend</th><th>Impressions</th><th>Clicks</th><th>CTR</th><th>CPC</th><th>Conversions</th><th>ROAS</th>${showLeads ? '<th>CRM Leads</th><th>Cost / Lead</th>' : ''}</tr></thead><tbody>${campaignRows}</tbody></table></section>`
      : '  <section><p>No campaign spent in this window.</p></section>',
    excluded_section: r.excluded_from_conversion_findings.length
      ? `  <section><h2>Not judged on conversions</h2><ul>${r.excluded_from_conversion_findings.map((e) => `<li>${esc(e.campaign_name)}: ${esc(e.reason)}</li>`).join('')}</ul></section>`
      : '',
    ads_section: b.top_ads?.length ? table('Top Ads by Spend', b.top_ads) : '',
    demographics_section: b.demographics?.length ? table('Demographics', b.demographics) : '',
    placements_section: b.placements?.length ? table('Placement', b.placements) : '',
    devices_section: b.devices?.length ? table('Device', b.devices) : '',
    industry_section: industrySection(r.industryBenchmark),
    generated_date: esc(r.date_range.until),
  });
}

// ---------------------------------------------------------------------------------------------
// Production readers
// ---------------------------------------------------------------------------------------------

const bareId = (id: string) => String(id ?? '').replace(/^act_/, '');

/** The monitor_lead_volume data path (ENG-916 snapshots + buildLeadVolumeReport), for the caller's own account. */
async function defaultGetLeads(userId: string, accountId: string, range: { since: string; until: string }): Promise<LeadFigures | null> {
  const [{ adsMetricsDb }, { buildLeadVolumeReport }] = await Promise.all([import('../services/adsMetricsDb'), import('../services/leadVolumeMonitor')]);
  const [campaignResult, accountDayResult] = await Promise.all([
    adsMetricsDb.getSnapshotsByUserDateRange(userId, range.since, range.until, { platform: 'meta' }),
    adsMetricsDb.getAccountDaySnapshots(userId, range.since, range.until, { platform: 'meta' }),
  ]);
  // A truncated read is never presented as complete counts.
  if (campaignResult.truncated || accountDayResult.truncated) return null;
  const id = bareId(accountId);
  const report = buildLeadVolumeReport({
    platform: 'meta', accountId: id, windowStart: range.since, windowEnd: range.until,
    campaignRows: campaignResult.rows.filter((r) => bareId(r.accountId) === id),
    accountDayRows: accountDayResult.rows.filter((r) => bareId(r.accountId) === id),
  });
  if (!report.campaigns.length && !report.unattributedContext.length) return null;
  return { byCampaign: new Map(report.campaigns.map((c) => [String(c.campaignId), c.totalLeads])), unattributed: report.totalUnattributedLeads };
}

async function defaultUploadHtml(html: string, filename: string, userId: string): Promise<string> {
  const { uploadFileToS3 } = await import('../utils/s3Utils');
  const result = await uploadFileToS3(html, filename, userId, 'text/html');
  if (!result.success || !result.url) throw new Error(result.error || 'Failed to upload the measurement report');
  return result.url;
}
