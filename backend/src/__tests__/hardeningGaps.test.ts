import {
  hasEmptyPrompt,
  powerToolsOf,
  needsSafetyBlock,
} from "../utils/hardeningGaps";

describe("hardeningGaps", () => {
  it("hasEmptyPrompt flags empty and whitespace-only prompts", () => {
    expect(hasEmptyPrompt({ systemPrompt: "" })).toBe(true);
    expect(hasEmptyPrompt({ systemPrompt: "   \n" })).toBe(true);
    expect(hasEmptyPrompt({ systemPrompt: undefined })).toBe(true);
    expect(hasEmptyPrompt({ systemPrompt: "You are Emma." })).toBe(false);
  });

  it("powerToolsOf returns only the high-power tools a skill holds", () => {
    expect(
      powerToolsOf({ toolNames: ["read_brand_guidelines", "linkedin_outreach", "send_email_to_lead"] }),
    ).toEqual(["linkedin_outreach", "send_email_to_lead"]);
    expect(powerToolsOf({ toolNames: ["read_brand_guidelines"] })).toEqual([]);
  });

  it("needsSafetyBlock: power tool present but no SAFETY block -> true", () => {
    expect(
      needsSafetyBlock({ toolNames: ["linkedin_outreach"], systemPrompt: "do outreach" }),
    ).toBe(true);
  });

  it("needsSafetyBlock: SAFETY block already present -> false", () => {
    expect(
      needsSafetyBlock({
        toolNames: ["linkedin_outreach"],
        systemPrompt: "do outreach\n\n## SAFETY & VOLUME LIMITS\n- caps...",
      }),
    ).toBe(false);
  });

  it("needsSafetyBlock: no power tool -> false regardless of prompt", () => {
    expect(needsSafetyBlock({ toolNames: ["read_brand_guidelines"], systemPrompt: "" })).toBe(false);
  });
});
