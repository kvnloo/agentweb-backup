/** Settled campaign evidence only. No provider calls, writes, or inferred adoption. */
import { getSettlingWindowDays, hasLearningContext, type Recommendation } from './outcomeLedger';
import type { SnapshotQueryResult } from './adsMetricsDb';
export interface ExecutionReceipt {
  reference: string;
  clientUserId: string;
  platform: string;
  accountId: string;
  campaignId: string;
  recommendationId: string;
  executedAt: string;
  status: 'succeeded' | 'declined';
  adopted: boolean;
}
const DAY = 86_400_000;
/** Exclusive end of a calendar date in the provider's IANA reporting zone.
 * Search the date transition instead of assuming a 24-hour local day (DST).
 * Invalid dates/zones, including skipped calendar dates, fail closed as NaN. */
function reportingDayEnd(date: string, timezone: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) ||
    new Date(date).toISOString().slice(0, 10) !== date || /^[+-]/.test(timezone)) return NaN;
  try {
    const formatter = new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
    const localDate = (instant: number) => {
      const parts = formatter.formatToParts(instant);
      return ['year', 'month', 'day'].map(type => parts.find(p => p.type === type)!.value).join('-');
    };
    let low = Date.parse(date) - 36 * DAY / 24, high = Date.parse(date) + 60 * DAY / 24;
    while (high - low > 1) {
      const mid = Math.floor((low + high) / 2);
      if (localDate(mid) <= date) low = mid; else high = mid;
    }
    return localDate(high - 1) === date ? high : NaN;
  } catch { return NaN; }
}
export function evaluateSettledRecommendation(args: {
  recommendation: Recommendation; now: string; receipt: ExecutionReceipt | null;
  baseline: SnapshotQueryResult; outcome: SnapshotQueryResult;
}): Recommendation | null {
  const { recommendation: r, now, receipt, baseline, outcome } = args;
  const clock = Date.parse(now);
  if (!Number.isFinite(clock)) throw new Error('Invalid evaluator clock');
  if (r.status !== 'pending' || !hasLearningContext(r)) return null;
  if (!Number.isFinite(Date.parse(r.evaluationDate))) throw new Error('Invalid evaluation date');
  if (clock < Date.parse(r.evaluationDate) + getSettlingWindowDays(r.platform) * DAY) return null;
  // The daily 09:00 UTC snapshot producer includes today-30. Wait through
  // that final refresh opportunity (including UTC-12 reporting days), rather
  // than permanently scoring a stale snapshot on the first 15-minute tick.
  if (r.platform === 'meta' && clock < Date.parse(r.evaluationDate.slice(0, 10)) + 31 * DAY) return null;
  const finish = (verdict: Recommendation['verdict'], reason: string, adopted: boolean | null = null,
    actualMagnitudePct: number | null = null): Recommendation => ({ ...r, status: 'scored', scoredAt: now,
      verdict, verdictReason: reason, adopted, actualMagnitudePct,
      actualDirection: actualMagnitudePct === null ? null : actualMagnitudePct > 0 ? 'increase' : actualMagnitudePct < 0 ? 'decrease' : 'flat' });
  const c = r.context;
  const validReceipt = receipt && typeof receipt.reference === 'string' && receipt.reference.length > 0 &&
    receipt.clientUserId === c.clientUserId && receipt.accountId === r.accountId && receipt.platform === r.platform &&
    receipt.campaignId === c.campaignId && receipt.recommendationId === r.recommendationId &&
    Number.isFinite(Date.parse(receipt.executedAt)) && Date.parse(receipt.executedAt) >= Date.parse(r.createdAt) &&
    Date.parse(receipt.executedAt) <= clock && (receipt.adopted === false || Date.parse(receipt.executedAt) < Date.parse(r.evaluationDate)) &&
    ((receipt.status === 'succeeded' && receipt.adopted === true) || (receipt.status === 'declined' && receipt.adopted === false));
  if (!validReceipt) return finish('unscoreable', 'missing_or_mismatched_execution_receipt');
  if (!receipt!.adopted) return finish('unscoreable', 'execution_declined', false);
  if (c.metricScope !== 'campaign' || r.predictedMetric !== 'ctr') return finish('unscoreable', 'unsupported_metric_scope', true);
  if (baseline.truncated || outcome.truncated || !Array.isArray(baseline.rows) || !Array.isArray(outcome.rows)) {
    return finish('unscoreable', 'incomplete_metric_read', true);
  }
  const end = r.evaluationDate.slice(0, 10);
  const since = c.sourceWindow.since.slice(0, 10), until = c.sourceWindow.until.slice(0, 10);
  const days = (Date.parse(until) - Date.parse(since)) / DAY + 1;
  if (!Number.isInteger(days) || days < 7 || days > 28) return finish('unscoreable', 'unsupported_window', true);
  const afterStart = new Date(Date.parse(end) - (days - 1) * DAY).toISOString().slice(0, 10);
  if (Date.parse(afterStart) <= Date.parse(receipt!.executedAt) || until >= receipt!.executedAt.slice(0, 10)) {
    return finish('unscoreable', 'intervention_overlaps_measurement', true);
  }
  const all = [...baseline.rows, ...outcome.rows];
  const currency = all[0]?.currency, timezone = all[0]?.reportingTimezone;
  const valid = (rows: typeof all, start: string, stop: string) => rows.length === days && new Set(rows.map(x => x?.date)).size === days &&
    rows.every(x => x && x.userId === c.clientUserId && x.accountId === r.accountId && x.platform === r.platform &&
      x.campaignId === c.campaignId && x.entityKey === `${r.platform}#${r.accountId}#${c.campaignId}` &&
      x.rowType === 'campaign' && x.dataQuality === 'exact' && typeof x.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x.date) &&
      x.date >= start && x.date <= stop && typeof currency === 'string' && currency.length > 0 && x.currency === currency &&
      typeof timezone === 'string' && timezone.length > 0 && x.reportingTimezone === timezone &&
      ['impressions', 'clicks', 'spend'].every(k => typeof (x as any)[k] === 'number' && Number.isFinite((x as any)[k]) && (x as any)[k] >= 0) &&
      Number.isInteger(x.impressions) && Number.isInteger(x.clicks) && x.clicks <= x.impressions &&
      // Last refresh must reach the end of the provider's mutable reporting interval.
      Date.parse(x.capturedAt) >= reportingDayEnd(x.date, timezone) + getSettlingWindowDays(r.platform) * DAY && Date.parse(x.capturedAt) <= clock);
  if (!valid(baseline.rows, since, until) || !valid(outcome.rows, afterStart, end)) return finish('unscoreable', 'missing_unsettled_or_foreign_metrics', true);
  const totals = (rows: typeof all) => rows.reduce((a, x) => ({ n: a.n + x.impressions, k: a.k + x.clicks, spend: a.spend + x.spend }), { n: 0, k: 0, spend: 0 });
  const before = totals(baseline.rows), after = totals(outcome.rows);
  if (before.n < 1000 || after.n < 1000 || before.k < 30 || after.k < 30) return finish('inconclusive', 'insufficient_campaign_sample', true);
  if (before.spend <= 0 || Math.abs(after.spend / before.spend - 1) > .2) return finish('inconclusive', 'campaign_spend_confounder', true);
  const p = before.k / before.n, q = after.k / after.n;
  const variance = (rows: typeof all) => {
    const rates = rows.map(x => x.impressions ? x.clicks / x.impressions : 0);
    const mean = rates.reduce((a, b) => a + b, 0) / rates.length;
    return rates.reduce((a, b) => a + (b - mean) ** 2, 0) / (rates.length - 1) / rates.length;
  };
  // Conservative campaign-specific floor: binomial uncertainty OR observed daily variation.
  const noise = Math.max(1.96 * Math.sqrt(p * (1 - p) / before.n + q * (1 - q) / after.n),
    1.96 * Math.sqrt(variance(baseline.rows) + variance(outcome.rows)), p * .01);
  const magnitude = (q / p - 1) * 100;
  if (Math.abs(q - p) <= noise) return finish('inconclusive', 'within_campaign_noise_band', true, magnitude);
  return finish((q > p ? 'increase' : 'decrease') === r.predictedDirection ? 'correct' : 'incorrect',
    'settled_direction_comparison_not_causal_proof', true, magnitude);
}
