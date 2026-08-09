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
const mockGetTemplatesByOwner    = jest.fn();
const mockDeleteTemplate          = jest.fn();
const mockTransferTemplateOwner   = jest.fn();
const mockTransferAllTemplates    = jest.fn();
const mockDeleteAllTemplates      = jest.fn();
const mockGetLandingPagesByOwner = jest.fn();
const mockDeleteLandingPageByRecord = jest.fn();
const mockTransferLandingPageOwner = jest.fn();
const mockGetWorkPlansByOwner = jest.fn();
const mockDeleteWorkPlan = jest.fn();
const mockWorkPlanTransferOwner = jest.fn();
const mockGetSkillsByOwner = jest.fn();
const mockDeleteSkill = jest.fn();
const mockSkillTransferOwner = jest.fn();
const mockGetOrgById = jest.fn();
const mockGetOrgMembers = jest.fn();
const mockUpdateOrg = jest.fn();
const mockDynamoGet = jest.fn();
const mockDynamoPut = jest.fn();

// ── Jest mocks ──────────────────────────────────────────────────────────────
jest.mock("../services/db", () => ({
  userDb: {
    getUserById: mockGetUserById,
    clearOrgMembership: mockClearOrgMembership,
  },
  orgDb: {
    pruneEditorListsForUser: mockPruneEditorListsForUser,
    getOrgById: mockGetOrgById,
    getOrgMembers: mockGetOrgMembers,
    updateOrg: mockUpdateOrg,
  },
  taskDb: {
    getTasksByUserId: mockGetTasksByUserId,
    deleteTask: mockDeleteTask,
    updateTaskOwner: mockUpdateTaskOwner,
  },
}));

jest.mock("../services/htmlTemplateService", () => ({
  htmlTemplateService: {
    getTemplatesByOwner:  mockGetTemplatesByOwner,
    deleteTemplate:       mockDeleteTemplate,
    transferAllTemplates: mockTransferAllTemplates,
    deleteAllTemplates:   mockDeleteAllTemplates,
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

jest.mock("aws-sdk", () => ({
  DynamoDB: {
    DocumentClient: jest.fn(() => ({
      get: (...args: any[]) => ({ promise: () => mockDynamoGet(...args) }),
      put: (...args: any[]) => ({ promise: () => mockDynamoPut(...args) }),
    })),
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
  funnels: "leave",
  analytics: "leave",
};

/** All-transfer decisions */
const allTransfer = {
  knowledgeBase: "transfer",
  htmlTemplates: "transfer",
  landingPages: "transfer",
  workPlans: "transfer",
  skills: "transfer",
  funnels: "leave",
  analytics: "leave",
};

/** All-leave decisions */
const allLeave = {
  knowledgeBase: "leave",
  htmlTemplates: "leave",
  landingPages: "leave",
  workPlans: "leave",
  skills: "leave",
  funnels: "leave",
  analytics: "leave",
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
  mockDeleteAllTemplates.mockResolvedValue(0);
  mockTransferAllTemplates.mockResolvedValue(0);
  mockDeleteLandingPageByRecord.mockResolvedValue(undefined);
  mockTransferLandingPageOwner.mockResolvedValue(undefined);
  mockDeleteWorkPlan.mockResolvedValue(undefined);
  mockWorkPlanTransferOwner.mockResolvedValue(undefined);
  mockDeleteSkill.mockResolvedValue(undefined);
  mockSkillTransferOwner.mockResolvedValue(undefined);
  mockDynamoGet.mockResolvedValue({ Item: undefined });
  mockDynamoPut.mockResolvedValue({});
}

// ── GET removal-preview tests ────────────────────────────────────────────────
describe("GET /api/orgs/me/members/:userId/removal-preview", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // ENG-954: the routes now resolve org authority through orgAuthz.can(),
    // which needs the org record. callerOwner is the org's owner, so every
    // previously-passing authorization outcome is unchanged.
    mockGetOrgById.mockResolvedValue({ orgId, ownerUserId: callerUserId, name: "Test Org" });
    mockGetOrgMembers.mockResolvedValue([callerOwner, targetMember]);
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
    mockDynamoGet.mockResolvedValue({ Item: undefined });

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
      funnels: 0,
    });
  });

  it("includes funnels count reflecting the member's funnels", async () => {
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
    // AW-Settings item keyed funnels_<targetUserId> with two funnels
    mockDynamoGet.mockImplementation((params: any) => {
      if (params?.Key?.settingName === `funnels_${targetUserId}`) {
        return Promise.resolve({
          Item: {
            settingName: `funnels_${targetUserId}`,
            funnels: {
              "f-1": { id: "f-1", name: "Funnel One", stages: [], createdAt: "", updatedAt: "" },
              "f-2": { id: "f-2", name: "Funnel Two", stages: [], createdAt: "", updatedAt: "" },
            },
          },
        });
      }
      return Promise.resolve({ Item: undefined });
    });

    const res = await request(app).get(
      `/api/orgs/me/members/${targetUserId}/removal-preview`
    );

    expect(res.status).toBe(200);
    expect(res.body.itemCounts.funnels).toBe(2);
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
    // ownerUserId must point elsewhere: orgAuthz unions ownerUserId with
    // orgRole, so a caller who is the org's ownerUserId is an owner even with a
    // drifted role. That union is the stale-role-lockout fix, not an accident.
    mockGetOrgById.mockResolvedValue({ orgId, ownerUserId: "someone-else", name: "Test Org" });
    mockGetUserById.mockImplementation((uid: string) => {
      if (uid === callerUserId)
        return Promise.resolve({ userId: callerUserId, orgId, orgRole: "member" });
      return Promise.resolve(targetMember);
    });

    const res = await request(app).get(
      `/api/orgs/me/members/${targetUserId}/removal-preview`
    );

    expect(res.status).toBe(403);
    expect(res.body.message).toBe("Org owners and admins only");
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
    expect(res.body.message).toBe("Org owners and admins only");
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
    mockGetOrgById.mockResolvedValue({ orgId, ownerUserId: "someone-else", name: "Test Org" });
    mockGetUserById.mockImplementation((uid: string) => {
      if (uid === callerUserId)
        return Promise.resolve({ userId: callerUserId, orgId, orgRole: "member" });
      return Promise.resolve(targetMember);
    });

    const res = await request(app)
      .post(`/api/orgs/me/members/${targetUserId}/remove`)
      .send({ confirm: true, decisions: allDelete });

    expect(res.status).toBe(403);
    expect(res.body.message).toBe("Org owners and admins only");
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
    // htmlTemplates uses bulk transfer — transferAllTemplates is called once
    expect(mockTransferAllTemplates).toHaveBeenCalledWith(targetUserId, callerUserId, "owner@example.com");
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
    // htmlTemplates uses bulk delete — deleteAllTemplates is called once
    expect(mockDeleteAllTemplates).toHaveBeenCalledWith(targetUserId, "owner@example.com");
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
          funnels: "leave",
          analytics: "leave",
        },
      });

    expect(res.status).toBe(200);
    // knowledgeBase: transfer
    expect(mockUpdateTaskOwner).toHaveBeenCalledTimes(2);
    expect(mockDeleteTask).not.toHaveBeenCalled();
    // htmlTemplates: delete — uses bulk deleteAllTemplates
    expect(mockDeleteAllTemplates).toHaveBeenCalledWith(targetUserId, "owner@example.com");
    expect(mockTransferAllTemplates).not.toHaveBeenCalled();
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
    // deleteAllTemplates returns 0 by default in setupNormalUsers; the route reports what the bulk call returns
    expect(res.body.summary.htmlTemplates.deleted).toBe(0);
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

// ENG-954 — the two guards this route was missing entirely, unlike its sibling
// in routes/org.ts. Without them an owner could remove themselves, leaving
// org.ownerUserId pointing at a non-member with no transfer route to recover.
describe("orgMemberRemoval guards", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetOrgById.mockResolvedValue({ orgId, ownerUserId: callerUserId, name: "Test Org" });
    mockGetOrgMembers.mockResolvedValue([callerOwner, targetMember]);
    mockGetUserById.mockImplementation((uid: string) => {
      if (uid === callerUserId) return Promise.resolve(callerOwner);
      if (uid === targetUserId) return Promise.resolve(targetMember);
      return Promise.resolve(null);
    });
  });

  it("refuses self-removal — this is what bricked orgs", async () => {
    const res = await request(app)
      .post(`/api/orgs/me/members/${callerUserId}/remove`)
      .send({ confirm: true, decisions: {} });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/cannot remove yourself/i);
    expect(mockClearOrgMembership).not.toHaveBeenCalled();
  });

  it("refuses to remove a PAYING billing owner — the gate this route kept missing", async () => {
    // Live run, 2026-08-09: this exact route returned 200 while the org went
    // Pro -> Free and the departed payer's sub_... stayed active. Twice now a
    // guard landed on routes/org.ts and not here.
    const ownerCaller = { userId: callerUserId, orgId, orgRole: "owner" };
    const payingRoot = {
      userId: "u-root", orgId, orgRole: "owner",
      subscriptionType: "Pro", subscription_status: "active", stripe_customer_id: "cus_x",
    };
    mockGetUserById.mockImplementation((uid: string) => {
      if (uid === callerUserId) return Promise.resolve(ownerCaller);
      if (uid === "u-root") return Promise.resolve(payingRoot);
      return Promise.resolve(null);
    });
    mockGetOrgMembers.mockResolvedValue([ownerCaller, payingRoot]);
    mockGetOrgById.mockResolvedValue({ orgId, ownerUserId: "u-root", name: "Test Org" });

    // allTRANSFER, not allLeave. The first version of this test used `leave`
    // decisions, which mutate nothing — so it passed while the gate sat AFTER
    // the asset loops and a refused removal had already moved the target's
    // content to the caller. Greptile caught what the test could not.
    const res = await request(app)
      .post(`/api/orgs/me/members/u-root/remove`)
      .send({ confirm: true, decisions: allTransfer });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("BILLING_OWNER_HAS_SUBSCRIPTION");
    expect(mockClearOrgMembership).not.toHaveBeenCalled();
    expect(mockUpdateOrg).not.toHaveBeenCalled();
    // Nothing of theirs may have moved or died on a refused removal.
    expect(mockUpdateTaskOwner).not.toHaveBeenCalled();
    expect(mockTransferLandingPageOwner).not.toHaveBeenCalled();
    expect(mockWorkPlanTransferOwner).not.toHaveBeenCalled();
    expect(mockSkillTransferOwner).not.toHaveBeenCalled();
    expect(mockTransferAllTemplates).not.toHaveBeenCalled();
    expect(mockDeleteTask).not.toHaveBeenCalled();
    expect(mockDeleteLandingPageByRecord).not.toHaveBeenCalled();
    expect(mockDeleteSkill).not.toHaveBeenCalled();
    expect(mockDeleteAllTemplates).not.toHaveBeenCalled();
  });

  it("a FREE billing owner still goes through this route", async () => {
    const ownerCaller = { userId: callerUserId, orgId, orgRole: "owner" };
    const freeRoot = { userId: "u-root", orgId, orgRole: "owner" };
    mockGetUserById.mockImplementation((uid: string) => {
      if (uid === callerUserId) return Promise.resolve(ownerCaller);
      if (uid === "u-root") return Promise.resolve(freeRoot);
      return Promise.resolve(null);
    });
    mockGetOrgMembers.mockResolvedValue([ownerCaller, freeRoot]);
    mockGetOrgById.mockResolvedValue({ orgId, ownerUserId: "u-root", name: "Test Org" });
    mockUpdateOrg.mockResolvedValue({});

    const res = await request(app)
      .post(`/api/orgs/me/members/u-root/remove`)
      .send({ confirm: true, decisions: allLeave });
    expect(res.status).toBe(200);
    expect(mockUpdateOrg).toHaveBeenCalledWith(orgId, { ownerUserId: callerUserId });
  });

  it("a failed billing reassignment mutates nothing — it runs before the asset work", async () => {
    // The failure path exists (two roster reads can disagree under GSI lag), so
    // it must not sit downstream of transfers. Greptile, #2297.
    const ownerCaller = { userId: callerUserId, orgId, orgRole: "owner" };
    const targetRoot = { userId: "u-root", orgId, orgRole: "owner" };
    mockGetUserById.mockImplementation((uid: string) => {
      if (uid === callerUserId) return Promise.resolve(ownerCaller);
      if (uid === "u-root") return Promise.resolve(targetRoot);
      return Promise.resolve(null);
    });
    mockGetOrgById.mockResolvedValue({ orgId, ownerUserId: "u-root", name: "Test Org" });
    // The admitting guard sees both owners; the reassignment's read then lags
    // and sees only the departing one, so it cannot find a successor.
    mockGetOrgMembers
      .mockResolvedValueOnce([ownerCaller, targetRoot])
      .mockResolvedValue([targetRoot]);
    // The target genuinely owns things, or the loops would iterate over nothing
    // and this assertion would hold regardless of ordering.
    mockGetTasksByUserId.mockResolvedValue(makeTasks(3));
    mockGetLandingPagesByOwner.mockResolvedValue(makeLandingPages(2));
    mockGetSkillsByOwner.mockResolvedValue(makeSkills(2));
    mockGetWorkPlansByOwner.mockResolvedValue(makeWorkPlans(2));
    mockGetTemplatesByOwner.mockResolvedValue(makeTemplates(2));

    const res = await request(app)
      .post(`/api/orgs/me/members/u-root/remove`)
      .send({ confirm: true, decisions: allTransfer });

    expect(res.status).toBe(409);
    expect(mockClearOrgMembership).not.toHaveBeenCalled();
    expect(mockUpdateTaskOwner).not.toHaveBeenCalled();
    expect(mockTransferLandingPageOwner).not.toHaveBeenCalled();
    expect(mockSkillTransferOwner).not.toHaveBeenCalled();
    expect(mockWorkPlanTransferOwner).not.toHaveBeenCalled();
    expect(mockTransferAllTemplates).not.toHaveBeenCalled();
  });

  it("carries the billing root to the remover — this route was missed the first time", async () => {
    // The reassignment landed on routes/org.ts only, while the commit claimed
    // both paths. This route is the one the portal's remove dialog calls, so
    // the gap was the one a human would hit — and did, twice.
    const ownerCaller = { userId: callerUserId, orgId, orgRole: "owner" };
    const targetRoot = { userId: "u-root", orgId, orgRole: "owner" };
    mockGetUserById.mockImplementation((uid: string) => {
      if (uid === callerUserId) return Promise.resolve(ownerCaller);
      if (uid === "u-root") return Promise.resolve(targetRoot);
      return Promise.resolve(null);
    });
    mockGetOrgMembers.mockResolvedValue([ownerCaller, targetRoot]);
    mockGetOrgById.mockResolvedValue({ orgId, ownerUserId: "u-root", name: "Test Org" });
    mockUpdateOrg.mockResolvedValue({});

    const res = await request(app)
      .post(`/api/orgs/me/members/u-root/remove`)
      .send({ confirm: true, decisions: allLeave });

    expect(res.status).toBe(200);
    expect(mockUpdateOrg).toHaveBeenCalledWith(orgId, { ownerUserId: callerUserId });
    expect(mockClearOrgMembership).toHaveBeenCalledWith("u-root");
  });

  it("removing a NON-billing member leaves the pointer alone", async () => {
    const ownerCaller = { userId: callerUserId, orgId, orgRole: "owner" };
    mockGetUserById.mockImplementation((uid: string) => {
      if (uid === callerUserId) return Promise.resolve(ownerCaller);
      if (uid === targetUserId) return Promise.resolve(targetMember);
      return Promise.resolve(null);
    });
    mockGetOrgMembers.mockResolvedValue([ownerCaller, targetMember]);
    mockGetOrgById.mockResolvedValue({ orgId, ownerUserId: callerUserId, name: "Test Org" });

    const res = await request(app)
      .post(`/api/orgs/me/members/${targetUserId}/remove`)
      .send({ confirm: true, decisions: allLeave });
    expect(res.status).toBe(200);
    expect(mockUpdateOrg).not.toHaveBeenCalled();
  });

  it("refuses to let an ADMIN remove an owner — and so never hands them the owner's content", async () => {
    // This route does more than evict: `transfer` decisions move the target's
    // landing pages, skills, work plans and knowledge base to *the caller*. An
    // admin cannot demote an owner (403 on PATCH .../role), so being able to
    // remove one would be the same revocation plus an asset transfer.
    const adminCaller = { userId: callerUserId, orgId, orgRole: "admin" };
    const targetOwner = { userId: "u-second", orgId, orgRole: "owner" };
    const thirdOwner = { userId: "u-third", orgId, orgRole: "owner" };
    mockGetUserById.mockImplementation((uid: string) => {
      if (uid === callerUserId) return Promise.resolve(adminCaller);
      if (uid === "u-second") return Promise.resolve(targetOwner);
      if (uid === "u-third") return Promise.resolve(thirdOwner);
      return Promise.resolve(null);
    });
    // Deliberately two other owners, so the last-owner guard cannot be what
    // refuses this. Only the owner-only guard stands here.
    mockGetOrgMembers.mockResolvedValue([adminCaller, targetOwner, thirdOwner]);
    mockGetOrgById.mockResolvedValue({ orgId, ownerUserId: "u-third", name: "Test Org" });

    const res = await request(app)
      .post(`/api/orgs/me/members/u-second/remove`)
      .send({ confirm: true, decisions: allTransfer });
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/only an owner/i);
    expect(mockClearOrgMembership).not.toHaveBeenCalled();
    expect(mockTransferLandingPageOwner).not.toHaveBeenCalled();
    expect(mockSkillTransferOwner).not.toHaveBeenCalled();
    expect(mockWorkPlanTransferOwner).not.toHaveBeenCalled();
    expect(mockUpdateTaskOwner).not.toHaveBeenCalled();
  });

  it("refuses to remove the only owner the member listing knows about", async () => {
    const ownerCaller = { userId: callerUserId, orgId, orgRole: "owner" };
    const targetOwner = { userId: "u-second", orgId, orgRole: "owner" };
    mockGetUserById.mockImplementation((uid: string) => {
      if (uid === callerUserId) return Promise.resolve(ownerCaller);
      if (uid === "u-second") return Promise.resolve(targetOwner);
      return Promise.resolve(null);
    });
    // getOrgMembers reads an eventually-consistent GSI: the caller's own
    // promotion may not have propagated, leaving one owner visible.
    mockGetOrgMembers.mockResolvedValue([targetOwner]);
    mockGetOrgById.mockResolvedValue({ orgId, ownerUserId: "u-second", name: "Test Org" });

    const res = await request(app)
      .post(`/api/orgs/me/members/u-second/remove`)
      .send({ confirm: true, decisions: {} });
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/only owner/i);
    expect(mockClearOrgMembership).not.toHaveBeenCalled();
  });
});
