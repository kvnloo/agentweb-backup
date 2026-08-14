/**
 * fetchGoogleAnalyticsMetrics — topPagesBySessions (ENG-1187)
 *
 * A page with heavy session volume but middling engagement can be absent from GA4's
 * top-20-by-engagement result entirely. topPagesBySessions must come from its own
 * sessions-ordered query, not a re-sort of topPagesByEngagement's rows — a re-sort of
 * that subset would silently omit exactly this kind of page and present an incomplete
 * ranking as authoritative (the same class of bug ENG-1187 was filed for).
 */

const mockRunReport = jest.fn();

jest.mock("../services/db", () => ({
  userDb: { getUserById: jest.fn() },
}));

jest.mock("../utils/secretsManager", () => ({
  getSecret: jest.fn().mockResolvedValue(
    JSON.stringify({ client_email: "test@example.com", private_key: "test-key" })
  ),
}));

jest.mock("@google-analytics/data", () => ({
  BetaAnalyticsDataClient: jest.fn().mockImplementation(() => ({
    runReport: mockRunReport,
  })),
}));

import { userDb } from "../services/db";
import { fetchGoogleAnalyticsMetrics } from "../services/seoService";

const mockGetUserById = userDb.getUserById as jest.Mock;

function pageRow(pagePath: string, sessions: number, engagementRate: number, userEngagementDuration: number) {
  return {
    dimensionValues: [{ value: pagePath }, { value: "example.com" }],
    metricValues: [
      { value: String(sessions) },
      { value: String(engagementRate) },
      { value: String(userEngagementDuration) },
      { value: "10" },
    ],
  };
}

const HIGH_ENGAGEMENT_PAGE = pageRow("/low-volume-high-engagement", 50, 0.9, 500);
const HIGH_SESSIONS_PAGE = pageRow("/high-volume-low-engagement", 9000, 0.05, 20);

describe("fetchGoogleAnalyticsMetrics — topPagesBySessions", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetUserById.mockResolvedValue({ id: "user-1" });

    mockRunReport.mockImplementation(async (req: any) => {
      const orderMetric = req.orderBys?.[0]?.metric?.metricName;
      const dimensionNames = (req.dimensions || []).map((d: any) => d.name);

      if (dimensionNames.includes("pagePath")) {
        if (orderMetric === "userEngagementDuration") {
          // GA4's own top-20-by-engagement — the high-session page never makes this list.
          return [{ rows: [HIGH_ENGAGEMENT_PAGE] }];
        }
        if (orderMetric === "sessions") {
          return [{ rows: [HIGH_SESSIONS_PAGE, HIGH_ENGAGEMENT_PAGE] }];
        }
      }
      // Overall metrics, daily timeline, traffic sources, conversions-by-source: not under test.
      return [{ rows: [] }];
    });
  });

  it("does not omit a high-session page just because it fell outside the engagement top-20", async () => {
    const resolvedConfig = {
      properties: [{ propertyId: "123456789", label: "Main Site" }],
      clarityProjects: [],
      gaFilteredDomains: [],
    } as any;

    const result = await fetchGoogleAnalyticsMetrics("user-1", "30d", undefined, resolvedConfig);

    const propertyMetrics = result.metrics[0];
    expect(propertyMetrics.topPagesByEngagement.map((p: any) => p.pageTitle)).toEqual([
      "/low-volume-high-engagement",
    ]);
    // The regression this test guards: a re-sort of topPagesByEngagement would have produced
    // the exact same single-page list above instead of surfacing the true top session page.
    expect(propertyMetrics.topPagesBySessions.map((p: any) => p.pageTitle)).toEqual([
      "/high-volume-low-engagement",
      "/low-volume-high-engagement",
    ]);
  });

  it("queries topPagesBySessions ordered by sessions, independently of the engagement query", async () => {
    const resolvedConfig = {
      properties: [{ propertyId: "123456789", label: "Main Site" }],
      clarityProjects: [],
      gaFilteredDomains: [],
    } as any;

    await fetchGoogleAnalyticsMetrics("user-1", "30d", undefined, resolvedConfig);

    const pageQueries = mockRunReport.mock.calls
      .map(([req]: any[]) => req)
      .filter((req: any) => (req.dimensions || []).some((d: any) => d.name === "pagePath"));

    expect(pageQueries).toHaveLength(2);
    expect(pageQueries.map((req: any) => req.orderBys[0].metric.metricName).sort()).toEqual([
      "sessions",
      "userEngagementDuration",
    ]);
  });

  it("does not present a failed sessions query as an empty (zero-page) ranking", async () => {
    mockRunReport.mockImplementation(async (req: any) => {
      const orderMetric = req.orderBys?.[0]?.metric?.metricName;
      const dimensionNames = (req.dimensions || []).map((d: any) => d.name);

      if (dimensionNames.includes("pagePath")) {
        if (orderMetric === "userEngagementDuration") {
          return [{ rows: [HIGH_ENGAGEMENT_PAGE] }];
        }
        if (orderMetric === "sessions") {
          throw new Error("GA4 quota exceeded");
        }
      }
      return [{ rows: [] }];
    });

    const resolvedConfig = {
      properties: [{ propertyId: "123456789", label: "Main Site" }],
      clarityProjects: [],
      gaFilteredDomains: [],
    } as any;

    const result = await fetchGoogleAnalyticsMetrics("user-1", "30d", undefined, resolvedConfig);
    const propertyMetrics = result.metrics[0];

    // A silent [] here would read as "GA4 confirms zero session data" — indistinguishable
    // from a real empty result. The field must be absent, with the failure surfaced instead.
    expect(propertyMetrics.topPagesBySessions).toBeUndefined();
    expect(propertyMetrics.topPagesBySessionsError).toEqual(expect.stringContaining("Could not fetch"));
    // The engagement query succeeding independently must still come through.
    expect(propertyMetrics.topPagesByEngagement).toHaveLength(1);
  });
});
