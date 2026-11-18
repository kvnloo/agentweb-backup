/**
 * ENG-3156 — zoma_industry_benchmark: how the user's cost per acquisition compares with a published
 * industry benchmark. Read-only: one Graph insights read (through runZomaAdsReport), plus one ad
 * creatives read and one small LLM call only when the caller does not name the industry.
 *
 *   KPI           purchase → lead → registration (zomaAdsReport's CONVERSION_PRIORITY), or the caller's kpi
 *   Customer CPA  spend / conversions of that KPI over the date range (zoma_ads_report's numbers)
 *   Benchmark     getIndustryBenchmark(industry, platform, kpi) from the static, sourced table
 *
 * No benchmark row for the (industry, platform, kpi) means "Industry benchmark: N/A": no estimate,
 * no interpolation, no nearest-category substitute.
 */
import type { ConnectedAccount } from '../services/connectedAccountsDb';
import { MetaToolkitRefusal } from './metaToolkitErrors';
import {
  CONVERSION_KPIS,
  type ConversionKpi,
  kpiOfConversionEvent,
  parseZomaAdsReportArgs,
  runZomaAdsReport,
  ZOMA_REPORT_DATE_PRESETS,
  type ZomaAdsReport,
} from './zomaAdsReport';
import {
  BENCHMARK_INDUSTRIES,
  type BenchmarkIndustry,
  type BenchmarkPlatform,
  getIndustryBenchmark,
  INDUSTRY_BENCHMARK_TABLE_VERSION,
  isBenchmarkIndustry,
} from './zomaIndustryBenchmarks';

export const ZOMA_INDUSTRY_BENCHMARK_TOOL = 'zoma_industry_benchmark';
export const isZomaIndustryBenchmarkTool = (name: string) => name === ZOMA_INDUSTRY_BENCHMARK_TOOL;

export const BENCHMARK_NA = 'N/A' as const;

export const ZOMA_INDUSTRY_BENCHMARK_DEFINITION = {
  name: ZOMA_INDUSTRY_BENCHMARK_TOOL,
  description:
    "Compares the connected Meta ad account's cost per acquisition (CPA) with a published industry benchmark. Read-only. " +
    'Use for "is my CPA good?", "how do my ads compare with my industry?". ' +
    'The KPI is purchases, else leads, else registrations (or kpi). Customer CPA = spend / conversions for the date range (same numbers as zoma_ads_report). ' +
    'Pass industry when the user names it; otherwise the industry is classified from the ads\' destination website and returned so the user can correct it (call again with industry). ' +
    'Every benchmark figure carries its source, year and URL. When no published figure exists for the industry and KPI the result is exactly "Industry benchmark: N/A"; never estimate one.',
  inputSchema: {
    type: 'object',
    properties: {
      industry: { type: 'string', enum: [...BENCHMARK_INDUSTRIES], description: "The user's industry. Omit to classify it from the ads' destination website." },
      kpi: { type: 'string', enum: [...CONVERSION_KPIS], description: 'The KPI to compare. Default: purchase, else lead, else registration, whichever the account records.' },
      date_preset: { type: 'string', enum: [...ZOMA_REPORT_DATE_PRESETS], description: 'Relative range in the ad account time zone. Default last_30d. Ignored when since/until are set.' },
      since: { type: 'string', description: 'Start date YYYY-MM-DD (inclusive). Needs until.' },
      until: { type: 'string', description: 'End date YYYY-MM-DD (inclusive). Needs since.' },
      account_id: { type: 'string', description: 'Meta ad account id; needed only when more than one is connected.' },
    },
    additionalProperties: false,
  },
};

export interface IndustryClassification {
  industry: BenchmarkIndustry | null;
  /** The destination host (or URL) the classification was based on, when one was found. */
  basis: string | null;
}

export interface ZomaIndustryBenchmarkDeps {
  runReport: (account: ConnectedAccount, accountId: string, args: unknown, kpi?: ConversionKpi) => Promise<ZomaAdsReport>;
  classifyIndustry: (account: ConnectedAccount, accountId: string, userId: string) => Promise<IndustryClassification>;
}

export interface BenchmarkFigure {
  cpa: number;
  currency: 'USD';
  metric: string;
  source_name: string;
  year: number;
  url: string;
  table_version: string;
}

export interface ZomaIndustryBenchmarkResult {
  account_id: string;
  platform: BenchmarkPlatform;
  date_range: ZomaAdsReport['date_range'];
  kpi: ConversionKpi | null;
  kpi_source: 'caller' | 'auto';
  conversion_event: string | null;
  industry: BenchmarkIndustry | null;
  industry_source: 'caller' | 'classified';
  industry_note: string | null;
  customer: {
    spend: number;
    conversions: number;
    cpa: number | null;
    currency: string | null;
    source: string;
  };
  industry_benchmark: BenchmarkFigure | typeof BENCHMARK_NA;
  comparison: {
    difference_percent: number;
    verdict: 'better' | 'worse' | 'same';
    source: string;
  } | null;
  comparison_note: string | null;
  summary: string;
}

interface ParsedBenchmarkArgs {
  industry: BenchmarkIndustry | null;
  kpi: ConversionKpi | null;
  reportArgs: Record<string, unknown>;
}

export function parseZomaIndustryBenchmarkArgs(args: any): ParsedBenchmarkArgs {
  const a = args && typeof args === 'object' ? args : {};
  let industry: BenchmarkIndustry | null = null;
  if (a.industry !== undefined) {
    if (!isBenchmarkIndustry(a.industry)) throw new MetaToolkitRefusal(`industry must be one of: ${BENCHMARK_INDUSTRIES.join(', ')}.`);
    industry = a.industry;
  }
  let kpi: ConversionKpi | null = null;
  if (a.kpi !== undefined) {
    if (!(CONVERSION_KPIS as readonly string[]).includes(a.kpi)) throw new MetaToolkitRefusal(`kpi must be one of: ${CONVERSION_KPIS.join(', ')}.`);
    kpi = a.kpi;
  }
  const reportArgs: Record<string, unknown> = { level: 'account' };
  for (const k of ['date_preset', 'since', 'until'] as const) if (a[k] !== undefined) reportArgs[k] = a[k];
  if (reportArgs.date_preset === undefined && reportArgs.since === undefined && reportArgs.until === undefined) reportArgs.date_preset = 'last_30d';
  // Validate the range up front so a bad date is refused before any Graph read.
  parseZomaAdsReportArgs(reportArgs);
  return { industry, kpi, reportArgs };
}

const round = (v: number, places = 2) => Math.round(v * 10 ** places) / 10 ** places;
const rangeLabel = (r: ZomaAdsReport['date_range']) => ('preset' in r ? r.preset : `${r.since} to ${r.until}`);

/** Percent difference of the customer's CPA from the benchmark. For CPA, lower is better. */
export function compareCpa(customerCpa: number, benchmarkCpa: number): { difference_percent: number; verdict: 'better' | 'worse' | 'same' } {
  const difference_percent = round(((customerCpa - benchmarkCpa) / benchmarkCpa) * 100, 1);
  return { difference_percent, verdict: difference_percent < 0 ? 'better' : difference_percent > 0 ? 'worse' : 'same' };
}

export async function runZomaIndustryBenchmark(
  account: ConnectedAccount,
  accountId: string,
  userId: string,
  args: unknown,
  deps: ZomaIndustryBenchmarkDeps = defaultDeps(),
): Promise<ZomaIndustryBenchmarkResult> {
  const parsed = parseZomaIndustryBenchmarkArgs(args);
  const platform: BenchmarkPlatform = 'meta';
  const report = await deps.runReport(account, accountId, parsed.reportArgs, parsed.kpi ?? undefined);
  const kpi = parsed.kpi ?? kpiOfConversionEvent(report.conversion_event);

  let industry = parsed.industry;
  let industryNote: string | null = null;
  if (!industry) {
    const classified = await deps.classifyIndustry(account, accountId, userId);
    industry = classified.industry;
    industryNote = industry
      ? `Industry "${industry}" was classified from your ads' destination (${classified.basis ?? 'unknown'}). If that is wrong, tell me your industry and I will rerun the comparison.`
      : `Your industry could not be determined${classified.basis ? ` from ${classified.basis}` : ' (no ad destination website found)'}. Tell me your industry (one of: ${BENCHMARK_INDUSTRIES.join(', ')}) to compare against a benchmark.`;
  }

  const spend = report.totals.spend;
  const conversions = report.totals.conversions;
  const cpa = conversions > 0 ? round(spend / conversions) : null;
  const currency = report.currency ?? null;
  const customerSource = `Meta Ads Insights for act_${accountId}, ${rangeLabel(report.date_range)}${report.conversion_event ? `, conversions = ${report.conversion_event}` : ''} (zoma_ads_report)`;

  const row = industry && kpi ? getIndustryBenchmark(industry, platform, kpi) : null;
  const benchmark: BenchmarkFigure | typeof BENCHMARK_NA = row
    ? { cpa: row.cpa, currency: row.currency, metric: row.metric, source_name: row.sourceName, year: row.year, url: row.url, table_version: INDUSTRY_BENCHMARK_TABLE_VERSION }
    : BENCHMARK_NA;

  let comparison: ZomaIndustryBenchmarkResult['comparison'] = null;
  let comparisonNote: string | null = null;
  if (benchmark === BENCHMARK_NA) {
    comparisonNote = 'No published benchmark for this industry, platform and KPI, so there is no comparison.';
  } else if (cpa === null) {
    comparisonNote = `No ${kpi ?? 'conversion'} conversions in this range, so CPA is undefined and cannot be compared.`;
  } else if (currency && currency !== benchmark.currency) {
    comparisonNote = `The account reports in ${currency} and the benchmark is in ${benchmark.currency}; they are not compared without an exchange rate.`;
  } else {
    comparison = { ...compareCpa(cpa, benchmark.cpa), source: `Derived: customer CPA (${customerSource}) vs ${benchmark.source_name} ${benchmark.year}` };
  }

  const result: Omit<ZomaIndustryBenchmarkResult, 'summary'> = {
    account_id: accountId,
    platform,
    date_range: report.date_range,
    kpi,
    kpi_source: parsed.kpi ? 'caller' : 'auto',
    conversion_event: report.conversion_event,
    industry,
    industry_source: parsed.industry ? 'caller' : 'classified',
    industry_note: industryNote,
    customer: { spend, conversions, cpa, currency, source: customerSource },
    industry_benchmark: benchmark,
    comparison,
    comparison_note: comparisonNote,
  };
  return { ...result, summary: summarizeBenchmark(result) };
}

const money = (v: number, currency: string | null) => `${v.toFixed(2)}${currency ? ` ${currency}` : ''}`;

export function summarizeBenchmark(r: Omit<ZomaIndustryBenchmarkResult, 'summary'>): string {
  const lines = [
    `Industry benchmark for act_${r.account_id} (Meta), ${rangeLabel(r.date_range)}; KPI: ${r.kpi ?? 'none recorded'}; industry: ${r.industry ?? 'unknown'}.`,
    `Your CPA: ${r.customer.cpa === null ? `N/A (${r.customer.conversions} conversions, spend ${money(r.customer.spend, r.customer.currency)})` : money(r.customer.cpa, r.customer.currency)} — source: ${r.customer.source}.`,
    r.industry_benchmark === BENCHMARK_NA
      ? 'Industry benchmark: N/A'
      : `Industry benchmark: ${money(r.industry_benchmark.cpa, r.industry_benchmark.currency)} (${r.industry_benchmark.metric}) — source: ${r.industry_benchmark.source_name}, ${r.industry_benchmark.year}, ${r.industry_benchmark.url}.`,
  ];
  if (r.comparison) {
    const d = r.comparison.difference_percent;
    lines.push(r.comparison.verdict === 'same'
      ? 'Your CPA equals the benchmark.'
      : `Your CPA is ${Math.abs(d)}% ${d < 0 ? 'below' : 'above'} the benchmark (${r.comparison.verdict} — lower CPA is better).`);
  } else if (r.comparison_note) {
    lines.push(r.comparison_note);
  }
  if (r.industry_note) lines.push(r.industry_note);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------------------------
// Industry classification from the ads' destination (only when the caller gives no industry).
// ---------------------------------------------------------------------------------------------

const CLASSIFY_MODEL = 'gemini-3.1-flash-lite';
const CLASSIFY_TIMEOUT_MS = 10000;
const MAX_CREATIVES = 25;

/** Destination links and copy of an account's ad creatives (from a Graph adcreatives read). */
export function destinationsFromCreatives(creatives: any[]): { host: string | null; url: string | null; copy: string[] } {
  const urls: string[] = [];
  const copy: string[] = [];
  for (const c of creatives) {
    const spec = c?.object_story_spec ?? {};
    for (const u of [c?.link_url, spec?.link_data?.link, spec?.video_data?.call_to_action?.value?.link, ...(Array.isArray(c?.asset_feed_spec?.link_urls) ? c.asset_feed_spec.link_urls.map((l: any) => l?.website_url) : [])]) {
      if (typeof u === 'string' && /^https?:\/\//i.test(u)) urls.push(u);
    }
    for (const t of [c?.title, c?.body, spec?.link_data?.name, spec?.link_data?.message]) {
      if (typeof t === 'string' && t.trim()) copy.push(t.trim().slice(0, 200));
    }
  }
  const hosts = new Map<string, { n: number; url: string }>();
  for (const u of urls) {
    let host: string;
    try { host = new URL(u).hostname.replace(/^www\./, '').toLowerCase(); } catch { continue; }
    if (/(^|\.)(facebook|fb|instagram|messenger|whatsapp)\.(com|me)$/.test(host)) continue;
    const prev = hosts.get(host);
    hosts.set(host, { n: (prev?.n ?? 0) + 1, url: prev?.url ?? u });
  }
  const top = [...hosts.entries()].sort((a, b) => b[1].n - a[1].n)[0];
  return { host: top?.[0] ?? null, url: top?.[1].url ?? null, copy: [...new Set(copy)].slice(0, 5) };
}

/** One bounded LLM call: map destination + ad copy to exactly one benchmark industry, or null. */
export async function classifyIndustryWithLlm(
  input: { host: string; url: string | null; copy: string[] },
  userId: string,
  callLLM?: (model: string, messages: any[], options: any) => Promise<any>,
): Promise<BenchmarkIndustry | null> {
  const call = callLLM ?? (async (m: string, msgs: any[], o: any) => (await import('../services/agentModeService')).agentModeService.callLLM(m, msgs, o));
  const system = `You classify a business into exactly one industry from its website and ad copy.\nIndustries: ${BENCHMARK_INDUSTRIES.join(', ')}.\nReply with ONLY one industry from the list, exactly as written, or "unknown" if none fits.`;
  const user = `Website: ${input.host}${input.url ? `\nAd destination URL: ${input.url.slice(0, 300)}` : ''}${input.copy.length ? `\nAd copy:\n${input.copy.map((c) => `- ${c}`).join('\n')}` : ''}`;
  let timer: NodeJS.Timeout | undefined;
  try {
    const res = await Promise.race([
      call(CLASSIFY_MODEL, [{ role: 'system', content: system }, { role: 'user', content: user }], {
        temperature: 0,
        max_completion_tokens: 20,
        taskClass: 'nonstandard_consumer',
        usageContext: { userId, feature: 'zoma_industry_classification' },
      }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Industry classification timed out')), CLASSIFY_TIMEOUT_MS); }),
    ]);
    const raw = String(res?.choices?.[0]?.message?.content ?? '').trim().toLowerCase().replace(/^["'`]|["'`.]$/g, '');
    return isBenchmarkIndustry(raw) ? raw : null;
  } catch (error) {
    console.warn('[zoma_industry_benchmark] industry classification failed:', error instanceof Error ? error.message : String(error));
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function classifyFromAdDestinations(account: ConnectedAccount, accountId: string, userId: string): Promise<IndustryClassification> {
  const token = (account.config as any)?.access_token;
  if (typeof token !== 'string' || !token) return { industry: null, basis: null };
  const params = new URLSearchParams({
    fields: 'link_url,title,body,object_story_spec,asset_feed_spec{link_urls}',
    limit: String(MAX_CREATIVES),
    access_token: token,
  });
  const base = `https://graph.facebook.com/${process.env.META_API_VERSION || 'v25.0'}`;
  let creatives: any[] = [];
  try {
    const res = await fetch(`${base}/act_${accountId}/adcreatives?${params.toString()}`, { signal: AbortSignal.timeout(20000) });
    const body: any = await res.json();
    if (res.ok && Array.isArray(body?.data)) creatives = body.data;
  } catch {
    // A failed creatives read only means no classification; the user is asked for the industry.
  }
  const dest = destinationsFromCreatives(creatives);
  if (!dest.host) return { industry: null, basis: null };
  return { industry: await classifyIndustryWithLlm({ host: dest.host, url: dest.url, copy: dest.copy }, userId), basis: dest.host };
}

const defaultDeps = (): ZomaIndustryBenchmarkDeps => ({
  runReport: (account, accountId, args, kpi) => runZomaAdsReport(account, accountId, args, undefined, { kpi }),
  classifyIndustry: classifyFromAdDestinations,
});
