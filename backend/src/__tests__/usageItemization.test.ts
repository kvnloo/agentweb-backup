import { reconcileItemizedUsage } from "../services/usageItemization";
import type { LlmChargeAuditEvent } from "../services/llmChargeAuditDb";
import type { UsageRecordRow } from "../services/usageRecordDb";

const event = (overrides: Partial<LlmChargeAuditEvent> = {}): LlmChargeAuditEvent => ({
  billingUserId: "bill-1",
  eventId: "evt-1",
  occurredAt: "2026-08-15T10:00:00.000Z",
  actingUserId: "user-1",
  tokens: 100,
  costMicroUsd: 5000,
  model: "gpt-4o",
  feature: "chat",
  provider: "azure-openai",
  ...overrides,
});

const row = (overrides: Partial<UsageRecordRow> = {}): UsageRecordRow => ({
  userId: "bill-1",
  sk: "2026-08-15#gpt-4o#chat",
  date: "2026-08-15",
  model: "gpt-4o",
  feature: "chat",
  totalTokens: 100,
  costMicroUsd: 5000,
  callCount: 1,
  billingUserId: "bill-1",
  updatedAt: "2026-08-15T10:00:00.000Z",
  ttl: 0,
  ...overrides,
});

describe("reconcileItemizedUsage", () => {
  it("shows the aggregate row in full when no charge events touch its key", () => {
    const result = reconcileItemizedUsage([], [row()]);
    expect(result.items).toEqual([
      expect.objectContaining({ tokens: 100, calls: 1, costMicroUsd: 5000, source: "daily_aggregate" }),
    ]);
    expect(result.precision).toBe("daily_aggregate");
  });

  it("suppresses the aggregate row entirely when fully covered on every dimension", () => {
    const result = reconcileItemizedUsage(
      [event({ tokens: 100, costMicroUsd: 5000 })],
      [row({ totalTokens: 100, costMicroUsd: 5000, callCount: 1 })]
    );
    // Only the charge event shows; the aggregate contributes nothing.
    expect(result.items).toHaveLength(1);
    expect(result.items[0].source).toBe("charge_event");
    expect(result.precision).toBe("per_charge");
  });

  it("shows the exact uncovered remainder when only some calls in the row are covered", () => {
    // 3 calls that day for this key, 300 tokens, $15000 total; 1 of the 3 is charged.
    const result = reconcileItemizedUsage(
      [event({ tokens: 100, costMicroUsd: 5000 })],
      [row({ totalTokens: 300, costMicroUsd: 15000, callCount: 3 })]
    );
    const aggregateItem = result.items.find((i) => i.source === "daily_aggregate");
    expect(aggregateItem).toEqual(
      expect.objectContaining({ tokens: 200, calls: 2, costMicroUsd: 10000 })
    );
    expect(result.precision).toBe("mixed");
  });

  it("ENG-1251 regression: a $0 event does not hide the OTHER uncovered $0 calls in the same aggregate row", () => {
    // Unpriced model: 5 calls that day, all $0 cost, 500 tokens total. Only 2
    // of the 5 calls got a charge event recorded (also $0, since unpriced).
    // Dollar-only coverage reads this as "fully covered" (0 - 0 = 0) and used
    // to drop the whole row, silently discarding the other 3 calls' tokens.
    const events = [
      event({ tokens: 100, costMicroUsd: 0, occurredAt: "2026-08-15T09:00:00.000Z" }),
      event({ tokens: 100, costMicroUsd: 0, occurredAt: "2026-08-15T09:05:00.000Z" }),
    ];
    const result = reconcileItemizedUsage(events, [row({ totalTokens: 500, costMicroUsd: 0, callCount: 5 })]);
    const aggregateItem = result.items.find((i) => i.source === "daily_aggregate");
    expect(aggregateItem).toEqual(
      expect.objectContaining({ tokens: 300, calls: 3, costMicroUsd: 0 })
    );
  });

  it("suppresses a $0 aggregate row only when charge events cover every call, not just when their dollar sum is $0", () => {
    const events = [
      event({ tokens: 100, costMicroUsd: 0, occurredAt: "2026-08-15T09:00:00.000Z" }),
      event({ tokens: 100, costMicroUsd: 0, occurredAt: "2026-08-15T09:05:00.000Z" }),
    ];
    const result = reconcileItemizedUsage(events, [row({ totalTokens: 200, costMicroUsd: 0, callCount: 2 })]);
    expect(result.items.filter((i) => i.source === "daily_aggregate")).toHaveLength(0);
    expect(result.items).toHaveLength(2);
  });

  it("never emits a negative remainder if charge-event coverage momentarily exceeds the aggregate (clamped to 0)", () => {
    // Defensive: aggregate and charge-event tables are written independently.
    const result = reconcileItemizedUsage(
      [event({ tokens: 150, costMicroUsd: 6000 })],
      [row({ totalTokens: 100, costMicroUsd: 5000, callCount: 1 })]
    );
    const aggregateItem = result.items.find((i) => i.source === "daily_aggregate");
    expect(aggregateItem).toBeUndefined();
  });

  it("mixes charge_event and daily_aggregate items and reports precision: mixed", () => {
    const result = reconcileItemizedUsage(
      [event({ occurredAt: "2026-08-15T10:00:00.000Z", model: "gpt-4o", feature: "chat" })],
      [row({ date: "2026-08-14", model: "claude-sonnet-4-6", feature: "agent_mode", totalTokens: 50, costMicroUsd: 2000, callCount: 1 })]
    );
    expect(result.precision).toBe("mixed");
    expect(result.items.map((i) => i.source).sort()).toEqual(["charge_event", "daily_aggregate"]);
  });

  it("sorts items by date descending, then cost descending within a date", () => {
    const result = reconcileItemizedUsage(
      [
        event({ occurredAt: "2026-08-14T10:00:00.000Z", costMicroUsd: 1000 }),
        event({ occurredAt: "2026-08-15T10:00:00.000Z", costMicroUsd: 9000, model: "gpt-4o-2" }),
      ],
      [row({ date: "2026-08-15", model: "claude-sonnet-4-6", costMicroUsd: 3000, totalTokens: 10, callCount: 1 })]
    );
    expect(result.items.map((i) => `${i.date.slice(0, 10)}:${i.costMicroUsd}`)).toEqual([
      "2026-08-15:9000",
      "2026-08-15:3000",
      "2026-08-14:1000",
    ]);
  });

  it("reports precision: daily_aggregate when there are no charge events at all", () => {
    const result = reconcileItemizedUsage([], [row(), row({ date: "2026-08-14" })]);
    expect(result.precision).toBe("daily_aggregate");
  });
});
