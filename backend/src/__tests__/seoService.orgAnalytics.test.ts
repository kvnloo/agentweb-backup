import { resolveAnalyticsConfig } from "../services/analyticsConfigResolver";

jest.mock("../services/analyticsConfigResolver");
jest.mock("../services/db", () => ({
  userDb: { getUserById: jest.fn().mockResolvedValue({ userId: "m-1", orgId: "org-1" }) },
}));

const mockResolve = resolveAnalyticsConfig as jest.MockedFunction<typeof resolveAnalyticsConfig>;

test("fetchGoogleAnalyticsMetrics uses resolver output, not raw user fields", async () => {
  mockResolve.mockResolvedValue({
    properties: [{ propertyId: "OWNER-PROP", label: "Owner" }],
    primaryPropertyId: "OWNER-PROP",
    gaFilteredDomains: [],
    seoDomains: [],
    clarityProjects: [],
    source: "org",
  });
  const { fetchGoogleAnalyticsMetrics } = await import("../services/seoService");
  const result = await fetchGoogleAnalyticsMetrics("m-1", "30d");
  // With no GA client configured in tests, it returns an error object (no
  // `message` field) — the point is it resolved OWNER-PROP rather than taking
  // the early "GA4 is not configured" return path (which sets `message`).
  expect(mockResolve).toHaveBeenCalled();
  expect(result.message ?? "").not.toMatch(/not configured/i);
});

test("fetchClarityProjectInfo with empty resolved clarity → not-configured message", async () => {
  mockResolve.mockResolvedValue({
    properties: [], primaryPropertyId: null, gaFilteredDomains: [],
    seoDomains: [], clarityProjects: [], source: "self",
  });
  const { fetchClarityProjectInfo } = await import("../services/seoService");
  const result = await fetchClarityProjectInfo("m-1");
  expect(result.message).toMatch(/Microsoft Clarity is not configured/);
});
