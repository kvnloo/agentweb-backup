/**
 * WS1b wire-in: negative visual directions from rejected image variants
 * are threaded into the next image generation's prompts.
 *
 * Covers:
 *   - buildSixLayerPromptForVariant appends the negative block (and skips
 *     it when empty)
 *   - generateAdImagesForUser threads deps.negativeExamples into every
 *     variant prompt and stamps `concept` on each produced variant
 *
 * Pure / injected fake image generator — no DB, no network.
 */

jest.mock("../services/db", () => ({
  userDb: { getUserById: jest.fn(), updateUser: jest.fn() },
}));

import {
  buildSixLayerPromptForVariant,
  generateAdImagesForUser,
} from "../services/onboardingAdImageService";

const brand = {
  companyName: "Linear",
  primaryColor: "#5E6AD2",
  secondaryColor: "#FFFFFF",
  fontFamily: "Inter",
  logoUrl: "https://example.com/logo.png",
  tagline: "Built for modern software teams",
  valueProposition: "Issue tracking that's actually fast",
};
const persona = {
  name: "DevTool Founder",
  pain: "no leads",
  desire: "more pipeline",
  objection: "tools are noisy",
  meta_targeting_brief: "founders, USA, 20-50",
};
const creativeDir = {
  concepts: ["VISCERAL MOMENT (VM)", "TRANSFORMATION (TR)", "SOCIAL PROOF (SP)"],
  copy_angles: ["PA", "OV", "SPL"],
  format_archetypes: ["A", "B", "C", "D"],
};

class FakeGen {
  lastPrompts: string[] = [];
  generateImage = async (params: { prompt: string; filename: string; userId: string }) => {
    this.lastPrompts.push(params.prompt);
    return { success: true, imageUrl: `https://s3.example.com/${params.filename}` };
  };
}

const fakeLoadTemplate = async (a: string) => ({
  feedLayout: `feed-${a}`,
  storyLayout: `story-${a}`,
  textBudget: `budget-${a}`,
  name: `tmpl-${a}`,
  version: "vTEST-2026-06-14",
});

const NEG_BLOCK =
  "User REJECTED these recent ad image directions — avoid this visual concept, layout, and overall style:\n- [archetype A] neon gradient hero\nSteer toward a clearly different visual concept and composition.";

describe("buildSixLayerPromptForVariant — negative examples", () => {
  const baseInputs = {
    variantIndex: 0,
    format: "1080x1080" as const,
    concept: "VISCERAL MOMENT (VM)",
    copyAngle: "PA",
    formatArchetype: "A",
    brand,
    persona,
  };

  it("appends the negative block before HARD CONSTRAINTS when provided", () => {
    const prompt = buildSixLayerPromptForVariant(baseInputs, undefined, NEG_BLOCK);
    expect(prompt).toContain("REJECTED");
    expect(prompt).toContain("neon gradient hero");
    expect(prompt.indexOf("REJECTED")).toBeLessThan(prompt.indexOf("HARD CONSTRAINTS"));
  });

  it("omits the block when negativeExamples is empty / default", () => {
    expect(buildSixLayerPromptForVariant(baseInputs)).not.toContain("REJECTED");
    expect(buildSixLayerPromptForVariant(baseInputs, undefined, "   ")).not.toContain("REJECTED");
  });
});

describe("generateAdImagesForUser — negative examples + concept stamp", () => {
  it("threads negativeExamples into every variant prompt", async () => {
    const gen = new FakeGen();
    await generateAdImagesForUser(creativeDir, brand, [persona], "user-1", {
      imageGen: gen as any,
      loadTemplate: fakeLoadTemplate as any,
      negativeExamples: NEG_BLOCK,
    });
    expect(gen.lastPrompts.length).toBeGreaterThan(0);
    for (const p of gen.lastPrompts) {
      expect(p).toContain("REJECTED");
      expect(p).toContain("neon gradient hero");
    }
  });

  it("stamps the concept label on each produced variant", async () => {
    const gen = new FakeGen();
    const result = await generateAdImagesForUser(creativeDir, brand, [persona], "user-1", {
      imageGen: gen as any,
      loadTemplate: fakeLoadTemplate as any,
    });
    expect(result.variants.length).toBeGreaterThan(0);
    for (const v of result.variants) {
      expect(typeof v.concept).toBe("string");
      expect(creativeDir.concepts).toContain(v.concept);
    }
  });

  it("produces clean prompts (no negative block) on the first run", async () => {
    const gen = new FakeGen();
    await generateAdImagesForUser(creativeDir, brand, [persona], "user-1", {
      imageGen: gen as any,
      loadTemplate: fakeLoadTemplate as any,
    });
    for (const p of gen.lastPrompts) {
      expect(p).not.toContain("REJECTED");
    }
  });
});
