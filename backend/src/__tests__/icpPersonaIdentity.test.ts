/**
 * Stable ICP persona identity.
 *
 * Personas used to be addressed positionally: the FE synthesised `icp-<index>`
 * from its snapshot and every mutator (`/icp/edit-one`, `/icp/regenerate-one`,
 * `/icp/delete-one`) parsed that index straight back out.
 *
 * `/icp/delete-one` splices the array server-side, and the FE does not refetch
 * afterwards (`useIcpStatus` stops polling once status is `ready`). So the
 * browser keeps pre-delete indices: delete card 2, regenerate "card 4", and
 * the server regenerates card 5 instead. `/icp/edit-one` has the same hazard.
 *
 * Fix: every persona carries a server-minted `id`, preserved across writes.
 * Mutators resolve by id, falling back to the legacy positional form only when
 * no persona carries one. A regenerated persona INHERITS the id of the card it
 * replaces — same card, new content — so the FE's per-card spinner and
 * removed-set keep working across a regeneration.
 */

import request from "supertest";
import express from "express";

jest.mock("../services/db", () => ({
  userDb: {
    getUserById: jest.fn(),
    getUserByEmailConsistent: jest.fn(),
    updateUser: jest.fn(),
  },
}));

jest.mock("../services/onboardingIcpService", () => {
  const actual = jest.requireActual("../services/onboardingIcpService");
  return {
    ...actual,
    startIcpDiscoveryForUser: jest.fn(async () => {}),
    regenerateSingleIcpForUser: jest.fn(async () => {}),
  };
});

jest.mock("../middleware/auth", () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = { userId: "user-1", email: "test@example.com", isAdmin: false };
    next();
  },
}));

import onboardingStepsRoutes from "../routes/onboardingSteps";
import {
  ensurePersonaIds,
  sanitizeICPPersonas,
} from "../services/icpStatusService";

const { userDb } = require("../services/db");
const { regenerateSingleIcpForUser } = require("../services/onboardingIcpService");

const app = express();
app.use(express.json());
app.use("/api/onboarding", onboardingStepsRoutes);

function persona(n: number, extra: Record<string, unknown> = {}): any {
  return {
    name: `P${n}`,
    pain: `pain${n}`,
    desire: `desire${n}`,
    objection: `objection${n}`,
    meta_targeting_brief: `brief${n}`,
    ...extra,
  };
}

/** Five personas carrying stable ids, as they exist post-migration. */
function identified() {
  return [0, 1, 2, 3, 4].map((n) => persona(n, { id: `icp_stable_${n}` }));
}

beforeEach(() => {
  jest.clearAllMocks();
  userDb.getUserById.mockReset();
  userDb.getUserByEmailConsistent.mockReset();
  userDb.updateUser.mockReset();
  userDb.updateUser.mockResolvedValue({ userId: "user-1" });
});

/** Last `icpResult` written across all updateUser calls. */
function lastWrittenIcps(): any[] | undefined {
  const calls = userDb.updateUser.mock.calls;
  for (let i = calls.length - 1; i >= 0; i--) {
    if (calls[i][1]?.icpResult) return calls[i][1].icpResult;
  }
  return undefined;
}

// ───────────────────────── id minting + persistence ─────────────────────────

describe("persona ids survive sanitisation and are minted where missing", () => {
  it("round-trips an existing id", () => {
    const out = sanitizeICPPersonas([persona(0, { id: "icp_abc123" })]);
    expect(out[0].id).toBe("icp_abc123");
  });

  it("drops a non-string id rather than persisting garbage", () => {
    const out = sanitizeICPPersonas([persona(0, { id: { nope: true } as any })]);
    expect(out[0].id).toBeUndefined();
  });

  it("mints ids only for personas that lack one, leaving the rest alone", () => {
    let seq = 0;
    const out = ensurePersonaIds(
      [persona(0, { id: "icp_keepme" }), persona(1)],
      () => `icp_minted_${seq++}`,
    );
    expect(out[0].id).toBe("icp_keepme");
    expect(out[1].id).toBe("icp_minted_0");
  });

  it("mints ids that are unique across a set", () => {
    const out = ensurePersonaIds([persona(0), persona(1), persona(2)]);
    const ids = out.map((p) => p.id);
    expect(new Set(ids).size).toBe(3);
    expect(ids.every((id) => typeof id === "string" && id!.length > 0)).toBe(true);
  });
});

// ─────────────────────── the delete-then-mutate race ───────────────────────

describe("mutators address personas by id, not by position", () => {
  it("regenerates the persona the user clicked after an earlier delete shifted indices", async () => {
    // Browser holds the pre-delete snapshot. Server has already dropped P1, so
    // the persona the user clicked (icp_stable_3) now sits at index 2.
    const afterDelete = identified().filter((p) => p.id !== "icp_stable_1");
    userDb.getUserById.mockResolvedValue({ userId: "user-1", icpResult: afterDelete });

    const res = await request(app)
      .post("/api/onboarding/icp/regenerate-one")
      .send({ icpId: "icp_stable_3" });

    expect(res.status).toBe(200);
    // Positional resolution would have sent 3 — which is now icp_stable_4.
    expect(regenerateSingleIcpForUser).toHaveBeenCalledWith("user-1", 2);
  });

  it("edits the persona the user clicked after an earlier delete shifted indices", async () => {
    const afterDelete = identified().filter((p) => p.id !== "icp_stable_0");
    userDb.getUserById.mockResolvedValue({ userId: "user-1", icpResult: afterDelete });

    const res = await request(app)
      .post("/api/onboarding/icp/edit-one")
      .send({ icpId: "icp_stable_2", patch: { name: "ZZZ TEST 123" } });

    expect(res.status).toBe(200);
    const written = lastWrittenIcps()!;
    const edited = written.find((p: any) => p.id === "icp_stable_2");
    expect(edited.name).toBe("ZZZ TEST 123");
    // Every other persona is untouched.
    expect(written.find((p: any) => p.id === "icp_stable_3").name).toBe("P3");
  });

  it("deletes the persona the user clicked, not the one at that index", async () => {
    userDb.getUserById.mockResolvedValue({ userId: "user-1", icpResult: identified() });

    const res = await request(app)
      .post("/api/onboarding/icp/delete-one")
      .send({ icpId: "icp_stable_3" });

    expect(res.status).toBe(200);
    expect(res.body.icpResult.map((p: any) => p.id)).toEqual([
      "icp_stable_0",
      "icp_stable_1",
      "icp_stable_2",
      "icp_stable_4",
    ]);
  });

  it("404s when the id names a persona that no longer exists", async () => {
    userDb.getUserById.mockResolvedValue({ userId: "user-1", icpResult: identified() });

    const res = await request(app)
      .post("/api/onboarding/icp/delete-one")
      .send({ icpId: "icp_already_gone" });

    expect(res.status).toBe(404);
    expect(userDb.updateUser).not.toHaveBeenCalled();
  });
});

// ───────────────────────── legacy positional fallback ─────────────────────────

describe("legacy personas without ids still resolve positionally", () => {
  it("accepts icp-N when no persona carries an id", async () => {
    userDb.getUserById.mockResolvedValue({
      userId: "user-1",
      icpResult: [persona(0), persona(1), persona(2)],
    });

    const res = await request(app)
      .post("/api/onboarding/icp/regenerate-one")
      .send({ icpId: "icp-1" });

    expect(res.status).toBe(200);
    expect(regenerateSingleIcpForUser).toHaveBeenCalledWith("user-1", 1);
  });

  it("400s on an id that is neither a known persona nor a positional ref", async () => {
    userDb.getUserById.mockResolvedValue({ userId: "user-1", icpResult: identified() });

    const res = await request(app)
      .post("/api/onboarding/icp/regenerate-one")
      .send({ icpId: "garbage" });

    expect(res.status).toBe(400);
    expect(regenerateSingleIcpForUser).not.toHaveBeenCalled();
  });
});

// ─────────────────────── self-healing backfill on read ───────────────────────

describe("GET /icp/status backfills missing ids so the FE never holds positional refs", () => {
  it("mints and persists ids when personas lack them", async () => {
    userDb.getUserByEmailConsistent.mockResolvedValue({
      userId: "user-1",
      icpStatus: "ready",
      icpResult: [persona(0), persona(1)],
    });

    const res = await request(app).get("/api/onboarding/icp/status");

    expect(res.status).toBe(200);
    const returned = res.body.status.icpResult;
    expect(returned.every((p: any) => typeof p.id === "string" && p.id.length > 0)).toBe(true);
    // Persisted, not just decorated on the way out — otherwise the next
    // mutation would send an id the stored record does not carry.
    const written = lastWrittenIcps()!;
    expect(written.map((p: any) => p.id)).toEqual(returned.map((p: any) => p.id));
  });

  it("does not write when every persona already has an id", async () => {
    userDb.getUserByEmailConsistent.mockResolvedValue({
      userId: "user-1",
      icpStatus: "ready",
      icpResult: identified(),
    });

    const res = await request(app).get("/api/onboarding/icp/status");

    expect(res.status).toBe(200);
    expect(userDb.updateUser).not.toHaveBeenCalled();
  });

  it("still serves the snapshot when the backfill write fails", async () => {
    userDb.getUserByEmailConsistent.mockResolvedValue({
      userId: "user-1",
      icpStatus: "ready",
      icpResult: [persona(0)],
    });
    userDb.updateUser.mockRejectedValue(new Error("dynamo down"));
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});

    const res = await request(app).get("/api/onboarding/icp/status");

    expect(res.status).toBe(200);
    expect(res.body.status.icpResult).toHaveLength(1);
    spy.mockRestore();
  });

  it("does not write when there are no personas at all", async () => {
    userDb.getUserByEmailConsistent.mockResolvedValue({
      userId: "user-1",
      icpStatus: "running",
    });

    const res = await request(app).get("/api/onboarding/icp/status");

    expect(res.status).toBe(200);
    expect(userDb.updateUser).not.toHaveBeenCalled();
  });
});
