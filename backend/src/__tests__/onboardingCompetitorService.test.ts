/**
 * Onboarding Epic Phase 2 — Competitor strategy service tests.
 *
 * Pure unit tests against an injected fake LLM and an injected fake web
 * searcher. No DynamoDB, no real network.
 */

jest.mock("../services/db", () => ({
  userDb: {
    getUserById: jest.fn(),
    updateUser: jest.fn(),
  },
}));

import {
  generateCompetitorStrategyForUser,
  COMPETITOR_STRATEGY_SYSTEM_PROMPT,
  startCompetitorStrategyForUser,
  triggerCompetitorStrategyForUser,
} from "../services/onboardingCompetitorService";
import type { ICPPersona } from "../services/icpStatusService";
const { userDb } = require("../services/db");

class FakeLlm {
  public calls: Array<{ system: string; user: string }> = [];

  constructor(
    private readonly responses: unknown[],
    private readonly throwError?: Error,
  ) {}

  async generateJsonRobust<T = unknown>(
    system: string,
    user: string,
  ): Promise<T> {
    this.calls.push({ system, user });
    if (this.throwError) throw this.throwError;
    const idx = Math.min(this.calls.length - 1, this.responses.length - 1);
    return this.responses[idx] as T;
  }
}

const samplePersona = (i: number): ICPPersona => ({
  name: `Persona ${i}`,
  pain: `pain ${i}`,
  desire: `desire ${i}`,
  objection: `objection ${i}`,
  meta_targeting_brief: `brief ${i}`,
});

const sampleCompetitorResp = (i: number) => ({
  competitor_names: [`Comp${i}A`, `Comp${i}B`, `Comp${i}C`],
  offer_angles: [`angle${i}-1`, `angle${i}-2`],
  meta_targeting_brief: `meta brief ${i}`,
});

describe("onboardingCompetitorService", () => {
  describe("generateCompetitorStrategyForUser", () => {
    it("returns one per_icp entry per ICP from the User record", async () => {
      const personas = [samplePersona(1), samplePersona(2), samplePersona(3)];
      const llm = new FakeLlm([
        sampleCompetitorResp(1),
        sampleCompetitorResp(2),
        sampleCompetitorResp(3),
      ]);
      const search = jest
        .fn()
        .mockResolvedValue([{ title: "x", url: "https://x.com", snippet: "s" }]);

      const result = await generateCompetitorStrategyForUser(
        { companyName: "Acme" },
        personas,
        { llm: llm as any, webSearchFn: search },
      );
      expect(result.per_icp).toHaveLength(3);
      expect(result.per_icp[0].icp_id).toBe("Persona 1");
      expect(result.per_icp[0].competitor_names).toContain("Comp1A");
      expect(result.per_icp[2].offer_angles).toContain("angle3-2");
    });

    it("calls webSearchFn once per ICP and embeds the snippets in the LLM prompt", async () => {
      const personas = [samplePersona(1), samplePersona(2)];
      const llm = new FakeLlm([
        sampleCompetitorResp(1),
        sampleCompetitorResp(2),
      ]);
      const search = jest.fn(async (query: string) => [
        {
          title: `Top result for ${query}`,
          url: `https://res.example/${encodeURIComponent(query)}`,
          snippet: `snippet for ${query}`,
        },
      ]);

      await generateCompetitorStrategyForUser(
        { companyName: "Acme" },
        personas,
        { llm: llm as any, webSearchFn: search },
      );
      expect(search).toHaveBeenCalledTimes(personas.length);
      // Each LLM call must have search context embedded.
      expect(llm.calls[0].user).toContain("snippet for");
      expect(llm.calls[1].user).toContain("snippet for");
    });

    it("survives webSearchFn failures and still produces per_icp entries", async () => {
      const personas = [samplePersona(1)];
      const llm = new FakeLlm([sampleCompetitorResp(1)]);
      const search = jest
        .fn()
        .mockRejectedValue(new Error("search api down"));

      const result = await generateCompetitorStrategyForUser(
        { companyName: "Acme" },
        personas,
        { llm: llm as any, webSearchFn: search },
      );
      expect(result.per_icp).toHaveLength(1);
      // Prompt should note that search failed / no data.
      expect(llm.calls[0].user.toLowerCase()).toMatch(
        /no .* data|unavailable|search failed/,
      );
    });

    it("works without any webSearchFn injected (best-effort)", async () => {
      const personas = [samplePersona(1)];
      const llm = new FakeLlm([sampleCompetitorResp(1)]);

      const result = await generateCompetitorStrategyForUser(
        { companyName: "Acme" },
        personas,
        { llm: llm as any },
      );
      expect(result.per_icp).toHaveLength(1);
      expect(llm.calls).toHaveLength(1);
    });

    it("throws when ICP list is empty (Step 3 cannot run before Step 2)", async () => {
      const llm = new FakeLlm([]);
      await expect(
        generateCompetitorStrategyForUser({ companyName: "Acme" }, [], {
          llm: llm as any,
        }),
      ).rejects.toThrow(/at least one icp|no icps/i);
    });

    it("propagates LLM errors", async () => {
      const llm = new FakeLlm([], new Error("bedrock 500"));
      await expect(
        generateCompetitorStrategyForUser(
          { companyName: "Acme" },
          [samplePersona(1)],
          { llm: llm as any },
        ),
      ).rejects.toThrow(/bedrock 500/);
    });

    it("uses the prod work-plan Step 3 system prompt verbatim", async () => {
      const llm = new FakeLlm([sampleCompetitorResp(1)]);
      await generateCompetitorStrategyForUser(
        { companyName: "Acme" },
        [samplePersona(1)],
        { llm: llm as any },
      );
      // Distinctive language from Step 3 of plan_1768351741814_jgc2wwlxa.
      expect(llm.calls[0].system).toContain("COMPETITIVE INTELLIGENCE");
      expect(llm.calls[0].system).toContain("OFFER STRATEGY");
      expect(COMPETITOR_STRATEGY_SYSTEM_PROMPT).toBe(llm.calls[0].system);
    });

    it("caps at 5 ICPs even when more are supplied", async () => {
      const personas = Array.from({ length: 7 }, (_, i) => samplePersona(i + 1));
      const responses = Array.from({ length: 7 }, (_, i) =>
        sampleCompetitorResp(i + 1),
      );
      const llm = new FakeLlm(responses);

      const result = await generateCompetitorStrategyForUser(
        { companyName: "Acme" },
        personas,
        { llm: llm as any },
      );
      expect(result.per_icp).toHaveLength(5);
      // LLM should only be invoked for the first 5.
      expect(llm.calls).toHaveLength(5);
    });

    it("tolerates a malformed LLM response (missing arrays) by inserting empty arrays", async () => {
      const llm = new FakeLlm([{ unrelated: "x" }]);
      const result = await generateCompetitorStrategyForUser(
        { companyName: "Acme" },
        [samplePersona(1)],
        { llm: llm as any },
      );
      expect(result.per_icp).toHaveLength(1);
      expect(result.per_icp[0].competitor_names).toEqual([]);
      expect(result.per_icp[0].offer_angles).toEqual([]);
      expect(result.per_icp[0].meta_targeting_brief).toBe("");
    });

    it("tolerates wrong-typed LLM response fields (string instead of array)", async () => {
      const llm = new FakeLlm([
        {
          competitor_names: "should-be-array",
          offer_angles: 42,
          meta_targeting_brief: { also: "wrong" },
        },
      ]);
      const result = await generateCompetitorStrategyForUser(
        { companyName: "Acme" },
        [samplePersona(1)],
        { llm: llm as any },
      );
      expect(result.per_icp[0].competitor_names).toEqual([]);
      expect(result.per_icp[0].offer_angles).toEqual([]);
      expect(result.per_icp[0].meta_targeting_brief).toBe("");
    });

    it("tolerates null LLM response (no raw object at all)", async () => {
      const llm = new FakeLlm([null]);
      const result = await generateCompetitorStrategyForUser(
        { companyName: "Acme" },
        [samplePersona(1)],
        { llm: llm as any },
      );
      expect(result.per_icp).toHaveLength(1);
      expect(result.per_icp[0].competitor_names).toEqual([]);
      expect(result.per_icp[0].offer_angles).toEqual([]);
      expect(result.per_icp[0].meta_targeting_brief).toBe("");
    });

    it("formats search snippets with empty results placeholder", async () => {
      const personas = [samplePersona(1)];
      const llm = new FakeLlm([sampleCompetitorResp(1)]);
      const search = jest.fn().mockResolvedValue([]); // empty array, not error
      await generateCompetitorStrategyForUser(
        { companyName: "Acme" },
        personas,
        { llm: llm as any, webSearchFn: search },
      );
      expect(llm.calls[0].user).toContain("(no competitor search results)");
    });

    it("formats search snippets with missing title/url/snippet fields", async () => {
      const personas = [samplePersona(1)];
      const llm = new FakeLlm([sampleCompetitorResp(1)]);
      const search = jest.fn().mockResolvedValue([
        { url: "https://x.com" }, // no title, no snippet
        { title: "T2" }, // no url, no snippet
        {}, // all missing
      ]);
      await generateCompetitorStrategyForUser(
        { companyName: "Acme" },
        personas,
        { llm: llm as any, webSearchFn: search },
      );
      expect(llm.calls[0].user).toContain("(untitled)");
      expect(llm.calls[0].user).toContain("https://x.com");
    });

    it("uses '(not provided)' placeholder when brand.companyName is missing in per-ICP prompt", async () => {
      const personas = [samplePersona(1)];
      const llm = new FakeLlm([sampleCompetitorResp(1)]);
      await generateCompetitorStrategyForUser(
        { companyUrl: "x.io" }, // no companyName
        personas,
        { llm: llm as any },
      );
      expect(llm.calls[0].user).toContain("Company: (not provided)");
    });

    it("uses fallback search query when brand.companyName is missing", async () => {
      const personas = [samplePersona(1)];
      const llm = new FakeLlm([sampleCompetitorResp(1)]);
      const search = jest.fn().mockResolvedValue([
        { title: "T", url: "https://x.com", snippet: "s" },
      ]);
      await generateCompetitorStrategyForUser(
        {}, // no companyName
        personas,
        { llm: llm as any, webSearchFn: search },
      );
      expect(search).toHaveBeenCalledWith(
        expect.stringMatching(/^competitors targeting /),
      );
    });

    it("rejects when personas is not an array (defensive type check)", async () => {
      const llm = new FakeLlm([]);
      await expect(
        generateCompetitorStrategyForUser(
          { companyName: "Acme" },
          undefined as unknown as ICPPersona[],
          { llm: llm as any },
        ),
      ).rejects.toThrow(/at least one icp/i);
    });

    it("includes brand value proposition + URL in the per-ICP prompt when present", async () => {
      const llm = new FakeLlm([sampleCompetitorResp(1)]);
      await generateCompetitorStrategyForUser(
        {
          companyName: "Linear",
          companyUrl: "linear.app",
          valueProposition: "Fast issue tracking",
        },
        [samplePersona(1)],
        { llm: llm as any },
      );
      expect(llm.calls[0].user).toContain("linear.app");
      expect(llm.calls[0].user).toContain("Fast issue tracking");
    });
  });

  describe("triggerCompetitorStrategyForUser (fire-and-forget orchestrator)", () => {
    beforeEach(() => {
      jest.clearAllMocks();
    });

    it("returns silently when user is missing", async () => {
      userDb.getUserById.mockResolvedValue(null);
      await triggerCompetitorStrategyForUser("missing-user");
      expect(userDb.updateUser).not.toHaveBeenCalled();
    });

    it("patches with competitorReadyPatch when LLM succeeds", async () => {
      const personas = [samplePersona(1), samplePersona(2)];
      userDb.getUserById
        .mockResolvedValueOnce({
          userId: "user-1",
          icpResult: personas,
          brandGuidelines: { brandData: { brandName: "Acme" } },
        })
        .mockResolvedValueOnce({
          userId: "user-1",
          competitorStatus: "running",
          competitorStartedAt: "2026-04-24T11:59:00.000Z",
        });
      userDb.updateUser.mockResolvedValue({});
      const llm = new FakeLlm([
        sampleCompetitorResp(1),
        sampleCompetitorResp(2),
      ]);
      await triggerCompetitorStrategyForUser("user-1", { llm: llm as any });

      expect(userDb.updateUser).toHaveBeenCalledTimes(1);
      const patch = userDb.updateUser.mock.calls[0][1];
      expect(patch.competitorStatus).toBe("ready");
      expect(patch.competitorResult.per_icp).toHaveLength(2);
    });

    it("patches with competitorFailedPatch when icpResult is empty (Step 2 incomplete)", async () => {
      userDb.getUserById
        .mockResolvedValueOnce({ userId: "user-1", icpResult: [] })
        .mockResolvedValueOnce({
          userId: "user-1",
          competitorStatus: "running",
        });
      userDb.updateUser.mockResolvedValue({});
      const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
      await triggerCompetitorStrategyForUser("user-1");
      errSpy.mockRestore();

      expect(userDb.updateUser).toHaveBeenCalledTimes(1);
      expect(userDb.updateUser.mock.calls[0][1].competitorStatus).toBe("failed");
      expect(userDb.updateUser.mock.calls[0][1].competitorError).toMatch(/Step 2|no ICPs/i);
    });

    it("patches with failed when LLM throws", async () => {
      const personas = [samplePersona(1)];
      userDb.getUserById
        .mockResolvedValueOnce({ userId: "user-1", icpResult: personas })
        .mockResolvedValueOnce({
          userId: "user-1",
          competitorStatus: "running",
        });
      userDb.updateUser.mockResolvedValue({});
      const llm = new FakeLlm([], new Error("bedrock 503"));
      const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
      await triggerCompetitorStrategyForUser("user-1", { llm: llm as any });
      errSpy.mockRestore();

      expect(userDb.updateUser).toHaveBeenCalledTimes(1);
      const patch = userDb.updateUser.mock.calls[0][1];
      expect(patch.competitorStatus).toBe("failed");
      expect(patch.competitorError).toContain("bedrock 503");
    });

    it("drops the ready patch silently when user is no longer running", async () => {
      const personas = [samplePersona(1)];
      userDb.getUserById
        .mockResolvedValueOnce({ userId: "user-1", icpResult: personas })
        .mockResolvedValueOnce({ userId: "user-1", competitorStatus: "idle" });
      const llm = new FakeLlm([sampleCompetitorResp(1)]);
      await triggerCompetitorStrategyForUser("user-1", { llm: llm as any });
      expect(userDb.updateUser).not.toHaveBeenCalled();
    });

    it("treats non-array icpResult as empty (Step 2 incomplete branch)", async () => {
      userDb.getUserById
        .mockResolvedValueOnce({ userId: "user-1", icpResult: "not-an-array" })
        .mockResolvedValueOnce({
          userId: "user-1",
          competitorStatus: "running",
        });
      userDb.updateUser.mockResolvedValue({});
      const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
      await triggerCompetitorStrategyForUser("user-1");
      errSpy.mockRestore();

      expect(userDb.updateUser).toHaveBeenCalledTimes(1);
      expect(userDb.updateUser.mock.calls[0][1].competitorStatus).toBe("failed");
    });

    it("stringifies non-Error thrown values in the failed patch", async () => {
      const personas = [samplePersona(1)];
      userDb.getUserById
        .mockResolvedValueOnce({ userId: "user-1", icpResult: personas })
        .mockResolvedValueOnce({
          userId: "user-1",
          competitorStatus: "running",
        });
      userDb.updateUser.mockResolvedValue({});
      // Custom LLM that throws a non-Error (string) — exercises String(err) path.
      const weirdLlm = {
        generateJsonRobust: async () => {
          throw "literal-string-error";
        },
      };
      const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
      await triggerCompetitorStrategyForUser("user-1", { llm: weirdLlm as any });
      errSpy.mockRestore();

      expect(userDb.updateUser).toHaveBeenCalledTimes(1);
      expect(userDb.updateUser.mock.calls[0][1].competitorError).toContain(
        "literal-string-error",
      );
    });

    it("uses {} fallback when getUserById returns null on the second read (race)", async () => {
      const personas = [samplePersona(1)];
      userDb.getUserById
        .mockResolvedValueOnce({ userId: "user-1", icpResult: personas })
        .mockResolvedValueOnce(null); // disappeared between LLM and patch read
      userDb.updateUser.mockResolvedValue({});
      const llm = new FakeLlm([sampleCompetitorResp(1)]);
      await triggerCompetitorStrategyForUser("user-1", { llm: llm as any });
      // ready patch returns null on empty user (not running) → drop silently
      expect(userDb.updateUser).not.toHaveBeenCalled();
    });

    it("uses {} fallback in failure path when current user disappears", async () => {
      const personas = [samplePersona(1)];
      userDb.getUserById
        .mockResolvedValueOnce({ userId: "user-1", icpResult: personas })
        .mockResolvedValueOnce(null); // user gone before failed-patch write
      userDb.updateUser.mockResolvedValue({});
      const llm = new FakeLlm([], new Error("boom"));
      const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
      await triggerCompetitorStrategyForUser("user-1", { llm: llm as any });
      errSpy.mockRestore();

      expect(userDb.updateUser).toHaveBeenCalledTimes(1);
      expect(userDb.updateUser.mock.calls[0][1].competitorStatus).toBe("failed");
    });
  });

  describe("startCompetitorStrategyForUser", () => {
    beforeEach(() => {
      jest.clearAllMocks();
    });

    it("writes the start patch and launches background work", async () => {
      userDb.updateUser.mockResolvedValue({});
      userDb.getUserById.mockResolvedValue(null); // background returns silently

      await startCompetitorStrategyForUser("user-1");

      expect(userDb.updateUser).toHaveBeenCalledTimes(1);
      const startPatch = userDb.updateUser.mock.calls[0][1];
      expect(startPatch.competitorStatus).toBe("running");
      expect(startPatch.competitorStartedAt).toBeTruthy();
    });
  });
});
