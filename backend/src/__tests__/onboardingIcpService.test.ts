/**
 * Onboarding Epic Phase 2 — ICP discovery service tests.
 *
 * Mirrors the onboardingAdGenerator test pattern: pure unit tests against
 * an injected fake LLM. No DynamoDB, no real Bedrock.
 */

// Run cascade trigger synchronously in unit tests (no GSI to wait on).
process.env.CASCADE_TRIGGER_DELAY_MS = "0";

jest.mock("../services/db", () => ({
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
  extractIcpBrandContext,
  generateIcpsForUser,
  ICP_DISCOVERY_SYSTEM_PROMPT,
  mapIcpResultToMarketStrategy,
  startIcpDiscoveryForUser,
  triggerIcpDiscoveryForUser,
} from "../services/onboardingIcpService";
const { userDb } = require("../services/db");

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

    it("includes uploaded onboarding seed context when present", () => {
      const ctx = extractIcpBrandContext({
        companyName: "AgentCap X",
        productDomain: "https://agentcapx.com",
        onboardingSeedContext: {
          files: [
            {
              filename: "ai-compute-capital-markets-brand-seed.md",
              content: "Sell first to GPU providers like Akash, CoreWeave, and Lambda Labs.",
            },
          ],
        },
      });
      expect(ctx.seedFilenames).toEqual([
        "ai-compute-capital-markets-brand-seed.md",
      ]);
      expect(ctx.seedContext).toContain("Akash");
      expect(ctx.seedContext).toContain("CoreWeave");
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

    it("tells the LLM to prioritize uploaded seed context over generic domain inference", async () => {
      const llm = new FakeLlm({ icps: fivePersonas });
      await generateIcpsForUser(
        {
          companyName: "AgentCap X",
          companyUrl: "https://agentcapx.com",
          seedFilenames: ["ai-compute-capital-markets-brand-seed.md"],
          seedContext:
            "AgentCap X should sell first to AI compute providers including Akash, CoreWeave, and Lambda Labs.",
        },
        { llm: llm as any },
      );
      expect(llm.lastUserPrompt).toContain("highest priority");
      expect(llm.lastUserPrompt).toContain("Akash");
      expect(llm.lastUserPrompt).toContain("CoreWeave");
      expect(llm.lastUserPrompt).toContain("source of truth");
      expect(llm.lastUserPrompt).toContain("make those the first ICPs");
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

  describe("triggerIcpDiscoveryForUser (fire-and-forget orchestrator)", () => {
    beforeEach(() => {
      jest.clearAllMocks();
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

  describe("startIcpDiscoveryForUser", () => {
    beforeEach(() => {
      jest.clearAllMocks();
    });

    it("writes the start patch synchronously and launches background work", async () => {
      userDb.updateUser.mockResolvedValue({});
      // Make the background trigger find no user so it terminates fast.
      userDb.getUserById.mockResolvedValue(null);

      await startIcpDiscoveryForUser("user-1");

      expect(userDb.updateUser).toHaveBeenCalledTimes(1);
      const startPatch = userDb.updateUser.mock.calls[0][1];
      expect(startPatch.icpStatus).toBe("running");
      expect(startPatch.icpStartedAt).toBeTruthy();
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
        });
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
