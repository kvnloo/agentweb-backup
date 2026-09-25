/**
 * Creative score vs live ad performance (ENG-2141, ENG-2128 T9).
 *
 * Pure: callers pass, per generated creative, its rubric-judge score and the daily ad rows of the
 * Meta ads it became; this returns Spearman's ρ (with n and a bootstrap CI) between the score and
 * CTR, and between the score and CPA. The loader is scripts/creativePerformanceCorrelation.ts.
 *
 * Only SETTLED rows count (isMetaRowSettled: Meta revises insights for 28 days, ENG-1550), and only
 * rows from the day the ad started carrying the creative. Everything excluded is counted, never
 * silently dropped.
 *
 * Reading the sign: a useful judge correlates POSITIVELY with CTR and NEGATIVELY with CPA.
 */

import { isMetaRowSettled } from '../../services/adsMetricsDb';
import type { MetaPublishVia } from '../../services/creativeLineage';
import { spearmanReport, type CorrelationReport, type XYPair } from './agreement';

/** The fields of an `ad` row (AdsMetricsAdRow) the correlation needs. */
export interface AdDayMetrics {
  date: string;
  capturedAt: string;
  currency: string;
  spend: number;
  impressions: number;
  clicks: number;
  platformLeadCount: number;
}

export interface LinkedAdMetrics {
  adId: string;
  via: MetaPublishVia;
  /** ISO timestamp the ad started carrying this creative. */
  linkedAt: string;
  rows: AdDayMetrics[];
}

export interface CreativeObservation {
  creativeId: string;
  /** Rubric criteria passed (0-7) from an `ok` rubric result; null when unscored. */
  rubricScore: number | null;
  ads: LinkedAdMetrics[];
}

export interface CorrelationOptions {
  /** Minimum settled impressions for a creative's CTR to count (default 1000). */
  minImpressions?: number;
  /** Minimum settled Meta-reported leads for a creative's CPA to count (default 1). */
  minConversions?: number;
  iterations?: number;
  seed?: number;
}

export const MIN_CORRELATION_N = 3;

export interface CreativeAggregate {
  creativeId: string;
  rubricScore: number | null;
  impressions: number;
  clicks: number;
  spend: number;
  leads: number;
  /** The single currency of the settled rows, or null when they span several (or there are none). */
  currency: string | null;
  settledRows: number;
  unsettledRows: number;
}

export interface MetricCorrelation {
  n: number;
  /** null when n < MIN_CORRELATION_N; otherwise the Spearman report. */
  result: CorrelationReport | null;
}

export interface CreativePerformanceReport {
  creativesConsidered: number;
  unsettledRowsExcluded: number;
  excluded: {
    noRubricScore: number;
    noSettledRows: number;
    belowMinImpressions: number;
    noConversions: number;
    mixedCurrency: number;
  };
  ctr: MetricCorrelation;
  /** CPA is only comparable within one currency, so it is reported per currency. */
  cpaByCurrency: Record<string, MetricCorrelation>;
  aggregates: CreativeAggregate[];
}

/**
 * First reporting date that is the ad's own for this creative. A new ad starts on its link day; a
 * swapped-in creative shares its link day with the previous one, so that day is left out.
 */
function firstOwnDate(ad: LinkedAdMetrics): string {
  const day = ad.linkedAt.slice(0, 10);
  if (ad.via !== 'swap_creative') return day;
  const next = new Date(`${day}T00:00:00.000Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}

export function aggregateCreative(obs: CreativeObservation): CreativeAggregate {
  const agg: CreativeAggregate = {
    creativeId: obs.creativeId,
    rubricScore: obs.rubricScore,
    impressions: 0,
    clicks: 0,
    spend: 0,
    leads: 0,
    currency: null,
    settledRows: 0,
    unsettledRows: 0,
  };
  const currencies = new Set<string>();
  for (const ad of obs.ads) {
    const from = firstOwnDate(ad);
    for (const row of ad.rows) {
      if (row.date < from) continue;
      if (!isMetaRowSettled(row)) {
        agg.unsettledRows++;
        continue;
      }
      agg.settledRows++;
      agg.impressions += row.impressions;
      agg.clicks += row.clicks;
      agg.spend += row.spend;
      agg.leads += row.platformLeadCount;
      currencies.add(row.currency);
    }
  }
  agg.currency = currencies.size === 1 ? [...currencies][0] : null;
  return agg;
}

function correlate(pairs: XYPair[], opts: CorrelationOptions): MetricCorrelation {
  if (pairs.length < MIN_CORRELATION_N) return { n: pairs.length, result: null };
  return { n: pairs.length, result: spearmanReport(pairs, { iterations: opts.iterations, seed: opts.seed }) };
}

export function creativePerformanceReport(
  observations: ReadonlyArray<CreativeObservation>,
  opts: CorrelationOptions = {},
): CreativePerformanceReport {
  const minImpressions = opts.minImpressions ?? 1000;
  const minConversions = opts.minConversions ?? 1;
  const aggregates = observations.map(aggregateCreative);
  const excluded = { noRubricScore: 0, noSettledRows: 0, belowMinImpressions: 0, noConversions: 0, mixedCurrency: 0 };
  const ctrPairs: XYPair[] = [];
  const cpaPairs = new Map<string, XYPair[]>();

  for (const a of aggregates) {
    if (a.rubricScore === null) { excluded.noRubricScore++; continue; }
    if (a.settledRows === 0) { excluded.noSettledRows++; continue; }
    if (a.impressions >= minImpressions && a.impressions > 0) {
      ctrPairs.push({ x: a.rubricScore, y: a.clicks / a.impressions });
    } else {
      excluded.belowMinImpressions++;
    }
    if (a.leads < minConversions || a.leads <= 0) { excluded.noConversions++; continue; }
    if (a.currency === null) { excluded.mixedCurrency++; continue; }
    const list = cpaPairs.get(a.currency) ?? [];
    list.push({ x: a.rubricScore, y: a.spend / a.leads });
    cpaPairs.set(a.currency, list);
  }

  const cpaByCurrency: Record<string, MetricCorrelation> = {};
  for (const [currency, pairs] of [...cpaPairs.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    cpaByCurrency[currency] = correlate(pairs, opts);
  }
  return {
    creativesConsidered: observations.length,
    unsettledRowsExcluded: aggregates.reduce((sum, a) => sum + a.unsettledRows, 0),
    excluded,
    ctr: correlate(ctrPairs, opts),
    cpaByCurrency,
    aggregates,
  };
}

/** Rubric criteria passed from a stored ENG-2140 `creativeRubric`, or null unless it is an ok single-mode result. */
export function readRubricScore(rubric: unknown): number | null {
  if (!rubric || typeof rubric !== 'object') return null;
  const r = rubric as { mode?: unknown; status?: unknown; passedCount?: unknown };
  if (r.mode !== 'single' || r.status !== 'ok') return null;
  return typeof r.passedCount === 'number' && Number.isFinite(r.passedCount) ? r.passedCount : null;
}
