/**
 * POST /api/internal/usage — the agent-engine's usage ingestion (ENG-1134 gap 1).
 *
 * This route recorded to the shadow ledger but never charged the per-user quota,
 * so every browser-automation task's LLM spend was visible as burn while drawing
 * down nothing. That breaks ENG-200's rule that a real userId means a real charge,
 * and it is the largest remaining unmetered spender now that agent mode and Emma
 * are correct.
 *
 * Two properties matter beyond "it charges":
 *
 * 1. It charges ONCE PER USER per batch, not once per record. A batch may carry up
 *    to 500 records; incrementUserTokenUsage is a read-modify-write on a single
 *    user row, so per-record charging would mean 500 sequential contended writes
 *    for one task run. The ledger stays granular (rows are keyed by model+feature
 *    and must be), while the charge is summed — the same split the coding agent
 *    already uses.
 *
 * 2. Attribution must follow the route's existing anti-spoofing rule. The charge
 *    lands on the resolved user, never on the raw record's claim, or any engine
 *    token could bill spend to somebody else's quota.
 */

import request from "supertest";
import express from "express";
import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET || "your-secret-key";

jest.mock("../middleware/auth", () => ({
  authenticateToken: (req: any, res: any, next: any) => {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    try {
      req.user = jwt.verify(token, JWT_SECRET);
      next();
    } catch {
      res.status(401).json({ message: "Unauthorized" });
    }
  },
}));

const mockRecordUsage = jest.fn().mockResolvedValue(undefined);
const mockIncrementUserTokenUsage = jest.fn().mockResolvedValue(undefined);

jest.mock("../services/usageRecorderService", () => ({
  ...jest.requireActual("../services/usageRecorderService"),
  recordUsage: (...args: unknown[]) => mockRecordUsage(...args),
}));
jest.mock("../services/tokenUsageService", () => ({
  incrementUserTokenUsage: (...args: unknown[]) => mockIncrementUserTokenUsage(...args),
}));

import internalUsageRoutes from "../routes/internalUsage";

const app = express();
app.use(express.json());
app.use("/api/internal", internalUsageRoutes);

const ownerToken = jwt.sign({ userId: "user-1", email: "u@example.com" }, JWT_SECRET);
const adminToken = jwt.sign(
  { userId: "admin-1", email: "a@example.com", isAdmin: true },
  JWT_SECRET
);

/** A priced Bedrock record — opus-5 is $5/M in, $25/M out, cache read $0.5/M. */
function record(over: Record<string, unknown> = {}) {
  return {
    model: "anthropic.claude-opus-5",
    provider: "bedrock",
    inputTokens: 1_000_000,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    ...over,
  };
}

beforeEach(() => jest.clearAllMocks());

describe("POST /api/internal/usage — charges the per-user quota", () => {
  it("charges the authenticated user for a single record", async () => {
    const res = await request(app)
      .post("/api/internal/usage")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ records: [record()] });

    expect(res.status).toBe(202);
    expect(mockIncrementUserTokenUsage).toHaveBeenCalledTimes(1);
    const [userId, tokens, cost] = mockIncrementUserTokenUsage.mock.calls[0];
    expect(userId).toBe("user-1");
    expect(tokens).toBe(1_000_000);
    expect(cost).toBeCloseTo(5, 5); // 1M input tokens at $5/M
  });

  it("charges ONCE with the batch summed, not once per record", async () => {
    const res = await request(app)
      .post("/api/internal/usage")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ records: [record(), record(), record()] });

    expect(res.status).toBe(202);
    // Three ledger rows, one charge.
    expect(mockRecordUsage).toHaveBeenCalledTimes(3);
    expect(mockIncrementUserTokenUsage).toHaveBeenCalledTimes(1);
    const [, tokens, cost] = mockIncrementUserTokenUsage.mock.calls[0];
    expect(tokens).toBe(3_000_000);
    expect(cost).toBeCloseTo(15, 5);
  });

  it("counts cache tokens in both the charge and its cost", async () => {
    await request(app)
      .post("/api/internal/usage")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({
        records: [record({ inputTokens: 0, cacheReadTokens: 2_000_000 })],
      });

    const [, tokens, cost] = mockIncrementUserTokenUsage.mock.calls[0];
    expect(tokens).toBe(2_000_000);
    expect(cost).toBeCloseTo(1, 5); // 2M cache-read at $0.50/M
  });

  it("bills each user separately when an admin submits a mixed batch", async () => {
    await request(app)
      .post("/api/internal/usage")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        records: [record({ userId: "user-a" }), record({ userId: "user-b" }), record({ userId: "user-a" })],
      });

    expect(mockIncrementUserTokenUsage).toHaveBeenCalledTimes(2);
    const byUser = Object.fromEntries(
      mockIncrementUserTokenUsage.mock.calls.map((c) => [c[0], c[1]])
    );
    expect(byUser["user-a"]).toBe(2_000_000);
    expect(byUser["user-b"]).toBe(1_000_000);
  });

  it("ignores a spoofed userId and bills the authenticated caller", async () => {
    // A non-admin engine token claiming someone else's userId must not be able to
    // drain that user's quota.
    await request(app)
      .post("/api/internal/usage")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ records: [record({ userId: "victim-9" })] });

    expect(mockIncrementUserTokenUsage).toHaveBeenCalledTimes(1);
    expect(mockIncrementUserTokenUsage.mock.calls[0][0]).toBe("user-1");
  });

  it("does not charge for an unpriced model but still records it", async () => {
    // Tokens are real even when we cannot price them; the charge must not silently
    // become a $0 deduction that looks like a successful bill.
    await request(app)
      .post("/api/internal/usage")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ records: [record({ model: "some-unlisted-model-xyz" })] });

    expect(mockRecordUsage).toHaveBeenCalledTimes(1);
    const [, tokens, cost] = mockIncrementUserTokenUsage.mock.calls[0];
    expect(tokens).toBe(1_000_000);
    expect(cost).toBe(0);
  });

  it("skips invalid records without charging for them", async () => {
    const res = await request(app)
      .post("/api/internal/usage")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ records: [record(), { model: "", inputTokens: 1, outputTokens: 1 }] });

    expect(res.body).toEqual({ accepted: 1, skipped: 1 });
    const [, tokens] = mockIncrementUserTokenUsage.mock.calls[0];
    expect(tokens).toBe(1_000_000);
  });

  it("does not charge platform overhead attributed to \"system\"", async () => {
    // "system" is the recorder's stand-in for spend with nobody to bill. Charging
    // it would invent a user and deduct real allowance from a row that is not a
    // customer.
    const systemToken = jwt.sign({ userId: "system", email: "sys@example.com" }, JWT_SECRET);

    const res = await request(app)
      .post("/api/internal/usage")
      .set("Authorization", `Bearer ${systemToken}`)
      .send({ records: [record()] });

    expect(res.status).toBe(202);
    // Still recorded — platform overhead must stay visible in the ledger.
    expect(mockRecordUsage).toHaveBeenCalledTimes(1);
    expect(mockIncrementUserTokenUsage).not.toHaveBeenCalled();
  });

  it("never lets a metering failure fail the ingestion", async () => {
    // The engine is fail-open by contract; a quota write blip must not turn into
    // a 500 that makes it retry and double-charge.
    mockIncrementUserTokenUsage.mockRejectedValueOnce(new Error("dynamo down"));

    const res = await request(app)
      .post("/api/internal/usage")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ records: [record()] });

    expect(res.status).toBe(202);
  });
});

describe("POST /api/internal/usage — engine spend is separable in the ledger", () => {
  /**
   * The ledger's sort key is `{date}#{model}#{feature}`, so `feature` is the only
   * component that can carry provenance. The engine reports `feature="agent_task"`
   * — the same value agent-mode chat uses — so both merge into one row and are
   * then arithmetically inseparable. `taskId` would have discriminated, but
   * usageRecordDb never persists it; `provider` and `sessionId` are written
   * if_not_exists, so they are first-write-wins and equally useless.
   *
   * This route is the agent-engine's endpoint by definition, so the backend knows
   * the provenance regardless of what the caller claims and can namespace it here.
   * Doing it in the backend rather than the Python engine also means it ships on
   * the normal deploy pipeline instead of a manual GCP-VM procedure.
   *
   * Only fixes things going forward — historical rows stay merged permanently,
   * which is why this wants to land in the SAME deploy that starts charging.
   */

  it("namespaces the generic agent_task so it cannot merge with agent-mode chat", async () => {
    await request(app)
      .post("/api/internal/usage")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ records: [record()] });

    expect(mockRecordUsage).toHaveBeenCalledTimes(1);
    expect(mockRecordUsage.mock.calls[0][0]).toMatchObject({ feature: "engine:agent_task" });
  });

  it("preserves a more specific feature rather than flattening it", async () => {
    await request(app)
      .post("/api/internal/usage")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ records: [record({ feature: "deep_research" })] });

    expect(mockRecordUsage.mock.calls[0][0]).toMatchObject({ feature: "engine:deep_research" });
  });

  it("does not double-prefix an already-namespaced feature", async () => {
    await request(app)
      .post("/api/internal/usage")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ records: [record({ feature: "engine:agent_task" })] });

    expect(mockRecordUsage.mock.calls[0][0]).toMatchObject({ feature: "engine:agent_task" });
  });

  it("labels without changing what the user is charged", async () => {
    await request(app)
      .post("/api/internal/usage")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ records: [record()] });

    const [, tokens, cost] = mockIncrementUserTokenUsage.mock.calls[0];
    expect(tokens).toBe(1_000_000);
    expect(cost).toBeCloseTo(5, 5);
  });
});
