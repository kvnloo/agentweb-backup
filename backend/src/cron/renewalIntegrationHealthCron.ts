/**
 * Pre-Renewal Ad-Integration Health Check (ENG-1270)
 *
 * Nothing previously checked whether a customer's primary ad integration was
 * still connected before their subscription renewed and they got charged.
 * ThinkingAI and TransAmerica were both caught manually during the August
 * 2026 audit — renewal imminent, no Meta ad account connected. Charging a
 * customer while the thing they're paying for is silently non-functional is
 * a trust break worth flagging loudly, not logging quietly.
 *
 * This scans active-subscription users whose renewal falls within the
 * lookahead window and raises a deduped oncall alert only for customers who
 * selected paid ads as a goal AND whose subscription plan actually permits
 * connecting an ad platform. A missing ad connection is not evidence that
 * ads are part of a customer's plan (for example, LinkedIn-outreach-only
 * customers, or a customer's plan that never included ad integration —
 * ENG-1541, the TFAConnect false positive: her onboarding-time "paid ads"
 * intent was stale relative to a plan that doesn't allow it), so neither
 * condition alone may create a renewal-risk alert.
 * ENG-2188: an account that never connected any ad platform is activation, not
 * renewal risk — it is never `would_flag`ged (the ENG-2143 classifier cron routes it to a
 * CS nudge). Only a connection that existed and has expired on every platform can flag.
 * Detection is intentionally cheap and synchronous (timestamp-only expiry
 * checks) — no live third-party API calls — so it can run frequently without
 * external dependency risk. The one async step is the entitlement lookup
 * (`subscriptionService.getAllowedConnectedAccounts`), which only runs for
 * users who already cleared the cheap sync checks.
 *
 * Registered in server.ts to run daily.
 */

import { userDb } from '../services/db';
import { sendAgentModeOncallAlert } from '../utils/agentModeAlerts';
import { PlatformType } from '../services/connectedAccountsDb';
import { classifyAdConnections, type AdConnectionSummary } from '../services/clientHealthService';
import { getAllowedConnectedAccounts } from '../services/subscriptionService';
import { isEvaluationUser } from '../services/evaluationPolicy';
import {
  getAccountCapabilityRequirement,
  upsertAccountCapabilityStatus,
  isSuppressed,
  type AccountCapabilityStatus,
  type AccountCapabilitySourceDetail,
  type AccountCapabilityRequirement,
} from '../services/accountCapabilityRequirementsDb';

const TAG = '[renewalIntegrationHealthCron]';

/** Renewal is "imminent" when it falls within this many days from now. */
export const RENEWAL_LOOKAHEAD_DAYS = 14;

/** Platforms that count as a customer's primary paid-media ad integration. */
const AD_PLATFORMS: ReadonlySet<PlatformType> = new Set(['meta', 'google_ads', 'linkedin_ads']);

/** Re-alert on the same account at most once per day. */
const DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface RenewalIntegrationHealthSummary {
  scannedUsers: number;
  /** Decided `would_flag` this run — NOT the same as "an alert fired" once suppression exists
   *  (ENG-1541). Kept meaning what it always has (backward compatible with existing dashboards);
   *  see `suppressedByCorrection` for the count of `would_flag` decisions an active correction
   *  suppressed before ever reaching the alert-send step. */
  flagged: number;
  /** `would_flag` decisions suppressed by an active, unexpired correction (ENG-1541 item 2) —
   *  the gap between `flagged` and an alert actually being sent. */
  suppressedByCorrection: number;
  alertFailed: number;
  evaluationFailed: number;
  /** Failures reading/writing `AW-AccountCapabilityRequirements`, isolated the same way
   *  evaluation and alert-send failures already are (ENG-1541 item 1) — one user's tracking
   *  failure must never abort the rest of the scan. */
  trackingFailed: number;
}

/**
 * Every branch `runRenewalIntegrationHealthCheck`'s per-user decision can take.
 * `would_flag` is the only branch that leads to an alert in a real run —
 * everything else is a reasoned skip.
 */
export type RenewalIntegrationHealthDecision =
  | 'skipped_no_paid_ads_intent'
  | 'skipped_healthy_integration'
  | 'skipped_activation_incomplete'
  | 'skipped_no_ad_entitlement'
  | 'would_flag';

export interface RenewalIntegrationHealthEvaluation {
  decision: RenewalIntegrationHealthDecision;
  hasPaidAdsIntent: boolean;
  hasHealthyAdIntegration: boolean;
  /** Ad connection across Meta, Google Ads and LinkedIn Ads (ENG-2188). */
  adConnection: AdConnectionSummary['state'];
  /** null when the entitlement check was short-circuited by an earlier skip. */
  hasAdIntegrationEntitlement: boolean | null;
}

function isAdAccount(account: any): boolean {
  return !!account && AD_PLATFORMS.has(account.platform);
}

/**
 * The user's ad connection across every ad platform, by the same timestamp-only rule the Client
 * Health page and the ENG-2143 classifier use (an expired token that can refresh still counts as
 * connected), so this check never makes a live third-party API call. ENG-2188: `never_connected`
 * is activation and must never reach the alert.
 */
function adConnectionState(user: any): AdConnectionSummary['state'] {
  const raw = user?.connected_accounts;
  return classifyAdConnections(Array.isArray(raw) ? raw : [], user?.adAccount, Date.now()).state;
}

/** Which of the three independent paid-ads-intent signals actually matched, if any. */
type PaidAdsIntentReason = 'goal' | 'emma_help_interests' | 'onboarding_event' | null;

/**
 * Single source of truth for "did this user express paid-ads intent, and how."
 * `hasPaidAdsIntent` and `describeCustomerOutcome` both derive from this instead
 * of each independently re-deciding: the two used to check similar-but-not-
 * identical conditions (`describeCustomerOutcome` reported the first TRUTHY field
 * in priority order, not the field that actually matched 'paid_ads'), which could
 * report a stale, unrelated `goal` value as the reason even when the real trigger
 * was `emmaHelpInterests` or an onboarding event -- an internally-contradictory,
 * misleading alert, exactly what ENG-1541's alert-enrichment work exists to
 * prevent. One function, two callers, cannot drift apart again.
 */
function paidAdsIntentReason(user: any): PaidAdsIntentReason {
  if (user?.goal === 'paid_ads') return 'goal';
  if (Array.isArray(user?.emmaHelpInterests) && user.emmaHelpInterests.includes('paid_ads')) return 'emma_help_interests';
  if (Array.isArray(user?.onboardingEvents) && user.onboardingEvents.some(
    (event: any) => event?.event === 'goal_selected' && event?.data?.goal === 'paid_ads',
  )) return 'onboarding_event';
  return null;
}

/** A user needs an ad connection only after explicitly choosing paid ads. */
function hasPaidAdsIntent(user: any): boolean {
  return paidAdsIntentReason(user) !== null;
}

/**
 * True when the user's subscription plan permits connecting at least one ad
 * platform (meta / google_ads / linkedin_ads). Consults the same entitlement
 * mechanism that gates the connected-accounts UI
 * (`subscriptionService.getAllowedConnectedAccounts`) so this cron never
 * flags a customer whose plan never included ad integration in the first
 * place, independent of onboarding-time intent (ENG-1541). Unrestricted
 * plans (`allowedConnectedAccounts` undefined or `['*']`) resolve through
 * `getAllowedConnectedAccounts` to the full platform list, which includes
 * `meta` and `google_ads` — so an unrestricted plan is always entitled here,
 * preserving today's behavior exactly.
 */
async function hasAdIntegrationEntitlement(userId: string): Promise<boolean> {
  const allowed = await getAllowedConnectedAccounts(userId);
  return allowed.some((platform) => AD_PLATFORMS.has(platform as PlatformType));
}

/**
 * ENG-1541: what the customer is actually trying to achieve, for the alert body.
 * Reports whichever signal actually satisfied `hasPaidAdsIntent` (via
 * `paidAdsIntentReason`), not just the first truthy field on the user record --
 * a stale, unrelated `goal` (free text, not enum-validated -- see routes/brandBuild.ts)
 * must never be reported as the reason when the real trigger was a different signal.
 * The `null` branch is structurally unreachable when called from the `would_flag`
 * path (that path requires `hasPaidAdsIntent` to already be true), kept only so this
 * stays a total function if that invariant is ever broken elsewhere.
 */
function describeCustomerOutcome(user: any): string {
  switch (paidAdsIntentReason(user)) {
    case 'goal':
      return 'stated goal: paid_ads';
    case 'emma_help_interests':
      return 'stated interest: paid_ads (Emma help interests)';
    case 'onboarding_event':
      return 'paid_ads goal selected during onboarding';
    case null:
      // Should never happen from the would_flag path (see doc comment above) -- if a
      // future regression ever reaches this, say so honestly rather than falsely
      // claiming one of the three signals matched when none did.
      return 'no paid-ads intent signal found on record (this should not be possible here)';
  }
}

/**
 * ENG-1541: the most recent ad-platform signal on record, for the alert body.
 * Ad-platform configs (`BaseOAuthConfig`) only carry `token_expires_at` -- there is
 * no dedicated "disconnected at" timestamp for these platforms (that field exists
 * only on `LinkedInOutreachConfig`, a different platform). So this can only ever
 * honestly say when a token expired, never claim the account was actively healthy
 * up to that point -- and if no ad-platform entry exists at all, says so plainly
 * rather than guessing at a date.
 */
function describeLastAdAccountSignal(user: any): string {
  const raw = user?.connected_accounts;
  const accounts: any[] = Array.isArray(raw) ? raw : [];
  const expiries = accounts
    .filter((acc) => isAdAccount(acc) && typeof acc?.config?.token_expires_at === 'number')
    .map((acc) => acc.config.token_expires_at as number);
  if (expiries.length === 0) return 'no ad platform account on record';
  return `most recent ad account token expired ${new Date(Math.max(...expiries)).toISOString()}`;
}

/**
 * The single decision this whole cron makes, for one user. Shared by the real
 * scan loop below and by the read-only admin dry-run route (ENG-1541) so the
 * two can never diverge — the dry-run route proves exactly what the scan
 * would have decided, not a parallel reimplementation of the same logic.
 * Read-only: makes no writes and sends no alert either way.
 */
export async function evaluateRenewalIntegrationHealth(user: any): Promise<RenewalIntegrationHealthEvaluation> {
  const paidAdsIntent = hasPaidAdsIntent(user);
  const adConnection = adConnectionState(user);
  const healthyIntegration = adConnection === 'connected';
  const base = { hasPaidAdsIntent: paidAdsIntent, hasHealthyAdIntegration: healthyIntegration, adConnection };

  if (!paidAdsIntent) {
    return { decision: 'skipped_no_paid_ads_intent', ...base, hasAdIntegrationEntitlement: null };
  }
  if (healthyIntegration) {
    return { decision: 'skipped_healthy_integration', ...base, hasAdIntegrationEntitlement: null };
  }
  // Stale onboarding intent plus an account that never connected is activation, not a broken
  // integration (ENG-2188, decision D6): the classifier cron nudges CS about it instead.
  if (adConnection === 'never_connected') {
    return { decision: 'skipped_activation_incomplete', ...base, hasAdIntegrationEntitlement: null };
  }

  const entitled = await hasAdIntegrationEntitlement(user.userId);
  return {
    decision: entitled ? 'would_flag' : 'skipped_no_ad_entitlement',
    ...base,
    hasAdIntegrationEntitlement: entitled,
  };
}

/**
 * Scan users with an active subscription renewing within `RENEWAL_LOOKAHEAD_DAYS`
 * and flag paid-ads customers, whose plan actually permits ad integration,
 * whose every ad integration has expired (never connecting is activation, not
 * flagged). Resilient: a failure evaluating or alerting for one user is logged
 * and never aborts the rest of the run.
 */
export async function runRenewalIntegrationHealthCheck(): Promise<RenewalIntegrationHealthSummary> {
  const summary: RenewalIntegrationHealthSummary = {
    scannedUsers: 0,
    flagged: 0,
    suppressedByCorrection: 0,
    alertFailed: 0,
    evaluationFailed: 0,
    trackingFailed: 0,
  };

  const now = Date.now();
  const cutoffIso = new Date(now + RENEWAL_LOOKAHEAD_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const nowIso = new Date(now).toISOString();

  let users: any[];
  try {
    users = await userDb.scanWithFilter(
      'subscription_status = :status AND current_period_end BETWEEN :now AND :cutoff',
      { ':status': 'active', ':now': nowIso, ':cutoff': cutoffIso }
    );
  } catch (error) {
    console.error(`${TAG} Failed to scan renewal-imminent users:`, error);
    return summary;
  }

  for (const user of users) {
    // ENG-1907: this scan bypasses getAllUsers. A sandbox principal is 'active' with
    // paid-ads intent and no real ad account — exactly the shape that flags. Never alert on it.
    if (isEvaluationUser(user?.userId)) continue;
    summary.scannedUsers++;

    // Isolated on purpose, symmetric to the alert-send try/catch below: today's
    // helper functions all guard their inputs and cannot throw, but that is an
    // implicit property of their current implementations, not a structural
    // guarantee of this loop. Without this, a future regression in one of them
    // would silently abort evaluation for every remaining user in the scan, not
    // just the one with unexpected data.
    let evaluation: RenewalIntegrationHealthEvaluation;
    try {
      evaluation = await evaluateRenewalIntegrationHealth(user);
    } catch (error) {
      summary.evaluationFailed++;
      console.error(`${TAG} Failed to evaluate user ${user?.userId ?? 'unknown'}:`, error);
      continue;
    }
    // ENG-1541 items 1-2: persist this run's status for every decision branch, before the
    // would_flag gate below — every branch needs the same symmetric read-compare-write, not
    // just the one that alerts. Isolated the same way evaluation/alert-send already are: an
    // uncaught throw here must not abort the scan for every remaining user. `updatedRow` (not
    // the pre-write read) is what the suppression check below must use — see
    // `upsertAccountCapabilityStatus`'s own doc comment for why the stale row would be wrong.
    let updatedRow: AccountCapabilityRequirement | null = null;
    try {
      const capabilityRow = await getAccountCapabilityRequirement(user.userId, 'ad_platform_integration');
      const statusForDecision: Record<RenewalIntegrationHealthDecision, AccountCapabilityStatus> = {
        would_flag: 'unhealthy',
        // The capability is still not working; only the alert is withheld (activation, not risk).
        skipped_activation_incomplete: 'unhealthy',
        skipped_healthy_integration: 'healthy',
        skipped_no_ad_entitlement: 'not_entitled',
        skipped_no_paid_ads_intent: 'not_required',
      };
      if (evaluation.decision === 'skipped_no_paid_ads_intent') {
        // Only ever write not_required onto a row that already exists (intent has lapsed) —
        // a user who has never expressed paid-ads intent never gets a row created for them.
        if (capabilityRow) {
          updatedRow = await upsertAccountCapabilityStatus(
            capabilityRow,
            user.userId,
            'ad_platform_integration',
            'not_required',
            null,
          );
        }
      } else {
        updatedRow = await upsertAccountCapabilityStatus(
          capabilityRow,
          user.userId,
          'ad_platform_integration',
          statusForDecision[evaluation.decision],
          paidAdsIntentReason(user) as AccountCapabilitySourceDetail, // non-null: this branch only runs when hasPaidAdsIntent is true
        );
      }
    } catch (error) {
      summary.trackingFailed++;
      console.error(`${TAG} Failed to update capability tracking for user ${user?.userId ?? 'unknown'}:`, error);
      // Deliberately continue to the would_flag gate below rather than `continue`-ing past this
      // user entirely: a tracking failure must not also suppress a real alert for them.
    }

    if (evaluation.decision !== 'would_flag') continue;

    summary.flagged++;

    // ENG-1541 item 2: a human correction, if still active and unexpired, short-circuits
    // before the existing in-memory dedupe below — a stronger, earlier suppression for the
    // specific case this mechanism exists for. If not suppressed, falls through to today's
    // 24h timer unchanged. `updatedRow` can be null only if the tracking write itself failed
    // above (already counted as trackingFailed) — fail open here, same as the rest of this
    // loop's isolation philosophy: a tracking failure must not also suppress a real alert.
    if (isSuppressed(updatedRow)) {
      summary.suppressedByCorrection++;
      continue;
    }

    try {
      // ENG-1541 Build item 4: state customer outcome, capability, last known signal,
      // next actor, and confidence explicitly, rather than leaving the oncall reader to
      // infer them from a single sentence. Built inside this try, not before it: these
      // are pure functions that cannot throw today, but that's an implicit property of
      // their current implementations, not a structural guarantee -- same reasoning as
      // the evaluation-isolation fix above. A failure constructing the alert content is
      // still a failure to alert, correctly counted as `alertFailed` either way.
      const customerOutcome = describeCustomerOutcome(user);
      const lastAdAccountSignal = describeLastAdAccountSignal(user);
      const nextActor = 'Customer — reconnect the ad platform account in Settings > Connected Accounts';
      // Deliberately not a fabricated score: this decision is a deterministic check, not
      // a model guess, so "confidence" means stating exactly what was and wasn't verified
      // this run, not inventing a number for something never measured.
      const confidence =
        'plan entitlement and current connection state independently verified this run; ' +
        'paid-ads intent is user-declared and not independently re-confirmed';
      await sendAgentModeOncallAlert({
        // ENG-2188: an expired connection is reconnect work, not churn evidence — no "at risk" label.
        subject: `Renewal reconnect needed: ${user.email || user.userId} has no healthy ad integration`,
        message:
          `${user.email || user.userId} selected paid ads and renews on ${user.current_period_end}, but every ` +
          `ad platform account on record (Meta/Google Ads/LinkedIn Ads) has expired. Check the account ` +
          `before the charge fires.\n\n` +
          `Customer outcome: ${customerOutcome}\n` +
          `Capability affected: ad platform integration (Meta / Google Ads / LinkedIn Ads)\n` +
          `Last known signal: ${lastAdAccountSignal}\n` +
          `Next actor: ${nextActor}\n` +
          `Confidence: ${confidence}`,
        dedupeKey: `renewal-integration-health:${user.userId}`,
        dedupeWindowMs: DEDUPE_WINDOW_MS,
        context: {
          userId: user.userId,
          email: user.email,
          currentPeriodEnd: user.current_period_end,
          customerOutcome,
          capability: 'ad_platform_integration',
          lastAdAccountSignal,
          nextActor,
          confidence,
        },
      });
    } catch (error) {
      summary.alertFailed++;
      console.error(`${TAG} Failed to send alert for user ${user.userId}:`, error);
    }
  }

  console.log(
    `${TAG} Run complete — scannedUsers=${summary.scannedUsers} flagged=${summary.flagged} ` +
    `suppressedByCorrection=${summary.suppressedByCorrection} alertFailed=${summary.alertFailed} ` +
    `evaluationFailed=${summary.evaluationFailed} trackingFailed=${summary.trackingFailed}`
  );
  return summary;
}
