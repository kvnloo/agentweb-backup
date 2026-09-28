/**
 * Creative rubric score vs settled Meta ad performance (ENG-2141, ENG-2128 T9).
 *
 * For every generated creative that lineage linked to at least one Meta ad, reads its rubric-judge
 * score (AW-HumanEvalQueue.creativeRubric, ENG-2140) and its ads' daily rows (AW-AdsMetricsSnapshots
 * rowType=ad), keeps settled rows only, and prints Spearman's ρ with n and a 95% bootstrap CI for
 * score vs CTR, CVR and hook rate, and score vs CPA and CRM CPL (per currency).
 *
 * Read-only: it scans the lineage table and reads the other two by key, and writes nothing,
 * anywhere. Output carries ids and numbers only, never prompts, images or customer names.
 *
 * Usage (default AWS profile; NODE_ENV=development reads the Dev- tables):
 *   CREATIVE_LINEAGE_TABLE=AW-Creatives npx ts-node --transpile-only \
 *     src/scripts/creativePerformanceCorrelation.ts [--table AW-Creatives] \
 *     [--min-impressions 1000] [--min-conversions 1] [--min-clicks 100] [--per-creative] [--json]
 */

import AWS from 'aws-sdk';
import { ADS_METRICS_TABLE, buildAdEntityKey, type AdsMetricsAdRow } from '../services/adsMetricsDb';
import { CREATIVE_LINEAGE_TABLE_ENV, type MetaAdLink, type MetaAdLinkEnd } from '../services/creativeLineage';
import {
  creativePerformanceReport,
  readRubricScore,
  type CreativeObservation,
  type CreativePerformanceReport,
  type MetricCorrelation,
} from '../loops/eval/creativePerformance';

type DocItem = Record<string, unknown>;

// Named here rather than imported: humanEvalService pulls in Slack clients a read-only script
// has no use for. Same NODE_ENV prefix rule as HUMAN_EVAL_QUEUE_TABLE there.
const HUMAN_EVAL_QUEUE_TABLE = `${process.env.NODE_ENV === 'development' ? 'Dev-' : ''}AW-HumanEvalQueue`;

interface ReadPage {
  Items?: DocItem[];
  LastEvaluatedKey?: DocItem;
}

/** Scan, query and get, and nothing else: the loader cannot write. */
export interface ReadOnlyReader {
  scan(request: AWS.DynamoDB.DocumentClient.ScanInput): Promise<ReadPage>;
  query(request: AWS.DynamoDB.DocumentClient.QueryInput): Promise<ReadPage>;
  get(request: AWS.DynamoDB.DocumentClient.GetItemInput): Promise<{ Item?: DocItem }>;
}

export interface CorrelationTables {
  lineage: string;
  humanEval: string;
  adsMetrics: string;
}

export interface LoadResult {
  observations: CreativeObservation[];
  /** Ad series that hit a read cap; a creative with one is left out rather than under-counted. */
  truncatedAds: number;
}

const MAX_AD_PAGES = 20;

async function readAll(
  fetchPage: (start: DocItem | undefined) => Promise<ReadPage>,
  maxPages = Infinity,
): Promise<{ items: DocItem[]; truncated: boolean }> {
  const items: DocItem[] = [];
  let start: DocItem | undefined;
  let pages = 0;
  do {
    const page = await fetchPage(start);
    items.push(...(page.Items ?? []));
    start = page.LastEvaluatedKey;
    pages++;
  } while (start && pages < maxPages);
  return { items, truncated: Boolean(start) };
}

const adKey = (accountId: string, adId: string): string => `${accountId}#${adId}`;

function linksOf(creative: DocItem): MetaAdLink[] {
  return Array.isArray(creative.metaAdLinks) ? (creative.metaAdLinks as MetaAdLink[]) : [];
}

/**
 * Every moment each ad's creative changed, across ALL scanned creatives: each link start and each
 * recorded end. One ad can carry several creatives over its life (swaps), so a link's window must
 * stop at the next change or the later creative's days are credited to the earlier one too.
 */
export function adChangeTimes(creatives: ReadonlyArray<DocItem>): Map<string, string[]> {
  const times = new Map<string, string[]>();
  const add = (key: string, at: string) => {
    const list = times.get(key) ?? [];
    list.push(at);
    times.set(key, list);
  };
  for (const creative of creatives) {
    for (const link of linksOf(creative)) add(adKey(link.accountId, link.adId), link.linkedAt);
    const ends = Array.isArray(creative.metaAdLinkEnds) ? (creative.metaAdLinkEnds as MetaAdLinkEnd[]) : [];
    for (const end of ends) add(adKey(end.accountId, end.adId), end.endedAt);
  }
  for (const list of times.values()) list.sort();
  return times;
}

/** Exclusive end date for a link: the date of the ad's first change after it, or undefined. */
export function linkUntil(link: MetaAdLink, changes: Map<string, string[]>): string | undefined {
  const next = changes.get(adKey(link.accountId, link.adId))?.find((at) => at > link.linkedAt);
  return next ? next.slice(0, 10) : undefined;
}

function previousDate(date: string): string {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

export async function loadCreativeObservations(reader: ReadOnlyReader, tables: CorrelationTables): Promise<LoadResult> {
  const { items: creatives } = await readAll((start) => reader.scan({
    TableName: tables.lineage,
    FilterExpression: 'attribute_exists(metaAdLinks)',
    ProjectionExpression: 'creativeId, humanEvalCandidateId, metaAdLinks, metaAdLinkEnds',
    ...(start ? { ExclusiveStartKey: start } : {}),
  }));
  const changes = adChangeTimes(creatives);

  const observations: CreativeObservation[] = [];
  let truncatedAds = 0;
  for (const creative of creatives) {
    let rubricScore: number | null = null;
    if (typeof creative.humanEvalCandidateId === 'string') {
      const { Item } = await reader.get({
        TableName: tables.humanEval,
        Key: { candidateId: creative.humanEvalCandidateId },
        ProjectionExpression: 'creativeRubric',
      });
      rubricScore = readRubricScore(Item?.creativeRubric);
    }

    const ads: CreativeObservation['ads'] = [];
    let truncated = false;
    for (const link of linksOf(creative)) {
      const since = String(link.linkedAt ?? '').slice(0, 10);
      const until = linkUntil(link, changes);
      const last = until ? previousDate(until) : undefined;
      const window = { adId: link.adId, via: link.via, linkedAt: link.linkedAt, ...(until ? { until } : {}) };
      if (last !== undefined && last < since) {
        ads.push({ ...window, rows: [] });
        continue;
      }
      const entityKey = buildAdEntityKey('meta', link.accountId, link.adId);
      const { items, truncated: cut } = await readAll((start) => reader.query({
        TableName: tables.adsMetrics,
        KeyConditionExpression: last ? 'entityKey = :entityKey AND #date BETWEEN :since AND :last' : 'entityKey = :entityKey AND #date >= :since',
        ExpressionAttributeNames: { '#date': 'date' },
        ExpressionAttributeValues: { ':entityKey': entityKey, ':since': since, ...(last ? { ':last': last } : {}) },
        ...(start ? { ExclusiveStartKey: start } : {}),
      }), MAX_AD_PAGES);
      if (cut) truncated = true;
      ads.push({ ...window, rows: items as unknown as AdsMetricsAdRow[] });
    }
    if (truncated) {
      truncatedAds++;
      continue;
    }
    observations.push({ creativeId: String(creative.creativeId), rubricScore, ads });
  }
  return { observations, truncatedAds };
}

interface CliOptions {
  table?: string;
  minImpressions: number;
  minConversions: number;
  minClicks: number;
  perCreative: boolean;
  json: boolean;
}

export function parseArgs(argv: readonly string[]): CliOptions {
  const value = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    if (i === -1) return undefined;
    const operand = argv[i + 1];
    if (operand === undefined || operand.startsWith('--')) throw new Error(`${flag} needs a value`);
    return operand;
  };
  const count = (flag: string, fallback: number): number => {
    const raw = value(flag);
    if (raw === undefined) return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0) throw new Error(`${flag} must be a non-negative integer`);
    return n;
  };
  return {
    table: value('--table'),
    minImpressions: count('--min-impressions', 1000),
    minConversions: count('--min-conversions', 1),
    minClicks: count('--min-clicks', 100),
    perCreative: argv.includes('--per-creative'),
    json: argv.includes('--json'),
  };
}

function formatCorrelation(label: string, c: MetricCorrelation): string {
  if (!c.result) return `${label}: n=${c.n} (need at least 3; not computed)`;
  const { rho, ci, undefinedResamples } = c.result;
  const rhoText = rho === null ? 'undefined (a constant variable)' : rho.toFixed(3);
  const ciText = ci ? `[${ci.low.toFixed(3)}, ${ci.high.toFixed(3)}]` : 'n/a';
  return `${label}: rho=${rhoText}  n=${c.n}  95% CI ${ciText}` + (undefinedResamples ? `  (${undefinedResamples} degenerate resamples dropped)` : '');
}

export function formatReport(report: CreativePerformanceReport, truncatedAds: number, opts: CliOptions): string[] {
  const lines = [
    `Creatives with a linked Meta ad: ${report.creativesConsidered + truncatedAds}` +
      (truncatedAds ? ` (${truncatedAds} left out: an ad series hit the read cap)` : ''),
    `Excluded: no rubric score ${report.excluded.noRubricScore}, no settled rows ${report.excluded.noSettledRows}, ` +
      `< ${opts.minImpressions} impressions (CTR) ${report.excluded.belowMinImpressions}, ` +
      `< ${opts.minConversions} leads (CPA) ${report.excluded.noConversions}, mixed currency (CPA) ${report.excluded.mixedCurrency}, ` +
      `< ${opts.minClicks} clicks (CVR) ${report.excluded.belowMinClicks}, no 3-second plays (hook rate) ${report.excluded.noVideoPlays}, ` +
      `< ${opts.minConversions} CRM leads (CPL) ${report.excluded.noCrmLeads}, mixed currency (CPL) ${report.excluded.crmMixedCurrency}`,
    `Unsettled ad-day rows excluded (inside Meta's 28-day revision window): ${report.unsettledRowsExcluded}`,
    formatCorrelation('Rubric score vs CTR', report.ctr),
    formatCorrelation('Rubric score vs CVR', report.cvr),
    formatCorrelation('Rubric score vs hook rate', report.hookRate),
  ];
  const perCurrency = (label: string, byCurrency: Record<string, MetricCorrelation>, none: string) => {
    const currencies = Object.keys(byCurrency);
    if (currencies.length === 0) lines.push(`Rubric score vs ${label}: ${none}`);
    for (const currency of currencies) lines.push(formatCorrelation(`Rubric score vs ${label} (${currency})`, byCurrency[currency]));
  };
  perCurrency('CPA', report.cpaByCurrency, 'no creative with settled conversions');
  perCurrency('CRM CPL', report.cplByCurrency, 'no creative with settled CRM leads');
  lines.push(
    'A useful judge correlates positively with CTR, CVR and hook rate, and negatively with CPA and CPL. ' +
      'The judge is unvalidated (evalRegistry mayGate=false).'
  );
  return lines;
}

function documentReader(): ReadOnlyReader {
  const client = new AWS.DynamoDB.DocumentClient();
  return {
    scan: (request) => client.scan(request).promise(),
    query: (request) => client.query(request).promise(),
    get: (request) => client.get(request).promise(),
  };
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const lineage = opts.table ?? process.env[CREATIVE_LINEAGE_TABLE_ENV]?.trim();
  if (!lineage) throw new Error(`Set ${CREATIVE_LINEAGE_TABLE_ENV} or pass --table (the lineage table is created by OPS-3, ENG-2148)`);

  const { observations, truncatedAds } = await loadCreativeObservations(documentReader(), {
    lineage,
    humanEval: HUMAN_EVAL_QUEUE_TABLE,
    adsMetrics: ADS_METRICS_TABLE,
  });
  const report = creativePerformanceReport(observations, {
    minImpressions: opts.minImpressions,
    minConversions: opts.minConversions,
    minClicks: opts.minClicks,
  });

  if (opts.json) {
    const { aggregates, ...summary } = report;
    console.log(JSON.stringify({ ...summary, truncatedAds, ...(opts.perCreative ? { aggregates } : {}) }, null, 2));
    return;
  }
  for (const line of formatReport(report, truncatedAds, opts)) console.log(line);
  if (opts.perCreative) {
    for (const a of report.aggregates) {
      console.log(JSON.stringify({
        creativeId: a.creativeId,
        rubricScore: a.rubricScore,
        impressions: a.impressions,
        ctr: a.impressions > 0 ? a.clicks / a.impressions : null,
        cvr: a.clicks > 0 ? a.leads / a.clicks : null,
        hookRate: a.videoImpressions > 0 ? a.videoPlays3s / a.videoImpressions : null,
        cpa: a.leads > 0 && a.currency ? { value: a.spend / a.leads, currency: a.currency } : null,
        crmCpl: a.crmLeads > 0 && a.currency ? { value: a.crmJoinedSpend / a.crmLeads, currency: a.currency } : null,
        settledRows: a.settledRows,
        unsettledRows: a.unsettledRows,
      }));
    }
  }
}

if (require.main === module) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
