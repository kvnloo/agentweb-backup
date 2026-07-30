import { dedupeTargets } from "../scripts/hardenSkills";

describe("dedupeTargets", () => {
  it("merges duplicate skillIds so each skill is processed once", () => {
    const out = dedupeTargets([
      { skillId: "a", blocks: ["safety"], addTools: ["x"] },
      { skillId: "a", blocks: ["failure"], addTools: ["y"] },
      { skillId: "b", addTools: ["z"] },
    ]);
    expect(out).toHaveLength(2);
    const a = out.find((t) => t.skillId === "a")!;
    expect(a.blocks).toEqual(["safety", "failure"]);
    expect(a.addTools).toEqual(["x", "y"]);
  });

  it("de-duplicates repeated blocks/tools within the merge", () => {
    const out = dedupeTargets([
      { skillId: "a", blocks: ["safety"], addTools: ["x"] },
      { skillId: "a", blocks: ["safety"], addTools: ["x"] },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].blocks).toEqual(["safety"]);
    expect(out[0].addTools).toEqual(["x"]);
  });

  it("preserves setPrompt through dedupe (regression)", () => {
    const out = dedupeTargets([
      { skillId: "a", setPrompt: "basicSubscription" },
      { skillId: "a", blocks: ["safety"] },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].setPrompt).toBe("basicSubscription");
    expect(out[0].blocks).toEqual(["safety"]);
  });

  it("passes distinct skills through unchanged", () => {
    const out = dedupeTargets([
      { skillId: "a", addTools: ["x"] },
      { skillId: "b", blocks: ["learn"] },
    ]);
    expect(out).toHaveLength(2);
  });
});
