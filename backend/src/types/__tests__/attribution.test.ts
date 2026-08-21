import { normalizeAttribution, promoteAttributionFromCustomFields } from "../attribution";

describe("normalizeAttribution", () => {
  it("returns undefined for empty/null/invalid payloads", () => {
    expect(normalizeAttribution(undefined)).toBeUndefined();
    expect(normalizeAttribution(null)).toBeUndefined();
    expect(normalizeAttribution({})).toBeUndefined();
    expect(normalizeAttribution("string")).toBeUndefined();
    expect(normalizeAttribution(123)).toBeUndefined();
  });

  it("normalizes the new nested attribution shape end-to-end", () => {
    const input = {
      timestamp: "2026-04-14T12:00:00.000Z",
      utm: { source: "linkedin", medium: "organic_social", campaign: "launch", content: "harsha_post" },
      clickIds: { gclid: "G123", fbclid: "FB456" },
      referrer: "https://linkedin.com",
      landingUrl: "https://agentweb.pro/?utm_source=linkedin",
      sessionId: "sess_abc",
      ref: "harsha_post",
      extraParams: { msclkid: "MS789" },
    };
    expect(normalizeAttribution(input)).toEqual(input);
  });

  it("preserves timestamp from payload when provided", () => {
    const ts = "2026-04-14T00:00:00.000Z";
    const got = normalizeAttribution({ timestamp: ts, utm: { source: "x" } });
    expect(got?.timestamp).toBe(ts);
  });

  it("generates a timestamp when missing", () => {
    const got = normalizeAttribution({ utm: { source: "x" } });
    expect(got?.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("converts legacy flat utm_* keys into nested shape", () => {
    const got = normalizeAttribution({
      utm_source: "linkedin",
      utm_medium: "organic_social",
      utm_campaign: "launch",
    });
    expect(got?.utm).toEqual({ source: "linkedin", medium: "organic_social", campaign: "launch" });
  });

  it("strips empty strings and prunes empty utm/clickIds objects", () => {
    const got = normalizeAttribution({
      utm: { source: "linkedin", medium: "  ", campaign: "" },
      clickIds: {},
    });
    expect(got?.utm).toEqual({ source: "linkedin" });
    expect(got?.clickIds).toBeUndefined();
  });

  it("returns undefined when payload has keys but no values", () => {
    expect(normalizeAttribution({ utm: {}, clickIds: {}, extraParams: {} })).toBeUndefined();
  });

  it("preserves extraParams only when non-empty", () => {
    expect(normalizeAttribution({ utm: { source: "x" }, extraParams: {} })?.extraParams).toBeUndefined();
    expect(normalizeAttribution({ utm: { source: "x" }, extraParams: { foo: "bar" } })?.extraParams).toEqual({ foo: "bar" });
  });

  it("merges top-level flat keys into nested utm when nested absent", () => {
    const got = normalizeAttribution({
      utm: { source: "linkedin" },
      utm_medium: "organic_social",
    });
    expect(got?.utm).toEqual({ source: "linkedin", medium: "organic_social" });
  });

  it("nested keys win over flat keys when both present", () => {
    const got = normalizeAttribution({
      utm: { source: "linkedin" },
      utm_source: "google",
    });
    expect(got?.utm?.source).toBe("linkedin");
  });

  it("accepts ttclid and liFatId click IDs", () => {
    const got = normalizeAttribution({
      clickIds: { ttclid: "TT", liFatId: "LI" },
    });
    expect(got?.clickIds).toEqual({ ttclid: "TT", liFatId: "LI" });
  });
});

/**
 * ENG-926 §A — a lander that posts its attribution into `customFields`.
 *
 * `hireemma.ai` captures fbclid and the full utm_* set correctly, then sends them
 * flattened into `customFields` (its own /api/lead route's buildForwardLeadBody
 * forwards no `attribution` and no `utm` envelope at all). Nothing structured reads
 * that container, so the lead landed with no `firstTouch` whatsoever: click-ID
 * coverage read 0%, and §C could not rebuild `fbc`. The data was never lost — it was
 * in a container nothing looked in. A field-shape mismatch, not a missing capture.
 *
 * The failure is invisible by construction: the site looks right, the POST returns
 * 201, the row appears. Any other bespoke lander making the same reasonable-looking
 * mistake is silently broken right now and there is no inventory of them, which is
 * why this is fixed once here rather than per site.
 */
describe("promoteAttributionFromCustomFields", () => {
  it("returns the base untouched when there is nothing to promote", () => {
    const base = normalizeAttribution({ utm: { source: "linkedin" } });
    expect(promoteAttributionFromCustomFields(undefined, base)).toBe(base);
    expect(promoteAttributionFromCustomFields(null, base)).toBe(base);
    expect(promoteAttributionFromCustomFields({}, base)).toBe(base);
    expect(promoteAttributionFromCustomFields("string", base)).toBe(base);
    expect(promoteAttributionFromCustomFields([], base)).toBe(base);
  });

  it("returns undefined when there is no base and nothing to promote", () => {
    expect(promoteAttributionFromCustomFields({ role: "CTO", partial: false })).toBeUndefined();
  });

  it("builds a touch from nothing but customFields — the hireemma.ai case", () => {
    // Verbatim shape from ai-readiness-popup.tsx, forwarded by the site's own
    // /api/lead route with no `attribution` and no `utm` envelope.
    const got = promoteAttributionFromCustomFields({
      campaign: "ai-readiness-popup",
      website: "https://example.com",
      completion_step: 4,
      partial: false,
      role: "CTO",
      offer: "ai_readiness_roadmap",
      utm_source: "facebook",
      utm_medium: "paid_social",
      utm_campaign: "ICP1-PLG",
      fbclid: "FB_REAL_CLICK",
      first_touch_page: "/first-ai-dollar",
    });

    expect(got?.clickIds).toEqual({ fbclid: "FB_REAL_CLICK" });
    expect(got?.utm).toEqual({ source: "facebook", medium: "paid_social", campaign: "ICP1-PLG" });
    expect(got?.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("NEVER promotes a bare `campaign` key — forward-lead fills it with the lead source", () => {
    // buildForwardLeadBody sets `customFields.campaign = payload.source`, so a bare
    // `campaign` here reads 'ai-readiness-popup', not a UTM campaign. Promoting it
    // would fabricate attribution that no visitor ever carried. Only the utm_-prefixed
    // spelling is a UTM; this is the single strongest reason the allowlist is prefixed.
    const got = promoteAttributionFromCustomFields({
      campaign: "ai-readiness-popup",
      source: "some-lander",
      medium: "whatever",
    });
    expect(got).toBeUndefined();
  });

  it("promotes only the allowlisted keys, never arbitrary customFields", () => {
    const got = promoteAttributionFromCustomFields({
      fbclid: "FB",
      msclkid: "MS",
      twclid: "TW",
      qualification_reason: "Qualified: revenue meets threshold",
      annual_revenue: "5000000",
    });
    expect(got?.clickIds).toEqual({ fbclid: "FB" });
    expect(got?.extraParams).toBeUndefined();
  });

  it("maps the wire spelling li_fat_id onto the stored liFatId, and accepts either", () => {
    expect(promoteAttributionFromCustomFields({ li_fat_id: "LI" })?.clickIds).toEqual({ liFatId: "LI" });
    expect(promoteAttributionFromCustomFields({ liFatId: "LI" })?.clickIds).toEqual({ liFatId: "LI" });
  });

  it("carries every allowlisted click ID", () => {
    const got = promoteAttributionFromCustomFields({
      gclid: "G", fbclid: "FB", ttclid: "TT", li_fat_id: "LI",
    });
    expect(got?.clickIds).toEqual({ gclid: "G", fbclid: "FB", ttclid: "TT", liFatId: "LI" });
  });

  it("FILLS GAPS rather than replacing — a structured value always wins", () => {
    // The point of gap-filling over a `??` fallback chain: a lander that sends a
    // proper `attribution` envelope AND puts fbclid in customFields would be skipped
    // entirely by a fallback, and that lander is exactly the uninventoried case here.
    const base = normalizeAttribution({
      utm: { source: "linkedin" },
      clickIds: { gclid: "STRUCTURED_G" },
    });
    const got = promoteAttributionFromCustomFields({
      gclid: "CUSTOMFIELD_G",
      fbclid: "CUSTOMFIELD_FB",
      utm_source: "facebook",
      utm_medium: "paid_social",
    }, base);

    expect(got?.clickIds).toEqual({ gclid: "STRUCTURED_G", fbclid: "CUSTOMFIELD_FB" });
    expect(got?.utm).toEqual({ source: "linkedin", medium: "paid_social" });
  });

  it("does not mutate the base touch", () => {
    const base = normalizeAttribution({ utm: { source: "linkedin" } })!;
    const got = promoteAttributionFromCustomFields({ fbclid: "FB" }, base);
    expect(base.clickIds).toBeUndefined();
    expect(got).not.toBe(base);
    expect(got?.clickIds).toEqual({ fbclid: "FB" });
  });

  it("preserves the base timestamp and every other base field", () => {
    const base = normalizeAttribution({
      timestamp: "2026-04-14T00:00:00.000Z",
      landingUrl: "https://hireemma.ai/first-ai-dollar",
      referrer: "https://facebook.com",
      ref: "harsha_post",
    })!;
    const got = promoteAttributionFromCustomFields({ fbclid: "FB" }, base);
    expect(got?.timestamp).toBe("2026-04-14T00:00:00.000Z");
    expect(got?.landingUrl).toBe("https://hireemma.ai/first-ai-dollar");
    expect(got?.referrer).toBe("https://facebook.com");
    expect(got?.ref).toBe("harsha_post");
  });

  it("ignores non-string values rather than coercing them", () => {
    // customFields legitimately carries booleans and numbers (`partial: false`,
    // `q1: 3`). Coercing would turn `fbclid: false` into the string "false" and make
    // an organic lead satisfy attribute_exists(clickIds) — which is what
    // "paid-acquired" MEANS downstream.
    const got = promoteAttributionFromCustomFields({
      fbclid: 12345, gclid: false, ttclid: null, utm_source: { nested: "x" },
    });
    expect(got).toBeUndefined();
  });

  it("ignores empty and whitespace-only values", () => {
    expect(promoteAttributionFromCustomFields({ fbclid: "", utm_source: "   " })).toBeUndefined();
  });

  it("trims promoted values", () => {
    expect(promoteAttributionFromCustomFields({ fbclid: "  FB  " })?.clickIds).toEqual({ fbclid: "FB" });
  });

  it("promotes UTMs alone when no click ID is present — an organic lead still gets a touch", () => {
    const got = promoteAttributionFromCustomFields({ utm_source: "newsletter", utm_medium: "email" });
    expect(got?.utm).toEqual({ source: "newsletter", medium: "email" });
    expect(got?.clickIds).toBeUndefined();
  });

  it("carries the full utm_* set", () => {
    const got = promoteAttributionFromCustomFields({
      utm_source: "s", utm_medium: "m", utm_campaign: "c", utm_content: "ct", utm_term: "t",
    });
    expect(got?.utm).toEqual({ source: "s", medium: "m", campaign: "c", content: "ct", term: "t" });
  });
});
