/**
 * Tests for org-wide funnel sharing on GET /api/funnels.
 *
 * The funnel router stores funnels in DynamoDB table AW-Settings keyed
 * `funnels_<userId>` via its internal getUserFunnels/saveUserFunnels helpers
 * (using AWS.DynamoDB.DocumentClient directly). These tests mock aws-sdk so
 * `get` on `funnels_<userId>` resolves that user's funnels map, and mock
 * ../services/db userDb/orgDb. orgShareService runs for real.
 */
import request from "supertest";
import express from "express";
import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET || "your-secret-key";

// ── Funnel fixtures keyed by owner userId ────────────────────────────────────
// Each entry is the FunnelsSettings map stored under `funnels_<userId>`.
const funnelsByUser: Record<string, any> = {};

function funnel(id: string) {
  return {
    id,
    name: `Funnel ${id}`,
    stages: [{ id: "s1", name: "Stage 1", order: 0 }],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
  };
}

// ── aws-sdk mock — DocumentClient.get reads funnelsByUser ────────────────────
jest.mock("aws-sdk", () => {
  const getFn = jest.fn().mockImplementation((params: any) => ({
    promise: () => {
      const settingName: string = params.Key.settingName;
      const match = settingName.match(/^funnels_(.+)$/);
      const ownerId = match ? match[1] : "";
      const funnels = funnelsByUser[ownerId];
      return Promise.resolve(funnels ? { Item: { settingName, funnels } } : {});
    },
  }));
  const noop = jest.fn().mockReturnValue({ promise: () => Promise.resolve({}) });
  const DocumentClient = jest.fn().mockImplementation(() => ({
    get: getFn, put: noop, update: noop, query: noop, delete: noop,
  }));
  return {
    __esModule: true,
    default: { DynamoDB: { DocumentClient }, config: { update: jest.fn() } },
    DynamoDB: { DocumentClient },
    config: { update: jest.fn() },
  };
});

// ── db mock — userDb/orgDb ───────────────────────────────────────────────────
const mockGetUserById   = jest.fn();
const mockGetOrgById    = jest.fn();
const mockGetOrgMembers = jest.fn();
jest.mock("../services/db", () => ({
  userDb: { getUserById: mockGetUserById },
  orgDb:  { getOrgById: mockGetOrgById, getOrgMembers: mockGetOrgMembers },
}));

// orgShareService — use the real implementation.
jest.unmock("../services/orgShareService");

// authenticateToken — decode the real JWT into req.user.
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

import funnelRouter from "../routes/funnel";

const app = express();
app.use(express.json());
app.use("/api/funnels", funnelRouter);

const m1Token = jwt.sign({ userId: "m-1", email: "m1@example.com" }, JWT_SECRET);
const m3Token = jwt.sign({ userId: "m-3", email: "m3@example.com" }, JWT_SECRET);

beforeEach(() => {
  jest.clearAllMocks();
  for (const k of Object.keys(funnelsByUser)) delete funnelsByUser[k];
});

describe("GET /api/funnels — org-wide sharing", () => {
  test("sharing ON → caller's funnels + org members' funnels, tagged", async () => {
    // caller m-1 in org-1; org has shareSettings.funnels.enabled = true
    // m-1 has funnel f-a; member m-2 has funnel f-b
    funnelsByUser["m-1"] = { "f-a": funnel("f-a") };
    funnelsByUser["m-2"] = { "f-b": funnel("f-b") };
    mockGetUserById.mockImplementation((uid: string) => {
      if (uid === "m-1") return Promise.resolve({ userId: "m-1", name: "Member One", orgId: "org-1", orgRole: "member" });
      if (uid === "m-2") return Promise.resolve({ userId: "m-2", name: "Member Two", orgId: "org-1", orgRole: "member" });
      return Promise.resolve(null);
    });
    mockGetOrgById.mockResolvedValue({
      orgId: "org-1", ownerUserId: "owner-x",
      shareSettings: { funnels: { enabled: true, editors: [] } },
    });
    mockGetOrgMembers.mockResolvedValue([{ userId: "m-1" }, { userId: "m-2" }]);

    const res = await request(app).get("/api/funnels").set("Authorization", `Bearer ${m1Token}`);
    expect(res.status).toBe(200);
    const ids = res.body.funnels.map((f: any) => f.configId);
    expect(ids).toEqual(expect.arrayContaining(["funnel:f-a", "funnel:f-b"]));
    const own = res.body.funnels.find((f: any) => f.configId === "funnel:f-a");
    const shared = res.body.funnels.find((f: any) => f.configId === "funnel:f-b");
    expect(own.ownerUserId).toBe("m-1");
    expect(shared.ownerUserId).toBe("m-2");
    expect(shared.ownerName).toBeTruthy();
  });

  test("sharing OFF, plain member → only own funnels", async () => {
    // org shareSettings.funnels.enabled = false; caller m-1 is a plain member
    funnelsByUser["m-1"] = { "f-a": funnel("f-a") };
    funnelsByUser["m-2"] = { "f-b": funnel("f-b") };
    mockGetUserById.mockImplementation((uid: string) => {
      if (uid === "m-1") return Promise.resolve({ userId: "m-1", name: "Member One", orgId: "org-1", orgRole: "member" });
      if (uid === "m-2") return Promise.resolve({ userId: "m-2", name: "Member Two", orgId: "org-1", orgRole: "member" });
      return Promise.resolve(null);
    });
    mockGetOrgById.mockResolvedValue({
      orgId: "org-1", ownerUserId: "owner-x",
      shareSettings: { funnels: { enabled: false, editors: [] } },
    });
    mockGetOrgMembers.mockResolvedValue([{ userId: "m-1" }, { userId: "m-2" }]);

    const res = await request(app).get("/api/funnels").set("Authorization", `Bearer ${m1Token}`);
    expect(res.status).toBe(200);
    const ids = res.body.funnels.map((f: any) => f.configId);
    expect(ids).toEqual(["funnel:f-a"]);
  });

  test("each funnel carries a server-computed canEdit", async () => {
    // org-1 shareSettings.funnels = { enabled: true, editors: ["m-1"] };
    // f-a owned by m-1, f-b owned by m-2.
    funnelsByUser["m-1"] = { "f-a": funnel("f-a") };
    funnelsByUser["m-2"] = { "f-b": funnel("f-b") };
    mockGetUserById.mockImplementation((uid: string) => {
      if (uid === "m-1") return Promise.resolve({ userId: "m-1", name: "Member One", orgId: "org-1", orgRole: "member" });
      if (uid === "m-2") return Promise.resolve({ userId: "m-2", name: "Member Two", orgId: "org-1", orgRole: "member" });
      return Promise.resolve(null);
    });
    mockGetOrgById.mockResolvedValue({
      orgId: "org-1", ownerUserId: "owner-x",
      shareSettings: { funnels: { enabled: true, editors: ["m-1"] } },
    });
    mockGetOrgMembers.mockResolvedValue([{ userId: "m-1" }, { userId: "m-2" }]);

    const res = await request(app).get("/api/funnels").set("Authorization", `Bearer ${m1Token}`);
    expect(res.status).toBe(200);
    const own = res.body.funnels.find((f: any) => f.configId === "funnel:f-a");
    const shared = res.body.funnels.find((f: any) => f.configId === "funnel:f-b");
    expect(own.canEdit).toBe(true);
    expect(shared.canEdit).toBe(true); // m-1 is a funnels editor → may edit a shared funnel
  });
});

describe("GET/PUT/DELETE /api/funnels/:configId — org-aware gating", () => {
  test("PUT /api/funnels/:id?ownerUserId=other — editor allowed", async () => {
    // m-1 is in shareSettings.funnels.editors; funnel f-b owned by m-2
    funnelsByUser["m-2"] = { "f-b": funnel("f-b") };
    mockGetUserById.mockImplementation((uid: string) => {
      if (uid === "m-1") return Promise.resolve({ userId: "m-1", name: "Member One", orgId: "org-1", orgRole: "member" });
      if (uid === "m-2") return Promise.resolve({ userId: "m-2", name: "Member Two", orgId: "org-1", orgRole: "member" });
      return Promise.resolve(null);
    });
    mockGetOrgById.mockResolvedValue({
      orgId: "org-1", ownerUserId: "owner-x",
      shareSettings: { funnels: { enabled: false, editors: ["m-1"] } },
    });

    const res = await request(app)
      .put("/api/funnels/funnel:f-b?ownerUserId=m-2")
      .set("Authorization", `Bearer ${m1Token}`)
      .send({ name: "Edited" });
    expect(res.status).toBe(200);
  });

  test("PUT /api/funnels/:id?ownerUserId=other — plain member denied 403", async () => {
    // m-3 is a plain member (not editor); funnel f-b owned by m-2
    funnelsByUser["m-2"] = { "f-b": funnel("f-b") };
    mockGetUserById.mockImplementation((uid: string) => {
      if (uid === "m-3") return Promise.resolve({ userId: "m-3", name: "Member Three", orgId: "org-1", orgRole: "member" });
      if (uid === "m-2") return Promise.resolve({ userId: "m-2", name: "Member Two", orgId: "org-1", orgRole: "member" });
      return Promise.resolve(null);
    });
    mockGetOrgById.mockResolvedValue({
      orgId: "org-1", ownerUserId: "owner-x",
      shareSettings: { funnels: { enabled: true, editors: ["m-1"] } },
    });

    const res = await request(app)
      .put("/api/funnels/funnel:f-b?ownerUserId=m-2")
      .set("Authorization", `Bearer ${m3Token}`)
      .send({ name: "Edited" });
    expect(res.status).toBe(403);
  });

  test("DELETE /api/funnels/:id?ownerUserId=other — editor denied 403 (delete is owner/org-owner only)", async () => {
    funnelsByUser["m-2"] = { "f-b": funnel("f-b") };
    mockGetUserById.mockImplementation((uid: string) => {
      if (uid === "m-1") return Promise.resolve({ userId: "m-1", name: "Member One", orgId: "org-1", orgRole: "member" });
      if (uid === "m-2") return Promise.resolve({ userId: "m-2", name: "Member Two", orgId: "org-1", orgRole: "member" });
      return Promise.resolve(null);
    });
    mockGetOrgById.mockResolvedValue({
      orgId: "org-1", ownerUserId: "owner-x",
      shareSettings: { funnels: { enabled: false, editors: ["m-1"] } },
    });

    const res = await request(app)
      .delete("/api/funnels/funnel:f-b?ownerUserId=m-2")
      .set("Authorization", `Bearer ${m1Token}`); // m-1 is editor, not org owner
    expect(res.status).toBe(403);
  });

  test("GET /api/funnels/:id?ownerUserId=other — plain member with sharing OFF denied 403", async () => {
    funnelsByUser["m-2"] = { "f-b": funnel("f-b") };
    mockGetUserById.mockImplementation((uid: string) => {
      if (uid === "m-3") return Promise.resolve({ userId: "m-3", name: "Member Three", orgId: "org-1", orgRole: "member" });
      if (uid === "m-2") return Promise.resolve({ userId: "m-2", name: "Member Two", orgId: "org-1", orgRole: "member" });
      return Promise.resolve(null);
    });
    mockGetOrgById.mockResolvedValue({
      orgId: "org-1", ownerUserId: "owner-x",
      shareSettings: { funnels: { enabled: false, editors: ["m-1"] } },
    });

    const res = await request(app)
      .get("/api/funnels/funnel:f-b?ownerUserId=m-2")
      .set("Authorization", `Bearer ${m3Token}`);
    expect(res.status).toBe(403);
  });
});
