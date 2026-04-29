import request from "supertest";
import express from "express";

jest.mock("../services/db", () => ({
  userDb: {
    getUserById: jest.fn(),
    updateUser: jest.fn(),
  },
}));

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

import brandBuildRoutes from "../routes/brandBuild";
const { userDb } = require("../services/db");

const app = express();
app.use(express.json());
app.use("/api/onboarding", brandBuildRoutes);

describe("POST /api/onboarding/brand-build/start", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("401s when the user is not authenticated", async () => {
    // Mocked middleware leaves req.user undefined when the header is present,
    // but authenticateToken wouldn't normally call next(). We still want a
    // defensive 401 if the handler somehow runs without a user.
    userDb.getUserById.mockResolvedValue({ userId: "user-1" });
    const res = await request(app)
      .post("/api/onboarding/brand-build/start")
      .set("x-no-auth", "1");
    expect(res.status).toBe(401);
  });

  it("writes a building patch and returns the new snapshot", async () => {
    userDb.updateUser.mockResolvedValue({ userId: "user-1" });
    // First call (idempotency check): user has no brandBuildStatus yet (fresh).
    // All subsequent calls (post-write snapshot read AND any reads inside the
    // fire-and-forget triggerBrandBuildForUser microtask): return the
    // post-buildStartPatch state. Use mockResolvedValueOnce for the first
    // value, mockResolvedValue as the fallback for everything after.
    userDb.getUserById
      .mockResolvedValueOnce({ userId: "user-1" })
      .mockResolvedValue({
        userId: "user-1",
        brandBuildStatus: "building",
        brandBuildStartedAt: "2026-04-24T12:00:00.000Z",
      });
    const res = await request(app).post("/api/onboarding/brand-build/start");
    expect(res.status).toBe(200);
    expect(userDb.updateUser).toHaveBeenCalledWith(
      "user-1",
      expect.objectContaining({ brandBuildStatus: "building" })
    );
    expect(res.body.status.brandBuildStatus).toBe("building");
    expect(res.body.status.inFlight).toBe(true);
  });

  it("is idempotent: skips re-trigger when status is already building", async () => {
    userDb.updateUser.mockResolvedValue({ userId: "user-1" });
    userDb.getUserById.mockResolvedValue({
      userId: "user-1",
      brandBuildStatus: "building",
      brandBuildStartedAt: "2026-04-24T12:00:00.000Z",
    });
    const res = await request(app).post("/api/onboarding/brand-build/start");
    expect(res.status).toBe(200);
    // No buildStartPatch write — only the empty-inputPatch check, which
    // skips updateUser entirely when no body fields are supplied.
    expect(userDb.updateUser).not.toHaveBeenCalled();
    expect(res.body.status.brandBuildStatus).toBe("building");
  });

  it("is idempotent: skips re-trigger when status is already ready", async () => {
    userDb.updateUser.mockResolvedValue({ userId: "user-1" });
    userDb.getUserById.mockResolvedValue({
      userId: "user-1",
      brandBuildStatus: "ready",
      brandBuildCompletedAt: "2026-04-24T12:00:30.000Z",
    });
    const res = await request(app).post("/api/onboarding/brand-build/start");
    expect(res.status).toBe(200);
    expect(userDb.updateUser).not.toHaveBeenCalled();
    expect(res.body.status.brandBuildStatus).toBe("ready");
  });

  it("idempotent path still persists supplied URL/name updates without re-firing", async () => {
    userDb.updateUser.mockResolvedValue({ userId: "user-1" });
    userDb.getUserById.mockResolvedValue({
      userId: "user-1",
      brandBuildStatus: "building",
    });
    const res = await request(app)
      .post("/api/onboarding/brand-build/start")
      .send({ companyUrl: "https://example.com", companyName: "Example Inc." });
    expect(res.status).toBe(200);
    // updateUser called WITHOUT brandBuildStatus — only the input fields.
    expect(userDb.updateUser).toHaveBeenCalledWith(
      "user-1",
      expect.objectContaining({
        productDomain: "https://example.com",
        companyName: "Example Inc.",
      })
    );
    const writeArg = userDb.updateUser.mock.calls[0][1];
    expect(writeArg).not.toHaveProperty("brandBuildStatus");
  });

  it("500s when the DB write throws", async () => {
    userDb.getUserById.mockResolvedValueOnce({ userId: "user-1" });
    userDb.updateUser.mockRejectedValue(new Error("dynamo down"));
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    const res = await request(app).post("/api/onboarding/brand-build/start");
    expect(res.status).toBe(500);
    expect(res.body.message).toMatch(/Failed to start/);
    spy.mockRestore();
  });
});

describe("GET /api/onboarding/brand-build/status", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns the persisted snapshot for the caller", async () => {
    userDb.getUserById.mockResolvedValue({
      userId: "user-1",
      brandBuildStatus: "ready",
      brandBuildStartedAt: "2026-04-24T11:59:00.000Z",
      brandBuildCompletedAt: "2026-04-24T11:59:30.000Z",
      brandBuildDurationMs: 30_000,
    });
    const res = await request(app).get("/api/onboarding/brand-build/status");
    expect(res.status).toBe(200);
    expect(res.body.status.brandBuildStatus).toBe("ready");
    expect(res.body.status.brandBuildDurationMs).toBe(30_000);
    expect(res.body.status.inFlight).toBe(false);
  });

  it("404s when the user record is missing", async () => {
    userDb.getUserById.mockResolvedValue(null);
    const res = await request(app).get("/api/onboarding/brand-build/status");
    expect(res.status).toBe(404);
  });

  it("returns an empty snapshot when the user has no brand-build fields yet", async () => {
    userDb.getUserById.mockResolvedValue({ userId: "user-1", email: "x@y.z" });
    const res = await request(app).get("/api/onboarding/brand-build/status");
    expect(res.status).toBe(200);
    expect(res.body.status.brandBuildStatus).toBeUndefined();
    expect(res.body.status.inFlight).toBe(false);
  });
});

describe("POST /api/onboarding/brand-build/fail", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("writes a failed patch with the supplied error message", async () => {
    userDb.getUserById
      .mockResolvedValueOnce({
        userId: "user-1",
        brandBuildStatus: "building",
        brandBuildStartedAt: "2026-04-24T12:00:00.000Z",
      })
      .mockResolvedValueOnce({
        userId: "user-1",
        brandBuildStatus: "failed",
        brandBuildError: "client timeout",
      });
    userDb.updateUser.mockResolvedValue({ userId: "user-1" });
    const res = await request(app)
      .post("/api/onboarding/brand-build/fail")
      .send({ error: "client timeout" });
    expect(res.status).toBe(200);
    expect(userDb.updateUser).toHaveBeenCalledWith(
      "user-1",
      expect.objectContaining({
        brandBuildStatus: "failed",
        brandBuildError: "client timeout",
      })
    );
    expect(res.body.status.brandBuildStatus).toBe("failed");
  });

  it("falls back to the default message when body.error is absent", async () => {
    userDb.getUserById.mockResolvedValue({
      userId: "user-1",
      brandBuildStatus: "building",
    });
    userDb.updateUser.mockResolvedValue({ userId: "user-1" });
    const res = await request(app)
      .post("/api/onboarding/brand-build/fail")
      .send({});
    expect(res.status).toBe(200);
    expect(userDb.updateUser).toHaveBeenCalledWith(
      "user-1",
      expect.objectContaining({ brandBuildError: "brand build timed out" })
    );
  });

  it("emits a metrics log line on failure", async () => {
    userDb.getUserById.mockResolvedValue({
      userId: "user-1",
      brandBuildStatus: "building",
      brandBuildStartedAt: "2026-04-24T11:59:00.000Z",
    });
    userDb.updateUser.mockResolvedValue({ userId: "user-1" });
    const spy = jest.spyOn(console, "log").mockImplementation(() => {});
    await request(app)
      .post("/api/onboarding/brand-build/fail")
      .send({ error: "gone" });
    const calls = spy.mock.calls.map((c) => String(c[0]));
    expect(
      calls.some((c) => c.includes("[metrics] brand_build_complete") && c.includes("status=failed"))
    ).toBe(true);
    spy.mockRestore();
  });
});
