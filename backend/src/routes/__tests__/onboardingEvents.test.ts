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

// Mock the capture hooks — our test asserts that a stage transition fires
// onOnboardingStageChanged. We intentionally don't mock the other hooks here
// since the route doesn't call them.
const mockOnOnboardingStageChanged = jest.fn();
jest.mock("../../services/contactCaptureHooks", () => ({
  onOnboardingStageChanged: (...args: any[]) => mockOnOnboardingStageChanged(...args),
}));

// Onboarding v2 dual-write mirror — mocked so existing User-path tests don't
// reach DynamoDB / the crm layer. Route treats it as fire-and-forget.
const mockMirrorOnboardingEventToLead = jest.fn();
jest.mock("../../services/onboardingLeadSync", () => ({
  mirrorOnboardingEventToLead: (...args: any[]) => mockMirrorOnboardingEventToLead(...args),
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
  // Default no-op for the capture hook — the route calls .catch() on the
  // returned promise, so the mock must return a thenable.
  mockOnOnboardingStageChanged.mockResolvedValue(null);
  mockMirrorOnboardingEventToLead.mockResolvedValue({ mirrored: true, reason: "updated" });
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

  // ─── Onboarding v2 analytics: new events + dual-write mirror ─────────────

  it("accepts the Phase 2 event 'channel_selected'", async () => {
    const app = makeApp();
    const res = await request(app)
      .post("/api/onboarding/events")
      .send({ event: "channel_selected", data: { channel: "meta" } });
    expect(res.status).toBe(200);
    expect(res.body.recorded.event).toBe("channel_selected");
  });

  it("accepts the Phase 2 event 'deviation' and records the freeform message", async () => {
    const app = makeApp();
    const res = await request(app)
      .post("/api/onboarding/events")
      .send({
        event: "deviation",
        data: { message: "what about ecommerce?", step: "goal" },
      });
    expect(res.status).toBe(200);
    expect(res.body.recorded.data).toMatchObject({
      message: "what about ecommerce?",
      step: "goal",
    });
  });

  it("accepts the Phase 2 event 'icp_selected'", async () => {
    const app = makeApp();
    const res = await request(app)
      .post("/api/onboarding/events")
      .send({
        event: "icp_selected",
        data: { id: "icp_1", name: "Growth-stage SaaS PMs" },
      });
    expect(res.status).toBe(200);
  });

  it("dual-writes every onboarding event to the matching Lead (fire-and-forget)", async () => {
    const app = makeApp();
    const res = await request(app)
      .post("/api/onboarding/events")
      .send({ event: "goal_selected", data: { goal: "paid_ads" } });
    expect(res.status).toBe(200);
    expect(mockMirrorOnboardingEventToLead).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-123",
        email: "user@example.com",
        onboardingStage: "goal_selected",
        allEvents: expect.arrayContaining([
          expect.objectContaining({ event: "goal_selected" }),
        ]),
        event: expect.objectContaining({ event: "goal_selected" }),
      }),
    );
  });

  it("does NOT fail the request when the Lead mirror rejects (fire-and-forget)", async () => {
    mockMirrorOnboardingEventToLead.mockRejectedValueOnce(new Error("boom"));
    const app = makeApp();
    const res = await request(app)
      .post("/api/onboarding/events")
      .send({ event: "goal_selected" });
    expect(res.status).toBe(200);
    expect(res.body.onboardingStage).toBe("goal_selected");
  });

  it("skips the mirror when the user has no email (defensive guard)", async () => {
    mockGetUserById.mockResolvedValueOnce({
      userId: "user-123",
      email: "",
      onboardingEvents: [],
    });
    const app = makeApp();
    const res = await request(app)
      .post("/api/onboarding/events")
      .send({ event: "goal_selected" });
    expect(res.status).toBe(200);
    expect(mockMirrorOnboardingEventToLead).not.toHaveBeenCalled();
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

  // ─── Phase 2: segmentation query params ───────────────────────────────
  describe("Phase 2 segmentation (lastActivityBefore, limit, onboardingGoal)", () => {
    it("filters users whose lastActiveAt is before the given ISO date", async () => {
      mockGetAllUsers.mockResolvedValueOnce([
        {
          userId: "fresh",
          email: "fresh@example.com",
          onboardingStage: "goal_selected",
          lastActiveAt: "2026-04-17T10:00:00Z",
        },
        {
          userId: "stale",
          email: "stale@example.com",
          onboardingStage: "goal_selected",
          lastActiveAt: "2026-04-10T10:00:00Z",
        },
        {
          userId: "never",
          email: "never@example.com",
          onboardingStage: "goal_selected",
          // no lastActiveAt — NOT returned because we can't prove it's before the cutoff
        },
      ]);
      const app = makeApp();
      const res = await request(app).get(
        "/api/onboarding/users?stage=goal_selected&lastActivityBefore=2026-04-15T00:00:00Z",
      );
      expect(res.status).toBe(200);
      expect(res.body.count).toBe(1);
      expect(res.body.users[0].userId).toBe("stale");
    });

    it("rejects an invalid lastActivityBefore date", async () => {
      const app = makeApp();
      const res = await request(app).get(
        "/api/onboarding/users?stage=goal_selected&lastActivityBefore=not-a-date",
      );
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/lastActivityBefore/);
    });

    it("applies limit to cap the returned list size", async () => {
      mockGetAllUsers.mockResolvedValueOnce(
        Array.from({ length: 12 }, (_, i) => ({
          userId: `u${i}`,
          email: `u${i}@example.com`,
          onboardingStage: "goal_selected",
        })),
      );
      const app = makeApp();
      const res = await request(app).get(
        "/api/onboarding/users?stage=goal_selected&limit=5",
      );
      expect(res.status).toBe(200);
      expect(res.body.count).toBe(5);
      expect(res.body.users).toHaveLength(5);
    });

    it("rejects a non-numeric limit", async () => {
      const app = makeApp();
      const res = await request(app).get(
        "/api/onboarding/users?stage=goal_selected&limit=abc",
      );
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/limit/);
    });

    it("rejects a limit that is <= 0", async () => {
      const app = makeApp();
      const res = await request(app).get(
        "/api/onboarding/users?stage=goal_selected&limit=0",
      );
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/limit/);
    });

    it("caps limit at 500 to prevent abuse", async () => {
      mockGetAllUsers.mockResolvedValueOnce(
        Array.from({ length: 600 }, (_, i) => ({
          userId: `u${i}`,
          email: `u${i}@example.com`,
          onboardingStage: "goal_selected",
        })),
      );
      const app = makeApp();
      const res = await request(app).get(
        "/api/onboarding/users?stage=goal_selected&limit=9999",
      );
      expect(res.status).toBe(200);
      // Server-side cap at 500
      expect(res.body.count).toBe(500);
    });

    it("exposes onboardingGoal derived from goal_selected event", async () => {
      mockGetAllUsers.mockResolvedValueOnce([
        {
          userId: "u1",
          email: "a@example.com",
          onboardingStage: "goal_selected",
          onboardingEvents: [
            {
              event: "goal_selected",
              ts: "2026-04-18T10:00:00Z",
              data: { goal: "paid_ads" },
            },
          ],
        },
        {
          userId: "u2",
          email: "b@example.com",
          onboardingStage: "goal_selected",
          onboardingEvents: [
            // goal_selected without data.goal
            { event: "goal_selected", ts: "2026-04-18T10:00:00Z" },
          ],
        },
      ]);
      const app = makeApp();
      const res = await request(app).get(
        "/api/onboarding/users?stage=goal_selected",
      );
      expect(res.status).toBe(200);
      const byId = Object.fromEntries(
        res.body.users.map((u: any) => [u.userId, u]),
      );
      expect(byId.u1.onboardingGoal).toBe("paid_ads");
      expect(byId.u2.onboardingGoal).toBeNull();
    });

    it("includes companyName in slim output", async () => {
      mockGetAllUsers.mockResolvedValueOnce([
        {
          userId: "u1",
          email: "a@example.com",
          companyName: "Acme",
          onboardingStage: "goal_selected",
        },
      ]);
      const app = makeApp();
      const res = await request(app).get(
        "/api/onboarding/users?stage=goal_selected",
      );
      expect(res.status).toBe(200);
      expect(res.body.users[0].companyName).toBe("Acme");
    });

    it("uses latest goal_selected event when there are multiple", async () => {
      mockGetAllUsers.mockResolvedValueOnce([
        {
          userId: "u1",
          email: "a@example.com",
          onboardingStage: "goal_selected",
          onboardingEvents: [
            {
              event: "goal_selected",
              ts: "2026-04-18T10:00:00Z",
              data: { goal: "seo" },
            },
            {
              event: "goal_selected",
              ts: "2026-04-18T11:00:00Z",
              data: { goal: "paid_ads" },
            },
          ],
        },
      ]);
      const app = makeApp();
      const res = await request(app).get(
        "/api/onboarding/users?stage=goal_selected",
      );
      expect(res.status).toBe(200);
      expect(res.body.users[0].onboardingGoal).toBe("paid_ads");
    });
  });
});

describe("POST /api/onboarding/events — contact activity timeline capture", () => {
  beforeEach(() => {
    // Default: the user starts with no prior stage so every POST is a transition.
    mockGetUserById.mockResolvedValue({
      userId: "user-123",
      email: "user@example.com",
      onboardingEvents: [],
      onboardingStage: null,
    });
    mockUpdateUser.mockImplementation(async (_id: string, updates: any) => ({
      userId: "user-123",
      email: "user@example.com",
      ...updates,
    }));
    mockOnOnboardingStageChanged.mockResolvedValue(null);
  });

  it("fires onOnboardingStageChanged when the derived stage changes", async () => {
    const app = makeApp();
    const res = await request(app)
      .post("/api/onboarding/events")
      .send({ event: "goal_selected" });

    expect(res.status).toBe(200);
    expect(mockOnOnboardingStageChanged).toHaveBeenCalledTimes(1);
    const call = mockOnOnboardingStageChanged.mock.calls[0][0];
    expect(call.userId).toBe("user-123");
    expect(call.email).toBe("user@example.com");
    expect(call.fromStage).toBeNull();
    expect(call.toStage).toBe(res.body.onboardingStage);
    expect(call.triggeredByEvent).toBe("goal_selected");
  });

  it("does NOT fire when the stage does not actually change", async () => {
    // Seed the user's existing stage so the derived stage equals it.
    mockGetUserById.mockResolvedValueOnce({
      userId: "user-123",
      email: "user@example.com",
      onboardingEvents: [
        { event: "goal_selected", ts: "2026-04-01T00:00:00Z" },
      ],
      onboardingStage: "goal_selected",
    });

    const app = makeApp();
    await request(app).post("/api/onboarding/events").send({ event: "goal_selected" });
    expect(mockOnOnboardingStageChanged).not.toHaveBeenCalled();
  });

  it("does not break the handler if capture hook rejects", async () => {
    mockOnOnboardingStageChanged.mockRejectedValueOnce(new Error("downstream boom"));
    const app = makeApp();
    const res = await request(app)
      .post("/api/onboarding/events")
      .send({ event: "goal_selected" });
    // The route returned 200 successfully; the hook failure was fire-and-forget.
    expect(res.status).toBe(200);
  });
});
