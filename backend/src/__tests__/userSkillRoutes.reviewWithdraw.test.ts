/**
 * Route-level tests for the ENG-932 fix: an owner previously had no way back
 * once a skill entered `pending_review` — PUT/DELETE both 403'd and there was
 * no withdraw endpoint. These assert the new withdraw route and the loosened
 * delete-by-owner behavior, independent of the skillService unit tests.
 */
import request from "supertest";
import express from "express";

jest.mock("../services/skillService", () => ({
  skillService: {
    getSkill: jest.fn(),
    deleteSkill: jest.fn(),
    withdrawFromReview: jest.fn(),
  },
}));

jest.mock("../services/db", () => ({
  userDb: { getUserById: jest.fn() },
  orgDb: { getOrgById: jest.fn() },
}));

jest.mock("../services/orgAuthz", () => ({
  can: jest.fn(() => false),
}));

jest.mock("../services/orgShareService", () => ({
  canEditItem: jest.fn(() => true),
}));

jest.mock("../services/userSkillAccessService", () => ({
  resolveUserSkillAccess: jest.fn(async () => ({ sharedOrgId: undefined })),
}));

const { skillService } = require("../services/skillService");
import userSkillRoutes from "../routes/userSkillRoutes";

const OWNER_ID = "owner-1";

function buildApp(userId: string) {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.user = { userId };
    next();
  });
  app.use("/api/user-skills", userSkillRoutes);
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("POST /:skillId/withdraw-review", () => {
  it("200s and returns the skill when the service succeeds", async () => {
    const updated = { skillId: "skill-1", visibility: "private", ownerId: OWNER_ID };
    skillService.withdrawFromReview.mockResolvedValue(updated);

    const res = await request(buildApp(OWNER_ID)).post("/api/user-skills/skill-1/withdraw-review");

    expect(res.status).toBe(200);
    expect(res.body).toEqual(updated);
    expect(skillService.withdrawFromReview).toHaveBeenCalledWith("skill-1", OWNER_ID);
  });

  it("404s when the service reports the skill missing", async () => {
    skillService.withdrawFromReview.mockRejectedValue(new Error("Skill not found"));
    const res = await request(buildApp(OWNER_ID)).post("/api/user-skills/skill-1/withdraw-review");
    expect(res.status).toBe(404);
  });

  it("403s when the requester does not own the skill", async () => {
    skillService.withdrawFromReview.mockRejectedValue(new Error("Not authorized"));
    const res = await request(buildApp("someone-else")).post("/api/user-skills/skill-1/withdraw-review");
    expect(res.status).toBe(403);
  });

  it("400s when the skill is not pending review", async () => {
    skillService.withdrawFromReview.mockRejectedValue(new Error("Skill is not pending review"));
    const res = await request(buildApp(OWNER_ID)).post("/api/user-skills/skill-1/withdraw-review");
    expect(res.status).toBe(400);
  });

  it("409s when the skill was changed concurrently (conditional-write conflict)", async () => {
    skillService.withdrawFromReview.mockRejectedValue(new Error("Skill was changed by someone else — refresh and try again"));
    const res = await request(buildApp(OWNER_ID)).post("/api/user-skills/skill-1/withdraw-review");
    expect(res.status).toBe(409);
  });

  it("500s on an unrecognized service error", async () => {
    skillService.withdrawFromReview.mockRejectedValue(new Error("Something else entirely"));
    const res = await request(buildApp(OWNER_ID)).post("/api/user-skills/skill-1/withdraw-review");
    expect(res.status).toBe(500);
  });
});

describe("DELETE /:skillId — owner can delete regardless of visibility (ENG-932)", () => {
  it.each(["private", "pending_review", "public"])(
    "200s when the owner deletes their own %s skill",
    async (visibility) => {
      skillService.getSkill.mockResolvedValue({ skillId: "skill-1", ownerId: OWNER_ID, visibility });
      skillService.deleteSkill.mockResolvedValue(undefined);

      const res = await request(buildApp(OWNER_ID)).delete("/api/user-skills/skill-1");

      expect(res.status).toBe(200);
      expect(skillService.deleteSkill).toHaveBeenCalledWith("skill-1");
    }
  );

  it("still 403s a non-owner with no admin override", async () => {
    skillService.getSkill.mockResolvedValue({ skillId: "skill-1", ownerId: OWNER_ID, visibility: "private" });
    const { userDb } = require("../services/db");
    userDb.getUserById.mockResolvedValue({ userId: "someone-else", orgId: undefined });

    const res = await request(buildApp("someone-else")).delete("/api/user-skills/skill-1");

    expect(res.status).toBe(403);
    expect(skillService.deleteSkill).not.toHaveBeenCalled();
  });

  it("still 403s an org-admin override deleting a teammate's non-private skill (unchanged scope)", async () => {
    skillService.getSkill.mockResolvedValue({ skillId: "skill-1", ownerId: OWNER_ID, visibility: "pending_review" });
    const { userDb, orgDb } = require("../services/db");
    const { can } = require("../services/orgAuthz");
    userDb.getUserById.mockImplementation(async (id: string) =>
      id === "admin-1" ? { userId: "admin-1", orgId: "org-1", orgRole: "owner" } : { userId: OWNER_ID, orgId: "org-1" }
    );
    orgDb.getOrgById.mockResolvedValue({ orgId: "org-1" });
    can.mockReturnValue(true);

    const res = await request(buildApp("admin-1")).delete("/api/user-skills/skill-1");

    expect(res.status).toBe(403);
    expect(skillService.deleteSkill).not.toHaveBeenCalled();
  });

  it("404s when the skill does not exist", async () => {
    skillService.getSkill.mockResolvedValue(null);
    const res = await request(buildApp(OWNER_ID)).delete("/api/user-skills/skill-1");
    expect(res.status).toBe(404);
  });
});
