import {
  BLOCKS,
  MIN_PROMPTS,
  appendBlocks,
  applyHardening,
  planSkillChange,
} from "../services/skillHardening/applyHardening";

describe("appendBlocks", () => {
  it("appends a block to an empty prompt and reports it", () => {
    const { systemPrompt, appended } = appendBlocks("", ["failure"]);
    expect(appended).toEqual(["failure"]);
    expect(systemPrompt).toContain(BLOCKS.failure.marker);
  });

  it("preserves the existing prompt text when appending", () => {
    const original = "You are a helpful outreach assistant.";
    const { systemPrompt } = appendBlocks(original, ["safety"]);
    expect(systemPrompt.startsWith(original)).toBe(true);
    expect(systemPrompt).toContain(BLOCKS.safety.marker);
  });

  it("is idempotent — re-appending an already-present block is a no-op", () => {
    const first = appendBlocks("base prompt", ["safety", "failure"]);
    const second = appendBlocks(first.systemPrompt, ["safety", "failure"]);
    expect(second.appended).toEqual([]);
    expect(second.systemPrompt).toBe(first.systemPrompt);
  });

  it("only appends the blocks that are missing", () => {
    const first = appendBlocks("base", ["safety"]);
    const second = appendBlocks(first.systemPrompt, ["safety", "learn"]);
    expect(second.appended).toEqual(["learn"]);
    // exactly one occurrence of each marker
    const count = (h: string, n: string) => h.split(n).length - 1;
    expect(count(second.systemPrompt, BLOCKS.safety.marker)).toBe(1);
    expect(count(second.systemPrompt, BLOCKS.learn.marker)).toBe(1);
  });

  it("throws on an unknown block key", () => {
    expect(() => appendBlocks("base", ["nope"])).toThrow(/unknown hardening block/i);
  });

  it("treats an undefined prompt as empty", () => {
    const { systemPrompt, appended } = appendBlocks(undefined, ["context"]);
    expect(appended).toEqual(["context"]);
    expect(systemPrompt).toContain(BLOCKS.context.marker);
  });
});

describe("applyHardening", () => {
  it("returns changed=true with the appended keys and a new row, leaving the input untouched", () => {
    const skill = { skillId: "s1", systemPrompt: "orig" } as any;
    const res = applyHardening(skill, ["safety", "failure"]);
    expect(res.changed).toBe(true);
    expect(res.appended).toEqual(["safety", "failure"]);
    expect(res.skill.systemPrompt).toContain(BLOCKS.safety.marker);
    expect(res.skill.systemPrompt).toContain(BLOCKS.failure.marker);
    // input not mutated
    expect(skill.systemPrompt).toBe("orig");
  });

  it("returns changed=false when all blocks already present", () => {
    const skill = { skillId: "s1", systemPrompt: "orig" } as any;
    const once = applyHardening(skill, ["safety"]);
    const twice = applyHardening(once.skill, ["safety"]);
    expect(twice.changed).toBe(false);
    expect(twice.appended).toEqual([]);
  });
});

describe("planSkillChange", () => {
  it("combines block append and toolNames additions (Brand Strategy shape)", () => {
    const skill = {
      skillId: "brand",
      toolNames: ["read_brand_guidelines", "read_market_strategy"],
      systemPrompt: "Use you_search_web.",
    } as any;
    const res = planSkillChange(skill, {
      skillId: "brand",
      addTools: ["you_search_web", "search_knowledge_base"],
    });
    expect(res.addedTools).toEqual(["you_search_web", "search_knowledge_base"]);
    expect(res.skill.toolNames).toEqual([
      "read_brand_guidelines",
      "read_market_strategy",
      "you_search_web",
      "search_knowledge_base",
    ]);
    expect(res.changed).toBe(true);
  });

  it("does not re-add tools already declared (idempotent)", () => {
    const skill = { skillId: "s", toolNames: ["a_tool"], systemPrompt: "" } as any;
    const res = planSkillChange(skill, { skillId: "s", addTools: ["a_tool"] });
    expect(res.addedTools).toEqual([]);
    expect(res.changed).toBe(false);
    expect(res.skill.toolNames).toEqual(["a_tool"]);
  });

  it("applies blocks and tools together and reports both", () => {
    const skill = { skillId: "s", toolNames: [], systemPrompt: "base" } as any;
    const res = planSkillChange(skill, {
      skillId: "s",
      blocks: ["safety"],
      addTools: ["list_connected_accounts"],
    });
    expect(res.appended).toEqual(["safety"]);
    expect(res.addedTools).toEqual(["list_connected_accounts"]);
    expect(res.skill.systemPrompt).toContain(BLOCKS.safety.marker);
  });
});

describe("planSkillChange setPrompt (Blindspot 4 empty prompts)", () => {
  it("fills an empty systemPrompt with the named min-prompt", () => {
    const skill = { skillId: "s", toolNames: [], systemPrompt: "" } as any;
    const res = planSkillChange(skill, { skillId: "s", setPrompt: "basicSubscription" });
    expect(res.promptSet).toBe(true);
    expect(res.changed).toBe(true);
    expect(res.skill.systemPrompt).toBe(MIN_PROMPTS.basicSubscription);
  });

  it("does NOT overwrite a skill that already has a systemPrompt", () => {
    const skill = { skillId: "s", toolNames: [], systemPrompt: "existing prompt" } as any;
    const res = planSkillChange(skill, { skillId: "s", setPrompt: "googleCalendar" });
    expect(res.promptSet).toBe(false);
    expect(res.changed).toBe(false);
    expect(res.skill.systemPrompt).toBe("existing prompt");
  });

  it("treats a whitespace-only prompt as empty", () => {
    const skill = { skillId: "s", toolNames: [], systemPrompt: "   \n " } as any;
    const res = planSkillChange(skill, { skillId: "s", setPrompt: "crmDraft" });
    expect(res.promptSet).toBe(true);
    expect(res.skill.systemPrompt).toBe(MIN_PROMPTS.crmDraft);
  });

  it("throws on an unknown min-prompt key", () => {
    const skill = { skillId: "s", toolNames: [], systemPrompt: "" } as any;
    expect(() => planSkillChange(skill, { skillId: "s", setPrompt: "nope" })).toThrow(/unknown min-prompt/i);
  });

  it("sets the prompt then appends blocks + tools in one plan", () => {
    const skill = { skillId: "s", toolNames: [], systemPrompt: "" } as any;
    const res = planSkillChange(skill, {
      skillId: "s",
      setPrompt: "meetingIntelligence",
      blocks: ["failure"],
      addTools: ["x_tool"],
    });
    expect(res.promptSet).toBe(true);
    expect(res.skill.systemPrompt).toContain("meeting intelligence");
    expect(res.skill.systemPrompt).toContain(BLOCKS.failure.marker);
    expect(res.addedTools).toEqual(["x_tool"]);
  });
});
