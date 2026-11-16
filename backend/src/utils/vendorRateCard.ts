/**
 * vendorRateCard — single source of truth for allocated per-unit vendor rates
 * used by non-token-priced usage metering (ENG-703, decision approved 2026-08-16).
 *
 * These are ALLOCATIONS used for credit drawdown and margin control, never a
 * measured vendor invoice charge — every consumer must record its cost with
 * `costSource: "allocated"` (see usageRecorderService.RecordVendorUsageContext).
 *
 * No adapter may embed its own independent dollar literal for a vendor/unit
 * covered here — read the rate from this module so a rate change is a
 * one-line edit instead of a grep-and-replace across services.
 *
 * v0 scope note: the $2.00 v0 landing-page rate is deliberately aggressive and
 * applies ONLY to v0 landing-page generation, not the coding agent. v0 exposes
 * no complexity tier or per-call usage field, so this is a flat allocation —
 * periodic dashboard reconciliation is the accepted drift check, not a blocker.
 *
 * Scope note (2026-08-18): X/Twitter pricing is intentionally NOT sourced from
 * this card. `twitterPricing.ts` (ENG-664, already shipped and live) prices
 * four X read categories separately (post/user/owned/dm reads at $0.005 /
 * $0.010 / $0.001 / $0.010) plus link-aware post writes. The table approved
 * here collapses that to one flat "X read" rate ($0.0125) and a different
 * post-write rate ($0.0375 / $0.50 vs the live $0.015 / $0.20). Silently
 * overwriting twitterPricing's already-live, more granular rates with this
 * flatter table would be a real behavior change to a shipped billing rail
 * made on a guess, not a confirmed instruction — flagged on ENG-703 for
 * Harsha to reconcile explicitly rather than resolved here.
 */

export type VendorRateProvider =
  | "v0"
  | "you.com"
  | "google_cse"
  | "apollo"
  | "enrich.so"
  | "enigma"
  | "2captcha"
  | "elevenlabs"
  | "placid"
  | "remotion"
  | "twilio";

interface VendorRateEntry {
  /** Human unit label written to RecordVendorUsageContext.unit. */
  recordingUnit: string;
  /** Allocated USD per unit. */
  usdPerUnit: number;
}

/**
 * Version stamp for the rates below (ENG-1250 §5: "A price change creates a new
 * version; historical events retain the rate version used").
 *
 * Dated to the last change to the rates in this file — currently the ENG-2271
 * Twilio voice placeholders of 2026-10-19. **Bump this in the same commit as
 * any rate edit**, otherwise two different prices share one version and a
 * historical event can no longer be re-derived from the card that produced it.
 *
 * 2026-11-02: Apollo `full_enrichment` split into `waterfall_email` ($0.445, unchanged) and
 * `waterfall_phone` (ENG-2720); previously 2026-10-19 (ENG-2271 Twilio placeholders).
 */
export const VENDOR_RATE_CARD_VERSION = "2026-11-02";

/**
 * Apollo allocated USD per credit (ENG-703, Harsha 2026-08-16): the 60% gross-margin
 * floor is real cost / 0.40 (x2.5). Real cost is $0.01975 per credit (Professional
 * Annual, $948 / 48,000 credits, confirmed from the account 2026-10-30), and
 * 2.5 x $0.01975 = $0.0494, booked as $0.0495. The one-credit Apollo rates (email_reveal,
 * person_match, org_enrichment) and waterfall_phone (8 credits) are this constant x a
 * credit count, so a per-credit pricing change is one edit here. Two entries sit at their
 * ENG-703 approved-table values instead: `waterfall_email` ($0.445) and the unused
 * `phone_reveal` ($0.395, $0.001 below 8 credits only because of rounding in that table).
 */
export const APOLLO_USD_PER_CREDIT = 0.0495;

/**
 * Apollo email-waterfall booking (ENG-703 "full enrichment" = $0.445 = "up to 9 credits":
 * 1 email + 8 phone), per component so phone numbers can slot in later (ENG-2720).
 *
 * DECISION (Harsha, Argusoft <> AgentWeb sync 2026-11-02): KEEP booking the 9-credit amount
 * on every email waterfall although nothing requests a phone yet (the /people/match body has
 * no phone parameter anywhere in the backend; the Apollo account shows 0 phone credits used;
 * observed real usage is 1-2 credits per contact). Rationale: customers' wallets are ~40% of
 * what they pay (Starter $80 of $199, Pro $200 of $499), so the margin is already there;
 * revisit when phone fetching ships. The earlier proposal to book 2 credits ($0.099) was
 * declined. Known consequence, recorded so it is a choice and not an accident: the booked
 * amount is ~10-40x Apollo's real cost, so wallets drain faster than the work warrants and,
 * on accounts with pay-as-you-go overage on (Opiner), the overage invoice carries it at the
 * tier's markup.
 *
 * - email: 1 credit (Apollo's own lookup; third-party sources charge more on a miss).
 * - phone: 8 credits (Apollo phone reveal), NOT requested by any call today.
 *
 * `waterfall_email` is therefore booked at the full 9-credit table value ($0.445 = email + the
 * 8-credit phone allowance). **When phone fetching ships, change `waterfall_email` to
 * apolloCreditsUsd(1) and book `waterfall_phone` ($0.396) on requests that ask for a phone, or
 * the phone credits are counted twice.** Verify the waterfall-phone charge (third-party
 * vendors, misses) on Apollo's "About credits" page before the first caller ships; if it
 * exceeds 8 credits the margin drops below the floor.
 */
export const APOLLO_WATERFALL_CREDITS = { email: 1, phone: 8 } as const;

const apolloCreditsUsd = (credits: number): number =>
  Math.round(credits * APOLLO_USD_PER_CREDIT * 1_000_000) / 1_000_000;

const RATE_CARD: Record<VendorRateProvider, Record<string, VendorRateEntry>> = {
  v0: {
    landing_page_generation: { recordingUnit: "generation", usdPerUnit: 2.0 },
  },
  "you.com": {
    query: { recordingUnit: "query", usdPerUnit: 0.0125 },
  },
  google_cse: {
    query: { recordingUnit: "query", usdPerUnit: 0.0125 },
  },
  apollo: {
    email_reveal: { recordingUnit: "reveal", usdPerUnit: apolloCreditsUsd(1) },
    phone_reveal: { recordingUnit: "reveal", usdPerUnit: 0.395 },
    // ENG-2720: broker waterfall, per component. waterfall_email is booked at the ENG-703 approved "full
    // enrichment" table value $0.445 (= email 1 + the 8-credit phone allowance) per the owner's 2026-11-02
    // decision to keep the 9-credit amount; see APOLLO_WATERFALL_CREDITS for the switch when phone ships.
    waterfall_email: { recordingUnit: "enrichment", usdPerUnit: 0.445 },
    // PROVISIONAL and unused: no caller books this yet. The 8 credits is Apollo's plain phone reveal; verify the
    // waterfall-phone charge (third-party vendors, misses) before the first caller ships. Do not book it together
    // with waterfall_email at 9 credits (that already includes it).
    waterfall_phone: { recordingUnit: "enrichment", usdPerUnit: apolloCreditsUsd(APOLLO_WATERFALL_CREDITS.phone) },
    // ENG-696: basic /people/match with no email/phone reveal — Apollo's
    // cheapest person-match credit tier (same class as org enrichment below).
    person_match: { recordingUnit: "match", usdPerUnit: apolloCreditsUsd(1) },
    // ENG-696 — confirmed via Apollo's official API docs (docs.apollo.io
    // /reference/organization-enrichment, docs.apollo.io/docs/api-pricing,
    // checked 2026-09-02): /organizations/enrich costs 1 credit per call,
    // the same credit tier as person_match's /people/match. Priced at the
    // same $0.0495/credit rate used for person_match above.
    org_enrichment: { recordingUnit: "enrichment", usdPerUnit: apolloCreditsUsd(1) },
  },
  "enrich.so": {
    email_lookup: { recordingUnit: "lookup", usdPerUnit: 0.005 },
    // ENG-703 approved rate. No caller books this today (audited ENG-2720); the admission estimate no longer reserves it.
    phone_finder: { recordingUnit: "lookup", usdPerUnit: 0.25 },
    email_validation: { recordingUnit: "validation", usdPerUnit: 0.0005 },
    // ENG-696 — confirmed via enrich.so's official docs (doc.enrich.so
    // /look-up-a-professional-profile-by-email-27483203e0, enrich.so/pricing,
    // checked 2026-09-02): reverse (lookup-by-email) costs 10 credits per
    // successful lookup vs. email_lookup's 1 credit, consistent with the
    // route's materially lower daily cap (50/day vs 1000/day — see
    // enrichSoQuota.ts DEFAULT_LOOKUP_BY_EMAIL_DAILY_LIMIT). Priced at
    // 10x email_lookup's confirmed per-credit rate. No charge is booked on a
    // no-profile-found response since recordVendorUsage only fires on the
    // successful-call path.
    reverse_lookup: { recordingUnit: "lookup", usdPerUnit: 0.05 },
  },
  // ENG-1388 — PLACEHOLDERS at Enigma's public list price (enigma.com/pricing/
  // rate-card, pricing effective 2026-08-10, checked 2026-09-14; 1 credit =
  // $0.01). Enigma bills per value returned ("per fill"), not per request, so
  // each key is one billed value: Brand 12M Card Revenue Amount = 10 credits,
  // Brand 12M Card Revenue YoY Growth = 10, Brand Name / Website = 2 each.
  // Pending Harsha's allocation confirmation (ENG-1706 pattern) before any
  // call site goes live — Phase 1 ships the adapter with no caller.
  enigma: {
    card_revenue_12m: { recordingUnit: "fill", usdPerUnit: 0.1 },
    card_revenue_yoy_growth_12m: { recordingUnit: "fill", usdPerUnit: 0.1 },
    brand_attribute: { recordingUnit: "fill", usdPerUnit: 0.02 },
  },
  "2captcha": {
    solve: { recordingUnit: "solve", usdPerUnit: 0.00725 },
  },
  elevenlabs: {
    characters_flash_turbo: { recordingUnit: "1k_characters", usdPerUnit: 0.125 },
    characters_multilingual: { recordingUnit: "1k_characters", usdPerUnit: 0.25 },
  },
  placid: {
    image_render: { recordingUnit: "render", usdPerUnit: 0.095 },
    video_render_30s: { recordingUnit: "render", usdPerUnit: 3.325 },
    pdf_page: { recordingUnit: "page", usdPerUnit: 0.19 },
  },
  remotion: {
    render: { recordingUnit: "render", usdPerUnit: 0.1375 },
  },
  // ENG-2271 — PROVISIONAL placeholders at Twilio's public US list price
  // (twilio.com/en-us/voice/pricing/us, "Pricing current as of August 2026",
  // checked 2026-10-19): outbound to United States & Canada $0.0140/min,
  // local number $1.15/mo. Pending Harsha's allocation confirmation (ENG-1706
  // pattern) before the hot-lead auto-call goes live.
  twilio: {
    voice_minute_outbound: { recordingUnit: "minute", usdPerUnit: 0.014 },
    number_monthly_rent: { recordingUnit: "number_month", usdPerUnit: 1.15 },
  },
};

// ── Runtime overrides (ENG-2271) ─────────────────────────────────────────────
//
// Owners can change the PROVISIONAL Twilio rates from the admin area without a
// deploy. Defaults stay in RATE_CARD above; an override is a layer on top that
// can only ever make a lookup return a validated number or fall back to the
// card. The lookup stays synchronous (four services call it inline), so it
// never waits on I/O: it reads an in-memory snapshot and, when that is stale,
// kicks a background refresh.

/** Providers whose rates an admin may override. Everything else is code-only. */
export const EDITABLE_VENDOR_RATE_PROVIDERS: readonly VendorRateProvider[] = ["twilio"];

/** AW-Settings item holding the overrides (see parseVendorRateOverrides for the shape). */
export const VENDOR_RATE_OVERRIDES_SETTING = "vendor_rate_overrides";

// Far above any real Twilio per-unit price. A decimal-point slip such as 14 or 1400 for 0.014 is refused outright
// by this ceiling; a smaller one such as 1.4 stays under it and is left to the admin UI's confirm dialog.
export const MAX_OVERRIDE_USD_PER_UNIT = 10;

export type VendorRateOverrides = Partial<Record<VendorRateProvider, Record<string, number>>>;

export interface VendorRateOverrideState {
  overrides: VendorRateOverrides;
  /** ISO time of the last admin write; null when the item was never written. */
  updatedAt: string | null;
  updatedBy: string | null;
}

const NO_OVERRIDES: VendorRateOverrideState = { overrides: {}, updatedAt: null, updatedBy: null };

const hasOwn = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

export function isEditableProvider(provider: string): boolean {
  return (EDITABLE_VENDOR_RATE_PROVIDERS as readonly string[]).includes(provider);
}

export function isEditableVendorRate(provider: string, rateKey: string): boolean {
  return (
    isEditableProvider(provider) &&
    hasOwn(RATE_CARD, provider) &&
    hasOwn(RATE_CARD[provider as VendorRateProvider], rateKey)
  );
}

/**
 * At most 6 decimal places: costs are booked in whole micro-dollars, so anything finer
 * (1e-7 per minute) would round to a $0 "allocated" event. The single validator for both
 * the admin route and the load path. Positive plus exactly-6-decimals is what guarantees
 * >= 1 micro-dollar per WHOLE unit (fractional quantities can still round to 0).
 */
export function isValidOverrideRate(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value > 0 &&
    value <= MAX_OVERRIDE_USD_PER_UNIT &&
    value === Number(value.toFixed(6))
  );
}

/**
 * Strictly parse the stored item. Never throws. Garbage as a whole (bad JSON,
 * wrong shape, no usable updatedAt) yields no overrides; a bad individual entry
 * is dropped on its own so one typo cannot disable the rest. Warnings name the
 * provider and key only, and an unreadable item logs only the error name (JSON.parse
 * messages quote a snippet of the stored text).
 *
 * Stored shape: { overrides: { <provider>: { <rateKey>: <usdPerUnit> } }, updatedAt, updatedBy }
 */
export function parseVendorRateOverrides(raw: unknown): VendorRateOverrideState {
  try {
    if (raw === undefined || raw === null || raw === "") return NO_OVERRIDES;
    const doc = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new Error("not an object");
    const { overrides, updatedAt, updatedBy } = doc as Record<string, unknown>;
    if (typeof updatedAt !== "string" || Number.isNaN(Date.parse(updatedAt))) throw new Error("no valid updatedAt");
    if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) throw new Error("no overrides object");

    const clean: VendorRateOverrides = {};
    for (const [provider, entries] of Object.entries(overrides)) {
      if (!entries || typeof entries !== "object" || Array.isArray(entries)) {
        console.warn(`[vendorRateCard] ignoring malformed override block for provider "${provider}"`);
        continue;
      }
      for (const [rateKey, value] of Object.entries(entries)) {
        if (!isEditableVendorRate(provider, rateKey) || !isValidOverrideRate(value)) {
          console.warn(`[vendorRateCard] ignoring invalid rate override ${provider}:${rateKey}`);
          continue;
        }
        const p = provider as VendorRateProvider;
        (clean[p] ??= {})[rateKey] = value;
      }
    }
    // An emptied item keeps its audit fields (an admin reset is still a recorded change).
    return { overrides: clean, updatedAt, updatedBy: typeof updatedBy === "string" ? updatedBy : null };
  } catch (error) {
    console.warn(
      `[vendorRateCard] ignoring unreadable ${VENDOR_RATE_OVERRIDES_SETTING} (${error instanceof Error ? error.name : "error"}); using the built-in card`,
    );
    return NO_OVERRIDES;
  }
}

/** Version stamp for a given override state. */
export function rateCardVersionFor(state: VendorRateOverrideState): string {
  const active = Object.keys(state.overrides).length > 0 && state.updatedAt;
  return active ? `${VENDOR_RATE_CARD_VERSION}+ovr:${state.updatedAt}` : VENDOR_RATE_CARD_VERSION;
}

const OVERRIDE_TTL_MS = 60_000;
const OVERRIDE_READ_TIMEOUT_MS = 1500;

// A first read that fails is retried after this, not after a full TTL: until one good read has
// landed the instance prices at the built-in defaults.
const COLD_RETRY_MS = 5_000;

let snapshot: { state: VendorRateOverrideState; at: number } = { state: NO_OVERRIDES, at: 0 };
let loaded = false;
let warnedCold = false;
let inflight: Promise<void> | null = null;
// Bumped by every read start and every local apply; a read result only lands if
// nothing newer started since, so a slow stale read cannot clobber a fresh PUT.
let epoch = 0;
let testState: VendorRateOverrideState | null = null;

/** Tests only: inject overrides (no I/O under NODE_ENV=test); null clears. */
export function setVendorRateOverridesForTests(
  overrides: VendorRateOverrides | null,
  updatedAt: string = "2026-01-01T00:00:00.000Z",
): void {
  testState = overrides ? parseVendorRateOverrides({ overrides, updatedAt, updatedBy: "test" }) : null;
  snapshot = { state: NO_OVERRIDES, at: 0 };
  loaded = false;
  warnedCold = false;
  inflight = null;
  epoch++;
}

/** Make the state this instance just wrote effective immediately (admin PUT). */
export function applyVendorRateOverridesLocally(state: VendorRateOverrideState): void {
  epoch++;
  loaded = true;
  snapshot = { state, at: Date.now() };
}

async function readOverrides(): Promise<VendorRateOverrideState | null> {
  let timer: NodeJS.Timeout | undefined;
  try {
    // Lazy: keeps aws-sdk out of every module that merely prices a unit.
    const { settingsService } = await import("../services/settingsService");
    const row = await Promise.race([
      settingsService.getSetting(VENDOR_RATE_OVERRIDES_SETTING),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), OVERRIDE_READ_TIMEOUT_MS);
      }),
    ]);
    return parseVendorRateOverrides(row?.settingValue);
  } catch {
    return null; // read error or timeout (no log here); null = keep the last good snapshot
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Re-read the item now (shared in-flight read). On a read error or timeout the
 * last good snapshot is KEPT (an admin's price change should not silently
 * revert because DynamoDB hiccuped); the next attempt waits a full TTL, or only
 * COLD_RETRY_MS if no read has ever succeeded. A missing or corrupt row means no
 * overrides. Never rejects.
 *
 * Residual (accepted): other instances lag an admin change by up to the 60s TTL, and a
 * failed boot read prices at the built-in defaults for up to COLD_RETRY_MS afterwards.
 */
export function refreshVendorRateOverrides(): Promise<void> {
  if (inflight) return inflight;
  const mine = ++epoch;
  const run = readOverrides()
    .then((state) => {
      if (mine !== epoch) return;
      if (state) loaded = true;
      else if (!loaded && !warnedCold) {
        warnedCold = true;
        console.warn("[vendorRateCard] could not read vendor rate overrides; pricing at the built-in defaults and retrying shortly");
      }
      const now = Date.now();
      snapshot = {
        state: state ?? snapshot.state,
        at: loaded ? now : now - (OVERRIDE_TTL_MS - COLD_RETRY_MS),
      };
    })
    .finally(() => {
      if (inflight === run) inflight = null;
    });
  inflight = run;
  return run;
}

function currentState(): VendorRateOverrideState {
  if (testState) return testState;
  // Under Jest nothing is read (every pricing test would otherwise reach DynamoDB); the
  // snapshot then only changes through an explicit apply/inject.
  if (process.env.NODE_ENV !== "test" && Date.now() - snapshot.at >= OVERRIDE_TTL_MS) {
    void refreshVendorRateOverrides();
  }
  return snapshot.state;
}

/**
 * Rate and stamp from ONE snapshot, so an event is always stamped with the
 * version of the rate that priced it, even if an override lands in between.
 * The `+ovr` suffix is only added when the override for THIS key was applied:
 * every other key is priced by the plain card and keeps the plain version.
 * Only editable providers touch the snapshot (and so the background read).
 *
 * A future overridable provider that records via `costUsd` instead of a `rateKey`
 * must have this version passed through to the ledger mirror, as the rateKey path does.
 */
export function getAllocatedRateWithVersion(
  provider: VendorRateProvider,
  rateKey: string,
): { rate: number; version: string } | null {
  if (!rateKey || !hasOwn(RATE_CARD, provider) || !hasOwn(RATE_CARD[provider], rateKey)) return null;
  if (isEditableProvider(provider)) {
    // Snapshot entries were validated by the parser; nothing here can throw.
    const state = currentState();
    const override = state.overrides[provider]?.[rateKey];
    if (override !== undefined) return { rate: override, version: rateCardVersionFor(state) };
  }
  return { rate: RATE_CARD[provider][rateKey].usdPerUnit, version: VENDOR_RATE_CARD_VERSION };
}

/** Effective view of every editable rate, for the admin API. */
export function describeEditableRates(state: VendorRateOverrideState): Array<{
  provider: string;
  key: string;
  unit: string;
  defaultUsdPerUnit: number;
  overrideUsdPerUnit: number | null;
  effectiveUsdPerUnit: number;
}> {
  return EDITABLE_VENDOR_RATE_PROVIDERS.flatMap((provider) =>
    Object.entries(RATE_CARD[provider]).map(([key, entry]) => {
      const override = state.overrides[provider]?.[key] ?? null;
      return {
        provider,
        key,
        unit: entry.recordingUnit,
        defaultUsdPerUnit: entry.usdPerUnit,
        overrideUsdPerUnit: override,
        effectiveUsdPerUnit: override ?? entry.usdPerUnit,
      };
    }),
  );
}

/**
 * Look up the allocated USD-per-unit rate for a vendor/rate-key pair.
 * Callers pass the configured key unchanged (for example,
 * `landing_page_generation`, not its human recording unit `generation`).
 * Returns null for an unknown provider or rate key — callers must not default a
 * missing rate to $0 or any other value. Metering resolves it inside
 * `recordVendorUsage` from a `rateKey`, recording an unpriced key as `unpriced`
 * (ENG-703 AC2, ENG-1929). An admin override (editable providers only) wins
 * over the card; any problem with overrides falls back to the card.
 */
export function getAllocatedRate(
  provider: VendorRateProvider,
  rateKey: string
): number | null {
  return getAllocatedRateWithVersion(provider, rateKey)?.rate ?? null;
}

/**
 * The card's own unit label for a vendor/rate-key pair, or null when unpriced.
 * Lets a caller record `unit` from the card rather than restating it at the call
 * site, where it can drift from the rate it is supposed to describe.
 */
export function getRecordingUnit(
  provider: VendorRateProvider,
  rateKey: string
): string | null {
  if (!rateKey || !hasOwn(RATE_CARD, provider)) return null;
  const providerCard = RATE_CARD[provider];
  if (!hasOwn(providerCard, rateKey)) return null;
  return providerCard[rateKey].recordingUnit;
}
