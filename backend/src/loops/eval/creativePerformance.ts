/**
 * Creative score vs live ad performance (ENG-2141, ENG-2128 T9).
 *
 * Pure: callers pass, per generated creative, its rubric-judge score and the daily ad rows of the
 * Meta ads it became; this returns Spearman's ρ (with n and a bootstrap CI) between the score and
 * CTR, CVR (Meta-reported leads / clicks), hook rate (3-second video plays / impressions), CPA
 * (Meta-reported leads) and CPL (CRM leads joined by utm_content, ENG-2194). The loader is
 * scripts/creativePerformanceCorrelation.ts.
 *
 * Only SETTLED rows count (isMetaRowSettled: Meta revises insights for 28 days, ENG-1550), and only
 * rows from the day the ad started carrying the creative until the day its creative next changed.
 * Everything excluded is counted, never silently dropped.
 *
 * Reading the sign: a useful judge correlates POSITIVELY with CTR, CVR and hook rate, and
 * NEGATIVELY with CPA and CPL.
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
  /** CRM leads joined to the ad (AdsMetricsAdRow.crmLeadCount); absent when the row was not joined. */
  crmLeadCount?: number;
  /** Read for `videoPlays3s` (3-second plays); absent on rows written before it was captured. */
  platformMetrics?: Record<string, number>;
}

export interface LinkedAdMetrics {
  adId: string;
  via: MetaPublishVia;
  /** ISO timestamp the ad started carrying this creative. */
  linkedAt: string;
  /**
   * Exclusive YYYY-MM-DD: the day the ad's creative changed next (another link or a recorded end),
   * shared with whatever it changed to, so left out here. Absent while the ad still carries it.
   */
  until?: string;
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
  /** Minimum settled leads for a creative's CPA (Meta-reported) or CPL (CRM) to count (default 1). */
  minConversions?: number;
  /** Minimum settled clicks for a creative's CVR to count (default 100). */
  minClicks?: number;
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
  /** 3-second video plays, and the impressions of the rows that reported them (hook rate = plays / those). */
  videoPlays3s: number;
  videoImpressions: number;
  /** CRM leads, and the spend of the rows that carried the CRM join (CPL = that spend / crmLeads). */
  crmLeads: number;
  crmJoinedSpend: number;
  /** The single currency of the settled rows, or null when they span several (or there are none). */
  currency: string | null;
  /**
   * The single currency of the settled, CRM-joined rows (the rows `crmLeads`/`crmJoinedSpend` are
   * built from), or null when those rows span several currencies (or there are none). CPL eligibility
   * must use this, not `currency`: a settled row with no CRM join contributes to `currency` but not to
   * `crmJoinedSpend`, so an older unjoined row in a different currency would otherwise make a
   * perfectly single-currency CRM pairing look mixed and drop a valid CPL point.
   */
  crmCurrency: string | null;
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
    /** CVR: fewer than minClicks settled clicks. */
    belowMinClicks: number;
    /** Hook rate: fewer than minImpressions settled impressions with 3-second plays (image ads have none). */
    noVideoPlays: number;
    /** CPL: fewer than minConversions CRM leads on joined rows. */
    noCrmLeads: number;
    /** CPL: CRM leads, but in more than one currency. */
    crmMixedCurrency: number;
  };
  ctr: MetricCorrelation;
  cvr: MetricCorrelation;
  hookRate: MetricCorrelation;
  /** CPA is only comparable within one currency, so it is reported per currency. */
  cpaByCurrency: Record<string, MetricCorrelation>;
  /** Same rule as CPA, on CRM leads. */
  cplByCurrency: Record<string, MetricCorrelation>;
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
    videoPlays3s: 0,
    videoImpressions: 0,
    crmLeads: 0,
    crmJoinedSpend: 0,
    currency: null,
    crmCurrency: null,
    settledRows: 0,
    unsettledRows: 0,
  };
  const currencies = new Set<string>();
  const crmCurrencies = new Set<string>();
  for (const ad of obs.ads) {
    const from = firstOwnDate(ad);
    for (const row of ad.rows) {
      if (row.date < from || (ad.until !== undefined && row.date >= ad.until)) continue;
      if (!isMetaRowSettled(row)) {
        agg.unsettledRows++;
        continue;
      }
      agg.settledRows++;
      agg.impressions += row.impressions;
      agg.clicks += row.clicks;
      agg.spend += row.spend;
      agg.leads += row.platformLeadCount;
      const plays = row.platformMetrics?.videoPlays3s;
      if (typeof plays === 'number') {
        agg.videoPlays3s += plays;
        agg.videoImpressions += row.impressions;
      }
      if (typeof row.crmLeadCount === 'number') {
        agg.crmLeads += row.crmLeadCount;
        agg.crmJoinedSpend += row.spend;
        crmCurrencies.add(row.currency);
      }
      currencies.add(row.currency);
    }
  }
  agg.currency = currencies.size === 1 ? [...currencies][0] : null;
  agg.crmCurrency = crmCurrencies.size === 1 ? [...crmCurrencies][0] : null;
  return agg;
}

function correlate(pairs: XYPair[], opts: CorrelationOptions): MetricCorrelation {
  if (pairs.length < MIN_CORRELATION_N) return { n: pairs.length, result: null };
  return { n: pairs.length, result: spearmanReport(pairs, { iterations: opts.iterations, seed: opts.seed }) };
}

function correlateByCurrency(pairsByCurrency: Map<string, XYPair[]>, opts: CorrelationOptions): Record<string, MetricCorrelation> {
  const out: Record<string, MetricCorrelation> = {};
  for (const [currency, pairs] of [...pairsByCurrency.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    out[currency] = correlate(pairs, opts);
  }
  return out;
}

function pushPair(map: Map<string, XYPair[]>, currency: string, pair: XYPair): void {
  const list = map.get(currency) ?? [];
  list.push(pair);
  map.set(currency, list);
}

export function creativePerformanceReport(
  observations: ReadonlyArray<CreativeObservation>,
  opts: CorrelationOptions = {},
): CreativePerformanceReport {
  const minImpressions = opts.minImpressions ?? 1000;
  const minConversions = opts.minConversions ?? 1;
  const minClicks = opts.minClicks ?? 100;
  const aggregates = observations.map(aggregateCreative);
  const excluded = {
    noRubricScore: 0, noSettledRows: 0, belowMinImpressions: 0, noConversions: 0, mixedCurrency: 0,
    belowMinClicks: 0, noVideoPlays: 0, noCrmLeads: 0, crmMixedCurrency: 0,
  };
  const ctrPairs: XYPair[] = [];
  const cvrPairs: XYPair[] = [];
  const hookPairs: XYPair[] = [];
  const cpaPairs = new Map<string, XYPair[]>();
  const cplPairs = new Map<string, XYPair[]>();

  for (const a of aggregates) {
    if (a.rubricScore === null) { excluded.noRubricScore++; continue; }
    if (a.settledRows === 0) { excluded.noSettledRows++; continue; }
    const x = a.rubricScore;
    if (a.impressions >= minImpressions && a.impressions > 0) ctrPairs.push({ x, y: a.clicks / a.impressions });
    else excluded.belowMinImpressions++;
    if (a.clicks >= minClicks && a.clicks > 0) cvrPairs.push({ x, y: a.leads / a.clicks });
    else excluded.belowMinClicks++;
    if (a.videoImpressions >= minImpressions && a.videoImpressions > 0) hookPairs.push({ x, y: a.videoPlays3s / a.videoImpressions });
    else excluded.noVideoPlays++;

    if (a.crmLeads < minConversions || a.crmLeads <= 0) excluded.noCrmLeads++;
    else if (a.crmCurrency === null) excluded.crmMixedCurrency++;
    else pushPair(cplPairs, a.crmCurrency, { x, y: a.crmJoinedSpend / a.crmLeads });

    if (a.leads < minConversions || a.leads <= 0) excluded.noConversions++;
    else if (a.currency === null) excluded.mixedCurrency++;
    else pushPair(cpaPairs, a.currency, { x, y: a.spend / a.leads });
  }

  return {
    creativesConsidered: observations.length,
    unsettledRowsExcluded: aggregates.reduce((sum, a) => sum + a.unsettledRows, 0),
    excluded,
    ctr: correlate(ctrPairs, opts),
    cvr: correlate(cvrPairs, opts),
    hookRate: correlate(hookPairs, opts),
    cpaByCurrency: correlateByCurrency(cpaPairs, opts),
    cplByCurrency: correlateByCurrency(cplPairs, opts),
    aggregates,
  };
}

/**
 * Rubric criteria passed from a stored ENG-2140 `creativeRubric`, or null unless it is an ok single-mode
 * result on the 7-criterion ad floor. Other surfaces (ENG-2192: organic images score out of 5) are not
 * comparable with it, so they are left out.
 */
export function readRubricScore(rubric: unknown): number | null {
  if (!rubric || typeof rubric !== 'object') return null;
  const r = rubric as { mode?: unknown; status?: unknown; passedCount?: unknown; surface?: unknown };
  if (r.mode !== 'single' || r.status !== 'ok') return null;
  if (r.surface !== undefined && r.surface !== 'ad_image') return null;
  return typeof r.passedCount === 'number' && Number.isFinite(r.passedCount) ? r.passedCount : null;
}
