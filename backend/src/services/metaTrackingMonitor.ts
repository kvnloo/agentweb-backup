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
  const params = new URLSearchParams({
    fields: 'spend,actions,date_start',
    level: 'account',
    time_increment: '1',
    date_preset: dayWindowToPreset(days),
  });
  // The token goes in a header-shaped query param only at call time and is never part of
  // the string retained for logging: this URL reaches error logs on failure, and a
  // credential in a log is a leak that outlives the incident.
  const url = `https://graph.facebook.com/${apiVersion}/act_${adAccountId}/insights?${params}`;

  try {
    const response = await fetchImpl(`${url}&access_token=${encodeURIComponent(accessToken)}`);
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

    const rows: any[] = Array.isArray(body?.data) ? body.data : [];
    return {
      status: 'ok',
      days: rows.map((row) => {
        const counted = countAttributedConversions(row?.actions);
        return {
          date: String(row?.date_start ?? ''),
          spend: Number.parseFloat(row?.spend ?? '0') || 0,
          conversions: counted.conversions,
          unrecognized: counted.unrecognized,
        };
      }),
    };
  } catch (error: any) {
    // A network failure must never abort the sweep — the next account still needs checking.
    return { status: 'fetch_error', days: [], error: error?.message || 'request failed' };
  }
}

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
