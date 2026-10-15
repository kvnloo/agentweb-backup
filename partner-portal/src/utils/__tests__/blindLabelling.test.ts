import { AI_LABEL_NOTE_PREFIX, blindForHuman, isAiLabelledCase, withoutDraft } from "../blindLabelling";

const humanCase = { caseId: "h", version: 3, labels: { task_success: "pass" }, notes: "checked by hand" };
const aiCase = {
  caseId: "a",
  version: 5,
  labels: { task_success: "fail", groundedness: "pass" },
  notes: `${AI_LABEL_NOTE_PREFIX} reason text`,
  draft: { model: "m", labels: {} },
  labeller: "ai-labeller@example.com",
  labelledAt: "2026-10-14T08:10:00.000Z",
};

describe("blindLabelling", () => {
  it("recognises only notes that start with the AI marker", () => {
    expect(isAiLabelledCase(aiCase)).toBe(true);
    expect(isAiLabelledCase(humanCase)).toBe(false);
    expect(isAiLabelledCase({ notes: `see ${AI_LABEL_NOTE_PREFIX}` })).toBe(false);
    expect(isAiLabelledCase({})).toBe(false);
  });

  it("returns a human-labelled case unchanged (same object)", () => {
    expect(blindForHuman(humanCase)).toBe(humanCase);
  });

  it("hides labels, notes and the draft of an AI-labelled case but keeps its version for the save", () => {
    const blind = blindForHuman(aiCase);
    expect(blind.labels).toEqual({});
    expect(blind.notes).toBe("");
    expect("draft" in blind).toBe(false);
    expect("labeller" in blind).toBe(false);
    expect("labelledAt" in blind).toBe(false);
    expect(blind.version).toBe(5);
    expect(blind.caseId).toBe("a");
  });

  it("does not mutate the input", () => {
    blindForHuman(aiCase);
    expect(aiCase.labels).toEqual({ task_success: "fail", groundedness: "pass" });
    expect(aiCase.notes.startsWith(AI_LABEL_NOTE_PREFIX)).toBe(true);
  });

  it("works for a pairwise case", () => {
    const pair = { labels: { pairwise_preference: "A" }, notes: `${AI_LABEL_NOTE_PREFIX} x`, pair: { batch: "2026-W40" } };
    expect(blindForHuman(pair).labels).toEqual({});
  });

  it("withoutDraft drops the draft from a saved case and returns draft-less cases as they are", () => {
    const saved = { caseId: "s", labels: { task_success: "pass" }, draft: { model: "m" } };
    const out = withoutDraft(saved);
    expect("draft" in out).toBe(false);
    expect(out.labels).toEqual({ task_success: "pass" });
    expect(saved.draft).toEqual({ model: "m" });
    expect(withoutDraft(humanCase)).toBe(humanCase);
  });
});
