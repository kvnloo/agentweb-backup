/**
 * ENG-1250 §3b — the event-driven projection writer (applySettledSpendEvents).
 *
 * Billing-critical invariants, so retained: the hot path maintains ONLY
 * settledMicroUsd via an atomic ADD (never a whole-item put, never touching
 * reserved/available), groups by subject+month, honors its kill switch, and can
 * never throw into the charging transaction it rides behind.
 */
jest.mock("aws-sdk", () => {
  const update = jest.fn(() => ({ promise: () => Promise.resolve({}) }));
  const mockDynamoDB = { put: jest.fn(), get: jest.fn(), update };
  return { DynamoDB: { DocumentClient: jest.fn(() => mockDynamoDB) }, config: { update: jest.fn() } };
});

import AWS from "aws-sdk";
import {
  applySettledSpendEvents,
  SPEND_PROJECTION_TABLE,
  SPEND_PROJECTION_WRITER_ENV,
} from "../services/spendProjectionDb";
import { SpendEvent } from "../services/spendEventDb";

const mockDynamoDB = new (AWS.DynamoDB.DocumentClient as any)();
const updateMock = mockDynamoDB.update as jest.Mock;

const NOW = "2026-09-21T10:00:00.000Z";

function settled(over: Partial<SpendEvent> = {}): SpendEvent {
  return {
    billingUserId: "user-1",
    eventId: `e:${Math.random()}`,
    occurredAt: "2026-09-21T09:00:00.000Z",
    billingMonth: "2026-09",
    actingUserId: "user-1",
    provider: "openai",
    operation: "gpt-5.5",
    unit: "llm_token",
    quantity: 100,
    costMicroUsd: 1000,
    costSource: "allocated",
    rateCardVersion: "book@1",
    lifecycle: "settled",
    ...over,
  };
}

describe("applySettledSpendEvents", () => {
  const savedEnv = { ...process.env };
  beforeEach(() => {
    updateMock.mockClear();
    updateMock.mockImplementation(() => ({ promise: () => Promise.resolve({}) }));
    delete process.env[SPEND_PROJECTION_WRITER_ENV];
  });
  afterAll(() => {
    process.env = savedEnv;
  });

  it("folds settled events into ONE atomic ADD per subject+month, restamping computedAt", async () => {
    await applySettledSpendEvents([settled({ costMicroUsd: 1000 }), settled({ costMicroUsd: 2500 })], NOW);

    expect(updateMock).toHaveBeenCalledTimes(1);
    const arg = updateMock.mock.calls[0][0];
    expect(arg.TableName).toBe(SPEND_PROJECTION_TABLE);
    expect(arg.Key).toEqual({ billingUserId: "user-1", billingMonth: "2026-09" });
    // ADD settled + count, SET computedAt — and NOTHING else. This is the
    // no-clobber invariant: reserved/available/allowance are never written here.
    expect(arg.UpdateExpression).toBe("SET computedAt = :now ADD settledMicroUsd :m, settledEventCount :c");
    expect(arg.UpdateExpression).not.toMatch(/reserved|available|usable/i);
    expect(arg.ExpressionAttributeValues).toEqual({ ":now": NOW, ":m": 3500, ":c": 2 });
  });

  it("ignores reserved and voided events (only settled moves settledMicroUsd)", async () => {
    await applySettledSpendEvents(
      [settled({ lifecycle: "reserved", costMicroUsd: 9999 }), settled({ lifecycle: "voided", costMicroUsd: 8888 })],
      NOW,
    );
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("groups a mixed batch by subject and by month", async () => {
    await applySettledSpendEvents(
      [
        settled({ billingUserId: "a", billingMonth: "2026-09", costMicroUsd: 100 }),
        settled({ billingUserId: "a", billingMonth: "2026-09", costMicroUsd: 200 }),
        settled({ billingUserId: "b", billingMonth: "2026-09", costMicroUsd: 50 }),
        settled({ billingUserId: "a", billingMonth: "2026-10", occurredAt: "2026-10-01T00:00:00.000Z", costMicroUsd: 7 }),
      ],
      NOW,
    );
    expect(updateMock).toHaveBeenCalledTimes(3);
    const byKey = Object.fromEntries(
      updateMock.mock.calls.map((c) => [`${c[0].Key.billingUserId}/${c[0].Key.billingMonth}`, c[0].ExpressionAttributeValues]),
    );
    expect(byKey["a/2026-09"]).toMatchObject({ ":m": 300, ":c": 2 });
    expect(byKey["b/2026-09"]).toMatchObject({ ":m": 50, ":c": 1 });
    expect(byKey["a/2026-10"]).toMatchObject({ ":m": 7, ":c": 1 });
  });

  it("does nothing when the kill switch is off", async () => {
    process.env[SPEND_PROJECTION_WRITER_ENV] = "false";
    await applySettledSpendEvents([settled()], NOW);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("never throws when the projection write fails — the charging path must survive", async () => {
    updateMock.mockImplementation(() => ({ promise: () => Promise.reject(new Error("dynamo down")) }));
    const err = jest.spyOn(console, "error").mockImplementation(() => {});
    await expect(applySettledSpendEvents([settled()], NOW)).resolves.toBeUndefined();
    err.mockRestore();
  });

  it("no-ops on an empty batch", async () => {
    await applySettledSpendEvents([], NOW);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("guards computedAt forward-only: an older now never clobbers a newer stamp, but settled/count still land", async () => {
    // The guarded SET+ADD fails the computedAt<=:now condition (a newer stamp is
    // present); the retry must be ADD-only so the settled delta is never dropped.
    updateMock
      .mockImplementationOnce(() => ({
        promise: () => Promise.reject(Object.assign(new Error("cond"), { code: "ConditionalCheckFailedException" })),
      }))
      .mockImplementationOnce(() => ({ promise: () => Promise.resolve({}) }));

    await applySettledSpendEvents([settled({ costMicroUsd: 500 })], "2020-01-01T00:00:00.000Z");

    expect(updateMock).toHaveBeenCalledTimes(2);
    const guarded = updateMock.mock.calls[0][0];
    expect(guarded.UpdateExpression).toBe("SET computedAt = :now ADD settledMicroUsd :m, settledEventCount :c");
    expect(guarded.ConditionExpression).toBe("attribute_not_exists(computedAt) OR computedAt <= :now");
    const addOnly = updateMock.mock.calls[1][0];
    expect(addOnly.UpdateExpression).toBe("ADD settledMicroUsd :m, settledEventCount :c");
    expect(addOnly.UpdateExpression).not.toContain("computedAt");
    expect(addOnly.ConditionExpression).toBeUndefined();
    expect(addOnly.ExpressionAttributeValues).toEqual({ ":m": 500, ":c": 1 });
  });

  it("stays never-throws even if the ADD-only fallback also fails", async () => {
    updateMock
      .mockImplementationOnce(() => ({
        promise: () => Promise.reject(Object.assign(new Error("cond"), { code: "ConditionalCheckFailedException" })),
      }))
      .mockImplementationOnce(() => ({ promise: () => Promise.reject(new Error("dynamo down")) }));
    const err = jest.spyOn(console, "error").mockImplementation(() => {});
    await expect(applySettledSpendEvents([settled()], "2020-01-01T00:00:00.000Z")).resolves.toBeUndefined();
    err.mockRestore();
  });
});
