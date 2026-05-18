/**
 * Tests for org-shared work plans.
 *
 * When a user belongs to an org, GET /api/user-work-plans should include
 * private work plans from all org members (not just their own). Plans remain
 * private; only the owner can edit or delete their plan.
 */
import request from "supertest";
import express from "express";

const mockUserId = "user-1";
const mockOrgMemberId = "user-2";
const mockOrgId = "org-abc";

// Plan owned by user-1
const myPlan = {
  planId: "plan-1",
  title: "My Plan",
  ownerId: mockUserId,
  visibility: "private",
  orgId: mockOrgId,
  isBuiltIn: false,
  steps: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

// Plan owned by org member user-2
const memberPlan = {
  planId: "plan-2",
  title: "Member Plan",
  ownerId: mockOrgMemberId,
  visibility: "private",
  orgId: mockOrgId,
  isBuiltIn: false,
  steps: [],
  createdAt: "2026-01-02T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
};

// Plan owned by user outside any org
const outsiderPlan = {
  planId: "plan-3",
  title: "Outsider Plan",
  ownerId: "user-outsider",
  visibility: "private",
  isBuiltIn: false,
  steps: [],
  createdAt: "2026-01-03T00:00:00.000Z",
  updatedAt: "2026-01-03T00:00:00.000Z",
};

const mockGetWorkPlansByOwner = jest.fn();
const mockGetWorkPlansByOrg = jest.fn();
const mockGetPublicPlansForAgentMode = jest.fn();
const mockGetWorkPlan = jest.fn();
const mockUpdateWorkPlan = jest.fn();
const mockDeleteWorkPlan = jest.fn();
const mockCreateWorkPlan = jest.fn();

jest.mock("../services/workPlanService", () => ({
  workPlanService: {
    getWorkPlansByOwner: mockGetWorkPlansByOwner,
    getWorkPlansByOrg: mockGetWorkPlansByOrg,
    getPublicPlansForAgentMode: mockGetPublicPlansForAgentMode,
    getWorkPlan: mockGetWorkPlan,
    updateWorkPlan: mockUpdateWorkPlan,
    deleteWorkPlan: mockDeleteWorkPlan,
    createWorkPlan: mockCreateWorkPlan,
  },
}));

jest.mock("../services/emailService", () => ({
  emailService: { sendOncallAlert: jest.fn() },
}));

const mockGetUserById = jest.fn();
const mockGetOrgById = jest.fn();
const mockGetOrgMembers = jest.fn();
jest.mock("../services/db", () => ({
  userDb: { getUserById: mockGetUserById },
  orgDb: { getOrgById: mockGetOrgById, getOrgMembers: mockGetOrgMembers },
}));

jest.mock("../middleware/auth", () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = { userId: mockUserId, email: "user1@example.com", isAdmin: false };
    next();
  },
}));

import { authenticateToken } from "../middleware/auth";
import userWorkPlanRoutes from "../routes/userWorkPlanRoutes";

const app = express();
app.use(express.json());
app.use("/api/user-work-plans", authenticateToken, userWorkPlanRoutes);

import { MEMBER_FANOUT_CAP } from "../services/orgShareService";

describe("GET /api/user-work-plans — org sharing", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetPublicPlansForAgentMode.mockResolvedValue([]);
    // Default: org has only two members (user-1 and user-2)
    mockGetOrgMembers.mockResolvedValue([
      { userId: mockUserId },
      { userId: mockOrgMemberId },
    ]);
  });

  it("includes org members' private plans when user is in an org with workPlans enabled", async () => {
    // user-1 is in org-abc, shareSettings.workPlans.enabled = true
    mockGetUserById.mockResolvedValue({ userId: mockUserId, orgId: mockOrgId });
    mockGetOrgById.mockResolvedValue({
      orgId: mockOrgId,
      shareSettings: { workPlans: { enabled: true } },
    });
    // getWorkPlansByOwner called for user-1 (own) and user-2 (fanout)
    mockGetWorkPlansByOwner.mockImplementation((uid: string) => {
      if (uid === mockUserId) return Promise.resolve([myPlan]);
      if (uid === mockOrgMemberId) return Promise.resolve([memberPlan]);
      return Promise.resolve([]);
    });

    const res = await request(app).get("/api/user-work-plans");
    expect(res.status).toBe(200);
    const ids = res.body.items.map((p: any) => p.planId);
    expect(ids).toContain("plan-1");
    expect(ids).toContain("plan-2");
  });

  it("does NOT include plans from outside the org", async () => {
    mockGetUserById.mockResolvedValue({ userId: mockUserId, orgId: mockOrgId });
    mockGetOrgById.mockResolvedValue({
      orgId: mockOrgId,
      shareSettings: { workPlans: { enabled: true } },
    });
    mockGetWorkPlansByOwner.mockImplementation((uid: string) => {
      if (uid === mockUserId) return Promise.resolve([myPlan]);
      if (uid === mockOrgMemberId) return Promise.resolve([memberPlan]);
      return Promise.resolve([]);
    });

    const res = await request(app).get("/api/user-work-plans");
    expect(res.status).toBe(200);
    const ids = res.body.items.map((p: any) => p.planId);
    expect(ids).not.toContain("plan-3");
  });

  it("returns only own plans when user is not in an org", async () => {
    mockGetUserById.mockResolvedValue({ userId: mockUserId }); // no orgId
    mockGetWorkPlansByOwner.mockResolvedValue([myPlan]);

    const res = await request(app).get("/api/user-work-plans");
    expect(res.status).toBe(200);
    const ids = res.body.items.map((p: any) => p.planId);
    expect(ids).toContain("plan-1");
    expect(ids).not.toContain("plan-2");
    // getOrgById should NOT be called when there is no orgId
    expect(mockGetOrgById).not.toHaveBeenCalled();
  });

  it("deduplicates plans that appear in both own and fanout results", async () => {
    mockGetUserById.mockResolvedValue({ userId: mockUserId, orgId: mockOrgId });
    mockGetOrgById.mockResolvedValue({
      orgId: mockOrgId,
      shareSettings: { workPlans: { enabled: true } },
    });
    // getWorkPlansByOwner for user-1 returns myPlan; fanout (user-2) also returns myPlan + memberPlan
    mockGetWorkPlansByOwner.mockImplementation((uid: string) => {
      if (uid === mockUserId) return Promise.resolve([myPlan]);
      if (uid === mockOrgMemberId) return Promise.resolve([myPlan, memberPlan]);
      return Promise.resolve([]);
    });

    const res = await request(app).get("/api/user-work-plans");
    expect(res.status).toBe(200);
    const ids = res.body.items.map((p: any) => p.planId);
    const plan1Occurrences = ids.filter((id: string) => id === "plan-1").length;
    expect(plan1Occurrences).toBe(1);
  });

  it("list excludes other-member plans when shareSettings.workPlans.enabled is false", async () => {
    mockGetUserById.mockResolvedValue({ userId: mockUserId, orgId: mockOrgId });
    mockGetOrgById.mockResolvedValue({
      orgId: mockOrgId,
      shareSettings: { workPlans: { enabled: false } },
    });
    mockGetWorkPlansByOwner.mockResolvedValue([myPlan]);

    const res = await request(app).get("/api/user-work-plans");
    expect(res.status).toBe(200);
    const ids = res.body.items.map((p: any) => p.planId);
    // Own plan should still be present
    expect(ids).toContain("plan-1");
    // Org member plan should NOT be present when sharing is disabled
    expect(ids).not.toContain("plan-2");
    // getWorkPlansByOrg should NOT be called when sharing is disabled
    expect(mockGetWorkPlansByOrg).not.toHaveBeenCalled();
  });

  it("response has items and truncated fields", async () => {
    mockGetUserById.mockResolvedValue({ userId: mockUserId, orgId: mockOrgId });
    mockGetOrgById.mockResolvedValue({
      orgId: mockOrgId,
      shareSettings: { workPlans: { enabled: true } },
    });
    mockGetWorkPlansByOwner.mockImplementation((uid: string) => {
      if (uid === mockUserId) return Promise.resolve([myPlan]);
      if (uid === mockOrgMemberId) return Promise.resolve([memberPlan]);
      return Promise.resolve([]);
    });

    const res = await request(app).get("/api/user-work-plans");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("items");
    expect(res.body).toHaveProperty("truncated", false);
    expect(Array.isArray(res.body.items)).toBe(true);
  });

  it("sets truncated=true when org has more than MEMBER_FANOUT_CAP members", async () => {
    mockGetUserById.mockResolvedValue({ userId: mockUserId, orgId: mockOrgId });
    mockGetOrgById.mockResolvedValue({
      orgId: mockOrgId,
      shareSettings: { workPlans: { enabled: true } },
    });
    // Create MEMBER_FANOUT_CAP + 1 member IDs (excluding the caller)
    const manyMembers = Array.from({ length: MEMBER_FANOUT_CAP + 1 }, (_, i) => ({
      userId: `member-${i}`,
    }));
    // Include caller in members list so the helper can filter them out
    mockGetOrgMembers.mockResolvedValue([{ userId: mockUserId }, ...manyMembers]);
    // Only own plans returned for the caller
    mockGetWorkPlansByOwner.mockImplementation((uid: string) => {
      if (uid === mockUserId) return Promise.resolve([myPlan]);
      return Promise.resolve([]);
    });

    const res = await request(app).get("/api/user-work-plans");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("truncated", true);
  });
});

// Editor ID for org-sharing edit tests (user-3)
const mockEditorId = "user-3";

// Org with workPlans sharing enabled; user-3 is an editor
const mockOrgWithEditor = {
  orgId: mockOrgId,
  ownerUserId: "org-owner",
  shareSettings: {
    workPlans: { enabled: true, editors: [mockEditorId] },
  },
};

// Org with workPlans sharing enabled but NO editors
const mockOrgNoEditors = {
  orgId: mockOrgId,
  ownerUserId: "org-owner",
  shareSettings: {
    workPlans: { enabled: true, editors: [] },
  },
};

describe("PUT /api/user-work-plans/:planId — org member cannot edit another member's plan", () => {
  it("returns 403 when trying to edit a plan owned by another org member", async () => {
    mockGetWorkPlan.mockResolvedValue(memberPlan); // owned by user-2, not user-1
    mockGetUserById.mockImplementation((uid: string) => {
      if (uid === mockUserId) return Promise.resolve({ userId: mockUserId, orgId: mockOrgId, orgRole: "member" });
      if (uid === mockOrgMemberId) return Promise.resolve({ userId: mockOrgMemberId, orgId: mockOrgId, orgRole: "member" });
      return Promise.resolve(null);
    });
    mockGetOrgById.mockResolvedValue(mockOrgNoEditors);

    const res = await request(app)
      .put("/api/user-work-plans/plan-2")
      .send({ title: "Hijacked" });

    expect(res.status).toBe(403);
    expect(mockUpdateWorkPlan).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/user-work-plans/:planId — org member cannot delete another member's plan", () => {
  it("returns 403 when trying to delete a plan owned by another org member", async () => {
    mockGetWorkPlan.mockResolvedValue(memberPlan);
    mockGetUserById.mockResolvedValue({ userId: mockUserId, orgId: mockOrgId, orgRole: "member" });

    const res = await request(app).delete("/api/user-work-plans/plan-2");

    expect(res.status).toBe(403);
    expect(mockDeleteWorkPlan).not.toHaveBeenCalled();
  });
});

describe("PUT /api/user-work-plans/:planId — editor-based PATCH permission", () => {
  // App where authenticated user is the editor (user-3)
  const editorApp = express();
  editorApp.use(express.json());
  editorApp.use("/api/user-work-plans", (req: any, _res: any, next: any) => {
    req.user = { userId: mockEditorId, email: "editor@example.com", isAdmin: false };
    next();
  }, userWorkPlanRoutes);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("editor in shareSettings.workPlans.editors can PATCH another member's plan", async () => {
    mockGetWorkPlan.mockResolvedValue(memberPlan); // owned by user-2
    mockGetUserById.mockImplementation((uid: string) => {
      if (uid === mockEditorId) return Promise.resolve({ userId: mockEditorId, orgId: mockOrgId, orgRole: "member" });
      if (uid === mockOrgMemberId) return Promise.resolve({ userId: mockOrgMemberId, orgId: mockOrgId, orgRole: "member" });
      return Promise.resolve(null);
    });
    mockGetOrgById.mockResolvedValue(mockOrgWithEditor);
    mockUpdateWorkPlan.mockResolvedValue(undefined);

    const res = await request(editorApp)
      .put("/api/user-work-plans/plan-2")
      .send({ title: "Editor Update" });

    expect(res.status).toBe(200);
    expect(mockUpdateWorkPlan).toHaveBeenCalled();
  });

  it("non-editor org member is rejected with 403 on PATCH", async () => {
    // user-1 is not in editors list for plan-2 (owned by user-2) when editors list is empty
    mockGetWorkPlan.mockResolvedValue(memberPlan);
    mockGetUserById.mockImplementation((uid: string) => {
      if (uid === mockUserId) return Promise.resolve({ userId: mockUserId, orgId: mockOrgId, orgRole: "member" });
      if (uid === mockOrgMemberId) return Promise.resolve({ userId: mockOrgMemberId, orgId: mockOrgId, orgRole: "member" });
      return Promise.resolve(null);
    });
    mockGetOrgById.mockResolvedValue(mockOrgNoEditors);

    const res = await request(app)
      .put("/api/user-work-plans/plan-2")
      .send({ title: "Hijacked" });

    expect(res.status).toBe(403);
    expect(mockUpdateWorkPlan).not.toHaveBeenCalled();
  });

  it("org owner (orgRole=owner) can PATCH any same-org member's plan regardless of editors", async () => {
    const orgOwnerUserId = "user-org-owner";
    const orgOwnerApp = express();
    orgOwnerApp.use(express.json());
    orgOwnerApp.use("/api/user-work-plans", (req: any, _res: any, next: any) => {
      req.user = { userId: orgOwnerUserId, email: "orgowner@example.com", isAdmin: false };
      next();
    }, userWorkPlanRoutes);

    mockGetWorkPlan.mockResolvedValue(memberPlan); // owned by user-2
    mockGetUserById.mockImplementation((uid: string) => {
      if (uid === orgOwnerUserId) return Promise.resolve({ userId: orgOwnerUserId, orgId: mockOrgId, orgRole: "owner" });
      if (uid === mockOrgMemberId) return Promise.resolve({ userId: mockOrgMemberId, orgId: mockOrgId, orgRole: "member" });
      return Promise.resolve(null);
    });
    // Org with no editors — but org owner should still be allowed
    mockGetOrgById.mockResolvedValue(mockOrgNoEditors);
    mockUpdateWorkPlan.mockResolvedValue(undefined);

    const res = await request(orgOwnerApp)
      .put("/api/user-work-plans/plan-2")
      .send({ title: "Owner Override" });

    expect(res.status).toBe(200);
    expect(mockUpdateWorkPlan).toHaveBeenCalled();
  });
});

describe("DELETE /api/user-work-plans/:planId — editor-based DELETE restriction", () => {
  // App where authenticated user is the editor (user-3)
  const editorApp = express();
  editorApp.use(express.json());
  editorApp.use("/api/user-work-plans", (req: any, _res: any, next: any) => {
    req.user = { userId: mockEditorId, email: "editor@example.com", isAdmin: false };
    next();
  }, userWorkPlanRoutes);

  // Org owner app
  const orgOwnerUserId = "user-org-owner";
  const orgOwnerApp = express();
  orgOwnerApp.use(express.json());
  orgOwnerApp.use("/api/user-work-plans", (req: any, _res: any, next: any) => {
    req.user = { userId: orgOwnerUserId, email: "orgowner@example.com", isAdmin: false };
    next();
  }, userWorkPlanRoutes);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("editor cannot delete another member's plan even when in editors list", async () => {
    mockGetWorkPlan.mockResolvedValue(memberPlan); // owned by user-2
    mockGetUserById.mockResolvedValue({ userId: mockEditorId, orgId: mockOrgId, orgRole: "member" });

    const res = await request(editorApp).delete("/api/user-work-plans/plan-2");

    expect(res.status).toBe(403);
    expect(mockDeleteWorkPlan).not.toHaveBeenCalled();
  });

  it("org owner (orgRole=owner) can DELETE another member's plan in same org", async () => {
    mockGetWorkPlan.mockResolvedValue(memberPlan); // owned by user-2
    mockGetUserById.mockImplementation((uid: string) => {
      if (uid === orgOwnerUserId) return Promise.resolve({ userId: orgOwnerUserId, orgId: mockOrgId, orgRole: "owner" });
      if (uid === mockOrgMemberId) return Promise.resolve({ userId: mockOrgMemberId, orgId: mockOrgId, orgRole: "member" });
      return Promise.resolve(null);
    });
    mockDeleteWorkPlan.mockResolvedValue(undefined);

    const res = await request(orgOwnerApp).delete("/api/user-work-plans/plan-2");

    expect(res.status).toBe(200);
    expect(mockDeleteWorkPlan).toHaveBeenCalledWith("plan-2");
  });

  it("plan owner can delete their own plan", async () => {
    mockGetWorkPlan.mockResolvedValue(myPlan); // owned by user-1 (the default authenticated user)
    mockDeleteWorkPlan.mockResolvedValue(undefined);

    const res = await request(app).delete("/api/user-work-plans/plan-1");

    expect(res.status).toBe(200);
    expect(mockDeleteWorkPlan).toHaveBeenCalledWith("plan-1");
  });
});

describe("POST /api/user-work-plans — new plan gets orgId stamped", () => {
  it("stamps the orgId from the user's record onto the new plan", async () => {
    mockGetUserById.mockResolvedValue({ userId: mockUserId, orgId: mockOrgId });
    mockCreateWorkPlan.mockResolvedValue({ ...myPlan, planId: "plan-new" });

    const res = await request(app)
      .post("/api/user-work-plans")
      .send({ title: "New Plan", steps: [{ title: "Step 1" }] });

    expect(res.status).toBe(201);
    expect(mockCreateWorkPlan).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: mockOrgId })
    );
  });

  it("creates plan without orgId when user is not in an org", async () => {
    mockGetUserById.mockResolvedValue({ userId: mockUserId }); // no orgId
    mockCreateWorkPlan.mockResolvedValue({ ...myPlan, planId: "plan-new", orgId: undefined });

    const res = await request(app)
      .post("/api/user-work-plans")
      .send({ title: "New Plan", steps: [{ title: "Step 1" }] });

    expect(res.status).toBe(201);
    const call = mockCreateWorkPlan.mock.calls[0][0];
    expect(call.orgId).toBeUndefined();
  });
});
