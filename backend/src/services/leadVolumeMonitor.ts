/**
 * ENG-1551 — lead volume & attribution monitor: the pure half.
 *
 * Reads ENG-916's join (`AW-AdsMetricsSnapshots`) and answers, per campaign, per day: spend,
 * CRM-landed leads, and whether volume has collapsed relative to THAT campaign's own history.
 * Storage/query lives in `adsMetricsDb.ts`; kept free of the DynamoDB client for the same reason
 * `adsThresholds.ts`/`outcomeLedger.ts` are — the rule below is what's worth unit-testing
 * exhaustively, and it should not need AWS to run.
 *
 * ─── Why a distribution-aware trigger, not "N days with no leads" ─────────────────────────
 *
 * Measured against real data (ENG-1551's own card, 2026-08-31): a client running 3.4 leads/week
 * has a ZERO-lead MEDIAN day (39 of 59 days). A fixed "2 consecutive zero days" rule fires on an
 * account like that roughly every other week by chance alone — the team learns to ignore the
 * digest, and the product dies. So the trigger is the 5th percentile of that campaign's OWN
 * historical daily-lead distribution, not a global constant and not a fixed day count.
 *
 * ─── Why "unattributed" must never read as "collapsed" ────────────────────────────────────
 *
 * A nonzero `unattributedLeadCount` is normal, not a defect — only 3 of Haven's 9 active ads carry
 * `utm_campaign`, so leads from the other 6 land in the account-day sentinel row, never a campaign
 * row. A campaign whose own leads genuinely dropped and an account with routine unattributed
 * volume must never be conflated, or a healthy campaign gets flagged as failing.
 *
 * ─── Why this doesn't gate on Conversion Tracking Validator itself ────────────────────────
 *
 * CTV is a skill (LLM + tools), not code this pure function can call. This function returns the
 * deterministic signal only; the AC's "flags AND requires a CTV pass" is the calling skill's job —
 * every result here carries `requiresTrackingValidation: true` on a drought verdict so a caller
 * cannot silently skip that step.
 */

import type { AdsMetricsSnapshotRow } from './adsMetricsDb';

/** Below this many days of campaign history, a percentile is not trustworthy — matches the
 * "require N observations before a threshold moves" gate ENG-885 applies everywhere else. */
export const MIN_HISTORY_DAYS = 14;

/** Trailing days compared against the historical floor. */
export const OBSERVATION_WINDOW_DAYS = 7;

/** The percentile itself — ENG-885's own stated floor. */
const DROUGHT_PERCENTILE = 5;

export type CampaignVolumeStatus = 'insufficient_history' | 'normal' | 'drought';

export interface CampaignDayReport {
  date: string;
  spend: number;
  leads: number;
}

export interface CampaignVolumeReport {
  campaignId: string;
  campaignName: string;
  platform: string;
  accountId: string;
  historyDays: number;
  days: CampaignDayReport[];
  /** Total spend/leads across `days`. */
  totalSpend: number;
  totalLeads: number;
  costPerLead: number | null;
  /** The 5th-percentile daily-lead floor computed from the campaign's own full history, or null
   * when there isn't enough history to compute one (see `status: 'insufficient_history'`). */
  historicalP5DailyLeads: number | null;
  /** Sum of leads over the trailing `OBSERVATION_WINDOW_DAYS`, or null if fewer days exist. */
  observedWindowLeads: number | null;
  status: CampaignVolumeStatus;
  /** Set only when status === 'drought'. A caller MUST NOT treat this as a confirmed drought
   * without a Conversion Tracking Validator pass — see the module doc comment. */
  requiresTrackingValidation: boolean;
  reason: string;
}

export interface AccountAttributionContext {
  date: string;
  totalLeadCount: number;
  unattributedLeadCount: number;
}

export interface LeadVolumeReport {
  platform: string;
  accountId: string;
  windowStart: string;
  windowEnd: string;
  campaigns: CampaignVolumeReport[];
  /** Per-day unattributed context for the whole account — surfaced so a reader never mistakes
   * "leads landed but weren't attributable to any campaign" for "leads stopped happening". */
  unattributedContext: AccountAttributionContext[];
  /** Sum of `unattributedLeadCount` across `unattributedContext`. A nonzero value here is
   * EXPECTED, not a defect — see the module doc comment. Never subtract this from any campaign's
   * `totalLeads` and never treat it as evidence a campaign's volume collapsed. */
  totalUnattributedLeads: number;
}

/**
 * The percentile of a sorted numeric array using nearest-rank interpolation (the same method
 * `Array.prototype` has no built-in for, chosen over a library dependency for one function).
 * Deterministic and simple to unit-test exhaustively — precision beyond that is not needed for a
 * floor used to gate an alert, not a statistical publication.
 */
export function percentile(sortedAscending: number[], p: number): number {
  if (sortedAscending.length === 0) {
    throw new Error('leadVolumeMonitor: percentile() requires a non-empty array');
  }
  if (p < 0 || p > 100) {
    throw new Error(`leadVolumeMonitor: percentile must be within [0, 100] (got ${p})`);
  }
  if (sortedAscending.length === 1) return sortedAscending[0];

  const rank = (p / 100) * (sortedAscending.length - 1);
  const lowerIndex = Math.floor(rank);
  const upperIndex = Math.ceil(rank);
  if (lowerIndex === upperIndex) return sortedAscending[lowerIndex];

  const weight = rank - lowerIndex;
  return sortedAscending[lowerIndex] * (1 - weight) + sortedAscending[upperIndex] * weight;
}

/**
 * Builds one campaign's volume report from its own (oldest-first) snapshot rows.
 *
 * `rows` must all share the same `campaignId` — mixing campaigns here would let one campaign's
 * history compute another's percentile, silently. Not defensively checked with a throw (the
 * caller already groups by campaign before calling this), but documented as the one invariant
 * this function trusts rather than re-derives.
 */
export function buildCampaignVolumeReport(
  campaignRows: AdsMetricsSnapshotRow[],
): CampaignVolumeReport {
  if (campaignRows.length === 0) {
    throw new Error('leadVolumeMonitor: buildCampaignVolumeReport requires at least one row');
  }

  const first = campaignRows[0];
  const days: CampaignDayReport[] = campaignRows.map(r => ({
    date: r.date,
    spend: r.spend,
    leads: r.leadCount ?? 0,
  }));

  const totalSpend = days.reduce((sum, d) => sum + d.spend, 0);
  const totalLeads = days.reduce((sum, d) => sum + d.leads, 0);
  const costPerLead = totalLeads > 0 ? totalSpend / totalLeads : null;

  const base: Omit<CampaignVolumeReport, 'status' | 'requiresTrackingValidation' | 'reason' | 'historicalP5DailyLeads' | 'observedWindowLeads'> = {
    campaignId: first.campaignId ?? '',
    campaignName: first.campaignName,
    platform: first.platform,
    accountId: first.accountId,
    historyDays: days.length,
    days,
    totalSpend,
    totalLeads,
    costPerLead,
  };

  // The baseline the percentile is computed FROM must exclude the trailing observation window —
  // including it lets a genuine, ongoing collapse dilute its own floor and mask itself. Caught by
  // a red-check: a campaign steady at 5 leads/day for 23 days then truly zero for the trailing 7
  // scored 'normal', because those 7 zero days pulled the whole-history p5 down to meet them.
  const baselineDays = days.slice(0, Math.max(0, days.length - OBSERVATION_WINDOW_DAYS));

  if (baselineDays.length < MIN_HISTORY_DAYS) {
    return {
      ...base,
      historicalP5DailyLeads: null,
      observedWindowLeads: null,
      status: 'insufficient_history',
      requiresTrackingValidation: false,
      reason:
        `only ${baselineDays.length} day(s) of baseline history (excluding the trailing ` +
        `${OBSERVATION_WINDOW_DAYS}-day observation window) — need at least ${MIN_HISTORY_DAYS} ` +
        `before a percentile floor is trustworthy`,
    };
  }

  const dailyLeadsSorted = baselineDays.map(d => d.leads).sort((a, b) => a - b);
  const historicalP5DailyLeads = percentile(dailyLeadsSorted, DROUGHT_PERCENTILE);

  const windowDays = days.slice(-OBSERVATION_WINDOW_DAYS);
  const observedWindowLeads = windowDays.reduce((sum, d) => sum + d.leads, 0);
  const observedWindowAvgDailyLeads = observedWindowLeads / windowDays.length;

  if (observedWindowAvgDailyLeads < historicalP5DailyLeads) {
    return {
      ...base,
      historicalP5DailyLeads,
      observedWindowLeads,
      status: 'drought',
      requiresTrackingValidation: true,
      reason:
        `trailing ${windowDays.length}-day average (${observedWindowAvgDailyLeads.toFixed(2)} leads/day) is below ` +
        `this campaign's own ${DROUGHT_PERCENTILE}th-percentile floor (${historicalP5DailyLeads.toFixed(2)} leads/day, ` +
        `from ${baselineDays.length} days of baseline history) — verify with Conversion Tracking Validator before treating as a real drought`,
    };
  }

  return {
    ...base,
    historicalP5DailyLeads,
    observedWindowLeads,
    status: 'normal',
    requiresTrackingValidation: false,
    reason: `trailing ${windowDays.length}-day average (${observedWindowAvgDailyLeads.toFixed(2)} leads/day) is at or above the historical floor`,
  };
}

/**
 * Builds the full account report: every campaign's volume report plus the account-level
 * unattributed context, kept as a SEPARATE field rather than folded into any campaign — see the
 * module doc comment on why conflating the two produces false alarms on healthy campaigns.
 */
export function buildLeadVolumeReport(params: {
  platform: string;
  accountId: string;
  windowStart: string;
  windowEnd: string;
  /** All campaign rows for this account, any order, mixed campaigns — grouped internally. */
  campaignRows: AdsMetricsSnapshotRow[];
  /** account_day rows for this account, any order. */
  accountDayRows: AdsMetricsSnapshotRow[];
}): LeadVolumeReport {
  const { platform, accountId, windowStart, windowEnd, campaignRows, accountDayRows } = params;

  const byCampaign = new Map<string, AdsMetricsSnapshotRow[]>();
  for (const row of campaignRows) {
    const key = row.campaignId ?? '';
    if (!byCampaign.has(key)) byCampaign.set(key, []);
    byCampaign.get(key)!.push(row);
  }
  // Each group must stay oldest-first for the percentile/window logic above to mean what it says.
  for (const group of byCampaign.values()) {
    group.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  }

  const campaigns = Array.from(byCampaign.values())
    .filter(group => group.length > 0)
    .map(buildCampaignVolumeReport);

  const unattributedContext: AccountAttributionContext[] = accountDayRows
    .map(r => ({
      date: r.date,
      totalLeadCount: r.totalLeadCount ?? 0,
      unattributedLeadCount: r.unattributedLeadCount ?? 0,
    }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const totalUnattributedLeads = unattributedContext.reduce((sum, d) => sum + d.unattributedLeadCount, 0);

  return {
    platform,
    accountId,
    windowStart,
    windowEnd,
    campaigns,
    unattributedContext,
    totalUnattributedLeads,
  };
}
