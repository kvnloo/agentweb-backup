/**
 * ENG-827 — the consent migration in scripts/grant-schedule-autopublish.ts.
 *
 * This script had no tests, and that is exactly how it shipped with a default
 * enumeration callback pointing at `scheduleDb.getAllSchedules` — a method that did
 * not exist. Every caller in a test injects `listSchedules`, so the untested default
 * was the ONLY path an operator would ever take, and it threw a TypeError before
 * reading a single schedule. The wiring is therefore asserted here against the real
 * db module, not a mock: a mock would have been just as happy with the broken name.
 */
import { scheduleDb, taskDb } from "../services/db";
import { backfillPublishConsent } from "../scripts/grant-schedule-autopublish";

const PUBLISHING = { requiredFunctionCalls: ["post_on_connected_account"] };

function schedule(over: Record<string, any> = {}) {
  return {
    scheduleId: "sched-1",
    scheduleName: "Kevin — Daily LinkedIn Post",
    userId: "user-1",
    status: "active",
    ...PUBLISHING,
    ...over,
  };
}

describe("ENG-827 grant-schedule-autopublish — enumeration wiring", () => {
  afterEach(() => jest.restoreAllMocks());

  it("names a method that scheduleDb actually implements", () => {
    // The regression, stated directly. Nothing else in the suite can catch it,
    // because every other test hands the function in.
    expect(typeof scheduleDb.getAllSchedules).toBe("function");
  });

  it("enumerates through scheduleDb when no lister is injected", async () => {
    const spy = jest
      .spyOn(scheduleDb, "getAllSchedules")
      .mockResolvedValue([schedule()]);

    const result = await backfillPublishConsent({ apply: false, confirmedBy: "" });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(result.scanned).toBe(1);
    expect(result.granted.map((g) => g.scheduleId)).toEqual(["sched-1"]);
  });

  it("lets a failed scan surface instead of reading as an empty table", async () => {
    // A scan that dies partway must not reach the migration as zero schedules: that
    // is a transient failure wearing the face of "nothing to grant", and the operator
    // would walk away believing the backfill was a no-op.
    jest.spyOn(taskDb, "scanAllItems").mockRejectedValue(new Error("ProvisionedThroughputExceeded"));

    await expect(scheduleDb.getAllSchedules()).rejects.toThrow("ProvisionedThroughputExceeded");
  });

  it("survives an empty table without inventing rows", async () => {
    jest.spyOn(scheduleDb, "getAllSchedules").mockResolvedValue([]);

    const result = await backfillPublishConsent({ apply: false, confirmedBy: "" });

    expect(result).toMatchObject({ scanned: 0, granted: [], skipped: [], applied: false });
  });
});

describe("ENG-827 grant-schedule-autopublish — what it will and will not touch", () => {
  const run = (rows: any[], apply = false, update?: any) =>
    backfillPublishConsent({
      apply,
      confirmedBy: apply ? "Harsha" : "",
      listSchedules: async () => rows,
      update,
    });

  it("grants to an active schedule that designates a publishing tool", async () => {
    const result = await run([schedule()]);

    expect(result.granted).toEqual([
      {
        scheduleId: "sched-1",
        scheduleName: "Kevin — Daily LinkedIn Post",
        userId: "user-1",
        tools: ["post_on_connected_account"],
      },
    ]);
  });

  it("never overrides an owner who asked to be held", async () => {
    // The one thing this migration must not do: reverse a decision a human made.
    const result = await run([schedule({ requirePublishApproval: true })]);

    expect(result.granted).toEqual([]);
    expect(result.skipped[0].reason).toBe("owner requires approval");
  });

  it.each([
    ["a recorded grant", true],
    ["a recorded refusal", false],
  ])("leaves %s alone", async (_label, recorded) => {
    const result = await run([schedule({ autopublishAuthorized: recorded })]);

    expect(result.granted).toEqual([]);
    expect(result.skipped[0].reason).toBe("consent already recorded");
  });

  it("skips inactive schedules", async () => {
    const result = await run([schedule({ status: "inactive" })]);

    expect(result.granted).toEqual([]);
    expect(result.skipped[0].reason).toBe("not active");
  });

  it("will not infer a tool scope from prompt wording alone", async () => {
    // Consent is recorded against specific tools. A schedule that names none gives
    // us nothing to scope a grant to, and guessing would manufacture the very
    // decision this ticket says a human has to make.
    const result = await run([
      schedule({ requiredFunctionCalls: [], startingMessage: "Post this to LinkedIn today" }),
    ]);

    expect(result.granted).toEqual([]);
    expect(result.skipped[0].reason).toBe("no publishing tool designated");
  });

  it("writes nothing on a dry run", async () => {
    const update = jest.fn();
    const result = await run([schedule()], false, update);

    expect(update).not.toHaveBeenCalled();
    expect(result.applied).toBe(false);
    expect(result.granted).toHaveLength(1);
  });

  it("attributes an applied grant to the named human, scoped to that schedule's tools", async () => {
    const update = jest.fn();
    await run([schedule()], true, update);

    expect(update).toHaveBeenCalledTimes(1);
    const [id, patch] = update.mock.calls[0];
    expect(id).toBe("sched-1");
    expect(patch).toMatchObject({
      autopublishAuthorized: true,
      autopublishAuthorizedTools: ["post_on_connected_account"],
      autopublishAuthorizedBy: "Harsha",
    });
  });
});
