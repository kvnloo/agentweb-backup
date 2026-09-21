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
// Delegates to the real implementation; wrapped only so the permission the
// service asks for can be asserted. ENG-1528 — `org:content:manage` and
// `org:members:read` happen to carry identical role grants today, so behaviour
// alone cannot tell them apart, and a later decision to let members read the
// roster would silently hand them model-switching too.
jest.mock("../services/orgAuthz", () => {
  const actual = jest.requireActual("../services/orgAuthz");
  return { ...actual, callerCan: jest.fn(actual.callerCan) };
});
jest.mock("../services/llmUsageTelemetry", () => ({
  recordUsageTelemetry: jest.fn(),
  USAGE_TELEMETRY_EVENTS: {
    changeApplied: "runway_change_applied",
    changeUndone: "runway_change_undone",
  },
}));

import { applyModelChange, undoModelChange } from "../services/llmModelChangeService";
import { scheduleDb, userDb, orgDb } from "../services/db";
import { callerCan } from "../services/orgAuthz";
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
    // The third argument is the ENG-1217 concurrency guard, not incidental: it
    // binds the write to the model this decision was read from, so a second
    // confirm racing the first is rejected by DynamoDB instead of writing a
    // duplicate audit row. Asserted by meaning rather than by arity — the value
    // has to be the model observed BEFORE the switch, and a guard pinned to the
    // wrong model would pass an arity check while defeating its own purpose.
    expect(mockUpdateSchedule).toHaveBeenCalledWith(
      "sched-a",
      { llmModel: SONNET },
      { llmModel: OPUS },
    );
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
    // The forward write carries the concurrency guard; the compensating write
    // below deliberately does NOT. Restoring what we just changed is not a
    // decision derived from a stale read, and guarding it would leave the
    // schedule on an unaudited model whenever the restore lost a race — the one
    // outcome the compensation exists to prevent.
    expect(mockUpdateSchedule).toHaveBeenNthCalledWith(
      1,
      "sched-a",
      { llmModel: SONNET },
      { llmModel: OPUS },
    );
    // The compensating write is guarded too, on the model WE just wrote. If a
    // condition failure means someone replaced it in between, our unaudited value
    // is already gone and reinstating `modelBefore` would clobber their deliberate
    // choice to undo a write that no longer exists.
    expect(mockUpdateSchedule).toHaveBeenNthCalledWith(
      2,
      "sched-a",
      { llmModel: OPUS },
      { llmModel: SONNET },
      undefined,
      undefined,
    );
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
    // The third argument guards the restore on the schedule still carrying the
    // model this change installed, so an undo cannot reinstate a stale value over
    // a newer choice. Asserted by value, not arity: a guard naming the wrong
    // model would satisfy a positional check while permitting the overwrite.
    expect(mockUpdateSchedule).toHaveBeenCalledWith(
      "sched-a",
      { llmModel: OPUS },
      { llmModel: SONNET },
      undefined,
      undefined,
    );
    expect(mockUndone).toHaveBeenCalledWith("billing-root", changeSk, "member-a");
    expect(result.undone).toBe(true);
  });

  it("restores INHERITANCE by removing the attribute, not by writing a value", async () => {
    // The majority case: 66 of 91 active production schedules store no model and
    // follow the platform default. `modelBefore: null` records that, and undoing
    // it has to REMOVE the attribute -- an absent value keeps following the
    // default as it moves, where any stored value stops following it.
    //
    // This previously passed `{ llmModel: undefined }`, which looks equivalent and
    // is not: the key survives `Object.entries`, so it emitted an unresolvable
    // SET and DynamoDB rejected the whole write. Undo therefore failed for two
    // thirds of real schedules, AFTER the audit row had been stamped undone.
    mockList.mockResolvedValue([
      { ...stored, modelBefore: null, modelAfter: SONNET },
    ]);
    mockGetSchedule.mockResolvedValue({
      scheduleId: "sched-a",
      userId: "member-a",
      llmModel: SONNET,
    });

    const result = await undoModelChange("member-a", changeSk);

    expect(result.undone).toBe(true);
    const [scheduleId, updates, , , removeAttributes] = mockUpdateSchedule.mock.calls[0];
    expect(scheduleId).toBe("sched-a");
    expect(removeAttributes).toEqual(["llmModel"]);
    // Neither a blank nor today's default may be written in place of absence.
    expect(updates).toEqual({});
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
    // A change whose record already carries `undoneAt` is settled: answer from the
    // record and touch nothing. The customer may have changed the model since, and
    // a second restore would silently overwrite that newer choice.
    //
    // This is now decided BEFORE the write rather than by the stamp refusing it,
    // because the restore moved ahead of the stamp — see the durability suite. The
    // stamp remains the lock for a genuine race between two concurrent undos.
    mockList.mockResolvedValue([{ ...stored, undoneAt: "2026-08-18T09:00:00.000Z" }] as never);
    const result = await undoModelChange("member-a", changeSk);
    expect(result.undone).toBe(false);
    expect(mockUpdateSchedule).not.toHaveBeenCalled();
    expect(mockUndone).not.toHaveBeenCalled();
  });

  it("reports a no-op when a concurrent undo wins the stamp", async () => {
    // The race the stamp still owns: both callers restore to the same value, and
    // the loser reports honestly rather than claiming an undo it did not record.
    mockUndone.mockResolvedValue(false);
    const result = await undoModelChange("member-a", changeSk);
    expect(result.undone).toBe(false);
  });

});

/**
 * ENG-1528 — an org owner may switch a colleague's schedule; a member may not.
 *
 * `usage-drivers` is billing-scoped: it pools schedules across every org member,
 * so an org owner is SHOWN colleagues' spend and told it is theirs to reduce.
 * The write then compared user ids and refused all of it. Measured on
 * production: 8 of the 10 schedules offered to the `AgentWeb` org owner were a
 * colleague's, and every one 404'd.
 *
 * `orgAuthz` already draws the line this needs — `org:content:manage`, held by
 * owner and admin, withheld from member. Nothing here widens a member's reach.
 *
 * The anti-enumeration property is load-bearing and tested separately: a
 * blanket 403 would turn this endpoint into an existence oracle for any UUID.
 */
describe("llmModelChangeService — org authority (ENG-1528)", () => {
  const mockGetUser = userDb.getUserById as jest.Mock;
  const mockGetOrg = orgDb.getOrgById as jest.Mock;

  /** A schedule owned by someone else, in org `org-1`. */
  const colleaguesSchedule = () =>
    mockGetSchedule.mockResolvedValue({
      scheduleId: "sched-a",
      userId: "colleague",
      llmModel: OPUS,
      scheduleName: "Harsha Daily X Post",
    });

  const wire = (callerRecord: Record<string, unknown>, org: Record<string, unknown> | null) => {
    mockGetUser.mockImplementation(async (id: string) =>
      id === "colleague" ? { userId: "colleague", orgId: "org-1" } : callerRecord,
    );
    mockGetOrg.mockResolvedValue(org);
  };

  it("lets the org's billing root switch a colleague's schedule", async () => {
    // The reported case exactly: the caller IS `ownerUserId`.
    colleaguesSchedule();
    wire({ userId: "member-a", orgId: "org-1" }, { orgId: "org-1", ownerUserId: "member-a" });

    const result = await apply();

    expect(result.applied).toBe(true);
    expect(mockUpdateSchedule).toHaveBeenCalled();
  });

  it("lets an org admin switch a colleague's schedule", async () => {
    colleaguesSchedule();
    wire(
      { userId: "member-a", orgId: "org-1", orgRole: "admin" },
      { orgId: "org-1", ownerUserId: "someone-else" },
    );

    const result = await apply();

    expect(result.applied).toBe(true);
  });

  it("refuses a plain member, and says why rather than lying", async () => {
    // `ROLE_PERMISSIONS.member` is empty, so this is unchanged from before —
    // but the words change: inside their own org the schedule is already on
    // their billing page, so "not found" was false and unactionable.
    colleaguesSchedule();
    wire(
      { userId: "member-a", orgId: "org-1", orgRole: "member" },
      { orgId: "org-1", ownerUserId: "someone-else" },
    );

    await expect(apply()).rejects.toThrow(/belongs to another member/i);
    expect(mockUpdateSchedule).not.toHaveBeenCalled();
  });

  it("still reports NOT FOUND across a tenant boundary, so ids cannot be enumerated", async () => {
    // The property the original 404 existed to protect. A caller in a different
    // org must not be able to distinguish "exists but forbidden" from "does not
    // exist" — otherwise this endpoint is an existence oracle for any UUID.
    colleaguesSchedule();
    wire(
      { userId: "member-a", orgId: "org-2", orgRole: "owner" },
      { orgId: "org-1", ownerUserId: "someone-else" },
    );

    await expect(apply()).rejects.toThrow(/not found/i);
    await expect(apply()).rejects.not.toThrow(/belongs to another member/i);
    expect(mockUpdateSchedule).not.toHaveBeenCalled();
  });

  it("reports NOT FOUND when the owner has no org at all", async () => {
    colleaguesSchedule();
    mockGetUser.mockImplementation(async (id: string) =>
      id === "colleague" ? { userId: "colleague" } : { userId: "member-a", orgId: "org-1" },
    );
    mockGetOrg.mockResolvedValue(null);

    await expect(apply()).rejects.toThrow(/not found/i);
  });

  it("asks for content-management authority specifically, not merely some org permission", async () => {
    // Guards a drift this suite otherwise cannot see. Switching the requested
    // permission to `org:members:read` leaves every other test in this file
    // green, because both are owner+admin today — but reading a roster is a
    // benign thing to widen to members later, and switching their colleagues'
    // models is not.
    colleaguesSchedule();
    wire({ userId: "member-a", orgId: "org-1" }, { orgId: "org-1", ownerUserId: "member-a" });

    await apply();

    expect(callerCan).toHaveBeenCalledWith(
      "member-a",
      expect.objectContaining({ orgId: "org-1" }),
      "org:content:manage",
    );
  });

  it("applies the same authority to UNDO, not just apply", async () => {
    // Undo is the other write. It re-checks the scope deliberately, so it has
    // to reach the same answer — otherwise an owner can switch and not revert.
    colleaguesSchedule();
    wire({ userId: "member-a", orgId: "org-1" }, { orgId: "org-1", ownerUserId: "member-a" });
    const changeSk = "2026-08-15T10:00:00.000Z#chg-1";
    mockList.mockResolvedValue([
      {
        changeId: "chg-1",
        changedAt: "2026-08-15T10:00:00.000Z",
        scope: "schedule",
        scopeId: "sched-a",
        modelBefore: OPUS,
        modelAfter: SONNET,
      },
    ]);

    await expect(undoModelChange("member-a", changeSk)).resolves.toBeDefined();
  });
});