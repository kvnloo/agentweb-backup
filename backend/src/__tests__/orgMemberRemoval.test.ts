/**
 * Tests for:
 *   GET  /api/orgs/me/members/:userId/removal-preview
 *   POST /api/orgs/me/members/:userId/remove
 *
 * Returns counts of all owned items for a target org member (GET),
 * and executes per-feature transfer/delete/leave decisions and removes the member (POST).
 * Both endpoints are accessible only by the org owner.
 */
import request from "supertest";
import express from "express";

// ── Fixed test IDs ──────────────────────────────────────────────────────────
const callerUserId = "caller-owner-1";
const targetUserId = "target-member-2";
const otherOrgUserId = "other-org-user-3";
const orgId = "org-xyz";

// ── Mock service fns ────────────────────────────────────────────────────────
const mockGetUserById = jest.fn();
const mockClearOrgMembership = jest.fn();
const mockPruneEditorListsForUser = jest.fn();
const mockGetTasksByUserId = jest.fn();
const mockDeleteTask = jest.fn();
const mockUpdateTaskOwner = jest.fn();
const mockGetTemplatesByOwner = jest.fn();
const mockDeleteTemplate = jest.fn();
const mockTransferTemplateOwner = jest.fn();
const mockGetLandingPagesByOwner = jest.fn();
const mockDeleteLandingPageByRecord = jest.fn();
const mockTransferLandingPageOwner = jest.fn();
const mockGetWorkPlansByOwner = jest.fn();
const mockDeleteWorkPlan = jest.fn();
const mockWorkPlanTransferOwner = jest.fn();
const mockGetSkillsByOwner = jest.fn();
const mockDeleteSkill = jest.fn();
const mockSkillTransferOwner = jest.fn();

// ── Jest mocks ──────────────────────────────────────────────────────────────
jest.mock("../services/db", () => ({
  userDb: {
    getUserById: mockGetUserById,
    clearOrgMembership: mockClearOrgMembership,
  },
  orgDb: {
    pruneEditorListsForUser: mockPruneEditorListsForUser,
  },
  taskDb: {
    getTasksByUserId: mockGetTasksByUserId,
    deleteTask: mockDeleteTask,
    updateTaskOwner: mockUpdateTaskOwner,
  },
}));

jest.mock("../services/htmlTemplateService", () => ({
  htmlTemplateService: {
    getTemplatesByOwner: mockGetTemplatesByOwner,
    deleteTemplate: mockDeleteTemplate,
    transferOwner: mockTransferTemplateOwner,
  },
}));

jest.mock("../services/v0Service", () => ({
  getLandingPagesByOwner: mockGetLandingPagesByOwner,
  deleteLandingPageByRecord: mockDeleteLandingPageByRecord,
  transferLandingPageOwner: mockTransferLandingPageOwner,
}));

jest.mock("../services/workPlanService", () => ({
  workPlanService: {
    getWorkPlansByOwner: mockGetWorkPlansByOwner,
    deleteWorkPlan: mockDeleteWorkPlan,
    transferOwner: mockWorkPlanTransferOwner,
  },
}));

jest.mock("../services/skillService", () => ({
  skillService: {
    getSkillsByOwner: mockGetSkillsByOwner,
    deleteSkill: mockDeleteSkill,
    transferOwner: mockSkillTransferOwner,
  },
}));

jest.mock("../middleware/auth", () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = { userId: callerUserId, email: "owner@example.com", isAdmin: false };
    next();
  },
}));

// ── App setup (after mocks) ─────────────────────────────────────────────────
import { authenticateToken } from "../middleware/auth";
import orgMemberRemovalRoutes from "../routes/orgMemberRemoval";

const app = express();
app.use(express.json());
app.use("/api/orgs/me/members", authenticateToken, orgMemberRemovalRoutes);

// ── Helpers ─────────────────────────────────────────────────────────────────
const callerOwner = { userId: callerUserId, orgId, orgRole: "owner" };
const targetMember = { userId: targetUserId, orgId };

function makeItems(n: number): { id: string }[] {
  return Array.from({ length: n }, (_, i) => ({ id: `item-${i}` }));
}

/** Shared item factories with proper IDs for each feature */
function makeTasks(n: number) {
  return Array.from({ length: n }, (_, i) => ({ taskId: `task-${i}`, userId: targetUserId }));
}
function makeTemplates(n: number) {
  return Array.from({ length: n }, (_, i) => ({ templateId: `tpl-${i}`, userId: targetUserId }));
}
function makeLandingPages(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `lp-${i}`,
    userId: targetUserId,
    isRootPage: false,
    status: "deployed",
  }));
}
function makeWorkPlans(n: number) {
  return Array.from({ length: n }, (_, i) => ({ planId: `plan-${i}`, ownerId: targetUserId }));
}
function makeSkills(n: number) {
  return Array.from({ length: n }, (_, i) => ({ skillId: `skill-${i}`, userId: targetUserId }));
}

/** All-delete decisions (valid input for POST) */
const allDelete = {
  knowledgeBase: "delete",
  htmlTemplates: "delete",
  landingPages: "delete",
  workPlans: "delete",
  skills: "delete",
};

/** All-transfer decisions */
const allTransfer = {
  knowledgeBase: "transfer",
  htmlTemplates: "transfer",
  landingPages: "transfer",
  workPlans: "transfer",
  skills: "transfer",
};

/** All-leave decisions */
const allLeave = {
  knowledgeBase: "leave",
  htmlTemplates: "leave",
  landingPages: "leave",
  workPlans: "leave",
  skills: "leave",
};

/** Setup normal user mocks (items empty by default) */
function setupNormalUsers() {
  mockGetUserById.mockImplementation((uid: string) => {
    if (uid === callerUserId) return Promise.resolve(callerOwner);
    if (uid === targetUserId) return Promise.resolve(targetMember);
    return Promise.resolve(null);
  });
  mockGetTasksByUserId.mockResolvedValue([]);
  mockGetTemplatesByOwner.mockResolvedValue([]);
  mockGetLandingPagesByOwner.mockResolvedValue([]);
  mockGetWorkPlansByOwner.mockResolvedValue([]);
  mockGetSkillsByOwner.mockResolvedValue([]);
  mockClearOrgMembership.mockResolvedValue(undefined);
  mockPruneEditorListsForUser.mockResolvedValue(undefined);
  mockDeleteTask.mockResolvedValue(undefined);
  mockUpdateTaskOwner.mockResolvedValue(undefined);
  mockDeleteTemplate.mockResolvedValue(undefined);
  mockTransferTemplateOwner.mockResolvedValue(undefined);
  mockDeleteLandingPageByRecord.mockResolvedValue(undefined);
  mockTransferLandingPageOwner.mockResolvedValue(undefined);
  mockDeleteWorkPlan.mockResolvedValue(undefined);
  mockWorkPlanTransferOwner.mockResolvedValue(undefined);
  mockDeleteSkill.mockResolvedValue(undefined);
  mockSkillTransferOwner.mockResolvedValue(undefined);
}

// ── GET removal-preview tests ────────────────────────────────────────────────
describe("GET /api/orgs/me/members/:userId/removal-preview", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns correct itemCounts for a member with mixed items", async () => {
    mockGetUserById.mockImplementation((uid: string) => {
      if (uid === callerUserId) return Promise.resolve(callerOwner);
      if (uid === targetUserId) return Promise.resolve(targetMember);
      return Promise.resolve(null);
    });
    mockGetTasksByUserId.mockResolvedValue(makeItems(3));
    mockGetTemplatesByOwner.mockResolvedValue(makeItems(2));
    mockGetLandingPagesByOwner.mockResolvedValue(makeItems(5));
    mockGetWorkPlansByOwner.mockResolvedValue(makeItems(1));
    mockGetSkillsByOwner.mockResolvedValue(makeItems(4));

    const res = await request(app).get(
      `/api/orgs/me/members/${targetUserId}/removal-preview`
    );

    expect(res.status).toBe(200);
    expect(res.body.userId).toBe(targetUserId);
    expect(res.body.itemCounts).toEqual({
      knowledgeBase: 3,
      htmlTemplates: 2,
      landingPages: 5,
      workPlans: 1,
      skills: 4,
    });
  });

  it("returns 404 if target user is not in caller's org", async () => {
    mockGetUserById.mockImplementation((uid: string) => {
      if (uid === callerUserId) return Promise.resolve(callerOwner);
      if (uid === otherOrgUserId)
        return Promise.resolve({ userId: otherOrgUserId, orgId: "different-org" });
      return Promise.resolve(null);
    });

    const res = await request(app).get(
      `/api/orgs/me/members/${otherOrgUserId}/removal-preview`
    );

    expect(res.status).toBe(404);
    expect(res.body.message).toBe("Member not found in your org");
  });

  it("returns 404 if target user does not exist", async () => {
    mockGetUserById.mockImplementation((uid: string) => {
      if (uid === callerUserId) return Promise.resolve(callerOwner);
      return Promise.resolve(null);
    });

    const res = await request(app).get(
      `/api/orgs/me/members/nonexistent-user/removal-preview`
    );

    expect(res.status).toBe(404);
    expect(res.body.message).toBe("Member not found in your org");
  });

  it("returns 403 if caller is not org owner", async () => {
    mockGetUserById.mockImplementation((uid: string) => {
      if (uid === callerUserId)
        return Promise.resolve({ userId: callerUserId, orgId, orgRole: "member" });
      return Promise.resolve(targetMember);
    });

    const res = await request(app).get(
      `/api/orgs/me/members/${targetUserId}/removal-preview`
    );

    expect(res.status).toBe(403);
    expect(res.body.message).toBe("Org owner only");
  });

  it("returns 403 if caller is not in any org", async () => {
    mockGetUserById.mockImplementation((uid: string) => {
      if (uid === callerUserId)
        // no orgId — not in any org
        return Promise.resolve({ userId: callerUserId, orgRole: "owner" });
      return Promise.resolve(targetMember);
    });

    const res = await request(app).get(
      `/api/orgs/me/members/${targetUserId}/removal-preview`
    );

    expect(res.status).toBe(403);
    expect(res.body.message).toBe("Org owner only");
  });

  it("handles getTasksByUserId returning undefined gracefully", async () => {
    mockGetUserById.mockImplementation((uid: string) => {
      if (uid === callerUserId) return Promise.resolve(callerOwner);
      if (uid === targetUserId) return Promise.resolve(targetMember);
      return Promise.resolve(null);
    });
    // Simulate handleDynamoDbError path — returns undefined
    mockGetTasksByUserId.mockResolvedValue(undefined);
    mockGetTemplatesByOwner.mockResolvedValue([]);
    mockGetLandingPagesByOwner.mockResolvedValue([]);
    mockGetWorkPlansByOwner.mockResolvedValue([]);
    mockGetSkillsByOwner.mockResolvedValue([]);

    const res = await request(app).get(
      `/api/orgs/me/members/${targetUserId}/removal-preview`
    );

    expect(res.status).toBe(200);
    expect(res.body.itemCounts.knowledgeBase).toBe(0);
  });
});

// ── POST /remove tests ────────────────────────────────────────────────────────
describe("POST /api/orgs/me/members/:userId/remove", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setupNormalUsers();
  });

  // 1. 403 when caller is not orgRole=owner
  it("returns 403 when caller is not org owner", async () => {
    mockGetUserById.mockImplementation((uid: string) => {
      if (uid === callerUserId)
        return Promise.resolve({ userId: callerUserId, orgId, orgRole: "member" });
      return Promise.resolve(targetMember);
    });

    const res = await request(app)
      .post(`/api/orgs/me/members/${targetUserId}/remove`)
      .send({ confirm: true, decisions: allDelete });

    expect(res.status).toBe(403);
    expect(res.body.message).toBe("Org owner only");
  });

  // 2. 400 when confirm:true is missing
  it("returns 400 when confirm:true is missing", async () => {
    const res = await request(app)
      .post(`/api/orgs/me/members/${targetUserId}/remove`)
      .send({ decisions: allDelete });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe("confirm:true required");
  });

  it("returns 400 when confirm is false", async () => {
    const res = await request(app)
      .post(`/api/orgs/me/members/${targetUserId}/remove`)
      .send({ confirm: false, decisions: allDelete });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe("confirm:true required");
  });

  // 3. 400 when an unknown decision string is given
  it("returns 400 when an invalid decision string is given for a feature", async () => {
    const res = await request(app)
      .post(`/api/orgs/me/members/${targetUserId}/remove`)
      .send({
        confirm: true,
        decisions: { ...allDelete, skills: "discard" },
      });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Invalid decision for skills/);
  });

  it("returns 400 when a decision is missing for a feature", async () => {
    const { skills: _omitted, ...decisionsWithoutSkills } = allDelete as any;
    const res = await request(app)
      .post(`/api/orgs/me/members/${targetUserId}/remove`)
      .send({ confirm: true, decisions: decisionsWithoutSkills });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Invalid decision for skills/);
  });

  // 4. 404 when target user is not in caller's org
  it("returns 404 when target user belongs to a different org", async () => {
    mockGetUserById.mockImplementation((uid: string) => {
      if (uid === callerUserId) return Promise.resolve(callerOwner);
      if (uid === otherOrgUserId)
        return Promise.resolve({ userId: otherOrgUserId, orgId: "other-org" });
      return Promise.resolve(null);
    });

    const res = await request(app)
      .post(`/api/orgs/me/members/${otherOrgUserId}/remove`)
      .send({ confirm: true, decisions: allDelete });

    expect(res.status).toBe(404);
    expect(res.body.message).toBe("Member not found in your org");
  });

  it("returns 404 when target user does not exist", async () => {
    mockGetUserById.mockImplementation((uid: string) => {
      if (uid === callerUserId) return Promise.resolve(callerOwner);
      return Promise.resolve(null);
    });

    const res = await request(app)
      .post(`/api/orgs/me/members/nonexistent/remove`)
      .send({ confirm: true, decisions: allDelete });

    expect(res.status).toBe(404);
    expect(res.body.message).toBe("Member not found in your org");
  });

  // 5. 400 with BULK_UPDATE_TOO_LARGE when a feature has > 10000 items
  it("returns 400 BULK_UPDATE_TOO_LARGE when knowledgeBase exceeds 10000 items", async () => {
    mockGetTasksByUserId.mockResolvedValue(Array.from({ length: 10001 }, (_, i) => ({ taskId: `t-${i}` })));

    const res = await request(app)
      .post(`/api/orgs/me/members/${targetUserId}/remove`)
      .send({ confirm: true, decisions: allDelete });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("BULK_UPDATE_TOO_LARGE");
    expect(res.body.feature).toBe("knowledgeBase");
    expect(res.body.count).toBe(10001);
  });

  it("returns 400 BULK_UPDATE_TOO_LARGE when skills exceeds 10000 items", async () => {
    mockGetSkillsByOwner.mockResolvedValue(Array.from({ length: 10001 }, (_, i) => ({ skillId: `s-${i}` })));

    const res = await request(app)
      .post(`/api/orgs/me/members/${targetUserId}/remove`)
      .send({ confirm: true, decisions: allDelete });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("BULK_UPDATE_TOO_LARGE");
    expect(res.body.feature).toBe("skills");
    expect(res.body.count).toBe(10001);
  });

  it("does not enforce cap for leave decisions", async () => {
    // Even if knowledgeBase has >10000 items, leave skips the cap check
    mockGetTasksByUserId.mockResolvedValue(Array.from({ length: 10001 }, (_, i) => ({ taskId: `t-${i}` })));

    const res = await request(app)
      .post(`/api/orgs/me/members/${targetUserId}/remove`)
      .send({ confirm: true, decisions: allLeave });

    expect(res.status).toBe(200);
    expect(mockClearOrgMembership).toHaveBeenCalledWith(targetUserId);
  });

  // 6. transfer decision sets new ownerId on items
  it("calls transferOwner helpers for all features when decision is transfer", async () => {
    const tasks = makeTasks(2);
    const templates = makeTemplates(1);
    const landingPages = makeLandingPages(1);
    const workPlans = makeWorkPlans(2);
    const skills = makeSkills(3);

    mockGetTasksByUserId.mockResolvedValue(tasks);
    mockGetTemplatesByOwner.mockResolvedValue(templates);
    mockGetLandingPagesByOwner.mockResolvedValue(landingPages);
    mockGetWorkPlansByOwner.mockResolvedValue(workPlans);
    mockGetSkillsByOwner.mockResolvedValue(skills);

    const res = await request(app)
      .post(`/api/orgs/me/members/${targetUserId}/remove`)
      .send({ confirm: true, decisions: allTransfer });

    expect(res.status).toBe(200);
    expect(mockUpdateTaskOwner).toHaveBeenCalledTimes(2);
    expect(mockUpdateTaskOwner).toHaveBeenCalledWith("task-0", callerUserId);
    expect(mockUpdateTaskOwner).toHaveBeenCalledWith("task-1", callerUserId);
    expect(mockTransferTemplateOwner).toHaveBeenCalledWith("tpl-0", callerUserId);
    expect(mockTransferLandingPageOwner).toHaveBeenCalledWith("lp-0", callerUserId);
    expect(mockWorkPlanTransferOwner).toHaveBeenCalledTimes(2);
    expect(mockSkillTransferOwner).toHaveBeenCalledTimes(3);
    expect(res.body.summary.knowledgeBase.updated).toBe(2);
    expect(res.body.summary.skills.updated).toBe(3);
  });

  // 7. delete decision calls deleteX
  it("calls delete helpers for all features when decision is delete", async () => {
    const tasks = makeTasks(2);
    const templates = makeTemplates(1);
    const landingPages = makeLandingPages(1);
    const workPlans = makeWorkPlans(1);
    const skills = makeSkills(2);

    mockGetTasksByUserId.mockResolvedValue(tasks);
    mockGetTemplatesByOwner.mockResolvedValue(templates);
    mockGetLandingPagesByOwner.mockResolvedValue(landingPages);
    mockGetWorkPlansByOwner.mockResolvedValue(workPlans);
    mockGetSkillsByOwner.mockResolvedValue(skills);

    const res = await request(app)
      .post(`/api/orgs/me/members/${targetUserId}/remove`)
      .send({ confirm: true, decisions: allDelete });

    expect(res.status).toBe(200);
    expect(mockDeleteTask).toHaveBeenCalledTimes(2);
    expect(mockDeleteTask).toHaveBeenCalledWith("task-0");
    expect(mockDeleteTemplate).toHaveBeenCalledWith("tpl-0");
    expect(mockDeleteLandingPageByRecord).toHaveBeenCalledTimes(1);
    expect(mockDeleteWorkPlan).toHaveBeenCalledWith("plan-0");
    expect(mockDeleteSkill).toHaveBeenCalledTimes(2);
    expect(res.body.summary.knowledgeBase.deleted).toBe(2);
    expect(res.body.summary.skills.deleted).toBe(2);
  });

  // 8. leave decision is a no-op for item manipulation
  it("does not call any item manipulation helpers when all decisions are leave", async () => {
    mockGetTasksByUserId.mockResolvedValue(makeTasks(3));
    mockGetSkillsByOwner.mockResolvedValue(makeSkills(2));

    const res = await request(app)
      .post(`/api/orgs/me/members/${targetUserId}/remove`)
      .send({ confirm: true, decisions: allLeave });

    expect(res.status).toBe(200);
    // No fetching or manipulation for leave
    expect(mockUpdateTaskOwner).not.toHaveBeenCalled();
    expect(mockDeleteTask).not.toHaveBeenCalled();
    expect(mockDeleteSkill).not.toHaveBeenCalled();
    // summary entries exist but are empty
    expect(res.body.summary.knowledgeBase).toEqual({ updated: 0, deleted: 0, errors: [] });
    expect(res.body.summary.skills).toEqual({ updated: 0, deleted: 0, errors: [] });
  });

  // 9. Mixed decisions handled independently
  it("handles mixed decisions across features", async () => {
    mockGetTasksByUserId.mockResolvedValue(makeTasks(2));
    mockGetTemplatesByOwner.mockResolvedValue(makeTemplates(1));
    mockGetLandingPagesByOwner.mockResolvedValue(makeLandingPages(1));
    mockGetWorkPlansByOwner.mockResolvedValue(makeWorkPlans(1));
    mockGetSkillsByOwner.mockResolvedValue(makeSkills(2));

    const res = await request(app)
      .post(`/api/orgs/me/members/${targetUserId}/remove`)
      .send({
        confirm: true,
        decisions: {
          knowledgeBase: "transfer",
          htmlTemplates: "delete",
          landingPages: "leave",
          workPlans: "delete",
          skills: "transfer",
        },
      });

    expect(res.status).toBe(200);
    // knowledgeBase: transfer
    expect(mockUpdateTaskOwner).toHaveBeenCalledTimes(2);
    expect(mockDeleteTask).not.toHaveBeenCalled();
    // htmlTemplates: delete
    expect(mockDeleteTemplate).toHaveBeenCalledWith("tpl-0");
    expect(mockTransferTemplateOwner).not.toHaveBeenCalled();
    // landingPages: leave — no fetch or manipulation
    expect(mockDeleteLandingPageByRecord).not.toHaveBeenCalled();
    expect(mockTransferLandingPageOwner).not.toHaveBeenCalled();
    // workPlans: delete
    expect(mockDeleteWorkPlan).toHaveBeenCalledWith("plan-0");
    // skills: transfer
    expect(mockSkillTransferOwner).toHaveBeenCalledTimes(2);
    expect(mockDeleteSkill).not.toHaveBeenCalled();

    expect(res.body.summary.landingPages).toEqual({ updated: 0, deleted: 0, errors: [] });
    expect(res.body.summary.knowledgeBase.updated).toBe(2);
    expect(res.body.summary.htmlTemplates.deleted).toBe(1);
  });

  // 10. After execution: clearOrgMembership and pruneEditorListsForUser are called
  it("calls clearOrgMembership and pruneEditorListsForUser after all decisions are processed", async () => {
    const res = await request(app)
      .post(`/api/orgs/me/members/${targetUserId}/remove`)
      .send({ confirm: true, decisions: allDelete });

    expect(res.status).toBe(200);
    expect(mockClearOrgMembership).toHaveBeenCalledTimes(1);
    expect(mockClearOrgMembership).toHaveBeenCalledWith(targetUserId);
    expect(mockPruneEditorListsForUser).toHaveBeenCalledTimes(1);
    expect(mockPruneEditorListsForUser).toHaveBeenCalledWith(orgId, targetUserId);
  });

  it("still clears org membership even when all decisions are leave", async () => {
    const res = await request(app)
      .post(`/api/orgs/me/members/${targetUserId}/remove`)
      .send({ confirm: true, decisions: allLeave });

    expect(res.status).toBe(200);
    expect(mockClearOrgMembership).toHaveBeenCalledWith(targetUserId);
    expect(mockPruneEditorListsForUser).toHaveBeenCalledWith(orgId, targetUserId);
  });

  it("returns summary with error entries when an item operation fails (delete)", async () => {
    mockGetSkillsByOwner.mockResolvedValue(makeSkills(2));
    mockDeleteSkill.mockResolvedValueOnce(undefined); // skill-0 succeeds
    mockDeleteSkill.mockRejectedValueOnce(new Error("DynamoDB timeout")); // skill-1 fails

    const res = await request(app)
      .post(`/api/orgs/me/members/${targetUserId}/remove`)
      .send({ confirm: true, decisions: allDelete });

    expect(res.status).toBe(200);
    expect(res.body.summary.skills.deleted).toBe(1);
    expect(res.body.summary.skills.errors).toHaveLength(1);
    expect(res.body.summary.skills.errors[0]).toMatch(/DynamoDB timeout/);
    // Cleanup still happens
    expect(mockClearOrgMembership).toHaveBeenCalledWith(targetUserId);
  });

  it("returns summary with error entries when an item operation fails (transfer)", async () => {
    mockGetTasksByUserId.mockResolvedValue(makeTasks(1));
    mockUpdateTaskOwner.mockRejectedValueOnce(new Error("conditional check failed"));

    const res = await request(app)
      .post(`/api/orgs/me/members/${targetUserId}/remove`)
      .send({ confirm: true, decisions: allTransfer });

    expect(res.status).toBe(200);
    expect(res.body.summary.knowledgeBase.updated).toBe(0);
    expect(res.body.summary.knowledgeBase.errors).toHaveLength(1);
    expect(res.body.summary.knowledgeBase.errors[0]).toMatch(/conditional check failed/);
    // Other features still processed and cleanup called
    expect(mockClearOrgMembership).toHaveBeenCalledWith(targetUserId);
  });
});
