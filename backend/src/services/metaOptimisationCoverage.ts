/**
 * ENG-926 §G (Tier 1) — is an ad set bidding toward an event the pixel never receives?
 *
 * THE INCIDENT THIS EXISTS FOR. Haven's `CompleteRegistration` went dark on 2026-08-05 when a
 * deprecated tracking wrapper was removed: the wrapper had been firing it through its own
 * auto-tracking, with no code for it anywhere in the repo, so nothing errored and no test
 * failed. Both live ad sets kept optimising for `COMPLETE_REGISTRATION` and spent 8+ days
 * bidding toward an event that no longer arrived. It was found by a human, 8 days later.
 *
 * NOTHING we had would have caught it, and this was verified rather than assumed:
 *   - §F's blackout cron streaks only days where conversions === 0. Haven's `Lead` kept
 *     flowing, so conversions were never zero and the streak never started. §F is silent
 *     on this failure forever — not a defect, it answers a different question.
 *   - §F's divergence check compares CRM vs Meta TOTALS, not per-event.
 *   - Meta's own `da_checks` diagnostics flagged nothing, even weeks later.
 *
 * This asks the one question with money attached: **are we paying to optimise toward an
 * event that is not arriving?** Two Meta reads, no storage, no new table — deliberately
 * cheap enough to run in §F's existing daily sweep.
 *
 * It does NOT detect an event that went dark with nobody optimising for it. That is
 * measurement loss rather than misdirected spend, needs a day-over-day baseline, and is
 * Tier 2 (see §39). Do not let this module's existence imply that coverage.
 */

/**
 * Meta's `promoted_object.custom_event_type` values mapped to the standard event NAME the
 * pixel actually reports. The two vocabularies differ (`COMPLETE_REGISTRATION` vs
 * `CompleteRegistration`) and comparing them without translating is the obvious way to get
 * a wrong answer in either direction.
 */
export const META_EVENT_BY_OPTIMISATION: Readonly<Record<string, string>> = {
  LEAD: 'Lead',
  COMPLETE_REGISTRATION: 'CompleteRegistration',
  PURCHASE: 'Purchase',
  ADD_TO_CART: 'AddToCart',
  START_TRIAL: 'StartTrial',
  SUBSCRIBE: 'Subscribe',
  INITIATED_CHECKOUT: 'InitiateCheckout',
  CONTENT_VIEW: 'ViewContent',
  SEARCH: 'Search',
  ADD_PAYMENT_INFO: 'AddPaymentInfo',
  ADD_TO_WISHLIST: 'AddToWishlist',
  DONATE: 'Donate',
  SCHEDULE: 'Schedule',
  SUBMIT_APPLICATION: 'SubmitApplication',
  CONTACT: 'Contact',
  CUSTOMIZE_PRODUCT: 'CustomizeProduct',
  FIND_LOCATION: 'FindLocation',
};

/** Only a delivering ad set can waste money. A paused one is a latent risk, reported separately. */
const DELIVERING_STATUSES = new Set(['ACTIVE']);

export interface OptimisationAdSet {
  id?: string;
  name?: string;
  effective_status?: string;
  optimization_goal?: string;
  promoted_object?: { custom_event_type?: string; pixel_id?: string } | null;
}

export interface OptimisationMismatch {
  adSetId?: string;
  adSetName?: string;
  optimisationEvent: string;
  expectedEventName: string;
  pixelId?: string;
}

export type OptimisationCoverageVerdict = {
  /** Delivering ad sets bidding toward an event the pixel is not receiving. Money at risk. */
  mismatches: OptimisationMismatch[];
  /** Same condition, but the ad set is paused. Latent — costs nothing until someone resumes it. */
  dormantMismatches: OptimisationMismatch[];
  /** Delivering ad sets whose optimisation event we could not translate. Never claimed as a mismatch. */
  unrecognisedOptimisations: string[];
  /**
   * True when no verdict is possible: the pixel reported no events at all, so "not received"
   * cannot be distinguished from "we could not see". A dormant pixel must never manufacture
   * a fleet of mismatches — the §F objective-filter lesson, applied to a different signal.
   */
  inconclusive: boolean;
};

/**
 * Compare what the ad sets are bidding on against what the pixel actually receives.
 *
 * `receivedEvents` is the set of event NAMES seen on the pixel (from `/stats?aggregation=event`).
 * An EMPTY set is treated as "cannot tell", never as "nothing arrives" — those are different
 * claims and only one of them is safe to alert on.
 */
export function evaluateOptimisationCoverage(
  adSets: OptimisationAdSet[] | null | undefined,
  receivedEvents: Iterable<string> | null | undefined,
): OptimisationCoverageVerdict {
  const received = new Set(
    [...(receivedEvents ?? [])].filter((e): e is string => typeof e === 'string' && !!e.trim()).map((e) => e.trim()),
  );

  const empty: OptimisationCoverageVerdict = {
    mismatches: [], dormantMismatches: [], unrecognisedOptimisations: [], inconclusive: false,
  };

  const rows = (Array.isArray(adSets) ? adSets : []).filter(Boolean);
  if (rows.length === 0) return empty;

  // A pixel that reported nothing cannot testify about what it is missing.
  if (received.size === 0) return { ...empty, inconclusive: true };

  const mismatches: OptimisationMismatch[] = [];
  const dormant: OptimisationMismatch[] = [];
  const unrecognised = new Set<string>();

  for (const row of rows) {
    const raw = row?.promoted_object?.custom_event_type;
    // No promoted event at all (reach, traffic, engagement goals) — nothing to compare.
    if (typeof raw !== 'string' || !raw.trim()) continue;

    const key = raw.trim().toUpperCase();
    const expected = META_EVENT_BY_OPTIMISATION[key];
    const delivering = DELIVERING_STATUSES.has(String(row?.effective_status ?? '').toUpperCase());

    if (!expected) {
      // Meta adds optimisation types over time. An untranslatable one is reported, never
      // asserted as a mismatch — claiming a pixel is missing an event we cannot name is
      // exactly the confidently-wrong diagnosis §F's alert-enrichment rounds warned about.
      if (delivering) unrecognised.add(key);
      continue;
    }

    if (received.has(expected)) continue;

    const hit: OptimisationMismatch = {
      adSetId: row?.id,
      adSetName: row?.name,
      optimisationEvent: key,
      expectedEventName: expected,
      pixelId: row?.promoted_object?.pixel_id,
    };
    (delivering ? mismatches : dormant).push(hit);
  }

  return {
    mismatches,
    dormantMismatches: dormant,
    unrecognisedOptimisations: [...unrecognised].sort(),
    inconclusive: false,
  };
}
