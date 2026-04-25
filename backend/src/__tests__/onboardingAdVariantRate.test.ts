/**
 * Route-level tests for POST /api/onboarding/ad-variant/rate.
 *
 * Mocks `userDb` so we can assert what gets persisted, and stubs auth so
 * the headers `x-no-auth: 1` skip authentication for the 401 path.
 *
 * Test surface (aligns with the Phase 4 "Ads Tinder" task):
 *   - 401 when unauthenticated
 *   - 400 on missing / bad variantId
 *   - 400 on missing / bad rating
 *   - 404 when user record can't be fetched
 *   - 200 happy path persists patch + returns summary
 *   - 200 on re-rating same variantId flips the stored rating (de-dup)
 *   - 50-cap behaviour exercised through the route end-to-end
 *   - 500 when the DB throws
 */

import request from "supertest";
import express from "express";

jest.mock("../services/db", () => ({
  userDb: {
    getUserById: jest.fn(),
    updateUser: jest.fn(),
  },
}));

// Stub fire-and-forget orchestrators so unrelated routes in this router
// don't fail at import time.
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

jest.mock("../middleware/auth", () => ({
  authenticateToken: (req: any, res: any, next: any) => {
    if (req.headers["x-no-auth"] === "1") {
      // Simulate the auth middleware rejecting the request: respond
      // 401 directly so the route handler never executes.
      return res.status(401).json({ message: "User not authenticated" });
    }
    req.user = {
      userId: "user-1",
      email: "test@example.com",
      isAdmin: false,
    };
    next();
  },
}));

import onboardingStepsRoutes from "../routes/onboardingSteps";
const { userDb } = require("../services/db");

const app = express();
app.use(express.json());
app.use("/api/onboarding", onboardingStepsRoutes);

beforeEach(() => {
  jest.clearAllMocks();
  userDb.getUserById.mockResolvedValue({
    userId: "user-1",
    email: "u@example.com",
    adVariantsRated: [],
  });
  userDb.updateUser.mockResolvedValue({ userId: "user-1" });
});

describe("POST /api/onboarding/ad-variant/rate", () => {
  it("rejects unauthenticated requests with 401", async () => {
    const res = await request(app)
      .post("/api/onboarding/ad-variant/rate")
      .set("x-no-auth", "1")
      .send({ variantId: "v1", rating: "like" });
    expect(res.status).toBe(401);
  });

  it("returns 400 when variantId is missing", async () => {
    const res = await request(app)
      .post("/api/onboarding/ad-variant/rate")
      .send({ rating: "like" });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/variantId/);
  });

  it("returns 400 when variantId is empty / wrong type", async () => {
    const cases = [{ variantId: "", rating: "like" }, { variantId: 5, rating: "like" }];
    for (const body of cases) {
      const res = await request(app)
        .post("/api/onboarding/ad-variant/rate")
        .send(body);
      expect(res.status).toBe(400);
    }
  });

  it("returns 400 when rating is invalid", async () => {
    const cases = [
      { variantId: "v1" }, // missing
      { variantId: "v1", rating: "love" }, // bad value
      { variantId: "v1", rating: 1 },
    ];
    for (const body of cases) {
      const res = await request(app)
        .post("/api/onboarding/ad-variant/rate")
        .send(body);
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/rating/);
    }
  });

  it("returns 404 when user record is missing", async () => {
    userDb.getUserById.mockResolvedValueOnce(null);
    const res = await request(app)
      .post("/api/onboarding/ad-variant/rate")
      .send({ variantId: "v1", rating: "like" });
    expect(res.status).toBe(404);
  });

  it("happy path persists rating + returns summary", async () => {
    userDb.getUserById
      .mockResolvedValueOnce({
        userId: "user-1",
        email: "u@example.com",
        adVariantsRated: [],
      })
      .mockResolvedValueOnce({
        userId: "user-1",
        email: "u@example.com",
        adVariantsRated: [
          {
            variantId: "v1",
            rating: "like",
            ratedAt: "2026-04-24T00:00:00Z",
          },
        ],
      });

    const res = await request(app)
      .post("/api/onboarding/ad-variant/rate")
      .send({ variantId: "v1", rating: "like" });

    expect(res.status).toBe(200);
    expect(res.body.summary).toEqual({ likes: 1, rejects: 0, total: 1 });

    expect(userDb.updateUser).toHaveBeenCalledTimes(1);
    const [, patch] = userDb.updateUser.mock.calls[0];
    expect(Array.isArray(patch.adVariantsRated)).toBe(true);
    expect(patch.adVariantsRated[0].variantId).toBe("v1");
    expect(patch.adVariantsRated[0].rating).toBe("like");
    expect(typeof patch.adVariantsRated[0].ratedAt).toBe("string");
  });

  it("re-rating the same variant flips the recorded rating", async () => {
    userDb.getUserById
      .mockResolvedValueOnce({
        userId: "user-1",
        email: "u@example.com",
        adVariantsRated: [
          {
            variantId: "v1",
            rating: "like",
            ratedAt: "2026-04-24T00:00:00Z",
          },
        ],
      })
      .mockResolvedValueOnce({
        userId: "user-1",
        email: "u@example.com",
        adVariantsRated: [
          {
            variantId: "v1",
            rating: "reject",
            ratedAt: "2026-04-24T00:01:00Z",
          },
        ],
      });

    const res = await request(app)
      .post("/api/onboarding/ad-variant/rate")
      .send({ variantId: "v1", rating: "reject" });

    expect(res.status).toBe(200);
    expect(res.body.summary).toEqual({ likes: 0, rejects: 1, total: 1 });
    const [, patch] = userDb.updateUser.mock.calls[0];
    expect(patch.adVariantsRated.length).toBe(1);
    expect(patch.adVariantsRated[0].rating).toBe("reject");
  });

  it("enforces the 50-entry cap end-to-end", async () => {
    const existing = Array.from({ length: 50 }).map((_, i) => ({
      variantId: `prev-${i}`,
      rating: "like" as const,
      ratedAt: new Date(2026, 3, 24, 0, 0, i).toISOString(),
    }));
    userDb.getUserById
      .mockResolvedValueOnce({
        userId: "user-1",
        email: "u@example.com",
        adVariantsRated: existing,
      })
      .mockResolvedValueOnce({
        userId: "user-1",
        email: "u@example.com",
        adVariantsRated: existing,
      });

    const res = await request(app)
      .post("/api/onboarding/ad-variant/rate")
      .send({ variantId: "fresh-1", rating: "like" });

    expect(res.status).toBe(200);
    const [, patch] = userDb.updateUser.mock.calls[0];
    expect(patch.adVariantsRated.length).toBe(50);
    // Oldest dropped, newest present
    expect(patch.adVariantsRated.find((e: any) => e.variantId === "prev-0")).toBeUndefined();
    expect(
      patch.adVariantsRated.find((e: any) => e.variantId === "fresh-1")
    ).toBeDefined();
  });

  it("returns 500 when DB throws", async () => {
    userDb.updateUser.mockRejectedValueOnce(new Error("dynamo down"));
    const res = await request(app)
      .post("/api/onboarding/ad-variant/rate")
      .send({ variantId: "v1", rating: "like" });
    expect(res.status).toBe(500);
  });
});
