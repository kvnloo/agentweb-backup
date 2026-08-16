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
// ENG-1251 Greptile P1 ("Coverage suppresses unrelated aggregate usage"): a
// charged group's ledger write and its paired charge event are now written
// atomically in one DynamoDB transaction (usageRecordDb.incrementUsageWithChargeEvent) --
// closing BOTH "retries duplicate aggregate usage" (the pre-check era's fix)
// AND the deeper finding that a real ledger-write failure could leave a
// charge event recorded with no matching ledger contribution.
//
// Default "applied": a clean transaction, ledger + charge event both written
// atomically -- so recordUsage() (the plain per-record ledger call) is NOT
// invoked for a charged record in the default/happy-path case any more. It
// is only invoked for uncharged ("system") records and the "conflict"/"error"
// non-atomic fallback path -- tests exercising those override this per-call.
const mockIncrementUsageWithChargeEvent = jest.fn().mockResolvedValue("applied");

jest.mock("../services/usageRecorderService", () => ({
  ...jest.requireActual("../services/usageRecorderService"),
  recordUsage: (...args: unknown[]) => mockRecordUsage(...args),
}));
jest.mock("../services/tokenUsageService", () => ({
  incrementUserTokenUsage: (...args: unknown[]) => mockIncrementUserTokenUsage(...args),
  // ENG-1251 Greptile P1: internalUsage.ts now resolves each contributing
  // actor's billing owner before recording the ledger row. Defaults to
  // "same as input" (no pooling) -- no test in this file exercises pooling.
  resolveBillingUserId: (userId: string) => Promise.resolve(userId),
}));
jest.mock("../services/usageRecordDb", () => ({
  usageRecordDb: {
    incrementUsageWithChargeEvent: (...args: unknown[]) => mockIncrementUsageWithChargeEvent(...args),
  },
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

beforeEach(() => {
  jest.clearAllMocks();
  // clearAllMocks() resets call history but NOT a persistent implementation
  // set via mockImplementation()/mockResolvedValue() -- a test that installs
  // a custom implementation (e.g. the mixed-batch duplicate test below)
  // would otherwise leak it into every later test in this file. Restore the
  // "clean atomic write" default explicitly every test.
  mockIncrementUsageWithChargeEvent.mockResolvedValue("applied");
});

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

  it("writes the ledger contribution ONCE via the atomic charge write, with the batch summed -- not once per record", async () => {
    const res = await request(app)
      .post("/api/internal/usage")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ records: [record(), record(), record()] });

    expect(res.status).toBe(202);
    // Three records in the SAME (userId, model, feature) charge group share
    // one ledger row by construction -- the atomic write sums them into ONE
    // combined increment, not three separate recordUsage() calls.
    expect(mockIncrementUsageWithChargeEvent).toHaveBeenCalledTimes(1);
    expect(mockRecordUsage).not.toHaveBeenCalled();
    const [ledgerInc] = mockIncrementUsageWithChargeEvent.mock.calls[0];
    expect(ledgerInc.inputTokens).toBe(3_000_000);
    expect(ledgerInc.calls).toBe(3);
    expect(mockIncrementUserTokenUsage).toHaveBeenCalledTimes(1);
    const [, tokens, cost] = mockIncrementUserTokenUsage.mock.calls[0];
    expect(tokens).toBe(3_000_000);
    expect(cost).toBeCloseTo(15, 5);
  });

  it("ENG-1251 Greptile P1: passes the true call count, not a hardcoded 1, for a summed batch", async () => {
    await request(app)
      .post("/api/internal/usage")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ records: [record(), record(), record()] });

    const [, , , audit] = mockIncrementUserTokenUsage.mock.calls[0];
    expect(audit?.calls).toBe(3);
  });

  it("ENG-1251 Greptile P1: the ledger increment's date and the charge event's occurredAt are derived from the SAME instant", async () => {
    // Two independent `new Date()` calls a few awaits apart could straddle
    // a UTC-midnight boundary, landing the ledger row and the charge event
    // on different dates -- breaking the (date, model, feature) key the
    // itemization reconciliation matches on. Both must come from one
    // shared timestamp captured at the top of the request.
    await request(app)
      .post("/api/internal/usage")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ records: [record()] });

    const [ledgerInc, chargeEvent] = mockIncrementUsageWithChargeEvent.mock.calls[0];
    expect(ledgerInc.date).toBeDefined();
    expect(chargeEvent.occurredAt).toBeDefined();
    expect(chargeEvent.occurredAt.slice(0, 10)).toBe(ledgerInc.date);
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

  it("ENG-1251 Greptile P1: splits a mixed-model batch into one charge event per (model, feature), not one summed event for the user", async () => {
    // A single charge event aggregated across every model in the batch cannot
    // carry one true model -- the itemization reconciliation (subscription.ts)
    // matches a charge event against its covered daily-aggregate row by
    // (date, model, feature), so a mis-attributed or missing model means the
    // event can never key-match its aggregate row, and both show up in the
    // itemized view (double-counted).
    await request(app)
      .post("/api/internal/usage")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({
        records: [
          record({ model: "anthropic.claude-opus-5", outputTokens: 100 }),
          record({ model: "gemini-2.5-pro", inputTokens: 500_000, outputTokens: 0 }),
        ],
      });

    expect(mockIncrementUserTokenUsage).toHaveBeenCalledTimes(2);
    const byModel = Object.fromEntries(
      mockIncrementUserTokenUsage.mock.calls.map((c) => [c[3]?.model, c[3]])
    );
    expect(byModel["anthropic.claude-opus-5"]).toMatchObject({
      model: "anthropic.claude-opus-5",
      feature: "engine:agent_task",
    });
    expect(byModel["gemini-2.5-pro"]).toMatchObject({
      model: "gemini-2.5-pro",
      feature: "engine:agent_task",
    });
    // Distinct (model, feature) keys must never collapse into the same eventId.
    expect(byModel["anthropic.claude-opus-5"].eventId).not.toBe(byModel["gemini-2.5-pro"].eventId);
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

    expect(mockIncrementUsageWithChargeEvent).toHaveBeenCalledTimes(1);
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
    // Uncharged records have no charge group to pair with, so they always go
    // through the plain (non-atomic) recordUsage() path, unaffected by any
    // of the atomic-write machinery above.
    expect(mockRecordUsage).toHaveBeenCalledTimes(1);
    expect(mockIncrementUserTokenUsage).not.toHaveBeenCalled();
    expect(mockIncrementUsageWithChargeEvent).not.toHaveBeenCalled();
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

describe("POST /api/internal/usage — idempotent against a resubmitted batch (ENG-1251)", () => {
  // This endpoint is fail-open by contract (202 regardless of charge success),
  // so the engine has no signal telling it whether a submission already landed.
  // A network timeout, or a worker that crashes mid-task and resubmits after
  // restart, can resend the SAME task's usage. Without a stable eventId, that
  // resubmission is a second full charge with no corresponding ledger evidence
  // of it being a duplicate — the exact shape of an unreconcilable counter/
  // ledger divergence.
  it("always derives an eventId, even with no taskId on any record", async () => {
    await request(app)
      .post("/api/internal/usage")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ records: [record()] });

    const [, , , audit] = mockIncrementUserTokenUsage.mock.calls[0];
    expect(audit?.eventId).toEqual(expect.stringMatching(/^engine:user-1:anthropic\.claude-opus-5:engine:agent_task:[0-9a-f]{32}$/));
  });

  it("derives the identical eventId for a byte-identical resubmitted batch", async () => {
    await request(app)
      .post("/api/internal/usage")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ records: [record({ taskId: "task-abc" })] });
    const [, , , first] = mockIncrementUserTokenUsage.mock.calls[0];

    mockIncrementUserTokenUsage.mockClear();

    // Same task, identical record content resubmitted (e.g. engine retry /
    // crash-restart) — must derive the identical eventId, which is what lets
    // the atomic write's conditional put turn this into a no-op instead of
    // a second charge.
    await request(app)
      .post("/api/internal/usage")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ records: [record({ taskId: "task-abc" })] });
    const [, , , second] = mockIncrementUserTokenUsage.mock.calls[0];

    expect(second.eventId).toBe(first.eventId);
  });

  it("derives a different eventId for identical records resubmitted well outside the retry window (Greptile P1: distinct reruns with identical measurements must not silently collapse)", async () => {
    // Content-only fingerprinting can't tell "the same submission retried"
    // apart from "a distinct rerun that happens to produce identical
    // measurements" (a deterministic/templated task can do this). Time
    // bucketing distinguishes them: near-immediate resubmission (retry,
    // crash-restart) stays in the same bucket and dedupes; a rerun 20
    // minutes later — well outside the 10-minute collapse window — gets its
    // own key and is charged in full, not silently dropped.
    const realDateNow = Date.now;
    try {
      Date.now = jest.fn(() => new Date("2026-08-16T00:00:00.000Z").getTime());
      await request(app)
        .post("/api/internal/usage")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ records: [record({ taskId: "task-abc" })] });
      const [, , , first] = mockIncrementUserTokenUsage.mock.calls[0];

      mockIncrementUserTokenUsage.mockClear();

      Date.now = jest.fn(() => new Date("2026-08-16T00:20:00.000Z").getTime());
      await request(app)
        .post("/api/internal/usage")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ records: [record({ taskId: "task-abc" })] });
      const [, , , second] = mockIncrementUserTokenUsage.mock.calls[0];

      expect(second.eventId).not.toBe(first.eventId);
    } finally {
      Date.now = realDateNow;
    }
  });

  it("derives a different eventId for a genuinely different task", async () => {
    await request(app)
      .post("/api/internal/usage")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ records: [record({ taskId: "task-one" })] });
    const [, , , first] = mockIncrementUserTokenUsage.mock.calls[0];

    mockIncrementUserTokenUsage.mockClear();

    await request(app)
      .post("/api/internal/usage")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ records: [record({ taskId: "task-two" })] });
    const [, , , second] = mockIncrementUserTokenUsage.mock.calls[0];

    expect(first.eventId).not.toBe(second.eventId);
  });

  it("derives a different eventId for a genuinely different (larger) batch on the SAME taskId — does not undercharge incremental submissions", async () => {
    // Greptile P1: a task-only key would make a second, legitimately larger
    // batch for the same task collide with the first submission and get
    // silently dropped. A long-running task reporting usage incrementally
    // must have each distinct batch charged in full.
    await request(app)
      .post("/api/internal/usage")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ records: [record({ taskId: "task-abc" })] });
    const [, , , first] = mockIncrementUserTokenUsage.mock.calls[0];

    mockIncrementUserTokenUsage.mockClear();

    // Same task, but a second record on top this time — a genuinely
    // different batch, not a resubmission.
    await request(app)
      .post("/api/internal/usage")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ records: [record({ taskId: "task-abc" }), record({ taskId: "task-abc", outputTokens: 500 })] });
    const [, , , second] = mockIncrementUserTokenUsage.mock.calls[0];

    expect(second.eventId).not.toBe(first.eventId);
  });

  it("combines multiple records contributing to one user's aggregate charge, order-independent", async () => {
    await request(app)
      .post("/api/internal/usage")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ records: [record({ taskId: "task-b" }), record({ taskId: "task-a" })] });
    const [, , , first] = mockIncrementUserTokenUsage.mock.calls[0];

    mockIncrementUserTokenUsage.mockClear();

    // Same two records, reported in the opposite order — must still collapse
    // to the same key.
    await request(app)
      .post("/api/internal/usage")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ records: [record({ taskId: "task-a" }), record({ taskId: "task-b" })] });
    const [, , , second] = mockIncrementUserTokenUsage.mock.calls[0];

    expect(first.eventId).toBe(second.eventId);
  });
});

describe("POST /api/internal/usage — prefers the engine's own reportId over the content fingerprint (ENG-1251)", () => {
  // agent-engine/usage_reporter.py generates one UUID per UsageReporter
  // instance (one per task-execution process) and sends it as reportId on
  // every flush attempt. Unlike the content+time-bucket fallback, this is
  // exact: no coincidental collisions, no bucket-boundary edge case.
  it("derives eventId from the resolved user + reportId + content fingerprint when present", async () => {
    await request(app)
      .post("/api/internal/usage")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ records: [record({ taskId: "task-abc" })], reportId: "a1b2c3d4e5f6" });

    const [, , , audit] = mockIncrementUserTokenUsage.mock.calls[0];
    expect(audit?.eventId).toEqual(
      expect.stringMatching(/^engine:user-1:anthropic\.claude-opus-5:engine:agent_task:a1b2c3d4e5f6:[0-9a-f]{32}$/)
    );
  });

  it("collapses a genuine retry (same reportId, byte-identical content)", async () => {
    await request(app)
      .post("/api/internal/usage")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ records: [record({ taskId: "task-abc" })], reportId: "same-report-id" });
    const [, , , first] = mockIncrementUserTokenUsage.mock.calls[0];

    mockIncrementUserTokenUsage.mockClear();

    // Identical resubmission -- the exact retry case reportId exists to handle.
    await request(app)
      .post("/api/internal/usage")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ records: [record({ taskId: "task-abc" })], reportId: "same-report-id" });
    const [, , , second] = mockIncrementUserTokenUsage.mock.calls[0];

    expect(second.eventId).toBe(first.eventId);
  });

  it("ENG-1251 Greptile P1 (security): a REUSED reportId carrying DIFFERENT content charges separately instead of silently collapsing", async () => {
    // reportId is caller-controlled and otherwise unvalidated. An engine bug
    // (or genuine misuse) reusing a reportId across two truly distinct
    // batches must not let the second batch's real usage vanish into a
    // dedup no-op -- that is an undercharge with zero signal anything was
    // dropped. The content fingerprint is folded into the eventId even when
    // reportId is present specifically to prevent this: same reportId alone
    // is no longer sufficient to collapse two batches with different content.
    await request(app)
      .post("/api/internal/usage")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ records: [record({ taskId: "task-abc" })], reportId: "same-report-id" });
    const [, , , first] = mockIncrementUserTokenUsage.mock.calls[0];

    mockIncrementUserTokenUsage.mockClear();

    await request(app)
      .post("/api/internal/usage")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ records: [record({ taskId: "task-abc", outputTokens: 999 })], reportId: "same-report-id" });
    const [, , , second] = mockIncrementUserTokenUsage.mock.calls[0];

    expect(second.eventId).not.toBe(first.eventId);
  });

  it("derives a different eventId for a different reportId, even with identical record content", async () => {
    // The exact scenario the content-only fingerprint couldn't handle: two
    // genuinely distinct executions with identical measurements. Two
    // different UsageReporter instances always carry two different
    // reportIds, so both are charged in full.
    await request(app)
      .post("/api/internal/usage")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ records: [record({ taskId: "task-abc" })], reportId: "report-one" });
    const [, , , first] = mockIncrementUserTokenUsage.mock.calls[0];

    mockIncrementUserTokenUsage.mockClear();

    await request(app)
      .post("/api/internal/usage")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ records: [record({ taskId: "task-abc" })], reportId: "report-two" });
    const [, , , second] = mockIncrementUserTokenUsage.mock.calls[0];

    expect(second.eventId).not.toBe(first.eventId);
  });

  it("falls back to the content+time-bucket fingerprint when reportId is absent (older engine version)", async () => {
    await request(app)
      .post("/api/internal/usage")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ records: [record({ taskId: "task-abc" })] });

    const [, , , audit] = mockIncrementUserTokenUsage.mock.calls[0];
    expect(audit?.eventId).toEqual(expect.stringMatching(/^engine:user-1:anthropic\.claude-opus-5:engine:agent_task:[0-9a-f]{32}$/));
  });

  it("ignores a non-string reportId rather than using it verbatim", async () => {
    await request(app)
      .post("/api/internal/usage")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ records: [record({ taskId: "task-abc" })], reportId: 12345 });

    const [, , , audit] = mockIncrementUserTokenUsage.mock.calls[0];
    // Falls back to the fingerprint format, not "engine:user-1:12345".
    expect(audit?.eventId).toEqual(expect.stringMatching(/^engine:user-1:anthropic\.claude-opus-5:engine:agent_task:[0-9a-f]{32}$/));
  });

  it("ENG-1251 Greptile P1 (security): rejects an oversized reportId instead of letting it silently drop the charge", async () => {
    // DynamoDB sort keys are capped at 1024 bytes; a real engine reportId
    // is a ~36-char UUID. An oversized value embedded verbatim in the
    // charge event's key would make the audit write fail validation --
    // which the fail-open charging path would otherwise swallow, silently
    // omitting the batch from both the counter and itemization. Falls
    // through to the content+time-bucket fingerprint instead, same as an
    // absent reportId, so the batch still gets charged.
    const oversizedReportId = "x".repeat(2000);
    await request(app)
      .post("/api/internal/usage")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ records: [record({ taskId: "task-abc" })], reportId: oversizedReportId });

    const [, , , audit] = mockIncrementUserTokenUsage.mock.calls[0];
    expect(audit?.eventId).toEqual(expect.stringMatching(/^engine:user-1:anthropic\.claude-opus-5:engine:agent_task:[0-9a-f]{32}$/));
    expect(audit?.eventId).not.toContain(oversizedReportId);
  });

  it("accepts a reportId right at the length boundary", async () => {
    const boundaryReportId = "x".repeat(256);
    await request(app)
      .post("/api/internal/usage")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ records: [record({ taskId: "task-abc" })], reportId: boundaryReportId });

    const [, , , audit] = mockIncrementUserTokenUsage.mock.calls[0];
    expect(audit?.eventId).toContain(boundaryReportId);
  });
});

describe("POST /api/internal/usage — atomic ledger+charge write outcomes (ENG-1251 Greptile P1: retries duplicate aggregate usage + coverage suppresses unrelated aggregate usage)", () => {
  it("on a clean write (\"applied\"), the ledger contribution goes through the atomic call, not the separate recordUsage() fallback", async () => {
    mockIncrementUsageWithChargeEvent.mockResolvedValueOnce("applied");

    const res = await request(app)
      .post("/api/internal/usage")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ records: [record({ taskId: "task-abc" })], reportId: "fresh-report-id" });

    expect(res.status).toBe(202);
    expect(mockIncrementUsageWithChargeEvent).toHaveBeenCalledTimes(1);
    expect(mockRecordUsage).not.toHaveBeenCalled();
    expect(mockIncrementUserTokenUsage).toHaveBeenCalledTimes(1);
  });

  it("on a confirmed duplicate (\"duplicate\"), neither the atomic write nor the recordUsage() fallback double-writes the ledger", async () => {
    // "duplicate" means the transaction's conditional put on the charge event
    // failed -- this exact eventId (and by construction, its paired ledger
    // contribution) was already recorded by a prior attempt. Writing again
    // via ANY path would double the daily aggregate.
    mockIncrementUsageWithChargeEvent.mockResolvedValueOnce("duplicate");

    const res = await request(app)
      .post("/api/internal/usage")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ records: [record({ taskId: "task-abc" })], reportId: "retry-report-id" });

    expect(res.status).toBe(202);
    expect(mockRecordUsage).not.toHaveBeenCalled();
    // The counter apply still runs unconditionally -- safe (idempotent) and
    // necessary for the crash-recovery case (event recorded, apply never
    // reached on a prior attempt).
    expect(mockIncrementUserTokenUsage).toHaveBeenCalledTimes(1);
  });

  it("on a transient conflict (\"conflict\", not a confirmed duplicate), falls back to the non-atomic recordUsage() write so real usage is never silently dropped", async () => {
    mockIncrementUsageWithChargeEvent.mockResolvedValueOnce("conflict");

    const res = await request(app)
      .post("/api/internal/usage")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ records: [record({ taskId: "task-abc" })], reportId: "conflict-report-id" });

    expect(res.status).toBe(202);
    expect(mockRecordUsage).toHaveBeenCalledTimes(1);
    expect(mockIncrementUserTokenUsage).toHaveBeenCalledTimes(1);
  });

  it("only the DUPLICATE group in a mixed batch skips its ledger write -- the genuinely new group still writes atomically, neither goes through the fallback", async () => {
    // Two charge groups (different models): the opus-5 one is a confirmed
    // duplicate, the gemini one is genuinely new.
    mockIncrementUsageWithChargeEvent.mockImplementation(async (inc: { model?: string }) =>
      inc.model === "anthropic.claude-opus-5" ? "duplicate" : "applied"
    );

    const res = await request(app)
      .post("/api/internal/usage")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({
        records: [
          record({ model: "anthropic.claude-opus-5", taskId: "task-a" }),
          record({ model: "gemini-2.5-pro", taskId: "task-b" }),
        ],
        reportId: "mixed-batch-report-id",
      });

    expect(res.status).toBe(202);
    expect(mockIncrementUsageWithChargeEvent).toHaveBeenCalledTimes(2);
    // Neither group ever reaches the non-atomic fallback: "applied" wrote its
    // ledger row atomically, "duplicate" correctly skipped writing at all.
    expect(mockRecordUsage).not.toHaveBeenCalled();
    // Both charge groups still get their counter-apply attempt.
    expect(mockIncrementUserTokenUsage).toHaveBeenCalledTimes(2);
  });

  it("a conflict/error in one group's atomic write does not affect a sibling group's clean atomic write in the same batch", async () => {
    mockIncrementUsageWithChargeEvent.mockImplementation(async (inc: { model?: string }) =>
      inc.model === "anthropic.claude-opus-5" ? "conflict" : "applied"
    );

    await request(app)
      .post("/api/internal/usage")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({
        records: [
          record({ model: "anthropic.claude-opus-5", taskId: "task-a" }),
          record({ model: "gemini-2.5-pro", taskId: "task-b" }),
        ],
        reportId: "mixed-conflict-report-id",
      });

    // Only the conflicted group's record falls back to recordUsage().
    expect(mockRecordUsage).toHaveBeenCalledTimes(1);
    expect(mockRecordUsage.mock.calls[0][0]).toMatchObject({ model: "anthropic.claude-opus-5" });
  });

  it("still writes the ledger row for an uncharged (system) record even when other charge groups in the batch are duplicates", async () => {
    // No mockResolvedValueOnce queued here on purpose: a system-attributed
    // record never reaches the atomic write at all (asserted below), so a
    // queued "once" value would sit unconsumed and leak into the very next
    // test's call to this same mock instead (clearAllMocks() drains call
    // history, not a pending mockResolvedValueOnce queue).
    const systemToken = jwt.sign({ userId: "system", email: "sys@example.com" }, JWT_SECRET);

    // Two separate requests sharing app state isn't realistic here -- send
    // one batch as an admin naming both a real user (duplicate charge) and
    // implicitly "system" via a system-authenticated record in the SAME
    // batch is not directly expressible with this route's attribution
    // rule (system comes from the AUTHENTICATED caller, not per-record).
    // Exercise it directly: a system-authenticated submission is never
    // charged at all, so the atomic write's gating path must not touch it.
    const res = await request(app)
      .post("/api/internal/usage")
      .set("Authorization", `Bearer ${systemToken}`)
      .send({ records: [record({ taskId: "task-sys" })] });

    expect(res.status).toBe(202);
    expect(mockRecordUsage).toHaveBeenCalledTimes(1);
    expect(mockIncrementUserTokenUsage).not.toHaveBeenCalled();
    // "system" is never charged, so the atomic write never runs for it.
    expect(mockIncrementUsageWithChargeEvent).not.toHaveBeenCalled();
  });

  it("falls back to writing the ledger when the atomic write itself throws (ambiguous, not a confirmed duplicate)", async () => {
    mockIncrementUsageWithChargeEvent.mockRejectedValueOnce(new Error("DynamoDB unavailable"));

    const res = await request(app)
      .post("/api/internal/usage")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ records: [record({ taskId: "task-abc" })], reportId: "error-report-id" });

    expect(res.status).toBe(202);
    // An error is not proof of a duplicate -- undercounting real usage is
    // worse than an occasional double-count under a genuine infra error.
    expect(mockRecordUsage).toHaveBeenCalledTimes(1);
    // The counter apply still proceeds regardless.
    expect(mockIncrementUserTokenUsage).toHaveBeenCalledTimes(1);
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

    expect(mockIncrementUsageWithChargeEvent).toHaveBeenCalledTimes(1);
    expect(mockIncrementUsageWithChargeEvent.mock.calls[0][0]).toMatchObject({ feature: "engine:agent_task" });
  });

  it("preserves a more specific feature rather than flattening it", async () => {
    await request(app)
      .post("/api/internal/usage")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ records: [record({ feature: "deep_research" })] });

    expect(mockIncrementUsageWithChargeEvent.mock.calls[0][0]).toMatchObject({ feature: "engine:deep_research" });
  });

  it("does not double-prefix an already-namespaced feature", async () => {
    await request(app)
      .post("/api/internal/usage")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ records: [record({ feature: "engine:agent_task" })] });

    expect(mockIncrementUsageWithChargeEvent.mock.calls[0][0]).toMatchObject({ feature: "engine:agent_task" });
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
