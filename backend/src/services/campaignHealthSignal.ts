/**
 * Managed-campaign health signal (ENG-87).
 *
 * Flags struggling and winning managed campaigns so Matt can decide what to do (human in the
 * loop; this module never acts on a campaign). Pure: every input is passed in.
 *
 * Thresholds are deliberately REQUIRED configuration with no built-in defaults. The issue leaves
 * the exact values to Harsha/Ray ("do NOT guess + lock in"), so an unset threshold disables its
 * signal instead of applying an invented number. AC5 (tunable down) is met by raising thresholds,
 * leaving them unset, or setting `enabled: false` / `minSeverityToEmit`.
 */

export interface CampaignHealthThresholds {
  /** AC1: fire when |reported - landed| / reported exceeds this fraction (e.g. 0.3). */
  discrepancyRatio?: number;
  /** AC1: fire when spend / landed leads exceeds this amount (same currency as spend). */
  maxCostPerLead?: number;
  /** AC2: fire when bad leads / evaluated leads exceeds this fraction. */
  badLeadRate?: number;
  /** AC3: fire a win when spend / landed leads is at or below this amount. */
  winMaxCostPerLead?: number;
  /** AC3: a win also needs a bad-lead rate at or below this fraction, when set. */
  winMaxBadLeadRate?: number;
  /** Minimum reported (or landed) leads before a rate-based judgement is made. Default 1. */
  minLeadsForRate?: number;
}

export interface CampaignHealthConfig {
  enabled: boolean;
  thresholds: CampaignHealthThresholds;
}

export interface CampaignWindowStats {
  campaignId: string;
  campaignName: string;
  /** Window identifier, e.g. `2026-10-21..2026-10-27`; part of the dedupe key (AC4). */
  windowKey: string;
  /** Leads the ads manager reports for the window; undefined = not read. */
  reportedLeads?: number;
  /** Leads that actually landed in the CRM for the window; undefined = not read. */
  landedLeads?: number;
  spend?: number;
  /** Landed leads whose quality was judged, and how many of them were bad. */
  qualityEvaluatedLeads?: number;
  badLeads?: number;
}

export type CampaignHealthMetric = 'lead_discrepancy' | 'cost_per_lead' | 'bad_lead_rate';

export interface CampaignHealthReason {
  metric: CampaignHealthMetric;
  value: number;
  threshold: number;
}

export interface CampaignHealthSignal {
  kind: 'struggling' | 'win';
  campaignId: string;
  campaignName: string;
  windowKey: string;
  dedupeKey: string;
  reasons: CampaignHealthReason[];
  /** Raw values so the alert names the numbers (AC1). */
  values: Pick<CampaignWindowStats, 'reportedLeads' | 'landedLeads' | 'spend' | 'qualityEvaluatedLeads' | 'badLeads'>;
}

function isNum(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

export function campaignHealthDedupeKey(kind: CampaignHealthSignal['kind'], campaignId: string, windowKey: string): string {
  return `campaign-health:${kind}:${campaignId}:${windowKey}`;
}

/** Evaluate one campaign window. Returns null when the campaign is in range (AC4). */
export function evaluateCampaignHealth(
  stats: CampaignWindowStats,
  config: CampaignHealthConfig,
): CampaignHealthSignal | null {
  if (!config.enabled) return null;
  const t = config.thresholds;
  const minLeads = isNum(t.minLeadsForRate) && t.minLeadsForRate >= 1 ? t.minLeadsForRate : 1;
  const struggling: CampaignHealthReason[] = [];

  const { reportedLeads, landedLeads, spend, qualityEvaluatedLeads, badLeads } = stats;

  if (isNum(t.discrepancyRatio) && isNum(reportedLeads) && isNum(landedLeads) && reportedLeads >= minLeads) {
    const ratio = Math.abs(reportedLeads - landedLeads) / reportedLeads;
    if (ratio > t.discrepancyRatio) struggling.push({ metric: 'lead_discrepancy', value: ratio, threshold: t.discrepancyRatio });
  }

  const cpl = isNum(spend) && isNum(landedLeads) && landedLeads >= minLeads ? spend / landedLeads : undefined;
  if (isNum(t.maxCostPerLead) && isNum(spend)) {
    if (cpl !== undefined && cpl > t.maxCostPerLead) {
      struggling.push({ metric: 'cost_per_lead', value: cpl, threshold: t.maxCostPerLead });
    } else if (landedLeads === 0 && spend > t.maxCostPerLead) {
      // Spend with zero landed leads is an unbounded cost per lead.
      struggling.push({ metric: 'cost_per_lead', value: Number.POSITIVE_INFINITY, threshold: t.maxCostPerLead });
    }
  }

  const badRate =
    isNum(qualityEvaluatedLeads) && isNum(badLeads) && qualityEvaluatedLeads >= minLeads
      ? badLeads / qualityEvaluatedLeads
      : undefined;
  if (isNum(t.badLeadRate) && badRate !== undefined && badRate > t.badLeadRate) {
    struggling.push({ metric: 'bad_lead_rate', value: badRate, threshold: t.badLeadRate });
  }

  const values = { reportedLeads, landedLeads, spend, qualityEvaluatedLeads, badLeads };
  const base = { campaignId: stats.campaignId, campaignName: stats.campaignName, windowKey: stats.windowKey, values };

  if (struggling.length > 0) {
    return { kind: 'struggling', ...base, dedupeKey: campaignHealthDedupeKey('struggling', stats.campaignId, stats.windowKey), reasons: struggling };
  }

  if (isNum(t.winMaxCostPerLead) && cpl !== undefined && cpl <= t.winMaxCostPerLead) {
    const reasons: CampaignHealthReason[] = [{ metric: 'cost_per_lead', value: cpl, threshold: t.winMaxCostPerLead }];
    if (isNum(t.winMaxBadLeadRate)) {
      // A cheap lead that is unjudged for quality is not a proven win.
      if (badRate === undefined || badRate > t.winMaxBadLeadRate) return null;
      reasons.push({ metric: 'bad_lead_rate', value: badRate, threshold: t.winMaxBadLeadRate });
    }
    return { kind: 'win', ...base, dedupeKey: campaignHealthDedupeKey('win', stats.campaignId, stats.windowKey), reasons };
  }

  return null;
}

/**
 * Evaluate many windows, dropping any signal whose dedupe key was already emitted (AC4).
 * `alreadyEmitted` is the caller's record of prior keys; it is not mutated.
 */
export function collectCampaignHealthSignals(
  windows: CampaignWindowStats[],
  config: CampaignHealthConfig,
  alreadyEmitted: ReadonlySet<string> = new Set(),
): CampaignHealthSignal[] {
  const seen = new Set(alreadyEmitted);
  const out: CampaignHealthSignal[] = [];
  for (const w of windows) {
    const s = evaluateCampaignHealth(w, config);
    if (!s || seen.has(s.dedupeKey)) continue;
    seen.add(s.dedupeKey);
    out.push(s);
  }
  return out;
}
