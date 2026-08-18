/**
 * ENG-926 §G Tier 2 — did an event that used to arrive reliably stop arriving?
 *
 * THE GAP THIS CLOSES. Tier 1 (`metaOptimisationCoverage`) only sees events somebody is
 * BIDDING on: it reads `promoted_object.custom_event_type` and asks whether that specific
 * event is arriving. An event that goes dark with nobody optimising for it is invisible to
 * it — measurement loss rather than misdirected spend, and the open worry for Every.io and
 * `hireemma.ai` after their tracking wrappers were removed.
 *
 * §G destination coverage (`metaDestinationCoverage`) is also silent here: a page can carry
 * the right pixel and still stop firing one of its events.
 *
 * ─── §39's premise was WRONG, and that is why this is buildable now ──────────────────
 *
 * §39 designed Tier 2 around `/stats` (a ~24h window) and concluded it needed daily
 * snapshots → a new table → the Harsha data-plane gate, and that the past was unrecoverable.
 * Both are false. Ad-account insights accept `time_range` with `time_increment=1` and return
 * per-day, per-family conversion counts for the whole window in ONE call. Verified
 * 2026-08-18: 29 daily rows per account, 25-30 distinct action types each.
 *
 * So: no stored history, no schema change, no gate — the same escape Tier 1 found.
 *
 * ─── Calibrated against a REAL outage, not invented ──────────────────────────────────
 *
 * A managed client's `complete_registration` went dark for 8+ days in August 2026 while
 * `lead` kept flowing and ~$220/day kept spending. Replayed against that account's real
 * daily rows, the thresholds below fire on the THIRD consecutive absent spending day — a
 * human found it on day 8.
 *
 * The same history contains two ISOLATED absent days on an otherwise healthy stretch. A
 * one-day threshold would have fired falsely twice in three weeks, which is precisely how
 * §F's channel would stop being read. That is what `EVENT_MIX_ABSENCE_DAYS` is protecting.
 */

import { ATTRIBUTION_SETTLE_DAYS } from './metaOptimisationCoverage';

/**
 * How much history to judge against. Long enough that a twice-weekly conversion still reads
 * as "reliably present", short enough to stay one Graph call.
 *
 * THIRTY, not 28, because `dayWindowToPreset` snaps any request to Meta's preset ladder
 * (`last_7d` / `last_14d` / `last_30d` / `last_90d`). Asking for 28 returns 30 rows, so the
 * constant is written as the window actually obtained rather than the one requested — a name
 * that quietly disagrees with the data is how a threshold gets reasoned about wrongly later.
 *
 * Nothing here depends on the exact count: the presence test is a RATIO of spending days
 * plus an absolute floor, so a longer window only strengthens the baseline.
 */
export const EVENT_MIX_WINDOW_DAYS = 30;

/**
 * Consecutive SPENDING days a family must be absent before it is a finding.
 *
 * Same number and same reasoning as Tier 1's `OPTIMISATION_ABSENCE_DAYS`, and it is not
 * arbitrary: the real outage produced runs of five and three, while the healthy stretch
 * around it contained isolated single absent days. Two would have fired on the healthy data.
 */
export const EVENT_MIX_ABSENCE_DAYS = 3;

/**
 * What "reliably present" means, as a FRACTION of spending days in the window.
 *
 * A family that only ever appears occasionally has no baseline to regress from, and alerting
 * on its absence would be alerting on normal. The real outage's family sat at 19 of 29 days
 * (0.66) BEFORE the outage began, comfortably clear of this.
 */
export const EVENT_MIX_PRESENCE_RATIO = 0.5;

/**
 * ...and an ABSOLUTE floor, because a ratio alone is not enough.
 *
 * On an account with three spending days, a family present twice satisfies any ratio while
 * proving nothing. Both conditions must hold, so a young or low-volume account is silent
 * rather than noisy — the direction §F learned to fail in.
 */
export const EVENT_MIX_MIN_PRESENT_DAYS = 5;

/** One day of account activity, exactly as `fetchDailyAdAccountActivity` already returns it. */
export interface EventMixDay {
  date: string;
  spend: number;
  /** Conversion families that arrived that day. Built by `countAttributedConversions`, which
   *  already excludes families reported with a count of zero — Meta emits those when a
   *  conversion is merely CONFIGURED, and counting them would make this permanently green. */
  families: string[];
}

export interface EventMixFinding {
  family: string;
  /** Spending days the family arrived on, before the absence began. */
  presentDays: number;
  spendingDays: number;
  consecutiveAbsentSpendingDays: number;
  /** Last date it was seen at all — the first thing a human needs. */
  lastSeen: string;
  /** Money spent across the absent days. The reason this is worth an alert. */
  spendDuringAbsence: number;
}

export type EventMixVerdict = {
  /** Reliably-present families that have now been absent long enough to mean something. */
  alerting: EventMixFinding[];
  /** Families reliably present AND still arriving — reported so a silent check is
   *  distinguishable from a check with nothing to watch. */
  healthy: string[];
  /** Seen, but too rarely to have a baseline. Never alerted on: absence is normal for them. */
  tooSparse: string[];
  /** Not enough spending days in the window to judge anything at all. */
  insufficientHistory: boolean;
  spendingDaysConsidered: number;
};

/**
 * Judge one account's event mix.
 *
 * @param days   per-day rows, any order; only SPENDING days are considered
 * @param asOf   ISO date the sweep is running for. Defaults to the newest row, but pass the
 *               sweep's own date so "has it stopped" is judged against today rather than
 *               against whatever Meta last returned.
 */
export function evaluateEventMix(days: EventMixDay[], asOf?: string): EventMixVerdict {
  const verdict: EventMixVerdict = {
    alerting: [], healthy: [], tooSparse: [], insufficientHistory: false, spendingDaysConsidered: 0,
  };

  const rows = (Array.isArray(days) ? days : [])
    .filter((d) => d && typeof d.date === 'string')
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date));

  // The newest days are still being attributed, so an absence there is not yet evidence of
  // anything. Counting them inflates every streak by one and reaches the threshold a day
  // early — the exact false-alert CodeRabbit caught on Tier 1.
  const cutoff = asOf ?? (rows.length ? rows[rows.length - 1].date : undefined);
  const settled = cutoff
    ? rows.filter((d) => daysBetween(d.date, cutoff) >= ATTRIBUTION_SETTLE_DAYS)
    : rows;

  // No spend, no expectation. A dormant account is not a broken one.
  const spendingDays = settled.filter((d) => Number(d.spend) > 0);
  verdict.spendingDaysConsidered = spendingDays.length;

  if (spendingDays.length < EVENT_MIX_MIN_PRESENT_DAYS + EVENT_MIX_ABSENCE_DAYS) {
    verdict.insufficientHistory = true;
    return verdict;
  }

  const allFamilies = new Set<string>();
  for (const d of spendingDays) for (const f of familiesOf(d)) allFamilies.add(f);

  for (const family of [...allFamilies].sort()) {
    const presentOn = spendingDays.map((d) => familiesOf(d).includes(family));
    const presentDays = presentOn.filter(Boolean).length;
    // Captured from the same scan rather than re-searched. A family only reaches this loop
    // by appearing on some spending day, so an index always exists — re-finding it would add
    // a "never seen" branch that cannot be taken.
    const lastSeenIndex = presentOn.lastIndexOf(true);

    // Trailing absence: consecutive most-recent SPENDING days with no arrival.
    let trailing = 0;
    for (let i = presentOn.length - 1; i >= 0 && !presentOn[i]; i--) trailing++;

    // The baseline is measured BEFORE the absence began. Including the absent tail would
    // drag a healthy family below the threshold precisely when it breaks — the check would
    // grow quieter the worse the outage got.
    const baselineDays = spendingDays.length - trailing;
    const reliablyPresent =
      presentDays >= EVENT_MIX_MIN_PRESENT_DAYS &&
      baselineDays > 0 &&
      presentDays / baselineDays >= EVENT_MIX_PRESENCE_RATIO;

    if (!reliablyPresent) {
      verdict.tooSparse.push(family);
      continue;
    }
    if (trailing < EVENT_MIX_ABSENCE_DAYS) {
      verdict.healthy.push(family);
      continue;
    }

    const absent = spendingDays.slice(spendingDays.length - trailing);

    verdict.alerting.push({
      family,
      presentDays,
      spendingDays: spendingDays.length,
      consecutiveAbsentSpendingDays: trailing,
      lastSeen: spendingDays[lastSeenIndex].date,
      // Every row here came from the spend > 0 filter, so no zero-fallback is reachable.
      spendDuringAbsence: Math.round(absent.reduce((sum, d) => sum + Number(d.spend), 0) * 100) / 100,
    });
  }

  return verdict;
}

/** A row's families, normalised once. Meta omits the field entirely on a day with no
 *  attributed conversions, and three separate call sites re-checking that is three chances
 *  for one of them to drift. */
function familiesOf(day: EventMixDay): string[] {
  return Array.isArray(day.families) ? day.families : [];
}

/** Whole days between two ISO dates. Date-only arithmetic: these are Meta's day buckets, not
 *  instants, and treating them as timestamps introduces a timezone bug that only shows up
 *  near midnight. */
function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / 86400000);
}
