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

  // A value of the wrong shape is worse than a missing one: it stores fine and
  // then the consumer skips it. setWorkPlanStatus gates on
  // `typeof expectedAssetCount === "number"`, so "18" would save happily and
  // the gate would never fire — the exact silent no-op this issue is about.
  describe("values of the wrong shape", () => {
    it.each([
      ["a numeric string", "18"],
      ["a negative number", -3],
      ["a non-finite number", Number.NaN],
      ["an object", { n: 18 }],
    ])("drops and reports expectedAssetCount given %s", (_label, value) => {
      const { steps, warnings } = normalizeWorkPlanSteps([
        { stepCount: 1, title: "Step", expectedAssetCount: value },
      ]);

      expect("expectedAssetCount" in steps[0]).toBe(false);
      expect(warnings).toEqual([
        "step 1: ignored expectedAssetCount — expected a non-negative number",
      ]);
    });

    it("keeps an explicit zero, which legitimately means no requirement", () => {
      const { steps, warnings } = normalizeWorkPlanSteps([
        { stepCount: 1, title: "Step", expectedAssetCount: 0 },
      ]);

      expect(steps[0].expectedAssetCount).toBe(0);
      expect(warnings).toEqual([]);
    });

    it.each([
      ["requiredFunctionCalls"],
      ["skillIds"],
    ])("keeps the usable strings in %s and reports the rest", (field) => {
      const { steps, warnings } = normalizeWorkPlanSteps([
        { stepCount: 1, title: "Step", [field]: ["good", 123, {}, null, "also_good", ""] },
      ]);

      expect((steps[0] as any)[field]).toEqual(["good", "also_good"]);
      expect(warnings).toEqual([
        `step 1: dropped 4 non-string entries from ${field}`,
      ]);
    });

    it("reports nothing when every entry is a usable string", () => {
      const { steps, warnings } = normalizeWorkPlanSteps([
        { stepCount: 1, title: "Step", requiredFunctionCalls: ["a", "b"] },
      ]);

      expect(steps[0].requiredFunctionCalls).toEqual(["a", "b"]);
      expect(warnings).toEqual([]);
    });

    it.each([
      ["requiredFunctionCalls", "list_skills"],
      ["skillIds", "skill-1"],
    ])("falls back to an empty list and reports %s given a non-array", (field, value) => {
      const { steps, warnings } = normalizeWorkPlanSteps([
        { stepCount: 1, title: "Step", [field]: value },
      ]);

      expect((steps[0] as any)[field]).toEqual([]);
      expect(warnings).toEqual([`step 1: ignored ${field} — expected an array`]);
    });
  });

  it("returns empty results for an empty step list", () => {
    expect(normalizeWorkPlanSteps([])).toEqual({ steps: [], warnings: [] });
  });
});
