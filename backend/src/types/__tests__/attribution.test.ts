import { normalizeAttribution } from "../attribution";

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
