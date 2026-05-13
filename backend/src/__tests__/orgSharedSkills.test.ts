/**
 * Tests for org-shared skills.
 *
 * When a user belongs to an org, GET /api/user-skills should include
 * private skills from all org members (not just their own). Skills remain
 * private; only the owner can edit or delete their skill.
 */
import request from "supertest";
import express from "express";

const mockUserId = "user-1";
const mockOrgMemberId = "user-2";
const mockOrgId = "org-abc";

const mySkill = {
  skillId: "skill-1",
  name: "My Skill",
  description: "desc",
  ownerId: mockUserId,
  visibility: "private",
  orgId: mockOrgId,
  isBuiltIn: false,
  isPublished: false,
  toolNames: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const memberSkill = {
  skillId: "skill-2",
  name: "Member Skill",
  description: "desc",
  ownerId: mockOrgMemberId,
  visibility: "private",
  orgId: mockOrgId,
  isBuiltIn: false,
  isPublished: false,
  toolNames: [],
  createdAt: "2026-01-02T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
};

const mockGetSkillsByOwner = jest.fn();
const mockGetSkillsByOrg = jest.fn();
const mockGetSkillsByVisibility = jest.fn();
const mockGetSkill = jest.fn();
const mockUpdateSkill = jest.fn();
const mockDeleteSkill = jest.fn();
const mockCreateSkill = jest.fn();

jest.mock("../services/skillService", () => ({
  skillService: {
    getSkillsByOwner: mockGetSkillsByOwner,
    getSkillsByOrg: mockGetSkillsByOrg,
    getSkillsByVisibility: mockGetSkillsByVisibility,
    getSkill: mockGetSkill,
    updateSkill: mockUpdateSkill,
    deleteSkill: mockDeleteSkill,
    createSkill: mockCreateSkill,
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
import userSkillRoutes from "../routes/userSkillRoutes";

const app = express();
app.use(express.json());
app.use("/api/user-skills", authenticateToken, userSkillRoutes);

describe("GET /api/user-skills — org sharing", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetSkillsByVisibility.mockResolvedValue([]);
  });

  it("includes org members' private skills when user is in an org", async () => {
    mockGetUserById.mockResolvedValue({ userId: mockUserId, orgId: mockOrgId });
    mockGetSkillsByOwner.mockResolvedValue([mySkill]);
    mockGetSkillsByOrg.mockResolvedValue([mySkill, memberSkill]);

    const res = await request(app).get("/api/user-skills");
    expect(res.status).toBe(200);
    const ids = res.body.map((s: any) => s.skillId);
    expect(ids).toContain("skill-1");
    expect(ids).toContain("skill-2");
  });

  it("returns only own skills when user is not in an org", async () => {
    mockGetUserById.mockResolvedValue({ userId: mockUserId }); // no orgId
    mockGetSkillsByOwner.mockResolvedValue([mySkill]);

    const res = await request(app).get("/api/user-skills");
    expect(res.status).toBe(200);
    const ids = res.body.map((s: any) => s.skillId);
    expect(ids).toContain("skill-1");
    expect(ids).not.toContain("skill-2");
  });

  it("deduplicates skills appearing in both own and org results", async () => {
    mockGetUserById.mockResolvedValue({ userId: mockUserId, orgId: mockOrgId });
    mockGetSkillsByOwner.mockResolvedValue([mySkill]);
    mockGetSkillsByOrg.mockResolvedValue([mySkill, memberSkill]);

    const res = await request(app).get("/api/user-skills");
    expect(res.status).toBe(200);
    const ids = res.body.map((s: any) => s.skillId);
    const skill1Occurrences = ids.filter((id: string) => id === "skill-1").length;
    expect(skill1Occurrences).toBe(1);
  });
});

describe("PUT /api/user-skills/:skillId — org member cannot edit another member's skill", () => {
  it("returns 403 when trying to edit a skill owned by another org member", async () => {
    mockGetSkill.mockResolvedValue(memberSkill);

    const res = await request(app)
      .put("/api/user-skills/skill-2")
      .send({ name: "Hijacked" });

    expect(res.status).toBe(403);
    expect(mockUpdateSkill).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/user-skills/:skillId — org member cannot delete another member's skill", () => {
  it("returns 403 when trying to delete a skill owned by another org member", async () => {
    mockGetSkill.mockResolvedValue(memberSkill);

    const res = await request(app).delete("/api/user-skills/skill-2");

    expect(res.status).toBe(403);
    expect(mockDeleteSkill).not.toHaveBeenCalled();
  });
});

describe("POST /api/user-skills — new skill gets orgId stamped", () => {
  it("stamps the orgId from the user's record onto the new skill", async () => {
    mockGetUserById.mockResolvedValue({ userId: mockUserId, orgId: mockOrgId });
    mockCreateSkill.mockResolvedValue({ ...mySkill, skillId: "skill-new" });
    mockUpdateSkill.mockResolvedValue(undefined);

    const res = await request(app)
      .post("/api/user-skills")
      .send({ name: "New Skill", description: "desc" });

    expect(res.status).toBe(201);
    expect(mockUpdateSkill).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: mockOrgId })
    );
  });

  it("creates skill without orgId when user has no org", async () => {
    mockGetUserById.mockResolvedValue({ userId: mockUserId }); // no orgId
    mockCreateSkill.mockResolvedValue({ ...mySkill, skillId: "skill-new", orgId: undefined });
    mockUpdateSkill.mockResolvedValue(undefined);

    const res = await request(app)
      .post("/api/user-skills")
      .send({ name: "New Skill", description: "desc" });

    expect(res.status).toBe(201);
    const call = mockUpdateSkill.mock.calls[0][0];
    expect(call.orgId).toBeUndefined();
  });
});
