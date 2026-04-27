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

import adGenRoutes from "../routes/adGen";
const { userDb } = require("../services/db");

const app = express();
app.use(express.json());
app.use("/api/onboarding", adGenRoutes);

const goodVariants = [
  { id: "v1", headline: "Hit your Q4 number", primaryText: "Stop guessing.", cta: "Learn more" },
  { id: "v2", headline: "Pipeline for founders", primaryText: "Built for you.", cta: "Sign up" },
  { id: "v3", headline: "10 leads a week", primaryText: "No ops needed.", cta: "Get started" },
];

describe("POST /api/onboarding/ad-gen/start", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("401s when the user is not authenticated", async () => {
    const res = await request(app)
      .post("/api/onboarding/ad-gen/start")
      .set("x-no-auth", "1");
    expect(res.status).toBe(401);
  });

  it("writes a generating patch and returns the new snapshot", async () => {
    userDb.updateUser.mockResolvedValue({ userId: "user-1" });
    userDb.getUserById.mockResolvedValue({
      userId: "user-1",
      adGenStatus: "generating",
      adGenStartedAt: "2026-04-24T12:00:00.000Z",
    });
    const res = await request(app).post("/api/onboarding/ad-gen/start");
    expect(res.status).toBe(200);
    expect(userDb.updateUser).toHaveBeenCalledWith(
      "user-1",
      expect.objectContaining({ adGenStatus: "generating" })
    );
    expect(res.body.status.adGenStatus).toBe("generating");
    expect(res.body.status.inFlight).toBe(true);
  });

  it("500s when the DB write throws", async () => {
    userDb.updateUser.mockRejectedValue(new Error("dynamo down"));
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    const res = await request(app).post("/api/onboarding/ad-gen/start");
    expect(res.status).toBe(500);
    expect(res.body.message).toMatch(/Failed to start/);
    spy.mockRestore();
  });
});

describe("POST /api/onboarding/ad-gen/complete", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("writes a ready patch with the supplied variants", async () => {
    userDb.getUserById
      .mockResolvedValueOnce({
        userId: "user-1",
        adGenStatus: "generating",
        adGenStartedAt: "2026-04-24T11:59:30.000Z",
      })
      .mockResolvedValueOnce({
        userId: "user-1",
        adGenStatus: "ready",
        adGenVariants: goodVariants,
      });
    userDb.updateUser.mockResolvedValue({ userId: "user-1" });
    const res = await request(app)
      .post("/api/onboarding/ad-gen/complete")
      .send({ variants: goodVariants });
    expect(res.status).toBe(200);
    expect(userDb.updateUser).toHaveBeenCalledWith(
      "user-1",
      expect.objectContaining({
        adGenStatus: "ready",
        adGenVariants: expect.any(Array),
      })
    );
    expect(res.body.status.adGenStatus).toBe("ready");
  });

  it("409s when user is not in generating state (cannot complete an idle build)", async () => {
    userDb.getUserById.mockResolvedValue({
      userId: "user-1",
      adGenStatus: "ready",
    });
    const res = await request(app)
      .post("/api/onboarding/ad-gen/complete")
      .send({ variants: goodVariants });
    expect(res.status).toBe(409);
    expect(userDb.updateUser).not.toHaveBeenCalled();
  });

  it("400s when variants are missing or malformed", async () => {
    userDb.getUserById.mockResolvedValue({
      userId: "user-1",
      adGenStatus: "generating",
    });
    const res = await request(app)
      .post("/api/onboarding/ad-gen/complete")
      .send({ variants: [] });
    expect(res.status).toBe(400);
  });

  it("emits a metrics log line on successful completion", async () => {
    userDb.getUserById.mockResolvedValue({
      userId: "user-1",
      adGenStatus: "generating",
      adGenStartedAt: "2026-04-24T11:59:00.000Z",
    });
    userDb.updateUser.mockResolvedValue({ userId: "user-1" });
    const spy = jest.spyOn(console, "log").mockImplementation(() => {});
    await request(app)
      .post("/api/onboarding/ad-gen/complete")
      .send({ variants: goodVariants });
    const calls = spy.mock.calls.map((c) => String(c[0]));
    expect(
      calls.some(
        (c) => c.includes("[metrics] ad_gen_complete") && c.includes("status=ready")
      )
    ).toBe(true);
    spy.mockRestore();
  });
});

describe("GET /api/onboarding/ad-gen/status", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns the persisted snapshot for the caller", async () => {
    userDb.getUserById.mockResolvedValue({
      userId: "user-1",
      adGenStatus: "ready",
      adGenStartedAt: "2026-04-24T11:59:00.000Z",
      adGenCompletedAt: "2026-04-24T11:59:45.000Z",
      adGenDurationMs: 45_000,
      adGenVariants: goodVariants,
    });
    const res = await request(app).get("/api/onboarding/ad-gen/status");
    expect(res.status).toBe(200);
    expect(res.body.status.adGenStatus).toBe("ready");
    expect(res.body.status.adGenDurationMs).toBe(45_000);
    expect(res.body.status.inFlight).toBe(false);
    expect(res.body.status.adGenVariants).toHaveLength(3);
  });

  it("404s when the user record is missing", async () => {
    userDb.getUserById.mockResolvedValue(null);
    const res = await request(app).get("/api/onboarding/ad-gen/status");
    expect(res.status).toBe(404);
  });

  it("returns an empty snapshot when the user has no ad-gen fields yet", async () => {
    userDb.getUserById.mockResolvedValue({ userId: "user-1", email: "x@y.z" });
    const res = await request(app).get("/api/onboarding/ad-gen/status");
    expect(res.status).toBe(200);
    expect(res.body.status.adGenStatus).toBeUndefined();
    expect(res.body.status.inFlight).toBe(false);
  });
});

describe("POST /api/onboarding/ad-gen/fail", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("writes a failed patch with the supplied error message", async () => {
    userDb.getUserById
      .mockResolvedValueOnce({
        userId: "user-1",
        adGenStatus: "generating",
        adGenStartedAt: "2026-04-24T12:00:00.000Z",
      })
      .mockResolvedValueOnce({
        userId: "user-1",
        adGenStatus: "failed",
        adGenError: "client timeout",
      });
    userDb.updateUser.mockResolvedValue({ userId: "user-1" });
    const res = await request(app)
      .post("/api/onboarding/ad-gen/fail")
      .send({ error: "client timeout" });
    expect(res.status).toBe(200);
    expect(userDb.updateUser).toHaveBeenCalledWith(
      "user-1",
      expect.objectContaining({
        adGenStatus: "failed",
        adGenError: "client timeout",
      })
    );
    expect(res.body.status.adGenStatus).toBe("failed");
  });

  it("falls back to a default message when body.error is absent", async () => {
    userDb.getUserById.mockResolvedValue({
      userId: "user-1",
      adGenStatus: "generating",
    });
    userDb.updateUser.mockResolvedValue({ userId: "user-1" });
    const res = await request(app)
      .post("/api/onboarding/ad-gen/fail")
      .send({});
    expect(res.status).toBe(200);
    expect(userDb.updateUser).toHaveBeenCalledWith(
      "user-1",
      expect.objectContaining({ adGenError: "ad generation timed out" })
    );
  });

  it("emits a metrics log line on failure", async () => {
    userDb.getUserById.mockResolvedValue({
      userId: "user-1",
      adGenStatus: "generating",
      adGenStartedAt: "2026-04-24T11:59:00.000Z",
    });
    userDb.updateUser.mockResolvedValue({ userId: "user-1" });
    const spy = jest.spyOn(console, "log").mockImplementation(() => {});
    await request(app)
      .post("/api/onboarding/ad-gen/fail")
      .send({ error: "gone" });
    const calls = spy.mock.calls.map((c) => String(c[0]));
    expect(
      calls.some(
        (c) => c.includes("[metrics] ad_gen_complete") && c.includes("status=failed")
      )
    ).toBe(true);
    spy.mockRestore();
  });
});
