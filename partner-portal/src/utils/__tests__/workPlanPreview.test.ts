import { computeWorkPlanPreview } from "../workPlanPreview";

const baseInput = {
  planId: "plan-1",
  title: "Meta Ads",
  description: "<b>Build</b> a campaign",
  legacyCategory: "Paid Ads",
  visibility: "public",
  steps: [{ title: "Create campaign" }],
  display: {
    categories: [] as const,
    stepLabels: [] as string[],
    nextPlanIds: [] as string[],
  },
  knownPlansById: new Map<string, { title: string }>(),
};

describe("computeWorkPlanPreview", () => {
  it("falls back to plan title/description/legacy category when no display fields are set", () => {
    const result = computeWorkPlanPreview(baseInput as any);
    expect(result).toEqual(
      expect.objectContaining({
        id: "plan-1",
        title: "Meta Ads",
        summary: "Build a campaign",
        categories: ["paid-ads"],
        steps: [{ position: 1, label: "Create campaign" }],
        nextPlans: [],
      }),
    );
  });

  it("prefers display fields over legacy fallbacks when present", () => {
    const result = computeWorkPlanPreview({
      ...baseInput,
      display: {
        title: "Launch Meta Ads Fast",
        summary: "A focused custom summary.",
        categories: ["paid-ads", "strategy"],
        channel: "meta",
        stepLabels: ["Set up the ad account"],
        nextPlanIds: [],
      },
    } as any);
    expect(result.title).toBe("Launch Meta Ads Fast");
    expect(result.summary).toBe("A focused custom summary.");
    expect(result.categories).toEqual(["paid-ads", "strategy"]);
    expect(result.channel).toBe("meta");
    expect(result.steps).toEqual([{ position: 1, label: "Set up the ad account" }]);
  });

  it("resolves known next-plan ids to titles and leaves unresolved ones visible by id", () => {
    const result = computeWorkPlanPreview({
      ...baseInput,
      display: { ...baseInput.display, nextPlanIds: ["plan-2", "deleted-plan"] },
      knownPlansById: new Map([["plan-2", { title: "Landing Page Launch" }]]),
    } as any);
    expect(result.nextPlans).toEqual([
      { id: "plan-2", title: "Landing Page Launch", resolved: true },
      { id: "deleted-plan", title: "deleted-plan", resolved: false },
    ]);
  });

  it("shows a placeholder id for an unsaved (create-mode) plan", () => {
    const result = computeWorkPlanPreview({ ...baseInput, planId: undefined } as any);
    expect(result.id).toBe("(unsaved)");
  });

  it("never leaks agent-only step content — only the label/title is used", () => {
    const result = computeWorkPlanPreview({
      ...baseInput,
      steps: [{ title: "Create campaign" }],
    } as any);
    expect(JSON.stringify(result)).not.toContain("secret");
  });
});
