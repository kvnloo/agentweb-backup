/**
 * ENG-1217 AC6/AC9 — applying and undoing a customer-confirmed model switch.
 *
 * This is the one path in the whole runway feature that WRITES a model, so it
 * carries the weight of ENG-1200: we removed automatic switching because
 * customers were silently downgraded and their work got worse. Everything here
 * exists to keep that from coming back through a different door.
 *
 * Four properties matter more than the happy path:
 *
 *  - **Owner-only.** Mirrors the existing schedule update check exactly, and
 *    reports "not found" rather than "forbidden" so the endpoint cannot be used
 *    to discover which schedule ids exist.
 *  - **Only a recommended model.** The target must be in the admin-configured
 *    recommendation catalog, not merely a model that exists. This endpoint
 *    applies a recommendation; accepting any model would make it a general
 *    model-setter with an audit trail, which is a different and riskier thing.
 *  - **No change without an audit record.** If the audit write fails, the model
 *    is put back. AC9 says a confirmed change is auditable; a change we cannot
 *    explain is worse than a change that did not happen.
 *  - **Idempotent.** A double-click must not produce two audit rows claiming two
 *    switches, nor an undo target whose "before" is already the "after".
 */

jest.mock("../services/db", () => ({
  scheduleDb: { getScheduleById: jest.fn(), updateSchedule: jest.fn() },
  userDb: { getUserById: jest.fn() },
  orgDb: { getOrgById: jest.fn(), getOrgMembers: jest.fn() },
}));
jest.mock("../services/llmUsagePolicyResolverService", () => ({
  getEffectiveLlmUsagePolicy: jest.fn(),
}));
jest.mock("../services/agentModeService", () => ({
  agentModeService: { getSupportedModels: jest.fn() },
}));
jest.mock("../services/llmModelChangeAuditDb", () => ({
  recordModelChange: jest.fn(),
  listModelChanges: jest.fn(),
  markModelChangeUndone: jest.fn(),
  buildChangeSortKey: (a: string, b: string) => `${a}#${b}`,
}));
jest.mock("../services/llmUsageTelemetry", () => ({
  recordUsageTelemetry: jest.fn(),
  USAGE_TELEMETRY_EVENTS: {
    changeApplied: "runway_change_applied",
    changeUndone: "runway_change_undone",
  },
}));

import { applyModelChange, undoModelChange } from "../services/llmModelChangeService";
import { scheduleDb } from "../services/db";
import { getEffectiveLlmUsagePolicy } from "../services/llmUsagePolicyResolverService";
import { agentModeService } from "../services/agentModeService";
import {
  recordModelChange,
  listModelChanges,
  markModelChangeUndone,
} from "../services/llmModelChangeAuditDb";
import { recordUsageTelemetry } from "../services/llmUsageTelemetry";

const mockGetSchedule = scheduleDb.getScheduleById as jest.Mock;
const mockUpdateSchedule = scheduleDb.updateSchedule as jest.Mock;
const mockPolicy = getEffectiveLlmUsagePolicy as jest.Mock;
const mockModels = agentModeService.getSupportedModels as jest.Mock;
const mockRecord = recordModelChange as jest.Mock;
const mockList = listModelChanges as jest.Mock;
const mockUndone = markModelChangeUndone as jest.Mock;
const mockTelemetry = recordUsageTelemetry as jest.Mock;

const OPUS = "anthropic.claude-opus-5";
const SONNET = "anthropic.claude-sonnet-5";
const HAIKU = "anthropic.claude-haiku-4-5";

beforeEach(() => {
  jest.clearAllMocks();
  mockGetSchedule.mockResolvedValue({
    scheduleId: "sched-a",
    userId: "member-a",
    llmModel: OPUS,
    scheduleName: "Lead list enrichment",
  });
  mockUpdateSchedule.mockResolvedValue({});
  mockPolicy.mockResolvedValue({
    billingUserId: "billing-root",
    policy: { optimizedModelIds: [SONNET, HAIKU], hardCostThresholdMicroUsd: 1 },
  });
  mockModels.mockResolvedValue([OPUS, SONNET, HAIKU]);
  mockRecord.mockResolvedValue("2026-08-15T10:00:00.000Z#chg-1");
  mockUndone.mockResolvedValue(true);
  mockTelemetry.mockResolvedValue(undefined);
});

const apply = (over: Record<string, unknown> = {}) =>
  applyModelChange("member-a", {
    scope: "schedule",
    scopeId: "sched-a",
    toModel: SONNET,
    estimatedDaysRecovered: 6,
    confidence: "high",
    ...over,
  });

describe("applyModelChange", () => {
  it("writes the new model and records the change", async () => {
    const result = await apply();
    expect(mockUpdateSchedule).toHaveBeenCalledWith("sched-a", { llmModel: SONNET });
    expect(mockRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        billingUserId: "billing-root",
        scope: "schedule",
        scopeId: "sched-a",
        modelBefore: OPUS,
        modelAfter: SONNET,
        estimatedDaysRecoveredAtDecision: 6,
        confirmedByUserId: "member-a",
      }),
    );
    expect(result.applied).toBe(true);
  });

  it("refuses a schedule the caller does not own, as not-found", async () => {
    // Not "forbidden": a 403 confirms the id exists, turning this into an
    // enumeration oracle for other tenants' schedule ids.
    mockGetSchedule.mockResolvedValue({ scheduleId: "sched-a", userId: "someone-else", llmModel: OPUS });
    await expect(apply()).rejects.toThrow(/not found/i);
    expect(mockUpdateSchedule).not.toHaveBeenCalled();
  });

  it("refuses a model that is not in the recommendation catalog", async () => {
    // OPUS is supported and real, but it is not something we recommended
    // switching TO. Accepting it would make this a general model-setter.
    await expect(apply({ toModel: OPUS })).rejects.toThrow(/not available/i);
    expect(mockUpdateSchedule).not.toHaveBeenCalled();
  });

  it("refuses a catalog model the account cannot actually invoke", async () => {
    // Admin-configured but unsupported for this account: switching to it would
    // break the schedule outright, which is a worse outcome than overspending.
    mockModels.mockResolvedValue([OPUS, SONNET]);
    await expect(apply({ toModel: HAIKU })).rejects.toThrow(/not available/i);
    expect(mockUpdateSchedule).not.toHaveBeenCalled();
  });

  it("is a no-op when the schedule already runs that model", async () => {
    // A double-click must not produce two audit rows claiming two switches, nor
    // an undo whose "before" is already the "after".
    mockGetSchedule.mockResolvedValue({ scheduleId: "sched-a", userId: "member-a", llmModel: SONNET });
    const result = await apply();
    expect(result.applied).toBe(false);
    expect(mockUpdateSchedule).not.toHaveBeenCalled();
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it("puts the model back if the audit record cannot be written", async () => {
    // AC9 says a confirmed change is auditable. A change we cannot explain is
    // worse than one that did not happen, so the write is compensated.
    mockRecord.mockRejectedValue(new Error("dynamo down"));
    await expect(apply()).rejects.toThrow(/dynamo down/);
    expect(mockUpdateSchedule).toHaveBeenNthCalledWith(1, "sched-a", { llmModel: SONNET });
    expect(mockUpdateSchedule).toHaveBeenNthCalledWith(2, "sched-a", { llmModel: OPUS });
  });

  it("records the schedule's name as it read at the time", async () => {
    // Denormalised so a schedule deleted later is still explainable.
    await apply();
    expect(mockRecord.mock.calls[0][0].scopeLabel).toBe("Lead list enrichment");
  });

  it("emits telemetry naming both models", async () => {
    await apply();
    expect(mockTelemetry).toHaveBeenCalledWith(
      "billing-root",
      "runway_change_applied",
      expect.objectContaining({ fromModel: OPUS, toModel: SONNET }),
    );
  });
});

describe("undoModelChange", () => {
  const changeSk = "2026-08-15T10:00:00.000Z#chg-1";
  const stored = {
    billingUserId: "billing-root",
    changeId: "chg-1",
    changedAt: "2026-08-15T10:00:00.000Z",
    scope: "schedule",
    scopeId: "sched-a",
    scopeLabel: "Lead list enrichment",
    modelBefore: OPUS,
    modelAfter: SONNET,
    estimatedDaysRecoveredAtDecision: 6,
    confidenceAtDecision: "high",
    confirmedByUserId: "member-a",
    undoneAt: null,
  };

  beforeEach(() => {
    mockList.mockResolvedValue([stored]);
    mockGetSchedule.mockResolvedValue({
      scheduleId: "sched-a",
      userId: "member-a",
      llmModel: SONNET,
      scheduleName: "Lead list enrichment",
    });
  });

  it("restores the model that was there before", async () => {
    const result = await undoModelChange("member-a", changeSk);
    expect(mockUpdateSchedule).toHaveBeenCalledWith("sched-a", { llmModel: OPUS });
    expect(mockUndone).toHaveBeenCalledWith("billing-root", changeSk, "member-a");
    expect(result.undone).toBe(true);
  });

  it("refuses to undo a change the caller does not own", async () => {
    mockGetSchedule.mockResolvedValue({ scheduleId: "sched-a", userId: "someone-else", llmModel: SONNET });
    await expect(undoModelChange("member-a", changeSk)).rejects.toThrow(/not found/i);
    expect(mockUpdateSchedule).not.toHaveBeenCalled();
  });

  it("refuses an unknown change id", async () => {
    mockList.mockResolvedValue([]);
    await expect(undoModelChange("member-a", changeSk)).rejects.toThrow(/not found/i);
  });

  it("does not restore twice when the change was already undone", async () => {
    // The audit stamp is the lock. If it reports "already undone", the model
    // must not be written again — the customer may have changed it since, and
    // a second restore would silently overwrite their newer choice.
    mockUndone.mockResolvedValue(false);
    const result = await undoModelChange("member-a", changeSk);
    expect(result.undone).toBe(false);
    expect(mockUpdateSchedule).not.toHaveBeenCalled();
  });
});
