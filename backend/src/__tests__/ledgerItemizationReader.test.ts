/**
 * ENG-1250 AC7 — per-charge itemization lines come from the spend ledger for ledger-covered months.
 *
 * Customer-visible billing explanation, so it is pinned: the adapter must not double-count against the
 * daily aggregate rows, must not leak non-LLM or unsettled spend, and must pick the right store by month.
 */
const listSpendEventsBoundedMock = jest.fn();
const listLlmChargeEventsMock = jest.fn();
jest.mock("../services/spendEventDb", () => ({
  listSpendEventsBounded: (...a: unknown[]) => listSpendEventsBoundedMock(...a),
}));
jest.mock("../services/llmChargeAuditDb", () => ({
  listLlmChargeEvents: (...a: unknown[]) => listLlmChargeEventsMock(...a),
}));

import {
  isLedgerCoveredMonth,
  readItemizationChargeEvents,
  spendEventsToChargeEvents,
} from "../services/ledgerItemizationReader";
import { reconcileItemizedUsage } from "../services/usageItemization";

const ev = (over: Record<string, unknown> = {}): any => ({
  billingUserId: "owner",
  eventId: "llm:abc",
  occurredAt: "2026-10-03T10:00:00.000Z",
  billingMonth: "2026-10",
  actingUserId: "member",
  provider: "anthropic",
  operation: "claude-sonnet-4-6",
  feature: "agent_task",
  unit: "llm_token",
  quantity: 1200,
  costMicroUsd: 4500,
  costSource: "allocated",
  rateCardVersion: "book-1",
  lifecycle: "settled",
  references: { sessionId: "sess-1" },
  ...over,
});

describe("isLedgerCoveredMonth", () => {
  it("is false for the month the LLM ledger started in and before; true after", () => {
    expect(isLedgerCoveredMonth("2026-08")).toBe(false);
    expect(isLedgerCoveredMonth("2026-09")).toBe(false); // started Sep 14: partial
    expect(isLedgerCoveredMonth("2026-10")).toBe(true);
    expect(isLedgerCoveredMonth("2027-01")).toBe(true);
  });
});

describe("spendEventsToChargeEvents", () => {
  it("maps a token event field-for-field, keeping the acting user (not the payer) for coverage netting", () => {
    expect(spendEventsToChargeEvents([ev()])).toEqual([
      expect.objectContaining({
        billingUserId: "owner",
        actingUserId: "member",
        model: "claude-sonnet-4-6",
        provider: "anthropic",
        feature: "agent_task",
        tokens: 1200,
        costMicroUsd: 4500,
        calls: 1,
        sessionId: "sess-1",
        occurredAt: "2026-10-03T10:00:00.000Z",
      }),
    ]);
  });

  it("a per-generation event carries no tokens and counts its generations as calls", () => {
    const [out] = spendEventsToChargeEvents([ev({ unit: "llm_generation", quantity: 3, operation: "veo-3" })]);
    expect(out).toMatchObject({ tokens: 0, calls: 3, model: "veo-3" });
  });

  it("drops non-LLM vendor spend and anything not settled", () => {
    const out = spendEventsToChargeEvents([
      ev({ eventId: "a" }),
      ev({ eventId: "b", unit: "email_send" }), // a vendor unit, not LLM
      ev({ eventId: "c", lifecycle: "reserved" }),
      ev({ eventId: "d", lifecycle: "voided" }),
    ]);
    expect(out.map((e) => e.eventId)).toEqual(["a"]);
  });

  it("never emits a negative cost or token count", () => {
    const [out] = spendEventsToChargeEvents([ev({ costMicroUsd: -5, quantity: -9 })]);
    expect(out.costMicroUsd).toBe(0);
    expect(out.tokens).toBe(0);
  });

  it("reconciles against the matching daily aggregate with NO double count and NO phantom remainder", () => {
    const events = spendEventsToChargeEvents([ev({ eventId: "a", quantity: 1000, costMicroUsd: 3000 }), ev({ eventId: "b", quantity: 500, costMicroUsd: 1500 })]);
    const row: any = {
      userId: "member", date: "2026-10-03", model: "claude-sonnet-4-6", feature: "agent_task", provider: "anthropic",
      costMicroUsd: 4500, totalTokens: 1500, callCount: 2,
    };

    const { items, precision } = reconcileItemizedUsage(events, [row]);

    expect(precision).toBe("per_charge");
    expect(items).toHaveLength(2);
    expect(items.reduce((s, i) => s + i.costMicroUsd, 0)).toBe(4500); // the bill, once
    expect(items.every((i) => i.source === "charge_event")).toBe(true);
  });

  it("an aggregate row with spend the ledger never saw still surfaces as the remainder", () => {
    const events = spendEventsToChargeEvents([ev({ costMicroUsd: 3000, quantity: 1000 })]);
    const row: any = {
      userId: "member", date: "2026-10-03", model: "claude-sonnet-4-6", feature: "agent_task", provider: "anthropic",
      costMicroUsd: 5000, totalTokens: 1800, callCount: 2,
    };

    const { items, precision } = reconcileItemizedUsage(events, [row]);

    expect(precision).toBe("mixed");
    expect(items.reduce((s, i) => s + i.costMicroUsd, 0)).toBe(5000);
  });
});

describe("readItemizationChargeEvents", () => {
  beforeEach(() => {
    listSpendEventsBoundedMock.mockReset();
    listLlmChargeEventsMock.mockReset();
  });

  it("reads the LEDGER for a covered month (and never the charge-event table)", async () => {
    listSpendEventsBoundedMock.mockResolvedValue({ events: [ev()], exceeded: false });

    const out = await readItemizationChargeEvents("owner", "2026-10");

    expect(out).toHaveLength(1);
    expect(listSpendEventsBoundedMock).toHaveBeenCalledWith("owner", "2026-10-01", "2026-10-31", 50_000);
    expect(listLlmChargeEventsMock).not.toHaveBeenCalled();
  });

  it("reads the CHARGE-EVENT table for September and earlier (the ledger is partial then)", async () => {
    listLlmChargeEventsMock.mockResolvedValue([{ eventId: "x" }]);

    const out = await readItemizationChargeEvents("owner", "2026-09");

    expect(out).toEqual([{ eventId: "x" }]);
    expect(listLlmChargeEventsMock).toHaveBeenCalledWith("owner", "2026-09-01", "2026-09-31");
    expect(listSpendEventsBoundedMock).not.toHaveBeenCalled();
  });

  it("degrades to NO per-charge events (daily aggregate only) when the ledger read exceeds its budget", async () => {
    listSpendEventsBoundedMock.mockResolvedValue({ events: [ev()], exceeded: true });
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});

    const out = await readItemizationChargeEvents("owner", "2026-10");

    expect(out).toEqual([]); // not truncated, not an error
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("propagates a ledger read failure (the route returns 500, never a silently empty bill)", async () => {
    listSpendEventsBoundedMock.mockRejectedValue(new Error("dynamo down"));
    await expect(readItemizationChargeEvents("owner", "2026-10")).rejects.toThrow("dynamo down");
  });
});
