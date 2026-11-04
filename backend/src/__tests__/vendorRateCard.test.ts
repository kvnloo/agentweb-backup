/**
 * Unit tests for the centralized allocated vendor rate card (ENG-703).
 *
 * These figures are the decision approved 2026-08-16: allocations used for
 * credit drawdown and margin control, never a measured vendor invoice charge.
 */

import {
  getAllocatedRate,
  VendorRateProvider,
  VENDOR_RATE_CARD_VERSION,
  getRecordingUnit,
  APOLLO_USD_PER_CREDIT,
  APOLLO_WATERFALL_CREDITS,
} from "../utils/vendorRateCard";

describe("getAllocatedRate", () => {
  // ── FAIL / invalid-input cases ────────────────────────────────────────────
  it("returns null for an unknown provider", () => {
    expect(getAllocatedRate("not-a-vendor" as VendorRateProvider, "generate")).toBeNull();
  });

  it("returns null for a known provider with an unknown unit", () => {
    expect(getAllocatedRate("v0", "not-a-real-unit")).toBeNull();
  });

  it("returns null for an empty unit string", () => {
    expect(getAllocatedRate("apollo", "")).toBeNull();
  });

  it.each(["__proto__", "constructor"])(
    "returns null for inherited provider name %s",
    (provider) => {
      expect(
        getAllocatedRate(provider as VendorRateProvider, "toString")
      ).toBeNull();
    }
  );

  it("returns null for an inherited rate key", () => {
    expect(getAllocatedRate("v0", "toString")).toBeNull();
  });

  // ── SUCCESS / happy-path rate cases (from the approved table) ────────────
  it("prices v0 landing-page generation at $2.00", () => {
    expect(getAllocatedRate("v0", "landing_page_generation")).toBe(2.0);
  });

  it("prices You.com queries at $0.0125", () => {
    expect(getAllocatedRate("you.com", "query")).toBe(0.0125);
  });

  it("prices Google CSE queries above the free tier at $0.0125", () => {
    expect(getAllocatedRate("google_cse", "query")).toBe(0.0125);
  });

  it("prices Apollo email reveal, phone reveal, and the waterfall components distinctly", () => {
    expect(getAllocatedRate("apollo", "email_reveal")).toBeCloseTo(0.0495, 6);
    expect(getAllocatedRate("apollo", "phone_reveal")).toBeCloseTo(0.395, 6);
    expect(getAllocatedRate("apollo", "waterfall_email")).toBeCloseTo(0.445, 6);
    expect(getAllocatedRate("apollo", "waterfall_phone")).toBeCloseTo(0.396, 6);
  });

  // ENG-2720: the ledger key `full_enrichment` became `waterfall_email` (same $0.445). The old key must stay
  // unpriced so a stale caller fails loud instead of silently booking under a name nothing reads.
  it("no longer prices the old Apollo full_enrichment key (renamed to waterfall_email)", () => {
    expect(getAllocatedRate("apollo", "full_enrichment")).toBeNull();
  });

  describe("Apollo waterfall booking (ENG-2720; owner decision 2026-11-02: keep the 9-credit amount)", () => {
    // Real cost per credit: Professional Annual $948 / 48,000 credits (confirmed 2026-10-30).
    const REAL_USD_PER_CREDIT = 948 / 48000;

    it("books the email waterfall at the approved table value $0.445, unchanged from the old full_enrichment line", () => {
      expect(getAllocatedRate("apollo", "waterfall_email")).toBe(0.445);
    });

    it("keeps the per-credit constant and prices the unused phone component as credits x it", () => {
      expect(APOLLO_USD_PER_CREDIT).toBe(0.0495);
      expect(getAllocatedRate("apollo", "waterfall_phone")).toBeCloseTo(APOLLO_WATERFALL_CREDITS.phone * APOLLO_USD_PER_CREDIT, 6);
      expect(getAllocatedRate("apollo", "email_reveal")).toBeCloseTo(APOLLO_USD_PER_CREDIT, 6);
    });

    it("waterfall_email is the email credit plus the 8-credit phone allowance (9 credits), so splitting later cannot change the total", () => {
      const nineCredits = (APOLLO_WATERFALL_CREDITS.email + APOLLO_WATERFALL_CREDITS.phone) * APOLLO_USD_PER_CREDIT;
      expect(APOLLO_WATERFALL_CREDITS.email + APOLLO_WATERFALL_CREDITS.phone).toBe(9);
      expect(Math.abs(getAllocatedRate("apollo", "waterfall_email")! - nineCredits)).toBeLessThan(0.001);
      // after the phone split: email (1 credit) + phone (8 credits) must still add up to the booked amount
      const split = getAllocatedRate("apollo", "email_reveal")! + getAllocatedRate("apollo", "waterfall_phone")!;
      expect(Math.abs(split - getAllocatedRate("apollo", "waterfall_email")!)).toBeLessThan(0.001);
    });

    it("clears the 60% gross-margin floor (booked >= real / 0.40) for the 9-credit amount", () => {
      const floor = (credits: number) => (credits * REAL_USD_PER_CREDIT) / 0.4;
      expect(getAllocatedRate("apollo", "waterfall_email")!).toBeGreaterThanOrEqual(floor(9) - 1e-4);
      expect(getAllocatedRate("apollo", "waterfall_phone")!).toBeGreaterThanOrEqual(floor(APOLLO_WATERFALL_CREDITS.phone) - 1e-4);
    });
  });

  it("prices enrich.so email lookup, phone finder, and email validation distinctly", () => {
    expect(getAllocatedRate("enrich.so", "email_lookup")).toBeCloseTo(0.005, 6);
    expect(getAllocatedRate("enrich.so", "phone_finder")).toBeCloseTo(0.25, 6);
    expect(getAllocatedRate("enrich.so", "email_validation")).toBeCloseTo(0.0005, 6);
  });

  it("prices 2captcha solves at $0.00725", () => {
    expect(getAllocatedRate("2captcha", "solve")).toBeCloseTo(0.00725, 6);
  });

  it("prices ElevenLabs per 1k characters by model tier", () => {
    expect(getAllocatedRate("elevenlabs", "characters_flash_turbo")).toBeCloseTo(0.125, 6);
    expect(getAllocatedRate("elevenlabs", "characters_multilingual")).toBeCloseTo(0.25, 6);
  });

  it("prices Placid image render, 30s video render, and PDF page distinctly", () => {
    expect(getAllocatedRate("placid", "image_render")).toBeCloseTo(0.095, 6);
    expect(getAllocatedRate("placid", "video_render_30s")).toBeCloseTo(3.325, 6);
    expect(getAllocatedRate("placid", "pdf_page")).toBeCloseTo(0.19, 6);
  });

  it("prices Remotion Lambda blended render estimate at $0.1375", () => {
    expect(getAllocatedRate("remotion", "render")).toBeCloseTo(0.1375, 6);
  });

  it("prices Twilio outbound voice minutes and monthly number rent at list price (provisional)", () => {
    expect(getAllocatedRate("twilio", "voice_minute_outbound")).toBeCloseTo(0.014, 6);
    expect(getAllocatedRate("twilio", "number_monthly_rent")).toBeCloseTo(1.15, 6);
    expect(getRecordingUnit("twilio", "voice_minute_outbound")).toBe("minute");
    expect(getRecordingUnit("twilio", "number_monthly_rent")).toBe("number_month");
  });
});

// computeAllocatedCost was removed by ENG-1929: pricing now happens inside
// recordVendorUsage from a rateKey, so an unpriced unit can no longer throw into
// a vendor request. Its AC2 cases (unpriced is loud, never $0; quantity clamps)
// moved to usageRecorderService.vendorRateKey.test.ts.
describe("vendor rate card", () => {
  describe("rate-card version (ENG-1250 §5)", () => {
    it("is a dated version string", () => {
      expect(VENDOR_RATE_CARD_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it("matches the last commit that changed a rate in this file", () => {
      // Pinned deliberately. A rate edit that does not bump this leaves two
      // different prices sharing one version, and a historical spend event can
      // no longer be re-derived from the card that produced it.
      expect(VENDOR_RATE_CARD_VERSION).toBe("2026-11-02");
    });
  });

  describe("getRecordingUnit", () => {
    it("returns the card's own unit label for a priced entry", () => {
      expect(getRecordingUnit("elevenlabs", "characters_flash_turbo")).toBe("1k_characters");
      expect(getRecordingUnit("you.com", "query")).toBe("query");
    });

    it("returns null for an unknown provider or rate key, never a default", () => {
      expect(getRecordingUnit("v0", "no_such_key")).toBeNull();
      expect(getRecordingUnit("not_a_vendor" as never, "query")).toBeNull();
      expect(getRecordingUnit("v0", "")).toBeNull();
    });

    it("does not resolve inherited Object properties as rate keys", () => {
      expect(getRecordingUnit("v0", "constructor")).toBeNull();
      expect(getRecordingUnit("v0", "toString")).toBeNull();
    });
  });
});