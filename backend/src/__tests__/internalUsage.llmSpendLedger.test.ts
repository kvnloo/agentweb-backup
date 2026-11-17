/**
 * ENG-1934 — agent-engine LLM usage reaches the spend ledger.
 *
 * `/internal/usage` is the second LLM write path: engine batches never pass
 * through `recordUsage`'s transaction, they write aggregate + charge event in a
 * transaction of their own. Covering only `recordUsage` would leave every
 * browser-automation task's LLM spend off the ledger, and the §8 fidelity check
 * would then report it as unmirrored forever.
 */
import request from "supertest";
import express from "express";
import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET || "your-secret-key";

jest.mock("../middleware/auth", () => ({
  authenticateToken: (req: any, res: any, next: any) => {
    const header = req.headers.authorization || "";
    try {
      req.user = jwt.verify(header.replace(/^Bearer /, ""), JWT_SECRET);
      next();
    } catch {
      res.status(401).json({ message: "Unauthorized" });
    }
  },
}));

const mockRecordUsage = jest.fn().mockResolvedValue(undefined);
const mockTxn = jest.fn().mockResolvedValue("applied");

jest.mock("../services/usageRecorderService", () => ({
  ...jest.requireActual("../services/usageRecorderService"),
  recordUsage: (...args: unknown[]) => mockRecordUsage(...args),
}));
jest.mock("../services/tokenUsageService", () => ({
  resolveBillingUserId: (userId: string) => Promise.resolve(userId === "member-1" ? "owner-1" : userId),
}));
jest.mock("../services/usageRecordDb", () => ({
  usageRecordDb: {
    incrementUsageWithChargeEvent: (...args: unknown[]) => mockTxn(...args),
  },
}));

import internalUsageRoutes, { MAX_SPEND_EVENTS_PER_GROUP } from "../routes/internalUsage";
import { validateSpendEvent } from "../services/spendEventDb";
import { LLM_PRICE_BOOK_PROVENANCE } from "../utils/llmPricing";

const app = express();
app.use(express.json());
app.use("/api/internal", internalUsageRoutes);

const memberToken = jwt.sign({ userId: "member-1", email: "m@example.com" }, JWT_SECRET);

function record(over: Record<string, unknown> = {}) {
  return {
    model: "anthropic.claude-opus-5",
    provider: "bedrock",
    inputTokens: 1_000_000,
    outputTokens: 2_000,
    cacheReadTokens: 300,
    cacheWriteTokens: 40,
    ...over,
  };
}

const post = (body: object) =>
  request(app).post("/api/internal/usage").set("Authorization", `Bearer ${memberToken}`).send(body);

describe("POST /api/internal/usage → spend ledger (ENG-1934)", () => {
  const originalSwitch = process.env.SPEND_LEDGER_LLM_DUAL_WRITE;

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.SPEND_LEDGER_LLM_DUAL_WRITE;
    mockTxn.mockResolvedValue("applied");
  });

  afterAll(() => {
    if (originalSwitch === undefined) delete process.env.SPEND_LEDGER_LLM_DUAL_WRITE;
    else process.env.SPEND_LEDGER_LLM_DUAL_WRITE = originalSwitch;
  });

  it("AC1: the group's spend event rides the SAME transaction as its aggregate and charge event", async () => {
    const res = await post({ records: [record(), record({ taskId: "t2" })], reportId: "r-1" });

    expect(res.status).toBe(202);
    expect(mockTxn).toHaveBeenCalledTimes(1);
    const [increment, charge, events] = mockTxn.mock.calls[0];
    expect(events).toHaveLength(1);
    const [event] = events;

    expect(() => validateSpendEvent(event)).not.toThrow();
    expect(event).toMatchObject({
      billingUserId: "owner-1",
      actingUserId: "member-1",
      provider: "bedrock",
      operation: "anthropic.claude-opus-5",
      feature: increment.feature,
      lifecycle: "settled",
      costSource: "allocated",
    });
    // Same money on all three items.
    expect(event.costMicroUsd).toBe(increment.costMicroUsd);
    expect(event.costMicroUsd).toBe(charge.costMicroUsd);
    expect(event.occurredAt).toBe(charge.occurredAt);
  });

  it("AC2: token quantity is the group's total tokens across both records", async () => {
    await post({ records: [record(), record({ taskId: "t2" })], reportId: "r-1" });
    const [, charge, [event]] = mockTxn.mock.calls[0];

    expect(event.unit).toBe("llm_token");
    expect(event.quantity).toBe(2 * (1_000_000 + 2_000 + 300 + 40));
    expect(event.quantity).toBe(charge.tokens);
  });

  it("AC3: shares its charge event's id, so a resubmitted batch no-ops all three items together", async () => {
    await post({ records: [record()], reportId: "r-1" });
    await post({ records: [record()], reportId: "r-1" });

    const [, charge1, [event1]] = mockTxn.mock.calls[0];
    const [, charge2, [event2]] = mockTxn.mock.calls[1];
    expect(event1.eventId).toBe(`llm:${charge1.eventId}`);
    expect(event2.eventId).toBe(event1.eventId);
    expect(charge2.eventId).toBe(charge1.eventId);
  });

  it("AC4: a backend-priced group carries the price book's version", async () => {
    await post({ records: [record()], reportId: "r-1" });

    expect(mockTxn.mock.calls[0][2][0].rateCardVersion).toBe(LLM_PRICE_BOOK_PROVENANCE);
  });

  it("AC4: a group the ENGINE priced is attributed to the engine — on the event and on the fallback write", async () => {
    // A conflict the retries cannot settle, so the fallback runs.
    mockTxn.mockResolvedValue("conflict");

    await post({ records: [record({ costUsdOverride: 0.5 })], reportId: "r-1" });

    expect(mockTxn.mock.calls[0][2].map((e: any) => e.rateCardVersion)).toEqual(["caller:agent-engine"]);
    // The conflict fallback goes through recordUsage, which must say the same.
    expect(mockRecordUsage).toHaveBeenCalledTimes(1);
    expect(mockRecordUsage.mock.calls[0][0]).toMatchObject({ costProvenance: "caller:agent-engine" });
    // And pins the event instant to the same request instant as its date, so a
    // fallback write near midnight cannot split one call across two days.
    const fallbackCtx = mockRecordUsage.mock.calls[0][0];
    expect(fallbackCtx.occurredAt.slice(0, 10)).toBe(fallbackCtx.date);
    expect(fallbackCtx.occurredAt).toBe(mockTxn.mock.calls[0][1].occurredAt);
  });

  it("AC5: an unpriced model's group writes aggregate + charge, labels the aggregate unpriced, and writes no spend event", async () => {
    await post({ records: [record({ model: "model-nobody-priced" })], reportId: "r-1" });

    expect(mockTxn).toHaveBeenCalledTimes(1);
    expect(mockTxn.mock.calls[0]).toHaveLength(2);
    // ENG-700 on this path too: nobody priced it, so it is not a confirmed $0.
    expect(mockTxn.mock.calls[0][0].costSource).toBe("unpriced");
  });

  it("AC4: a group mixing book- and engine-priced records writes one event per portion, summing to the aggregate", async () => {
    await post({
      records: [record(), record({ taskId: "t2", costUsdOverride: 0.25 })],
      reportId: "r-1",
    });

    const [increment, charge, events] = mockTxn.mock.calls[0];
    expect(events.map((e: any) => [e.rateCardVersion, e.eventId])).toEqual([
      [LLM_PRICE_BOOK_PROVENANCE, `llm:${charge.eventId}`],
      ["caller:agent-engine", `llm:${charge.eventId}#engine`],
    ]);
    expect(events[1].costMicroUsd).toBe(250_000);
    expect(events[0].costMicroUsd + events[1].costMicroUsd).toBe(increment.costMicroUsd);
    const perRecordTokens = 1_000_000 + 2_000 + 300 + 40;
    expect(events.map((e: any) => e.quantity)).toEqual([perRecordTokens, perRecordTokens]);
  });

  it("AC1: one group served by two providers writes one event per provider, each under its own id, summing to the aggregate", async () => {
    await post({
      records: [record({ provider: "bedrock" }), record({ provider: "vertex", taskId: "t2", outputTokens: 7 })],
      reportId: "r-1",
    });

    const [increment, charge, events] = mockTxn.mock.calls[0];
    expect(events.map((e: any) => [e.provider, e.eventId])).toEqual([
      ["bedrock", `llm:${charge.eventId}`],
      ["vertex", `llm:${charge.eventId}@vertex`],
    ]);
    expect(new Set(events.map((e: any) => e.eventId)).size).toBe(2);
    expect(events.reduce((sum: number, e: any) => sum + e.costMicroUsd, 0)).toBe(increment.costMicroUsd);
    expect(events[1].quantity).toBe(1_000_000 + 7 + 300 + 40);
  });

  it("an image record the engine did not price is unpriced — no $0 'allocated' price-book event (CodeRabbit, PR #2904)", async () => {
    await post({
      records: [record({ model: "gpt-image-1", provider: "openai", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })],
      reportId: "r-1",
    });

    expect(mockTxn.mock.calls[0]).toHaveLength(2);
    expect(mockTxn.mock.calls[0][0].costSource).toBe("unpriced");
  });

  it("a group naming more providers than one transaction can hold collapses to one event per pricing source, still atomic and exact", async () => {
    const providers = Array.from({ length: MAX_SPEND_EVENTS_PER_GROUP + 5 }, (_, i) => `p${i}`);
    await post({
      records: [
        ...providers.map((provider, i) => record({ provider, taskId: `b${i}`, outputTokens: i })),
        ...providers.map((provider, i) => record({ provider, taskId: `e${i}`, costUsdOverride: 0.01 })),
      ],
      reportId: "r-1",
    });

    expect(mockTxn).toHaveBeenCalledTimes(1);
    const [increment, charge, events] = mockTxn.mock.calls[0];
    // 2 (aggregate + charge) + events stays far inside DynamoDB's 100-action limit.
    expect(events).toHaveLength(2);
    expect(events.map((e: any) => [e.provider, e.rateCardVersion, e.eventId])).toEqual([
      ["mixed", LLM_PRICE_BOOK_PROVENANCE, `llm:${charge.eventId}@mixed`],
      ["mixed", "caller:agent-engine", `llm:${charge.eventId}#engine@mixed`],
    ]);
    expect(events.reduce((sum: number, e: any) => sum + e.costMicroUsd, 0)).toBe(increment.costMicroUsd);
    expect(mockRecordUsage).not.toHaveBeenCalled();
  });

  it("AC5: an unknown model mixing engine-priced and unpriced records records ONLY the engine portion", async () => {
    await post({
      records: [
        record({ model: "model-nobody-priced" }),
        record({ model: "model-nobody-priced", taskId: "t2", costUsdOverride: 0.1 }),
      ],
      reportId: "r-1",
    });

    const [increment, , events] = mockTxn.mock.calls[0];
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ rateCardVersion: "caller:agent-engine", costMicroUsd: 100_000 });
    expect(events[0].quantity).toBe(1_000_000 + 2_000 + 300 + 40);
    expect(increment.costSource).toBe("allocated");
  });

  it("AC2: a batch of image generations records how many there were", async () => {
    await post({
      records: [1, 2, 3].map((n) =>
        record({ model: "gpt-image-1", provider: "openai", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsdOverride: 0.04, taskId: `t${n}` }),
      ),
      reportId: "r-1",
    });

    const [, , [event]] = mockTxn.mock.calls[0];
    expect(event).toMatchObject({ unit: "llm_generation", quantity: 3, costMicroUsd: 120_000 });
  });

  it("AC7: with the kill switch off the transaction is exactly the two items it was", async () => {
    process.env.SPEND_LEDGER_LLM_DUAL_WRITE = "false";

    await post({ records: [record()], reportId: "r-1" });

    expect(mockTxn.mock.calls[0]).toHaveLength(2);
  });
});
