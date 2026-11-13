import {
  classifyUsageWaste,
  wasteRowId,
  WasteLedgerRow,
} from "../services/llmUsageWasteClassifier";

const row = (over: Partial<WasteLedgerRow>): WasteLedgerRow => ({
  userId: "u1",
  date: "2026-11-01",
  model: "claude-sonnet",
  feature: "agent_task",
  costMicroUsd: 100,
  ...over,
});

describe("ENG-2952 classifyUsageWaste", () => {
  it("returns no accounts for empty input", () => {
    expect(classifyUsageWaste([])).toEqual([]);
  });

  it("counts only interactive-tagged rows as user work", () => {
    const [acc] = classifyUsageWaste([row({ feature: "agent_task:interactive", costMicroUsd: 250 })]);
    expect(acc.userWorkMicroUsd).toBe(250);
    expect(acc.unknownMicroUsd).toBe(0);
    expect(acc.systemWasteMicroUsd).toBe(0);
  });

  it("puts scheduled rows in unknown (no output flag on the ledger), with evidence", () => {
    const r = row({ feature: "agent_task:scheduled:sched-1", costMicroUsd: 300 });
    const [acc] = classifyUsageWaste([r]);
    expect(acc.unknown.scheduledMicroUsd).toBe(300);
    expect(acc.unknown.evidenceRowIds).toEqual([wasteRowId(r)]);
    expect(acc.systemWaste.scheduled_no_output.detectable).toBe(false);
    expect(acc.systemWaste.scheduled_no_output.missingFields).toContain("user-visible output produced flag");
  });

  it("never treats a non-provenance qualifier as user work", () => {
    const [acc] = classifyUsageWaste([row({ feature: "x-account:1340767380", costMicroUsd: 40 })]);
    expect(acc.userWorkMicroUsd).toBe(0);
    expect(acc.unknown.untaggedMicroUsd).toBe(40);
  });

  it.each([
    ["retry_after_failure", "attempt number"],
    ["duplicate_tool_call", "tool-call arguments hash"],
  ] as const)("reports %s as undetectable with the missing field named and no evidence", (cls, field) => {
    const [acc] = classifyUsageWaste([row({})]);
    const c = acc.systemWaste[cls];
    expect(c).toMatchObject({ detectable: false, costMicroUsd: 0, evidenceRowIds: [] });
    expect(c.missingFields).toContain(field);
  });

  it("states quality impact unknown on every account", () => {
    const out = classifyUsageWaste([row({}), row({ userId: "u2" })]);
    expect(out.map((a) => a.qualityImpact)).toEqual(["quality impact unknown", "quality impact unknown"]);
  });

  it("reconciles exactly per account and splits accounts", () => {
    const out = classifyUsageWaste([
      row({ feature: "agent_task:interactive", costMicroUsd: 1 }),
      row({ feature: "agent_task:scheduled", costMicroUsd: 2, date: "2026-11-02" }),
      row({ feature: "onboarding:cron", costMicroUsd: 3 }),
      row({ userId: "u2", costMicroUsd: 7 }),
      row({ userId: "u2", costMicroUsd: NaN, model: "m2" }),
    ]);
    expect(out.map((a) => a.userId)).toEqual(["u1", "u2"]);
    for (const a of out) {
      expect(a.reconciles).toBe(true);
      expect(a.userWorkMicroUsd + a.systemWasteMicroUsd + a.unknownMicroUsd).toBe(a.totalCostMicroUsd);
    }
    expect(out[0].totalCostMicroUsd).toBe(6);
    expect(out[1].totalCostMicroUsd).toBe(7);
  });
});
