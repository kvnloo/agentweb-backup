/**
 * ENG-926 §F — continuous tracking-integrity monitoring.
 *
 * The card exists because RankAI's tracking broke, was reported fixed three times without
 * an end-to-end check, and nobody noticed until the client asked a question the data could
 * no longer answer. The reason nobody noticed is structural: the failure is an ABSENCE.
 * No request fails, no error is thrown, no user clicks anything — leads simply stop
 * arriving. An absence has no event to hang a listener on, which is why this is a clock
 * rather than a hook.
 *
 * This module holds the classification half: turning a day of Meta ad activity into
 * "did this spend produce any attributed conversion at all".
 *
 * ─── Two facts established against REAL production data, not docs ───────────────────
 *
 * Read 2026-08-15 from Haven (`act_1842363582956923`) and Every.io
 * (`act_1358071355944019`), 25 daily rows each, `time_increment=1`:
 *
 *   1. `actions` is NEVER EMPTY on a spending account. A live day carries ~20 action
 *      types and almost all of them are engagement — `link_click`, `post_reaction`,
 *      `landing_page_view`, `video_view`, `page_engagement`. Any check phrased as "did
 *      Meta report any actions" is therefore permanently green and can never fire once.
 *      That is the same shape of failure as the weekly report that read the broken pixel
 *      it was supposed to validate.
 *
 *   2. ONE conversion is reported under SEVERAL names. Haven 2026-06-08 carried
 *      `lead: 17`, `offsite_conversion.fb_pixel_lead: 17`, `onsite_web_lead: 17` and
 *      `offsite_lead_add_20_s_calls: 17` — one set of 17 leads, four names. Across all 50
 *      production days examined, the bare rollup equalled the maximum of its aliases in
 *      every single row, with zero exceptions. Hence: count each family ONCE, by its
 *      maximum. Summing the aliases reports 34 leads for 17 and would make a half-broken
 *      account read as healthier than a working one. (`businessFunnelService`'s
 *      action-type list sums three lead aliases and carries exactly that defect; it is
 *      dormant only because its insights call never requests the `actions` field.)
 */

const TAG = '[Tracking Monitor]';

/** Meta's deduplicated conversion rollups. Each is a FAMILY: the bare name plus the
 *  alias spellings Meta reports the same conversion under. Objective determines which
 *  appear, so a customer optimising for registrations and one optimising for leads are
 *  both covered without configuration. */
const CONVERSION_FAMILIES = [
  'lead',
  'complete_registration',
  'purchase',
  'schedule',
  'submit_application',
  'start_trial',
  'subscribe',
  'contact',
  'initiate_checkout',
  'add_to_cart',
  'donate',
  'find_location',
] as const;

/**
 * Every spelling Meta has been observed to use for a family, plus the generated prefixes.
 * Exact matches first, then the two prefix forms — `offsite_lead_add_20_s_calls` and
 * `offsite_complete_registration_add_meta_leads` are both real, both from Haven, and both
 * carry an arbitrary suffix naming the ad-set rule that produced them.
 */
function familyOf(actionType: string): string | null {
  for (const family of CONVERSION_FAMILIES) {
    if (
      actionType === family ||
      actionType === `omni_${family}` ||
      actionType === `onsite_web_${family}` ||
      actionType === `offsite_conversion.fb_pixel_${family}` ||
      actionType === `onsite_conversion.${family}` ||
      actionType === `offsite_${family}` ||
      actionType.startsWith(`offsite_${family}_add_`)
    ) {
      return family;
    }
  }
  return null;
}

/**
 * Action types known to be engagement rather than conversion.
 *
 * This list exists so the "unrecognised" signal stays meaningful. Without it every
 * spending day would report ~20 unknown types, the signal would be pure noise on every
 * account every day, and it would be ignored inside a week — which is the same outcome as
 * not having it.
 *
 * Prefix families are handled separately below; these are the exact names observed on
 * real Haven and Every.io days.
 */
const ENGAGEMENT_EXACT = new Set([
  'link_click',
  'landing_page_view',
  'omni_landing_page_view',
  'comment',
  'like',
  'post',
  'rsvp',
  'photo_view',
  'checkin',
  'app_engagement',
]);

/** Whole families of engagement, matched by prefix — `post_*`, `page_*`, `video_*`, and
 *  the `onsite_conversion.post_*` reaction spellings. Deliberately NOT applied to
 *  `onsite_conversion.` as a whole: a genuine conversion can live under that prefix and
 *  must not be silently swallowed as engagement. */
const ENGAGEMENT_PREFIXES = [
  'post_',
  'page_',
  'video_',
  'onsite_conversion.post_',
  'onsite_conversion.messaging_',
  'onsite_conversion.total_messaging_',
];

function isKnownEngagement(actionType: string): boolean {
  if (ENGAGEMENT_EXACT.has(actionType)) return true;
  return ENGAGEMENT_PREFIXES.some((prefix) => actionType.startsWith(prefix));
}

/** How many unknown action types one day may report. A cap, because this is a diagnostic
 *  breadcrumb in a log line, not a dataset — one oddly-configured account must not be able
 *  to flood a cron's output. */
export const UNRECOGNIZED_SAMPLE_LIMIT = 10;

export interface AttributedConversionCount {
  /** Deduplicated attributed conversions across every family present. */
  conversions: number;
  /**
   * Action types that are neither a known conversion family nor known engagement.
   *
   * This is the THIRD state, and it exists because "zero conversions" and "conversions
   * reported under a name this code has never been taught" are indistinguishable from the
   * count alone — yet one of them is an alert and the other is a vocabulary gap in here.
   * Collapsing them would either fire a false blackout alert on a healthy customer or
   * hide a real one. Neither is acceptable, so the count stays honest and the unknown
   * names are surfaced for a human to add.
   */
  unrecognized: string[];
}

/**
 * Deduplicated conversion count for one day of insights `actions`.
 *
 * Counts each family by its MAXIMUM member rather than its sum — see the header. An alias
 * arriving without its bare rollup still counts: it is then the only evidence the
 * conversion happened, and dropping it would manufacture a blackout that is not real, on a
 * detector whose entire job is alerting about blackouts.
 */
export function countAttributedConversions(actions: any[] | undefined | null): AttributedConversionCount {
  const perFamily = new Map<string, number>();
  const unrecognized: string[] = [];
  const seenUnknown = new Set<string>();

  for (const entry of Array.isArray(actions) ? actions : []) {
    const actionType = entry?.action_type;
    // A row with no action type carries no information about anything. It is not an
    // unknown conversion — it is malformed — so it must not pollute the diagnostic.
    if (typeof actionType !== 'string' || !actionType) continue;

    const family = familyOf(actionType);
    if (family) {
      const value = Number.parseInt(entry?.value, 10);
      // A non-numeric value contributes nothing rather than NaN-poisoning the total.
      if (Number.isFinite(value)) {
        perFamily.set(family, Math.max(perFamily.get(family) ?? 0, value));
      } else if (!perFamily.has(family)) {
        perFamily.set(family, 0);
      }
      continue;
    }

    if (isKnownEngagement(actionType)) continue;

    if (!seenUnknown.has(actionType) && unrecognized.length < UNRECOGNIZED_SAMPLE_LIMIT) {
      seenUnknown.add(actionType);
      unrecognized.push(actionType);
    }
  }

  let conversions = 0;
  for (const value of perFamily.values()) conversions += value;

  return { conversions, unrecognized };
}

/**
 * Campaign objectives that actually optimise for a conversion.
 *
 * Established on production 2026-08-16, and the reason this filter exists: of the three
 * accounts the blackout check flagged, TWO were running campaigns that were never trying
 * to convert.
 *
 *   Every.io      $557.39  OUTCOME_ENGAGEMENT — boosted posts, NO destination URL
 *   Kraftersland  $ 60.59  LINK_CLICKS + OUTCOME_ENGAGEMENT
 *   AgentWeb own  $175.57  OUTCOME_LEADS — a real blackout
 *
 * A boosted post with no link cannot produce an attributed conversion however perfect the
 * tracking is. Alerting on it trains people to ignore the channel, which is the outcome
 * §F exists to prevent — reached from the opposite direction.
 *
 * Both the outcome-era names and the legacy ones, because older campaigns still carry the
 * old values.
 */
export const CONVERSION_OBJECTIVES = new Set([
  'OUTCOME_LEADS',
  'OUTCOME_SALES',
  'CONVERSIONS',
  'LEAD_GENERATION',
  'PRODUCT_CATALOG_SALES',
  'APP_INSTALLS',
  'OUTCOME_APP_PROMOTION',
  'STORE_VISITS',
]);

/**
 * Whether spend under this objective should be judged for conversions.
 *
 * An UNKNOWN objective counts as YES, deliberately. Meta adds objectives over time, and a
 * name this list has not caught up with must never silently suppress a real blackout — a
 * false alert is recoverable, silence is the failure this card exists to end. So the
 * filter can only ever REMOVE noise it positively recognises.
 */
export function isConversionOptimisedObjective(objective?: string | null): boolean {
  const name = typeof objective === 'string' ? objective.trim().toUpperCase() : '';
  if (!name) return true;
  if (CONVERSION_OBJECTIVES.has(name)) return true;
  return !NON_CONVERSION_OBJECTIVES.has(name);
}

/** Objectives positively known NOT to optimise for conversions. Everything here was seen
 *  on a real account that this check wrongly flagged, or is documented alongside them. */
const NON_CONVERSION_OBJECTIVES = new Set([
  'OUTCOME_ENGAGEMENT',
  'OUTCOME_AWARENESS',
  'OUTCOME_TRAFFIC',
  'LINK_CLICKS',
  'BRAND_AWARENESS',
  'REACH',
  'VIDEO_VIEWS',
  'POST_ENGAGEMENT',
  'PAGE_LIKES',
  'EVENT_RESPONSES',
  'MESSAGES',
  'OUTCOME_MESSAGES',
  'LOCAL_AWARENESS',
]);

export interface SpendByObjective {
  /** Spend under objectives that are trying to convert — the only spend a blackout judges. */
  conversionSpend: number;
  /** Spend explicitly excluded, reported so an operator can see WHY nothing alerted. */
  nonConversionSpend: number;
  excludedObjectives: string[];
  /** Objectives not in either list. Counted as conversion spend (fail loud) and surfaced
   *  so the catalogue can be extended rather than silently drifting. */
  unknownObjectives: string[];
}

/** Split a window's campaign rows into spend that was trying to convert and spend that
 *  never was. */
export function splitSpendByObjective(rows: any[]): SpendByObjective {
  let conversionSpend = 0;
  let nonConversionSpend = 0;
  const excluded = new Set<string>();
  const unknown = new Set<string>();

  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row) continue;
    const spend = Number.parseFloat(row.spend);
    if (!Number.isFinite(spend)) continue;
    const raw = typeof row.objective === 'string' ? row.objective.trim().toUpperCase() : '';

    if (raw && NON_CONVERSION_OBJECTIVES.has(raw)) {
      nonConversionSpend += spend;
      excluded.add(raw);
      continue;
    }
    if (raw && !CONVERSION_OBJECTIVES.has(raw)) unknown.add(raw);
    conversionSpend += spend;
  }

  return {
    conversionSpend,
    nonConversionSpend,
    excludedObjectives: [...excluded],
    unknownObjectives: [...unknown],
  };
}

export interface MonitorFetchDeps {
  fetchImpl: typeof fetch;
}

export type AdAccountActivity = {
  /**
   * `token_error` exists as a separate status for a specific reason: an expired token
   * returns no rows, and no rows is indistinguishable from a dormant account. A monitor
   * that swallowed it would report healthy silence for an account it can no longer see —
   * rebuilding the exact failure the card exists to prevent, inside the fix for it.
   * Not hypothetical: one production ad account carried a dead token the day this shipped.
   */
  status: 'ok' | 'token_error' | 'fetch_error';
  days: AdAccountDay[];
  error?: string;
  /** Objectives whose spend was excluded from the judgement, so an operator can see WHY
   *  an account that is visibly spending did not alert. */
  excludedObjectives?: string[];
  /** Objectives in neither catalogue. Counted as in-scope (fail loud) and surfaced so the
   *  list can be extended rather than drifting silently. */
  unknownObjectives?: string[];
};

/**
 * One day of daily-granularity insights for an ad account.
 *
 * `time_increment=1` and an explicit `actions` field are BOTH required and neither is the
 * default. `metaService.getInsights` requests neither, which is why
 * `businessFunnelService`'s lead count reads `row.actions` that never arrives and is
 * therefore structurally always zero. That omission is silent — the call succeeds, the
 * number is simply always 0 — which is why the request shape is pinned by a test.
 */
export async function fetchDailyAdAccountActivity(
  adAccountId: string,
  accessToken: string,
  days: number,
  deps?: MonitorFetchDeps,
): Promise<AdAccountActivity> {
  const fetchImpl = deps?.fetchImpl ?? fetch;
  const apiVersion = process.env.META_API_VERSION || 'v25.0';
  // CAMPAIGN level, not account: `objective` is only available per campaign, and without
  // it the check cannot tell spend that was trying to convert from spend that never was.
  // Two of the three accounts this flagged on 2026-08-16 were running engagement campaigns
  // where zero attributed conversions is the CORRECT outcome (§28).
  const params = new URLSearchParams({
    fields: 'spend,actions,date_start,objective,campaign_name',
    level: 'campaign',
    time_increment: '1',
    date_preset: dayWindowToPreset(days),
  });
  // The token goes in a header-shaped query param only at call time and is never part of
  // the string retained for logging: this URL reaches error logs on failure, and a
  // credential in a log is a leak that outlives the incident.
  const baseUrl = `https://graph.facebook.com/${apiVersion}/act_${adAccountId}/insights?${params}`;

  // Campaign rows collapse into one row per DAY, counting only campaigns that were trying
  // to convert. A non-conversion campaign contributes neither its spend nor its
  // conversions: its spend would manufacture a blackout, and its conversions would let
  // engagement traffic mask a real one on the same account.
  const byDay = new Map<string, AdAccountDay>();
  const excluded = new Set<string>();
  const unknown = new Set<string>();

  // Campaign level multiplies rows by the campaign count, so a real account spills past
  // Meta's page size where the old account-level query (7 rows a week) never did. Reading
  // only the first page silently drops spend AND conversions — a wrong verdict in either
  // direction rather than a missing one (Greptile P1 on #2420).
  let url: string = `${baseUrl}&access_token=${encodeURIComponent(accessToken)}`;

  try {
    for (let page = 0; page < MAX_INSIGHTS_PAGES && url; page++) {
      const response = await fetchImpl(url);
      const body: any = await response.json();

      if (!response.ok || body?.error) {
        const error = body?.error || {};
        // Code 190 is Meta's "this token is no longer usable" — expired, revoked, or
        // invalidated by a password change. Every other OAuthException (17 is the user
        // request limit) is transient and resolves without anyone re-authorising, so
        // reporting it as a dead token would send a human to fix nothing.
        const isDeadToken = error?.code === 190;
        return {
          status: isDeadToken ? 'token_error' : 'fetch_error',
          days: [],
          error: typeof error?.message === 'string' ? error.message : `HTTP ${response.status}`,
        };
      }

      for (const row of Array.isArray(body?.data) ? body.data : []) {
        const date = String(row?.date_start ?? '');
        if (!date) continue;
        const objective = typeof row?.objective === 'string' ? row.objective.trim().toUpperCase() : '';

        const day = byDay.get(date) || { date, spend: 0, conversions: 0, unrecognized: [] };
        byDay.set(date, day);

        if (objective && !isConversionOptimisedObjective(objective)) {
          excluded.add(objective);
          continue;
        }
        if (objective && !CONVERSION_OBJECTIVES.has(objective)) unknown.add(objective);

        const counted = countAttributedConversions(row?.actions);
        day.spend += Number.parseFloat(row?.spend ?? '0') || 0;
        day.conversions += counted.conversions;
        for (const u of counted.unrecognized) {
          if (!day.unrecognized.includes(u)) day.unrecognized.push(u);
        }
      }

      url = typeof body?.paging?.next === 'string' ? body.paging.next : '';

      // Exhausting the cap with pages still outstanding is NOT a complete read. Returning
      // what we have would present a truncated window as a whole one — indistinguishable
      // from genuinely reduced spend, and able to produce either a false blackout or a
      // missed one. Same rule as a failure on a later page: no answer beats a partial one
      // dressed as complete (Greptile P1 on #2420, second pass).
      if (url && page === MAX_INSIGHTS_PAGES - 1) {
        console.warn(
          `${TAG} ${adAccountId}: campaign insights still paging after ${MAX_INSIGHTS_PAGES} ` +
          `pages — refusing to judge a truncated window`,
        );
        return {
          status: 'fetch_error',
          days: [],
          error: `insights exceeded ${MAX_INSIGHTS_PAGES} pages; window incomplete`,
        };
      }
    }
  } catch (error: any) {
    // A network failure must never abort the sweep — the next account still needs checking.
    return { status: 'fetch_error', days: [], error: error?.message || 'request failed' };
  }

  return {
    status: 'ok',
    days: [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date)),
    excludedObjectives: [...excluded],
    unknownObjectives: [...unknown],
  };
}

/** Bound on insight pages followed per account. Seven days across a normal campaign count
 *  is a handful of pages; the cap only exists so a pathological `paging.next` cannot loop. */
const MAX_INSIGHTS_PAGES = 20;

/** Meta accepts only a fixed set of presets; map the requested window onto the smallest
 *  one that covers it rather than computing explicit dates, which drift across timezones. */
function dayWindowToPreset(days: number): string {
  if (days <= 7) return 'last_7d';
  if (days <= 14) return 'last_14d';
  if (days <= 30) return 'last_30d';
  return 'last_90d';
}

/**
 * How many CONSECUTIVE spending days with no attributed conversion constitute a blackout.
 *
 * Three, not one: a single quiet day is ordinary variance on a small account, and an alert
 * that fires on variance gets muted. Three days of real spend with nothing back is not
 * variance. Every.io ran 24 such days; RankAI's entire tracked lifetime was one.
 */
export const BLACKOUT_CONSECUTIVE_DAYS = 3;

export interface AdAccountDay {
  date: string;
  spend: number;
  conversions: number;
  unrecognized: string[];
}

export type AdAccountVerdict = {
  /**
   * `idle` — nothing was spent, so there is nothing to conclude. Distinct from `ok` on
   *   purpose: most accounts are dormant, and a dormant account is neither healthy nor
   *   broken. Reporting it as `ok` would let a paused campaign read as a passing check.
   * `ok` — spend produced conversions.
   * `blackout` — sustained spend, nothing back. This is AC4.
   * `unclassifiable` — sustained spend, nothing back, BUT unknown action types were seen
   *   on the same days, so the zero may be our vocabulary rather than their tracking.
   */
  status: 'idle' | 'ok' | 'blackout' | 'unclassifiable';
  consecutiveBlackoutDays: number;
  spendInBlackout: number;
  unrecognized: string[];
};

/**
 * Decide whether a run of daily rows is a blackout.
 *
 * Two rules that look like details and are not:
 *
 * Zero-spend days are EXCLUDED from the evidence rather than counted as blackout days. A
 * paused campaign spends nothing and converts nothing; counting that would alert on every
 * dormant account, which today is nearly all of them, and the alert would be muted before
 * it ever caught a real one.
 *
 * Zero-spend days also do not BREAK a streak. An outage that happens to span a weekend
 * pause is still one outage, and letting the pause reset the counter would hide exactly
 * the long-running failures this exists to find.
 *
 * The streak is measured from the most recent day backwards. A gap earlier in the window
 * is history that may already be fixed; re-alerting on it every day forever is how an
 * alert channel becomes noise.
 */
export function evaluateAdAccountDays(days: AdAccountDay[]): AdAccountVerdict {
  const spendingDays = (Array.isArray(days) ? days : []).filter((d) => Number(d?.spend) > 0);
  if (spendingDays.length === 0) {
    return { status: 'idle', consecutiveBlackoutDays: 0, spendInBlackout: 0, unrecognized: [] };
  }

  const streak: AdAccountDay[] = [];
  for (let i = spendingDays.length - 1; i >= 0; i--) {
    if (spendingDays[i].conversions !== 0) break;
    streak.push(spendingDays[i]);
  }

  if (streak.length < BLACKOUT_CONSECUTIVE_DAYS) {
    return { status: 'ok', consecutiveBlackoutDays: streak.length, spendInBlackout: 0, unrecognized: [] };
  }

  const spendInBlackout = streak.reduce((sum, d) => sum + Number(d.spend || 0), 0);
  // Only the days being used as EVIDENCE can cast doubt on the verdict. An unknown action
  // type on a healthy day earlier in the window says nothing about this streak.
  const unrecognized = [...new Set(streak.flatMap((d) => d.unrecognized || []))];

  return {
    status: unrecognized.length > 0 ? 'unclassifiable' : 'blackout',
    consecutiveBlackoutDays: streak.length,
    spendInBlackout,
    unrecognized,
  };
}

// ── Alerting ─────────────────────────────────────────────────────────────────────────
//
// Alerts go to ONCALL, not to the customer, and that is a deliberate choice rather than
// the easy one. Almost every tracking failure traced so far was ours and on our own
// generated pages: RankAI's lander discarded `utm_*` and `fbclid` at the capture call;
// hireemma.ai fired eight conversions at a dead PixelFlow endpoint with no `window.fbq`
// on the site at all. Telling a customer "your tracking is broken" about a bug they
// cannot reach is noise to them and a lost signal for us.
//
// Some causes ARE the customer's — a dead token only they can re-authorise, a Business
// Manager with no pixel in it. Those deserve a customer-facing surface eventually, and
// ENG-1192's portal banner is the right home. Not here: this detector has never run
// against live data, and an unproven alarm shown to customers is how an alarm becomes
// something people learn to ignore.

/** Stable dedupe classes for the intake gate (ENG-358). Every occurrence carries one, so
 *  repeat firings cluster onto ONE canonical Linear issue instead of filing a fresh one
 *  per run — the failure that produced 14 near-identical v0 issues in 5 days. This job
 *  sees every account every day, so it is the same shape at greater volume. */
export const BLACKOUT_ALERT_CLASS = 'meta-attribution-blackout';
export const TOKEN_ALERT_CLASS = 'meta-token-invalid';

/** Re-alert at most once per account per class per day. A blackout that is still open
 *  tomorrow still matters, so this is a rate limit rather than a one-shot. */
export const ALERT_REALERT_WINDOW_MS = 24 * 60 * 60 * 1000;

export type AlertTransport = (
  subject: string,
  message: string,
  context?: Record<string, any>,
) => Promise<void>;

/** Default transport: the canonical ops path — oncall email plus an auto-filed tracked
 *  issue, suppressed outside production by emailService itself. Lazily imported so this
 *  module's unit tests never pull in the email dependency graph. */
const defaultAlertTransport: AlertTransport = async (subject, message, context) => {
  const { emailService } = await import('./emailService');
  await emailService.sendOncallAlert(subject, message, context);
};

/** In-memory, per (account, class). A process restart re-alerting once is acceptable and
 *  is the same trade v0BillingService makes; persisting this would mean a table write per
 *  account per day to save one duplicate email after a deploy. */
const lastAlertAtByKey = new Map<string, number>();

export function __resetTrackingAlertStateForTests(): void {
  lastAlertAtByKey.clear();
}

function shouldSuppress(key: string, now: number): boolean {
  const last = lastAlertAtByKey.get(key);
  if (last !== undefined && now - last < ALERT_REALERT_WINDOW_MS) return true;
  lastAlertAtByKey.set(key, now);
  if (lastAlertAtByKey.size > 1000) {
    for (const [k, ts] of lastAlertAtByKey) {
      if (now - ts >= ALERT_REALERT_WINDOW_MS) lastAlertAtByKey.delete(k);
    }
  }
  return false;
}

export interface MonitorDeps {
  fetchActivity?: (
    adAccountId: string,
    accessToken: string,
    days: number,
  ) => Promise<AdAccountActivity>;
  alertTransport?: AlertTransport;
  now?: number;
}

export interface MonitorSummary {
  accountsChecked: number;
  blackouts: number;
  tokenErrors: number;
  fetchErrors: number;
  unclassifiable: number;
  idle: number;
  healthy: number;
  unrecognizedActionTypes: string[];
  /** Objectives whose spend was excluded from judgement. Surfaced so an operator can see
   *  WHY an account that is visibly spending did not alert — a filter nobody can observe
   *  is indistinguishable from a detector that is broken. */
  excludedObjectives: string[];
  /** Objectives in neither catalogue, counted as in-scope. Surfaced so the list can be
   *  extended deliberately rather than drifting. */
  unknownObjectives: string[];
}

/** How many days of history each check reads. Comfortably more than the blackout
 *  threshold so a streak is visible in full rather than inferred from its tail. */
export const MONITOR_WINDOW_DAYS = 7;

/**
 * Check every Meta ad account this user has connected. Never throws: it runs inside a
 * cron sweep over every user, and one bad account must not abandon the rest.
 */
export async function monitorUserTracking(user: any, deps?: MonitorDeps): Promise<MonitorSummary> {
  const summary: MonitorSummary = {
    accountsChecked: 0,
    blackouts: 0,
    tokenErrors: 0,
    fetchErrors: 0,
    unclassifiable: 0,
    idle: 0,
    healthy: 0,
    unrecognizedActionTypes: [],
    excludedObjectives: [],
    unknownObjectives: [],
  };

  const fetchActivity =
    deps?.fetchActivity ??
    ((id: string, token: string, days: number) => fetchDailyAdAccountActivity(id, token, days));
  const alertTransport = deps?.alertTransport ?? defaultAlertTransport;
  const now = deps?.now ?? Date.now();

  const accounts = (Array.isArray(user?.connected_accounts) ? user.connected_accounts : []).filter(
    // 'facebook' is checked alongside 'meta' by three other modules; production carries
    // zero such rows today (all 21 Meta connections are 'meta'), but matching the wider
    // predicate costs nothing and avoids this being the one place that disagrees.
    (acc: any) =>
      (acc?.platform === 'meta' || acc?.platform === 'facebook') &&
      acc?.config?.account_type === 'ad_account',
  );

  const unknownTypes = new Set<string>();
  const excludedObjectives = new Set<string>();
  const unknownObjectives = new Set<string>();

  for (const account of accounts) {
    const adAccountId = account?.account_id;
    const accessToken = account?.config?.access_token;
    // No token is not a monitoring finding — the account was never fully connected.
    // Calling Meta with `undefined` would return a token error and alert a human about a
    // connection that does not exist.
    if (!adAccountId || !accessToken) continue;

    summary.accountsChecked++;

    let activity: AdAccountActivity;
    try {
      activity = await fetchActivity(adAccountId, accessToken, MONITOR_WINDOW_DAYS);
    } catch (error: any) {
      summary.fetchErrors++;
      console.error(`${TAG} ${adAccountId}: activity fetch threw — ${error?.message}`);
      continue;
    }

    if (activity.status === 'token_error') {
      summary.tokenErrors++;
      await raise(
        alertTransport,
        `${TOKEN_ALERT_CLASS}:${adAccountId}`,
        now,
        `Meta ad account ${adAccountId} cannot be read — token invalid`,
        [
          `Meta rejected our stored credentials for ad account ${adAccountId}.`,
          '',
          'While this holds, the account is invisible to tracking monitoring: no spend,',
          'no conversions, and no way to tell a healthy account from a broken one. The',
          'owner has to re-authorise the Meta connection.',
          '',
          `Meta said: ${activity.error}`,
        ].join('\n'),
        {
          'Alert Class': TOKEN_ALERT_CLASS,
          'Alert Priority': 'high',
          'Ad Account': adAccountId,
          'Owner User Id': user?.userId,
          'Owner Email': user?.email,
        },
      );
      continue;
    }

    if (activity.status === 'fetch_error') {
      // Transient by definition — a rate limit or a network blip. Alerting here would
      // train people to ignore this channel before it ever caught a real blackout.
      summary.fetchErrors++;
      console.warn(`${TAG} ${adAccountId}: insights unavailable — ${activity.error}`);
      continue;
    }

    (activity.excludedObjectives || []).forEach((o) => excludedObjectives.add(o));
    (activity.unknownObjectives || []).forEach((o) => unknownObjectives.add(o));

    const verdict = evaluateAdAccountDays(activity.days);
    verdict.unrecognized.forEach((t) => unknownTypes.add(t));

    // An account whose spend was ENTIRELY excluded is worth saying out loud. It looks
    // identical to a dormant account in the summary, and someone checking why a visibly
    // spending customer never alerts needs to find the answer without reading this code.
    if (verdict.status === 'idle' && (activity.excludedObjectives || []).length > 0) {
      console.log(
        `${TAG} ${adAccountId}: spending, but only on non-converting objectives ` +
        `(${activity.excludedObjectives!.join(', ')}) — not judged for conversions`,
      );
    }

    if (verdict.status === 'idle') {
      summary.idle++;
      continue;
    }
    if (verdict.status === 'ok') {
      summary.healthy++;
      continue;
    }
    if (verdict.status === 'unclassifiable') {
      summary.unclassifiable++;
      console.warn(
        `${TAG} ${adAccountId}: ${verdict.consecutiveBlackoutDays} spending day(s) with no ` +
        `recognised conversion, but unknown action types were present — NOT alerting. ` +
        `Add these if they are conversions: ${verdict.unrecognized.join(', ')}`,
      );
      continue;
    }

    summary.blackouts++;

    // Enrichment is deliberately gathered HERE — only for an account that is actually
    // alerting — rather than for every account on every sweep. It costs a lead walk and
    // two Graph calls, which is trivial once a day for a handful of broken accounts and
    // wasteful across a healthy fleet. It is also best-effort: buildAlertContext swallows
    // its own failures, so a lookup problem drops a field and never the alert.
    const enriched = await buildAccountAlertContext(
      user, adAccountId, accessToken, activity.days, activity.excludedObjectives,
    );

    await raise(
      alertTransport,
      `${BLACKOUT_ALERT_CLASS}:${adAccountId}`,
      now,
      `Meta ad account ${adAccountId} spent with zero attributed conversions`,
      [
        `Ad account ${adAccountId} has spent for ${verdict.consecutiveBlackoutDays} consecutive`,
        `day(s) and Meta has attributed no conversions at all over that period.`,
        '',
        `Spend during the blackout: ${verdict.spendInBlackout.toFixed(2)}`,
        '',
        'This is either a genuinely non-converting campaign or a broken tracking path.',
        'It is worth telling apart quickly: the same pattern ran on a real account for 24',
        'consecutive days before anyone noticed, and the customer churned.',
      ].join('\n'),
      {
        'Alert Class': BLACKOUT_ALERT_CLASS,
        'Alert Priority': 'high',
        'Consecutive Days': verdict.consecutiveBlackoutDays,
        'Spend In Blackout': verdict.spendInBlackout.toFixed(2),
        // Identity, click-ID coverage, the account's pixels and Meta's match keys. The
        // first real alert of this kind took ~10 API calls to interpret; all of it was
        // available at the moment it fired.
        ...enriched,
      },
    );
  }

  summary.unrecognizedActionTypes = [...unknownTypes];
  summary.excludedObjectives = [...excludedObjectives];
  summary.unknownObjectives = [...unknownObjectives];
  return summary;
}

/** Best-effort enrichment for an alerting account. Isolated behind its own try/catch as
 *  well as the builder's, because nothing about a richer ticket is worth risking the
 *  ticket itself. */
async function buildAccountAlertContext(
  user: any,
  adAccountId: string,
  accessToken: string,
  days: AdAccountDay[],
  excludedObjectives?: string[],
): Promise<Record<string, any>> {
  try {
    const { buildAlertContextForAccount } = await import('./metaAlertContext');
    return await buildAlertContextForAccount(user, adAccountId, accessToken, days, excludedObjectives);
  } catch (error: any) {
    console.warn(`${TAG} alert enrichment failed for ${adAccountId}: ${error?.message}`);
    return { 'Ad Account': adAccountId, 'Owner User Id': user?.userId, 'Owner Email': user?.email };
  }
}

/** Send an alert unless one for this key already went out inside the window. A transport
 *  failure is logged and swallowed: a broken mail server must not stop the sweep from
 *  checking the remaining accounts. */
async function raise(
  transport: AlertTransport,
  dedupeKey: string,
  now: number,
  subject: string,
  message: string,
  context: Record<string, any>,
): Promise<void> {
  if (shouldSuppress(dedupeKey, now)) return;
  try {
    await transport(subject, message, context);
  } catch (error: any) {
    console.error(`${TAG} failed to send alert "${subject}": ${error?.message}`);
  }
}
