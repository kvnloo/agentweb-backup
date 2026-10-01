/**
 * ENG-1250 §3b backfill — optimistic-concurrency write path (F2).
 *
 * Billing-critical: the backfill must not revert the event-driven writer's
 * settled ADDs. It reads strongly consistent, writes only if the row is
 * unchanged, and on a conflict (or a lagging event list) re-derives from a fresh
 * read and retries — never re-using the stale snapshot.
 */
jest.mock("../services/spendProjectionDb", () => ({
  getProjection: jest.fn(),
  putProjectionIfUnchanged: jest.fn(),
  reconcilePersistedProjection: jest.fn(() => ({ ok: true, driftMicroUsd: 0, missing: false, persistedSettledMicroUsd: 0, derivedSettledMicroUsd: 0 })),
  PERSISTED_PROJECTION_TOLERANCE_MICRO_USD: 1,
}));
jest.mock("../services/spendEventDb", () => ({ SPEND_EVENTS_TABLE: "AW-SpendEvents", listSpendEvents: jest.fn() }));
jest.mock("../services/db", () => ({ userDb: { getUserById: jest.fn() } }));
jest.mock("../services/subscriptionService", () => ({ getSubscriptionTypeConfig: jest.fn() }));
jest.mock("../services/llmUsageCreditService", () => ({ getLlmUsageCreditAdjustment: jest.fn() }));

import { persistSubjectProjection, allowanceFor } from "../scripts/spendProjectionBackfill";
import { getProjection, putProjectionIfUnchanged } from "../services/spendProjectionDb";
import { listSpendEvents, SpendEvent } from "../services/spendEventDb";
import { AllowanceInputs } from "../services/spendProjection";
import { userDb } from "../services/db";
import { getSubscriptionTypeConfig } from "../services/subscriptionService";
import { getLlmUsageCreditAdjustment } from "../services/llmUsageCreditService";

const getProjectionMock = getProjection as jest.Mock;
const putMock = putProjectionIfUnchanged as jest.Mock;
const listMock = listSpendEvents as jest.Mock;
const getUserMock = userDb.getUserById as jest.Mock;
const getConfigMock = getSubscriptionTypeConfig as jest.Mock;
const getCreditMock = getLlmUsageCreditAdjustment as jest.Mock;

const U = "u1";
const M = "2026-09";
const allowance: AllowanceInputs = { includedAllowanceMicroUsd: 150_000_000, unlimited: false };

function ev(costMicroUsd: number, i = Math.random()): SpendEvent {
  return {
    billingUserId: U,
    eventId: `e:${i}`,
    occurredAt: "2026-09-10T00:00:00.000Z",
    billingMonth: M,
    actingUserId: U,
    provider: "openai",
    operation: "gpt-5.5",
    unit: "llm_token",
    quantity: 1,
    costMicroUsd,
    costSource: "allocated",
    rateCardVersion: "book@1",
    lifecycle: "settled",
  };
}
const row = (settledMicroUsd: number, settledEventCount: number) => ({ settledMicroUsd, settledEventCount });

describe("persistSubjectProjection (F2 optimistic concurrency)", () => {
  beforeEach(() => {
    getProjectionMock.mockReset();
    putMock.mockReset();
    listMock.mockReset();
  });

  it("writes once when the row is unchanged since the consistent read", async () => {
    getProjectionMock
      .mockResolvedValueOnce(row(1000, 1)) // observe
      .mockResolvedValueOnce(row(1000, 1)); // verify
    putMock.mockResolvedValueOnce({ written: true, item: {} });

    const res = await persistSubjectProjection(U, M, allowance, [ev(1000)]);

    expect(res.attempts).toBe(1);
    expect(putMock).toHaveBeenCalledTimes(1);
    expect(listMock).not.toHaveBeenCalled();
    // Both reads were strongly consistent.
    expect(getProjectionMock).toHaveBeenNthCalledWith(1, U, M, true);
  });

  it("on a conditional miss, re-derives from a FRESH read and retries — never the stale snapshot", async () => {
    getProjectionMock
      .mockResolvedValueOnce(row(1000, 1)) // attempt 1 observe
      .mockResolvedValueOnce(row(1100, 2)) // attempt 2 observe (writer added 100 meanwhile)
      .mockResolvedValueOnce(row(1100, 2)); // attempt 2 verify
    putMock
      .mockResolvedValueOnce({ written: false, item: {} }) // conflict
      .mockResolvedValueOnce({ written: true, item: {} }); // succeeds after re-derive
    listMock.mockResolvedValueOnce([ev(1000), ev(100)]); // fresh events now include the new one

    const res = await persistSubjectProjection(U, M, allowance, [ev(1000)]);

    expect(res.attempts).toBe(2);
    expect(res.settledMicroUsd).toBe(1100); // wrote the fresh total, not the stale 1000
    expect(putMock).toHaveBeenCalledTimes(2);
    expect(listMock).toHaveBeenCalledTimes(1); // re-derived exactly once
  });

  it("does NOT write when its event list lags the row (would revert spend); re-derives instead", async () => {
    // Row already holds 2000 (writer ahead of our GSI list, which only sums 1000).
    getProjectionMock
      .mockResolvedValueOnce(row(2000, 2)) // attempt 1 observe — projection(1000) < 2000
      .mockResolvedValueOnce(row(2000, 2)) // attempt 2 observe, now our list caught up
      .mockResolvedValueOnce(row(2000, 2)); // verify
    listMock.mockResolvedValueOnce([ev(1000), ev(1000)]); // fresh list now sums 2000
    putMock.mockResolvedValueOnce({ written: true, item: {} });

    const res = await persistSubjectProjection(U, M, allowance, [ev(1000)]);

    // Attempt 1 must NOT have called put (guard tripped); only attempt 2 writes.
    expect(putMock).toHaveBeenCalledTimes(1);
    expect(res.settledMicroUsd).toBe(2000);
    expect(listMock).toHaveBeenCalledTimes(1);
  });

  it("gives up after the bounded attempts rather than looping forever", async () => {
    getProjectionMock.mockResolvedValue(row(1000, 1));
    putMock.mockResolvedValue({ written: false, item: {} }); // always conflicts
    listMock.mockResolvedValue([ev(1000)]);

    await expect(persistSubjectProjection(U, M, allowance, [ev(1000)], 3)).rejects.toThrow(/could not converge/);
    expect(putMock).toHaveBeenCalledTimes(3);
  });
});

describe("allowanceFor — fail loud on unresolvable inputs (the 2026-09-21 near-miss)", () => {
  beforeEach(() => {
    getUserMock.mockReset();
    getConfigMock.mockReset();
    getCreditMock.mockReset();
    getCreditMock.mockReturnValue({ purchasedMicroUsd: 0, adminGrantedMicroUsd: 0, migrationOffsetMicroUsd: 0 });
  });

  it("THROWS when the user cannot be read (does not silently seed 'unlimited')", async () => {
    getUserMock.mockResolvedValue(null);
    await expect(allowanceFor(U, M)).rejects.toThrow(/user not found/i);
    expect(getConfigMock).not.toHaveBeenCalled();
  });

  it("THROWS when the user has no subscriptionType", async () => {
    getUserMock.mockResolvedValue({ subscriptionType: undefined });
    await expect(allowanceFor(U, M)).rejects.toThrow(/no subscriptionType/i);
  });

  it("THROWS when the subscription config cannot be resolved (config source unreadable)", async () => {
    getUserMock.mockResolvedValue({ subscriptionType: "Super Premium" });
    getConfigMock.mockResolvedValue(null);
    await expect(allowanceFor(U, M)).rejects.toThrow(/no subscription config/i);
  });

  it("returns unlimited ONLY when the config resolves and the tier genuinely has no policy", async () => {
    getUserMock.mockResolvedValue({ subscriptionType: "FreeInternal" });
    getConfigMock.mockResolvedValue({ llmUsagePolicy: null }); // resolved, no cap
    await expect(allowanceFor(U, M)).resolves.toEqual({ includedAllowanceMicroUsd: 0, unlimited: true });
  });

  it("returns the real cap for a capped tier, credits folded in", async () => {
    getUserMock.mockResolvedValue({ subscriptionType: "Super Premium", llmUsageCredits: {} });
    getConfigMock.mockResolvedValue({ llmUsagePolicy: { hardCostThresholdMicroUsd: 150_000_000 } });
    getCreditMock.mockReturnValue({ purchasedMicroUsd: 50_000_000, adminGrantedMicroUsd: 0, migrationOffsetMicroUsd: 0 });
    await expect(allowanceFor(U, M)).resolves.toEqual({
      includedAllowanceMicroUsd: 150_000_000,
      purchasedCreditsMicroUsd: 50_000_000,
      adminAdjustmentMicroUsd: 0,
      migrationAdjustmentMicroUsd: 0,
      unlimited: false,
    });
  });
});
