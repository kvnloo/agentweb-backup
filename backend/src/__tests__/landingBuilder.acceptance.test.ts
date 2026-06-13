/**
 * Behavioral acceptance contract for the landing-page builder.
 *
 * These assert the THREE behaviors the product owner specified, independent of
 * implementation path:
 *
 *   AC1. No site yet + "build me a landing page"  -> build a first page matched
 *        to the brand guidelines as closely as possible.
 *   AC2. Has a site + "build me a NEW landing page":
 *          - "single page" (unified) -> add it as a SUB-PAGE of the existing site.
 *          - "multi page"  (separate) -> give it its OWN separate site.
 *        (AC2 routing is covered by the multi-site tests in services.v0Service.test.ts:
 *         "unified default + existing site -> adds a page", "separate mode -> creates a new site".)
 *   AC3. The single/multi mode is LOCKED once chosen — it cannot be switched.
 */
import { resolveLockedSiteMode, buildBrandEnrichedPrompt } from "../services/v0Service";

describe("AC1 — the first landing page is built matched to the brand guidelines", () => {
  it("weaves the brand (name, color, font, tone) into the generation prompt", () => {
    const out = buildBrandEnrichedPrompt("Build me a landing page", {
      brandName: "Acme",
      primaryColor: "#FF5733",
      fontFamily: "Inter",
      toneOfVoice: "bold and friendly",
    } as any);
    expect(out).toContain("Acme");
    expect(out).toContain("#FF5733");
    expect(out).toContain("Inter");
    expect(out.toLowerCase()).toContain("bold and friendly");
  });

  it("still produces a usable prompt when the brand is sparse (no crash, prompt preserved)", () => {
    const out = buildBrandEnrichedPrompt("Build me a landing page", {} as any);
    expect(out).toContain("Build me a landing page");
  });
});

describe("AC3 — the single/multi site mode is locked once chosen", () => {
  it("an explicit first pick chooses the mode AND locks it (lockNow = true)", () => {
    expect(resolveLockedSiteMode(undefined, "separate")).toEqual({ mode: "separate", lockNow: true });
    expect(resolveLockedSiteMode(undefined, "unified")).toEqual({ mode: "unified", lockNow: true });
  });

  it("a saved mode is immutable — a conflicting later request is IGNORED (no switching)", () => {
    // User chose "single page" (unified); a later request asking for "multi page" is ignored.
    expect(resolveLockedSiteMode("unified", "separate")).toEqual({ mode: "unified", lockNow: false });
    // User chose "multi page" (separate); a later request asking for "single page" is ignored.
    expect(resolveLockedSiteMode("separate", "unified")).toEqual({ mode: "separate", lockNow: false });
  });

  it("no saved mode and no explicit pick → default to single-page (unified), not yet locked", () => {
    expect(resolveLockedSiteMode(undefined, undefined)).toEqual({ mode: "unified", lockNow: false });
    expect(resolveLockedSiteMode(undefined, "garbage")).toEqual({ mode: "unified", lockNow: false });
  });
});
