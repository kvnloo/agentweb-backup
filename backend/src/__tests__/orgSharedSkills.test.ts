/**
 * Tests for org-shared skills.
 *
 * When a user belongs to an org, GET /api/user-skills should include
 * private skills from other org members (not just their own) when the org's
 * skills sharing toggle is enabled. Skills are member-owned: any member may
 * create their own, and only the item owner may edit or delete it (no editor
 * delegation, no org-owner override).
 */
import request from "supertest";
import express from "express";

const mockUserId = "user-1";
const mockOrgMemberId = "user-2";
const mockEditorId = "user-3";
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

// Org with skills sharing enabled; user-3 is an editor
const mockOrgEnabled = {
  orgId: mockOrgId,
  ownerUserId: "org-owner",
  shareSettings: {
    skills: { enabled: true, editors: [mockEditorId] },
  },
};

// Org with skills sharing disabled
const mockOrgDisabled = {
  orgId: mockOrgId,
  ownerUserId: "org-owner",
  shareSettings: {
    skills: { enabled: false, editors: [] },
  },
};

const mockGetSkillsByOwner = jest.fn();
const mockGetSkillsByOrg = jest.fn();
const mockGetSkillsByVisibility = jest.fn();
const mockGetSkillsAvailableToUser = jest.fn();
const mockGetSkill = jest.fn();
const mockUpdateSkill = jest.fn();
const mockDeleteSkill = jest.fn();
const mockCreateSkill = jest.fn();

jest.mock("../services/skillService", () => ({
  skillService: {
    getSkillsByOwner: mockGetSkillsByOwner,
    getSkillsByOrg: mockGetSkillsByOrg,
    getSkillsByVisibility: mockGetSkillsByVisibility,
    getSkillsAvailableToUser: mockGetSkillsAvailableToUser,
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
const mockGetOrgById = jest.fn();
jest.mock("../services/db", () => ({
  userDb: { getUserById: mockGetUserById },
  orgDb: { getOrgById: mockGetOrgById },
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
    mockGetSkillsAvailableToUser.mockImplementation(async (userId: string, orgId?: string) => {
      const [own, org, publicSkills, systemSkills] = await Promise.all([
        mockGetSkillsByOwner(userId),
        orgId ? mockGetSkillsByOrg(orgId, userId) : [],
        mockGetSkillsByVisibility('public'),
        mockGetSkillsByVisibility('system'),
      ]);
      const seen = new Set<string>();
      return [...own, ...org, ...publicSkills, ...systemSkills].filter(skill =>
        seen.has(skill.skillId) ? false : (seen.add(skill.skillId), true)
      );
    });
  });

  it("includes org members' private skills when user is in an org (skills enabled)", async () => {
    mockGetUserById.mockResolvedValue({ userId: mockUserId, orgId: mockOrgId });
    mockGetOrgById.mockResolvedValue(mockOrgEnabled);
    mockGetSkillsByOwner.mockResolvedValue([mySkill]);
    // getSkillsByOrg returns only OTHER members' skills (not caller's)
    mockGetSkillsByOrg.mockResolvedValue([memberSkill]);

    const res = await request(app).get("/api/user-skills");
    expect(res.status).toBe(200);
    const ids = res.body.items.map((s: any) => s.skillId);
    expect(ids).toContain("skill-1");
    expect(ids).toContain("skill-2");
  });

  it("returns only own skills when user is not in an org", async () => {
    mockGetUserById.mockResolvedValue({ userId: mockUserId }); // no orgId
    mockGetSkillsByOwner.mockResolvedValue([mySkill]);

    const res = await request(app).get("/api/user-skills");
    expect(res.status).toBe(200);
    const ids = res.body.items.map((s: any) => s.skillId);
    expect(ids).toContain("skill-1");
    expect(ids).not.toContain("skill-2");
  });

  it("deduplicates skills appearing in both own and org results", async () => {
    mockGetUserById.mockResolvedValue({ userId: mockUserId, orgId: mockOrgId });
    mockGetOrgById.mockResolvedValue(mockOrgEnabled);
    mockGetSkillsByOwner.mockResolvedValue([mySkill]);
    // Suppose org fanout also returned mySkill somehow (shouldn't in practice, but dedup guard)
    mockGetSkillsByOrg.mockResolvedValue([mySkill, memberSkill]);

    const res = await request(app).get("/api/user-skills");
    expect(res.status).toBe(200);
    const ids = res.body.items.map((s: any) => s.skillId);
    const skill1Occurrences = ids.filter((id: string) => id === "skill-1").length;
    expect(skill1Occurrences).toBe(1);
  });

  it("includes org members' skills by default when org has no shareSettings (regression: shared-by-default)", async () => {
    // Reproduces the reported bug: an org created without shareSettings (e.g.
    // after the one-time backfill migration ran) should still share skills
    // org-wide by default for plain members.
    mockGetUserById.mockResolvedValue({ userId: mockUserId, orgId: mockOrgId, orgRole: "member" });
    mockGetOrgById.mockResolvedValue({ orgId: mockOrgId, ownerUserId: "org-owner" }); // no shareSettings
    mockGetSkillsByOwner.mockResolvedValue([mySkill]);
    mockGetSkillsByOrg.mockResolvedValue([memberSkill]);

    const res = await request(app).get("/api/user-skills");
    expect(res.status).toBe(200);
    const ids = res.body.items.map((s: any) => s.skillId);
    expect(ids).toContain("skill-1");
    expect(ids).toContain("skill-2");
    expect(mockGetSkillsByOrg).toHaveBeenCalledWith(mockOrgId, mockUserId);
  });

  it("list excludes other-member skills when shareSettings.skills.enabled is false", async () => {
    mockGetUserById.mockResolvedValue({ userId: mockUserId, orgId: mockOrgId });
    mockGetOrgById.mockResolvedValue(mockOrgDisabled);
    mockGetSkillsByOwner.mockResolvedValue([mySkill]);
    // getSkillsByOrg should NOT be called when feature is disabled
    mockGetSkillsByOrg.mockResolvedValue([memberSkill]);

    const res = await request(app).get("/api/user-skills");
    expect(res.status).toBe(200);
    const ids = res.body.items.map((s: any) => s.skillId);
    expect(ids).toContain("skill-1");
    expect(ids).not.toContain("skill-2");
    // Confirm org fanout was not invoked
    expect(mockGetSkillsByOrg).not.toHaveBeenCalled();
  });

  it("response is wrapped in { items, truncated } envelope", async () => {
    mockGetUserById.mockResolvedValue({ userId: mockUserId, orgId: mockOrgId });
    mockGetOrgById.mockResolvedValue(mockOrgEnabled);
    mockGetSkillsByOwner.mockResolvedValue([mySkill]);
    mockGetSkillsByOrg.mockResolvedValue([memberSkill]);

    const res = await request(app).get("/api/user-skills");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("items");
    expect(res.body).toHaveProperty("truncated");
    expect(Array.isArray(res.body.items)).toBe(true);
  });
});

describe("PUT /api/user-skills/:skillId — org member cannot edit another member's skill", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns 403 when trying to edit a skill owned by another org member (non-editor)", async () => {
    mockGetSkill.mockResolvedValue(memberSkill);
    // Caller is user-1, a plain member (not in editors list)
    mockGetUserById.mockResolvedValue({ userId: mockUserId, orgId: mockOrgId, orgRole: "member" });
    mockGetOrgById.mockResolvedValue(mockOrgEnabled);

    const res = await request(app)
      .put("/api/user-skills/skill-2")
      .send({ name: "Hijacked" });

    expect(res.status).toBe(403);
    expect(mockUpdateSkill).not.toHaveBeenCalled();
  });

  it("owner can edit their own skill", async () => {
    mockGetSkill.mockResolvedValue(mySkill);
    mockGetUserById.mockResolvedValue({ userId: mockUserId, orgId: mockOrgId, orgRole: "member" });
    mockGetOrgById.mockResolvedValue(mockOrgEnabled);
    mockUpdateSkill.mockResolvedValue(undefined);

    const res = await request(app)
      .put("/api/user-skills/skill-1")
      .send({ name: "Updated" });

    expect(res.status).toBe(200);
    expect(mockUpdateSkill).toHaveBeenCalled();
  });
});

describe("PUT /api/user-skills/:skillId — skills are owner-edit-only (no editor delegation)", () => {
  // Use a separate app where the authenticated user is user-3 (a listed editor)
  const editorApp = express();
  editorApp.use(express.json());
  editorApp.use("/api/user-skills", (req: any, _res: any, next: any) => {
    req.user = { userId: mockEditorId, email: "editor@example.com", isAdmin: false };
    next();
  }, userSkillRoutes);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("a listed skills editor CANNOT PATCH another member's skill (owner-only)", async () => {
    mockGetSkill.mockResolvedValue(memberSkill);
    // When getUserById is called for editorId (caller) or ownerId (user-2), return appropriate objects
    mockGetUserById.mockImplementation((uid: string) => {
      if (uid === mockEditorId) return Promise.resolve({ userId: mockEditorId, orgId: mockOrgId, orgRole: "member" });
      if (uid === mockOrgMemberId) return Promise.resolve({ userId: mockOrgMemberId, orgId: mockOrgId, orgRole: "member" });
      return Promise.resolve(null);
    });
    mockGetOrgById.mockResolvedValue(mockOrgEnabled);

    const res = await request(editorApp)
      .put("/api/user-skills/skill-2")
      .send({ name: "Editor Update" });

    expect(res.status).toBe(403);
    expect(mockUpdateSkill).not.toHaveBeenCalled();
  });

  it("non-editor org member is rejected with 403 on PATCH", async () => {
    // user-1 is not in editors list for skill-2 (owned by user-2)
    mockGetSkill.mockResolvedValue(memberSkill);
    mockGetUserById.mockImplementation((uid: string) => {
      if (uid === mockUserId) return Promise.resolve({ userId: mockUserId, orgId: mockOrgId, orgRole: "member" });
      if (uid === mockOrgMemberId) return Promise.resolve({ userId: mockOrgMemberId, orgId: mockOrgId, orgRole: "member" });
      return Promise.resolve(null);
    });
    mockGetOrgById.mockResolvedValue(mockOrgEnabled);

    const res = await request(app)
      .put("/api/user-skills/skill-2")
      .send({ name: "Hijacked" });

    expect(res.status).toBe(403);
    expect(mockUpdateSkill).not.toHaveBeenCalled();
  });

  it("org owner can PATCH another same-org member's skill (admin override)", async () => {
    const orgOwnerUserId = "user-org-owner";
    const orgOwnerApp = express();
    orgOwnerApp.use(express.json());
    orgOwnerApp.use("/api/user-skills", (req: any, _res: any, next: any) => {
      req.user = { userId: orgOwnerUserId, email: "orgowner@example.com", isAdmin: false };
      next();
    }, userSkillRoutes);

    mockGetSkill.mockResolvedValue(memberSkill); // owned by user-2
    mockGetUserById.mockImplementation((uid: string) => {
      if (uid === orgOwnerUserId) return Promise.resolve({ userId: orgOwnerUserId, orgId: mockOrgId, orgRole: "owner" });
      if (uid === mockOrgMemberId) return Promise.resolve({ userId: mockOrgMemberId, orgId: mockOrgId, orgRole: "member" });
      return Promise.resolve(null);
    });
    mockGetOrgById.mockResolvedValue(mockOrgEnabled);
    mockUpdateSkill.mockResolvedValue(undefined);

    const res = await request(orgOwnerApp)
      .put("/api/user-skills/skill-2")
      .send({ name: "Owner Override" });

    expect(res.status).toBe(200);
    expect(mockUpdateSkill).toHaveBeenCalled();
  });
});

describe("DELETE /api/user-skills/:skillId — org member cannot delete another member's skill", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns 403 when trying to delete a skill owned by another org member (non-admin)", async () => {
    mockGetSkill.mockResolvedValue(memberSkill);
    mockGetUserById.mockResolvedValue({ userId: mockUserId, orgId: mockOrgId, orgRole: "member" });

    const res = await request(app).delete("/api/user-skills/skill-2");

    expect(res.status).toBe(403);
    expect(mockDeleteSkill).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/user-skills/:skillId — owner or org-owner may delete; editors cannot", () => {
  // Editor app (user-3 is an editor but not org owner)
  const editorApp = express();
  editorApp.use(express.json());
  editorApp.use("/api/user-skills", (req: any, _res: any, next: any) => {
    req.user = { userId: mockEditorId, email: "editor@example.com", isAdmin: false };
    next();
  }, userSkillRoutes);

  // Org owner app
  const orgOwnerUserId = "user-org-owner";
  const orgOwnerApp = express();
  orgOwnerApp.use(express.json());
  orgOwnerApp.use("/api/user-skills", (req: any, _res: any, next: any) => {
    req.user = { userId: orgOwnerUserId, email: "orgowner@example.com", isAdmin: false };
    next();
  }, userSkillRoutes);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("editor cannot delete another member's skill even when in editors list", async () => {
    mockGetSkill.mockResolvedValue(memberSkill);
    mockGetUserById.mockImplementation((uid: string) => {
      if (uid === mockEditorId) return Promise.resolve({ userId: mockEditorId, orgId: mockOrgId, orgRole: "member" });
      if (uid === mockOrgMemberId) return Promise.resolve({ userId: mockOrgMemberId, orgId: mockOrgId, orgRole: "member" });
      return Promise.resolve(null);
    });

    const res = await request(editorApp).delete("/api/user-skills/skill-2");

    expect(res.status).toBe(403);
    expect(mockDeleteSkill).not.toHaveBeenCalled();
  });

  it("org owner (orgRole=owner) can delete another same-org member's skill (admin override)", async () => {
    const privateSkillByMember = { ...memberSkill, visibility: "private" };
    mockGetSkill.mockResolvedValue(privateSkillByMember);
    mockGetUserById.mockImplementation((uid: string) => {
      if (uid === orgOwnerUserId) return Promise.resolve({ userId: orgOwnerUserId, orgId: mockOrgId, orgRole: "owner" });
      if (uid === mockOrgMemberId) return Promise.resolve({ userId: mockOrgMemberId, orgId: mockOrgId, orgRole: "member" });
      return Promise.resolve(null);
    });
    mockDeleteSkill.mockResolvedValue(undefined);

    const res = await request(orgOwnerApp).delete("/api/user-skills/skill-2");

    expect(res.status).toBe(200);
    expect(mockDeleteSkill).toHaveBeenCalledWith("skill-2");
  });

  it("skill owner can delete their own skill", async () => {
    mockGetSkill.mockResolvedValue(mySkill);
    mockDeleteSkill.mockResolvedValue(undefined);

    const res = await request(app).delete("/api/user-skills/skill-1");

    expect(res.status).toBe(200);
    expect(mockDeleteSkill).toHaveBeenCalledWith("skill-1");
  });
});

describe("POST /api/user-skills — new skill gets orgId stamped", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("stamps the orgId from the user's record onto the new skill (editor allowed)", async () => {
    mockGetUserById.mockResolvedValue({ userId: mockUserId, orgId: mockOrgId, orgRole: "member" });
    mockGetOrgById.mockResolvedValue({
      orgId: mockOrgId,
      shareSettings: { skills: { enabled: false, editors: [mockUserId] } },
    });
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

  it("preserves the legacy create call shape when welcomeMessage is absent", async () => {
    mockGetUserById.mockResolvedValue({ userId: mockUserId });
    mockCreateSkill.mockResolvedValue({ ...mySkill, skillId: "skill-legacy" });
    await request(app).post("/api/user-skills").send({ name: "Legacy", description: "d" });
    expect(mockCreateSkill).toHaveBeenCalledWith("Legacy", "d", [], undefined, false);
  });

  it("passes the existing welcomeMessage field through canonical user-skill creation", async () => {
    mockGetUserById.mockResolvedValue({ userId: mockUserId });
    mockCreateSkill.mockResolvedValue({ ...mySkill, skillId: "skill-brief" });
    await request(app).post("/api/user-skills").send({
      name: "Brief", description: "d", welcomeMessage: "**Bring** [the artifact](https://example.com).",
    });
    expect(mockCreateSkill).toHaveBeenCalledWith(
      "Brief", "d", [], undefined, false, "**Bring** [the artifact](https://example.com)."
    );
  });

  it.each([
    '<script>alert(1)</script>',
    '<iframe src="https://evil.test"></iframe>',
    '<form action="https://evil.test"><input></form>',
    '<img src=x onerror="alert(1)">',
    'hello\u0000world',
    null,
  ])("rejects unsafe welcomeMessage before user-skill creation: %s", async (welcomeMessage) => {
    const res = await request(app).post("/api/user-skills").send({
      name: "Unsafe", description: "d", welcomeMessage,
    });

    expect(res.status).toBe(400);
    expect(mockCreateSkill).not.toHaveBeenCalled();
  });
});

describe("PUT /api/user-skills/:skillId — welcomeMessage", () => {
  it("updates the existing welcomeMessage field on an owned private skill", async () => {
    mockGetSkill.mockResolvedValue(mySkill);
    mockGetUserById.mockResolvedValue({ userId: mockUserId, orgId: mockOrgId });
    mockGetOrgById.mockResolvedValue(mockOrgEnabled);

    const res = await request(app).put("/api/user-skills/skill-1").send({
      welcomeMessage: "Updated static brief.",
    });

    expect(res.status).toBe(200);
    expect(mockUpdateSkill).toHaveBeenCalledWith(expect.objectContaining({
      skillId: "skill-1", welcomeMessage: "Updated static brief.",
    }));
  });

  it.each(['<svg/onload=alert(1)>', null])("rejects unsafe welcomeMessage before updating an owned skill: %s", async (welcomeMessage) => {
    mockGetSkill.mockResolvedValue(mySkill);
    mockGetUserById.mockResolvedValue({ userId: mockUserId, orgId: mockOrgId });
    mockGetOrgById.mockResolvedValue(mockOrgEnabled);

    const res = await request(app).put("/api/user-skills/skill-1").send({
      welcomeMessage,
    });

    expect(res.status).toBe(400);
    expect(mockUpdateSkill).not.toHaveBeenCalled();
  });
});

describe("POST /api/user-skills — any org member may create their own skill", () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it("org owner can create regardless of toggle", async () => {
    mockGetUserById.mockResolvedValue({ userId: mockUserId, orgId: mockOrgId, orgRole: "owner" });
    mockGetOrgById.mockResolvedValue({
      orgId: mockOrgId,
      shareSettings: { skills: { enabled: false, editors: [] } },
    });
    mockCreateSkill.mockResolvedValue({ ...mySkill, skillId: "owner-skill" });
    mockUpdateSkill.mockResolvedValue(undefined);

    const res = await request(app)
      .post("/api/user-skills")
      .send({ name: "Owner Skill", description: "d" });

    expect(res.status).toBe(201);
    expect(mockCreateSkill).toHaveBeenCalledTimes(1);
  });

  it("a plain org member can create even when sharing is disabled (skills are member-owned)", async () => {
    mockGetUserById.mockResolvedValue({ userId: mockUserId, orgId: mockOrgId, orgRole: "member" });
    mockGetOrgById.mockResolvedValue({
      orgId: mockOrgId,
      shareSettings: { skills: { enabled: false, editors: [] } },
    });
    mockCreateSkill.mockResolvedValue({ ...mySkill, skillId: "member-skill" });
    mockUpdateSkill.mockResolvedValue(undefined);

    const res = await request(app)
      .post("/api/user-skills")
      .send({ name: "Member Skill", description: "d" });

    expect(res.status).toBe(201);
    expect(mockCreateSkill).toHaveBeenCalledTimes(1);
  });

  it("a plain org member can create when sharing is enabled (no editor list required)", async () => {
    mockGetUserById.mockResolvedValue({ userId: mockUserId, orgId: mockOrgId, orgRole: "member" });
    mockGetOrgById.mockResolvedValue({
      orgId: mockOrgId,
      shareSettings: { skills: { enabled: true, editors: [] } },
    });
    mockCreateSkill.mockResolvedValue({ ...mySkill, skillId: "member-skill-2" });
    mockUpdateSkill.mockResolvedValue(undefined);

    const res = await request(app)
      .post("/api/user-skills")
      .send({ name: "Member Attempt", description: "d" });

    expect(res.status).toBe(201);
    expect(mockCreateSkill).toHaveBeenCalledTimes(1);
  });
});
