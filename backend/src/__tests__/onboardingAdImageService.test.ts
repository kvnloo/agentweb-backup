/**
 * Onboarding Epic Phase 2 — Ad image service tests (Brick 8 / Step 5).
 *
 * Pure unit tests against an injected fake image generator. Asserts:
 *   - waits for creativeDirStatus === 'ready'
 *   - generates 3 variants in parallel
 *   - 6-layer prompt is built correctly (FORMAT / SETTING / FOCAL / TEXT / BADGE / STYLE)
 *   - 60/40 format split (1080x1080 vs 1080x1350) across the 3 variants
 *   - per-variant timeout patches that variant with placeholder, doesn't kill the run
 *   - partial failure (2/3 succeed) still returns ready with the survivors
 *   - brand colors / typography / logo flow into the prompt
 *   - patches User via adImageReadyPatch / adImageFailedPatch
 */

jest.mock("../services/db", () => ({
  userDb: {
    getUserById: jest.fn(),
    updateUser: jest.fn(),
  },
  // Org-aware brand resolution (ENG-326): org members' brandGuidelines live
  // on the ORG record — the trigger resolves through orgDb for them.
  orgDb: {
    getOrgById: jest.fn(),
  },
}));

// Mock the chat-session mirror so the success path stays testable as
// "exactly one userDb.updateUser call". The mirror is exercised by its
// own dedicated test file (onboardingAdImageChatSessionMirror.test.ts).
// Without this mock, ChatbotDB.createChatSession fires a real
// userDb.updateUser({ lastActiveAt }) which inflates the call count
// here and makes the existing assertions on updateUser.mock.calls[0]
// pick up the wrong write. The mock returns a stable sessionId so the
// caller can still fold `adImageChatSessionId` into the ready patch.
jest.mock("../services/onboardingAdImageChatSessionMirror", () => ({
  mirrorOnboardingAdImagesToChatSession: jest
    .fn()
    .mockResolvedValue("mocked-onboarding-session-id"),
}));

import {
  AD_IMAGE_SYSTEM_PROMPT,
  buildSixLayerPromptForVariant,
  extractAdImageBrandContext,
  generateAdImagesForUser,
  isBrandLogoFetchable,
  pickFormatSplit,
  startAdImageGenerationForUser,
  triggerAdImageGenerationForUser,
} from "../services/onboardingAdImageService";
const { userDb, orgDb } = require("../services/db");

class FakeImageGen {
  public callCount = 0;
  public lastPrompts: string[] = [];
  public lastParams: Array<{ prompt: string; filename: string; userId: string; size?: string; imageModel?: string; logoImage?: string }> = [];

  constructor(
    private readonly responder: (n: number, prompt: string) => Promise<{
      success: boolean;
      imageUrl?: string;
      error?: string;
    }>
  ) {}

  generateImage = async (params: { prompt: string; filename: string; userId: string; size?: string; imageModel?: string; logoImage?: string }) => {
    this.callCount += 1;
    this.lastPrompts.push(params.prompt);
    this.lastParams.push(params);
    return this.responder(this.callCount, params.prompt);
  };
}

const okResponder = async (n: number) => ({
  success: true,
  imageUrl: `https://s3.example.com/ad-image-${n}.png`,
});

const onePersona = {
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
const brand = {
  companyName: "Linear",
  primaryColor: "#5E6AD2",
  secondaryColor: "#FFFFFF",
  fontFamily: "Inter",
  logoUrl: "https://example.com/logo.png",
  tagline: "Built for modern software teams",
  valueProposition: "Issue tracking that's actually fast",
};

describe("onboardingAdImageService", () => {
  describe("AD_IMAGE_SYSTEM_PROMPT", () => {
    it("contains the verbatim Brick 8 6-layer markers from the prod work plan", () => {
      // The 6 layer headers must all appear verbatim — the LLM relies on this
      // structure. If the prod plan changes the layer names, this test catches
      // the drift.
      expect(AD_IMAGE_SYSTEM_PROMPT).toContain("BRICK 8");
      expect(AD_IMAGE_SYSTEM_PROMPT).toContain("LAYER 1: FORMAT & DIMENSIONS");
      expect(AD_IMAGE_SYSTEM_PROMPT).toContain("LAYER 2: BACKGROUND / SETTING");
      expect(AD_IMAGE_SYSTEM_PROMPT).toContain("LAYER 3: SUBJECT / FOCAL POINT");
      expect(AD_IMAGE_SYSTEM_PROMPT).toContain("LAYER 4");
      expect(AD_IMAGE_SYSTEM_PROMPT).toContain("LAYER 5");
      expect(AD_IMAGE_SYSTEM_PROMPT).toContain("LAYER 6");
      expect(AD_IMAGE_SYSTEM_PROMPT).toContain("1080x1080");
      expect(AD_IMAGE_SYSTEM_PROMPT).toContain("1080");
    });
  });

  describe("pickFormatSplit", () => {
    it("returns 60/40 split across 3 variants — 2x square, 1x vertical", () => {
      const split = pickFormatSplit(3);
      expect(split).toHaveLength(3);
      const squares = split.filter((s) => s === "1080x1080").length;
      const verticals = split.filter((s) => s === "1080x1350").length;
      expect(squares).toBe(2); // 60% rounded
      expect(verticals).toBe(1); // 40% rounded
    });

    it("returns single square for n=1 (60% wins)", () => {
      const split = pickFormatSplit(1);
      expect(split).toEqual(["1080x1080"]);
    });

    it("handles n=0 (no variants)", () => {
      expect(pickFormatSplit(0)).toEqual([]);
    });

    it("handles n=2 — 1 square, 1 vertical", () => {
      const split = pickFormatSplit(2);
      expect(split).toHaveLength(2);
      expect(split).toContain("1080x1080");
      expect(split).toContain("1080x1350");
    });

    it("returns 0 for negative or non-finite n (defensive)", () => {
      expect(pickFormatSplit(-1)).toEqual([]);
      expect(pickFormatSplit(NaN as any)).toEqual([]);
    });
  });

  describe("buildSixLayerPromptForVariant", () => {
    it("includes all 6 layers in order", () => {
      const prompt = buildSixLayerPromptForVariant({
        variantIndex: 0,
        format: "1080x1080",
        concept: "VISCERAL MOMENT (VM)",
        copyAngle: "PA",
        formatArchetype: "A",
        brand,
        persona: onePersona,
      });
      // Layers must appear in this order
      const layer1 = prompt.indexOf("LAYER 1");
      const layer2 = prompt.indexOf("LAYER 2");
      const layer3 = prompt.indexOf("LAYER 3");
      const layer4 = prompt.indexOf("LAYER 4");
      const layer5 = prompt.indexOf("LAYER 5");
      const layer6 = prompt.indexOf("LAYER 6");
      expect(layer1).toBeGreaterThan(-1);
      expect(layer2).toBeGreaterThan(layer1);
      expect(layer3).toBeGreaterThan(layer2);
      expect(layer4).toBeGreaterThan(layer3);
      expect(layer5).toBeGreaterThan(layer4);
      expect(layer6).toBeGreaterThan(layer5);
    });

    it("embeds the brand primaryColor hex code (Layer 5 — color & brand)", () => {
      const prompt = buildSixLayerPromptForVariant({
        variantIndex: 0,
        format: "1080x1080",
        concept: "VM",
        copyAngle: "PA",
        formatArchetype: "A",
        brand,
        persona: onePersona,
      });
      expect(prompt).toContain("#5E6AD2");
    });

    it("embeds the brand fontFamily and companyName", () => {
      const prompt = buildSixLayerPromptForVariant({
        variantIndex: 0,
        format: "1080x1080",
        concept: "VM",
        copyAngle: "PA",
        formatArchetype: "A",
        brand,
        persona: onePersona,
      });
      expect(prompt).toContain("Inter");
      expect(prompt).toContain("Linear");
    });

    it("embeds the format dimensions in Layer 1", () => {
      const prompt = buildSixLayerPromptForVariant({
        variantIndex: 1,
        format: "1080x1350",
        concept: "VM",
        copyAngle: "PA",
        formatArchetype: "A",
        brand,
        persona: onePersona,
      });
      expect(prompt).toContain("1080x1350");
    });

    it("embeds the persona's pain in Layer 3 (focal point)", () => {
      const prompt = buildSixLayerPromptForVariant({
        variantIndex: 0,
        format: "1080x1080",
        concept: "VM",
        copyAngle: "PA",
        formatArchetype: "A",
        brand,
        persona: onePersona,
      });
      expect(prompt).toContain("no leads");
    });

    it("embeds the concept and copyAngle so the visual reflects the strategy", () => {
      const prompt = buildSixLayerPromptForVariant({
        variantIndex: 2,
        format: "1080x1080",
        concept: "TRANSFORMATION (TR)",
        copyAngle: "OV",
        formatArchetype: "B",
        brand,
        persona: onePersona,
      });
      expect(prompt).toContain("TRANSFORMATION");
      expect(prompt).toContain("OV");
    });

    it("falls back to safe defaults when brand color/font missing", () => {
      const prompt = buildSixLayerPromptForVariant({
        variantIndex: 0,
        format: "1080x1080",
        concept: "VM",
        copyAngle: "PA",
        formatArchetype: "A",
        brand: { companyName: "Acme" } as any,
        persona: onePersona,
      });
      // Defaults: black hex / Inter font / no logo block
      expect(prompt).toContain("Acme");
      // Should still mention typography even without an explicit font
      expect(prompt.toLowerCase()).toContain("typography");
    });

    it("emits the brand fallback wordmark 'Your brand' when companyName is missing", () => {
      const prompt = buildSixLayerPromptForVariant({
        variantIndex: 0,
        format: "1080x1080",
        concept: "VM",
        copyAngle: "PA",
        formatArchetype: "A",
        brand: {} as any,
        persona: onePersona,
      });
      // The prompt builder swaps any missing companyName for "Your brand"
      // and emits it inside the Layer 5 wordmark fallback line. Previous
      // builder used "(not provided)" but that placeholder text could
      // get rendered onto the canvas by Gemini — "Your brand" is a safer
      // generic that reads naturally if it leaks through.
      expect(prompt).toContain("Your brand");
    });
  });

  describe("generateAdImagesForUser", () => {
    it("generates 3 image variants in parallel via Promise.all", async () => {
      const gen = new FakeImageGen(okResponder);
      const result = await generateAdImagesForUser(
        creativeDir,
        brand,
        [onePersona],
        "user-1",
        { imageGen: gen as any }
      );
      expect(gen.callCount).toBe(3);
      expect(result.variants).toHaveLength(3);
      for (const v of result.variants) {
        expect(typeof v.id).toBe("string");
        expect(typeof v.imageUrl).toBe("string");
        expect(typeof v.prompt).toBe("string");
        expect(v.imageUrl.length).toBeGreaterThan(0);
      }
    });

    it("uses 60/40 format split — 2 squares, 1 vertical", async () => {
      const gen = new FakeImageGen(okResponder);
      await generateAdImagesForUser(
        creativeDir,
        brand,
        [onePersona],
        "user-1",
        { imageGen: gen as any }
      );
      const squarePrompts = gen.lastPrompts.filter((p) => p.includes("1080x1080"));
      const verticalPrompts = gen.lastPrompts.filter((p) => p.includes("1080x1350"));
      expect(squarePrompts).toHaveLength(2);
      expect(verticalPrompts).toHaveLength(1);
    });

    it("each variant gets a distinct concept (decorrelated test set)", async () => {
      const gen = new FakeImageGen(okResponder);
      await generateAdImagesForUser(
        creativeDir,
        brand,
        [onePersona],
        "user-1",
        { imageGen: gen as any }
      );
      // The 3 prompts should include different concept tags from creativeDir.concepts
      const conceptHits = creativeDir.concepts
        .slice(0, 3)
        .map((c) => gen.lastPrompts.filter((p) => p.includes(c.split(" ")[0])).length);
      // At least 2 of the 3 concepts should be uniquely present
      const distinctConcepts = conceptHits.filter((h) => h > 0).length;
      expect(distinctConcepts).toBeGreaterThanOrEqual(2);
    });

    it("handles partial failure — 2/3 succeed → returns 3 variants with placeholder for failed", async () => {
      let attempt = 0;
      const flakyGen = new FakeImageGen(async () => {
        attempt += 1;
        if (attempt === 2) {
          return { success: false, error: "rate limited" };
        }
        return { success: true, imageUrl: `https://s3/ok-${attempt}.png` };
      });
      const result = await generateAdImagesForUser(
        creativeDir,
        brand,
        [onePersona],
        "user-1",
        { imageGen: flakyGen as any }
      );
      expect(result.variants).toHaveLength(3);
      // All 3 variants present; the 1 failure carries a placeholder URL
      const placeholders = result.variants.filter((v) =>
        v.imageUrl.includes("placeholder") || v.imageUrl === ""
      );
      expect(placeholders.length).toBeGreaterThanOrEqual(1);
    });

    it("handles total failure — all 3 fail → returns 3 variants all placeholders, doesn't throw", async () => {
      const allFailGen = new FakeImageGen(async () => ({
        success: false,
        error: "service down",
      }));
      const result = await generateAdImagesForUser(
        creativeDir,
        brand,
        [onePersona],
        "user-1",
        { imageGen: allFailGen as any }
      );
      expect(result.variants).toHaveLength(3);
      for (const v of result.variants) {
        expect(v.imageUrl.includes("placeholder") || v.imageUrl === "").toBe(true);
      }
    });

    it("respects per-variant timeout — slow variant patches with placeholder, doesn't block others", async () => {
      // First call resolves immediately, second hangs past timeout, third resolves immediately
      let n = 0;
      const slowGen = {
        generateImage: async (_p: any) => {
          n += 1;
          if (n === 2) {
            // Hang well past the test timeout (real hard timeout is 180s, we
            // override it via deps.timeoutMs to 50ms for this test).
            await new Promise((resolve) => setTimeout(resolve, 5000));
            return { success: true, imageUrl: "https://s3/late.png" };
          }
          return { success: true, imageUrl: `https://s3/fast-${n}.png` };
        },
      };
      const start = Date.now();
      const result = await generateAdImagesForUser(
        creativeDir,
        brand,
        [onePersona],
        "user-1",
        { imageGen: slowGen as any, timeoutMs: 50 }
      );
      const elapsed = Date.now() - start;
      // Total time should be much less than the 5-second hang because the slow
      // variant is timed out at 50ms.
      expect(elapsed).toBeLessThan(2000);
      expect(result.variants).toHaveLength(3);
      // Exactly one variant has the placeholder; the others are real URLs
      const placeholders = result.variants.filter((v) =>
        v.imageUrl.includes("placeholder")
      );
      expect(placeholders).toHaveLength(1);
    }, 10000);

    it("works without a persona (brand-level only)", async () => {
      const gen = new FakeImageGen(okResponder);
      const result = await generateAdImagesForUser(
        creativeDir,
        brand,
        [],
        "user-1",
        { imageGen: gen as any }
      );
      expect(gen.callCount).toBe(3);
      expect(result.variants).toHaveLength(3);
    });

    it("works with no creative-direction concepts (fallback to defaults)", async () => {
      const gen = new FakeImageGen(okResponder);
      const result = await generateAdImagesForUser(
        { concepts: [], copy_angles: [], format_archetypes: [] },
        brand,
        [onePersona],
        "user-1",
        { imageGen: gen as any }
      );
      expect(result.variants).toHaveLength(3);
    });
  });

  describe("triggerAdImageGenerationForUser (fire-and-forget)", () => {
    beforeEach(() => {
      jest.clearAllMocks();
    });

    it("returns silently when user is missing", async () => {
      userDb.getUserById.mockResolvedValue(null);
      await triggerAdImageGenerationForUser("missing");
      expect(userDb.updateUser).not.toHaveBeenCalled();
    });

    it("fails the run when creativeDirStatus is not 'ready'", async () => {
      userDb.getUserById
        .mockResolvedValueOnce({
          userId: "u1",
          creativeDirStatus: "running",
          icpResult: [onePersona],
        })
        .mockResolvedValueOnce({
          userId: "u1",
          adImageStatus: "running",
          adImageStartedAt: new Date().toISOString(),
        });
      userDb.updateUser.mockResolvedValue({});
      const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
      const gen = new FakeImageGen(okResponder);
      await triggerAdImageGenerationForUser("u1", {
        imageGen: gen as any,
        verifyLogoUrl: async () => true,
      });
      errSpy.mockRestore();

      expect(userDb.updateUser).toHaveBeenCalledTimes(1);
      const written = userDb.updateUser.mock.calls[0][1];
      expect(written.adImageStatus).toBe("failed");
      expect(written.adImageError).toMatch(/creative|ready/i);
      expect(gen.callCount).toBe(0);
    });

    it("treats missing creativeDirStatus as idle and fails", async () => {
      userDb.getUserById
        .mockResolvedValueOnce({
          userId: "u1",
          icpResult: [onePersona],
        })
        .mockResolvedValueOnce({ userId: "u1", adImageStatus: "running" });
      userDb.updateUser.mockResolvedValue({});
      const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
      const gen = new FakeImageGen(okResponder);
      await triggerAdImageGenerationForUser("u1", {
        imageGen: gen as any,
        verifyLogoUrl: async () => true,
      });
      errSpy.mockRestore();
      const written = userDb.updateUser.mock.calls[0][1];
      expect(written.adImageStatus).toBe("failed");
      expect(written.adImageError).toMatch(/idle/i);
    });

    it("uses {} fallback on the gate failure path when getUserById returns null on second read", async () => {
      userDb.getUserById
        .mockResolvedValueOnce({ userId: "u1", creativeDirStatus: "running" })
        .mockResolvedValueOnce(null);
      userDb.updateUser.mockResolvedValue({});
      const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
      const gen = new FakeImageGen(okResponder);
      await triggerAdImageGenerationForUser("u1", {
        imageGen: gen as any,
        verifyLogoUrl: async () => true,
      });
      errSpy.mockRestore();
      expect(userDb.updateUser).toHaveBeenCalledTimes(1);
      expect(userDb.updateUser.mock.calls[0][1].adImageStatus).toBe("failed");
    });

    it("patches User with adImageReadyPatch on full success and composites the persisted logo (AC-2)", async () => {
      userDb.getUserById
        .mockResolvedValueOnce({
          userId: "u1",
          creativeDirStatus: "ready",
          creativeDirResult: creativeDir,
          icpResult: [onePersona],
          brandGuidelines: {
            brandData: { brandName: "Linear", primaryColor: "#5E6AD2", logoUrl: "https://s3/brand/logo.png" },
          },
        })
        .mockResolvedValueOnce({
          userId: "u1",
          adImageStatus: "running",
          adImageStartedAt: new Date().toISOString(),
        });
      userDb.updateUser.mockResolvedValue({});
      const gen = new FakeImageGen(okResponder);
      await triggerAdImageGenerationForUser("u1", {
        imageGen: gen as any,
        verifyLogoUrl: async () => true,
      });
      expect(userDb.updateUser).toHaveBeenCalledTimes(1);
      const written = userDb.updateUser.mock.calls[0][1];
      expect(written.adImageStatus).toBe("ready");
      expect(written.adImageResult.variants).toHaveLength(3);
      // Every variant call composited the REAL persisted logo as an image input.
      expect(gen.lastParams).toHaveLength(3);
      for (const p of gen.lastParams) {
        expect(p.logoImage).toBe("https://s3/brand/logo.png");
      }
    });

    it("fails the run pointing at brand config when no logo is persisted — never generates (AC-3)", async () => {
      userDb.getUserById
        .mockResolvedValueOnce({
          userId: "u1",
          creativeDirStatus: "ready",
          creativeDirResult: creativeDir,
          icpResult: [onePersona],
          brandGuidelines: { brandData: { brandName: "Linear", primaryColor: "#5E6AD2" } },
        })
        .mockResolvedValueOnce({
          userId: "u1",
          adImageStatus: "running",
          adImageStartedAt: new Date().toISOString(),
        });
      userDb.updateUser.mockResolvedValue({});
      const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
      const gen = new FakeImageGen(okResponder);
      await triggerAdImageGenerationForUser("u1", {
        imageGen: gen as any,
        verifyLogoUrl: async () => true,
      });
      errSpy.mockRestore();

      expect(gen.callCount).toBe(0);
      expect(userDb.updateUser).toHaveBeenCalledTimes(1);
      const written = userDb.updateUser.mock.calls[0][1];
      expect(written.adImageStatus).toBe("failed");
      expect(written.adImageError).toMatch(/logo/i);
      expect(written.adImageError).toMatch(/brand/i);
    });

    it("fails the run when the persisted logo URL is present but unfetchable — never ships broken placeholders (ENG-792)", async () => {
      // Reproduces the reported bug: the account's logo is a Google
      // favicon-service URL that 301→404s for a domain with no crawlable
      // favicon, so every variant's input-image fetch throws. Before the fix
      // the run shipped 3 placeholders as "ready"; now the unfetchable logo is
      // treated like a missing one and the run fails with an actionable error.
      userDb.getUserById
        .mockResolvedValueOnce({
          userId: "u1",
          creativeDirStatus: "ready",
          creativeDirResult: creativeDir,
          icpResult: [onePersona],
          brandGuidelines: {
            brandData: {
              brandName: "DramaBreak",
              logoUrl:
                "https://www.google.com/s2/favicons?domain=dramabreak.ai&sz=128",
            },
          },
        })
        .mockResolvedValueOnce({
          userId: "u1",
          adImageStatus: "running",
          adImageStartedAt: new Date().toISOString(),
        });
      userDb.updateUser.mockResolvedValue({});
      const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
      const gen = new FakeImageGen(okResponder);
      await triggerAdImageGenerationForUser("u1", {
        imageGen: gen as any,
        // The persisted favicon URL fails the real preflight; simulate that.
        verifyLogoUrl: async () => false,
      });
      errSpy.mockRestore();

      expect(gen.callCount).toBe(0);
      expect(userDb.updateUser).toHaveBeenCalledTimes(1);
      const written = userDb.updateUser.mock.calls[0][1];
      expect(written.adImageStatus).toBe("failed");
      expect(written.adImageError).toMatch(/logo/i);
      expect(written.adImageError).toMatch(/re-upload|brand config/i);
    });

    it("resolves the ORG brandGuidelines for org members — an org-level logo satisfies the gate", async () => {
      // ensureBrandLogoPersisted and manual brand-config uploads both write
      // the ORG record for org members (updateBrandGuidelines is org-aware).
      // The gate must read the same record, or the failure message "upload
      // your logo in brand config, then regenerate" is a permanent dead end.
      userDb.getUserById
        .mockResolvedValueOnce({
          userId: "u1",
          orgId: "org1",
          creativeDirStatus: "ready",
          creativeDirResult: creativeDir,
          icpResult: [onePersona],
          // Nothing on the user record — the logo lives on the org.
        })
        .mockResolvedValueOnce({
          userId: "u1",
          adImageStatus: "running",
          adImageStartedAt: new Date().toISOString(),
        });
      orgDb.getOrgById.mockResolvedValue({
        orgId: "org1",
        brandGuidelines: {
          brandData: { brandName: "Linear", primaryColor: "#5E6AD2" },
          attachments: [{ type: "logo", url: "https://s3/org/logo.png" }],
        },
      });
      userDb.updateUser.mockResolvedValue({});
      const gen = new FakeImageGen(okResponder);
      await triggerAdImageGenerationForUser("u1", {
        imageGen: gen as any,
        verifyLogoUrl: async () => true,
      });

      expect(orgDb.getOrgById).toHaveBeenCalledWith("org1");
      const written = userDb.updateUser.mock.calls[0][1];
      expect(written.adImageStatus).toBe("ready");
      expect(gen.lastParams).toHaveLength(3);
      for (const p of gen.lastParams) {
        expect(p.logoImage).toBe("https://s3/org/logo.png");
      }
    });

    it("org logo wins over a stale user-record logo for org members", async () => {
      userDb.getUserById
        .mockResolvedValueOnce({
          userId: "u1",
          orgId: "org1",
          creativeDirStatus: "ready",
          creativeDirResult: creativeDir,
          icpResult: [onePersona],
          brandGuidelines: {
            brandData: { brandName: "Linear", logoUrl: "https://s3/stale-user.png" },
          },
        })
        .mockResolvedValueOnce({
          userId: "u1",
          adImageStatus: "running",
          adImageStartedAt: new Date().toISOString(),
        });
      orgDb.getOrgById.mockResolvedValue({
        orgId: "org1",
        brandGuidelines: {
          brandData: { brandName: "Linear" },
          attachments: [{ type: "logo", url: "https://s3/org/current.png" }],
        },
      });
      userDb.updateUser.mockResolvedValue({});
      const gen = new FakeImageGen(okResponder);
      await triggerAdImageGenerationForUser("u1", {
        imageGen: gen as any,
        verifyLogoUrl: async () => true,
      });

      expect(gen.lastParams[0].logoImage).toBe("https://s3/org/current.png");
    });

    it("finds the persisted logo on the attachments store for the gate (canonical write path)", async () => {
      userDb.getUserById
        .mockResolvedValueOnce({
          userId: "u1",
          creativeDirStatus: "ready",
          creativeDirResult: creativeDir,
          icpResult: [onePersona],
          brandGuidelines: {
            brandData: { brandName: "Linear" },
            attachments: [{ type: "logo", url: "https://s3/att/logo.png", filename: "logo.png" }],
          },
        })
        .mockResolvedValueOnce({
          userId: "u1",
          adImageStatus: "running",
          adImageStartedAt: new Date().toISOString(),
        });
      userDb.updateUser.mockResolvedValue({});
      const gen = new FakeImageGen(okResponder);
      await triggerAdImageGenerationForUser("u1", {
        imageGen: gen as any,
        verifyLogoUrl: async () => true,
      });
      const written = userDb.updateUser.mock.calls[0][1];
      expect(written.adImageStatus).toBe("ready");
      expect(gen.lastParams[0].logoImage).toBe("https://s3/att/logo.png");
    });

    it("drops the ready patch silently when user is no longer running", async () => {
      userDb.getUserById
        .mockResolvedValueOnce({
          userId: "u1",
          creativeDirStatus: "ready",
          creativeDirResult: creativeDir,
          icpResult: [onePersona],
          brandGuidelines: { brandData: { logoUrl: "https://s3/brand/logo.png" } },
        })
        .mockResolvedValueOnce({ userId: "u1", adImageStatus: "idle" });
      userDb.updateUser.mockResolvedValue({});
      const gen = new FakeImageGen(okResponder);
      await triggerAdImageGenerationForUser("u1", {
        imageGen: gen as any,
        verifyLogoUrl: async () => true,
      });
      expect(userDb.updateUser).not.toHaveBeenCalled();
    });

    it("patches with adImageFailedPatch when image generator throws", async () => {
      userDb.getUserById
        .mockResolvedValueOnce({
          userId: "u1",
          creativeDirStatus: "ready",
          creativeDirResult: creativeDir,
          icpResult: [onePersona],
          brandGuidelines: { brandData: { logoUrl: "https://s3/brand/logo.png" } },
        })
        .mockResolvedValueOnce({ userId: "u1", adImageStatus: "running" });
      userDb.updateUser.mockResolvedValue({});
      const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
      const throwingGen = {
        generateImage: async () => {
          throw new Error("hard crash inside generator");
        },
      };
      // The orchestrator wraps each variant in its own try/catch — a thrown
      // error becomes a placeholder, NOT a failed run. Verify the run still
      // ends in 'ready' with placeholders. (Hard failures are routed via the
      // partial-failure path because we always want the UI to render
      // something.)
      await triggerAdImageGenerationForUser("u1", {
        imageGen: throwingGen as any,
        verifyLogoUrl: async () => true,
      });
      errSpy.mockRestore();
      const written = userDb.updateUser.mock.calls[0][1];
      expect(written.adImageStatus).toBe("ready");
      expect(written.adImageResult.variants).toHaveLength(3);
    });

    it("falls back to empty personas when icpResult is non-array", async () => {
      userDb.getUserById
        .mockResolvedValueOnce({
          userId: "u1",
          creativeDirStatus: "ready",
          creativeDirResult: creativeDir,
          icpResult: "not-an-array" as any,
          brandGuidelines: { brandData: { logoUrl: "https://s3/brand/logo.png" } },
        })
        .mockResolvedValueOnce({ userId: "u1", adImageStatus: "running" });
      userDb.updateUser.mockResolvedValue({});
      const gen = new FakeImageGen(okResponder);
      await triggerAdImageGenerationForUser("u1", {
        imageGen: gen as any,
        verifyLogoUrl: async () => true,
      });
      expect(userDb.updateUser.mock.calls[0][1].adImageStatus).toBe("ready");
    });

    it("falls back to empty creativeDir when persisted as null", async () => {
      userDb.getUserById
        .mockResolvedValueOnce({
          userId: "u1",
          creativeDirStatus: "ready",
          creativeDirResult: null,
          icpResult: [onePersona],
          brandGuidelines: { brandData: { logoUrl: "https://s3/brand/logo.png" } },
        })
        .mockResolvedValueOnce({ userId: "u1", adImageStatus: "running" });
      userDb.updateUser.mockResolvedValue({});
      const gen = new FakeImageGen(okResponder);
      await triggerAdImageGenerationForUser("u1", {
        imageGen: gen as any,
        verifyLogoUrl: async () => true,
      });
      expect(userDb.updateUser.mock.calls[0][1].adImageStatus).toBe("ready");
    });

    it("uses {} fallback when getUserById returns null on second read (success path)", async () => {
      userDb.getUserById
        .mockResolvedValueOnce({
          userId: "u1",
          creativeDirStatus: "ready",
          creativeDirResult: creativeDir,
          icpResult: [onePersona],
          brandGuidelines: { brandData: { logoUrl: "https://s3/brand/logo.png" } },
        })
        .mockResolvedValueOnce(null);
      userDb.updateUser.mockResolvedValue({});
      const gen = new FakeImageGen(okResponder);
      await triggerAdImageGenerationForUser("u1", {
        imageGen: gen as any,
        verifyLogoUrl: async () => true,
      });
      // Patch returned null because current was {} → updateUser not called
      expect(userDb.updateUser).not.toHaveBeenCalled();
    });
  });

  describe("isBrandLogoFetchable (ENG-792 logo preflight)", () => {
    const pngHeaders = { "content-type": "image/png" };

    it("returns true for a 2xx image response with a non-empty body", async () => {
      const ok = await isBrandLogoFetchable("https://s3/logo.png", {
        httpGet: async () => ({
          status: 200,
          headers: pngHeaders,
          data: Buffer.from([137, 80, 78, 71]),
        }),
      });
      expect(ok).toBe(true);
    });

    it("returns false when the fetch throws (favicon 404, DNS, timeout)", async () => {
      const ok = await isBrandLogoFetchable(
        "https://www.google.com/s2/favicons?domain=dramabreak.ai&sz=128",
        {
          httpGet: async () => {
            throw new Error("Request failed with status code 404");
          },
        }
      );
      expect(ok).toBe(false);
    });

    it("returns false for a non-2xx status from an injected fetcher", async () => {
      const ok = await isBrandLogoFetchable("https://s3/logo.png", {
        httpGet: async () => ({ status: 404, headers: pngHeaders, data: Buffer.from([1]) }),
      });
      expect(ok).toBe(false);
    });

    it("returns false when the body is empty even on a 200", async () => {
      const ok = await isBrandLogoFetchable("https://s3/logo.png", {
        httpGet: async () => ({ status: 200, headers: pngHeaders, data: Buffer.alloc(0) }),
      });
      expect(ok).toBe(false);
    });

    it("returns false when a 200 serves an HTML error body, not an image", async () => {
      const ok = await isBrandLogoFetchable("https://cdn/error", {
        httpGet: async () => ({
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
          data: Buffer.from("<!doctype html><html>not found</html>"),
        }),
      });
      expect(ok).toBe(false);
    });

    it("allows an unknown/empty content-type through (extension is sniffed later)", async () => {
      const ok = await isBrandLogoFetchable("https://s3/logo.png", {
        httpGet: async () => ({ status: 200, headers: {}, data: Buffer.from([1, 2, 3]) }),
      });
      expect(ok).toBe(true);
    });

    it("allows a generic binary content-type through (getImageMimeType sniffs it)", async () => {
      // S3 objects lacking ContentType metadata / some CDNs serve real image
      // bytes as octet-stream; these generate fine downstream and must not hard-fail.
      for (const ct of ["application/octet-stream", "binary/octet-stream"]) {
        const ok = await isBrandLogoFetchable("https://s3/logo.png", {
          httpGet: async () => ({
            status: 200,
            headers: { "content-type": ct },
            data: Buffer.from([137, 80, 78, 71]),
          }),
        });
        expect(ok).toBe(true);
      }
    });

    it("returns false when a 200 serves a JSON error body, not an image", async () => {
      const ok = await isBrandLogoFetchable("https://cdn/error", {
        httpGet: async () => ({
          status: 200,
          headers: { "content-type": "application/json" },
          data: Buffer.from('{"error":"not found"}'),
        }),
      });
      expect(ok).toBe(false);
    });

    it("returns false for an empty or non-string URL without fetching", async () => {
      let called = false;
      const httpGet = async () => {
        called = true;
        return { status: 200, headers: pngHeaders, data: Buffer.from([1]) };
      };
      expect(await isBrandLogoFetchable("", { httpGet })).toBe(false);
      expect(await isBrandLogoFetchable("   ", { httpGet })).toBe(false);
      expect(await isBrandLogoFetchable(undefined as any, { httpGet })).toBe(false);
      expect(called).toBe(false);
    });
  });

  describe("extractAdImageBrandContext", () => {
    it("projects all visual fields when present (primary/secondary color, font, logoUrl)", () => {
      const ctx = extractAdImageBrandContext({
        companyName: "Linear",
        brandGuidelines: {
          brandData: {
            primaryColor: "#5E6AD2",
            secondaryColor: "#FFFFFF",
            fontFamily: "Inter",
            logoUrl: "https://example.com/logo.png",
          },
        },
      });
      expect(ctx.primaryColor).toBe("#5E6AD2");
      expect(ctx.secondaryColor).toBe("#FFFFFF");
      expect(ctx.fontFamily).toBe("Inter");
      expect(ctx.logoUrl).toBe("https://example.com/logo.png");
    });

    it("falls back to the attachments logo asset — where updateBrandGuidelines actually persists (ENG-326)", () => {
      const ctx = extractAdImageBrandContext({
        companyName: "Linear",
        brandGuidelines: {
          brandData: { primaryColor: "#5E6AD2" },
          attachments: [
            { type: "brandGuide", url: "https://example.com/guide.pdf" },
            { type: "logo", url: "https://example.com/att-logo.png" },
          ],
        },
      });
      expect(ctx.logoUrl).toBe("https://example.com/att-logo.png");
    });

    it("falls back to brandAssets array when brandData.logoUrl is missing", () => {
      const ctx = extractAdImageBrandContext({
        companyName: "Linear",
        brandGuidelines: {
          brandData: { primaryColor: "#5E6AD2" },
          brandAssets: [
            { type: "image", url: "https://example.com/asset.png" },
          ],
        },
      });
      expect(ctx.logoUrl).toBe("https://example.com/asset.png");
    });

    it("picks the first 'logo' typed asset out of multiple", () => {
      const ctx = extractAdImageBrandContext({
        brandGuidelines: {
          brandAssets: [
            { type: "favicon", url: "https://example.com/fav.png" },
            { type: "logo-light", url: "https://example.com/logo.png" },
            { type: "image", url: "https://example.com/photo.png" },
          ],
        },
      });
      expect(ctx.logoUrl).toBe("https://example.com/logo.png");
    });

    it("returns empty when nothing is set (defensive)", () => {
      const ctx = extractAdImageBrandContext({});
      expect(ctx.primaryColor).toBeUndefined();
      expect(ctx.fontFamily).toBeUndefined();
      expect(ctx.logoUrl).toBeUndefined();
    });

    it("ignores non-string color/font/logo values defensively", () => {
      const ctx = extractAdImageBrandContext({
        brandGuidelines: {
          brandData: {
            primaryColor: 123 as any,
            secondaryColor: null as any,
            fontFamily: { name: "Inter" } as any,
            logoUrl: undefined as any,
          },
        },
      });
      expect(ctx.primaryColor).toBeUndefined();
      expect(ctx.secondaryColor).toBeUndefined();
      expect(ctx.fontFamily).toBeUndefined();
      expect(ctx.logoUrl).toBeUndefined();
    });

    it("ignores assets missing url or type when scanning for logo", () => {
      const ctx = extractAdImageBrandContext({
        brandGuidelines: {
          brandAssets: [
            { type: "logo" }, // no url
            { url: "https://example.com/no-type.png" }, // no type
            null as any, // null entry
            { type: "logo", url: "https://example.com/real.png" },
          ],
        },
      });
      expect(ctx.logoUrl).toBe("https://example.com/real.png");
    });
  });

  describe("startAdImageGenerationForUser", () => {
    beforeEach(() => {
      jest.clearAllMocks();
    });

    it("writes the start patch synchronously and launches background work", async () => {
      userDb.updateUser.mockResolvedValue({});
      userDb.getUserById.mockResolvedValue(null);
      await startAdImageGenerationForUser("u1");
      expect(userDb.updateUser).toHaveBeenCalledTimes(1);
      const startPatch = userDb.updateUser.mock.calls[0][1];
      expect(startPatch.adImageStatus).toBe("running");
      expect(startPatch.adImageStartedAt).toBeTruthy();
    });
  });
});
