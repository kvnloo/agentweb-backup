/**
 * Unit tests for the shared work plan step normalizer.
 *
 * The route-level suite (workPlanRoutes.userInstructions.test.ts) covers the
 * happy paths through the HTTP boundary; these pin the defensive branches a
 * route test cannot reach cleanly — malformed step entries and the
 * stepCount/title fallbacks — which the write routes rely on to never throw
 * on a payload an LLM assembled (ENG-889).
 */
import { normalizeWorkPlanSteps } from "../services/workPlanSteps";

describe("normalizeWorkPlanSteps", () => {
  it("defaults stepCount to the array position and title to a placeholder", () => {
    const { steps, warnings } = normalizeWorkPlanSteps([{ description: "no title" }, {}]);

    expect(steps[0]).toMatchObject({ stepCount: 1, title: "Step 1", description: "no title" });
    expect(steps[1]).toMatchObject({ stepCount: 2, title: "Step 2" });
    expect(warnings).toEqual([]);
  });

  it.each([
    ["null", null],
    ["a string", "step one"],
    ["an array", ["step one"]],
    ["a number", 7],
  ])("replaces %s step entry with a placeholder instead of throwing", (_label, value) => {
    const { steps, warnings } = normalizeWorkPlanSteps([value]);

    expect(steps).toEqual([
      { stepCount: 1, title: "Step 1", description: undefined, requiredFunctionCalls: [], skillIds: [] },
    ]);
    // A malformed entry has no recognizable fields to report as dropped.
    expect(warnings).toEqual([]);
  });

  it("keeps every storable field and reports nothing when all are recognized", () => {
    const { steps, warnings } = normalizeWorkPlanSteps([{
      stepCount: 4,
      title: "Generate 3 Images Per Hook",
      description: "prompt",
      userInstructions: "pick your favourites",
      requiredFunctionCalls: ["generate_image"],
      skillIds: ["skill-1"],
      expectedAssetCount: 18,
    }]);

    expect(steps[0]).toEqual({
      stepCount: 4,
      title: "Generate 3 Images Per Hook",
      description: "prompt",
      userInstructions: "pick your favourites",
      requiredFunctionCalls: ["generate_image"],
      skillIds: ["skill-1"],
      expectedAssetCount: 18,
    });
    expect(warnings).toEqual([]);
  });

  it("omits optional fields entirely rather than storing undefined", () => {
    const { steps } = normalizeWorkPlanSteps([{ stepCount: 1, title: "Step" }]);

    expect("userInstructions" in steps[0]).toBe(false);
    expect("expectedAssetCount" in steps[0]).toBe(false);
  });

  it("keeps an explicit zero asset count rather than treating it as absent", () => {
    const { steps } = normalizeWorkPlanSteps([{ stepCount: 1, title: "Step", expectedAssetCount: 0 }]);

    expect(steps[0].expectedAssetCount).toBe(0);
  });

  it("reports discarded fields per step with a 1-based pointer", () => {
    const { warnings } = normalizeWorkPlanSteps([
      { stepCount: 1, title: "Ok" },
      { stepCount: 2, title: "Bad", required_function_calls: ["x"] },
      { stepCount: 3, title: "Worse", foo: 1, bar: 2 },
    ]);

    expect(warnings).toEqual([
      "step 2: ignored unrecognized field 'required_function_calls'",
      "step 3: ignored unrecognized fields 'foo', 'bar'",
    ]);
  });

  it("returns empty results for an empty step list", () => {
    expect(normalizeWorkPlanSteps([])).toEqual({ steps: [], warnings: [] });
  });
});
