jest.mock('../services/brandGuidelinesPopulation', () => ({ populateEmptyBrandGuidelines: jest.fn().mockResolvedValue(undefined) }));
/**
 * Onboarding Epic Phase 2 — ICP discovery service tests.
 *
 * Mirrors the onboardingAdGenerator test pattern: pure unit tests against
 * an injected fake LLM. No DynamoDB, no real Bedrock.
 */

// Run cascade trigger synchronously in unit tests (no GSI to wait on).
process.env.CASCADE_TRIGGER_DELAY_MS = "0";

jest.mock("../services/db", () => ({
  taskDb: {
    getTasksWithKnowledgeBase: jest.fn(),
  },
  userDb: {
    getUserById: jest.fn(),
    updateUser: jest.fn(),
  },
}));

// Mock the competitor service so we can assert the cascade trigger fires
// from the ICP service after a successful run, without actually doing any
// LLM/network work in this test file.
jest.mock("../services/onboardingCompetitorService", () => ({
  startCompetitorStrategyForUser: jest.fn(),
  triggerCompetitorStrategyForUser: jest.fn(),
}));

import {
  claimIcpRun,
  extractIcpBrandContext,
  generateIcpsForUser,
  ICP_DISCOVERY_SYSTEM_PROMPT,
  loadOnboardingStrategicContextForUser,
  mapIcpResultToMarketStrategy,
  startIcpDiscoveryForUser,
  triggerIcpDiscoveryForUser,
} from "../services/onboardingIcpService";
import { ICP_TIMEOUT_MS } from "../services/icpStatusService";
const { taskDb, userDb } = require("../services/db");

class FakeLlm {
  public lastSystemPrompt = "";
  public lastUserPrompt = "";
  public callCount = 0;

  constructor(
    private readonly response: unknown,
    private readonly throwError?: Error,
  ) {}

  async generateJsonRobust<T = unknown>(
    system: string,
    user: string,
  ): Promise<T> {
    this.callCount += 1;
    this.lastSystemPrompt = system;
    this.lastUserPrompt = user;
    if (this.throwError) throw this.throwError;
    return this.response as T;
  }
}

const fivePersonas = [
  {
    name: "P1",
    pain: "p1",
    desire: "d1",
    objection: "o1",
    meta_targeting_brief: "b1",
  },
  {
    name: "P2",
    pain: "p2",
    desire: "d2",
    objection: "o2",
    meta_targeting_brief: "b2",
  },
  {
    name: "P3",
    pain: "p3",
    desire: "d3",
    objection: "o3",
    meta_targeting_brief: "b3",
  },
  {
    name: "P4",
    pain: "p4",
    desire: "d4",
    objection: "o4",
    meta_targeting_brief: "b4",
  },
  {
    name: "P5",
    pain: "p5",
    desire: "d5",
    objection: "o5",
    meta_targeting_brief: "b5",
  },
];

describe("onboardingIcpService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    taskDb.getTasksWithKnowledgeBase.mockResolvedValue([]);
  });

  describe("extractIcpBrandContext", () => {
    it("reads brand fields from brandGuidelines.brandData when present", () => {
      const user = {
        brandGuidelines: {
          brandData: {
            brandName: "Linear",
            domain: "linear.app",
            tagline: "Issue tracking you'll enjoy using",
            valueProposition: "Fast, minimal issue tracking",
            targetAudience: "Software teams",
            toneOfVoice: "Confident, direct",
          },
        },
      };
      const ctx = extractIcpBrandContext(user);
      expect(ctx.companyName).toBe("Linear");
      expect(ctx.companyUrl).toBe("linear.app");
      expect(ctx.tagline).toBe("Issue tracking you'll enjoy using");
      expect(ctx.valueProposition).toBe("Fast, minimal issue tracking");
    });

    it("falls back to top-level companyName / productDomain when brandGuidelines absent", () => {
      const user = { companyName: "Acme", productDomain: "acme.io" };
      const ctx = extractIcpBrandContext(user);
      expect(ctx.companyName).toBe("Acme");
      expect(ctx.companyUrl).toBe("acme.io");
      expect(ctx.tagline).toBeUndefined();
    });

    it("returns empty object when no brand data is available", () => {
      expect(extractIcpBrandContext({})).toEqual({});
    });

    it("does not include unset optional fields in the returned object", () => {
      const ctx = extractIcpBrandContext({
        brandGuidelines: { brandData: { brandName: "Acme" } },
      });
      expect(ctx.companyName).toBe("Acme");
      // tagline/valueProposition/targetAudience/toneOfVoice/companyUrl are absent
      expect("tagline" in ctx).toBe(false);
      expect("valueProposition" in ctx).toBe(false);
      expect("targetAudience" in ctx).toBe(false);
      expect("toneOfVoice" in ctx).toBe(false);
      expect("companyUrl" in ctx).toBe(false);
    });

    it("uses brandGuidelines.brandData even when top-level companyName is also set", () => {
      const ctx = extractIcpBrandContext({
        companyName: "Old Name",
        productDomain: "old.com",
        brandGuidelines: { brandData: { brandName: "New Name", domain: "new.com" } },
      });
      expect(ctx.companyName).toBe("New Name");
      expect(ctx.companyUrl).toBe("new.com");
    });

    it("includes explicit onboarding strategic context when present", () => {
      const ctx = extractIcpBrandContext({
        companyName: "AgentCap X",
        onboardingStrategicContext:
          "Sell supply-side first: Akash, CoreWeave, GPU clouds, and decentralized compute networks.",
      });

      expect(ctx.strategicContext).toContain("supply-side first");
      expect(ctx.strategicContext).toContain("CoreWeave");
    });
  });

  describe("generateIcpsForUser", () => {
    it("returns 5 personas parsed from LLM response", async () => {
      const llm = new FakeLlm({ icps: fivePersonas });
      const result = await generateIcpsForUser(
        { companyName: "Linear", valueProposition: "Fast issue tracking" },
        { llm: llm as any },
      );
      expect(result).toHaveLength(5);
      expect(result[0].name).toBe("P1");
      expect(result[4].meta_targeting_brief).toBe("b5");
    });

    it("caps at 5 personas if LLM returns more", async () => {
      const tooMany = Array.from({ length: 9 }, (_, i) => ({
        name: `n${i}`,
        pain: `p${i}`,
        desire: `d${i}`,
        objection: `o${i}`,
        meta_targeting_brief: `b${i}`,
      }));
      const llm = new FakeLlm({ icps: tooMany });
      const result = await generateIcpsForUser(
        { companyName: "Acme" },
        { llm: llm as any },
      );
      expect(result).toHaveLength(5);
    });

    it("throws when the LLM returns no icps key", async () => {
      const llm = new FakeLlm({ unrelated: 42 });
      await expect(
        generateIcpsForUser({ companyName: "Acme" }, { llm: llm as any }),
      ).rejects.toThrow(/icps/i);
    });

    it("propagates LLM errors verbatim", async () => {
      const llm = new FakeLlm(null, new Error("bedrock 429"));
      await expect(
        generateIcpsForUser({ companyName: "Acme" }, { llm: llm as any }),
      ).rejects.toThrow(/bedrock 429/);
    });

    it("uses the prod work-plan Step 2 system prompt verbatim", async () => {
      const llm = new FakeLlm({ icps: fivePersonas });
      await generateIcpsForUser(
        { companyName: "Acme" },
        { llm: llm as any },
      );
      // The system prompt MUST contain language unique to the prod work plan
      // (Step 2 of plan_1768351741814_jgc2wwlxa). If you change the prompt
      // copy, update Notion task and the prod plan first, then this test.
      expect(llm.lastSystemPrompt).toContain("Ideal Customer Profiles");
      expect(llm.lastSystemPrompt).toContain("Firmographics");
      expect(llm.lastSystemPrompt).toContain("Psychographics");
      expect(ICP_DISCOVERY_SYSTEM_PROMPT).toBe(llm.lastSystemPrompt);
    });

    it("includes brand context in the user prompt", async () => {
      const llm = new FakeLlm({ icps: fivePersonas });
      await generateIcpsForUser(
        {
          companyName: "Linear",
          valueProposition: "Fast issue tracking",
          targetAudience: "Software teams",
        },
        { llm: llm as any },
      );
      expect(llm.lastUserPrompt).toContain("Linear");
      expect(llm.lastUserPrompt).toContain("Fast issue tracking");
      expect(llm.lastUserPrompt).toContain("Software teams");
    });

    it("includes strategic context and marketplace sequencing instructions in the user prompt", async () => {
      const llm = new FakeLlm({ icps: fivePersonas });
      await generateIcpsForUser(
        {
          companyName: "AgentCap X",
          strategicContext:
            "This marketplace must win supply first. Prioritize GPU cloud providers like Akash and CoreWeave before end buyers.",
        },
        { llm: llm as any },
      );

      expect(llm.lastUserPrompt).toContain("Strategic context from user-provided onboarding docs/notes");
      expect(llm.lastUserPrompt).toContain("Akash");
      expect(llm.lastUserPrompt).toContain("CoreWeave");
      expect(llm.lastUserPrompt).toContain("supply-side providers");
      expect(llm.lastUserPrompt).toContain("do not default to generic founders");
    });

    it("falls back gracefully when brand context is empty", async () => {
      const llm = new FakeLlm({ icps: fivePersonas });
      const result = await generateIcpsForUser({}, { llm: llm as any });
      expect(result).toHaveLength(5);
      expect(llm.lastUserPrompt).toContain("not provided");
    });

    it("emits every optional brand field into the user prompt when all provided", async () => {
      const llm = new FakeLlm({ icps: fivePersonas });
      await generateIcpsForUser(
        {
          companyName: "Linear",
          companyUrl: "linear.app",
          tagline: "Issue tracking",
          valueProposition: "Fast",
          targetAudience: "Software teams",
          toneOfVoice: "Direct",
        },
        { llm: llm as any },
      );
      expect(llm.lastUserPrompt).toContain("Website: linear.app");
      expect(llm.lastUserPrompt).toContain("Tagline: Issue tracking");
      expect(llm.lastUserPrompt).toContain("Value proposition: Fast");
      expect(llm.lastUserPrompt).toContain("Target audience hint: Software teams");
      expect(llm.lastUserPrompt).toContain("Tone of voice: Direct");
    });

    it("returns sanitisation result when LLM returns null icps", async () => {
      const llm = new FakeLlm({ icps: null });
      // sanitizeICPPersonas treats non-array as empty -> no throw, but throws inside generateIcpsForUser
      await expect(
        generateIcpsForUser({ companyName: "Acme" }, { llm: llm as any }),
      ).rejects.toThrow(/icps/i);
    });

    it("filters malformed personas from the LLM output", async () => {
      const llm = new FakeLlm({
        icps: [
          fivePersonas[0],
          { name: "no-pain-field" }, // missing fields
          fivePersonas[1],
          null, // null entry
          fivePersonas[2],
        ],
      });
      const result = await generateIcpsForUser(
        { companyName: "Acme" },
        { llm: llm as any },
      );
      // Only the well-formed ones survive sanitisation.
      expect(result.map((p) => p.name)).toEqual(["P1", "P2", "P3"]);
    });
  });

  describe("loadOnboardingStrategicContextForUser", () => {
    it("loads bounded context from searchable text on uploaded brand docs", async () => {
      taskDb.getTasksWithKnowledgeBase.mockResolvedValue([
        {
          taskId: "task-1",
          name: "Brand Documents",
          knowledgeBaseFiles: [
            {
              filename: "ai-compute-capital-markets-brand-seed.md",
              key: "tasks/task-1/knowledge-base-files/seed.md",
              searchableText:
                "AgentCap X should sell supply-side first to Akash, CoreWeave, and other GPU compute providers.",
              uploadedAt: "2026-06-23T03:44:34.893Z",
            },
          ],
        },
      ]);

      const context = await loadOnboardingStrategicContextForUser("user-1");

      expect(context).toContain("ai-compute-capital-markets-brand-seed.md");
      expect(context).toContain("sell supply-side first");
      expect(context).toContain("CoreWeave");
    });

    it("ignores non-text uploaded files for prompt context", async () => {
      taskDb.getTasksWithKnowledgeBase.mockResolvedValue([
        {
          taskId: "task-1",
          name: "Brand Documents",
          knowledgeBaseFiles: [
            {
              filename: "brand-logo.png",
              key: "s3:users/u/files/logo.png",
              searchableText: "should not be used",
              uploadedAt: "2026-06-23T03:44:34.893Z",
            },
          ],
        },
      ]);

      await expect(loadOnboardingStrategicContextForUser("user-1")).resolves.toBeNull();
    });
  });

  describe("triggerIcpDiscoveryForUser (fire-and-forget orchestrator)", () => {
    beforeEach(() => {
      jest.clearAllMocks();
      taskDb.getTasksWithKnowledgeBase.mockResolvedValue([]);
    });

    it("returns silently when user is missing", async () => {
      userDb.getUserById.mockResolvedValue(null);
      await triggerIcpDiscoveryForUser("missing-user");
      expect(userDb.updateUser).not.toHaveBeenCalled();
    });

    it("patches User with icpReadyPatch when LLM succeeds", async () => {
      userDb.getUserById
        .mockResolvedValueOnce({
          userId: "user-1",
          brandGuidelines: { brandData: { brandName: "Linear" } },
        })
        .mockResolvedValueOnce({
          userId: "user-1",
          icpStatus: "running",
          icpStartedAt: "2026-04-24T11:59:00.000Z",
        });
      userDb.updateUser.mockResolvedValue({});

      const llm = new FakeLlm({ icps: fivePersonas });
      await triggerIcpDiscoveryForUser("user-1", { llm: llm as any });

      expect(userDb.updateUser).toHaveBeenCalledTimes(1);
      const writtenPatch = userDb.updateUser.mock.calls[0][1];
      expect(writtenPatch.icpStatus).toBe("ready");
      expect(writtenPatch.icpResult).toHaveLength(5);
    });

    // ENG-2308 review follow-up, confirmed by direct reproduction against
    // the real icpStartPatch/icpReadyPatch functions: the stale-claim
    // escape hatch lets a reclaim supersede a merely-slow (not crashed)
    // run. icpReadyPatch's own guard only checks icpStatus === "running",
    // not WHICH run's "running" it is — without an ownership check on the
    // WRITE itself, this run's zombie completion can land after a
    // reclaim's own completion and silently clobber it.
    it("conditions the completion write on this run's own icpStartedAt when expectedStartedAt is provided", async () => {
      userDb.getUserById
        .mockResolvedValueOnce({ userId: "user-1" })
        .mockResolvedValueOnce({
          userId: "user-1",
          icpStatus: "running",
          icpStartedAt: "2026-04-24T11:59:00.000Z",
        });
      userDb.updateUser.mockResolvedValue({});

      const llm = new FakeLlm({ icps: fivePersonas });
      await triggerIcpDiscoveryForUser("user-1", {
        llm: llm as any,
        expectedStartedAt: "2026-04-24T11:59:00.000Z",
      });

      const options = userDb.updateUser.mock.calls[0][2];
      expect(options?.condition?.expression).toBe(
        "#icpStartedAt = :icpOwnerStartedAt",
      );
      expect(options?.condition?.values?.[":icpOwnerStartedAt"]).toBe(
        "2026-04-24T11:59:00.000Z",
      );
    });

    // ENG-2308 live finding: a /icp/regenerate-one that overlapped this run
    // keeps our icpStartedAt but sets `ready` (~6s) before we finish (~12-22s).
    // That used to make icpReadyPatch return null and silently drop the
    // whole-set result. The write is conditioned on our own claim, so it is safe.
    it.each(["ready", "failed"])(
      "still lands the whole-set result when a regenerate-one left status %s but the claim is still ours",
      async (status) => {
        const claim = "2026-04-24T11:59:00.000Z";
        userDb.getUserById
          .mockResolvedValueOnce({ userId: "user-1" })
          .mockResolvedValueOnce({
            userId: "user-1",
            icpStatus: status,
            icpStartedAt: claim,
          });
        userDb.updateUser.mockResolvedValue({});

        await triggerIcpDiscoveryForUser("user-1", {
          llm: new FakeLlm({ icps: fivePersonas }) as any,
          expectedStartedAt: claim,
        });

        const [, patch, options] = userDb.updateUser.mock.calls[0];
        expect(patch.icpStatus).toBe("ready");
        expect(patch.icpResult).toHaveLength(5);
        expect(options.condition.values[":icpOwnerStartedAt"]).toBe(claim);
      },
    );

    it("clears the failed attempt's error when it lands over a failed status", async () => {
      const claim = "2026-04-24T11:59:00.000Z";
      userDb.getUserById
        .mockResolvedValueOnce({ userId: "user-1" })
        .mockResolvedValueOnce({ userId: "user-1", icpStatus: "failed", icpStartedAt: claim, icpError: "icp generation timed out" });
      userDb.updateUser.mockResolvedValue({});
      await triggerIcpDiscoveryForUser("user-1", { llm: new FakeLlm({ icps: fivePersonas }) as any, expectedStartedAt: claim });
      expect(userDb.updateUser.mock.calls[0][1].icpError).toBeNull();
    });

    it("does NOT land the result when the non-running record belongs to a different claim", async () => {
      userDb.getUserById
        .mockResolvedValueOnce({ userId: "user-1" })
        .mockResolvedValueOnce({
          userId: "user-1",
          icpStatus: "ready",
          icpStartedAt: "2026-04-24T12:05:00.000Z",
        });
      userDb.updateUser.mockResolvedValue({});

      await triggerIcpDiscoveryForUser("user-1", {
        llm: new FakeLlm({ icps: fivePersonas }) as any,
        expectedStartedAt: "2026-04-24T11:59:00.000Z",
      });

      expect(userDb.updateUser).not.toHaveBeenCalled();
    });

    it("drops the completion silently when a reclaim has superseded this run (ConditionalCheckFailedException), without mirroring or cascading", async () => {
      userDb.getUserById
        .mockResolvedValueOnce({ userId: "user-1" })
        .mockResolvedValueOnce({
          userId: "user-1",
          icpStatus: "running",
          // A reclaim's fresh startedAt — different from the stale
          // expectedStartedAt this (zombie) run was given below.
          icpStartedAt: "2026-04-24T12:05:00.000Z",
        });
      const conditionalFailure = Object.assign(
        new Error("The conditional request failed"),
        { code: "ConditionalCheckFailedException" },
      );
      userDb.updateUser.mockRejectedValueOnce(conditionalFailure);

      const llm = new FakeLlm({ icps: fivePersonas });
      await expect(
        triggerIcpDiscoveryForUser("user-1", {
          llm: llm as any,
          expectedStartedAt: "2026-04-24T11:59:00.000Z",
        }),
      ).resolves.toBeUndefined();

      // Exactly one write attempt (the one that lost ownership) — no
      // second write, no mirror-to-marketStrategy call.
      expect(userDb.updateUser).toHaveBeenCalledTimes(1);
    });

    it("conditions the failure-path write on this run's own icpStartedAt and drops it silently when superseded", async () => {
      userDb.getUserById
        .mockResolvedValueOnce({ userId: "user-1" })
        // Re-read inside the catch block, after the LLM throws.
        .mockResolvedValueOnce({
          userId: "user-1",
          icpStatus: "running",
          icpStartedAt: "2026-04-24T12:05:00.000Z",
        });
      const conditionalFailure = Object.assign(
        new Error("The conditional request failed"),
        { code: "ConditionalCheckFailedException" },
      );
      userDb.updateUser.mockRejectedValueOnce(conditionalFailure);

      const llm = new FakeLlm(null, new Error("bedrock exploded"));
      await expect(
        triggerIcpDiscoveryForUser("user-1", {
          llm: llm as any,
          expectedStartedAt: "2026-04-24T11:59:00.000Z",
        }),
      ).resolves.toBeUndefined();

      const options = userDb.updateUser.mock.calls[0][2];
      expect(options?.condition?.values?.[":icpOwnerStartedAt"]).toBe(
        "2026-04-24T11:59:00.000Z",
      );
    });

    it("adds uploaded strategic context to ICP generation when user brand fields are sparse", async () => {
      userDb.getUserById
        .mockResolvedValueOnce({
          userId: "user-1",
          companyName: "AgentCap X",
          productDomain: "https://agentcapx.com",
        })
        .mockResolvedValueOnce({
          userId: "user-1",
          icpStatus: "running",
          icpStartedAt: "2026-04-24T11:59:00.000Z",
        });
      userDb.updateUser.mockResolvedValue({});

      const llm = new FakeLlm({ icps: fivePersonas });
      await triggerIcpDiscoveryForUser("user-1", {
        llm: llm as any,
        loadStrategicContext: async () =>
          "Sell to supply-side GPU providers first: Akash, CoreWeave, decentralized compute networks.",
      });

      expect(llm.lastUserPrompt).toContain("Akash");
      expect(llm.lastUserPrompt).toContain("CoreWeave");
      expect(llm.lastUserPrompt).toContain("supply-side GPU providers");
      expect(userDb.updateUser.mock.calls[0][1].icpStatus).toBe("ready");
    });

    it("drops the ready patch silently when user is no longer running (stale completion)", async () => {
      userDb.getUserById
        .mockResolvedValueOnce({ userId: "user-1" })
        .mockResolvedValueOnce({ userId: "user-1", icpStatus: "idle" }); // not running

      const llm = new FakeLlm({ icps: fivePersonas });
      await triggerIcpDiscoveryForUser("user-1", { llm: llm as any });

      expect(userDb.updateUser).not.toHaveBeenCalled();
    });

    it("patches with icpFailedPatch when LLM throws", async () => {
      userDb.getUserById
        .mockResolvedValueOnce({ userId: "user-1" })
        .mockResolvedValueOnce({
          userId: "user-1",
          icpStatus: "running",
          icpStartedAt: "2026-04-24T11:59:00.000Z",
        });
      userDb.updateUser.mockResolvedValue({});

      const llm = new FakeLlm(null, new Error("bedrock rate limited"));
      const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
      await triggerIcpDiscoveryForUser("user-1", { llm: llm as any });
      errSpy.mockRestore();

      expect(userDb.updateUser).toHaveBeenCalledTimes(1);
      const writtenPatch = userDb.updateUser.mock.calls[0][1];
      expect(writtenPatch.icpStatus).toBe("failed");
      expect(writtenPatch.icpError).toContain("bedrock rate limited");
    });

    it("patches with failed when LLM returns malformed shape (string err path)", async () => {
      userDb.getUserById
        .mockResolvedValueOnce({ userId: "user-1" })
        .mockResolvedValueOnce({ userId: "user-1", icpStatus: "running" });
      userDb.updateUser.mockResolvedValue({});

      const llm = new FakeLlm({ icps: "not-an-array" });
      const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
      await triggerIcpDiscoveryForUser("user-1", { llm: llm as any });
      errSpy.mockRestore();

      expect(userDb.updateUser).toHaveBeenCalledTimes(1);
      expect(userDb.updateUser.mock.calls[0][1].icpStatus).toBe("failed");
    });

    it("stringifies non-Error thrown values in the failed patch", async () => {
      userDb.getUserById
        .mockResolvedValueOnce({ userId: "user-1" })
        .mockResolvedValueOnce({ userId: "user-1", icpStatus: "running" });
      userDb.updateUser.mockResolvedValue({});

      // LLM throws a literal string (not an Error instance) — exercises String(err) path.
      const weirdLlm = {
        generateJsonRobust: async () => {
          throw "literal-string-thrown";
        },
      };
      const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
      await triggerIcpDiscoveryForUser("user-1", { llm: weirdLlm as any });
      errSpy.mockRestore();

      expect(userDb.updateUser).toHaveBeenCalledTimes(1);
      expect(userDb.updateUser.mock.calls[0][1].icpError).toContain(
        "literal-string-thrown",
      );
    });

    it("uses {} fallback when getUserById returns null on the second read (race condition)", async () => {
      userDb.getUserById
        .mockResolvedValueOnce({ userId: "user-1" }) // first read OK
        .mockResolvedValueOnce(null); // user disappeared between LLM and patch read
      userDb.updateUser.mockResolvedValue({});

      const llm = new FakeLlm({ icps: fivePersonas });
      await triggerIcpDiscoveryForUser("user-1", { llm: llm as any });

      // Empty {} fallback is not in `running` so icpReadyPatch returns null
      // and we drop silently — no DB write.
      expect(userDb.updateUser).not.toHaveBeenCalled();
    });

    it("uses {} fallback in the failure path when getUserById returns null", async () => {
      userDb.getUserById
        .mockResolvedValueOnce({ userId: "user-1" })
        .mockResolvedValueOnce(null); // disappeared before failed patch
      userDb.updateUser.mockResolvedValue({});

      const llm = new FakeLlm(null, new Error("boom"));
      const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
      await triggerIcpDiscoveryForUser("user-1", { llm: llm as any });
      errSpy.mockRestore();

      // Failure path always writes (even with {} fallback).
      expect(userDb.updateUser).toHaveBeenCalledTimes(1);
      expect(userDb.updateUser.mock.calls[0][1].icpStatus).toBe("failed");
    });

    it("fire-and-forgets triggerCompetitorStrategyForUser after successful icp completion (cascade kickoff)", async () => {
      userDb.getUserById
        .mockResolvedValueOnce({
          userId: "user-1",
          brandGuidelines: { brandData: { brandName: "Linear" } },
        })
        .mockResolvedValueOnce({
          userId: "user-1",
          icpStatus: "running",
          icpStartedAt: "2026-04-24T11:59:00.000Z",
        });
      userDb.updateUser.mockResolvedValue({});

      const {
        startCompetitorStrategyForUser,
      } = require("../services/onboardingCompetitorService");
      (startCompetitorStrategyForUser as jest.Mock).mockClear();

      const llm = new FakeLlm({ icps: fivePersonas });
      await triggerIcpDiscoveryForUser("user-1", { llm: llm as any });

      // ICP must have been persisted as ready first.
      expect(userDb.updateUser).toHaveBeenCalledTimes(1);
      expect(userDb.updateUser.mock.calls[0][1].icpStatus).toBe("ready");

      // Cascade kickoff: competitor service start called exactly once with userId.
      expect(startCompetitorStrategyForUser).toHaveBeenCalledTimes(1);
      expect(startCompetitorStrategyForUser).toHaveBeenCalledWith("user-1");
    });

    it("does NOT trigger competitor when ICP completion is dropped silently (stale)", async () => {
      userDb.getUserById
        .mockResolvedValueOnce({ userId: "user-1" })
        .mockResolvedValueOnce({ userId: "user-1", icpStatus: "idle" }); // not running

      const {
        startCompetitorStrategyForUser,
      } = require("../services/onboardingCompetitorService");
      (startCompetitorStrategyForUser as jest.Mock).mockClear();

      const llm = new FakeLlm({ icps: fivePersonas });
      await triggerIcpDiscoveryForUser("user-1", { llm: llm as any });

      expect(userDb.updateUser).not.toHaveBeenCalled();
      // No DB write of `ready` ⇒ no cascade kickoff.
      expect(startCompetitorStrategyForUser).not.toHaveBeenCalled();
    });

    it("does NOT cross-call competitor when the user is on `useEagerPipeline` (orchestrator owns step ordering)", async () => {
      // Eager DAG sub-task 2: the legacy ICP→Competitor cross-call must
      // be skipped when the orchestrator is driving step ordering. The
      // orchestrator's reconcile loop will pick up `competitor` once
      // `icp` is `ready` in `User.steps`. Without the gate, both the
      // legacy cascade AND the orchestrator would race to fire the
      // competitor step.
      userDb.getUserById
        .mockResolvedValueOnce({
          userId: "user-1",
          brandGuidelines: { brandData: { brandName: "Linear" } },
          useEagerPipeline: true,
        })
        .mockResolvedValueOnce({
          userId: "user-1",
          icpStatus: "running",
          icpStartedAt: "2026-04-24T11:59:00.000Z",
          useEagerPipeline: true,
        });
      userDb.updateUser.mockResolvedValue({});

      const {
        startCompetitorStrategyForUser,
      } = require("../services/onboardingCompetitorService");
      (startCompetitorStrategyForUser as jest.Mock).mockClear();

      const llm = new FakeLlm({ icps: fivePersonas });
      await triggerIcpDiscoveryForUser("user-1", { llm: llm as any });

      // ICP itself still completes normally — the read-and-write path
      // is unchanged. Only the cross-call cascade is gated.
      expect(userDb.updateUser).toHaveBeenCalledTimes(1);
      expect(userDb.updateUser.mock.calls[0][1].icpStatus).toBe("ready");

      // No legacy cross-call cascade — orchestrator owns it.
      expect(startCompetitorStrategyForUser).not.toHaveBeenCalled();
    });

    it("does NOT trigger competitor when ICP fails (cascade should not fire on failure)", async () => {
      userDb.getUserById
        .mockResolvedValueOnce({ userId: "user-1" })
        .mockResolvedValueOnce({
          userId: "user-1",
          icpStatus: "running",
          icpStartedAt: "2026-04-24T11:59:00.000Z",
        });
      userDb.updateUser.mockResolvedValue({});

      const {
        startCompetitorStrategyForUser,
      } = require("../services/onboardingCompetitorService");
      (startCompetitorStrategyForUser as jest.Mock).mockClear();

      const llm = new FakeLlm(null, new Error("bedrock down"));
      const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
      await triggerIcpDiscoveryForUser("user-1", { llm: llm as any });
      errSpy.mockRestore();

      expect(userDb.updateUser).toHaveBeenCalledTimes(1);
      expect(userDb.updateUser.mock.calls[0][1].icpStatus).toBe("failed");
      expect(startCompetitorStrategyForUser).not.toHaveBeenCalled();
    });
  });

  // ENG-2308 follow-up, caught live: the eager-pipeline orchestrator's
  // runIcp used to call triggerIcpDiscoveryForUser directly, with nothing
  // ever flipping icpStatus to running first on a pure orchestrator-driven
  // cascade — icpReadyPatch requires icpStatus === 'running' to persist a
  // result, so the trigger ran for real then silently dropped it, and the
  // orchestrator recorded the step "ready" with a null output anyway.
  // claimIcpRun is the extracted, reusable claim both startIcpDiscoveryForUser
  // and the orchestrator's runIcp now go through.
  describe("claimIcpRun", () => {
    beforeEach(() => {
      jest.clearAllMocks();
    });

    it("claims the axis and returns the persisted patch", async () => {
      userDb.updateUser.mockResolvedValue({});
      const patch = await claimIcpRun("user-1");
      expect(patch).not.toBeNull();
      expect(patch?.icpStatus).toBe("running");
      expect(userDb.updateUser).toHaveBeenCalledTimes(1);
      const options = userDb.updateUser.mock.calls[0][2];
      expect(options?.condition?.expression).toContain("icpStatus");
    });

    it("returns null without throwing when it loses the claim", async () => {
      const conditionalFailure = Object.assign(
        new Error("The conditional request failed"),
        { code: "ConditionalCheckFailedException" },
      );
      userDb.updateUser.mockRejectedValueOnce(conditionalFailure);
      const patch = await claimIcpRun("user-1");
      expect(patch).toBeNull();
    });
  });

  describe("startIcpDiscoveryForUser", () => {
    beforeEach(() => {
      jest.clearAllMocks();
    });

    it("writes the start patch synchronously and launches background work", async () => {
      userDb.updateUser.mockResolvedValue({});
      // Make the background trigger find no user so it terminates fast.
      userDb.getUserById.mockResolvedValue(null);

      const result = await startIcpDiscoveryForUser("user-1");

      expect(userDb.updateUser).toHaveBeenCalledTimes(1);
      const startPatch = userDb.updateUser.mock.calls[0][1];
      expect(startPatch.icpStatus).toBe("running");
      expect(startPatch.icpStartedAt).toBeTruthy();
      // The claim also clears the previous attempt's error (REMOVE, via null);
      // the returned patch is the same run without that storage-only marker.
      expect(startPatch.icpError).toBeNull();
      expect(result).toEqual({ ...startPatch, icpError: undefined });
    });

    // ENG-2308: OutreachIcpPick's 8s watchdog re-fires /icp/start whenever
    // generation is still running past that window — which real generation
    // routinely is. Without an atomic claim, a concurrent call that reads a
    // stale non-running status launches a second, fully parallel LLM
    // generation that races the first to decide which personas persist.
    it("claims the running transition with a ConditionExpression guarding against a concurrent in-flight run", async () => {
      userDb.updateUser.mockResolvedValue({});
      userDb.getUserById.mockResolvedValue(null);

      const before = Date.now();
      await startIcpDiscoveryForUser("user-1");

      const options = userDb.updateUser.mock.calls[0][2];
      expect(options?.condition?.expression).toBe(
        "attribute_not_exists(#icpStatus) OR #icpStatus <> :icpRunning OR #icpStartedAt <= :icpStaleBefore",
      );
      expect(options?.condition?.names).toEqual({
        "#icpStatus": "icpStatus",
        "#icpStartedAt": "icpStartedAt",
      });
      expect(options?.condition?.values?.[":icpRunning"]).toBe("running");
      // ENG-2308 fix-of-a-fix: the stale-claim escape hatch — without it, a
      // run genuinely stuck in `running` (lost to a deploy/crash) could
      // never be retried again, since the exclusive claim would block every
      // future /icp/start forever. The threshold is "now minus the same
      // ICP_TIMEOUT_MS the FE's `timedOut` flag already uses", computed
      // fresh on every call (not a fixed constant).
      const staleBefore = Date.parse(options?.condition?.values?.[":icpStaleBefore"]);
      expect(staleBefore).toBeGreaterThanOrEqual(before - ICP_TIMEOUT_MS - 1000);
      expect(staleBefore).toBeLessThanOrEqual(Date.now() - ICP_TIMEOUT_MS + 1000);
    });

    it("returns null and launches no background work when it loses the race to a concurrent caller", async () => {
      // Not on the eager pipeline, so this exercises the claim path.
      userDb.getUserById.mockResolvedValue({ userId: "user-1" });
      const conditionalFailure = Object.assign(
        new Error("The conditional request failed"),
        { code: "ConditionalCheckFailedException" },
      );
      userDb.updateUser.mockRejectedValue(conditionalFailure);

      const result = await startIcpDiscoveryForUser("user-1");

      expect(result).toBeNull();
      // Only the failed claim attempt — no background-trigger writes, and
      // in particular no second generateJsonRobust call could have been
      // reached from here. getUserById IS called once (to check eager
      // status before claiming — ENG-2308 fix-of-a-fix), but that's the
      // extent of it.
      expect(userDb.updateUser).toHaveBeenCalledTimes(1);
      expect(userDb.getUserById).toHaveBeenCalledTimes(1);
    });

    // ENG-2308 fix-of-a-fix, caught live against a real preview + real
    // eager-pipeline account: runIcp claims this SAME axis itself (with
    // its own call to claimIcpRun) when the orchestrator actually fires
    // the step, inside the SAME reconcile pass this function delegates to.
    // If this function ALSO claimed before checking eager status, its own
    // claim would always win an instant before handing off, permanently
    // starving runIcp's claim moments later. Must check eager status and
    // skip claiming entirely in that case, leaving claimIcpRun as the sole
    // claimant — exactly like ad-image's existing fix.
    it("does not claim the axis itself on the eager pipeline — leaves the claim to runIcp", async () => {
      userDb.getUserById.mockResolvedValue({ userId: "user-1", useEagerPipeline: true });
      const orchestratorWiring = require("../services/onboardingOrchestratorWiring");
      const reconcileSpy = jest
        .spyOn(orchestratorWiring, "reconcileForUser")
        .mockImplementation(async () => {});
      try {
        const result = await startIcpDiscoveryForUser("user-1");

        expect(result).toBeNull();
        expect(userDb.updateUser).not.toHaveBeenCalled();
        expect(reconcileSpy).toHaveBeenCalledWith("user-1");
      } finally {
        reconcileSpy.mockRestore();
      }
    });

    it("re-throws a non-conditional DynamoDB error", async () => {
      // jest.clearAllMocks() (beforeEach) does not reset the previous test's
      // mockResolvedValue — without this, a prior eager-pipeline test's
      // `useEagerPipeline: true` leaks in, and since the eager check now
      // runs BEFORE the claim write, this test would short-circuit to the
      // reconcile branch and never reach updateUser at all.
      userDb.getUserById.mockResolvedValue({ userId: "user-1" });
      userDb.updateUser.mockRejectedValue(
        Object.assign(new Error("boom"), {
          code: "ProvisionedThroughputExceededException",
        }),
      );

      await expect(startIcpDiscoveryForUser("user-1")).rejects.toThrow("boom");
    });
  });

  /**
   * Prose-recovery tests — the regression class behind PR #666 / Phase 4 ad-gen.
   * The real `LLMService.generateJsonRobust` strips fences + balanced-brace
   * extracts + retries once on failure. Service-level callers should reach
   * `ready` whenever ANY of those layers recover JSON, and reach `failed`
   * with a useful breadcrumb when all layers exhaust.
   *
   * We exercise this end-to-end by simulating the robust method's contract
   * directly inside the FakeLlm (so we don't have to spin up the real
   * Bedrock client).
   */
  describe("prose-recovery via generateJsonRobust", () => {
    beforeEach(() => {
      jest.clearAllMocks();
    });

    it("reaches ready when the robust LLM call recovers from a prose-then-JSON response", async () => {
      // Simulating: real LLM returned prose-wrapped JSON, generateJsonRobust
      // recovered it via balanced-brace extraction and returned the parsed
      // object. The service sees a clean object — that is the contract.
      userDb.getUserById
        .mockResolvedValueOnce({ userId: "user-1" })
        .mockResolvedValueOnce({
          userId: "user-1",
          icpStatus: "running",
          icpStartedAt: "2026-04-24T11:59:00.000Z",
        })
        // mirrorIcpsToMarketStrategy's own re-read is a 3rd call. Pin it to
        // null (no user found -> early return, no extra write) instead of
        // relying on whatever default a previous test in this file left
        // behind — jest.clearAllMocks() (beforeEach) does not reset a
        // previous test's persistent mockResolvedValue default.
        .mockResolvedValue(null);
      userDb.updateUser.mockResolvedValue({});

      const llm = new FakeLlm({ icps: fivePersonas });
      await triggerIcpDiscoveryForUser("user-1", { llm: llm as any });

      expect(userDb.updateUser).toHaveBeenCalledTimes(1);
      const patch = userDb.updateUser.mock.calls[0][1];
      expect(patch.icpStatus).toBe("ready");
      expect(patch.icpResult).toHaveLength(5);
    });

    it("reaches failed with a debuggable error when the robust LLM call exhausts retries", async () => {
      // Simulating: real LLM returned prose twice. generateJsonRobust gave
      // up and threw JsonExtractError carrying the raw snippet.
      userDb.getUserById
        .mockResolvedValueOnce({ userId: "user-1" })
        .mockResolvedValueOnce({
          userId: "user-1",
          icpStatus: "running",
          icpStartedAt: "2026-04-24T11:59:00.000Z",
        });
      userDb.updateUser.mockResolvedValue({});

      // Reuse the real JsonExtractError class so the service's String(err.message)
      // path runs identically to production.
      const {
        JsonExtractError,
      } = require("../services/util/extractJson");
      const llm = {
        generateJsonRobust: jest.fn(async () => {
          throw new JsonExtractError(
            "could not extract JSON from LLM response",
            "It looks like I cannot generate that right now.",
          );
        }),
      };
      const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
      await triggerIcpDiscoveryForUser("user-1", { llm: llm as any });
      errSpy.mockRestore();

      expect(userDb.updateUser).toHaveBeenCalledTimes(1);
      const patch = userDb.updateUser.mock.calls[0][1];
      expect(patch.icpStatus).toBe("failed");
      // Error message persisted; capped at 512 chars by icpFailedPatch.
      expect(typeof patch.icpError).toBe("string");
      expect(patch.icpError.length).toBeGreaterThan(0);
      expect(patch.icpError.length).toBeLessThanOrEqual(512);
      expect(patch.icpError).toContain("could not extract JSON");
    });
  });

  // Mirror v2 onboarding ICPs to User.marketStrategy.icp[] so the rest of
  // the product (Agent Mode, chatbot) sees them. Bug from 2026-04-29:
  // onboarding finishes with icpResult populated but marketStrategy.icp
  // empty, so the main account looks blank.
  describe("mapIcpResultToMarketStrategy", () => {
    it("maps ICPPersona[] into the marketStrategy.icp shape", () => {
      const out = mapIcpResultToMarketStrategy([
        {
          name: "Series A SaaS founder",
          pain: "Pipeline dries up after launch",
          desire: "Predictable demand-gen",
          objection: "Tools are noisy",
          meta_targeting_brief: "founders, US, 20-100 employees",
        } as any,
      ]);
      expect(out).toEqual([
        {
          title: "Series A SaaS founder",
          description: "Pipeline dries up after launch",
          valueProposition: "Predictable demand-gen",
          buyerPersonas: ["founders, US, 20-100 employees"],
        },
      ]);
    });

    it("returns an empty array for empty / non-array input", () => {
      expect(mapIcpResultToMarketStrategy([])).toEqual([]);
      expect(mapIcpResultToMarketStrategy(null as any)).toEqual([]);
      expect(mapIcpResultToMarketStrategy(undefined as any)).toEqual([]);
    });

    it("tolerates missing meta_targeting_brief (returns empty buyerPersonas)", () => {
      const out = mapIcpResultToMarketStrategy([
        { name: "A", pain: "B", desire: "C", objection: "D", meta_targeting_brief: "" } as any,
      ]);
      expect(out[0].buyerPersonas).toEqual([]);
    });
  });

  describe("triggerIcpDiscoveryForUser — marketStrategy mirror", () => {
    it("writes marketStrategy.icp[] alongside the icpReadyPatch when a fresh user record is available", async () => {
      userDb.getUserById
        // 1: initial brand context read
        .mockResolvedValueOnce({
          userId: "user-1",
          brandGuidelines: { brandData: { brandName: "Linear" } },
        })
        // 2: post-LLM read for icpReadyPatch
        .mockResolvedValueOnce({
          userId: "user-1",
          icpStatus: "running",
          icpStartedAt: "2026-04-24T11:59:00.000Z",
        })
        // 3: mirror read (NEW) — needs to find the user so the mirror writes
        .mockResolvedValueOnce({
          userId: "user-1",
          marketStrategy: {
            businessOverview: "existing overview",
            competitors: [{ name: "Existing Co", description: "preserved" }],
            icp: [],
            createdAt: "2026-04-01T00:00:00.000Z",
            updatedAt: "2026-04-01T00:00:00.000Z",
          },
        });
      userDb.updateUser.mockResolvedValue({});

      const llm = new FakeLlm({ icps: fivePersonas });
      await triggerIcpDiscoveryForUser("user-1", { llm: llm as any });

      // Two updates: icpReadyPatch + marketStrategy mirror.
      expect(userDb.updateUser).toHaveBeenCalledTimes(2);

      const firstWrite = userDb.updateUser.mock.calls[0][1];
      expect(firstWrite.icpStatus).toBe("ready");
      expect(firstWrite.icpResult).toHaveLength(5);

      const secondWrite = userDb.updateUser.mock.calls[1][1];
      expect(secondWrite.marketStrategy).toBeDefined();
      expect(secondWrite.marketStrategy.icp).toHaveLength(5);
      // Existing fields preserved.
      expect(secondWrite.marketStrategy.businessOverview).toBe("existing overview");
      expect(secondWrite.marketStrategy.competitors).toEqual([
        { name: "Existing Co", description: "preserved" },
      ]);
      // createdAt preserved, updatedAt bumped.
      expect(secondWrite.marketStrategy.createdAt).toBe("2026-04-01T00:00:00.000Z");
      expect(secondWrite.marketStrategy.updatedAt).not.toBe("2026-04-01T00:00:00.000Z");
    });

    // ENG-1955: the mirror write happens strictly AFTER icpCompletedAt is
    // persisted (write + re-read round-trip), so timestamping the mirror
    // with wall-clock `now()` always looked "newer" than icpCompletedAt —
    // GET /icp/filters's staleness check would then treat every onboarding
    // generation as if the user had just corrected their ICPs on the
    // Market Strategy page, permanently skipping the icpResult cache path.
    // The mirror must instead backdate marketStrategy.updatedAt to the
    // icpCompletedAt of the generation it mirrors.
    it("backdates marketStrategy.updatedAt to icpCompletedAt, not wall-clock now", async () => {
      userDb.getUserById
        .mockResolvedValueOnce({
          userId: "user-1",
          brandGuidelines: { brandData: { brandName: "Linear" } },
        })
        .mockResolvedValueOnce({
          userId: "user-1",
          icpStatus: "running",
          icpStartedAt: "2026-04-24T11:59:00.000Z",
        })
        .mockResolvedValueOnce({ userId: "user-1" });
      userDb.updateUser.mockResolvedValue({});

      const llm = new FakeLlm({ icps: fivePersonas });
      await triggerIcpDiscoveryForUser("user-1", { llm: llm as any });

      const firstWrite = userDb.updateUser.mock.calls[0][1];
      const secondWrite = userDb.updateUser.mock.calls[1][1];
      expect(secondWrite.marketStrategy.updatedAt).toBe(firstWrite.icpCompletedAt);
      // icpUpdatedAt (ENG-1955 follow-up) must be backdated the same way —
      // this write genuinely sets `icp`, but it's still a system mirror, not
      // wall-clock "now", for the same reason updatedAt is backdated above.
      expect(secondWrite.marketStrategy.icpUpdatedAt).toBe(firstWrite.icpCompletedAt);
    });

    it("seeds marketStrategy when User has no prior marketStrategy", async () => {
      userDb.getUserById
        .mockResolvedValueOnce({ userId: "user-1" })
        .mockResolvedValueOnce({ userId: "user-1", icpStatus: "running" })
        .mockResolvedValueOnce({ userId: "user-1" }); // no marketStrategy yet
      userDb.updateUser.mockResolvedValue({});

      const llm = new FakeLlm({ icps: fivePersonas });
      await triggerIcpDiscoveryForUser("user-1", { llm: llm as any });

      const secondWrite = userDb.updateUser.mock.calls[1][1];
      expect(secondWrite.marketStrategy.icp).toHaveLength(5);
      expect(secondWrite.marketStrategy.businessOverview).toBe("");
      expect(secondWrite.marketStrategy.competitors).toEqual([]);
      expect(secondWrite.marketStrategy.createdAt).toBeDefined();
    });

    it("exits silently when the mirror read returns null (user disappeared)", async () => {
      userDb.getUserById
        .mockResolvedValueOnce({ userId: "user-1" })
        .mockResolvedValueOnce({ userId: "user-1", icpStatus: "running" })
        .mockResolvedValueOnce(null); // user deleted between ready-patch and mirror
      userDb.updateUser.mockResolvedValue({});

      const llm = new FakeLlm({ icps: fivePersonas });
      await triggerIcpDiscoveryForUser("user-1", { llm: llm as any });

      // Only the icpReadyPatch update fired; mirror exited silently.
      expect(userDb.updateUser).toHaveBeenCalledTimes(1);
    });

    it("does NOT mirror when icpReadyPatch is dropped (stale completion)", async () => {
      userDb.getUserById
        .mockResolvedValueOnce({ userId: "user-1" })
        .mockResolvedValueOnce({ userId: "user-1", icpStatus: "idle" }); // not running

      const llm = new FakeLlm({ icps: fivePersonas });
      await triggerIcpDiscoveryForUser("user-1", { llm: llm as any });

      // Stale completion path returns before reaching mirror.
      expect(userDb.updateUser).not.toHaveBeenCalled();
    });
  });
});
