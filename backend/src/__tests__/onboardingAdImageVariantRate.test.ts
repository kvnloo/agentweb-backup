/**
 * Route-level tests for POST /api/onboarding/ad-image-variant/rate (WS1b).
 *
 * The IMAGE-side analogue of /ad-variant/rate. Stores ♥/✕ on the User
 * record under `adImageVariantsRated` so the next image generation can
 * steer away from rejected visual directions. Mirrors
 * onboardingAdVariantRate.test.ts.
 */

import request from "supertest";
import express from "express";

jest.mock("../services/db", () => ({
  userDb: {
    getUserById: jest.fn(),
    updateUser: jest.fn(),
  },
}));

jest.mock("../services/onboardingIcpService", () => ({
  ...jest.requireActual("../services/onboardingIcpService"),
  startIcpDiscoveryForUser: jest.fn(),
  extractIcpBrandContext: jest.fn(() => ({})),
}));
jest.mock("../services/onboardingCompetitorService", () => ({
  ...jest.requireActual("../services/onboardingCompetitorService"),
  startCompetitorStrategyForUser: jest.fn(),
}));
jest.mock("../services/onboardingCreativeDirService", () => ({
  ...jest.requireActual("../services/onboardingCreativeDirService"),
  startCreativeDirForUser: jest.fn(),
}));
jest.mock("../services/onboardingAdCopyService", () => ({
  ...jest.requireActual("../services/onboardingAdCopyService"),
  startAdCopyForUser: jest.fn(),
}));
jest.mock("../services/onboardingAdImageService", () => ({
  ...jest.requireActual("../services/onboardingAdImageService"),
  startAdImageGenerationForUser: jest.fn(),
}));
// Keep the prompt-signal write a no-op so the fire-and-forget call in the
// route doesn't reach DynamoDB during the test.
jest.mock("../services/promptSignalsService", () => ({
  logPromptSignal: jest.fn(),
}));

jest.mock("../middleware/auth", () => ({
  authenticateToken: (req: any, res: any, next: any) => {
    if (req.headers["x-no-auth"] === "1") {
      return res.status(401).json({ message: "User not authenticated" });
    }
    req.user = { userId: "user-1", email: "test@example.com", isAdmin: false };
    next();
  },
}));

import onboardingStepsRoutes from "../routes/onboardingSteps";
const { userDb } = require("../services/db");
const { logPromptSignal } = require("../services/promptSignalsService");

const app = express();
app.use(express.json());
app.use("/api/onboarding", onboardingStepsRoutes);

beforeEach(() => {
  jest.clearAllMocks();
  userDb.getUserById.mockResolvedValue({
    userId: "user-1",
    email: "u@example.com",
    adImageVariantsRated: [],
  });
  userDb.updateUser.mockResolvedValue({ userId: "user-1" });
});

describe("POST /api/onboarding/ad-image-variant/rate", () => {
  it("rejects unauthenticated requests with 401", async () => {
    const res = await request(app)
      .post("/api/onboarding/ad-image-variant/rate")
      .set("x-no-auth", "1")
      .send({ variantId: "v1", rating: "like" });
    expect(res.status).toBe(401);
  });

  it("returns 400 on missing / bad variantId", async () => {
    for (const body of [{ rating: "like" }, { variantId: "", rating: "like" }, { variantId: 5, rating: "like" }]) {
      const res = await request(app).post("/api/onboarding/ad-image-variant/rate").send(body);
      expect(res.status).toBe(400);
    }
  });

  it("returns 400 on invalid rating", async () => {
    for (const body of [{ variantId: "v1" }, { variantId: "v1", rating: "love" }, { variantId: "v1", rating: 1 }]) {
      const res = await request(app).post("/api/onboarding/ad-image-variant/rate").send(body);
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/rating/);
    }
  });

  it("returns 404 when user record is missing", async () => {
    userDb.getUserById.mockResolvedValueOnce(null);
    const res = await request(app)
      .post("/api/onboarding/ad-image-variant/rate")
      .send({ variantId: "v1", rating: "like" });
    expect(res.status).toBe(404);
  });

  it("happy path persists rating to adImageVariantsRated + returns summary + logs signal", async () => {
    userDb.getUserById
      .mockResolvedValueOnce({ userId: "user-1", adImageVariantsRated: [] })
      .mockResolvedValueOnce({
        userId: "user-1",
        adImageVariantsRated: [{ variantId: "v1", rating: "like", ratedAt: "2026-06-14T00:00:00Z" }],
        adImageResult: { variants: [{ id: "v1", promptVersion: "v2-brick5", archetype: "A" }] },
      });

    const res = await request(app)
      .post("/api/onboarding/ad-image-variant/rate")
      .send({ variantId: "v1", rating: "like" });

    expect(res.status).toBe(200);
    expect(res.body.summary).toEqual({ likes: 1, rejects: 0, total: 1 });

    const [, patch] = userDb.updateUser.mock.calls[0];
    expect(Array.isArray(patch.adImageVariantsRated)).toBe(true);
    expect(patch.adImageVariantsRated[0]).toMatchObject({ variantId: "v1", rating: "like" });

    expect(logPromptSignal).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-1", variantId: "v1", signal: "like", promptVersion: "v2-brick5", archetype: "A" }),
    );
  });

  it("maps reject rating to the skip signal", async () => {
    userDb.getUserById
      .mockResolvedValueOnce({ userId: "user-1", adImageVariantsRated: [] })
      .mockResolvedValueOnce({
        userId: "user-1",
        adImageVariantsRated: [{ variantId: "v1", rating: "reject", ratedAt: "2026-06-14T00:00:00Z" }],
        adImageResult: { variants: [{ id: "v1", promptVersion: "v2-brick5", archetype: "A" }] },
      });
    const res = await request(app)
      .post("/api/onboarding/ad-image-variant/rate")
      .send({ variantId: "v1", rating: "reject" });
    expect(res.status).toBe(200);
    expect(logPromptSignal).toHaveBeenCalledWith(expect.objectContaining({ signal: "skip" }));
  });

  it("returns 500 when DB throws", async () => {
    userDb.updateUser.mockRejectedValueOnce(new Error("dynamo down"));
    const res = await request(app)
      .post("/api/onboarding/ad-image-variant/rate")
      .send({ variantId: "v1", rating: "like" });
    expect(res.status).toBe(500);
  });
});
