/**
 * Route-level tests for userInstructions pass-through.
 *
 * Bug discovered when an admin saved user instructions in the partner
 * portal's Work Plans editor and the field disappeared on reload. Both
 * the admin and user route handlers were whitelisting step fields
 * (stepCount/title/description/requiredFunctionCalls/skillIds) and
 * silently dropping userInstructions before calling the service. The
 * service-level tests (workPlanService.test.ts) were green because
 * they invoked the service directly, bypassing the route filter.
 *
 * These tests assert the field round-trips end-to-end through the route
 * → service boundary on both POST and PUT, for both routes.
 */
import request from "supertest";
import express from "express";

jest.mock("../services/workPlanService", () => ({
  workPlanService: {
    createWorkPlan: jest.fn(),
    getWorkPlan: jest.fn(),
    updateWorkPlan: jest.fn(),
  },
}));

jest.mock("../services/workPlanThumbnailService", () => ({
  workPlanThumbnailService: {
    generateAIThumbnail: jest.fn(() => Promise.resolve()),
  },
}));

jest.mock("../middleware/auth", () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = { userId: "user-1", email: "test@example.com", isAdmin: true };
    next();
  },
  isAdmin: (_req: any, _res: any, next: any) => next(),
}));

import { authenticateToken, isAdmin } from "../middleware/auth";
import adminWorkPlanRoutes from "../routes/adminWorkPlanRoutes";
import userWorkPlanRoutes from "../routes/userWorkPlanRoutes";
const { workPlanService } = require("../services/workPlanService");

const app = express();
app.use(express.json());
// Mirror the real app's middleware chain — auth runs before the routes
// so req.user gets populated (the mock above sets it inline).
app.use("/api/admin/work-plans", authenticateToken, isAdmin, adminWorkPlanRoutes);
app.use("/api/user-work-plans", authenticateToken, userWorkPlanRoutes);

const STEP_WITH_INSTRUCTIONS = {
  stepCount: 1,
  title: "Score the profile",
  description: "LLM prompt content here",
  userInstructions: "Click Generate. Expect a CSV download with the scores.",
  requiredFunctionCalls: [],
};

describe("POST /api/admin/work-plans — userInstructions pass-through", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    workPlanService.createWorkPlan.mockResolvedValue({
      planId: "plan-1",
      title: "Test",
      steps: [STEP_WITH_INSTRUCTIONS],
      visibility: "system",
      isBuiltIn: true,
      createdAt: "2026-05-09T00:00:00Z",
      updatedAt: "2026-05-09T00:00:00Z",
    });
  });

  it("forwards step.userInstructions to workPlanService.createWorkPlan", async () => {
    const res = await request(app)
      .post("/api/admin/work-plans")
      .send({
        title: "Test Plan",
        steps: [STEP_WITH_INSTRUCTIONS],
        visibility: "system",
      });
    expect(res.status).toBe(201);
    const arg = workPlanService.createWorkPlan.mock.calls[0][0];
    expect(arg.steps[0].userInstructions).toBe(
      "Click Generate. Expect a CSV download with the scores.",
    );
  });
});

describe("PUT /api/admin/work-plans/:planId — userInstructions pass-through", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    workPlanService.getWorkPlan.mockResolvedValue({
      planId: "plan-1",
      title: "Existing",
      steps: [{ stepCount: 1, title: "Old step" }],
      visibility: "system",
      isBuiltIn: true,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    });
    workPlanService.updateWorkPlan.mockResolvedValue(undefined);
  });

  it("forwards step.userInstructions to workPlanService.updateWorkPlan", async () => {
    const res = await request(app)
      .put("/api/admin/work-plans/plan-1")
      .send({
        title: "Updated Plan",
        steps: [STEP_WITH_INSTRUCTIONS],
      });
    expect(res.status).toBe(200);
    const arg = workPlanService.updateWorkPlan.mock.calls[0][0];
    expect(arg.steps[0].userInstructions).toBe(
      "Click Generate. Expect a CSV download with the scores.",
    );
  });
});

describe("POST /api/user-work-plans — userInstructions pass-through", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    workPlanService.createWorkPlan.mockResolvedValue({
      planId: "plan-2",
      title: "User plan",
      steps: [STEP_WITH_INSTRUCTIONS],
      ownerId: "user-1",
      visibility: "private",
      isBuiltIn: false,
      createdAt: "2026-05-09T00:00:00Z",
      updatedAt: "2026-05-09T00:00:00Z",
    });
  });

  it("forwards step.userInstructions to workPlanService.createWorkPlan", async () => {
    const res = await request(app)
      .post("/api/user-work-plans")
      .send({
        title: "My Plan",
        steps: [STEP_WITH_INSTRUCTIONS],
      });
    expect(res.status).toBeLessThan(400);
    const arg = workPlanService.createWorkPlan.mock.calls[0][0];
    expect(arg.steps[0].userInstructions).toBe(
      "Click Generate. Expect a CSV download with the scores.",
    );
  });
});

describe("PUT /api/user-work-plans/:planId — userInstructions pass-through", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    workPlanService.getWorkPlan.mockResolvedValue({
      planId: "plan-2",
      title: "Mine",
      steps: [{ stepCount: 1, title: "Old step" }],
      ownerId: "user-1",
      visibility: "private",
      isBuiltIn: false,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    });
    workPlanService.updateWorkPlan.mockResolvedValue(undefined);
  });

  it("forwards step.userInstructions to workPlanService.updateWorkPlan", async () => {
    const res = await request(app)
      .put("/api/user-work-plans/plan-2")
      .send({
        title: "Updated",
        steps: [STEP_WITH_INSTRUCTIONS],
      });
    expect(res.status).toBeLessThan(400);
    const arg = workPlanService.updateWorkPlan.mock.calls[0][0];
    expect(arg.steps[0].userInstructions).toBe(
      "Click Generate. Expect a CSV download with the scores.",
    );
  });
});

describe("backwards compat — steps without userInstructions still work", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    workPlanService.createWorkPlan.mockResolvedValue({
      planId: "plan-3",
      title: "Plain",
      steps: [{ stepCount: 1, title: "Step" }],
      visibility: "system",
      isBuiltIn: true,
      createdAt: "2026-05-09T00:00:00Z",
      updatedAt: "2026-05-09T00:00:00Z",
    });
  });

  it("forwards undefined userInstructions cleanly (no field on the saved step)", async () => {
    const res = await request(app)
      .post("/api/admin/work-plans")
      .send({
        title: "Plain Plan",
        steps: [{ stepCount: 1, title: "Step", description: "desc" }],
        visibility: "system",
      });
    expect(res.status).toBe(201);
    const arg = workPlanService.createWorkPlan.mock.calls[0][0];
    expect(arg.steps[0].userInstructions).toBeUndefined();
  });
});
