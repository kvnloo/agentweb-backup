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

// ─── ENG-889 ────────────────────────────────────────────────────────────────
// Third instance of the same defect the tests above cover: the route rebuilds
// each step from a fixed field list, so anything outside that list is dropped
// on a 200/201 with no signal. userInstructions was the first casualty, the
// snake_case `required_function_calls` alias the second (ENG-889), and
// expectedAssetCount — the asset-count completion gate's input — the third.
// These tests pin both halves: the field round-trips, and an unrecognized
// field is reported back to the caller instead of vanishing.
const STEP_WITH_ASSET_COUNT = {
  stepCount: 1,
  title: "Generate 3 Images Per Hook",
  description: "generate 3 images per hook (18 total)",
  requiredFunctionCalls: ["generate_image"],
  expectedAssetCount: 18,
};

describe("expectedAssetCount pass-through", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    workPlanService.createWorkPlan.mockResolvedValue({
      planId: "plan-assets",
      title: "Creative Hub",
      steps: [STEP_WITH_ASSET_COUNT],
      visibility: "system",
      isBuiltIn: true,
      createdAt: "2026-08-04T00:00:00Z",
      updatedAt: "2026-08-04T00:00:00Z",
    });
    workPlanService.getWorkPlan.mockResolvedValue({
      planId: "plan-assets",
      title: "Creative Hub",
      steps: [],
      visibility: "system",
      isBuiltIn: true,
      createdAt: "2026-08-04T00:00:00Z",
      updatedAt: "2026-08-04T00:00:00Z",
    });
    workPlanService.updateWorkPlan.mockResolvedValue(undefined);
  });

  it("forwards step.expectedAssetCount on admin create", async () => {
    const res = await request(app)
      .post("/api/admin/work-plans")
      .send({ title: "Creative Hub", steps: [STEP_WITH_ASSET_COUNT], visibility: "system" });

    expect(res.status).toBe(201);
    const arg = workPlanService.createWorkPlan.mock.calls[0][0];
    expect(arg.steps[0].expectedAssetCount).toBe(18);
  });

  it("forwards step.expectedAssetCount on admin update", async () => {
    const res = await request(app)
      .put("/api/admin/work-plans/plan-assets")
      .send({ title: "Creative Hub", steps: [STEP_WITH_ASSET_COUNT] });

    expect(res.status).toBe(200);
    const arg = workPlanService.updateWorkPlan.mock.calls[0][0];
    expect(arg.steps[0].expectedAssetCount).toBe(18);
  });

  it("forwards step.expectedAssetCount on user create", async () => {
    const res = await request(app)
      .post("/api/user-work-plans")
      .send({ title: "Creative Hub", steps: [STEP_WITH_ASSET_COUNT] });

    expect(res.status).toBe(201);
    const arg = workPlanService.createWorkPlan.mock.calls[0][0];
    expect(arg.steps[0].expectedAssetCount).toBe(18);
  });

  it("omits expectedAssetCount entirely when the caller did not send it", async () => {
    await request(app)
      .post("/api/admin/work-plans")
      .send({ title: "Plain", steps: [{ stepCount: 1, title: "Step" }], visibility: "system" });

    const arg = workPlanService.createWorkPlan.mock.calls[0][0];
    expect("expectedAssetCount" in arg.steps[0]).toBe(false);
  });
});

describe("unrecognized step fields are reported, not silently dropped", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    workPlanService.createWorkPlan.mockResolvedValue({
      planId: "plan-warn",
      title: "Warned",
      steps: [{ stepCount: 1, title: "Step" }],
      visibility: "system",
      isBuiltIn: true,
      createdAt: "2026-08-04T00:00:00Z",
      updatedAt: "2026-08-04T00:00:00Z",
    });
    workPlanService.getWorkPlan.mockResolvedValue({
      planId: "plan-warn",
      title: "Warned",
      steps: [],
      visibility: "system",
      isBuiltIn: true,
      createdAt: "2026-08-04T00:00:00Z",
      updatedAt: "2026-08-04T00:00:00Z",
    });
    workPlanService.updateWorkPlan.mockResolvedValue(undefined);
  });

  it("names the ignored field and its 1-based step on admin create", async () => {
    const res = await request(app)
      .post("/api/admin/work-plans")
      .send({
        title: "Warned",
        steps: [
          { stepCount: 1, title: "Step 1" },
          { stepCount: 2, title: "Step 2", mystery_field: ["x"] },
        ],
        visibility: "system",
      });

    expect(res.status).toBe(201);
    expect(res.body.warnings).toEqual([
      "step 2: ignored unrecognized field 'mystery_field'",
    ]);
  });

  it("lists every ignored field on a step", async () => {
    const res = await request(app)
      .post("/api/admin/work-plans")
      .send({
        title: "Warned",
        steps: [{ stepCount: 1, title: "Step 1", alpha: 1, beta: 2 }],
        visibility: "system",
      });

    expect(res.body.warnings).toEqual([
      "step 1: ignored unrecognized fields 'alpha', 'beta'",
    ]);
  });

  it("reports ignored fields on admin update too", async () => {
    const res = await request(app)
      .put("/api/admin/work-plans/plan-warn")
      .send({ title: "Warned", steps: [{ stepCount: 1, title: "Step 1", nope: true }] });

    expect(res.status).toBe(200);
    expect(res.body.warnings).toEqual([
      "step 1: ignored unrecognized field 'nope'",
    ]);
  });

  it("reports ignored fields on user create too", async () => {
    const res = await request(app)
      .post("/api/user-work-plans")
      .send({ title: "Warned", steps: [{ stepCount: 1, title: "Step 1", nope: true }] });

    expect(res.status).toBe(201);
    expect(res.body.warnings).toEqual([
      "step 1: ignored unrecognized field 'nope'",
    ]);
  });

  it("leaves the response shape untouched when every field is recognized", async () => {
    const res = await request(app)
      .post("/api/admin/work-plans")
      .send({
        title: "Clean",
        steps: [{
          stepCount: 1,
          title: "Step 1",
          description: "d",
          userInstructions: "u",
          requiredFunctionCalls: ["a"],
          skillIds: ["s"],
          expectedAssetCount: 3,
        }],
        visibility: "system",
      });

    expect(res.status).toBe(201);
    expect("warnings" in res.body).toBe(false);
  });
});

describe("user PUT is consistent with every other write path", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    workPlanService.getWorkPlan.mockResolvedValue({
      planId: "plan-user",
      title: "Mine",
      steps: [],
      ownerId: "user-1",
      visibility: "private",
      isBuiltIn: false,
      createdAt: "2026-08-04T00:00:00Z",
      updatedAt: "2026-08-04T00:00:00Z",
    });
    workPlanService.updateWorkPlan.mockResolvedValue(undefined);
  });

  it("normalizes steps rather than storing the caller's object verbatim", async () => {
    const res = await request(app)
      .put("/api/user-work-plans/plan-user")
      .send({ steps: [{ title: "Step", expectedAssetCount: 4, mystery: 1 }] });

    expect(res.status).toBe(200);
    const arg = workPlanService.updateWorkPlan.mock.calls[0][0];
    expect(arg.steps[0]).toMatchObject({ stepCount: 1, title: "Step", expectedAssetCount: 4 });
    expect("mystery" in arg.steps[0]).toBe(false);
  });

  it("reports the discarded field instead of persisting it silently", async () => {
    const res = await request(app)
      .put("/api/user-work-plans/plan-user")
      .send({ steps: [{ title: "Step", mystery: 1 }] });

    expect(res.body.warnings).toEqual(["step 1: ignored unrecognized field 'mystery'"]);
  });
});

describe("a non-array steps payload is rejected, not crashed on", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Owned + private, so the user route's ownership check passes and we reach
    // the payload validation this describe is actually about.
    workPlanService.getWorkPlan.mockResolvedValue({
      planId: "p", title: "T", steps: [], ownerId: "user-1",
      visibility: "private", isBuiltIn: false,
      createdAt: "2026-08-04T00:00:00Z", updatedAt: "2026-08-04T00:00:00Z",
    });
    workPlanService.updateWorkPlan.mockResolvedValue(undefined);
  });

  it("returns 400 from the admin PUT instead of a 500 from inside .map", async () => {
    const res = await request(app).put("/api/admin/work-plans/p").send({ steps: "not an array" });

    expect(res.status).toBe(400);
    expect(workPlanService.updateWorkPlan).not.toHaveBeenCalled();
  });

  it("returns 400 from the user PUT too", async () => {
    const res = await request(app).put("/api/user-work-plans/p").send({ steps: { a: 1 } });

    expect(res.status).toBe(400);
    expect(workPlanService.updateWorkPlan).not.toHaveBeenCalled();
  });
});

describe("a plan deleted between read and write answers 404, not 500", () => {
  const stored = {
    planId: "p", title: "T", steps: [], ownerId: "user-1",
    visibility: "private", isBuiltIn: false,
    createdAt: "2026-08-04T00:00:00Z", updatedAt: "2026-08-04T00:00:00Z",
  };

  beforeEach(() => {
    jest.clearAllMocks();
    workPlanService.getWorkPlan.mockResolvedValue(stored);
    // updateWorkPlan's attribute_exists guard now rejects a vanished plan
    // instead of the old put silently resurrecting it.
    workPlanService.updateWorkPlan.mockRejectedValue(new Error("Work plan not found"));
  });

  it("on the admin PUT", async () => {
    const res = await request(app)
      .put("/api/admin/work-plans/p")
      .send({ title: "Renamed" });

    expect(res.status).toBe(404);
    expect(res.body.message).toBe("Work plan not found");
  });

  it("on the user PUT", async () => {
    const res = await request(app)
      .put("/api/user-work-plans/p")
      .send({ title: "Renamed" });

    expect(res.status).toBe(404);
  });

  it("still returns 500 for a genuine failure", async () => {
    workPlanService.updateWorkPlan.mockRejectedValue(new Error("ProvisionedThroughputExceeded"));

    const res = await request(app)
      .put("/api/admin/work-plans/p")
      .send({ title: "Renamed" });

    expect(res.status).toBe(500);
  });
});
