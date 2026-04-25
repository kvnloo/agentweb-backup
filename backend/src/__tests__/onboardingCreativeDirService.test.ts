/**
 * Onboarding Epic Phase 2 — Creative direction service tests.
 *
 * Mirrors `onboardingIcpService.test.ts` and `onboardingCompetitorService.test.ts`:
 * pure unit tests against an injected fake LLM. No DynamoDB, no real Bedrock.
 */

jest.mock("../services/db", () => ({
  userDb: {
    getUserById: jest.fn(),
    updateUser: jest.fn(),
  },
}));

import {
  CREATIVE_DIR_SYSTEM_PROMPT,
  generateCreativeDirectionForUser,
  startCreativeDirForUser,
  triggerCreativeDirForUser,
} from "../services/onboardingCreativeDirService";
const { userDb } = require("../services/db");

class FakeLlm {
  public lastSystemPrompt = "";
  public lastUserPrompt = "";
  public callCount = 0;

  constructor(
    private readonly response: unknown,
    private readonly throwError?: Error
  ) {}

  async generateJsonRobust<T = unknown>(
    system: string,
    user: string
  ): Promise<T> {
    this.callCount += 1;
    this.lastSystemPrompt = system;
    this.lastUserPrompt = user;
    if (this.throwError) throw this.throwError;
    return this.response as T;
  }
}

const sixConcepts = [
  "VM: 3am realization that the deal is gone",
  "TR: before/after pipeline transformation",
  "SP: 1,200+ revenue teams trust Linear",
  "CE: competitors are eating your AI visibility",
  "CA: 30% faster sales cycles, quantified",
  "PI: contrarian take — your CRM is the bottleneck",
];
const fiveAngles = [
  "PA: Lead with the wound. Make it sting.",
  "OV: Lead with the dream state.",
  "SPL: Open with a testimonial / stat.",
  "CH: Curiosity hook — information gap.",
  "DC: Direct challenge — call them out.",
];
const formatArchetypes = [
  "A: NATIVE UI",
  "B: DATA / COMPARISON",
  "C: LIFESTYLE / ASPIRATIONAL",
  "D: TYPOGRAPHIC / MANIFESTO",
];
const fullResponse = {
  concepts: sixConcepts,
  copy_angles: fiveAngles,
  format_archetypes: formatArchetypes,
};

const onePersona = {
  name: "DevTool Founder",
  pain: "no leads",
  desire: "more pipeline",
  objection: "tools are noisy",
  meta_targeting_brief: "founders, USA, 20-50 employees",
};

const competitorResult = {
  per_icp: [
    {
      icp_id: "DevTool Founder",
      competitor_names: ["GitHub", "Linear"],
      offer_angles: ["Free trial", "OSS plan"],
      meta_targeting_brief: "B2B founders, USA",
    },
  ],
};

describe("onboardingCreativeDirService", () => {
  describe("generateCreativeDirectionForUser", () => {
    it("returns 6 concepts + 5 copy angles + format archetypes parsed from LLM", async () => {
      const llm = new FakeLlm(fullResponse);
      const result = await generateCreativeDirectionForUser(
        { companyName: "Linear" },
        [onePersona],
        competitorResult,
        { llm: llm as any }
      );
      expect(result.concepts).toHaveLength(6);
      expect(result.copy_angles).toHaveLength(5);
      expect(result.format_archetypes.length).toBeGreaterThan(0);
    });

    it("caps concepts at MAX_CONCEPTS (6) when LLM returns more", async () => {
      const tooMany = Array.from({ length: 12 }, (_, i) => `c${i}`);
      const llm = new FakeLlm({
        ...fullResponse,
        concepts: tooMany,
      });
      const result = await generateCreativeDirectionForUser(
        { companyName: "Acme" },
        [onePersona],
        competitorResult,
        { llm: llm as any }
      );
      expect(result.concepts).toHaveLength(6);
    });

    it("throws when LLM returns no concepts and no copy_angles", async () => {
      const llm = new FakeLlm({ format_archetypes: ["A"] });
      await expect(
        generateCreativeDirectionForUser(
          { companyName: "Acme" },
          [onePersona],
          competitorResult,
          { llm: llm as any }
        )
      ).rejects.toThrow(/concepts|copy_angles/i);
    });

    it("propagates LLM errors verbatim", async () => {
      const llm = new FakeLlm(null, new Error("bedrock 429"));
      await expect(
        generateCreativeDirectionForUser(
          { companyName: "Acme" },
          [onePersona],
          competitorResult,
          { llm: llm as any }
        )
      ).rejects.toThrow(/bedrock 429/);
    });

    it("uses the prod work-plan Step 4 system prompt verbatim (BRICK 4)", async () => {
      const llm = new FakeLlm(fullResponse);
      await generateCreativeDirectionForUser(
        { companyName: "Acme" },
        [onePersona],
        competitorResult,
        { llm: llm as any }
      );
      // The prompt MUST contain Step 4 / Brick 4 markers from the prod plan
      // (plan_1768351741814_jgc2wwlxa, steps[3].description). Update prod
      // plan first if you need to change the prompt.
      expect(llm.lastSystemPrompt).toContain("BRICK 4");
      expect(llm.lastSystemPrompt).toContain("CREATIVE DIRECTION");
      expect(llm.lastSystemPrompt).toContain("VISCERAL MOMENT");
      expect(llm.lastSystemPrompt).toContain("PAIN AGITATION");
      expect(CREATIVE_DIR_SYSTEM_PROMPT).toBe(llm.lastSystemPrompt);
    });

    it("includes ICP + competitor context in the user prompt", async () => {
      const llm = new FakeLlm(fullResponse);
      await generateCreativeDirectionForUser(
        { companyName: "Linear", valueProposition: "Fast issue tracking" },
        [onePersona],
        competitorResult,
        { llm: llm as any }
      );
      expect(llm.lastUserPrompt).toContain("Linear");
      expect(llm.lastUserPrompt).toContain("Fast issue tracking");
      expect(llm.lastUserPrompt).toContain("DevTool Founder");
      expect(llm.lastUserPrompt).toContain("GitHub");
    });

    it("falls back gracefully when ICP list is empty", async () => {
      const llm = new FakeLlm(fullResponse);
      const result = await generateCreativeDirectionForUser(
        { companyName: "Acme" },
        [],
        { per_icp: [] },
        { llm: llm as any }
      );
      expect(result.concepts).toHaveLength(6);
      expect(llm.lastUserPrompt).toContain("no ICPs available");
    });

    it("emits every optional brand field into the user prompt when all provided", async () => {
      const llm = new FakeLlm(fullResponse);
      await generateCreativeDirectionForUser(
        {
          companyName: "Linear",
          companyUrl: "linear.app",
          tagline: "Issue tracking",
          valueProposition: "Fast",
          toneOfVoice: "Direct",
        },
        [onePersona],
        competitorResult,
        { llm: llm as any }
      );
      expect(llm.lastUserPrompt).toContain("Website: linear.app");
      expect(llm.lastUserPrompt).toContain("Tagline: Issue tracking");
      expect(llm.lastUserPrompt).toContain("Value proposition: Fast");
      expect(llm.lastUserPrompt).toContain("Tone of voice: Direct");
    });

    it("handles competitor entries with missing competitor_names / offer_angles arrays", async () => {
      const llm = new FakeLlm(fullResponse);
      await generateCreativeDirectionForUser(
        { companyName: "Acme" },
        [onePersona],
        {
          per_icp: [
            // Defensive null-pass: undefined arrays should fall back to []
            { icp_id: "P1" } as any,
            // Standard well-formed entry
            {
              icp_id: "P2",
              competitor_names: ["X"],
              offer_angles: ["A"],
              meta_targeting_brief: "b",
            },
          ],
        },
        { llm: llm as any }
      );
      // Both ICP lines should appear in the user prompt with safe fallbacks
      expect(llm.lastUserPrompt).toContain("P1");
      expect(llm.lastUserPrompt).toContain("competitors=[]");
      expect(llm.lastUserPrompt).toContain("P2");
    });

    it("handles competitor result that is null / non-object", async () => {
      const llm = new FakeLlm(fullResponse);
      await generateCreativeDirectionForUser(
        { companyName: "Acme" },
        [onePersona],
        null as any,
        { llm: llm as any }
      );
      expect(llm.lastUserPrompt).toContain("no competitor analysis available");
    });

    it("filters non-string entries from concepts/angles/archetypes", async () => {
      const llm = new FakeLlm({
        concepts: ["c1", null, "c2", 42, "c3"],
        copy_angles: ["a1", undefined, "a2"],
        format_archetypes: ["arch1", { x: 1 }, "arch2"],
      });
      const result = await generateCreativeDirectionForUser(
        { companyName: "Acme" },
        [onePersona],
        competitorResult,
        { llm: llm as any }
      );
      expect(result.concepts).toEqual(["c1", "c2", "c3"]);
      expect(result.copy_angles).toEqual(["a1", "a2"]);
      expect(result.format_archetypes).toEqual(["arch1", "arch2"]);
    });
  });

  describe("triggerCreativeDirForUser (fire-and-forget orchestrator)", () => {
    beforeEach(() => {
      jest.clearAllMocks();
    });

    it("returns silently when user is missing", async () => {
      userDb.getUserById.mockResolvedValue(null);
      await triggerCreativeDirForUser("missing-user");
      expect(userDb.updateUser).not.toHaveBeenCalled();
    });

    it("patches User with creativeDirReadyPatch when LLM succeeds", async () => {
      userDb.getUserById
        .mockResolvedValueOnce({
          userId: "user-1",
          brandGuidelines: { brandData: { brandName: "Linear" } },
          icpResult: [onePersona],
          competitorResult,
        })
        .mockResolvedValueOnce({
          userId: "user-1",
          creativeDirStatus: "running",
          creativeDirStartedAt: "2026-04-24T11:59:00.000Z",
        });
      userDb.updateUser.mockResolvedValue({});

      const llm = new FakeLlm(fullResponse);
      await triggerCreativeDirForUser("user-1", { llm: llm as any });

      expect(userDb.updateUser).toHaveBeenCalledTimes(1);
      const writtenPatch = userDb.updateUser.mock.calls[0][1];
      expect(writtenPatch.creativeDirStatus).toBe("ready");
      expect(writtenPatch.creativeDirResult.concepts).toHaveLength(6);
    });

    it("drops the ready patch silently when user is no longer running", async () => {
      userDb.getUserById
        .mockResolvedValueOnce({
          userId: "user-1",
          icpResult: [onePersona],
          competitorResult,
        })
        .mockResolvedValueOnce({ userId: "user-1", creativeDirStatus: "idle" });
      const llm = new FakeLlm(fullResponse);
      await triggerCreativeDirForUser("user-1", { llm: llm as any });
      expect(userDb.updateUser).not.toHaveBeenCalled();
    });

    it("patches with creativeDirFailedPatch when LLM throws", async () => {
      userDb.getUserById
        .mockResolvedValueOnce({
          userId: "user-1",
          icpResult: [onePersona],
          competitorResult,
        })
        .mockResolvedValueOnce({
          userId: "user-1",
          creativeDirStatus: "running",
          creativeDirStartedAt: "2026-04-24T11:59:00.000Z",
        });
      userDb.updateUser.mockResolvedValue({});

      const llm = new FakeLlm(null, new Error("bedrock rate limited"));
      const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
      await triggerCreativeDirForUser("user-1", { llm: llm as any });
      errSpy.mockRestore();

      expect(userDb.updateUser).toHaveBeenCalledTimes(1);
      const writtenPatch = userDb.updateUser.mock.calls[0][1];
      expect(writtenPatch.creativeDirStatus).toBe("failed");
      expect(writtenPatch.creativeDirError).toContain("bedrock rate limited");
    });

    it("stringifies non-Error thrown values in the failed patch", async () => {
      userDb.getUserById
        .mockResolvedValueOnce({
          userId: "user-1",
          icpResult: [onePersona],
          competitorResult,
        })
        .mockResolvedValueOnce({ userId: "user-1", creativeDirStatus: "running" });
      userDb.updateUser.mockResolvedValue({});

      const weirdLlm = {
        generateJsonRobust: async () => {
          throw "literal-string-thrown";
        },
      };
      const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
      await triggerCreativeDirForUser("user-1", { llm: weirdLlm as any });
      errSpy.mockRestore();
      expect(userDb.updateUser.mock.calls[0][1].creativeDirError).toContain(
        "literal-string-thrown"
      );
    });

    it("uses {} fallback when getUserById returns null on the second read", async () => {
      userDb.getUserById
        .mockResolvedValueOnce({
          userId: "user-1",
          icpResult: [onePersona],
          competitorResult,
        })
        .mockResolvedValueOnce(null);
      userDb.updateUser.mockResolvedValue({});

      const llm = new FakeLlm(fullResponse);
      await triggerCreativeDirForUser("user-1", { llm: llm as any });
      expect(userDb.updateUser).not.toHaveBeenCalled();
    });

    it("uses {} fallback in the failure path when getUserById returns null", async () => {
      userDb.getUserById
        .mockResolvedValueOnce({
          userId: "user-1",
          icpResult: [onePersona],
          competitorResult,
        })
        .mockResolvedValueOnce(null);
      userDb.updateUser.mockResolvedValue({});

      const llm = new FakeLlm(null, new Error("boom"));
      const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
      await triggerCreativeDirForUser("user-1", { llm: llm as any });
      errSpy.mockRestore();

      expect(userDb.updateUser).toHaveBeenCalledTimes(1);
      expect(userDb.updateUser.mock.calls[0][1].creativeDirStatus).toBe("failed");
    });

    it("succeeds even when ICPs and competitor result are missing on user", async () => {
      userDb.getUserById
        .mockResolvedValueOnce({ userId: "user-1" })
        .mockResolvedValueOnce({
          userId: "user-1",
          creativeDirStatus: "running",
        });
      userDb.updateUser.mockResolvedValue({});

      const llm = new FakeLlm(fullResponse);
      await triggerCreativeDirForUser("user-1", { llm: llm as any });

      expect(userDb.updateUser).toHaveBeenCalledTimes(1);
      expect(userDb.updateUser.mock.calls[0][1].creativeDirStatus).toBe("ready");
    });
  });

  describe("startCreativeDirForUser", () => {
    beforeEach(() => {
      jest.clearAllMocks();
    });

    it("writes the start patch synchronously and launches background work", async () => {
      userDb.updateUser.mockResolvedValue({});
      userDb.getUserById.mockResolvedValue(null);

      await startCreativeDirForUser("user-1");

      expect(userDb.updateUser).toHaveBeenCalledTimes(1);
      const startPatch = userDb.updateUser.mock.calls[0][1];
      expect(startPatch.creativeDirStatus).toBe("running");
      expect(startPatch.creativeDirStartedAt).toBeTruthy();
    });
  });
});
