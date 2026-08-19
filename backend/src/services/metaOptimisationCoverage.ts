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

import { META_GRAPH_TIMEOUT_MS } from '../utils/metaApiFetch';


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

/**
 * The THIRD vocabulary. `promoted_object` says `COMPLETE_REGISTRATION`, the pixel reports
 * `CompleteRegistration`, and ad-account insights report `complete_registration`. All three
 * name one conversion and none of them match.
 *
 * Deliberately covers ONLY the families `countAttributedConversions` can count. An
 * optimisation with no countable family has no history to check, so it can never be
 * confirmed — and an unconfirmable finding must be logged, never alerted. Leaving the entry
 * out is what makes that happen structurally rather than by remembering to check.
 */
export const INSIGHTS_FAMILY_BY_OPTIMISATION: Readonly<Record<string, string>> = {
  LEAD: 'lead',
  COMPLETE_REGISTRATION: 'complete_registration',
  PURCHASE: 'purchase',
  SCHEDULE: 'schedule',
  SUBMIT_APPLICATION: 'submit_application',
  START_TRIAL: 'start_trial',
  SUBSCRIBE: 'subscribe',
  CONTACT: 'contact',
  INITIATED_CHECKOUT: 'initiate_checkout',
  ADD_TO_CART: 'add_to_cart',
  DONATE: 'donate',
  FIND_LOCATION: 'find_location',
};

/**
 * Optimisation types that are real, understood, and deliberately not judged.
 *
 * `OTHER` is Meta's marker for "a custom conversion", not an unknown event — Haven runs
 * several. Reporting it as unrecognised would put the same name in every sweep's output
 * forever, and a diagnostic that never changes is one people learn to skip past.
 */
export const IGNORED_OPTIMISATIONS = new Set(['OTHER']);

/**
 * What a promoted object is actually optimising for, resolved ONCE for every caller.
 *
 * There are three call sites and they used to each re-read `custom_event_type` and re-apply
 * their own rules, which is how they drifted apart: one applied IGNORED_OPTIMISATIONS and the
 * other did not. Fixing one member of a group and not its neighbours is the defect §48 records
 * four times, so the rule lives in one place and the callers ask.
 *
 * The case that matters: `custom_event_type: 'OTHER'` means "a custom conversion", NOT an
 * unknown event, and Meta hands us its name in `custom_event_str` in the SAME object we
 * already fetch. Dropping those cost real coverage — measured 2026-08-18, Tier 1 could judge
 * only 5 of the 13 delivering conversion-optimised ad sets fleet-wide, and all 8 it could not
 * see belonged to the single biggest-spending account.
 */
export type OptimisationEventResolution =
  | { kind: 'none' }
  | { kind: 'ignored'; key: string }
  | { kind: 'unrecognised'; key: string }
  | { kind: 'resolved'; key: string; expectedEventName: string; custom: boolean };

export function resolveOptimisationEvent(
  promoted: OptimisationAdSet['promoted_object'],
): OptimisationEventResolution {
  const raw = promoted?.custom_event_type;
  // Reach, traffic and engagement goals promote nothing — there is no event to compare.
  if (typeof raw !== 'string' || !raw.trim()) return { kind: 'none' };

  const key = raw.trim().toUpperCase();

  if (key === 'OTHER') {
    const custom = promoted?.custom_event_str;
    if (typeof custom === 'string' && custom.trim()) {
      // A custom conversion's pixel event name IS the string itself — no translation, unlike
      // the standard taxonomy where `COMPLETE_REGISTRATION` reports as `CompleteRegistration`.
      const name = custom.trim();
      return { kind: 'resolved', key: name, expectedEventName: name, custom: true };
    }
    // OTHER with no name attached. Ignored rather than reported unrecognised: it is a real,
    // valid configuration, and surfacing it would print the same word in every sweep forever.
    return { kind: 'ignored', key };
  }

  if (IGNORED_OPTIMISATIONS.has(key)) return { kind: 'ignored', key };

  const expected = META_EVENT_BY_OPTIMISATION[key];
  // Meta adds optimisation types over time. An untranslatable one is REPORTED, never asserted
  // as a mismatch — claiming a pixel is missing an event we cannot name is the confidently
  // wrong diagnosis §F's alert-enrichment rounds were spent removing.
  if (!expected) return { kind: 'unrecognised', key };

  return { kind: 'resolved', key, expectedEventName: expected, custom: false };
}

/**
 * Did this pixel report this event?
 *
 * Percent-decoded as well as compared raw, because `/stats` returns BOTH forms for a custom
 * event whose name contains spaces or symbols — one production pixel reports
 * `Hubspot Form Completed $25k+` and `Hubspot%20Form%20Completed%20%2425k%2B` side by side.
 *
 * Deliberately CASE-SENSITIVE. `Lead` and `lead` are different events and one production pixel
 * receives both; folding them would let a healthy event vouch for a dead one.
 */
export function pixelReceivedEvent(received: Set<string>, expected: string): boolean {
  if (received.has(expected)) return true;
  for (const got of received) {
    if (got === expected) return true;
    try {
      if (decodeURIComponent(got) === expected) return true;
    } catch {
      // A malformed percent sequence is not a match; it is also not an error worth throwing.
    }
  }
  return false;
}

/**
 * Consecutive SPENDING days with no attributed conversion of the family before a pixel
 * silence is treated as real. Same number and same reasoning as
 * `BLACKOUT_CONSECUTIVE_DAYS`, and it is not arbitrary: Haven's own healthy baseline
 * (2026-08-01..05) contained a single zero day, while the outage produced runs of five and
 * three. Two would have fired on the healthy baseline.
 */
export const OPTIMISATION_ABSENCE_DAYS = 3;

/**
 * Most recent days excluded from the evidence, because their conversions may not have
 * finished being attributed.
 *
 * Meta attributes a conversion back to the ad interaction, and that assignment keeps
 * arriving for a while after the day itself. So the newest row systematically UNDER-reports
 * conversions, and an absence there is not yet evidence of anything. Counting it inflates
 * every streak by one and lets the threshold be reached a day early — a false alert of
 * exactly the kind this check is built to avoid.
 *
 * Cost: one day of detection latency. Haven's outage would still have been caught on day 4
 * instead of day 3, against the 8 days it actually took a human.
 */
export const ATTRIBUTION_SETTLE_DAYS = 1;

/**
 * How stale the newest spending day may be before an ad set stops counting as "currently
 * paying".
 *
 * An ad set can hold a full absence streak and then stop delivering. `effective_status`
 * still says ACTIVE, because that is a configuration rather than a statement about spend.
 * Alerting on it produces a high-priority message whose first sentence — that the ad set is
 * PAYING for an event it is not receiving — is false at the moment someone reads it.
 *
 * The money that was wasted during the streak is real and stays reported, but as a log
 * line rather than a page: nobody can act on spend that already stopped, and alerting on
 * unactionable things is precisely how this channel would lose its credibility.
 */
export const OPTIMISATION_RECENCY_DAYS = 2;

/** Whole days from `from` to `to`, both `YYYY-MM-DD`. Null if either is unparseable, so a
 *  malformed date can never silently read as "recent". */
function daysBetween(from: string, to: string): number | null {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86_400_000);
}

/** The most recent day the ad set actually spent, or undefined if it never did. */
/**
 * §G day-1 detection — how much account history must exist before ABSENCE means anything.
 *
 * Resuming a known-broken ad set costs ~4 days of spend before the ordinary streak reaches
 * OPTIMISATION_ABSENCE_DAYS, because the streak needs spending days the ad set has not had
 * yet. This floor closes that gap without storing anything.
 *
 * The reasoning INVERTS this module's own first P1. Account-wide PRESENCE is worthless as
 * evidence — a busy sibling pixel's conversions land in the account's family list and vouch
 * for a dead pixel. Account-wide ABSENCE cannot be masked that way: if a family produced
 * ZERO conversions across the entire account while it was spending, then no pixel produced
 * it, and a brand-new ad set optimising for it is bidding at something that does not arrive.
 *
 * The floor exists because "the account never produced it" is only meaningful once the
 * account has had a real chance to. Without it, every genuinely new account would alert on
 * its first days for not having converted YET — the noise failure §F paid for twice.
 */
export const DAY1_MIN_ACCOUNT_SPENDING_DAYS = 7;

/** Spending days in a window. Zero-spend days are not opportunity, so they do not count. */
export function countSpendingDays(days: OptimisationSpendingDay[] | null | undefined): number {
  return (Array.isArray(days) ? days : []).filter((d) => Number(d?.spend) > 0).length;
}

/**
 * Did this family EVER arrive across the window, on any day, at any spend?
 *
 * Deliberately not restricted to spending days: a conversion on a zero-spend day still
 * proves the event can arrive, and this function's only job is to find an exculpating fact.
 */
export function familyEverPresent(
  days: OptimisationSpendingDay[] | null | undefined,
  family: string,
): boolean {
  return (Array.isArray(days) ? days : []).some((d) =>
    (Array.isArray(d?.families) ? d.families : []).some(
      (f) => typeof f === 'string' && f.trim().toLowerCase() === family,
    ),
  );
}

export function newestSpendingDay(
  days: OptimisationSpendingDay[] | null | undefined,
): string | undefined {
  const spending = (Array.isArray(days) ? days : [])
    .filter((d) => d && Number(d.spend) > 0 && typeof d.date === 'string')
    .map((d) => d.date)
    .sort();
  return spending[spending.length - 1];
}

/** Only a delivering ad set can waste money. A paused one is a latent risk, reported separately. */
const DELIVERING_STATUSES = new Set(['ACTIVE']);

export interface OptimisationAdSet {
  id?: string;
  name?: string;
  effective_status?: string;
  optimization_goal?: string;
  promoted_object?: {
    custom_event_type?: string;
    pixel_id?: string;
    /** Present when `custom_event_type` is OTHER: the custom conversion's own event
     *  name, reported by the pixel verbatim. Meta returns it in the same object. */
    custom_event_str?: string;
    custom_conversion_id?: string;
  } | null;
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
    const resolved = resolveOptimisationEvent(row?.promoted_object);
    if (resolved.kind === 'none' || resolved.kind === 'ignored') continue;

    const delivering = DELIVERING_STATUSES.has(String(row?.effective_status ?? '').toUpperCase());

    if (resolved.kind === 'unrecognised') {
      if (delivering) unrecognised.add(resolved.key);
      continue;
    }

    if (pixelReceivedEvent(received, resolved.expectedEventName)) continue;

    const hit: OptimisationMismatch = {
      adSetId: row?.id,
      adSetName: row?.name,
      optimisationEvent: resolved.key,
      expectedEventName: resolved.expectedEventName,
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

/** One day of ad-account activity, with the conversion families that actually arrived.
 *  `families` is the set §F's `countAttributedConversions` recognised that day. */
export interface OptimisationSpendingDay {
  date: string;
  spend: number;
  families: string[];
}

/**
 * Consecutive SPENDING days, counted back from the most recent, on which `family` was
 * absent.
 *
 * Three rules, all inherited from `evaluateAdAccountDays` because they were paid for once
 * already and the failure modes are identical:
 *
 *  - Zero-spend days are NOT evidence. Nothing was delivered, so an absent conversion says
 *    nothing about tracking. Counting them would alert on every dormant account.
 *  - Zero-spend days do NOT break the streak. An outage spanning a weekend pause is one
 *    outage, and letting the pause reset the counter hides exactly the long failures this
 *    exists to find.
 *  - Measured from the most recent day BACKWARDS. An earlier gap may already be fixed;
 *    re-alerting on history every day forever is how a channel becomes noise.
 */
export function countTrailingAbsentSpendingDays(
  days: OptimisationSpendingDay[] | null | undefined,
  family: string,
  ignoreMostRecent = 0,
): number {
  // Sorted defensively rather than trusting the caller: "counted back from the most recent"
  // is meaningless on an unordered array, and the failure would be silent — a plausible
  // number computed from the wrong end of the window.
  const rows = (Array.isArray(days) ? days : [])
    .filter(Boolean)
    .slice()
    .sort((a, b) => String(a?.date ?? '').localeCompare(String(b?.date ?? '')));
  const judged = ignoreMostRecent > 0 ? rows.slice(0, -ignoreMostRecent) : rows;
  let streak = 0;
  for (let i = judged.length - 1; i >= 0; i--) {
    const row = judged[i];
    if (!(Number(row?.spend) > 0)) continue; // no delivery — neither evidence nor a reset
    const present = (Array.isArray(row?.families) ? row.families : []).some(
      (f) => typeof f === 'string' && f.trim().toLowerCase() === family,
    );
    if (present) break;
    streak++;
  }
  return streak;
}

/** A mismatch the spending history CONFIRMS: the money-losing case, and the only one that alerts. */
export interface ConfirmedOptimisationMismatch extends OptimisationMismatch {
  insightsFamily: string;
  consecutiveAbsentSpendingDays: number;
  /** Raised by day-1 detection rather than by a completed absence streak. Set so an alert
   *  can say WHY it fired on so little of the ad set's own history. */
  day1?: true;
}

export type AccountOptimisationVerdict = {
  /** ACTIVE, pixel silent, AND a confirmed streak of spending days with no such conversion. */
  alerting: ConfirmedOptimisationMismatch[];
  /** ACTIVE and pixel silent, but the account's own conversion history contradicts it.
   *  Log only — this is the low-volume case, where a 24h pixel window simply missed. */
  unconfirmed: OptimisationMismatch[];
  /** ACTIVE and pixel silent, but no evidence is obtainable: no pixel on the promoted
   *  object, or an optimisation §F cannot count. Never alerted, always visible. */
  unconfirmable: OptimisationMismatch[];
  /** Paused/not delivering. Costs nothing today; one click from costing money. Log only. */
  dormant: OptimisationMismatch[];
  /**
   * Held a full absence streak, but stopped delivering more than OPTIMISATION_RECENCY_DAYS
   * ago. The waste already happened and is worth seeing; it is not worth paging about,
   * because there is no spend left to stop.
   */
  staleDelivery: ConfirmedOptimisationMismatch[];
  /** Delivering ad sets whose optimisation event could not be translated at all. */
  unrecognisedOptimisations: string[];
  /** Pixels that reported no events, so nothing can be concluded about them either way. */
  inconclusivePixels: string[];
};

/**
 * Account-level §G Tier 1: does anything we are PAYING to optimise for look like it stopped
 * arriving, on the evidence of both the pixel and the account's own conversion history?
 *
 * ── Why two signals, and why THIS way round ──────────────────────────────────────────
 *
 * The pixel read (`/stats?aggregation=event`) is precise but serves ~24 HOURS and cannot be
 * widened — `limit` is capped server-side and `paging.next` returns nothing. Verified on
 * three production pixels, 2026-08-17. On Haven, the very event this check exists for
 * arrived in ONE of 23 hourly buckets, so a 24h window is a coin flip on a once-daily
 * conversion. Triggering on it alone would have alerted on a pixel that was working.
 *
 * Insights carry real history — an explicit `time_range` returns per-day, per-family counts
 * in a single call — but they include conversions the browser pixel never saw, so they
 * cannot localise a fault to the pixel.
 *
 * So: insights supply the EVIDENCE (a streak), the pixel supplies the SPECIFICITY (it is
 * silent right now), and only their agreement alerts. Everything else is logged.
 *
 * Notably, the streak needs no stored history and therefore no new table — §39 assumed it
 * would, which is what had this behind the data-plane gate.
 *
 * ── Every scope is the AD SET's own, never the account's ─────────────────────────────
 *
 * Both halves of the evidence are scoped to the thing the claim is about, and neither was
 * in the first version of this code:
 *
 *   - Pixel events per PIXEL. Haven runs THREE. A conversion arriving on one says nothing
 *     about another, so a unioned event set lets a busy pixel vouch for a dead one.
 *   - Spend and conversion families per AD SET. Account-wide figures break BOTH directions.
 *     A healthy sibling pixel's conversions land in the account's family list and silently
 *     break a dead pixel's absence streak, hiding the outage this check exists to find.
 *     And an ACTIVE ad set that is not delivering inherits the account's spend, producing a
 *     high-priority alert that says it is paying for an event when it is spending nothing.
 *
 * An ad set with NO insight rows did not deliver, so there is nothing to conclude about it:
 * ACTIVE status is a configuration, not evidence of spend.
 */
export function evaluateAccountOptimisationCoverage(
  adSets: OptimisationAdSet[] | null | undefined,
  receivedEventsByPixel: Record<string, Iterable<string>> | null | undefined,
  spendingDaysByAdSet: Record<string, OptimisationSpendingDay[]> | null | undefined,
  asOf?: string,
  /** The ACCOUNT's own per-day history, used only by day-1 detection. Omitted by existing
   *  callers, which keeps their behaviour byte-identical. */
  accountSpendingDays?: OptimisationSpendingDay[] | null,
): AccountOptimisationVerdict {
  const verdict: AccountOptimisationVerdict = {
    alerting: [], unconfirmed: [], unconfirmable: [], dormant: [], staleDelivery: [],
    unrecognisedOptimisations: [], inconclusivePixels: [],
  };

  const rows = (Array.isArray(adSets) ? adSets : []).filter(Boolean);
  const byPixel = receivedEventsByPixel && typeof receivedEventsByPixel === 'object' ? receivedEventsByPixel : {};
  const byAdSet =
    spendingDaysByAdSet && typeof spendingDaysByAdSet === 'object' ? spendingDaysByAdSet : {};
  const unrecognised = new Set<string>();
  const inconclusive = new Set<string>();
  const eventCache = new Map<string, Set<string>>();

  const eventsFor = (pixelId: string): Set<string> => {
    let set = eventCache.get(pixelId);
    if (!set) {
      set = new Set(
        [...(byPixel[pixelId] ?? [])]
          .filter((e): e is string => typeof e === 'string' && !!e.trim())
          .map((e) => e.trim()),
      );
      eventCache.set(pixelId, set);
    }
    return set;
  };

  for (const row of rows) {
    const resolved = resolveOptimisationEvent(row?.promoted_object);
    if (resolved.kind === 'none' || resolved.kind === 'ignored') continue;

    const delivering = DELIVERING_STATUSES.has(String(row?.effective_status ?? '').toUpperCase());

    if (resolved.kind === 'unrecognised') {
      if (delivering) unrecognised.add(resolved.key);
      continue;
    }

    const key = resolved.key;
    const expected = resolved.expectedEventName;

    const hit: OptimisationMismatch = {
      adSetId: row?.id,
      adSetName: row?.name,
      optimisationEvent: key,
      expectedEventName: expected,
      pixelId: row?.promoted_object?.pixel_id,
    };

    // No pixel on the promoted object — nothing to ask, so nothing to claim.
    const pixelId = row?.promoted_object?.pixel_id;
    if (typeof pixelId !== 'string' || !pixelId.trim()) {
      verdict.unconfirmable.push(hit);
      continue;
    }

    // A pixel that reported nothing cannot testify about what it is missing. Treating that
    // as "nothing arrives" would manufacture a mismatch for every ad set behind it.
    const received = eventsFor(pixelId);
    if (received.size === 0) {
      inconclusive.add(pixelId);
      continue;
    }

    // pixelReceivedEvent, NOT received.has: /stats returns a custom event under BOTH its
    // decoded and percent-encoded names, and a raw Set lookup sees only one of them. This
    // evaluator was left on the raw check when the helper was introduced for its sibling —
    // the same fix-one-of-a-pair defect §48 records, in the commit that cited §48.
    if (pixelReceivedEvent(received, expected)) continue; // arriving — no claim to make

    // Paused: real, but costs nothing until someone resumes it. Never alerted, by decision.
    if (!delivering) {
      verdict.dormant.push(hit);
      continue;
    }

    const family = INSIGHTS_FAMILY_BY_OPTIMISATION[key];
    if (!family) {
      verdict.unconfirmable.push(hit);
      continue;
    }

    // This ad set's OWN spend and conversions. An ad set Meta reported no rows for did not
    // deliver, so `countTrailingAbsentSpendingDays` returns 0 and it cannot alert — which is
    // the correct outcome: no delivery means no money at risk and nothing to diagnose.
    const ownDays = Array.isArray(byAdSet[String(row?.id ?? '')]) ? byAdSet[String(row?.id ?? '')] : [];
    const absent = countTrailingAbsentSpendingDays(ownDays, family, ATTRIBUTION_SETTLE_DAYS);
    if (absent >= OPTIMISATION_ABSENCE_DAYS) {
      const confirmed = { ...hit, insightsFamily: family, consecutiveAbsentSpendingDays: absent };
      // ACTIVE describes configuration, not spend. Only an ad set that was still delivering
      // recently can be described as paying for anything right now.
      const lastSpend = asOf ? newestSpendingDay(ownDays) : undefined;
      const staleBy = asOf && lastSpend ? daysBetween(lastSpend, asOf) : null;
      if (staleBy !== null && staleBy > OPTIMISATION_RECENCY_DAYS) {
        verdict.staleDelivery.push(confirmed);
      } else {
        verdict.alerting.push(confirmed);
      }
    } else if (
      // ── day-1 detection ───────────────────────────────────────────────────────────
      // Every condition is a way for the claim to be WRONG, so all must fail to hold.
      delivering &&
      // The ad set delivered at all — ACTIVE is configuration, not spend.
      countSpendingDays(ownDays) >= 1 &&
      // ...but has too little history of its own for the ordinary streak to have run.
      absent < OPTIMISATION_ABSENCE_DAYS &&
      // The account had a real chance to produce this family, and never did. PRESENCE would
      // be exculpatory here; only total absence supports the claim.
      countSpendingDays(accountSpendingDays) >= DAY1_MIN_ACCOUNT_SPENDING_DAYS &&
      !familyEverPresent(accountSpendingDays, family) &&
      // The pixel is demonstrably ALIVE. Without traffic of its own, its silence about this
      // event is "could not ask", never "did not arrive".
      pixelReceivedEvent(received, 'PageView')
    ) {
      verdict.alerting.push({
        ...hit,
        insightsFamily: family,
        consecutiveAbsentSpendingDays: absent,
        day1: true,
      });
    } else {
      // Either this ad set converted the family recently — so the pixel's 24h silence is far
      // more likely to be a low-volume window than a fault — or it did not deliver at all.
      // Both are reasons to log rather than alert.
      verdict.unconfirmed.push(hit);
    }
  }

  verdict.unrecognisedOptimisations = [...unrecognised].sort();
  verdict.inconclusivePixels = [...inconclusive].sort();
  return verdict;
}

/** Bound on ad-set pages followed per account. Haven, the largest real account seen, has 43
 *  ad sets in one page at limit=200; the cap only exists so a pathological cursor cannot loop. */
const MAX_ADSET_PAGES = 10;

/** Pixels diagnosed per account. Haven runs three. The cap keeps a misconfigured account
 *  from turning one daily sweep into dozens of Graph calls. */
export const MAX_PIXELS_CHECKED = 8;

export interface OptimisationFetchDeps {
  fetchImpl: typeof fetch;
}

export type OptimisationInputs = {
  status: 'ok' | 'fetch_error';
  adSets: OptimisationAdSet[];
  /** Event names per pixel. A pixel whose read FAILED is deliberately absent rather than
   *  empty-but-present: both read as "cannot tell" downstream, and neither may be read as
   *  "nothing arrives". */
  receivedEventsByPixel: Record<string, string[]>;
  error?: string;
  /** Pixels referenced by ad sets but not read, because the cap was hit. Surfaced so a
   *  silently reduced check cannot pass for a complete one. */
  pixelsNotChecked?: string[];
  /**
   * Per-AD-SET daily spend and conversion families.
   *
   * Read at `level=adset` rather than account, because account totals cannot answer an
   * ad-set question in either direction: a sibling pixel's conversions would break a dead
   * pixel's absence streak, and account spend would make a non-delivering ACTIVE ad set
   * look like it was paying for something.
   *
   * An ad set absent from this map produced no rows, which means it did not deliver.
   */
  spendingDaysByAdSet: Record<string, OptimisationSpendingDay[]>;
};

/**
 * The two Meta reads §G Tier 1 needs: what every ad set is bidding on, and what each
 * referenced pixel is actually receiving.
 *
 * A failure to read ONE pixel is not a failure of the sweep — that pixel is simply omitted
 * and its ad sets come back inconclusive. Only losing the ad-set list makes the whole check
 * impossible, because then there is no claim to test.
 */
export async function fetchOptimisationInputs(
  adAccountId: string,
  accessToken: string,
  deps?: OptimisationFetchDeps,
): Promise<OptimisationInputs> {
  const fetchImpl = deps?.fetchImpl ?? fetch;
  const apiVersion = process.env.META_API_VERSION || 'v25.0';
  const params = new URLSearchParams({
    // `custom_event_str` is the load-bearing addition: without it Meta returns
    // `custom_event_type: 'OTHER'` with no name, every custom-conversion ad set is
    // unjudgeable, and the check goes quiet on most of what is actually delivering.
    fields:
      'id,name,effective_status,' +
      'promoted_object{custom_event_type,custom_event_str,custom_conversion_id,pixel_id}',
    limit: '200',
  });

  const adSets: OptimisationAdSet[] = [];
  let url: string =
    `https://graph.facebook.com/${apiVersion}/act_${adAccountId}/adsets?${params}` +
    `&access_token=${encodeURIComponent(accessToken)}`;

  try {
    for (let page = 0; page < MAX_ADSET_PAGES && url; page++) {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(META_GRAPH_TIMEOUT_MS) });
      const body: any = await response.json();
      if (!response.ok || body?.error) {
        return {
          status: 'fetch_error',
          adSets: [],
          receivedEventsByPixel: {},
          spendingDaysByAdSet: {},
          error: body?.error?.message || `HTTP ${response.status}`,
        };
      }
      for (const row of Array.isArray(body?.data) ? body.data : []) adSets.push(row);
      url = typeof body?.paging?.next === 'string' ? body.paging.next : '';
    }
  } catch (error: any) {
    return {
      status: 'fetch_error', adSets: [], receivedEventsByPixel: {}, spendingDaysByAdSet: {},
      error: error?.message || 'request failed',
    };
  }

  // Only pixels an ad set actually promotes an event to are worth a call. A pixel nobody
  // optimises toward cannot produce a Tier 1 finding.
  const referenced: string[] = [];
  for (const row of adSets) {
    const pixelId = row?.promoted_object?.pixel_id;
    // Resolved rather than merely present, so a pixel referenced ONLY by ad sets we cannot
    // judge does not cost a Graph call — and, more importantly, so a pixel referenced only by
    // custom-conversion ad sets DOES get one. Before this it was skipped entirely.
    const resolved = resolveOptimisationEvent(row?.promoted_object);
    if (typeof pixelId === 'string' && pixelId.trim() && resolved.kind === 'resolved') {
      if (!referenced.includes(pixelId)) referenced.push(pixelId);
    }
  }

  const checked = referenced.slice(0, MAX_PIXELS_CHECKED);
  const receivedEventsByPixel: Record<string, string[]> = {};

  for (const pixelId of checked) {
    try {
      // `/stats` serves ~24 HOURS and cannot be widened: `limit` is capped server-side and
      // `paging.next` returns nothing. Verified on three production pixels 2026-08-17.
      // This is why it corroborates rather than triggers — see evaluateAccountOptimisationCoverage.
      const statsUrl =
        `https://graph.facebook.com/${apiVersion}/${encodeURIComponent(pixelId)}/stats` +
        `?aggregation=event&access_token=${encodeURIComponent(accessToken)}`;
      const response = await fetchImpl(statsUrl, { signal: AbortSignal.timeout(META_GRAPH_TIMEOUT_MS) });
      const body: any = await response.json();
      if (!response.ok || body?.error) continue; // omitted → inconclusive, never "nothing arrives"

      const events = new Set<string>();
      for (const bucket of Array.isArray(body?.data) ? body.data : []) {
        for (const entry of Array.isArray(bucket?.data) ? bucket.data : []) {
          const name = entry?.value;
          if (typeof name === 'string' && name.trim()) events.add(name.trim());
        }
      }
      if (events.size > 0) receivedEventsByPixel[pixelId] = [...events];
    } catch {
      // Same rule: a pixel we could not read is a pixel we cannot testify about.
    }
  }

  return {
    status: 'ok',
    adSets,
    receivedEventsByPixel,
    pixelsNotChecked: referenced.slice(MAX_PIXELS_CHECKED),
    spendingDaysByAdSet: await fetchAdSetSpendingDays(adAccountId, accessToken, fetchImpl, apiVersion),
  };
}

/**
 * Per-ad-set daily spend and conversion families for the monitor window.
 *
 * `level=adset` with `time_increment=1` and an explicit `actions` field are all three
 * required. Reading this at account level is what produced both P1s on the first version of
 * this check: the evidence has to belong to the ad set the alert names.
 *
 * A failure here returns an empty map rather than throwing. Every ad set then has no
 * delivery evidence and none can alert — the safe direction, since this gate only ever
 * removes alerts.
 */
async function fetchAdSetSpendingDays(
  adAccountId: string,
  accessToken: string,
  fetchImpl: typeof fetch,
  apiVersion: string,
): Promise<Record<string, OptimisationSpendingDay[]>> {
  const { countAttributedConversions } = await import('./metaTrackingMonitor');
  const params = new URLSearchParams({
    fields: 'spend,actions,date_start,adset_id',
    level: 'adset',
    time_increment: '1',
    date_preset: 'last_7d',
  });

  const byAdSet: Record<string, Record<string, OptimisationSpendingDay>> = {};
  let url: string =
    `https://graph.facebook.com/${apiVersion}/act_${adAccountId}/insights?${params}` +
    `&access_token=${encodeURIComponent(accessToken)}`;

  try {
    // Ad-set level multiplies rows by the ad-set count, so a real account pages. Reading
    // only the first page would silently drop delivery evidence and turn real alerts into
    // silence — the same pagination trap #2420 hit moving account level to campaign.
    for (let page = 0; page < MAX_INSIGHT_PAGES && url; page++) {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(META_GRAPH_TIMEOUT_MS) });
      const body: any = await response.json();
      if (!response.ok || body?.error) return {};

      for (const row of Array.isArray(body?.data) ? body.data : []) {
        const adSetId = typeof row?.adset_id === 'string' ? row.adset_id : '';
        const date = typeof row?.date_start === 'string' ? row.date_start : '';
        if (!adSetId || !date) continue;

        byAdSet[adSetId] = byAdSet[adSetId] || {};
        const day = byAdSet[adSetId][date] || { date, spend: 0, families: [] as string[] };
        byAdSet[adSetId][date] = day;
        day.spend += Number.parseFloat(row?.spend ?? '0') || 0;
        for (const f of countAttributedConversions(row?.actions).families) {
          if (!day.families.includes(f)) day.families.push(f);
        }
      }
      url = typeof body?.paging?.next === 'string' ? body.paging.next : '';
    }
  } catch {
    return {};
  }

  const out: Record<string, OptimisationSpendingDay[]> = {};
  for (const [adSetId, days] of Object.entries(byAdSet)) {
    out[adSetId] = Object.values(days).sort((a, b) => a.date.localeCompare(b.date));
  }
  return out;
}

/** Bound on insight pages followed per account, mirroring the blackout fetch's own cap. */
const MAX_INSIGHT_PAGES = 20;
