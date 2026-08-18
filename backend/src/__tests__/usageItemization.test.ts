import { reconcileItemizedUsage } from "../services/usageItemization";
import type { LlmChargeAuditEvent } from "../services/llmChargeAuditDb";
import type { UsageRecordRow } from "../services/usageRecordDb";

const event = (overrides: Partial<LlmChargeAuditEvent> = {}): LlmChargeAuditEvent => ({
  billingUserId: "bill-1",
  eventId: "evt-1",
  occurredAt: "2026-08-15T10:00:00.000Z",
  // Matches row()'s default userId: "bill-1" -- the common non-pooled case,
  // where the acting user and the billing owner are the same person.
  // Coverage is scoped by actingUserId, so a test exercising pooled/
  // cross-actor behavior must override this explicitly on both sides.
  actingUserId: "bill-1",
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
  it("nets a slot's coverage ONCE when the day holds an old- and new-format row", () => {
    // The deploy-day case for the payer sort-key change. A day that was already
    // accumulating under `date#model#feature` stops there and a new row starts at
    // `date#model#feature#payer`. Same actor, same day, same slot, SAME payer --
    // two rows where there used to be one.
    //
    // Coverage is per SLOT, not per row. Subtracting it from each row
    // independently removes it twice and understates the bill -- and an
    // undercount is invisible to the customer, which is what makes it the
    // dangerous direction. This is the one real hazard the key change introduces,
    // and it lasts exactly as long as a cycle contains rows of both formats.
    const events = [event({ billingUserId: "bill-1", actingUserId: "actor-1", costMicroUsd: 3000 })];
    const rows = [
      row({ userId: "actor-1", billingUserId: "bill-1", costMicroUsd: 5000,
            sk: "2026-08-15#gpt-4o#chat" }),
      row({ userId: "actor-1", billingUserId: "bill-1", costMicroUsd: 4000,
            sk: "2026-08-15#gpt-4o#chat#bill-1" }),
    ];

    const result = reconcileItemizedUsage(events, rows);
    const total = result.items.reduce((sum, i) => sum + i.costMicroUsd, 0);

    // Aggregates total 9000, of which 3000 is already itemised as a charge event.
    // Correct total = 3000 (event) + (9000 - 3000) = 9000.
    expect(total).toBe(9000);
  });

  it("does not apply one payer's coverage to another payer's row for the same slot", () => {
    // ENG-1210 (Greptile, PR #2407). Since the payer became part of the aggregate
    // row's sort key, a billing transition mid-day yields TWO rows for one
    // (actor, date, model, feature) slot. Read from the subject's own partition,
    // both come back.
    //
    // Keyed without the payer they would hash together, and the coverage from
    // owner-1's charge event would be subtracted from owner-2's row as well --
    // understating the bill by a full day's coverage. An undercount is invisible
    // to the customer, which is what makes it the dangerous direction.
    const events = [event({ billingUserId: "bill-1", actingUserId: "actor-1", costMicroUsd: 5000 })];
    const rows = [
      row({ userId: "actor-1", billingUserId: "bill-1", costMicroUsd: 5000,
            sk: "2026-08-15#gpt-4o#chat#bill-1" }),
      row({ userId: "actor-1", billingUserId: "bill-2", costMicroUsd: 7000,
            sk: "2026-08-15#gpt-4o#chat#bill-2" }),
    ];

    const result = reconcileItemizedUsage(events, rows);
    const total = result.items.reduce((sum, i) => sum + i.costMicroUsd, 0);

    // bill-1's row is fully covered by its charge event (5000 - 5000 = 0), and
    // bill-2's row is untouched by it. The event itself contributes 5000.
    expect(total).toBe(5000 + 7000);
  });

  it("still nets a row against coverage from its OWN payer", () => {
    // The scoping must not go so far that legitimate coverage stops matching --
    // that would double-count, which is the opposite failure.
    const events = [event({ billingUserId: "bill-1", actingUserId: "actor-1", costMicroUsd: 5000 })];
    const rows = [
      row({ userId: "actor-1", billingUserId: "bill-1", costMicroUsd: 5000,
            sk: "2026-08-15#gpt-4o#chat#bill-1" }),
    ];

    const result = reconcileItemizedUsage(events, rows);
    const total = result.items.reduce((sum, i) => sum + i.costMicroUsd, 0);
    expect(total).toBe(5000);
  });

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

  it("ENG-1251 Greptile P1: a batch-charge event's own call count is used, not hardcoded 1", () => {
    // internalUsage.ts sums an engine batch into ONE charge event per
    // (user, model, feature) -- that event can represent several calls,
    // not one. Both the event's own displayed `calls` and the coverage
    // subtracted from its aggregate row must reflect the true count.
    const result = reconcileItemizedUsage(
      [event({ tokens: 300, costMicroUsd: 5000, calls: 3 })],
      [row({ totalTokens: 500, costMicroUsd: 8000, callCount: 5 })]
    );
    const chargeItem = result.items.find((i) => i.source === "charge_event");
    expect(chargeItem).toEqual(expect.objectContaining({ calls: 3, tokens: 300 }));

    const aggregateItem = result.items.find((i) => i.source === "daily_aggregate");
    // 5 total calls - 3 covered by the batch event = 2 uncovered, not 4
    // (which is what a hardcoded calls:1 would have produced).
    expect(aggregateItem).toEqual(expect.objectContaining({ calls: 2, tokens: 200 }));
  });

  it("treats a charge event with no `calls` field (pre-existing data, or a single-call caller) as exactly 1 call", () => {
    const result = reconcileItemizedUsage(
      [event({ tokens: 100, costMicroUsd: 5000 })], // no `calls` field
      [row({ totalTokens: 300, costMicroUsd: 15000, callCount: 3 })]
    );
    const chargeItem = result.items.find((i) => i.source === "charge_event");
    expect(chargeItem?.calls).toBe(1);
    const aggregateItem = result.items.find((i) => i.source === "daily_aggregate");
    expect(aggregateItem?.calls).toBe(2);
  });

  it("ENG-1251 Greptile P1: does not let one pooled member's charge-event coverage suppress ANOTHER member's aggregate row on the same (date, model, feature)", () => {
    // Two org members pooled onto the same billing owner both use gpt-4o
    // for chat on the same day. member-A is fully covered by a charge
    // event; member-B has aggregate-only usage with NO event at all.
    // Coverage must be scoped per acting user -- if it weren't, member-A's
    // coverage would incorrectly suppress member-B's real, uncovered usage.
    const result = reconcileItemizedUsage(
      [event({ actingUserId: "member-A", tokens: 100, costMicroUsd: 5000 })],
      [
        row({ userId: "member-A", totalTokens: 100, costMicroUsd: 5000, callCount: 1 }),
        row({ userId: "member-B", totalTokens: 300, costMicroUsd: 9000, callCount: 3 }),
      ]
    );

    expect(result.items).toHaveLength(2);
    const memberBItem = result.items.find(
      (i) => i.source === "daily_aggregate"
    );
    // member-B's row shows IN FULL -- not suppressed by member-A's coverage,
    // and not incorrectly reduced by it either.
    expect(memberBItem).toEqual(
      expect.objectContaining({ tokens: 300, calls: 3, costMicroUsd: 9000 })
    );
  });

  it("ENG-1251 Greptile P1: two pooled members' PARTIAL coverage on the same (date, model, feature) resolve independently, not summed across both", () => {
    const result = reconcileItemizedUsage(
      [
        event({ actingUserId: "member-A", tokens: 100, costMicroUsd: 5000 }),
        event({ actingUserId: "member-B", tokens: 50, costMicroUsd: 2000 }),
      ],
      [
        row({ userId: "member-A", totalTokens: 400, costMicroUsd: 20000, callCount: 4 }),
        row({ userId: "member-B", totalTokens: 200, costMicroUsd: 8000, callCount: 2 }),
      ]
    );

    const aggregateItems = result.items.filter((i) => i.source === "daily_aggregate");
    expect(aggregateItems).toHaveLength(2);
    // member-A's remainder uses ONLY member-A's coverage (100 tokens), not
    // both members' coverage summed (150).
    const memberARemainder = aggregateItems.find((i) => i.tokens === 300);
    expect(memberARemainder).toBeDefined();
    // member-B's remainder uses ONLY member-B's coverage (50 tokens).
    const memberBRemainder = aggregateItems.find((i) => i.tokens === 150);
    expect(memberBRemainder).toBeDefined();
  });
});
