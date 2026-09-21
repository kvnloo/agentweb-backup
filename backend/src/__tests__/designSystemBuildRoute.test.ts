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

jest.mock("../services/onboardingDesignSystemService", () => ({
  triggerDesignSystemBuildForUser: jest.fn().mockResolvedValue(undefined),
}));

import designSystemBuildRoutes from "../routes/designSystemBuild";
const { userDb } = require("../services/db");
const { triggerDesignSystemBuildForUser } = require("../services/onboardingDesignSystemService");

const app = express();
app.use(express.json());
app.use("/api/onboarding", designSystemBuildRoutes);

describe("POST /api/onboarding/design-system/start", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("401s when the user is not authenticated", async () => {
    const res = await request(app)
      .post("/api/onboarding/design-system/start")
      .set("x-no-auth", "1");
    expect(res.status).toBe(401);
  });

  it("claims the transition with a conditional write and fires the trigger", async () => {
    userDb.getUserById
      .mockResolvedValueOnce({ userId: "user-1" }) // idempotency check
      .mockResolvedValue({
        userId: "user-1",
        designSystem: { status: "running", startedAt: "2026-04-24T12:00:00.000Z" },
      });
    userDb.updateUser.mockResolvedValue({ userId: "user-1" });

    const res = await request(app).post("/api/onboarding/design-system/start");

    expect(res.status).toBe(200);
    expect(userDb.updateUser).toHaveBeenCalledWith(
      "user-1",
      expect.objectContaining({ designSystem: expect.objectContaining({ status: "running" }) }),
      expect.objectContaining({
        condition: expect.objectContaining({
          expression: expect.stringContaining("attribute_not_exists"),
        }),
      })
    );
    expect(res.body.status.status).toBe("running");
    expect(triggerDesignSystemBuildForUser).toHaveBeenCalledWith("user-1");
  });

  it("is idempotent: skips the write and the trigger when already running", async () => {
    userDb.getUserById.mockResolvedValue({
      userId: "user-1",
      designSystem: { status: "running", startedAt: "2026-04-24T12:00:00.000Z" },
    });

    const res = await request(app).post("/api/onboarding/design-system/start");

    expect(res.status).toBe(200);
    expect(userDb.updateUser).not.toHaveBeenCalled();
    expect(triggerDesignSystemBuildForUser).not.toHaveBeenCalled();
    expect(res.body.status.status).toBe("running");
  });

  it("loses a concurrent race gracefully: a ConditionalCheckFailedException does not crash the request or double-fire the trigger (ENG-328)", async () => {
    // Both requests read `idle` before either writes — the fast-path
    // in-memory check alone can't catch this, only the DynamoDB condition can.
    userDb.getUserById
      .mockResolvedValueOnce({ userId: "user-1" }) // idempotency check sees idle
      .mockResolvedValueOnce({
        // re-read after losing the race — the winner already flipped it
        userId: "user-1",
        designSystem: { status: "running", startedAt: "2026-04-24T12:00:00.000Z" },
      });
    userDb.updateUser.mockRejectedValue(
      Object.assign(new Error("The conditional request failed"), {
        code: "ConditionalCheckFailedException",
      })
    );

    const res = await request(app).post("/api/onboarding/design-system/start");

    expect(res.status).toBe(200);
    expect(res.body.status.status).toBe("running");
    expect(triggerDesignSystemBuildForUser).not.toHaveBeenCalled();
  });

  it("surfaces a genuine DynamoDB failure as a 500 instead of swallowing it", async () => {
    userDb.getUserById.mockResolvedValueOnce({ userId: "user-1" });
    userDb.updateUser.mockRejectedValue(
      Object.assign(new Error("boom"), { code: "ProvisionedThroughputExceededException" })
    );

    const res = await request(app).post("/api/onboarding/design-system/start");

    expect(res.status).toBe(500);
    expect(triggerDesignSystemBuildForUser).not.toHaveBeenCalled();
  });
});
