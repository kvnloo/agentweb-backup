/**
 * ENG-827 — the consent migration in scripts/grant-schedule-autopublish.ts.
 *
 * Two things are under test, and they fail in opposite directions.
 *
 * The script must actually RUN: it shipped with a default enumeration callback
 * pointing at `scheduleDb.getAllSchedules`, a method nothing implemented, and since
 * every test injects `listSchedules`, the untested default was the only path an
 * operator would ever take. That wiring is asserted against the real db module — a
 * mock would have been just as happy with the broken name.
 *
 * And it must not GRANT anything nobody agreed to. Consent cannot be read back out of
 * the configuration this ticket exists to fix, so eligibility and permission are
 * separate: the survey says who to ask, and only an allowlist line — carrying the
 * owner's id and how they confirmed — turns one into a write.
 */
import { scheduleDb, taskDb } from "../services/db";
import {
  backfillPublishConsent,
  parseConsentAllowlist,
} from "../scripts/grant-schedule-autopublish";

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

/** A confirmation for the default schedule above. */
const CONFIRMED = [{ scheduleId: "sched-1", ownerUserId: "user-1", note: "owner said yes in #ops" }];

describe("ENG-827 grant-schedule-autopublish — enumeration wiring", () => {
  afterEach(() => jest.restoreAllMocks());

  it("names a method that scheduleDb actually implements", () => {
    // The regression, stated directly. Nothing else in the suite can catch it,
    // because every other test hands the function in.
    expect(typeof scheduleDb.getAllSchedules).toBe("function");
  });

  it("enumerates through scheduleDb when no lister is injected", async () => {
    const spy = jest.spyOn(scheduleDb, "getAllSchedules").mockResolvedValue([schedule()]);

    const result = await backfillPublishConsent({ apply: false, confirmedBy: "" });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(result.scanned).toBe(1);
    expect(result.candidates.map((c) => c.scheduleId)).toEqual(["sched-1"]);
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

    expect(result).toMatchObject({ scanned: 0, candidates: [], granted: [], skipped: [], applied: false });
  });
});

describe("ENG-827 grant-schedule-autopublish — eligibility is not consent", () => {
  const survey = (rows: any[], update?: any) =>
    backfillPublishConsent({ apply: false, confirmedBy: "", listSchedules: async () => rows, update });

  it("surveys an eligible schedule without granting it anything", async () => {
    // Greptile: the earlier draft read "already publishing" as "owner agreed", which is
    // circular — the configuration never held a consent decision, which is why we are
    // adding a field for one.
    const result = await survey([schedule()]);

    expect(result.candidates).toEqual([
      {
        scheduleId: "sched-1",
        scheduleName: "Kevin — Daily LinkedIn Post",
        userId: "user-1",
        tools: ["post_on_connected_account"],
      },
    ]);
    expect(result.granted).toEqual([]);
    expect(result.unconfirmed.map((u) => u.scheduleId)).toEqual(["sched-1"]);
  });

  it("refuses to apply with no confirmations at all", async () => {
    // An --apply typo must not become a silent grant to everything eligible.
    const update = jest.fn();
    await expect(
      backfillPublishConsent({
        apply: true,
        confirmedBy: "Harsha",
        listSchedules: async () => [schedule()],
        update,
      }),
    ).rejects.toThrow(/empty allowlist/i);
    expect(update).not.toHaveBeenCalled();
  });

  it("never overrides an owner who asked to be held", async () => {
    // The one thing this migration must not do: reverse a decision a human made.
    const result = await survey([schedule({ requirePublishApproval: true })]);

    expect(result.candidates).toEqual([]);
    expect(result.skipped[0].reason).toBe("owner requires approval");
  });

  it.each([
    ["a recorded grant", true],
    ["a recorded refusal", false],
  ])("leaves %s alone", async (_label, recorded) => {
    const result = await survey([schedule({ autopublishAuthorized: recorded })]);

    expect(result.candidates).toEqual([]);
    expect(result.skipped[0].reason).toBe("consent already recorded");
  });

  it("skips inactive schedules", async () => {
    const result = await survey([schedule({ status: "inactive" })]);

    expect(result.candidates).toEqual([]);
    expect(result.skipped[0].reason).toBe("not active");
  });

  it("will not infer a tool scope from prompt wording alone", async () => {
    // Consent is recorded against specific tools. A schedule that names none gives
    // us nothing to scope a grant to, and guessing would manufacture the very
    // decision this ticket says a human has to make.
    const result = await survey([
      schedule({ requiredFunctionCalls: [], startingMessage: "Post this to LinkedIn today" }),
    ]);

    expect(result.candidates).toEqual([]);
    expect(result.skipped[0].reason).toBe("no publishing tool designated");
  });
});

describe("ENG-827 grant-schedule-autopublish — the allowlist decides", () => {
  const run = (rows: any[], allowlist: any[], apply = false, update?: any) =>
    backfillPublishConsent({
      apply,
      confirmedBy: apply ? "Harsha" : "",
      allowlist,
      listSchedules: async () => rows,
      update,
    });

  it("writes only the confirmed schedule, leaving its eligible neighbour alone", async () => {
    const update = jest.fn();
    const neighbour = schedule({ scheduleId: "sched-2", userId: "user-2", scheduleName: "X Morning Post" });

    const result = await run([schedule(), neighbour], CONFIRMED, true, update);

    expect(result.granted.map((g) => g.scheduleId)).toEqual(["sched-1"]);
    expect(result.unconfirmed.map((u) => u.scheduleId)).toEqual(["sched-2"]);
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0][0]).toBe("sched-1");
  });

  it("records the grant exactly as the consent endpoint would — owner, not operator", async () => {
    // A migrated row has to be indistinguishable from one where the owner ticked the
    // box; `autopublishAuthorizedBy` answers "who authorized this", and that is never
    // the person who ran the migration.
    const update = jest.fn();
    await run([schedule()], CONFIRMED, true, update);

    const [id, patch] = update.mock.calls[0];
    expect(id).toBe("sched-1");
    expect(patch).toMatchObject({
      autopublishAuthorized: true,
      autopublishAuthorizedTools: ["post_on_connected_account"],
      autopublishAuthorizedBy: "user-1",
    });
    expect(patch.autopublishAuthorizedBy).not.toBe("Harsha");
  });

  it("fails closed when a mistyped id lands on someone else's schedule", async () => {
    // The owner id on each line is the integrity check: without it a typo grants
    // unreviewed publishing on a stranger's account.
    const update = jest.fn();
    const result = await run(
      [schedule({ userId: "someone-else" })],
      CONFIRMED,
      true,
      update,
    );

    expect(result.granted).toEqual([]);
    expect(update).not.toHaveBeenCalled();
    expect(result.rejected[0].reason).toMatch(/owner mismatch/);
  });

  it("reports a confirmation for a schedule that does not exist", async () => {
    const result = await run([schedule()], [
      { scheduleId: "sched-typo", ownerUserId: "user-1", note: "confirmed" },
    ]);

    expect(result.rejected).toEqual([
      { scheduleId: "sched-typo", ownerUserId: "user-1", reason: "no such schedule" },
    ]);
  });

  it("says WHY a confirmed schedule was still not granted", async () => {
    // The operator went and got an answer for this one. Dropping the line silently
    // would leave them believing it took.
    const result = await run([schedule({ requirePublishApproval: true })], CONFIRMED);

    expect(result.granted).toEqual([]);
    expect(result.rejected[0].reason).toBe("owner requires approval");
  });

  it("honours a duplicated line once", async () => {
    const update = jest.fn();
    const result = await run([schedule()], [...CONFIRMED, ...CONFIRMED], true, update);

    expect(result.granted).toHaveLength(1);
    expect(update).toHaveBeenCalledTimes(1);
    expect(result.rejected[0].reason).toBe("duplicate allowlist entry");
  });

  /**
   * ENG-1245 — the exact shape that used to be un-grantable. Schedule
   * 1d001fba-0fb7-4bcd-80f6-6041b244a442's requiredFunctionCalls is
   * ["twitter_outreach"], so it fails "no publishing tool designated" and never
   * became a candidate — meaning even a confirmed allowlist line for it was
   * rejected with that same reason, granting nothing. tools= lets the operator
   * record the owner's actual answer independent of requiredFunctionCalls.
   */
  describe("explicit tools= grants a schedule requiredFunctionCalls never named (ENG-1245)", () => {
    const notCandidate = () => schedule({ requiredFunctionCalls: ["twitter_outreach"] });
    const EXPLICIT = [
      { scheduleId: "sched-1", ownerUserId: "user-1", tools: ["post_on_connected_account"], note: "Harsha confirmed in Linear" },
    ];

    it("without tools=, the schedule is not even a candidate (pins the original bug)", async () => {
      const result = await run([notCandidate()], []);
      expect(result.candidates).toEqual([]);
      expect(result.skipped[0].reason).toBe("no publishing tool designated");
    });

    it("with tools=, the confirmed line grants it despite requiredFunctionCalls naming no publish tool", async () => {
      const update = jest.fn();
      const result = await run([notCandidate()], EXPLICIT, true, update);

      expect(result.granted).toEqual([
        { scheduleId: "sched-1", scheduleName: "Kevin — Daily LinkedIn Post", userId: "user-1", tools: ["post_on_connected_account"] },
      ]);
      expect(update).toHaveBeenCalledTimes(1);
      const [id, patch] = update.mock.calls[0];
      expect(id).toBe("sched-1");
      expect(patch).toMatchObject({
        autopublishAuthorized: true,
        autopublishAuthorizedTools: ["post_on_connected_account"],
        autopublishAuthorizedBy: "user-1",
      });
    });

    it("still enforces every existing safety gate — an explicit tools= grant is not a bypass", async () => {
      const update = jest.fn();

      const heldResult = await run(
        [schedule({ requiredFunctionCalls: ["twitter_outreach"], requirePublishApproval: true })],
        EXPLICIT,
        true,
        update,
      );
      expect(heldResult.granted).toEqual([]);
      expect(heldResult.rejected[0].reason).toBe("owner requires approval");

      const mismatchResult = await run(
        [schedule({ requiredFunctionCalls: ["twitter_outreach"], userId: "someone-else" })],
        EXPLICIT,
        true,
        update,
      );
      expect(mismatchResult.granted).toEqual([]);
      expect(mismatchResult.rejected[0].reason).toMatch(/owner mismatch/);

      expect(update).not.toHaveBeenCalled();
    });

    it("rejects a tools= entry naming something that is not a real publish-capable tool", async () => {
      const update = jest.fn();
      const result = await run(
        [notCandidate()],
        [{ scheduleId: "sched-1", ownerUserId: "user-1", tools: ["not_a_real_tool"], note: "confirmed" }],
        true,
        update,
      );

      expect(result.granted).toEqual([]);
      expect(update).not.toHaveBeenCalled();
      expect(result.rejected[0].reason).toMatch(/not_a_real_tool/);
    });

    it("de-duplicates an explicit tools= list", async () => {
      const update = jest.fn();
      await run(
        [notCandidate()],
        [{ scheduleId: "sched-1", ownerUserId: "user-1", tools: ["post_on_connected_account", "post_on_connected_account"], note: "confirmed" }],
        true,
        update,
      );

      expect(update.mock.calls[0][1].autopublishAuthorizedTools).toEqual(["post_on_connected_account"]);
    });

    it("a dry run reports the grant but writes nothing", async () => {
      const update = jest.fn();
      const result = await run([notCandidate()], EXPLICIT, false, update);

      expect(update).not.toHaveBeenCalled();
      expect(result.applied).toBe(false);
      expect(result.granted).toHaveLength(1);
    });
  });

  // =========================================================================
  // The apply pass writes one schedule at a time and can run long, while owners
  // keep editing. A grant DERIVED from the scan must not land against a schedule
  // that has moved since — so the write carries the state it was derived from.
  // =========================================================================
  const conditionalCheckFailed = () =>
    Object.assign(new Error("The conditional request failed"), {
      code: "ConditionalCheckFailedException",
    });

  it("conditions the grant on everything it was derived from", async () => {
    const update = jest.fn();
    await run([schedule()], CONFIRMED, true, update);

    expect(update).toHaveBeenCalledTimes(1);
    const [, patch, expected] = update.mock.calls[0];
    expect(patch).toMatchObject({
      autopublishAuthorized: true,
      autopublishAuthorizedTools: ["post_on_connected_account"],
    });
    // The tool scope the grant points at, the owner it is recorded against, and the
    // two settings that made it eligible at all.
    expect(expected).toEqual({
      userId: "user-1",
      status: "active",
      requiredFunctionCalls: ["post_on_connected_account"],
      // Absent at scan time, and `undefined` compiles to attribute_not_exists — so an
      // approval hold or a consent decision made in the window fails the write.
      requirePublishApproval: undefined,
      autopublishAuthorized: undefined,
    });
  });

  it("does not report a grant that the condition rejected", async () => {
    // The owner re-scoped or revoked between the scan and the write. Nothing was
    // written, so nothing may be reported as granted — the operator must be able to
    // trust this output when deciding it is safe to deploy.
    const update = jest.fn().mockRejectedValue(conditionalCheckFailed());
    const result = await run([schedule()], CONFIRMED, true, update);

    expect(result.granted).toEqual([]);
    expect(result.rejected).toEqual([
      {
        scheduleId: "sched-1",
        ownerUserId: "user-1",
        reason: expect.stringMatching(/changed after it was read/),
      },
    ]);
  });

  it("carries on past a moved schedule instead of abandoning the rest", async () => {
    const neighbour = schedule({ scheduleId: "sched-2", userId: "user-2", scheduleName: "X Morning Post" });
    const update = jest
      .fn()
      .mockRejectedValueOnce(conditionalCheckFailed())
      .mockResolvedValue({});

    const result = await run(
      [schedule(), neighbour],
      [...CONFIRMED, { scheduleId: "sched-2", ownerUserId: "user-2", note: "confirmed by email" }],
      true,
      update,
    );

    // One moved schedule must not leave the other 24 unmigrated on deploy day.
    expect(update).toHaveBeenCalledTimes(2);
    expect(result.granted.map((g) => g.scheduleId)).toEqual(["sched-2"]);
    expect(result.rejected.map((r) => r.scheduleId)).toEqual(["sched-1"]);
  });

  it("still surfaces a real write failure rather than logging it as a rejection", async () => {
    // A throttle or a credentials problem is not "the owner changed their mind", and
    // swallowing it would report a migration as done when most of it never ran.
    const update = jest.fn().mockRejectedValue(new Error("ProvisionedThroughputExceededException"));
    await expect(run([schedule()], CONFIRMED, true, update)).rejects.toThrow(/Throughput/i);
  });

  it("writes nothing on a dry run against a real allowlist", async () => {
    const update = jest.fn();
    const result = await run([schedule()], CONFIRMED, false, update);

    expect(update).not.toHaveBeenCalled();
    expect(result.applied).toBe(false);
    expect(result.granted).toHaveLength(1);
  });
});

describe("ENG-827 grant-schedule-autopublish — parseConsentAllowlist", () => {
  it("reads a schedule, its owner, and the note as the rest of the line", () => {
    expect(
      parseConsentAllowlist(
        [
          "# ENG-827 confirmations",
          "",
          "sched-1  user-1  ruiw@agentweb.pro confirmed in #ops on 2026-08-11",
        ].join("\n"),
      ),
    ).toEqual([
      { scheduleId: "sched-1", ownerUserId: "user-1", note: "ruiw@agentweb.pro confirmed in #ops on 2026-08-11" },
    ]);
  });

  it.each([
    ["a line with no note", "sched-1  user-1"],
    ["a line with no owner", "sched-1"],
  ])("stops the run on %s", (_label, line) => {
    // A file that grants permission to publish in someone's name is not a place for
    // "skipped one malformed line" warnings nobody reads.
    expect(() => parseConsentAllowlist(line)).toThrow(/Allowlist line 1/);
  });

  it("treats an empty file as no confirmations rather than an error", () => {
    expect(parseConsentAllowlist("")).toEqual([]);
    expect(parseConsentAllowlist("\n#only a comment\n")).toEqual([]);
  });

  /**
   * ENG-1245 — schedule 1d001fba-0fb7-4bcd-80f6-6041b244a442 ("Harsha Daily X Post
   * (Autonomous)") has posted nothing since 2026-08-13: its requiredFunctionCalls
   * (["twitter_outreach"]) names no publish tool, so it fails the "no publishing tool
   * designated" gate and this script — as originally written — rejects even an
   * allowlist line naming it, granting nothing. `tools=` lets the operator record
   * exactly which tools the owner confirmed, independent of requiredFunctionCalls.
   */
  describe("explicit tools= (ENG-1245)", () => {
    it("parses a tools= token as the explicit grant scope, not part of the note", () => {
      expect(
        parseConsentAllowlist("sched-1  user-1  tools=post_on_connected_account  Harsha confirmed in Linear"),
      ).toEqual([
        {
          scheduleId: "sched-1",
          ownerUserId: "user-1",
          tools: ["post_on_connected_account"],
          note: "Harsha confirmed in Linear",
        },
      ]);
    });

    it("splits a comma-separated tools= list (no spaces — it is one whitespace-delimited token)", () => {
      expect(
        parseConsentAllowlist("sched-1  user-1  tools=post_on_connected_account,twitter_manage_post  confirmed"),
      ).toEqual([
        {
          scheduleId: "sched-1",
          ownerUserId: "user-1",
          tools: ["post_on_connected_account", "twitter_manage_post"],
          note: "confirmed",
        },
      ]);
    });

    it("omits tools entirely (not an empty array) when the line has no tools= token", () => {
      const [entry] = parseConsentAllowlist("sched-1  user-1  confirmed in #ops");
      expect(entry.tools).toBeUndefined();
    });

    it("stops the run on an empty tools= list", () => {
      expect(() => parseConsentAllowlist("sched-1  user-1  tools=  confirmed")).toThrow(/Allowlist line 1/);
    });
  });
});
