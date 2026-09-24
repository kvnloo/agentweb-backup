/**
 * ENG-1250 F5 — the projection maintenance items (settledProjectionUpdateItems).
 *
 * Billing-critical invariants, so retained: the projection update rides in the
 * SAME transaction as the settled spend events, as an atomic ADD on
 * settledMicroUsd/settledEventCount only (never a whole-item put, never touching
 * reserved/available/allowance), grouped by subject+month (one item per group,
 * since a transaction may not touch an item twice), UNCONDITIONAL (a failing
 * condition would abort the charge), and empty when the kill switch is off.
 */
import {
  settledProjectionUpdateItems,
  SPEND_PROJECTION_TABLE,
  SPEND_PROJECTION_WRITER_ENV,
} from "../services/spendProjectionDb";
import { SpendEvent } from "../services/spendEventDb";

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

describe("settledProjectionUpdateItems", () => {
  const savedEnv = { ...process.env };
  beforeEach(() => {
    delete process.env[SPEND_PROJECTION_WRITER_ENV];
  });
  afterAll(() => {
    process.env = savedEnv;
  });

  it("folds settled events into ONE atomic-ADD Update item per subject+month, restamping computedAt", () => {
    const items = settledProjectionUpdateItems([settled({ costMicroUsd: 1000 }), settled({ costMicroUsd: 2500 })], NOW);

    expect(items).toHaveLength(1);
    const u = items[0].Update!;
    expect(u.TableName).toBe(SPEND_PROJECTION_TABLE);
    expect(u.Key).toEqual({ billingUserId: "user-1", billingMonth: "2026-09" });
    // ADD settled + count, SET computedAt — and NOTHING else. The no-clobber
    // invariant: reserved/available/allowance are never written here.
    expect(u.UpdateExpression).toBe("SET computedAt = :now ADD settledMicroUsd :m, settledEventCount :c");
    expect(u.UpdateExpression).not.toMatch(/reserved|available|usable/i);
    expect(u.ExpressionAttributeValues).toEqual({ ":now": NOW, ":m": 3500, ":c": 2 });
  });

  it("is UNCONDITIONAL — no ConditionExpression that could abort the charging transaction", () => {
    const items = settledProjectionUpdateItems([settled()], NOW);
    expect(items[0].Update!.ConditionExpression).toBeUndefined();
  });

  it("ignores reserved and voided events (only settled moves settledMicroUsd)", () => {
    const items = settledProjectionUpdateItems(
      [settled({ lifecycle: "reserved", costMicroUsd: 9999 }), settled({ lifecycle: "voided", costMicroUsd: 8888 })],
      NOW,
    );
    expect(items).toEqual([]);
  });

  it("groups a mixed batch by subject and by month (one item each — a txn can't touch an item twice)", () => {
    const items = settledProjectionUpdateItems(
      [
        settled({ billingUserId: "a", billingMonth: "2026-09", costMicroUsd: 100 }),
        settled({ billingUserId: "a", billingMonth: "2026-09", costMicroUsd: 200 }),
        settled({ billingUserId: "b", billingMonth: "2026-09", costMicroUsd: 50 }),
        settled({ billingUserId: "a", billingMonth: "2026-10", occurredAt: "2026-10-01T00:00:00.000Z", costMicroUsd: 7 }),
      ],
      NOW,
    );
    expect(items).toHaveLength(3);
    const byKey = Object.fromEntries(
      items.map((it) => [`${it.Update!.Key.billingUserId}/${it.Update!.Key.billingMonth}`, it.Update!.ExpressionAttributeValues]),
    );
    expect(byKey["a/2026-09"]).toMatchObject({ ":m": 300, ":c": 2 });
    expect(byKey["b/2026-09"]).toMatchObject({ ":m": 50, ":c": 1 });
    expect(byKey["a/2026-10"]).toMatchObject({ ":m": 7, ":c": 1 });
  });

  it("returns [] when the kill switch is off (transaction stays exactly its ledger+event items)", () => {
    process.env[SPEND_PROJECTION_WRITER_ENV] = "false";
    expect(settledProjectionUpdateItems([settled()], NOW)).toEqual([]);
  });

  it("returns [] on an empty batch", () => {
    expect(settledProjectionUpdateItems([], NOW)).toEqual([]);
  });

  it("skips events with a bad month (would land in the wrong bucket)", () => {
    expect(settledProjectionUpdateItems([settled({ billingMonth: "2026-13" })], NOW)).toEqual([]);
  });
});
