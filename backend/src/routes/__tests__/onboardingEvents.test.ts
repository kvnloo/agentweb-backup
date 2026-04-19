import express from "express";
import request from "supertest";

// Hoisted mocks — must be before router import
jest.mock("../../middleware/auth", () => ({
  authenticateToken: jest.fn((req: any, _res: any, next: any) => {
    req.user = { userId: "user-123" };
    next();
  }),
}));

// Admin middleware — test-controllable
let _isAdminPasses = true;
jest.mock("../../middleware/admin", () => ({
  isAdmin: jest.fn((req: any, res: any, next: any) => {
    if (_isAdminPasses) return next();
    return res.status(403).json({ message: "Forbidden" });
  }),
}));

const mockUpdateUser = jest.fn();
const mockGetUserById = jest.fn();
const mockGetAllUsers = jest.fn();
jest.mock("../../services/db", () => ({
  userDb: {
    updateUser: (...args: any[]) => mockUpdateUser(...args),
    getUserById: (...args: any[]) => mockGetUserById(...args),
    getAllUsers: (...args: any[]) => mockGetAllUsers(...args),
  },
  taskDb: {},
  subscriberDb: {},
  orgDb: { getOrgById: jest.fn() },
}));

import onboardingEventsRouter from "../onboardingEvents";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/onboarding", onboardingEventsRouter);
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  _isAdminPasses = true;
  mockGetUserById.mockResolvedValue({
    userId: "user-123",
    email: "user@example.com",
    onboardingEvents: [],
  });
  mockUpdateUser.mockImplementation(async (_id: string, updates: any) => ({
    userId: "user-123",
    email: "user@example.com",
    ...updates,
  }));
});

describe("POST /api/onboarding/events", () => {
  it("records a valid event and derives onboardingStage", async () => {
    const app = makeApp();
    const res = await request(app)
      .post("/api/onboarding/events")
      .send({ event: "goal_selected", data: { goal: "paid_ads" } });

    expect(res.status).toBe(200);
    expect(res.body.onboardingStage).toBe("goal_selected");
    expect(res.body.eventCount).toBe(1);
    expect(res.body.recorded).toMatchObject({
      event: "goal_selected",
      data: { goal: "paid_ads" },
    });
    expect(res.body.recorded.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(mockUpdateUser).toHaveBeenCalledWith(
      "user-123",
      expect.objectContaining({
        onboardingStage: "goal_selected",
        onboardingEvents: expect.arrayContaining([
          expect.objectContaining({ event: "goal_selected" }),
        ]),
      }),
    );
  });

  it("appends to an existing event log", async () => {
    mockGetUserById.mockResolvedValueOnce({
      userId: "user-123",
      email: "user@example.com",
      onboardingEvents: [
        { event: "goal_selected", ts: "2026-04-18T10:00:00Z" },
      ],
    });
    const app = makeApp();
    const res = await request(app)
      .post("/api/onboarding/events")
      .send({ event: "brand_submitted", data: { companyName: "Acme" } });

    expect(res.status).toBe(200);
    expect(res.body.eventCount).toBe(2);
    expect(res.body.onboardingStage).toBe("brand_submitted");
    const updateCall = mockUpdateUser.mock.calls[0][1];
    expect(updateCall.onboardingEvents.map((e: any) => e.event)).toEqual([
      "goal_selected",
      "brand_submitted",
    ]);
  });

  it("rejects an unknown event name", async () => {
    const app = makeApp();
    const res = await request(app)
      .post("/api/onboarding/events")
      .send({ event: "totally_made_up" });

    expect(res.status).toBe(400);
    expect(res.body.message).toContain("totally_made_up");
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });

  it("rejects a missing event", async () => {
    const app = makeApp();
    const res = await request(app)
      .post("/api/onboarding/events")
      .send({});

    expect(res.status).toBe(400);
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });

  it("rejects a non-object `data` payload", async () => {
    const app = makeApp();
    const res = await request(app)
      .post("/api/onboarding/events")
      .send({ event: "goal_selected", data: "not-an-object" });

    expect(res.status).toBe(400);
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });

  it("rejects an array `data` payload", async () => {
    const app = makeApp();
    const res = await request(app)
      .post("/api/onboarding/events")
      .send({ event: "goal_selected", data: ["x"] });

    expect(res.status).toBe(400);
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });

  it("rejects a payload > 2048 bytes", async () => {
    const big = "x".repeat(3000);
    const app = makeApp();
    const res = await request(app)
      .post("/api/onboarding/events")
      .send({ event: "goal_selected", data: { big } });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/exceeds/);
  });

  it("caps the event log at the last 50 events (FIFO drop)", async () => {
    const existing = Array.from({ length: 50 }, (_, i) => ({
      event: "goal_selected",
      ts: `2026-04-01T00:00:${String(i).padStart(2, "0")}Z`,
    }));
    mockGetUserById.mockResolvedValueOnce({
      userId: "user-123",
      email: "user@example.com",
      onboardingEvents: existing,
    });
    const app = makeApp();
    const res = await request(app)
      .post("/api/onboarding/events")
      .send({ event: "onboarding_completed" });

    expect(res.status).toBe(200);
    expect(res.body.eventCount).toBe(50);
    const updateCall = mockUpdateUser.mock.calls[0][1];
    expect(updateCall.onboardingEvents).toHaveLength(50);
    // oldest event dropped, newest appended
    expect(updateCall.onboardingEvents[49].event).toBe("onboarding_completed");
    expect(updateCall.onboardingEvents[0].ts).toBe("2026-04-01T00:00:01Z");
  });

  it("returns 404 when the user is not found", async () => {
    mockGetUserById.mockResolvedValueOnce(null);
    const app = makeApp();
    const res = await request(app)
      .post("/api/onboarding/events")
      .send({ event: "goal_selected" });

    expect(res.status).toBe(404);
  });

  it("returns 500 on an unexpected error", async () => {
    mockGetUserById.mockRejectedValueOnce(new Error("boom"));
    const app = makeApp();
    const res = await request(app)
      .post("/api/onboarding/events")
      .send({ event: "goal_selected" });

    expect(res.status).toBe(500);
  });

  it("derives 'active' when onboarding_completed + recent lastActiveAt", async () => {
    mockGetUserById.mockResolvedValueOnce({
      userId: "user-123",
      email: "user@example.com",
      lastActiveAt: new Date().toISOString(),
      onboardingEvents: [],
    });
    const app = makeApp();
    const res = await request(app)
      .post("/api/onboarding/events")
      .send({ event: "onboarding_completed" });

    expect(res.status).toBe(200);
    expect(res.body.onboardingStage).toBe("active");
  });
});

describe("GET /api/onboarding/events/me", () => {
  it("returns the caller's events + derived stage", async () => {
    mockGetUserById.mockResolvedValueOnce({
      userId: "user-123",
      email: "user@example.com",
      onboardingEvents: [
        { event: "goal_selected", ts: "2026-04-18T10:00:00Z" },
        { event: "brand_submitted", ts: "2026-04-18T10:01:00Z" },
      ],
    });
    const app = makeApp();
    const res = await request(app).get("/api/onboarding/events/me");
    expect(res.status).toBe(200);
    expect(res.body.onboardingStage).toBe("brand_submitted");
    expect(res.body.onboardingEvents).toHaveLength(2);
  });

  it("defaults to empty log + signed_up_no_start for a fresh user", async () => {
    mockGetUserById.mockResolvedValueOnce({
      userId: "user-123",
      email: "user@example.com",
    });
    const app = makeApp();
    const res = await request(app).get("/api/onboarding/events/me");
    expect(res.status).toBe(200);
    expect(res.body.onboardingStage).toBe("signed_up_no_start");
    expect(res.body.onboardingEvents).toEqual([]);
  });

  it("returns 404 when user is missing", async () => {
    mockGetUserById.mockResolvedValueOnce(undefined);
    const app = makeApp();
    const res = await request(app).get("/api/onboarding/events/me");
    expect(res.status).toBe(404);
  });

  it("returns 500 on unexpected error", async () => {
    mockGetUserById.mockRejectedValueOnce(new Error("boom"));
    const app = makeApp();
    const res = await request(app).get("/api/onboarding/events/me");
    expect(res.status).toBe(500);
  });
});

describe("GET /api/onboarding/users (admin)", () => {
  it("returns users filtered by stage", async () => {
    mockGetAllUsers.mockResolvedValueOnce([
      {
        userId: "u1",
        email: "a@example.com",
        onboardingStage: "goal_selected",
        onboardingEvents: [{ event: "goal_selected", ts: "t" }],
      },
      {
        userId: "u2",
        email: "b@example.com",
        onboardingStage: "onboarding_completed",
      },
      {
        userId: "u3",
        email: "c@example.com",
        onboardingStage: "goal_selected",
      },
    ]);
    const app = makeApp();
    const res = await request(app).get(
      "/api/onboarding/users?stage=goal_selected",
    );
    expect(res.status).toBe(200);
    expect(res.body.stage).toBe("goal_selected");
    expect(res.body.count).toBe(2);
    expect(res.body.users.map((u: any) => u.userId).sort()).toEqual(["u1", "u3"]);
    expect(res.body.users[0].onboardingEventCount).toBeGreaterThanOrEqual(0);
  });

  it("returns all users with a stage set when no filter given", async () => {
    mockGetAllUsers.mockResolvedValueOnce([
      {
        userId: "u1",
        email: "a@example.com",
        onboardingStage: "goal_selected",
      },
      { userId: "u2", email: "b@example.com" }, // no stage
      {
        userId: "u3",
        email: "c@example.com",
        onboardingStage: "active",
      },
    ]);
    const app = makeApp();
    const res = await request(app).get("/api/onboarding/users");
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
  });

  it("excludes soft-deleted users", async () => {
    mockGetAllUsers.mockResolvedValueOnce([
      {
        userId: "deleted_u1",
        email: "old@example.com",
        onboardingStage: "goal_selected",
      },
      {
        userId: "u2",
        email: "b@example.com",
        onboardingStage: "goal_selected",
      },
    ]);
    const app = makeApp();
    const res = await request(app).get(
      "/api/onboarding/users?stage=goal_selected",
    );
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.users[0].userId).toBe("u2");
  });

  it("rejects an invalid stage query param", async () => {
    const app = makeApp();
    const res = await request(app).get(
      "/api/onboarding/users?stage=bogus_stage",
    );
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Invalid stage/);
  });

  it("blocks non-admin callers", async () => {
    _isAdminPasses = false;
    const app = makeApp();
    const res = await request(app).get("/api/onboarding/users");
    expect(res.status).toBe(403);
  });

  it("returns 500 on unexpected error", async () => {
    mockGetAllUsers.mockRejectedValueOnce(new Error("boom"));
    const app = makeApp();
    const res = await request(app).get("/api/onboarding/users");
    expect(res.status).toBe(500);
  });
});
