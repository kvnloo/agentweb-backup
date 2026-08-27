/**
 * ENG-1404 / ENG-1599 — the one-off correction in
 * scripts/fix-eng1404-schedule-required-function.ts.
 *
 * This is deliberately a single-schedule, single-field script, not a general
 * migration — so the tests are about the same two failure directions as any
 * data-plane one-off: it must actually run against the real db wiring, and it
 * must refuse to write anything it wasn't specifically built to touch (wrong
 * owner, wrong schedule shape, already applied).
 */
import { scheduleDb } from "../services/db";
import {
  fixRequiredFunctionMismatch,
  SCHEDULE_ID,
  EXPECTED_OWNER_ID,
} from "../scripts/fix-eng1404-schedule-required-function";

function schedule(over: Record<string, any> = {}) {
  return {
    scheduleId: SCHEDULE_ID,
    userId: EXPECTED_OWNER_ID,
    requiredFunctionCalls: ["twitter_outreach", "twitter_manage_post"],
    ...over,
  };
}

describe("ENG-1404 fix-eng1404-schedule-required-function — real db wiring", () => {
  afterEach(() => jest.restoreAllMocks());

  it("names methods that scheduleDb actually implements", () => {
    expect(typeof scheduleDb.getScheduleById).toBe("function");
    expect(typeof scheduleDb.updateSchedule).toBe("function");
  });

  it("reads through scheduleDb.getScheduleById when nothing is injected", async () => {
    const spy = jest.spyOn(scheduleDb, "getScheduleById").mockResolvedValue(schedule() as any);

    const result = await fixRequiredFunctionMismatch({ apply: false });

    expect(spy).toHaveBeenCalledWith(SCHEDULE_ID);
    expect(result.skippedReason).toBeUndefined();
  });
});

describe("ENG-1404 fix-eng1404-schedule-required-function — dry run", () => {
  it("reports the swap without writing anything", async () => {
    const update = jest.fn();

    const result = await fixRequiredFunctionMismatch({
      apply: false,
      getScheduleById: async () => schedule(),
      update,
    });

    expect(result).toMatchObject({
      applied: false,
      scheduleId: SCHEDULE_ID,
      before: ["twitter_outreach", "twitter_manage_post"],
      after: ["twitter_outreach", "post_on_connected_account"],
    });
    expect(update).not.toHaveBeenCalled();
  });
});

describe("ENG-1404 fix-eng1404-schedule-required-function — apply", () => {
  it("writes the corrected requiredFunctionCalls, conditioned on the value it read", async () => {
    const update = jest.fn().mockResolvedValue(undefined);
    const stale = ["twitter_outreach", "twitter_manage_post"];

    const result = await fixRequiredFunctionMismatch({
      apply: true,
      getScheduleById: async () => schedule({ requiredFunctionCalls: stale }),
      update,
    });

    expect(result.applied).toBe(true);
    expect(result.after).toEqual(["twitter_outreach", "post_on_connected_account"]);
    expect(update).toHaveBeenCalledWith(
      SCHEDULE_ID,
      expect.objectContaining({ requiredFunctionCalls: ["twitter_outreach", "post_on_connected_account"] }),
      // The condition must pin BOTH the owner and the exact array this run read,
      // so a schedule that changed underneath it (re-scoped, re-owned) fails
      // closed instead of silently overwriting a different state than it saw.
      { userId: EXPECTED_OWNER_ID, requiredFunctionCalls: stale },
    );
  });

  it("is order-insensitive reading the stale value, but always writes the canonical order", async () => {
    const update = jest.fn().mockResolvedValue(undefined);

    const result = await fixRequiredFunctionMismatch({
      apply: true,
      getScheduleById: async () => schedule({ requiredFunctionCalls: ["twitter_manage_post", "twitter_outreach"] }),
      update,
    });

    expect(result.applied).toBe(true);
    expect(result.after).toEqual(["twitter_outreach", "post_on_connected_account"]);
  });
});

describe("ENG-1404 fix-eng1404-schedule-required-function — fails closed", () => {
  it("refuses a schedule that does not exist", async () => {
    const update = jest.fn();

    const result = await fixRequiredFunctionMismatch({
      apply: true,
      getScheduleById: async () => null,
      update,
    });

    expect(result.applied).toBe(false);
    expect(result.skippedReason).toBe("schedule not found");
    expect(update).not.toHaveBeenCalled();
  });

  it("refuses a schedule with the wrong owner — id typo/reuse must not touch a stranger's schedule", async () => {
    const update = jest.fn();

    const result = await fixRequiredFunctionMismatch({
      apply: true,
      getScheduleById: async () => schedule({ userId: "someone-else" }),
      update,
    });

    expect(result.applied).toBe(false);
    expect(result.skippedReason).toMatch(/owner mismatch/);
    expect(update).not.toHaveBeenCalled();
  });

  it("is a no-op once the schedule is already corrected", async () => {
    const update = jest.fn();

    const result = await fixRequiredFunctionMismatch({
      apply: true,
      getScheduleById: async () => schedule({ requiredFunctionCalls: ["twitter_outreach", "post_on_connected_account"] }),
      update,
    });

    expect(result.applied).toBe(false);
    expect(result.skippedReason).toBe("already corrected");
    expect(update).not.toHaveBeenCalled();
  });

  it("refuses a schedule whose requiredFunctionCalls no longer matches the expected stale shape", async () => {
    // Guards against blindly overwriting a record that has moved on from the
    // exact state this one-off script was written against — e.g. someone
    // already hand-edited it to something else entirely.
    const update = jest.fn();

    const result = await fixRequiredFunctionMismatch({
      apply: true,
      getScheduleById: async () => schedule({ requiredFunctionCalls: ["twitter_outreach"] }),
      update,
    });

    expect(result.applied).toBe(false);
    expect(result.skippedReason).toMatch(/not the expected stale value/);
    expect(update).not.toHaveBeenCalled();
  });

  it("lets a concurrent-change write rejection surface rather than swallowing it", async () => {
    const conditionalCheckFailed = Object.assign(new Error("ConditionalCheckFailedException"), {
      name: "ConditionalCheckFailedException",
    });
    const update = jest.fn().mockRejectedValue(conditionalCheckFailed);

    await expect(
      fixRequiredFunctionMismatch({
        apply: true,
        getScheduleById: async () => schedule(),
        update,
      }),
    ).rejects.toThrow("ConditionalCheckFailedException");
  });
});
