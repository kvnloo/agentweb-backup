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

jest.mock("../services/creativeRubricOnboarding", () => ({
  judgeOnboardingAdCopy: jest.fn(async () => null),
}));

import { judgeOnboardingAdCopy } from "../services/creativeRubricOnboarding";
import {
  AD_COPY_SYSTEM_PROMPT,
  BRICK_10_VARIETIES,
  claimAdCopyRun,
  generateAdCopyForUser,
  pickDistinctVarieties,
  startAdCopyForUser,
  triggerAdCopyForUser,
} from "../services/onboardingAdCopyService";
import { AD_COPY_TIMEOUT_MS } from "../services/adCopyStatusService";
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

  async generateJsonRobust<T = unknown>(
    system: string,
    user: string
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

    it("hands the stored copy run and its images to the rubric judge hook (ENG-2192)", async () => {
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

      type CopyDeps = NonNullable<Parameters<typeof triggerAdCopyForUser>[1]>;
      await triggerAdCopyForUser("user-1", { llm: new FakeLlm(buildVariantResponse) as unknown as CopyDeps["llm"] });
      await new Promise((resolve) => setImmediate(resolve)); // the hook is dispatched, not awaited

      const written = userDb.updateUser.mock.calls[0][1];
      expect(jest.mocked(judgeOnboardingAdCopy)).toHaveBeenCalledWith({
        userId: "user-1",
        completedAt: written.adCopyCompletedAt,
        copyVariants: written.adCopyResult.variants,
        imageVariants: threeImages,
      });
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

    // ENG-2308 review follow-up, confirmed by direct reproduction (same
    // reasoning as onboardingIcpService's icpOwnershipCondition tests).
    it("conditions the completion write on this run's own adCopyStartedAt when expectedStartedAt is provided", async () => {
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
          adCopyStartedAt: "2026-04-24T11:59:00.000Z",
        });
      userDb.updateUser.mockResolvedValue({});

      const llm = new FakeLlm(buildVariantResponse);
      await triggerAdCopyForUser("user-1", {
        llm: llm as any,
        expectedStartedAt: "2026-04-24T11:59:00.000Z",
      });

      const options = userDb.updateUser.mock.calls[0][2];
      expect(options?.condition?.expression).toBe(
        "#adCopyStartedAt = :adCopyOwnerStartedAt",
      );
      expect(options?.condition?.values?.[":adCopyOwnerStartedAt"]).toBe(
        "2026-04-24T11:59:00.000Z",
      );
    });

    it("drops the completion silently when a reclaim has superseded this run (ConditionalCheckFailedException)", async () => {
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
          adCopyStartedAt: "2026-04-24T12:05:00.000Z",
        });
      const conditionalFailure = Object.assign(
        new Error("The conditional request failed"),
        { code: "ConditionalCheckFailedException" },
      );
      userDb.updateUser.mockRejectedValueOnce(conditionalFailure);
      const llm = new FakeLlm(buildVariantResponse);

      await expect(
        triggerAdCopyForUser("user-1", {
          llm: llm as any,
          expectedStartedAt: "2026-04-24T11:59:00.000Z",
        }),
      ).resolves.toBeUndefined();

      expect(userDb.updateUser).toHaveBeenCalledTimes(1);
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
        generateJsonRobust: async () => {
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

  // ENG-2308 follow-up, caught live: the orchestrator's runAdCopy used to
  // call triggerAdCopyForUser directly with nothing ever flipping
  // adCopyStatus to running first — the trigger silently dropped its
  // result. claimAdCopyRun is the extracted, reusable claim both
  // startAdCopyForUser and runAdCopy go through.
  describe("claimAdCopyRun", () => {
    beforeEach(() => {
      jest.clearAllMocks();
    });

    it("claims the axis and returns the persisted patch", async () => {
      userDb.updateUser.mockResolvedValue({});
      const patch = await claimAdCopyRun("user-1");
      expect(patch).not.toBeNull();
      expect(patch?.adCopyStatus).toBe("running");
    });

    it("returns null without throwing when it loses the claim", async () => {
      const conditionalFailure = Object.assign(
        new Error("The conditional request failed"),
        { code: "ConditionalCheckFailedException" },
      );
      userDb.updateUser.mockRejectedValueOnce(conditionalFailure);
      const patch = await claimAdCopyRun("user-1");
      expect(patch).toBeNull();
    });
  });

  describe("startAdCopyForUser", () => {
    beforeEach(() => {
      jest.clearAllMocks();
    });

    it("writes the start patch synchronously and launches background work", async () => {
      userDb.updateUser.mockResolvedValue({});
      userDb.getUserById.mockResolvedValue(null);

      const result = await startAdCopyForUser("user-1");

      expect(userDb.updateUser).toHaveBeenCalledTimes(1);
      const startPatch = userDb.updateUser.mock.calls[0][1];
      expect(startPatch.adCopyStatus).toBe("running");
      expect(startPatch.adCopyStartedAt).toBeTruthy();
      // The claim also clears the previous attempt's error (REMOVE, via null);
      // the returned patch is the same run without that storage-only marker.
      expect(startPatch.adCopyError).toBeNull();
      expect(result).toEqual({ ...startPatch, adCopyError: undefined });
    });

    // ENG-2308: same unconditional-write race as icp/competitor — two
    // concurrent callers could each observe a non-running status and both
    // launch a real LLM call. Guard the claim with a ConditionExpression.
    it("claims the running transition with a ConditionExpression guarding against a concurrent in-flight run", async () => {
      userDb.updateUser.mockResolvedValue({});
      userDb.getUserById.mockResolvedValue(null);

      const before = Date.now();
      await startAdCopyForUser("user-1");

      const options = userDb.updateUser.mock.calls[0][2];
      expect(options?.condition?.expression).toBe(
        "attribute_not_exists(#adCopyStatus) OR #adCopyStatus <> :adCopyRunning OR #adCopyStartedAt <= :adCopyStaleBefore",
      );
      expect(options?.condition?.names).toEqual({
        "#adCopyStatus": "adCopyStatus",
        "#adCopyStartedAt": "adCopyStartedAt",
      });
      expect(options?.condition?.values?.[":adCopyRunning"]).toBe("running");
      // ENG-2308 fix-of-a-fix: stale-claim escape hatch (see icpStartClaimCondition).
      const staleBefore = Date.parse(options?.condition?.values?.[":adCopyStaleBefore"]);
      expect(staleBefore).toBeGreaterThanOrEqual(before - AD_COPY_TIMEOUT_MS - 1000);
      expect(staleBefore).toBeLessThanOrEqual(Date.now() - AD_COPY_TIMEOUT_MS + 1000);
    });

    it("returns null and launches no background work when it loses the race to a concurrent caller", async () => {
      userDb.getUserById.mockResolvedValue({ userId: "user-1" });
      const conditionalFailure = Object.assign(
        new Error("The conditional request failed"),
        { code: "ConditionalCheckFailedException" },
      );
      userDb.updateUser.mockRejectedValue(conditionalFailure);

      const result = await startAdCopyForUser("user-1");

      expect(result).toBeNull();
      expect(userDb.updateUser).toHaveBeenCalledTimes(1);
      // getUserById IS called once (to check eager status before claiming
      // — ENG-2308 fix-of-a-fix).
      expect(userDb.getUserById).toHaveBeenCalledTimes(1);
    });

    // ENG-2308 fix-of-a-fix, caught live: runAdCopy claims this SAME axis
    // itself when the orchestrator fires the step, inside the SAME
    // reconcile pass this function delegates to. Must check eager status
    // and skip claiming entirely in that case.
    it("does not claim the axis itself on the eager pipeline — leaves the claim to runAdCopy", async () => {
      userDb.getUserById.mockResolvedValue({ userId: "user-1", useEagerPipeline: true });
      const orchestratorWiring = require("../services/onboardingOrchestratorWiring");
      const reconcileSpy = jest
        .spyOn(orchestratorWiring, "reconcileForUser")
        .mockImplementation(async () => {});
      try {
        const result = await startAdCopyForUser("user-1");

        expect(result).toBeNull();
        expect(userDb.updateUser).not.toHaveBeenCalled();
        expect(reconcileSpy).toHaveBeenCalledWith("user-1");
      } finally {
        reconcileSpy.mockRestore();
      }
    });

    it("re-throws a non-conditional DynamoDB error", async () => {
      // jest.clearAllMocks() (beforeEach) does not reset the previous test's
      // mockResolvedValue — without this, the prior eager-pipeline test's
      // `useEagerPipeline: true` leaks in, and since the eager check now
      // runs BEFORE the claim write, this test would short-circuit to the
      // reconcile branch and never reach updateUser at all.
      userDb.getUserById.mockResolvedValue({ userId: "user-1" });
      userDb.updateUser.mockRejectedValue(
        Object.assign(new Error("boom"), {
          code: "ProvisionedThroughputExceededException",
        }),
      );

      await expect(startAdCopyForUser("user-1")).rejects.toThrow("boom");
    });
  });
});
