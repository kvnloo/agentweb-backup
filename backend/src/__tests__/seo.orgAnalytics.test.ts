import request from "supertest";
import express from "express";
import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET || "your-secret-key";

// Mock authenticateToken to decode the real JWT from the Authorization header
// and populate req.user — the seo router applies router.use(authenticateToken).
jest.mock("../middleware/auth", () => ({
  authenticateToken: (req: any, res: any, next: any) => {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    try {
      req.user = jwt.verify(token, JWT_SECRET);
      next();
    } catch {
      res.status(401).json({ message: "Unauthorized" });
    }
  },
}));

jest.mock("../services/db", () => ({
  userDb: {
    getUserById: jest.fn(),
  },
  orgDb: {
    getOrgById: jest.fn(),
  },
}));

// Records the `settingName` of every AW-Settings get so tests can assert which
// owner's funnel map was looked up.
const awSettingsGetKeys: string[] = [];
jest.mock("aws-sdk", () => ({
  DynamoDB: {
    DocumentClient: jest.fn().mockImplementation(() => ({
      get: (params: any) => {
        const settingName = params?.Key?.settingName;
        if (typeof settingName === "string") awSettingsGetKeys.push(settingName);
        return {
          promise: () =>
            Promise.resolve({
              Item: {
                settingName,
                funnels: {
                  "f-b": {
                    name: "Funnel B",
                    stages: [{ name: "Visit", type: "pageview" }],
                  },
                },
              },
            }),
        };
      },
    })),
  },
}));

// Stub seoService so the handlers don't reach real Google APIs.
jest.mock("../services/seoService", () => ({
  getGoogleSearchConsoleAccessToken: jest.fn().mockResolvedValue("test-token"),
  getGoogleAnalyticsDataClient: jest.fn().mockResolvedValue(null),
  getTechnicalSeoScore: jest.fn().mockResolvedValue(null),
}));

// Stub funnelService — not exercised by these tests.
jest.mock("../services/funnelService", () => ({
  calculateFunnelMetrics: jest.fn().mockResolvedValue({}),
  DEFAULT_FUNNEL_STAGES: [],
  validateFunnelStages: jest.fn(),
}));

// Stub secretsManager so getLandingPagesConfig resolves cleanly.
jest.mock("../utils/secretsManager", () => ({
  getSecret: jest.fn().mockResolvedValue(null),
  getLandingPagesConfig: jest.fn().mockResolvedValue(null),
}));

// Mock the analytics config resolver — the focus of this task.
jest.mock("../services/analyticsConfigResolver", () => ({
  resolveAnalyticsConfig: jest.fn(),
}));

// ---------------------------------------------------------------------------
// Google Search Console transport stub (ENG-960)
//
// `routes/seo.ts` reaches Search Console through the *global* `fetch`, not
// through `seoService`. Stubbing `seoService` above only replaces the token
// helper (`getGoogleSearchConsoleAccessToken`) — it does not intercept the
// request. So before this stub, every `/metrics` test issued a real HTTPS POST
// to https://www.googleapis.com/webmasters/v3/... and received a live
// `401 UNAUTHENTICATED` from Google's production API. Test duration was
// therefore set by an uncontrolled third-party network round trip; under CI
// contention its long tail crossed jest's 5000 ms per-test budget and the suite
// flaked intermittently (ENG-960).
//
// Stubbing the transport is not masking the flake — it removes the suite's
// dependency on internet egress and on Google's production API, and it
// *strengthens* coverage: the handler's success path (parsing the daily,
// overall, query and page responses) had never once been exercised, because the
// live 401 short-circuited the domain out on its very first request every run.
// ---------------------------------------------------------------------------
const GSC_ORIGIN = "https://www.googleapis.com";

type GscCall = { url: string; authorization: string; body: any };
/** Every Search Console request the handler made, in order. */
const gscCalls: GscCall[] = [];

// Fixed Search Console payloads. Numbers are arbitrary but internally
// consistent so the handler's derived values (ctr, weighted position) are
// assertable.
const GSC_DAILY_ROWS = [
  { keys: ["2026-01-01"], clicks: 30, impressions: 400 },
  { keys: ["2026-01-02"], clicks: 70, impressions: 600 },
];
const GSC_OVERALL_ROW = {
  clicks: 100,
  impressions: 1000,
  ctr: 0.1,
  position: 8.5,
};
const GSC_QUERY_ROWS = [
  { keys: ["acme widgets"], clicks: 60, impressions: 600, position: 6 },
  { keys: ["acme pricing"], clicks: 40, impressions: 400, position: 12 },
];
const GSC_PAGE_ROWS = [
  { keys: ["https://acme.com/"], clicks: 55, impressions: 500, position: 7 },
  { keys: ["https://acme.com/pricing"], clicks: 45, impressions: 500, position: 10 },
];

/** Mirrors the Search Console contract: the response shape follows `dimensions`. */
function gscPayloadFor(body: any) {
  const dimension: string | undefined = body?.dimensions?.[0];
  if (dimension === undefined) return { rows: [GSC_OVERALL_ROW] };
  if (dimension === "date") return { rows: GSC_DAILY_ROWS };
  if (dimension === "query") return { rows: GSC_QUERY_ROWS };
  if (dimension === "page") return { rows: GSC_PAGE_ROWS };
  throw new Error(`Unexpected GSC dimension requested by the handler: ${dimension}`);
}

const realFetch = global.fetch;

function installGscFetchStub() {
  gscCalls.length = 0;
  global.fetch = jest.fn(async (input: any, init: any) => {
    const url = typeof input === "string" ? input : input?.url;
    // Fail loudly rather than silently reaching the network: if the handler
    // ever grows a call to a different host, this suite must go red instead of
    // quietly becoming network-dependent again.
    if (typeof url !== "string" || !url.startsWith(GSC_ORIGIN)) {
      throw new Error(
        `seo.orgAnalytics.test.ts attempted a live network call to ${url}. ` +
          `Tests must not reach third-party APIs — add a stub for it.`
      );
    }
    const body = init?.body ? JSON.parse(init.body) : {};
    gscCalls.push({
      url,
      authorization: init?.headers?.Authorization,
      body,
    });
    const payload = gscPayloadFor(body);
    return {
      ok: true,
      status: 200,
      json: async () => payload,
    };
  }) as unknown as typeof fetch;
}

import { userDb, orgDb } from "../services/db";
import { resolveAnalyticsConfig } from "../services/analyticsConfigResolver";
import seoRoutes from "../routes/seo";

const mockUserDb = userDb as jest.Mocked<typeof userDb>;
const mockOrgDb = orgDb as jest.Mocked<typeof orgDb>;
const mockResolve = resolveAnalyticsConfig as jest.MockedFunction<
  typeof resolveAnalyticsConfig
>;

const memberToken = jwt.sign(
  { userId: "member-1", email: "member@example.com", isAdmin: false },
  JWT_SECRET
);

const m1Token = jwt.sign(
  { userId: "m-1", email: "m1@example.com", isAdmin: false },
  JWT_SECRET
);

const app = express();
app.use(express.json());
app.use("/api/seo", seoRoutes);

describe("seo routes — org analytics inheritance", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    awSettingsGetKeys.length = 0;
    // Re-install per test: `clearMocks` resets call history, and a fresh stub
    // keeps each test's `gscCalls` assertions independent of run order.
    installGscFetchStub();
    // A member with no analytics config of their own.
    mockUserDb.getUserById.mockResolvedValue({
      userId: "member-1",
      email: "member@example.com",
      orgId: "org-1",
    } as any);
  });

  afterAll(() => {
    global.fetch = realFetch;
  });

  test("GET /metrics: member inherits org analytics — no not-configured 400", async () => {
    mockResolve.mockResolvedValue({
      properties: [{ propertyId: "OWNER-PROP", label: "Owner" }],
      primaryPropertyId: "OWNER-PROP",
      gaFilteredDomains: [],
      seoDomains: ["acme.com"],
      clarityProjects: [],
      source: "org",
    });
    const res = await request(app)
      .get("/api/seo/metrics")
      .set("Authorization", `Bearer ${memberToken}`);
    expect(res.status).not.toBe(400);

    // ENG-960: the inherited org domain must actually drive a Search Console
    // request, and its response must be parsed. Previously this suite reached
    // Google's live API, got a 401, and asserted only "not 400" — so it passed
    // whether or not the inherited config was used at all.
    expect(res.status).toBe(200);
    expect(gscCalls.length).toBeGreaterThan(0);
    expect(gscCalls[0].url).toBe(
      `${GSC_ORIGIN}/webmasters/v3/sites/${encodeURIComponent(
        "sc-domain:acme.com"
      )}/searchAnalytics/query`
    );
    expect(gscCalls[0].authorization).toBe("Bearer test-token");

    const metric = res.body.metrics[0];
    expect(metric.domain).toBe("acme.com");
    expect(metric.error).toBeUndefined();
    expect(metric.clicks).toBe(100);
    expect(metric.impressions).toBe(1000);
    expect(metric.ctr).toBeCloseTo(10);
    expect(metric.position).toBeCloseTo(8.5);
    expect(metric.dailyData).toHaveLength(2);
    expect(metric.topQueries[0].query).toBe("acme widgets");
    expect(metric.topPages[0].page).toBe("https://acme.com/");
  });

  test("GET /product-metrics: member inherits org productDomain — no not-configured 400", async () => {
    mockResolve.mockResolvedValue({
      properties: [{ propertyId: "OWNER-PROP", label: "Owner" }],
      primaryPropertyId: "OWNER-PROP",
      gaFilteredDomains: [],
      productDomain: "app.acme.com",
      seoDomains: [],
      clarityProjects: [],
      source: "org",
    });
    const res = await request(app)
      .get("/api/seo/product-metrics")
      .set("Authorization", `Bearer ${memberToken}`);
    expect(res.status).not.toBe(400);
  });

  test("GET /metrics looks the funnel up under funnelOwnerId, not the caller", async () => {
    // funnel f-b lives in funnels_m-2; caller is m-1 with view access
    mockResolve.mockResolvedValue({
      properties: [{ propertyId: "OWNER-PROP", label: "Owner" }],
      primaryPropertyId: "OWNER-PROP",
      gaFilteredDomains: [],
      seoDomains: ["acme.com"],
      clarityProjects: [],
      source: "org",
    });
    // m-1 (caller) and m-2 (funnel owner) are in the same org.
    mockUserDb.getUserById.mockImplementation((id: string) =>
      Promise.resolve(
        id === "m-2"
          ? ({ userId: "m-2", email: "m2@example.com", orgId: "org-1" } as any)
          : ({
              userId: "m-1",
              email: "m1@example.com",
              orgId: "org-1",
              orgRole: "member",
            } as any)
      )
    );
    // Org has funnel sharing enabled so m-1 can view m-2's funnel.
    mockOrgDb.getOrgById.mockResolvedValue({
      orgId: "org-1",
      ownerUserId: "m-owner",
      shareSettings: { analytics: { enabled: true, editors: [] } },
    } as any);

    const res = await request(app)
      .get("/api/seo/metrics?funnelId=f-b&funnelOwnerId=m-2")
      .set("Authorization", `Bearer ${m1Token}`);
    expect(res.status).toBe(200);
    // The AW-Settings get must have been keyed funnels_m-2
    expect(awSettingsGetKeys).toContain("funnels_m-2");
    // ENG-960: the org-inherited domain still drives a stubbed GSC request —
    // no live call, and the funnel lookup did not short-circuit metrics.
    expect(gscCalls[0].url).toContain(encodeURIComponent("sc-domain:acme.com"));
    expect(res.body.metrics[0].clicks).toBe(100);
  });
});
