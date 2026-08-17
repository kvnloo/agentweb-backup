/**
 * ENG-1212 — deterministic cost-runway forecast.
 *
 * One pure calculator over the existing cost ledger (`AW-UsageRecords`, keyed
 * `userId` / `date#model#feature`). It answers "will the included usage last to
 * reset, and if not, roughly when does it run out" — without a forecasting
 * framework, a new table, or any exposure of internal dollar ceilings.
 *
 * ## The formula, fixed by ENG-1210's MVP design
 *
 * Only COMPLETE cycle days feed the rate. The in-progress day is deliberately
 * excluded: it is a partial sample, and including it makes the rate swing wildly
 * in the morning and understate spend all afternoon.
 *
 *   cycleToDate  = cost over complete cycle days / number of complete days
 *   trailingSeven = cost over the last min(7, complete) days / that day count,
 *                   available only once at least 3 complete days exist
 *   forecast      = max(cycleToDate, trailingSeven ?? 0)
 *
 * The MAX is the important choice. A mean over the whole cycle hides a recent
 * acceleration — exactly the case that matters, because that is the account
 * about to hit its cap early. Taking the larger of a slow long-run rate and a
 * fast recent one fails safe toward warning the customer sooner.
 *
 *   estimatedDaysRemaining = floor(remaining allowance / forecast)
 *
 * No forecast is produced before one complete day, or when burn is effectively
 * zero — mirroring AWS Cost Explorer, which withholds a forecast rather than
 * emitting a confident-looking number from insufficient history.
 *
 * ## Two different cost inputs, on purpose
 *
 * The RATE comes from complete-day ledger rows. The POSITION (percent used,
 * remaining allowance) comes from `costUsedMicroUsd`, the authoritative
 * policy-visible counter, which includes today's partial spend and has credits
 * already applied. Rate from history, position from the live counter.
 *
 * ## Customer exposure
 *
 * Everything under `diagnostics` is internal (micro-USD amounts and raw rates)
 * and must be stripped by the API layer before it reaches a customer — ENG-1212
 * AC4 allows it only in authorized admin diagnostics. The rest of the object is
 * customer-safe: percentages, dates, day counts, and a plain confidence label.
 */

/** Bump when the formula changes so a stored forecast stays reproducible (AC6). */
export const USAGE_RUNWAY_VERSION = "runway-2026-08-v1";

/** At least this many complete days before the trailing window is meaningful. */
const MIN_DAYS_FOR_TRAILING_WINDOW = 3;
/**
 * Exported so a caller reasoning about "enough history" uses the SAME window the
 * forecast does, rather than a second 7 that can drift away from this one.
 */
export const TRAILING_WINDOW_DAYS = 7;
/**
 * Below this, daily burn is treated as zero. One micro-USD per day would
 * otherwise project a runway of centuries and render as a confident "on track".
 */
const NEGLIGIBLE_DAILY_BURN_MICRO_USD = 1_000; // $0.001/day

export interface DailyCostRow {
  /** UTC calendar day, `YYYY-MM-DD`. Several rows may share a date (model/feature). */
  date: string;
  costMicroUsd: number;
}

export interface UsageRunwayInput {
  /** Authoritative policy-visible spend this cycle, credits applied. */
  costUsedMicroUsd: number;
  /** Effective ceiling this cycle, including verified purchased credits. */
  hardThresholdMicroUsd: number;
  /** Ledger rows; rows outside the cycle are ignored rather than trusted. */
  dailyCostMicroUsd: DailyCostRow[];
  /** Inclusive first day of the cycle, `YYYY-MM-DD`. */
  cycleStartDate: string;
  /** Exclusive — the day the allowance resets, `YYYY-MM-DD`. */
  cycleResetDate: string;
  /** The in-progress (incomplete) day, `YYYY-MM-DD`. */
  today: string;
}

export type RunwayConfidence = "insufficient_data" | "low" | "normal";

export interface UsageRunway {
  version: string;
  /** 0..100, clamped — an over-spent account still reads 100, never 130. */
  percentUsed: number;
  /** null when no forecast could be made. */
  onTrack: boolean | null;
  confidence: RunwayConfidence;
  completeDaysElapsed: number;
  daysUntilReset: number;
  resetDate: string;
  estimatedDaysRemaining: number | null;
  estimatedExhaustionDate: string | null;
  /** INTERNAL — strip before returning to a customer (AC4). */
  diagnostics: {
    cycleToDateBurnMicroUsdPerDay: number | null;
    trailingSevenDayBurnMicroUsdPerDay: number | null;
    forecastBurnMicroUsdPerDay: number | null;
    remainingAllowanceMicroUsd: number;
  };
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Parse `YYYY-MM-DD` as a UTC midnight instant. Deliberately not `new Date(str)`
 * on a full timestamp: the cycle is reckoned in whole UTC calendar days, so a
 * local-timezone parse would shift day boundaries and make the forecast depend
 * on where the server happens to run.
 */
function toUtcDay(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return Date.UTC(y, (m || 1) - 1, d || 1);
}

function toIsoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function wholeDaysBetween(fromDate: string, toDate: string): number {
  return Math.round((toUtcDay(toDate) - toUtcDay(fromDate)) / MS_PER_DAY);
}

export function computeUsageRunway(input: UsageRunwayInput): UsageRunway {
  const startMs = toUtcDay(input.cycleStartDate);
  const todayMs = toUtcDay(input.today);
  const resetMs = toUtcDay(input.cycleResetDate);

  // Complete days are [cycleStart, today) — today is still accruing.
  const completeDaysElapsed = Math.max(0, Math.round((todayMs - startMs) / MS_PER_DAY));
  const daysUntilReset = Math.max(0, Math.round((resetMs - todayMs) / MS_PER_DAY));

  // Collapse the ledger to one total per day, keeping only complete cycle days.
  // Rows may arrive unordered and several may share a date (one per
  // model/feature), so sum rather than assume one row per day.
  const perDay = new Map<string, number>();
  for (const row of input.dailyCostMicroUsd) {
    const dayMs = toUtcDay(row.date);
    if (dayMs < startMs || dayMs >= todayMs) continue;
    perDay.set(row.date, (perDay.get(row.date) || 0) + Math.max(0, row.costMicroUsd || 0));
  }
  const orderedDays = [...perDay.keys()].sort();

  const completeDayTotal = orderedDays.reduce((sum, day) => sum + (perDay.get(day) || 0), 0);

  const cycleToDateBurn = completeDaysElapsed > 0 ? completeDayTotal / completeDaysElapsed : null;

  // Window over the CALENDAR tail, not the last N populated rows: a day with no
  // spend is a real zero and must dilute the average, not be skipped.
  let trailingSevenBurn: number | null = null;
  if (completeDaysElapsed >= MIN_DAYS_FOR_TRAILING_WINDOW) {
    const windowDays = Math.min(TRAILING_WINDOW_DAYS, completeDaysElapsed);
    const windowStartMs = todayMs - windowDays * MS_PER_DAY;
    let windowTotal = 0;
    for (const [day, cost] of perDay) {
      if (toUtcDay(day) >= windowStartMs) windowTotal += cost;
    }
    trailingSevenBurn = windowTotal / windowDays;
  }

  const candidateBurn = Math.max(cycleToDateBurn ?? 0, trailingSevenBurn ?? 0);
  const hasForecast = completeDaysElapsed > 0 && candidateBurn >= NEGLIGIBLE_DAILY_BURN_MICRO_USD;
  const forecastBurn = hasForecast ? candidateBurn : null;

  const remainingAllowanceMicroUsd = Math.max(
    0,
    Math.round(input.hardThresholdMicroUsd - input.costUsedMicroUsd),
  );

  const percentUsed = input.hardThresholdMicroUsd > 0
    ? Math.min(100, Math.round((input.costUsedMicroUsd / input.hardThresholdMicroUsd) * 100))
    : 100;

  let estimatedDaysRemaining: number | null = null;
  let estimatedExhaustionDate: string | null = null;
  let onTrack: boolean | null = null;

  if (forecastBurn !== null) {
    estimatedDaysRemaining = Math.floor(remainingAllowanceMicroUsd / forecastBurn);
    estimatedExhaustionDate = toIsoDay(todayMs + estimatedDaysRemaining * MS_PER_DAY);
    // On track means the allowance outlives the cycle. Exhausting exactly on the
    // reset day counts as on track: the allowance refills that morning.
    onTrack = wholeDaysBetween(input.today, estimatedExhaustionDate) >= daysUntilReset;
  }

  let confidence: RunwayConfidence;
  if (!hasForecast) confidence = "insufficient_data";
  else if (trailingSevenBurn === null) confidence = "low";
  else confidence = "normal";

  return {
    version: USAGE_RUNWAY_VERSION,
    percentUsed,
    onTrack,
    confidence,
    completeDaysElapsed,
    daysUntilReset,
    resetDate: input.cycleResetDate,
    estimatedDaysRemaining,
    estimatedExhaustionDate,
    diagnostics: {
      cycleToDateBurnMicroUsdPerDay: cycleToDateBurn,
      trailingSevenDayBurnMicroUsdPerDay: trailingSevenBurn,
      forecastBurnMicroUsdPerDay: forecastBurn,
      remainingAllowanceMicroUsd,
    },
  };
}

/**
 * Strip everything a customer must not see (AC4). The API layer returns THIS,
 * never the raw runway — no internal dollar ceilings, no raw burn rates.
 */
export function toCustomerRunway(runway: UsageRunway): Omit<UsageRunway, "diagnostics"> {
  const { diagnostics: _diagnostics, ...customerSafe } = runway;
  return customerSafe;
}
