/**
 * Route tests for the admin-editable onboarding outreach invite prompt.
 *
 * Covers the three endpoints added for the outreach pre-fill work:
 *   GET  /api/onboarding/outreach/invite-template      (any authed user)
 *   GET  /api/admin/prompt-templates/outreach/invite   (admin)
 *   PUT  /api/admin/prompt-templates/outreach/invite   (admin)
 *
 * The service layer is mocked — what these tests own is the auth gate,
 * the request validation, the status-code shaping, and the fact that
 * "outreach" is not swallowed by the `/:id` archetype route.
 */
import request from "supertest";
import express from "express";

// NOTE: deliberately no `jest.mock("aws-sdk")` here. The onboarding router now
// reaches LinkedInOutreachService (for the per-account invite char limit),
// which pulls in Secrets Manager and `AWS.config` at module load — a partial
// aws-sdk mock breaks that graph. The services that would actually touch
// DynamoDB are mocked below, so the real SDK is never used, and this matches
// how the other suites importing LinkedInOutreachService are written.

jest.mock("../middleware/auth", () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    if (req.headers["x-no-auth"] === "1") {
      req.user = undefined;
    } else {
      req.user = { userId: "user-1", email: "test@example.com", isAdmin: false };
    }
    next();
  },
}));

jest.mock("../services/outreachInvitePromptService", () => ({
  getOutreachInvitePrompt: jest.fn(),
  saveOutreachInvitePrompt: jest.fn(),
}));

// Heavy siblings pulled in by the admin router — stubbed so the module
// graph stays cheap and no real AWS/LLM client is constructed.
jest.mock("../services/promptTemplatesService", () => ({
  getTemplateForArchetype: jest.fn(),
  listAllTemplates: jest.fn(),
  saveTemplate: jest.fn(),
  getGlobalImageDirectives: jest.fn(),
  saveGlobalImageDirectives: jest.fn(),
}));
jest.mock("../services/promptSignalsService", () => ({
  computeLikeRate: jest.fn(),
  getPromptSignalSummary: jest.fn(),
}));
jest.mock("../services/onboardingAdImageService", () => ({
  PROMPT_BUILDER_VERSION: "v-test",
}));
jest.mock("../services/imagePromptQualityService", () => ({
  analyzeImagePromptQuality: jest.fn(),
}));
jest.mock("../services/outreachProspectPreviewService", () => ({
  searchProspectsPreview: jest.fn(),
}));
jest.mock("../services/outreachOnboardingSaveService", () => ({
  saveOutreachProspects: jest.fn(),
}));

import adminPromptTemplatesRoutes from "../routes/adminPromptTemplates";
import outreachOnboardingRoutes from "../routes/outreachOnboarding";
const {
  getOutreachInvitePrompt,
  saveOutreachInvitePrompt,
} = require("../services/outreachInvitePromptService");

const ROW = {
  templateId: "onboarding-outreach-invite",
  version: "v2-2026-07-10",
  systemPrompt: "SYSTEM PROMPT",
  withCompanyVariants: ["Hi {firstName} at {company}"],
  withoutCompanyVariants: ["Hi {firstName}"],
  updatedAt: "2026-07-10T00:00:00Z",
  updatedBy: "admin-1",
};

const DEFAULT_ADMIN = { userId: "admin-1", isAdmin: true };

/**
 * Admin router is gated by authenticateToken + isAdmin at the app.ts mount.
 * Pass `null` to simulate a request that reached the handler with no user.
 */
function buildApp(adminUser: any = DEFAULT_ADMIN) {
  const app = express();
  app.use(express.json());
  app.use("/api/onboarding", outreachOnboardingRoutes);
  app.use(
    "/api/admin/prompt-templates",
    (req: any, _res, next) => {
      req.user = adminUser ?? undefined;
      next();
    },
    adminPromptTemplatesRoutes,
  );
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  getOutreachInvitePrompt.mockResolvedValue(ROW);
  saveOutreachInvitePrompt.mockResolvedValue(ROW);
});

describe("GET /api/onboarding/outreach/invite-template", () => {
  it("401s when the user is not authenticated", async () => {
    const res = await request(buildApp())
      .get("/api/onboarding/outreach/invite-template")
      .set("x-no-auth", "1");
    expect(res.status).toBe(401);
    expect(getOutreachInvitePrompt).not.toHaveBeenCalled();
  });

  it("returns the variant pool to an authed onboarding user", async () => {
    const res = await request(buildApp()).get(
      "/api/onboarding/outreach/invite-template",
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      withCompanyVariants: ROW.withCompanyVariants,
      withoutCompanyVariants: ROW.withoutCompanyVariants,
      version: ROW.version,
    });
  });

  it("does not leak the system prompt to onboarding users (composed server-side only)", async () => {
    const res = await request(buildApp()).get(
      "/api/onboarding/outreach/invite-template",
    );
    expect(res.body.systemPrompt).toBeUndefined();
  });

  it("500s when the service rejects", async () => {
    getOutreachInvitePrompt.mockRejectedValueOnce(new Error("ddb down"));
    const res = await request(buildApp()).get(
      "/api/onboarding/outreach/invite-template",
    );
    expect(res.status).toBe(500);
    expect(res.body.message).toBe("ddb down");
  });
});

describe("GET /api/admin/prompt-templates/outreach/invite", () => {
  it("returns the row and is not swallowed by the /:id archetype route", async () => {
    const res = await request(buildApp()).get(
      "/api/admin/prompt-templates/outreach/invite",
    );
    expect(res.status).toBe(200);
    expect(res.body.template).toEqual(ROW);
    expect(getOutreachInvitePrompt).toHaveBeenCalledTimes(1);
  });

  it("500s when the service rejects", async () => {
    getOutreachInvitePrompt.mockRejectedValueOnce(new Error("boom"));
    const res = await request(buildApp()).get(
      "/api/admin/prompt-templates/outreach/invite",
    );
    expect(res.status).toBe(500);
    expect(res.body.message).toMatch(/Failed to get outreach invite prompt/);
  });
});

describe("PUT /api/admin/prompt-templates/outreach/invite", () => {
  it("400s when a variant list is not an array", async () => {
    const res = await request(buildApp())
      .put("/api/admin/prompt-templates/outreach/invite")
      .send({ withCompanyVariants: "not-an-array" });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/withCompanyVariants/);
    expect(saveOutreachInvitePrompt).not.toHaveBeenCalled();
  });

  it("400s when a variant list has no usable entries (never persist an empty pool)", async () => {
    const res = await request(buildApp())
      .put("/api/admin/prompt-templates/outreach/invite")
      .send({ withoutCompanyVariants: ["", "   "] });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/withoutCompanyVariants/);
    expect(saveOutreachInvitePrompt).not.toHaveBeenCalled();
  });

  it("400s when systemPrompt is present but blank", async () => {
    const res = await request(buildApp())
      .put("/api/admin/prompt-templates/outreach/invite")
      .send({ systemPrompt: "   " });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/systemPrompt/);
    expect(saveOutreachInvitePrompt).not.toHaveBeenCalled();
  });

  it("saves the merged fields and stamps updatedBy from the admin's userId", async () => {
    const res = await request(buildApp())
      .put("/api/admin/prompt-templates/outreach/invite")
      .send({
        systemPrompt: "NEW PROMPT",
        withCompanyVariants: ["Hi {firstName} at {company}!"],
      });
    expect(res.status).toBe(200);
    expect(res.body.template).toEqual(ROW);
    expect(saveOutreachInvitePrompt).toHaveBeenCalledWith({
      systemPrompt: "NEW PROMPT",
      withCompanyVariants: ["Hi {firstName} at {company}!"],
      withoutCompanyVariants: undefined,
      updatedBy: "admin-1",
    });
  });

  it("accepts an empty body as a no-op save (all fields undefined)", async () => {
    const res = await request(buildApp()).put(
      "/api/admin/prompt-templates/outreach/invite",
    );
    expect(res.status).toBe(200);
    expect(saveOutreachInvitePrompt).toHaveBeenCalledWith({
      systemPrompt: undefined,
      withCompanyVariants: undefined,
      withoutCompanyVariants: undefined,
      updatedBy: "admin-1",
    });
  });

  it("falls back to unknown-admin when the request carries no user", async () => {
    const res = await request(buildApp(null))
      .put("/api/admin/prompt-templates/outreach/invite")
      .send({ systemPrompt: "NEW PROMPT" });
    expect(res.status).toBe(200);
    expect(saveOutreachInvitePrompt.mock.calls[0][0].updatedBy).toBe(
      "unknown-admin",
    );
  });

  it("500s when the save rejects", async () => {
    saveOutreachInvitePrompt.mockRejectedValueOnce(new Error("write failed"));
    const res = await request(buildApp())
      .put("/api/admin/prompt-templates/outreach/invite")
      .send({ systemPrompt: "NEW PROMPT" });
    expect(res.status).toBe(500);
    expect(res.body.message).toMatch(/Failed to save outreach invite prompt/);
  });
});
