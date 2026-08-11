/**
 * ENG-721: admin discovery/reassociation of landing pages by URL or org.
 *
 * Behavioral assertions (from the human-written acceptance criteria):
 *  AC1 — an admin can resolve a landing page by URL/domain even when it is
 *        owned by a different account (and gets the owner + org back).
 *  AC2 — an admin can enable org-level landing-page visibility and grant a
 *        named org member edit access without raw DB access, without
 *        duplicating or redeploying the page.
 *  AC3 — the member's effective view is verifiable: canonical URL, deployed
 *        status, editability, connected lead list.
 *  AC4 — every cross-account mutation is authorization-checked and audited.
 */
import request from "supertest";
import express from "express";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const adminId = "admin-1";
const ownerId = "owner-1";
const memberId = "member-1";
const outsiderId = "outsider-1";
const orgId = "org-rankai";

const page = {
  id: "page-1",
  userId: ownerId,
  name: "Book a Demo",
  status: "deployed",
  deployedUrl: "https://rankai.agentwebforms.com/book-a-demo",
  customDomainUrl: "",
  leadListId: "list-123",
  iterations: 2,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const ownerUser = { userId: ownerId, email: "admin@rankai.ai", orgId, orgRole: "owner" };
const memberUser = { userId: memberId, email: "hugo@rankai.ai", orgId, orgRole: "member" };
const outsiderUser = { userId: outsiderId, email: "x@other.com", orgId: "org-other", orgRole: "member" };

const baseOrg = {
  orgId,
  ownerUserId: ownerId,
  shareSettings: {
    knowledgeBase: { enabled: true, editors: [] },
    htmlTemplates: { enabled: true, editors: [] },
    landingPages: { enabled: false, editors: [] },
    workPlans: { enabled: true, editors: [] },
    skills: { enabled: true, editors: [] },
    analytics: { enabled: true, editors: [] },
    brandGuidelines: { editors: [] },
    marketingStrategy: { editors: [] },
  },
};

// ---------------------------------------------------------------------------
// Mock aws-sdk (required transitively)
// ---------------------------------------------------------------------------
jest.mock("aws-sdk", () => {
  const mockFn = jest.fn().mockReturnValue({ promise: () => Promise.resolve({}) });
  const DocumentClient = jest.fn().mockImplementation(() => ({
    put: mockFn, update: mockFn, get: mockFn, query: mockFn, delete: mockFn, scan: mockFn,
  }));
  const SecretsManager = jest.fn().mockImplementation(() => ({
    getSecretValue: jest.fn().mockReturnValue({
      promise: () => Promise.resolve({ SecretString: '{"apiKey":"test-key"}' }),
    }),
  }));
  return {
    __esModule: true,
    default: { DynamoDB: { DocumentClient }, SecretsManager, config: { update: jest.fn() } },
    DynamoDB: { DocumentClient },
    SecretsManager,
    config: { update: jest.fn() },
  };
});

// ---------------------------------------------------------------------------
// Mock services
// ---------------------------------------------------------------------------
const mockAdminFindLandingPagesByUrl = jest.fn();
const mockGetLandingPageById = jest.fn();
const mockGetLandingPageLiveUrl = jest.fn(
  (p: any) => p.customDomainUrl || p.deployedUrl || ""
);
jest.mock("../services/v0Service", () => ({
  adminFindLandingPagesByUrl: (...a: any[]) => mockAdminFindLandingPagesByUrl(...a),
  getLandingPageById: (...a: any[]) => mockGetLandingPageById(...a),
  getLandingPageLiveUrl: (p: any) => mockGetLandingPageLiveUrl(p),
}));

const mockGetUserById = jest.fn();
const mockGetUserByEmail = jest.fn();
const mockGetUserByEmailConsistent = jest.fn();
const mockGetOrgById = jest.fn();
const mockGetOrgMembers = jest.fn();
const mockUpdateShareSettings = jest.fn();
jest.mock("../services/db", () => ({
  userDb: {
    getUserById: (...a: any[]) => mockGetUserById(...a),
    getUserByEmail: (...a: any[]) => mockGetUserByEmail(...a),
    getUserByEmailConsistent: (...a: any[]) => mockGetUserByEmailConsistent(...a),
  },
  orgDb: {
    getOrgById: (...a: any[]) => mockGetOrgById(...a),
    getOrgMembers: (...a: any[]) => mockGetOrgMembers(...a),
    updateShareSettings: (...a: any[]) => mockUpdateShareSettings(...a),
  },
}));

const mockRecordAdminAudit = jest.fn();
jest.mock("../services/adminAuditLog", () => ({
  recordAdminAudit: (...a: any[]) => mockRecordAdminAudit(...a),
}));

import adminLandingPagesRoutes from "../routes/adminLandingPages";

// ---------------------------------------------------------------------------
// App under test: auth middleware stub injects req.user
// ---------------------------------------------------------------------------
function makeApp(user: { userId: string; email: string; isAdmin: boolean }) {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => { req.user = user; next(); });
  // Mirror the app.ts admin gate so non-admin denial is covered here too.
  app.use((req: any, res, next) => {
    if (!req.user?.isAdmin) return res.status(403).json({ message: "Admin access required" });
    next();
  });
  app.use("/api/admin/landing-pages", adminLandingPagesRoutes);
  return app;
}

const admin = { userId: adminId, email: "harsha@agentweb.pro", isAdmin: true };
const nonAdmin = { userId: outsiderId, email: "x@other.com", isAdmin: false };

beforeEach(() => {
  jest.clearAllMocks();
  // clear queued once-values as well as call history so a fail-closed early
  // return in one concurrency test cannot leak a response into the next one
  mockUpdateShareSettings.mockReset();
  mockGetUserByEmailConsistent.mockReset();
  mockGetUserById.mockImplementation(async (id: string) =>
    ({ [ownerId]: ownerUser, [memberId]: memberUser, [outsiderId]: outsiderUser } as any)[id] ?? null
  );
  mockGetUserByEmail.mockImplementation(async (email: string) =>
    [ownerUser, memberUser, outsiderUser].find((u) => u.email === email.toLowerCase()) ?? null
  );
  mockGetUserByEmailConsistent.mockImplementation(async (email: string) =>
    [ownerUser, memberUser, outsiderUser].find((u) => u.email === email.toLowerCase()) ?? null
  );
  mockGetOrgById.mockResolvedValue(JSON.parse(JSON.stringify(baseOrg)));
  mockGetOrgMembers.mockResolvedValue([ownerUser, memberUser]);
  mockGetLandingPageById.mockResolvedValue(page);
  mockAdminFindLandingPagesByUrl.mockResolvedValue({ matches: [page], scannedAll: true });
});

// ---------------------------------------------------------------------------
// Guard
// ---------------------------------------------------------------------------
describe("admin gate", () => {
  it("denies non-admin callers on every route", async () => {
    const app = makeApp(nonAdmin);
    const r1 = await request(app).get("/api/admin/landing-pages/resolve?url=https://rankai.agentwebforms.com/book-a-demo");
    const r2 = await request(app).post("/api/admin/landing-pages/page-1/org-share").send({ memberEmails: ["hugo@rankai.ai"] });
    const r3 = await request(app).get("/api/admin/landing-pages/page-1/effective-view?member=hugo@rankai.ai");
    expect([r1.status, r2.status, r3.status]).toEqual([403, 403, 403]);
    expect(mockUpdateShareSettings).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// AC1 — resolve by URL across accounts
// ---------------------------------------------------------------------------
describe("GET /resolve", () => {
  it("resolves a page owned by another account by URL and returns owner + org", async () => {
    const app = makeApp(admin);
    const res = await request(app).get(
      "/api/admin/landing-pages/resolve?url=" +
        encodeURIComponent("https://rankai.agentwebforms.com/book-a-demo")
    );
    expect(res.status).toBe(200);
    expect(res.body.matches).toHaveLength(1);
    const m = res.body.matches[0];
    expect(m.page.id).toBe("page-1");
    expect(m.owner).toMatchObject({ userId: ownerId, email: "admin@rankai.ai", orgId });
    expect(m.liveUrl).toBe("https://rankai.agentwebforms.com/book-a-demo");
    expect(mockAdminFindLandingPagesByUrl).toHaveBeenCalledWith(
      "https://rankai.agentwebforms.com/book-a-demo"
    );
  });

  it("returns 400 on a missing/invalid url param", async () => {
    const app = makeApp(admin);
    const r1 = await request(app).get("/api/admin/landing-pages/resolve");
    const r2 = await request(app).get("/api/admin/landing-pages/resolve?url=notaurl%20at%20all");
    expect(r1.status).toBe(400);
    expect(r2.status).toBe(400);
  });

  it("returns 404 with an empty match list when nothing matches", async () => {
    mockAdminFindLandingPagesByUrl.mockResolvedValue({ matches: [], scannedAll: true });
    const app = makeApp(admin);
    const res = await request(app).get(
      "/api/admin/landing-pages/resolve?url=" + encodeURIComponent("https://nope.example.com/x")
    );
    expect(res.status).toBe(404);
    expect(res.body.matches).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// AC2 + AC4 — org-share mutation
// ---------------------------------------------------------------------------
describe("POST /:id/org-share", () => {
  it("enables org landing-page sharing and grants the named member edit access, with audit", async () => {
    const app = makeApp(admin);
    const res = await request(app)
      .post("/api/admin/landing-pages/page-1/org-share")
      .send({ memberEmails: ["hugo@rankai.ai"] });
    expect(res.status).toBe(200);

    expect(mockUpdateShareSettings).toHaveBeenCalledTimes(1);
    const [calledOrgId, settings] = mockUpdateShareSettings.mock.calls[0];
    expect(calledOrgId).toBe(orgId);
    expect(settings.landingPages.enabled).toBe(true);
    expect(settings.landingPages.editors).toContain(memberId);
    // Other features untouched
    expect(settings.knowledgeBase).toEqual(baseOrg.shareSettings.knowledgeBase);

    // AC4: audited with actor, target, and action
    expect(mockRecordAdminAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: adminId,
        action: "landing_page_org_share",
        pageId: "page-1",
        orgId,
        grantedEditorUserIds: [memberId],
      })
    );

    // Response reports the member's effective access (AC3 wiring)
    expect(res.body.members).toEqual([
      expect.objectContaining({ userId: memberId, email: "hugo@rankai.ai", canEdit: true, canView: true }),
    ]);
    expect(res.body.page.id).toBe("page-1");
  });

  it("is idempotent: an already-listed editor is not duplicated", async () => {
    mockGetOrgById.mockResolvedValue({
      ...JSON.parse(JSON.stringify(baseOrg)),
      shareSettings: {
        ...JSON.parse(JSON.stringify(baseOrg.shareSettings)),
        landingPages: { enabled: true, editors: [memberId] },
      },
    });
    const app = makeApp(admin);
    const res = await request(app)
      .post("/api/admin/landing-pages/page-1/org-share")
      .send({ memberEmails: ["hugo@rankai.ai"] });
    expect(res.status).toBe(200);
    const [, settings] = mockUpdateShareSettings.mock.calls[0];
    expect(settings.landingPages.editors).toEqual([memberId]);
  });

  it("rejects a member outside the owner's org and performs no mutation", async () => {
    const app = makeApp(admin);
    const res = await request(app)
      .post("/api/admin/landing-pages/page-1/org-share")
      .send({ memberEmails: ["x@other.com"] });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/not a member/i);
    expect(mockUpdateShareSettings).not.toHaveBeenCalled();
    expect(mockRecordAdminAudit).not.toHaveBeenCalled();
  });

  it("rejects when the page owner has no org", async () => {
    mockGetUserById.mockImplementation(async (id: string) =>
      id === ownerId ? { ...ownerUser, orgId: undefined } : null
    );
    const app = makeApp(admin);
    const res = await request(app)
      .post("/api/admin/landing-pages/page-1/org-share")
      .send({ memberEmails: ["hugo@rankai.ai"] });
    expect(res.status).toBe(400);
    expect(mockUpdateShareSettings).not.toHaveBeenCalled();
  });

  it("404s on an unknown page id", async () => {
    mockGetLandingPageById.mockResolvedValue(null);
    const app = makeApp(admin);
    const res = await request(app)
      .post("/api/admin/landing-pages/missing/org-share")
      .send({ memberEmails: ["hugo@rankai.ai"] });
    expect(res.status).toBe(404);
    expect(mockUpdateShareSettings).not.toHaveBeenCalled();
  });

  it("re-reads and re-applies the grant when a concurrent writer changed shareSettings", async () => {
    // First write loses the optimistic-concurrency race; the re-read returns a
    // document where a concurrent request granted an analytics editor. The
    // retry must preserve that grant while still applying ours.
    const concurrentlyChanged = {
      ...JSON.parse(JSON.stringify(baseOrg)),
      updatedAt: "2026-08-10T15:00:00.000Z",
      shareSettings: {
        ...JSON.parse(JSON.stringify(baseOrg.shareSettings)),
        analytics: { enabled: true, editors: ["concurrent-editor"] },
      },
    };
    mockGetOrgById
      .mockResolvedValueOnce(JSON.parse(JSON.stringify(baseOrg)))
      .mockResolvedValueOnce(concurrentlyChanged);
    const conditionalFailure = Object.assign(new Error("conditional check failed"), {
      code: "ConditionalCheckFailedException",
    });
    mockUpdateShareSettings
      .mockRejectedValueOnce(conditionalFailure)
      .mockResolvedValueOnce(undefined);

    const app = makeApp(admin);
    const res = await request(app)
      .post("/api/admin/landing-pages/page-1/org-share")
      .send({ memberEmails: ["hugo@rankai.ai"] });
    expect(res.status).toBe(200);

    expect(mockUpdateShareSettings).toHaveBeenCalledTimes(2);
    const [, retriedSettings, expectedUpdatedAt] = mockUpdateShareSettings.mock.calls[1];
    // Concurrent writer's change survives the retry…
    expect(retriedSettings.analytics.editors).toContain("concurrent-editor");
    // …and our grant is applied on top of the fresh document.
    expect(retriedSettings.landingPages.editors).toContain(memberId);
    expect(expectedUpdatedAt).toBe("2026-08-10T15:00:00.000Z");
  });

  it("revalidates a user-id grant when its first lookup omitted the canonical email", async () => {
    const userWithoutProjectedEmail = { ...memberUser, email: undefined };
    mockGetUserById.mockImplementation(async (id: string) =>
      ({
        [ownerId]: ownerUser,
        [memberId]: userWithoutProjectedEmail,
        [outsiderId]: outsiderUser,
      } as any)[id] ?? null
    );
    mockGetOrgById
      .mockResolvedValueOnce(JSON.parse(JSON.stringify(baseOrg)))
      .mockResolvedValueOnce({
        ...JSON.parse(JSON.stringify(baseOrg)),
        updatedAt: "2026-08-10T15:00:00.000Z",
      });
    mockUpdateShareSettings
      .mockRejectedValueOnce(
        Object.assign(new Error("conditional check failed"), { code: "ConditionalCheckFailedException" })
      )
      .mockResolvedValueOnce(undefined);

    const app = makeApp(admin);
    const res = await request(app)
      .post("/api/admin/landing-pages/page-1/org-share")
      .send({ memberUserIds: [memberId] });

    expect(res.status).toBe(200);
    expect(mockGetUserByEmailConsistent).toHaveBeenCalledWith(memberUser.email);
    expect(mockUpdateShareSettings).toHaveBeenCalledTimes(2);
  });

  it("409s when the retried grant targets a member removed by the concurrent writer", async () => {
    // Departed-member cleanup wins the race: the re-read org no longer lists
    // the target member. Re-applying the stale grant would silently restore
    // their editor entry, so the route must fail closed instead.
    mockGetOrgById
      .mockResolvedValueOnce(JSON.parse(JSON.stringify(baseOrg)))
      .mockResolvedValueOnce({
        ...JSON.parse(JSON.stringify(baseOrg)),
        updatedAt: "2026-08-10T15:00:00.000Z",
      });
    // The OrgIdIndex can still return a stale member after departure. The
    // retry must fail closed using a strongly consistent primary-key read.
    mockGetOrgMembers.mockResolvedValue([ownerUser, memberUser]);
    mockGetUserByEmailConsistent.mockResolvedValueOnce({
      ...memberUser,
      orgId: "org-other",
    });
    mockUpdateShareSettings.mockRejectedValueOnce(
      Object.assign(new Error("conditional check failed"), { code: "ConditionalCheckFailedException" })
    );

    const app = makeApp(admin);
    const res = await request(app)
      .post("/api/admin/landing-pages/page-1/org-share")
      .send({ memberEmails: ["hugo@rankai.ai"] });
    expect(res.status).toBe(409);
    expect(mockGetUserByEmailConsistent).toHaveBeenCalledWith(memberUser.email);
    expect(mockUpdateShareSettings).toHaveBeenCalledTimes(1);
    expect(mockRecordAdminAudit).not.toHaveBeenCalled();
  });

  it("fails loudly when the conditional write keeps losing the race", async () => {
    const conditionalFailure = Object.assign(new Error("conditional check failed"), {
      code: "ConditionalCheckFailedException",
    });
    mockUpdateShareSettings.mockRejectedValue(conditionalFailure);
    const app = makeApp(admin);
    const res = await request(app)
      .post("/api/admin/landing-pages/page-1/org-share")
      .send({ memberEmails: ["hugo@rankai.ai"] });
    expect(res.status).toBe(500);
    expect(mockUpdateShareSettings).toHaveBeenCalledTimes(5);
    expect(mockRecordAdminAudit).not.toHaveBeenCalled();
  });

  it("requires at least one member", async () => {
    const app = makeApp(admin);
    const res = await request(app).post("/api/admin/landing-pages/page-1/org-share").send({});
    expect(res.status).toBe(400);
    expect(mockUpdateShareSettings).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// AC3 — effective view
// ---------------------------------------------------------------------------
describe("GET /:id/effective-view", () => {
  it("reports an editor member as canView/canEdit with canonical URL, status, and lead list", async () => {
    mockGetOrgById.mockResolvedValue({
      ...JSON.parse(JSON.stringify(baseOrg)),
      shareSettings: {
        ...JSON.parse(JSON.stringify(baseOrg.shareSettings)),
        landingPages: { enabled: true, editors: [memberId] },
      },
    });
    const app = makeApp(admin);
    const res = await request(app).get(
      "/api/admin/landing-pages/page-1/effective-view?member=hugo@rankai.ai"
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      member: { userId: memberId, email: "hugo@rankai.ai" },
      canView: true,
      canEdit: true,
      liveUrl: "https://rankai.agentwebforms.com/book-a-demo",
      status: "deployed",
      leadListId: "list-123",
    });
  });

  it("reports a non-shared member as no-view/no-edit rather than erroring", async () => {
    // baseOrg has landingPages.enabled=false and no editors
    const app = makeApp(admin);
    const res = await request(app).get(
      "/api/admin/landing-pages/page-1/effective-view?member=hugo@rankai.ai"
    );
    expect(res.status).toBe(200);
    expect(res.body.canView).toBe(false);
    expect(res.body.canEdit).toBe(false);
  });

  it("404s on an unknown member", async () => {
    const app = makeApp(admin);
    const res = await request(app).get(
      "/api/admin/landing-pages/page-1/effective-view?member=ghost@rankai.ai"
    );
    expect(res.status).toBe(404);
  });
});
