/**
 * Continuous account-health evaluators (ENG-1266).
 *
 * Every documented churn/at-risk incident in the August 2026 audit — RankAI (broken
 * pixel, ~$5.2k spent with zero conversion signal), Haven ($6,549 spend beyond its
 * approved cap), ThinkingAI/TransAmerica (ad account silently disconnected before
 * renewal) — was caught manually, in a burst, after real damage had already happened.
 * These are pure evaluators over already-computed signals so a scheduled sweep can
 * flag the same three failure classes continuously instead of relying on the next
 * manual audit to notice.
 *
 * Deliberately pure and input-driven, not a fetcher:
 *  - Pixel health composes the same per-user counts `metaTrackingMonitor.monitorUserTracking`
 *    already computes daily (`destinationAlerts`, `destinationOk`, `blackouts`) rather than
 *    re-fetching Meta/landing-page data a second time — a second cron making the same live
 *    calls would double the tracking-monitor's external cost for the same signal.
 *  - Connectivity generalizes `renewalIntegrationHealthCron.hasHealthyAdIntegration`'s
 *    AD_PLATFORMS + isTokenNotExpired check to run for every account continuously, not only
 *    inside the pre-renewal lookahead window.
 *  - Budget variance is genuinely new: nothing in the codebase compares actual spend against
 *    a cap today. There is no stored "business-approved" budget ceiling distinct from what a
 *    campaign is configured with on the ad platform itself (Meta `spend_cap` / Google Ads
 *    campaign budget) — the same "no ground truth" gap noted on ENG-1265 for contracted price.
 *    This evaluator therefore takes the platform-configured cap as its `configuredCapCents`
 *    input; a customer-specific business-approved cap, if one is ever entered, is a drop-in
 *    replacement for that input with no change to the evaluator itself.
 *
 * Wiring this into a live sweep (feeding real `configuredCapCents`/`actualSpendCents` and
 * calling this from inside the existing `metaTrackingMonitorCron` run so pixel data is not
 * fetched twice) is left to a follow-up issue rather than bundled here — that touches an
 * already-tuned, alert-sensitive cron and deserves review on its own.
 */

export interface HealthFlag {
  flagged: boolean;
  reason?: string;
}

export interface PixelHealthInput {
  /** ENG-926 §F absence-streak count for this user (metaTrackingMonitor MonitorSummary.blackouts). */
  blackouts: number;
  /** §G destination pairs whose landing page carries no pixel this account owns. */
  destinationAlerts: number;
  /** §G destination pairs confirmed carrying a pixel this account owns. */
  destinationOk: number;
}

/**
 * Flags an account whose conversion pixel is not verifiably firing — RankAI's failure
 * mode. A destination alert (page serves no owned pixel) or an attribution blackout
 * (no conversion events at all for the blackout window) are each sufficient on their own;
 * `destinationOk` alone, with neither, is healthy.
 */
export function evaluatePixelHealth(input: PixelHealthInput): HealthFlag {
  if (input.destinationAlerts > 0) {
    return {
      flagged: true,
      reason: `${input.destinationAlerts} destination(s) carry no pixel this ad account owns`,
    };
  }
  if (input.blackouts > 0) {
    return {
      flagged: true,
      reason: `attribution blackout — no conversion events for the monitored window`,
    };
  }
  return { flagged: false };
}

export interface BudgetVarianceInput {
  /** The cap the account is configured against (platform spend_cap / campaign budget), in cents. */
  configuredCapCents: number;
  /** Actual spend measured over the same window, in cents. */
  actualSpendCents: number;
  /** Percent over the cap that counts as a flag. Defaults to DEFAULT_BUDGET_VARIANCE_THRESHOLD_PCT. */
  thresholdPct?: number;
}

/** Haven overspent by ~65% of its cap; 10% gives real headroom for platform billing lag
 *  without missing an incident of that scale. */
export const DEFAULT_BUDGET_VARIANCE_THRESHOLD_PCT = 10;

/**
 * Flags spend that has run past its configured cap by more than the threshold — Haven's
 * failure mode. An account with no cap configured cannot meaningfully overspend one, so
 * it is reported, not flagged (a missing cap is a data-completeness gap, a different
 * problem from a cap being exceeded).
 */
export function evaluateBudgetVariance(input: BudgetVarianceInput): HealthFlag {
  const thresholdPct = input.thresholdPct ?? DEFAULT_BUDGET_VARIANCE_THRESHOLD_PCT;
  if (input.configuredCapCents <= 0) {
    return { flagged: false, reason: 'no cap configured for this account' };
  }
  const overagePct = ((input.actualSpendCents - input.configuredCapCents) / input.configuredCapCents) * 100;
  if (overagePct > thresholdPct) {
    return {
      flagged: true,
      reason: `spend is ${overagePct.toFixed(1)}% over its configured cap (threshold ${thresholdPct}%)`,
    };
  }
  return { flagged: false };
}

/** Mirrors renewalIntegrationHealthCron's AD_PLATFORMS — the platforms that count as a
 *  customer's primary paid-media integration. */
export const AD_HEALTH_PLATFORMS: ReadonlySet<string> = new Set(['meta', 'google_ads', 'linkedin_ads']);

export interface ConnectivityAccountInput {
  platform: string;
  config?: { token_expires_at?: number } | null;
}

/**
 * Flags an account with no currently-connected, unexpired ad-platform integration —
 * ThinkingAI (never connected) and TransAmerica's (silently expired) failure modes.
 * Generalizes `renewalIntegrationHealthCron.hasHealthyAdIntegration` to run for every
 * account on every sweep rather than only inside the pre-renewal lookahead window.
 */
export function evaluateAdConnectivity(accounts: ConnectivityAccountInput[]): HealthFlag {
  const adAccounts = accounts.filter((acc) => acc && AD_HEALTH_PLATFORMS.has(acc.platform));
  if (adAccounts.length === 0) {
    return { flagged: true, reason: 'no ad-platform account connected' };
  }
  const now = Date.now();
  const hasValid = adAccounts.some(
    (acc) => acc.config && typeof acc.config.token_expires_at === 'number' && acc.config.token_expires_at > now,
  );
  if (!hasValid) {
    return { flagged: true, reason: 'every connected ad-platform account has an expired or invalid token' };
  }
  return { flagged: false };
}

export type AccountHealthCheck = 'pixel' | 'budget' | 'connectivity';

export interface AccountHealthResult {
  userId: string;
  flagged: boolean;
  flags: Array<{ check: AccountHealthCheck; reason?: string }>;
}

export interface AccountHealthInput {
  userId: string;
  pixel: PixelHealthInput;
  budget: BudgetVarianceInput;
  connectedAccounts: ConnectivityAccountInput[];
}

/**
 * Composes the three checks for one account. An account is flagged overall if any
 * individual check flags; `flags` names exactly which ones, so a multi-cause incident
 * (e.g. disconnected AND overspent) is visible as more than one entry, not collapsed
 * into a single undifferentiated alert.
 */
export function evaluateAccountHealth(input: AccountHealthInput): AccountHealthResult {
  const flags: Array<{ check: AccountHealthCheck; reason?: string }> = [];

  const pixel = evaluatePixelHealth(input.pixel);
  if (pixel.flagged) flags.push({ check: 'pixel', reason: pixel.reason });

  const budget = evaluateBudgetVariance(input.budget);
  if (budget.flagged) flags.push({ check: 'budget', reason: budget.reason });

  const connectivity = evaluateAdConnectivity(input.connectedAccounts);
  if (connectivity.flagged) flags.push({ check: 'connectivity', reason: connectivity.reason });

  return { userId: input.userId, flagged: flags.length > 0, flags };
}
