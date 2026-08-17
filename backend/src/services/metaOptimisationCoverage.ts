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
 * Consecutive SPENDING days with no attributed conversion of the family before a pixel
 * silence is treated as real. Same number and same reasoning as
 * `BLACKOUT_CONSECUTIVE_DAYS`, and it is not arbitrary: Haven's own healthy baseline
 * (2026-08-01..05) contained a single zero day, while the outage produced runs of five and
 * three. Two would have fired on the healthy baseline.
 */
export const OPTIMISATION_ABSENCE_DAYS = 3;

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
): number {
  const rows = (Array.isArray(days) ? days : []).filter(Boolean);
  let streak = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
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
 * ── Per PIXEL, never per account ─────────────────────────────────────────────────────
 *
 * Haven runs THREE pixels. A conversion arriving on one says nothing about another, so a
 * unioned event set would let a busy pixel vouch for a dead one.
 */
export function evaluateAccountOptimisationCoverage(
  adSets: OptimisationAdSet[] | null | undefined,
  receivedEventsByPixel: Record<string, Iterable<string>> | null | undefined,
  spendingDays: OptimisationSpendingDay[] | null | undefined,
): AccountOptimisationVerdict {
  const verdict: AccountOptimisationVerdict = {
    alerting: [], unconfirmed: [], unconfirmable: [], dormant: [],
    unrecognisedOptimisations: [], inconclusivePixels: [],
  };

  const rows = (Array.isArray(adSets) ? adSets : []).filter(Boolean);
  const byPixel = receivedEventsByPixel && typeof receivedEventsByPixel === 'object' ? receivedEventsByPixel : {};
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
    const raw = row?.promoted_object?.custom_event_type;
    if (typeof raw !== 'string' || !raw.trim()) continue; // reach/traffic goals promote nothing

    const key = raw.trim().toUpperCase();
    if (IGNORED_OPTIMISATIONS.has(key)) continue;

    const delivering = DELIVERING_STATUSES.has(String(row?.effective_status ?? '').toUpperCase());
    const expected = META_EVENT_BY_OPTIMISATION[key];
    if (!expected) {
      if (delivering) unrecognised.add(key);
      continue;
    }

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

    if (received.has(expected)) continue; // arriving — no claim to make

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

    const absent = countTrailingAbsentSpendingDays(spendingDays, family);
    if (absent >= OPTIMISATION_ABSENCE_DAYS) {
      verdict.alerting.push({ ...hit, insightsFamily: family, consecutiveAbsentSpendingDays: absent });
    } else {
      // The account converted this family recently, so the pixel's 24h silence is far more
      // likely to be a low-volume window than a fault. This is the case that would have
      // produced the false positives.
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
    fields: 'id,name,effective_status,promoted_object{custom_event_type,pixel_id}',
    limit: '200',
  });

  const adSets: OptimisationAdSet[] = [];
  let url: string =
    `https://graph.facebook.com/${apiVersion}/act_${adAccountId}/adsets?${params}` +
    `&access_token=${encodeURIComponent(accessToken)}`;

  try {
    for (let page = 0; page < MAX_ADSET_PAGES && url; page++) {
      const response = await fetchImpl(url);
      const body: any = await response.json();
      if (!response.ok || body?.error) {
        return {
          status: 'fetch_error',
          adSets: [],
          receivedEventsByPixel: {},
          error: body?.error?.message || `HTTP ${response.status}`,
        };
      }
      for (const row of Array.isArray(body?.data) ? body.data : []) adSets.push(row);
      url = typeof body?.paging?.next === 'string' ? body.paging.next : '';
    }
  } catch (error: any) {
    return { status: 'fetch_error', adSets: [], receivedEventsByPixel: {}, error: error?.message || 'request failed' };
  }

  // Only pixels an ad set actually promotes an event to are worth a call. A pixel nobody
  // optimises toward cannot produce a Tier 1 finding.
  const referenced: string[] = [];
  for (const row of adSets) {
    const pixelId = row?.promoted_object?.pixel_id;
    const event = row?.promoted_object?.custom_event_type;
    if (typeof pixelId === 'string' && pixelId.trim() && typeof event === 'string' && event.trim()) {
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
      const response = await fetchImpl(statsUrl);
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
  };
}
