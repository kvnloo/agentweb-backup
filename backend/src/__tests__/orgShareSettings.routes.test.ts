import express from "express";
import request from "supertest";

const mockGetUserById = jest.fn();
const mockGetOrgById = jest.fn();
const mockUpdateShareSettings = jest.fn();
const mockGetOrgMembers = jest.fn();

jest.mock("../services/db", () => ({
  userDb: { getUserById: (...a: any[]) => mockGetUserById(...a) },
  orgDb: {
    getOrgById:           (...a: any[]) => mockGetOrgById(...a),
    updateShareSettings:  (...a: any[]) => mockUpdateShareSettings(...a),
    getOrgMembers:        (...a: any[]) => mockGetOrgMembers(...a),
  },
}));

import routes from "../routes/orgShareSettings";

function makeApp(userId: string) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as any).user = { userId }; next(); });
  app.use("/api/orgs/me/share-settings", routes);
  return app;
}

const sampleSettings = {
  knowledgeBase:     { enabled: false, editors: [] },
  htmlTemplates:     { enabled: true,  editors: ["u-2"] },
  landingPages:      { enabled: false, editors: [] },
  workPlans:         { enabled: true,  editors: [] },
  skills:            { enabled: false, editors: [] },
  analytics:         { enabled: false, editors: [] },
  brandGuidelines:   { editors: [] },
  marketingStrategy: { editors: [] },
};

beforeEach(() => {
  mockGetUserById.mockReset();
  mockGetOrgById.mockReset();
  mockUpdateShareSettings.mockReset();
  mockGetOrgMembers.mockReset();
});

describe("GET /api/orgs/me/share-settings", () => {
  it("returns settings to a member", async () => {
    mockGetUserById.mockResolvedValueOnce({ userId: "u-1", orgId: "org-1", orgRole: "member" });
    mockGetOrgById.mockResolvedValueOnce({
      orgId: "org-1",
      shareSettings: sampleSettings,
      updatedAt: "2026-08-10T15:00:00.000Z",
    });
    const res = await request(makeApp("u-1")).get("/api/orgs/me/share-settings");
    expect(res.status).toBe(200);
    expect(res.body.shareSettings).toEqual({
      ...sampleSettings,
      _revision: "2026-08-10T15:00:00.000Z",
    });
  });
  it("404s if user has no org", async () => {
    mockGetUserById.mockResolvedValueOnce({ userId: "u-1" });
    const res = await request(makeApp("u-1")).get("/api/orgs/me/share-settings");
    expect(res.status).toBe(404);
  });
});

describe("PATCH /api/orgs/me/share-settings", () => {
  const validBody = {
    shareSettings: {
      ...sampleSettings,
      _revision: "2026-08-10T14:00:00.000Z",
    },
  };

  it("requires the revision from the client's prior read", async () => {
    mockGetUserById.mockResolvedValueOnce({ userId: "u-1", orgId: "org-1", orgRole: "owner" });
    mockGetOrgById.mockResolvedValueOnce({
      orgId: "org-1",
      updatedAt: "2026-08-10T15:00:00.000Z",
      shareSettings: sampleSettings,
    });

    const res = await request(makeApp("u-1"))
      .patch("/api/orgs/me/share-settings")
      .send({ shareSettings: sampleSettings });

    expect(res.status).toBe(428);
    expect(mockUpdateShareSettings).not.toHaveBeenCalled();
  });

  it("rejects non-admin caller with 403", async () => {
    mockGetUserById.mockResolvedValueOnce({ userId: "u-1", orgId: "org-1", orgRole: "member" });
    mockGetOrgById.mockResolvedValueOnce({ orgId: "org-1", shareSettings: sampleSettings });
    const res = await request(makeApp("u-1"))
      .patch("/api/orgs/me/share-settings").send(validBody);
    expect(res.status).toBe(403);
    expect(mockUpdateShareSettings).not.toHaveBeenCalled();
  });

  it("accepts admin caller and writes", async () => {
    mockGetUserById.mockResolvedValueOnce({ userId: "u-1", orgId: "org-1", orgRole: "owner" });
    mockGetOrgById.mockResolvedValueOnce({ orgId: "org-1" });
    mockGetOrgMembers.mockResolvedValueOnce([
      { userId: "u-1" }, { userId: "u-2" },
    ]);
    mockUpdateShareSettings.mockResolvedValueOnce("2026-08-10T15:00:00.001Z");

    const res = await request(makeApp("u-1"))
      .patch("/api/orgs/me/share-settings").send(validBody);
    expect(res.status).toBe(200);
    expect(mockUpdateShareSettings).toHaveBeenCalledWith(
      "org-1",
      expect.not.objectContaining({ _revision: expect.anything() }),
      "2026-08-10T14:00:00.000Z"
    );
    expect(res.body.shareSettings._revision).toBe("2026-08-10T15:00:00.001Z");
  });

  it("guards the write with the client's revision rather than a fresh route read", async () => {
    mockGetUserById.mockResolvedValueOnce({ userId: "u-1", orgId: "org-1", orgRole: "owner" });
    mockGetOrgById.mockResolvedValueOnce({
      orgId: "org-1",
      updatedAt: "2026-08-10T15:00:00.000Z",
      shareSettings: sampleSettings,
    });
    mockGetOrgMembers.mockResolvedValueOnce([{ userId: "u-1" }, { userId: "u-2" }]);
    mockUpdateShareSettings.mockRejectedValueOnce(
      Object.assign(new Error("conditional check failed"), { code: "ConditionalCheckFailedException" })
    );

    const res = await request(makeApp("u-1"))
      .patch("/api/orgs/me/share-settings")
      .send(validBody);

    expect(res.status).toBe(409);
    expect(mockUpdateShareSettings).toHaveBeenCalledWith(
      "org-1",
      expect.any(Object),
      "2026-08-10T14:00:00.000Z"
    );
  });

  it("returns 409 on a concurrent-write conflict without retrying the stale document", async () => {
    mockGetUserById.mockResolvedValueOnce({ userId: "u-1", orgId: "org-1", orgRole: "owner" });
    mockGetOrgById.mockResolvedValueOnce({ orgId: "org-1", updatedAt: "2026-08-10T15:00:00.000Z" });
    mockGetOrgMembers.mockResolvedValueOnce([{ userId: "u-1" }, { userId: "u-2" }]);
    mockUpdateShareSettings.mockRejectedValueOnce(
      Object.assign(new Error("conditional check failed"), { code: "ConditionalCheckFailedException" })
    );

    const res = await request(makeApp("u-1"))
      .patch("/api/orgs/me/share-settings").send(validBody);
    expect(res.status).toBe(409);
    // Blind-retrying the client's stale full document would erase the
    // concurrent writer's change — the write must happen exactly once.
    expect(mockUpdateShareSettings).toHaveBeenCalledTimes(1);
  });

  it("rejects editors who are not org members with 400", async () => {
    mockGetUserById.mockResolvedValueOnce({ userId: "u-1", orgId: "org-1", orgRole: "owner" });
    mockGetOrgById.mockResolvedValueOnce({ orgId: "org-1" });
    mockGetOrgMembers.mockResolvedValueOnce([{ userId: "u-1" }]);
    const bad = {
      shareSettings: {
        ...sampleSettings,
        _revision: "2026-08-10T14:00:00.000Z",
        htmlTemplates: { enabled: true, editors: ["u-not-in-org"] },
      },
    };
    const res = await request(makeApp("u-1"))
      .patch("/api/orgs/me/share-settings").send(bad);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/editor/i);
  });

  it("rejects missing required feature key with 400", async () => {
    mockGetUserById.mockResolvedValueOnce({ userId: "u-1", orgId: "org-1", orgRole: "owner" });
    mockGetOrgById.mockResolvedValueOnce({ orgId: "org-1" });
    const bad = {
      shareSettings: {
        ...sampleSettings,
        _revision: "2026-08-10T14:00:00.000Z",
        brandGuidelines: undefined,
      },
    };
    const res = await request(makeApp("u-1"))
      .patch("/api/orgs/me/share-settings").send(bad);
    expect(res.status).toBe(400);
  });
});
