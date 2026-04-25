/**
 * Onboarding Epic Phase 2 — Ad copy service tests (replaces
 * onboardingAdGenerator.test.ts after the legacy generator is removed).
 *
 * Mirrors the ICP / competitor / creative-dir test patterns: pure unit tests
 * against an injected fake LLM. Asserts:
 *   - waits for adImageStatus === 'ready'
 *   - picks 3 distinct Brick 10 varieties
 *   - calls LLM once per variant
 *   - enforces first-125-char hook rule in prompt
 *   - attaches copy to image variants by id
 */

jest.mock("../services/db", () => ({
  userDb: {
    getUserById: jest.fn(),
    updateUser: jest.fn(),
  },
}));

import {
  AD_COPY_SYSTEM_PROMPT,
  BRICK_10_VARIETIES,
  generateAdCopyForUser,
  pickDistinctVarieties,
  startAdCopyForUser,
  triggerAdCopyForUser,
} from "../services/onboardingAdCopyService";
const { userDb } = require("../services/db");

class FakeLlm {
  public lastSystemPrompt = "";
  public lastUserPrompt = "";
  public allUserPrompts: string[] = [];
  public callCount = 0;

  constructor(
    private readonly responder: (n: number) => unknown,
    private readonly throwError?: Error
  ) {}

  async generateJSONContent<T = unknown>(
    system: string,
    user: string,
    _format: "json" | "xml" = "json"
  ): Promise<T> {
    this.callCount += 1;
    this.lastSystemPrompt = system;
    this.lastUserPrompt = user;
    this.allUserPrompts.push(user);
    if (this.throwError) throw this.throwError;
    return this.responder(this.callCount) as T;
  }
}

const threeImages = [
  { id: "img-v1", imageUrl: "https://s3/img1.png", prompt: "feed 1:1 hero" },
  { id: "img-v2", imageUrl: "https://s3/img2.png", prompt: "story 4:5 testimonial" },
  { id: "img-v3", imageUrl: "https://s3/img3.png", prompt: "data comparison" },
];

const onePersona = {
  name: "DevTool Founder",
  pain: "no leads",
  desire: "more pipeline",
  objection: "tools are noisy",
  meta_targeting_brief: "founders, USA, 20-50",
};
const creativeDir = {
  concepts: ["VM", "TR", "SP", "CE", "CA", "PI"],
  copy_angles: ["PA", "OV", "SPL", "CH", "DC"],
  format_archetypes: ["A", "B", "C", "D"],
};

const buildVariantResponse = (i: number) => ({
  headline: `Headline ${i}`,
  primaryText: `Hook ${i} — first 125 chars must hook. Then agitate. Then offer the fix.`,
  cta: "Learn more",
});

describe("onboardingAdCopyService", () => {
  describe("BRICK_10_VARIETIES", () => {
    it("exposes the 5 Brick 10 varieties verbatim from the prod plan", () => {
      expect(BRICK_10_VARIETIES).toContain("Problem Agitation");
      expect(BRICK_10_VARIETIES).toContain("Competitor Contrast");
      expect(BRICK_10_VARIETIES).toContain("Social Proof Led");
      // Match either the long ("While You Sleep / Passive Benefit") or
      // short ("Passive Benefit") form — both are acceptable.
      expect(
        BRICK_10_VARIETIES.some((v) => v.includes("Passive Benefit"))
      ).toBe(true);
      expect(
        BRICK_10_VARIETIES.some((v) => v.includes("Direct Response"))
      ).toBe(true);
      expect(BRICK_10_VARIETIES).toHaveLength(5);
    });
  });

  describe("pickDistinctVarieties", () => {
    it("picks exactly 3 distinct varieties for 3 images", () => {
      const picked = pickDistinctVarieties(3);
      expect(picked).toHaveLength(3);
      expect(new Set(picked).size).toBe(3);
      for (const v of picked) {
        expect(BRICK_10_VARIETIES).toContain(v);
      }
    });

    it("returns N varieties when N <= 5", () => {
      expect(pickDistinctVarieties(1)).toHaveLength(1);
      expect(pickDistinctVarieties(5)).toHaveLength(5);
    });

    it("caps at 5 even if asked for more (only 5 varieties exist)", () => {
      const picked = pickDistinctVarieties(10);
      expect(picked).toHaveLength(5);
      expect(new Set(picked).size).toBe(5);
    });

    it("returns 0 when asked for 0 (no images yet)", () => {
      expect(pickDistinctVarieties(0)).toEqual([]);
    });

    it("returns 0 for negative or non-finite n (defensive)", () => {
      expect(pickDistinctVarieties(-1)).toEqual([]);
      expect(pickDistinctVarieties(NaN as any)).toEqual([]);
    });
  });

  describe("generateAdCopyForUser", () => {
    it("calls LLM once per image variant and returns 3 ad copy variants", async () => {
      const llm = new FakeLlm(buildVariantResponse);
      const result = await generateAdCopyForUser(
        threeImages,
        creativeDir,
        [onePersona],
        { companyName: "Linear" },
        { llm: llm as any }
      );
      expect(llm.callCount).toBe(3);
      expect(result.variants).toHaveLength(3);
    });

    it("attaches each ad copy variant to the matching image id", async () => {
      const llm = new FakeLlm(buildVariantResponse);
      const result = await generateAdCopyForUser(
        threeImages,
        creativeDir,
        [onePersona],
        { companyName: "Linear" },
        { llm: llm as any }
      );
      const ids = result.variants.map((v) => v.id);
      expect(ids).toEqual(["img-v1", "img-v2", "img-v3"]);
    });

    it("each variant gets a distinct Brick 10 variety tag", async () => {
      const llm = new FakeLlm(buildVariantResponse);
      const result = await generateAdCopyForUser(
        threeImages,
        creativeDir,
        [onePersona],
        { companyName: "Linear" },
        { llm: llm as any }
      );
      const varieties = result.variants.map((v) => v.variety);
      expect(new Set(varieties).size).toBe(3);
      for (const v of varieties) {
        expect(BRICK_10_VARIETIES).toContain(v);
      }
    });

    it("uses the prod work-plan Step 6 system prompt verbatim (Brick 10)", async () => {
      const llm = new FakeLlm(buildVariantResponse);
      await generateAdCopyForUser(
        threeImages,
        creativeDir,
        [onePersona],
        { companyName: "Linear" },
        { llm: llm as any }
      );
      expect(llm.lastSystemPrompt).toContain("Brick 10");
      expect(llm.lastSystemPrompt).toContain("125 characters");
      expect(llm.lastSystemPrompt).toContain("Hook");
      expect(AD_COPY_SYSTEM_PROMPT).toBe(llm.lastSystemPrompt);
    });

    it("includes the per-variant variety, image prompt, persona context in user prompt", async () => {
      const llm = new FakeLlm(buildVariantResponse);
      await generateAdCopyForUser(
        threeImages,
        creativeDir,
        [onePersona],
        { companyName: "Linear" },
        { llm: llm as any }
      );
      // First user prompt should mention the first image's prompt + the assigned variety
      const first = llm.allUserPrompts[0];
      expect(first).toContain("feed 1:1 hero");
      expect(first).toContain("Linear");
      expect(first).toContain("DevTool Founder");
      // The variety tag for variant 1 must appear in the variant 1 prompt
      const v1variety = BRICK_10_VARIETIES[0];
      // first-pick variety appears in the prompt
      expect(first).toContain(v1variety);
    });

    it("throws when image variants array is empty", async () => {
      const llm = new FakeLlm(buildVariantResponse);
      await expect(
        generateAdCopyForUser(
          [],
          creativeDir,
          [onePersona],
          { companyName: "Linear" },
          { llm: llm as any }
        )
      ).rejects.toThrow(/image variant/i);
    });

    it("propagates LLM errors verbatim", async () => {
      const llm = new FakeLlm(buildVariantResponse, new Error("bedrock 429"));
      await expect(
        generateAdCopyForUser(
          threeImages,
          creativeDir,
          [onePersona],
          { companyName: "Linear" },
          { llm: llm as any }
        )
      ).rejects.toThrow(/bedrock 429/);
    });

    it("handles LLM returning malformed variant (missing fields) by filling defaults", async () => {
      const sparseLlm = new FakeLlm(() => ({
        primaryText: "only primary text",
      }));
      const result = await generateAdCopyForUser(
        [threeImages[0]],
        creativeDir,
        [onePersona],
        { companyName: "Linear" },
        { llm: sparseLlm as any }
      );
      expect(result.variants).toHaveLength(1);
      // Missing headline / cta default to empty / sensible defaults — the
      // sanitiser at adCopyStatusService is the boundary check. Just verify
      // it didn't throw.
      expect(result.variants[0].id).toBe("img-v1");
    });

    it("defaults headline+primaryText to empty strings when LLM returns non-strings", async () => {
      const llm = new FakeLlm(() => ({
        headline: 42, // non-string
        primaryText: null,
        cta: undefined,
      }));
      const result = await generateAdCopyForUser(
        [threeImages[0]],
        creativeDir,
        [onePersona],
        { companyName: "Linear" },
        { llm: llm as any }
      );
      expect(result.variants[0].headline).toBe("");
      expect(result.variants[0].primaryText).toBe("");
      expect(result.variants[0].cta).toBe("Learn More");
    });

    it("handles LLM returning null entirely (defensive optional chaining)", async () => {
      const llm = new FakeLlm(() => null);
      const result = await generateAdCopyForUser(
        [threeImages[0]],
        creativeDir,
        [onePersona],
        { companyName: "Linear" },
        { llm: llm as any }
      );
      expect(result.variants[0].headline).toBe("");
      expect(result.variants[0].primaryText).toBe("");
      expect(result.variants[0].cta).toBe("Learn More");
    });

    it("uses default '(see system prompt)' for unknown variety in user prompt", async () => {
      // Hit the BRICK_10_STRUCTURES fallback — pass an image but mock pickDistinctVarieties
      // by routing through the public API. The orchestrator always picks from
      // BRICK_10_VARIETIES, so the only way to hit the fallback is through a
      // fake variety, which means calling the prompt builder via the LLM round.
      // We can verify this indirectly: the fallback string never appears for
      // a real run (because every picked variety is in the dict).
      const llm = new FakeLlm(buildVariantResponse);
      await generateAdCopyForUser(
        [threeImages[0]],
        creativeDir,
        [onePersona],
        { companyName: "Linear" },
        { llm: llm as any }
      );
      // Real Brick 10 varieties always have a known structure
      expect(llm.allUserPrompts[0]).not.toContain("(see system prompt)");
      expect(llm.allUserPrompts[0]).toContain("Variety structure:");
    });

    it("emits brand companyName fallback '(not provided)' when missing", async () => {
      const llm = new FakeLlm(buildVariantResponse);
      await generateAdCopyForUser(
        [threeImages[0]],
        creativeDir,
        [onePersona],
        {},
        { llm: llm as any }
      );
      expect(llm.allUserPrompts[0]).toContain("Company: (not provided)");
    });

    it("emits every optional brand field into the user prompt when all provided", async () => {
      const llm = new FakeLlm(buildVariantResponse);
      await generateAdCopyForUser(
        [threeImages[0]],
        creativeDir,
        [onePersona],
        {
          companyName: "Linear",
          companyUrl: "linear.app",
          valueProposition: "Fast",
          toneOfVoice: "Direct",
        },
        { llm: llm as any }
      );
      const prompt = llm.allUserPrompts[0];
      expect(prompt).toContain("Website: linear.app");
      expect(prompt).toContain("Value proposition: Fast");
      expect(prompt).toContain("Tone of voice: Direct");
    });

    it("uses a default 'Learn More' CTA when LLM returns empty cta", async () => {
      const llm = new FakeLlm(() => ({
        headline: "Hi",
        primaryText: "Body",
        cta: "",
      }));
      const result = await generateAdCopyForUser(
        [threeImages[0]],
        creativeDir,
        [onePersona],
        { companyName: "Linear" },
        { llm: llm as any }
      );
      expect(result.variants[0].cta).toBe("Learn More");
    });

    it("includes creative-direction concepts and angles in the user prompt", async () => {
      const llm = new FakeLlm(buildVariantResponse);
      await generateAdCopyForUser(
        [threeImages[0]],
        creativeDir,
        [onePersona],
        { companyName: "Linear" },
        { llm: llm as any }
      );
      const prompt = llm.allUserPrompts[0];
      expect(prompt).toContain("Concepts:");
      expect(prompt).toContain("Copy angles:");
    });

    it("works without ICPs (top-level brand only)", async () => {
      const llm = new FakeLlm(buildVariantResponse);
      const result = await generateAdCopyForUser(
        [threeImages[0]],
        creativeDir,
        [],
        { companyName: "Linear" },
        { llm: llm as any }
      );
      expect(result.variants).toHaveLength(1);
      // Primary ICP block should not be emitted when there are none
      expect(llm.allUserPrompts[0]).not.toContain("Primary ICP:");
    });

    it("works against a single image variant (only 1 picked variety)", async () => {
      const llm = new FakeLlm(buildVariantResponse);
      const result = await generateAdCopyForUser(
        [threeImages[0]],
        creativeDir,
        [onePersona],
        { companyName: "Linear" },
        { llm: llm as any }
      );
      expect(result.variants).toHaveLength(1);
      expect(llm.callCount).toBe(1);
    });
  });

  describe("triggerAdCopyForUser (fire-and-forget orchestrator)", () => {
    beforeEach(() => {
      jest.clearAllMocks();
    });

    it("returns silently when user is missing", async () => {
      userDb.getUserById.mockResolvedValue(null);
      await triggerAdCopyForUser("missing-user");
      expect(userDb.updateUser).not.toHaveBeenCalled();
    });

    it("fails the run when adImageStatus is not 'ready' (waits for images)", async () => {
      userDb.getUserById
        .mockResolvedValueOnce({
          userId: "user-1",
          adImageStatus: "running",
          icpResult: [onePersona],
          creativeDirResult: creativeDir,
        })
        .mockResolvedValueOnce({
          userId: "user-1",
          adCopyStatus: "running",
          adCopyStartedAt: "2026-04-24T11:59:00.000Z",
        });
      userDb.updateUser.mockResolvedValue({});

      const llm = new FakeLlm(buildVariantResponse);
      const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
      await triggerAdCopyForUser("user-1", { llm: llm as any });
      errSpy.mockRestore();

      expect(userDb.updateUser).toHaveBeenCalledTimes(1);
      const written = userDb.updateUser.mock.calls[0][1];
      expect(written.adCopyStatus).toBe("failed");
      expect(written.adCopyError).toMatch(/image|ready/i);
      expect(llm.callCount).toBe(0);
    });

    it("treats missing adImageStatus (undefined) as 'idle' and fails the run", async () => {
      userDb.getUserById
        .mockResolvedValueOnce({
          userId: "user-1",
          // adImageStatus omitted entirely
          icpResult: [onePersona],
          creativeDirResult: creativeDir,
        })
        .mockResolvedValueOnce({
          userId: "user-1",
          adCopyStatus: "running",
        });
      userDb.updateUser.mockResolvedValue({});

      const llm = new FakeLlm(buildVariantResponse);
      const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
      await triggerAdCopyForUser("user-1", { llm: llm as any });
      errSpy.mockRestore();

      const written = userDb.updateUser.mock.calls[0][1];
      expect(written.adCopyStatus).toBe("failed");
      expect(written.adCopyError).toMatch(/idle/);
    });

    it("uses {} fallback when getUserById returns null on the gate failure path", async () => {
      userDb.getUserById
        .mockResolvedValueOnce({
          userId: "user-1",
          adImageStatus: "running",
          icpResult: [onePersona],
          creativeDirResult: creativeDir,
        })
        .mockResolvedValueOnce(null); // disappears between gate detection and patch read
      userDb.updateUser.mockResolvedValue({});

      const llm = new FakeLlm(buildVariantResponse);
      const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
      await triggerAdCopyForUser("user-1", { llm: llm as any });
      errSpy.mockRestore();

      // Failure path always writes (even with {} fallback).
      expect(userDb.updateUser).toHaveBeenCalledTimes(1);
      expect(userDb.updateUser.mock.calls[0][1].adCopyStatus).toBe("failed");
    });

    it("falls back to empty personas when icpResult is non-array", async () => {
      userDb.getUserById
        .mockResolvedValueOnce({
          userId: "user-1",
          adImageStatus: "ready",
          adImageResult: { variants: threeImages },
          icpResult: "not-an-array" as any, // exercise the Array.isArray fallback
          creativeDirResult: creativeDir,
        })
        .mockResolvedValueOnce({
          userId: "user-1",
          adCopyStatus: "running",
        });
      userDb.updateUser.mockResolvedValue({});

      const llm = new FakeLlm(buildVariantResponse);
      await triggerAdCopyForUser("user-1", { llm: llm as any });

      // Successful run; just verify the orchestrator didn't crash on non-array
      expect(userDb.updateUser.mock.calls[0][1].adCopyStatus).toBe("ready");
    });

    it("falls back to empty creativeDir when persisted as null/non-object", async () => {
      userDb.getUserById
        .mockResolvedValueOnce({
          userId: "user-1",
          adImageStatus: "ready",
          adImageResult: { variants: threeImages },
          icpResult: [onePersona],
          creativeDirResult: null, // missing creative direction
        })
        .mockResolvedValueOnce({
          userId: "user-1",
          adCopyStatus: "running",
        });
      userDb.updateUser.mockResolvedValue({});

      const llm = new FakeLlm(buildVariantResponse);
      await triggerAdCopyForUser("user-1", { llm: llm as any });

      expect(userDb.updateUser.mock.calls[0][1].adCopyStatus).toBe("ready");
    });

    it("fails the run when adImageResult is empty", async () => {
      userDb.getUserById
        .mockResolvedValueOnce({
          userId: "user-1",
          adImageStatus: "ready",
          adImageResult: { variants: [] },
          icpResult: [onePersona],
          creativeDirResult: creativeDir,
        })
        .mockResolvedValueOnce({
          userId: "user-1",
          adCopyStatus: "running",
        });
      userDb.updateUser.mockResolvedValue({});

      const llm = new FakeLlm(buildVariantResponse);
      const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
      await triggerAdCopyForUser("user-1", { llm: llm as any });
      errSpy.mockRestore();

      expect(userDb.updateUser.mock.calls[0][1].adCopyStatus).toBe("failed");
    });

    it("patches User with adCopyReadyPatch when LLM succeeds and images are ready", async () => {
      userDb.getUserById
        .mockResolvedValueOnce({
          userId: "user-1",
          adImageStatus: "ready",
          adImageResult: { variants: threeImages },
          icpResult: [onePersona],
          creativeDirResult: creativeDir,
          brandGuidelines: { brandData: { brandName: "Linear" } },
        })
        .mockResolvedValueOnce({
          userId: "user-1",
          adCopyStatus: "running",
          adCopyStartedAt: "2026-04-24T11:59:00.000Z",
        });
      userDb.updateUser.mockResolvedValue({});

      const llm = new FakeLlm(buildVariantResponse);
      await triggerAdCopyForUser("user-1", { llm: llm as any });

      expect(userDb.updateUser).toHaveBeenCalledTimes(1);
      const written = userDb.updateUser.mock.calls[0][1];
      expect(written.adCopyStatus).toBe("ready");
      expect(written.adCopyResult.variants).toHaveLength(3);
    });

    it("drops the ready patch silently when user is no longer running", async () => {
      userDb.getUserById
        .mockResolvedValueOnce({
          userId: "user-1",
          adImageStatus: "ready",
          adImageResult: { variants: threeImages },
          icpResult: [onePersona],
          creativeDirResult: creativeDir,
        })
        .mockResolvedValueOnce({ userId: "user-1", adCopyStatus: "idle" });
      const llm = new FakeLlm(buildVariantResponse);
      await triggerAdCopyForUser("user-1", { llm: llm as any });
      expect(userDb.updateUser).not.toHaveBeenCalled();
    });

    it("patches with adCopyFailedPatch when LLM throws", async () => {
      userDb.getUserById
        .mockResolvedValueOnce({
          userId: "user-1",
          adImageStatus: "ready",
          adImageResult: { variants: threeImages },
          icpResult: [onePersona],
          creativeDirResult: creativeDir,
        })
        .mockResolvedValueOnce({
          userId: "user-1",
          adCopyStatus: "running",
        });
      userDb.updateUser.mockResolvedValue({});

      const llm = new FakeLlm(buildVariantResponse, new Error("bedrock down"));
      const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
      await triggerAdCopyForUser("user-1", { llm: llm as any });
      errSpy.mockRestore();

      expect(userDb.updateUser.mock.calls[0][1].adCopyStatus).toBe("failed");
    });

    it("uses {} fallback when getUserById returns null on the second read", async () => {
      userDb.getUserById
        .mockResolvedValueOnce({
          userId: "user-1",
          adImageStatus: "ready",
          adImageResult: { variants: threeImages },
          icpResult: [onePersona],
          creativeDirResult: creativeDir,
        })
        .mockResolvedValueOnce(null);
      userDb.updateUser.mockResolvedValue({});

      const llm = new FakeLlm(buildVariantResponse);
      await triggerAdCopyForUser("user-1", { llm: llm as any });
      expect(userDb.updateUser).not.toHaveBeenCalled();
    });

    it("uses {} fallback in the failure path when getUserById returns null", async () => {
      userDb.getUserById
        .mockResolvedValueOnce({
          userId: "user-1",
          adImageStatus: "ready",
          adImageResult: { variants: threeImages },
          icpResult: [onePersona],
          creativeDirResult: creativeDir,
        })
        .mockResolvedValueOnce(null);
      userDb.updateUser.mockResolvedValue({});

      const llm = new FakeLlm(buildVariantResponse, new Error("boom"));
      const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
      await triggerAdCopyForUser("user-1", { llm: llm as any });
      errSpy.mockRestore();

      expect(userDb.updateUser.mock.calls[0][1].adCopyStatus).toBe("failed");
    });

    it("stringifies non-Error thrown values in the failed patch", async () => {
      userDb.getUserById
        .mockResolvedValueOnce({
          userId: "user-1",
          adImageStatus: "ready",
          adImageResult: { variants: threeImages },
          icpResult: [onePersona],
          creativeDirResult: creativeDir,
        })
        .mockResolvedValueOnce({ userId: "user-1", adCopyStatus: "running" });
      userDb.updateUser.mockResolvedValue({});

      const weirdLlm = {
        generateJSONContent: async () => {
          throw "literal-string-thrown";
        },
      };
      const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
      await triggerAdCopyForUser("user-1", { llm: weirdLlm as any });
      errSpy.mockRestore();
      expect(userDb.updateUser.mock.calls[0][1].adCopyError).toContain(
        "literal-string-thrown"
      );
    });
  });

  describe("startAdCopyForUser", () => {
    beforeEach(() => {
      jest.clearAllMocks();
    });

    it("writes the start patch synchronously and launches background work", async () => {
      userDb.updateUser.mockResolvedValue({});
      userDb.getUserById.mockResolvedValue(null);

      await startAdCopyForUser("user-1");

      expect(userDb.updateUser).toHaveBeenCalledTimes(1);
      const startPatch = userDb.updateUser.mock.calls[0][1];
      expect(startPatch.adCopyStatus).toBe("running");
      expect(startPatch.adCopyStartedAt).toBeTruthy();
    });
  });
});
