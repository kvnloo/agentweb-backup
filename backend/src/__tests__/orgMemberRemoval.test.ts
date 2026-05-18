/**
 * Tests for GET /api/orgs/me/members/:userId/removal-preview
 *
 * Returns counts of all owned items for a target org member,
 * accessible only by the org owner.
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
const mockGetTasksByUserId = jest.fn();
const mockGetTemplatesByOwner = jest.fn();
const mockGetLandingPagesByOwner = jest.fn();
const mockGetWorkPlansByOwner = jest.fn();
const mockGetSkillsByOwner = jest.fn();

// ── Jest mocks ──────────────────────────────────────────────────────────────
jest.mock("../services/db", () => ({
  userDb: { getUserById: mockGetUserById },
  orgDb: {},
  taskDb: { getTasksByUserId: mockGetTasksByUserId },
}));

jest.mock("../services/htmlTemplateService", () => ({
  htmlTemplateService: { getTemplatesByOwner: mockGetTemplatesByOwner },
}));

jest.mock("../services/v0Service", () => ({
  getLandingPagesByOwner: mockGetLandingPagesByOwner,
}));

jest.mock("../services/workPlanService", () => ({
  workPlanService: { getWorkPlansByOwner: mockGetWorkPlansByOwner },
}));

jest.mock("../services/skillService", () => ({
  skillService: { getSkillsByOwner: mockGetSkillsByOwner },
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

// ── Tests ────────────────────────────────────────────────────────────────────
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
