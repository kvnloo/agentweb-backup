import { validateAnalyticsConfig } from "../services/analyticsConfigValidator";

describe("validateAnalyticsConfig", () => {
  test("empty input → ok with empty value", () => {
    const r = validateAnalyticsConfig({});
    expect(r.ok).toBe(true);
  });

  test("valid GA properties → ok, trimmed", () => {
    const r = validateAnalyticsConfig({
      googleAnalyticsProperties: [{ propertyId: " 123 ", label: " Main " }],
    });
    expect(r).toEqual({ ok: true, value: { googleAnalyticsProperties: [{ propertyId: "123", label: "Main" }] } });
  });

  test("non-numeric GA property id → error", () => {
    const r = validateAnalyticsConfig({ googleAnalyticsProperties: [{ propertyId: "G-ABC", label: "x" }] });
    expect(r.ok).toBe(false);
  });

  test("duplicate GA property id → error", () => {
    const r = validateAnalyticsConfig({
      googleAnalyticsProperties: [
        { propertyId: "1", label: "a" },
        { propertyId: "1", label: "b" },
      ],
    });
    expect(r.ok).toBe(false);
  });

  test("label over 100 chars → error", () => {
    const r = validateAnalyticsConfig({
      googleAnalyticsProperties: [{ propertyId: "1", label: "x".repeat(101) }],
    });
    expect(r.ok).toBe(false);
  });

  test("primaryAnalyticsPropertyId not in properties → error", () => {
    const r = validateAnalyticsConfig({
      googleAnalyticsProperties: [{ propertyId: "1", label: "a" }],
      primaryAnalyticsPropertyId: "999",
    });
    expect(r.ok).toBe(false);
  });

  test("primaryAnalyticsPropertyId in properties → ok", () => {
    const r = validateAnalyticsConfig({
      googleAnalyticsProperties: [{ propertyId: "1", label: "a" }],
      primaryAnalyticsPropertyId: "1",
    });
    expect(r.ok).toBe(true);
  });

  test("invalid Clarity project id → error", () => {
    const r = validateAnalyticsConfig({ clarityProjects: [{ projectId: "no", label: "x" }] });
    expect(r.ok).toBe(false);
  });

  test("valid Clarity project → ok", () => {
    const r = validateAnalyticsConfig({ clarityProjects: [{ projectId: "ul13e4f7fe", label: "Site" }] });
    expect(r.ok).toBe(true);
  });

  test("bad seo domain → error", () => {
    const r = validateAnalyticsConfig({ seoDomains: ["not a domain"] });
    expect(r.ok).toBe(false);
  });

  test("valid seo domain and url-prefix → ok", () => {
    const r = validateAnalyticsConfig({ seoDomains: ["acme.com", "https://blog.acme.com/"] });
    expect(r.ok).toBe(true);
  });

  test("gaFilteredDomains allows localhost and ip → ok", () => {
    const r = validateAnalyticsConfig({ gaFilteredDomains: ["localhost", "10.0.0.1", "app.acme.com"] });
    expect(r.ok).toBe(true);
  });

  test("bad productDomain → error", () => {
    const r = validateAnalyticsConfig({ productDomain: "bad domain" });
    expect(r.ok).toBe(false);
  });
});
