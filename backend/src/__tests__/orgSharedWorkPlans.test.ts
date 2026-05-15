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
jest.mock("../services/db", () => ({
  userDb: { getUserById: mockGetUserById },
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

describe("GET /api/user-work-plans — org sharing", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetPublicPlansForAgentMode.mockResolvedValue([]);
  });

  it("includes org members' private plans when user is in an org", async () => {
    // user-1 is in org-abc
    mockGetUserById.mockResolvedValue({ userId: mockUserId, orgId: mockOrgId });
    mockGetWorkPlansByOwner.mockResolvedValue([myPlan]);
    mockGetWorkPlansByOrg.mockResolvedValue([myPlan, memberPlan]);

    const res = await request(app).get("/api/user-work-plans");
    expect(res.status).toBe(200);
    const ids = res.body.map((p: any) => p.planId);
    expect(ids).toContain("plan-1");
    expect(ids).toContain("plan-2");
  });

  it("does NOT include plans from outside the org", async () => {
    mockGetUserById.mockResolvedValue({ userId: mockUserId, orgId: mockOrgId });
    mockGetWorkPlansByOwner.mockResolvedValue([myPlan]);
    mockGetWorkPlansByOrg.mockResolvedValue([myPlan, memberPlan]);

    const res = await request(app).get("/api/user-work-plans");
    expect(res.status).toBe(200);
    const ids = res.body.map((p: any) => p.planId);
    expect(ids).not.toContain("plan-3");
  });

  it("returns only own plans when user is not in an org", async () => {
    mockGetUserById.mockResolvedValue({ userId: mockUserId }); // no orgId
    mockGetWorkPlansByOwner.mockResolvedValue([myPlan]);

    const res = await request(app).get("/api/user-work-plans");
    expect(res.status).toBe(200);
    const ids = res.body.map((p: any) => p.planId);
    expect(ids).toContain("plan-1");
    expect(ids).not.toContain("plan-2");
  });

  it("deduplicates plans that appear in both own and org results", async () => {
    mockGetUserById.mockResolvedValue({ userId: mockUserId, orgId: mockOrgId });
    mockGetWorkPlansByOwner.mockResolvedValue([myPlan]);
    mockGetWorkPlansByOrg.mockResolvedValue([myPlan, memberPlan]); // myPlan appears in both

    const res = await request(app).get("/api/user-work-plans");
    expect(res.status).toBe(200);
    const ids = res.body.map((p: any) => p.planId);
    const plan1Occurrences = ids.filter((id: string) => id === "plan-1").length;
    expect(plan1Occurrences).toBe(1);
  });
});

describe("PUT /api/user-work-plans/:planId — org member cannot edit another member's plan", () => {
  it("returns 403 when trying to edit a plan owned by another org member", async () => {
    mockGetWorkPlan.mockResolvedValue(memberPlan); // owned by user-2, not user-1

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

    const res = await request(app).delete("/api/user-work-plans/plan-2");

    expect(res.status).toBe(403);
    expect(mockDeleteWorkPlan).not.toHaveBeenCalled();
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
