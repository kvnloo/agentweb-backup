/**
 * Route-level tests for the BrandReview-gate endpoints.
 *
 * These three endpoints power the per-card actions on the BrandReview gate
 * screen (between dataGathering and adReveal):
 *   - POST /api/onboarding/icp/edit-one        — edit one persona
 *   - POST /api/onboarding/icp/regenerate-one  — regenerate one persona
 *   - POST /api/onboarding/icp/delete-one      — remove one persona
 *   - POST /api/onboarding/value-prop          — persist user value prop
 *
 * Identity model: personas are identified by INDEX in the user's
 * `icpResult` array. The `icpId` body field is treated as a string and
 * mapped to the index `icp-{n}` (matching the FE convention that backfills
 * `id: 'icp-{idx}'` when the backend doesn't supply one). This avoids a
 * persona-id schema migration while still letting the FE refer to a
 * specific card stably across re-renders.
 */
import request from "supertest";
import express from "express";

jest.mock("../services/db", () => ({
  userDb: {
    getUserById: jest.fn(),
    updateUser: jest.fn(),
  },
}));

jest.mock("../services/onboardingIcpService", () => {
  const actual = jest.requireActual("../services/onboardingIcpService");
  return {
    ...actual,
    startIcpDiscoveryForUser: jest.fn(async (userId: string) => {
      const { userDb } = require("../services/db");
      const { icpStartPatch } = require("../services/icpStatusService");
      await userDb.updateUser(userId, icpStartPatch());
    }),
  };
});

jest.mock("../services/onboardingCompetitorService", () => {
  const actual = jest.requireActual("../services/onboardingCompetitorService");
  return {
    ...actual,
    startCompetitorStrategyForUser: jest.fn(),
  };
});

jest.mock("../services/onboardingCreativeDirService", () => {
  const actual = jest.requireActual("../services/onboardingCreativeDirService");
  return { ...actual, startCreativeDirForUser: jest.fn() };
});

jest.mock("../services/onboardingAdCopyService", () => {
  const actual = jest.requireActual("../services/onboardingAdCopyService");
  return { ...actual, startAdCopyForUser: jest.fn() };
});

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

import onboardingStepsRoutes from "../routes/onboardingSteps";
const { userDb } = require("../services/db");

const app = express();
app.use(express.json());
app.use("/api/onboarding", onboardingStepsRoutes);

const personaA = {
  name: "Founders",
  pain: "no leads",
  desire: "more pipeline",
  objection: "tools are noisy",
  meta_targeting_brief: "founders, USA",
};
const personaB = {
  name: "Heads of growth",
  pain: "manual ops",
  desire: "automation",
  objection: "trust",
  meta_targeting_brief: "growth roles, B2B SaaS",
};
const personaC = {
  name: "Agency owners",
  pain: "client churn",
  desire: "retainer clients",
  objection: "time",
  meta_targeting_brief: "agency owners",
};

beforeEach(() => {
  jest.clearAllMocks();
});

// ───────────────────── /icp/edit-one ─────────────────────

describe("POST /api/onboarding/icp/edit-one", () => {
  it("401s without auth", async () => {
    const res = await request(app)
      .post("/api/onboarding/icp/edit-one")
      .set("x-no-auth", "1")
      .send({ icpId: "icp-0", patch: { pain: "x" } });
    expect(res.status).toBe(401);
  });

  it("400s when icpId is missing", async () => {
    const res = await request(app)
      .post("/api/onboarding/icp/edit-one")
      .send({ patch: { pain: "x" } });
    expect(res.status).toBe(400);
  });

  it("400s when patch is missing or empty", async () => {
    let res = await request(app)
      .post("/api/onboarding/icp/edit-one")
      .send({ icpId: "icp-0" });
    expect(res.status).toBe(400);
    res = await request(app)
      .post("/api/onboarding/icp/edit-one")
      .send({ icpId: "icp-0", patch: {} });
    expect(res.status).toBe(400);
  });

  it("404s when no icpResult on user", async () => {
    userDb.getUserById.mockResolvedValue({ userId: "user-1" });
    const res = await request(app)
      .post("/api/onboarding/icp/edit-one")
      .send({ icpId: "icp-0", patch: { pain: "x" } });
    expect(res.status).toBe(404);
  });

  it("404s when the icpId doesn't resolve to an existing persona", async () => {
    userDb.getUserById.mockResolvedValue({
      userId: "user-1",
      icpResult: [personaA, personaB],
    });
    const res = await request(app)
      .post("/api/onboarding/icp/edit-one")
      .send({ icpId: "icp-99", patch: { pain: "x" } });
    expect(res.status).toBe(404);
  });

  it("merges only allowed fields and writes the new icpResult", async () => {
    userDb.getUserById.mockResolvedValue({
      userId: "user-1",
      icpResult: [personaA, personaB, personaC],
    });
    userDb.updateUser.mockResolvedValue({ userId: "user-1" });
    const res = await request(app)
      .post("/api/onboarding/icp/edit-one")
      .send({
        icpId: "icp-1",
        patch: {
          pain: "rewritten pain",
          objection: "rewritten objection",
          // bogus fields silently dropped:
          icpStatus: "ready",
          arbitrary: "nope",
        },
      });
    expect(res.status).toBe(200);
    expect(userDb.updateUser).toHaveBeenCalledTimes(1);
    const [, patch] = userDb.updateUser.mock.calls[0];
    expect(patch.icpResult).toHaveLength(3);
    expect(patch.icpResult[1].pain).toBe("rewritten pain");
    expect(patch.icpResult[1].objection).toBe("rewritten objection");
    expect(patch.icpResult[1].name).toBe("Heads of growth"); // untouched
    // Bogus fields must NOT leak through.
    expect(patch.icpResult[1]).not.toHaveProperty("icpStatus");
    expect(patch.icpResult[1]).not.toHaveProperty("arbitrary");
  });
});

// ───────────────────── /icp/regenerate-one ─────────────────────

describe("POST /api/onboarding/icp/regenerate-one", () => {
  it("401s without auth", async () => {
    const res = await request(app)
      .post("/api/onboarding/icp/regenerate-one")
      .set("x-no-auth", "1")
      .send({ icpId: "icp-0" });
    expect(res.status).toBe(401);
  });

  it("400s when icpId is missing", async () => {
    const res = await request(app)
      .post("/api/onboarding/icp/regenerate-one")
      .send({});
    expect(res.status).toBe(400);
  });

  it("flips icpStatus to running and triggers the orchestrator", async () => {
    const { startIcpDiscoveryForUser } = require("../services/onboardingIcpService");
    (startIcpDiscoveryForUser as jest.Mock).mockClear();
    userDb.getUserById.mockResolvedValue({
      userId: "user-1",
      icpResult: [personaA, personaB],
      icpStatus: "ready",
    });
    userDb.updateUser.mockResolvedValue({ userId: "user-1" });
    const res = await request(app)
      .post("/api/onboarding/icp/regenerate-one")
      .send({ icpId: "icp-1" });
    expect(res.status).toBe(200);
    expect(startIcpDiscoveryForUser).toHaveBeenCalledTimes(1);
    expect(startIcpDiscoveryForUser).toHaveBeenCalledWith("user-1");
  });

  it("returns icpStatus='running' even when getUserById returns stale GSI data", async () => {
    // Repro of the bug observed during the 2026-04-27 baseline rerun
    // (Maya persona): `userDb.getUserById` queries `UserIdIndex` (GSI),
    // which is eventually consistent. Immediately after `updateUser`
    // sets icpStatus='running', the GSI may still return the pre-update
    // row showing icpStatus='ready' + the old icpResult. The route MUST
    // NOT trust that stale read — otherwise the FE sees `ready`, stops
    // polling, and the regen spinner sticks forever.
    const { startIcpDiscoveryForUser } = require("../services/onboardingIcpService");
    (startIcpDiscoveryForUser as jest.Mock).mockClear();
    // Simulate a stale GSI read: getUserById returns the PRE-update row.
    userDb.getUserById.mockResolvedValue({
      userId: "user-1",
      icpResult: [personaA, personaB],
      icpStatus: "ready",
      icpStartedAt: "2026-04-26T11:00:00.000Z",
      icpCompletedAt: "2026-04-26T11:00:20.000Z",
      icpDurationMs: 20_000,
    });
    userDb.updateUser.mockResolvedValue({ userId: "user-1" });
    const res = await request(app)
      .post("/api/onboarding/icp/regenerate-one")
      .send({ icpId: "icp-1" });
    expect(res.status).toBe(200);
    expect(res.body.status.icpStatus).toBe("running");
    expect(res.body.status.inFlight).toBe(true);
    // icpResult should NOT be the stale array — running-state snapshot
    // should not surface stale ICPs to the FE (avoids the regen spinner
    // clearing prematurely on content-key match).
    expect(res.body.status.icpResult).toBeUndefined();
  });
});

// ───────────────────── /icp/delete-one ─────────────────────

describe("POST /api/onboarding/icp/delete-one", () => {
  it("401s without auth", async () => {
    const res = await request(app)
      .post("/api/onboarding/icp/delete-one")
      .set("x-no-auth", "1")
      .send({ icpId: "icp-0" });
    expect(res.status).toBe(401);
  });

  it("400s when icpId is missing", async () => {
    const res = await request(app)
      .post("/api/onboarding/icp/delete-one")
      .send({});
    expect(res.status).toBe(400);
  });

  it("404s when no icpResult on user", async () => {
    userDb.getUserById.mockResolvedValue({ userId: "user-1" });
    const res = await request(app)
      .post("/api/onboarding/icp/delete-one")
      .send({ icpId: "icp-0" });
    expect(res.status).toBe(404);
  });

  it("404s when the icpId doesn't match any persona", async () => {
    userDb.getUserById.mockResolvedValue({
      userId: "user-1",
      icpResult: [personaA, personaB],
    });
    const res = await request(app)
      .post("/api/onboarding/icp/delete-one")
      .send({ icpId: "icp-9" });
    expect(res.status).toBe(404);
  });

  it("removes the persona at the given index and writes the new array", async () => {
    userDb.getUserById.mockResolvedValue({
      userId: "user-1",
      icpResult: [personaA, personaB, personaC],
    });
    userDb.updateUser.mockResolvedValue({ userId: "user-1" });
    const res = await request(app)
      .post("/api/onboarding/icp/delete-one")
      .send({ icpId: "icp-1" });
    expect(res.status).toBe(200);
    const [, patch] = userDb.updateUser.mock.calls[0];
    expect(patch.icpResult).toHaveLength(2);
    expect(patch.icpResult[0].name).toBe("Founders");
    expect(patch.icpResult[1].name).toBe("Agency owners");
  });
});

// ───────────────────── /value-prop ─────────────────────

describe("POST /api/onboarding/value-prop", () => {
  it("401s without auth", async () => {
    const res = await request(app)
      .post("/api/onboarding/value-prop")
      .set("x-no-auth", "1")
      .send({ valueProp: "x" });
    expect(res.status).toBe(401);
  });

  it("400s when valueProp is missing or non-string", async () => {
    let res = await request(app).post("/api/onboarding/value-prop").send({});
    expect(res.status).toBe(400);
    res = await request(app)
      .post("/api/onboarding/value-prop")
      .send({ valueProp: 42 });
    expect(res.status).toBe(400);
  });

  it("400s when valueProp is empty after trim", async () => {
    const res = await request(app)
      .post("/api/onboarding/value-prop")
      .send({ valueProp: "    " });
    expect(res.status).toBe(400);
  });

  it("trims and bounds the input, then persists to the User record", async () => {
    userDb.updateUser.mockResolvedValue({ userId: "user-1" });
    const long = " ".repeat(2) + "a".repeat(5000) + " ".repeat(2);
    const res = await request(app)
      .post("/api/onboarding/value-prop")
      .send({ valueProp: long });
    expect(res.status).toBe(200);
    const [, patch] = userDb.updateUser.mock.calls[0];
    expect(typeof patch.valueProp).toBe("string");
    expect(patch.valueProp.length).toBeLessThanOrEqual(2000);
    expect(patch.valueProp.startsWith("a")).toBe(true);
  });
});
