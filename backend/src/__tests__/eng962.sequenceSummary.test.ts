/**
 * ENG-962 — unit tests for the read-only sequence summary helpers.
 * Pure: no network, no DB, no mocks.
 */
import { summarizeSequence, describeSequenceAudience } from "../services/crmSequenceRead";

describe("describeSequenceAudience (AC3: audience = what the worker reads)", () => {
  it("reports auto-enroll lists, not the trigger, as the audience", () => {
    expect(
      describeSequenceAudience({
        enrollmentTrigger: { type: "list_membership", listId: "list-9" },
        autoEnrollListIds: ["list-1", "list-2"],
      }),
    ).toContain("auto-enrolling new leads from: list-1, list-2");
  });

  it("says plainly when an active sequence enrolls nobody new", () => {
    const text = describeSequenceAudience({
      status: "active",
      enrollmentTrigger: { type: "list_membership", listId: "list-9" },
      autoEnrollListIds: [],
    });
    expect(text).toContain("manual enrollment only");
    expect(text).toContain("no new leads are being added");
  });
});

describe("summarizeSequence (AC3/AC4: honest is_sending + description)", () => {
  it("marks only active sequences as sending", () => {
    expect(summarizeSequence({ status: "active" }).is_sending).toBe(true);
    for (const status of ["draft", "paused", "archived", undefined]) {
      expect(summarizeSequence({ status }).is_sending).toBe(false);
    }
  });

  it("counts steps and carries identity fields through", () => {
    const summary = summarizeSequence({
      sequenceId: "seq-1",
      name: "Nurture",
      status: "active",
      campaignType: "nurture",
      steps: [{}, {}],
      autoEnrollListIds: ["list-1"],
    });
    expect(summary).toMatchObject({
      sequence_id: "seq-1",
      name: "Nurture",
      status: "active",
      step_count: 2,
      is_sending: true,
    });
    expect(summary.audience).toContain("list-1");
  });
});
