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
