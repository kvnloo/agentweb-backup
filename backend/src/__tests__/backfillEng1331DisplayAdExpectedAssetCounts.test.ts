import {
  planExpectedAssetCountUpdates,
  ENG1331_EXPECTED_ASSET_COUNT_TARGETS,
} from "../scripts/backfill-eng1331-display-ad-expected-asset-counts";

/**
 * ENG-1331: this backfill writes production work-plan template data, so the policy
 * deciding WHAT to write is pinned here rather than inferred from a dry run.
 *
 * The boundary that matters: a step is only ever updated when its title matches
 * exactly what this script expects. expectedAssetCount is safety-critical in both
 * directions — too low never gates a false completion claim, too high permanently
 * blocks a step from ever completing — so a template that changed since this script
 * was written must never be silently overwritten.
 */
describe("backfill-eng1331-display-ad-expected-asset-counts — planExpectedAssetCountUpdates", () => {
  const liveSteps = [
    { stepCount: 1, title: "Intake & Master Deconstruction" },
    { stepCount: 2, title: "Copy Ladder & Token Sheet Approval" },
    { stepCount: 3, title: "Render the Full Size Matrix" },
    { stepCount: 4, title: "QA, Contact Sheet & Delivery" },
    { stepCount: 5, title: "Optional: Variant Run" },
  ];

  it("sets expectedAssetCount on the render, QA, and variant-run steps — leaves the other two untouched", () => {
    const { updatedSteps, results } = planExpectedAssetCountUpdates(liveSteps);

    expect(updatedSteps.find((s) => s.stepCount === 1)).toEqual(liveSteps[0]);
    expect(updatedSteps.find((s) => s.stepCount === 2)).toEqual(liveSteps[1]);
    expect(updatedSteps.find((s) => s.stepCount === 3)?.expectedAssetCount).toBe(12);
    expect(updatedSteps.find((s) => s.stepCount === 4)?.expectedAssetCount).toBe(1);
    expect(updatedSteps.find((s) => s.stepCount === 5)?.expectedAssetCount).toBe(12);

    // Steps 3 and 5 also name the SINGLE tool that counts — unambiguous by construction,
    // not relying on the gate's max-across-tools heuristic. Step 4's producing tool isn't
    // evidenced clearly enough in the template to name safely, so it's left unset.
    expect(updatedSteps.find((s) => s.stepCount === 3)?.expectedAssetCountTools).toEqual([
      "playwright_browser_take_screenshot",
    ]);
    expect(updatedSteps.find((s) => s.stepCount === 4)?.expectedAssetCountTools).toBeUndefined();
    expect(updatedSteps.find((s) => s.stepCount === 5)?.expectedAssetCountTools).toEqual([
      "playwright_browser_take_screenshot",
    ]);

    expect(results.map((r) => ({ stepCount: r.stepCount, action: r.action }))).toEqual([
      { stepCount: 3, action: "set" },
      { stepCount: 4, action: "set" },
      { stepCount: 5, action: "set" },
    ]);
  });

  // Step 4 is the one the ticket's own draft recommendation got wrong (proposed 12,
  // which would have made it permanently unable to complete since the gate scopes each
  // step's count to only what THAT step produced since the previous step resolved).
  it("sets step 4 (QA, Contact Sheet & Delivery) to 1, not 12", () => {
    const target = ENG1331_EXPECTED_ASSET_COUNT_TARGETS.find((t) => t.stepCount === 4);
    expect(target?.count).toBe(1);
  });

  it("reports already-set for a step that already has the correct count AND tools — does not rewrite it", () => {
    const steps = liveSteps.map((s) =>
      s.stepCount === 3
        ? { ...s, expectedAssetCount: 12, expectedAssetCountTools: ["playwright_browser_take_screenshot"] }
        : s,
    );
    const { results } = planExpectedAssetCountUpdates(steps);
    expect(results.find((r) => r.stepCount === 3)?.action).toBe("already-set");
  });

  it("still reports 'set' when the count matches but expectedAssetCountTools does not", () => {
    // The count alone matching isn't enough — an unset (or different) tools list is
    // still ambiguous relative to the target's explicit declaration.
    const steps = liveSteps.map((s) => (s.stepCount === 3 ? { ...s, expectedAssetCount: 12 } : s));
    const { results } = planExpectedAssetCountUpdates(steps);
    expect(results.find((r) => r.stepCount === 3)?.action).toBe("set");
  });

  it("flags a title mismatch and leaves that step's expectedAssetCount untouched", () => {
    const steps = liveSteps.map((s) =>
      s.stepCount === 5 ? { ...s, title: "Optional: Regenerate Set" } : s,
    );
    const { updatedSteps, results } = planExpectedAssetCountUpdates(steps);

    const step5Result = results.find((r) => r.stepCount === 5);
    expect(step5Result?.action).toBe("title-mismatch");
    expect(updatedSteps.find((s) => s.stepCount === 5)?.expectedAssetCount).toBeUndefined();
  });

  it("produces no result for a target stepCount absent from the plan entirely", () => {
    const steps = liveSteps.filter((s) => s.stepCount !== 5);
    const { results } = planExpectedAssetCountUpdates(steps);
    expect(results.some((r) => r.stepCount === 5)).toBe(false);
  });

  it("leaves non-target steps (1, 2) completely alone", () => {
    const { updatedSteps } = planExpectedAssetCountUpdates(liveSteps);
    expect(updatedSteps.filter((s) => s.stepCount === 1 || s.stepCount === 2)).toEqual([
      liveSteps[0],
      liveSteps[1],
    ]);
  });

  it("never lowers or clears an existing expectedAssetCount on a title-mismatched step", () => {
    const steps = liveSteps.map((s) =>
      s.stepCount === 3 ? { ...s, title: "Render Sizes (renamed)", expectedAssetCount: 8 } : s,
    );
    const { updatedSteps } = planExpectedAssetCountUpdates(steps);
    expect(updatedSteps.find((s) => s.stepCount === 3)?.expectedAssetCount).toBe(8);
  });
});
