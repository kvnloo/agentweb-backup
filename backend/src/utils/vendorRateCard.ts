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
  | "2captcha"
  | "elevenlabs"
  | "placid"
  | "remotion";

interface VendorRateEntry {
  /** Human unit label written to RecordVendorUsageContext.unit. */
  recordingUnit: string;
  /** Allocated USD per unit. */
  usdPerUnit: number;
}

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
    email_reveal: { recordingUnit: "reveal", usdPerUnit: 0.0495 },
    phone_reveal: { recordingUnit: "reveal", usdPerUnit: 0.395 },
    full_enrichment: { recordingUnit: "enrichment", usdPerUnit: 0.445 },
  },
  "enrich.so": {
    email_lookup: { recordingUnit: "lookup", usdPerUnit: 0.005 },
    phone_finder: { recordingUnit: "lookup", usdPerUnit: 0.25 },
    email_validation: { recordingUnit: "validation", usdPerUnit: 0.0005 },
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
};

/**
 * Look up the allocated USD-per-unit rate for a vendor/rate-key pair.
 * Callers pass the configured key unchanged (for example,
 * `landing_page_generation`, not its human recording unit `generation`).
 * Returns null for an unknown provider or rate key — callers must not default a
 * missing rate to $0 or any other value (see computeAllocatedCost).
 */
export function getAllocatedRate(
  provider: VendorRateProvider,
  rateKey: string
): number | null {
  if (
    !rateKey ||
    !Object.prototype.hasOwnProperty.call(RATE_CARD, provider)
  ) {
    return null;
  }
  const providerCard = RATE_CARD[provider];
  if (!Object.prototype.hasOwnProperty.call(providerCard, rateKey)) {
    return null;
  }
  return providerCard[rateKey].usdPerUnit;
}

/**
 * Allocated USD cost for `quantity` units of a vendor/unit pair.
 *
 * @throws if the provider/unit has no rate entry — an unpriced unit must fail
 *         loudly rather than silently book $0 (ENG-703 AC2).
 */
export function computeAllocatedCost(
  provider: VendorRateProvider,
  rateKey: string,
  quantity: number
): number {
  const rate = getAllocatedRate(provider, rateKey);
  if (rate === null) {
    throw new Error(
      `No allocated rate for vendor "${provider}" rate key "${rateKey}" — add it to vendorRateCard.ts before metering this call`
    );
  }
  const safeQuantity = Number.isFinite(quantity) && quantity > 0 ? quantity : 0;
  return safeQuantity * rate;
}
