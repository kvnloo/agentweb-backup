/**
 * Unit tests for the centralized allocated vendor rate card (ENG-703).
 *
 * These figures are the decision approved 2026-08-16: allocations used for
 * credit drawdown and margin control, never a measured vendor invoice charge.
 */

import {
  getAllocatedRate,
  computeAllocatedCost,
  VendorRateProvider,
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

  it("prices Apollo email reveal, phone reveal, and full enrichment distinctly", () => {
    expect(getAllocatedRate("apollo", "email_reveal")).toBeCloseTo(0.0495, 6);
    expect(getAllocatedRate("apollo", "phone_reveal")).toBeCloseTo(0.395, 6);
    expect(getAllocatedRate("apollo", "full_enrichment")).toBeCloseTo(0.445, 6);
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
});

describe("computeAllocatedCost", () => {
  it("throws loudly for an unpriced unit instead of booking $0 (AC2)", () => {
    expect(() => computeAllocatedCost("v0", "not-a-real-unit", 1)).toThrow(
      /no allocated rate/i
    );
  });

  it("throws loudly for an unknown provider", () => {
    expect(() =>
      computeAllocatedCost("not-a-vendor" as VendorRateProvider, "generate", 1)
    ).toThrow(/no allocated rate/i);
  });

  it("computes quantity * rate for a priced unit", () => {
    const cost = computeAllocatedCost("apollo", "email_reveal", 4);
    expect(cost).toBeCloseTo(0.198, 6);
  });

  it("clamps a negative quantity to 0 (never a negative charge)", () => {
    expect(computeAllocatedCost("v0", "landing_page_generation", -3)).toBe(0);
  });

  it("treats a non-finite quantity as 0", () => {
    expect(computeAllocatedCost("v0", "landing_page_generation", Number.NaN)).toBe(0);
  });
});
