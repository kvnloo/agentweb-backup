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
  claimCompetitorRun,
  generateCompetitorStrategyForUser,
  COMPETITOR_STRATEGY_SYSTEM_PROMPT,
  mapCompetitorResultToMarketStrategy,
  startCompetitorStrategyForUser,
  triggerCompetitorStrategyForUser,
} from "../services/onboardingCompetitorService";
import type { ICPPersona } from "../services/icpStatusService";
import { COMPETITOR_TIMEOUT_MS } from "../services/competitorStatusService";
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
          icpStatus: "ready",
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

    // ENG-2308 review follow-up, confirmed by direct reproduction (same
    // reasoning as onboardingIcpService's icpOwnershipCondition tests): the
    // stale-claim escape hatch lets a reclaim supersede a merely-slow run;
    // competitorReadyPatch's own guard only checks status, not WHICH run's
    // "running" it is, so the completion WRITE itself must be conditioned
    // on this run's own competitorStartedAt.
    it("conditions the completion write on this run's own competitorStartedAt when expectedStartedAt is provided", async () => {
      const personas = [samplePersona(1), samplePersona(2)];
      userDb.getUserById
        .mockResolvedValueOnce({
          userId: "user-1",
          icpStatus: "ready",
          icpResult: personas,
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
      await triggerCompetitorStrategyForUser("user-1", {
        llm: llm as any,
        expectedStartedAt: "2026-04-24T11:59:00.000Z",
      } as any);

      const options = userDb.updateUser.mock.calls[0][2];
      expect(options?.condition?.expression).toBe(
        "#competitorStartedAt = :competitorOwnerStartedAt",
      );
      expect(options?.condition?.values?.[":competitorOwnerStartedAt"]).toBe(
        "2026-04-24T11:59:00.000Z",
      );
    });

    it("drops the completion silently when a reclaim has superseded this run (ConditionalCheckFailedException)", async () => {
      const personas = [samplePersona(1)];
      userDb.getUserById
        .mockResolvedValueOnce({
          userId: "user-1",
          icpStatus: "ready",
          icpResult: personas,
        })
        .mockResolvedValueOnce({
          userId: "user-1",
          competitorStatus: "running",
          competitorStartedAt: "2026-04-24T12:05:00.000Z",
        });
      const conditionalFailure = Object.assign(
        new Error("The conditional request failed"),
        { code: "ConditionalCheckFailedException" },
      );
      userDb.updateUser.mockRejectedValueOnce(conditionalFailure);
      const llm = new FakeLlm([sampleCompetitorResp(1)]);

      await expect(
        triggerCompetitorStrategyForUser("user-1", {
          llm: llm as any,
          expectedStartedAt: "2026-04-24T11:59:00.000Z",
        } as any),
      ).resolves.toBeUndefined();

      expect(userDb.updateUser).toHaveBeenCalledTimes(1);
    });

    it("no-ops (does NOT mark failed) when icpStatus is 'running' — gated by icp step", async () => {
      const personas = [samplePersona(1)];
      userDb.getUserById.mockResolvedValueOnce({
        userId: "user-1",
        icpStatus: "running",
        icpResult: personas, // even if personas leak through, gating must hold
      });
      userDb.updateUser.mockResolvedValue({});
      const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
      await triggerCompetitorStrategyForUser("user-1");
      logSpy.mockRestore();

      // Critical: do NOT mark failed — the polling tick will retry once ICP flips to ready.
      expect(userDb.updateUser).not.toHaveBeenCalled();
    });

    it("no-ops when icpStatus is 'building' — gated by icp step (covers brand-build flow)", async () => {
      userDb.getUserById.mockResolvedValueOnce({
        userId: "user-1",
        icpStatus: "building",
        icpResult: [],
      });
      userDb.updateUser.mockResolvedValue({});
      const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
      await triggerCompetitorStrategyForUser("user-1");
      logSpy.mockRestore();

      expect(userDb.updateUser).not.toHaveBeenCalled();
    });

    it("no-ops when icpStatus is 'failed' — gated by icp step", async () => {
      userDb.getUserById.mockResolvedValueOnce({
        userId: "user-1",
        icpStatus: "failed",
        icpResult: [],
      });
      userDb.updateUser.mockResolvedValue({});
      const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
      await triggerCompetitorStrategyForUser("user-1");
      logSpy.mockRestore();

      expect(userDb.updateUser).not.toHaveBeenCalled();
    });

    it("runs when the indexed read lags but a consistent read shows icp ready", async () => {
      const personas = [samplePersona(1)];
      userDb.getUserById
        .mockResolvedValueOnce({ userId: "user-1", icpStatus: "running" })
        .mockResolvedValueOnce({
          userId: "user-1",
          competitorStatus: "running",
          competitorStartedAt: "2026-04-24T11:59:00.000Z",
        });
      userDb.getUserByIdConsistent = jest.fn().mockResolvedValueOnce({
        userId: "user-1",
        icpStatus: "ready",
        icpResult: personas,
        brandGuidelines: { brandData: { brandName: "Acme" } },
      });
      userDb.updateUser.mockResolvedValue({});
      const llm = new FakeLlm([sampleCompetitorResp(1)]);
      try {
        await triggerCompetitorStrategyForUser("user-1", { llm: llm as any });
      } finally {
        delete userDb.getUserByIdConsistent;
      }
      expect(llm.calls.length).toBeGreaterThan(0);
      expect(userDb.updateUser.mock.calls[0][1].competitorStatus).toBe("ready");
    });

    it("releases its own claim (idle, conditioned on its startedAt) when gated by icp, so a retry is not blocked until timeout", async () => {
      userDb.getUserById.mockResolvedValueOnce({ userId: "user-1", icpStatus: "running" });
      userDb.updateUser.mockResolvedValue({});
      const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
      await triggerCompetitorStrategyForUser("user-1", {
        expectedStartedAt: "2026-04-24T11:59:00.000Z",
      } as any);
      logSpy.mockRestore();

      expect(userDb.updateUser).toHaveBeenCalledTimes(1);
      const [, patch, opts] = userDb.updateUser.mock.calls[0];
      expect(patch).toEqual({ competitorStatus: "idle" });
      expect(opts.condition).toBeDefined();
      expect(JSON.stringify(opts)).toContain("2026-04-24T11:59:00.000Z");
    });

    it("does not throw when releasing the gated claim loses to a newer run", async () => {
      userDb.getUserById.mockResolvedValueOnce({ userId: "user-1", icpStatus: "running" });
      userDb.updateUser.mockRejectedValueOnce(
        Object.assign(new Error("cond"), { code: "ConditionalCheckFailedException" }),
      );
      const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
      await expect(
        triggerCompetitorStrategyForUser("user-1", {
          expectedStartedAt: "2026-04-24T11:59:00.000Z",
        } as any),
      ).resolves.toBeUndefined();
      logSpy.mockRestore();
    });

    it("no-ops when icpStatus is 'idle' or missing — gated by icp step", async () => {
      userDb.getUserById.mockResolvedValueOnce({
        userId: "user-1",
        // no icpStatus, no icpResult
      });
      userDb.updateUser.mockResolvedValue({});
      const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
      await triggerCompetitorStrategyForUser("user-1");
      logSpy.mockRestore();

      expect(userDb.updateUser).not.toHaveBeenCalled();
    });

    it("no-ops when icpStatus='ready' but icpResult is empty (defensive)", async () => {
      userDb.getUserById.mockResolvedValueOnce({
        userId: "user-1",
        icpStatus: "ready",
        icpResult: [],
      });
      userDb.updateUser.mockResolvedValue({});
      const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
      await triggerCompetitorStrategyForUser("user-1");
      logSpy.mockRestore();

      expect(userDb.updateUser).not.toHaveBeenCalled();
    });

    it("no-ops when icpStatus='ready' but icpResult is not an array (defensive)", async () => {
      userDb.getUserById.mockResolvedValueOnce({
        userId: "user-1",
        icpStatus: "ready",
        icpResult: "not-an-array",
      });
      userDb.updateUser.mockResolvedValue({});
      const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
      await triggerCompetitorStrategyForUser("user-1");
      logSpy.mockRestore();

      expect(userDb.updateUser).not.toHaveBeenCalled();
    });

    it("logs a 'gated by icp step' message when bailing", async () => {
      userDb.getUserById.mockResolvedValueOnce({
        userId: "user-1",
        icpStatus: "running",
        icpResult: [],
      });
      const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
      await triggerCompetitorStrategyForUser("user-1");
      const messages = logSpy.mock.calls.map((c) => c.join(" "));
      logSpy.mockRestore();

      expect(
        messages.some((m) => m.includes("gated by icp step")),
      ).toBe(true);
    });

    it("patches with failed when LLM throws (icp ready, real generation error)", async () => {
      const personas = [samplePersona(1)];
      userDb.getUserById
        .mockResolvedValueOnce({
          userId: "user-1",
          icpStatus: "ready",
          icpResult: personas,
        })
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
        .mockResolvedValueOnce({
          userId: "user-1",
          icpStatus: "ready",
          icpResult: personas,
        })
        .mockResolvedValueOnce({ userId: "user-1", competitorStatus: "idle" });
      const llm = new FakeLlm([sampleCompetitorResp(1)]);
      await triggerCompetitorStrategyForUser("user-1", { llm: llm as any });
      expect(userDb.updateUser).not.toHaveBeenCalled();
    });

    it("stringifies non-Error thrown values in the failed patch", async () => {
      const personas = [samplePersona(1)];
      userDb.getUserById
        .mockResolvedValueOnce({
          userId: "user-1",
          icpStatus: "ready",
          icpResult: personas,
        })
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
        .mockResolvedValueOnce({
          userId: "user-1",
          icpStatus: "ready",
          icpResult: personas,
        })
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
        .mockResolvedValueOnce({
          userId: "user-1",
          icpStatus: "ready",
          icpResult: personas,
        })
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

  // ENG-2308 follow-up, caught live: the orchestrator's runCompetitor used
  // to call triggerCompetitorStrategyForUser directly with nothing ever
  // flipping competitorStatus to running first — the trigger silently
  // dropped its result. claimCompetitorRun is the extracted, reusable
  // claim both startCompetitorStrategyForUser and runCompetitor go through.
  describe("claimCompetitorRun", () => {
    beforeEach(() => {
      jest.clearAllMocks();
    });

    it("claims the axis and returns the persisted patch", async () => {
      userDb.updateUser.mockResolvedValue({});
      const patch = await claimCompetitorRun("user-1");
      expect(patch).not.toBeNull();
      expect(patch?.competitorStatus).toBe("running");
    });

    it("returns null without throwing when it loses the claim", async () => {
      const conditionalFailure = Object.assign(
        new Error("The conditional request failed"),
        { code: "ConditionalCheckFailedException" },
      );
      userDb.updateUser.mockRejectedValueOnce(conditionalFailure);
      const patch = await claimCompetitorRun("user-1");
      expect(patch).toBeNull();
    });
  });

  describe("startCompetitorStrategyForUser", () => {
    beforeEach(() => {
      jest.clearAllMocks();
    });

    it("writes the start patch and launches background work", async () => {
      userDb.updateUser.mockResolvedValue({});
      userDb.getUserById.mockResolvedValue(null); // background returns silently

      const result = await startCompetitorStrategyForUser("user-1");

      expect(userDb.updateUser).toHaveBeenCalledTimes(1);
      const startPatch = userDb.updateUser.mock.calls[0][1];
      expect(startPatch.competitorStatus).toBe("running");
      expect(startPatch.competitorStartedAt).toBeTruthy();
      // The claim also clears the previous attempt's error (REMOVE, via null);
      // the returned patch is the same run without that storage-only marker.
      expect(startPatch.competitorError).toBeNull();
      expect(result).toEqual({ ...startPatch, competitorError: undefined });
    });

    // ENG-2308: this function has two callers that can race each other — the
    // `/competitor/start` route AND the icp-ready cascade kickoff in
    // onboardingIcpService.ts. Without an atomic claim, a manual retry
    // landing while the cascade is already mid-flight launches a second,
    // fully parallel per-ICP LLM loop (confirmed live during ENG-2276
    // production testing).
    it("claims the running transition with a ConditionExpression guarding against a concurrent in-flight run", async () => {
      userDb.updateUser.mockResolvedValue({});
      userDb.getUserById.mockResolvedValue(null);

      const before = Date.now();
      await startCompetitorStrategyForUser("user-1");

      const options = userDb.updateUser.mock.calls[0][2];
      expect(options?.condition?.expression).toBe(
        "attribute_not_exists(#competitorStatus) OR #competitorStatus <> :competitorRunning OR #competitorStartedAt <= :competitorStaleBefore",
      );
      expect(options?.condition?.names).toEqual({
        "#competitorStatus": "competitorStatus",
        "#competitorStartedAt": "competitorStartedAt",
      });
      expect(options?.condition?.values?.[":competitorRunning"]).toBe("running");
      // ENG-2308 fix-of-a-fix: stale-claim escape hatch (see icpStartClaimCondition).
      const staleBefore = Date.parse(
        options?.condition?.values?.[":competitorStaleBefore"],
      );
      expect(staleBefore).toBeGreaterThanOrEqual(before - COMPETITOR_TIMEOUT_MS - 1000);
      expect(staleBefore).toBeLessThanOrEqual(Date.now() - COMPETITOR_TIMEOUT_MS + 1000);
    });

    it("returns null and launches no background work when it loses the race to a concurrent caller", async () => {
      userDb.getUserById.mockResolvedValue({ userId: "user-1" });
      const conditionalFailure = Object.assign(
        new Error("The conditional request failed"),
        { code: "ConditionalCheckFailedException" },
      );
      userDb.updateUser.mockRejectedValue(conditionalFailure);

      const result = await startCompetitorStrategyForUser("user-1");

      expect(result).toBeNull();
      expect(userDb.updateUser).toHaveBeenCalledTimes(1);
      // getUserById IS called once (to check eager status before claiming
      // — ENG-2308 fix-of-a-fix).
      expect(userDb.getUserById).toHaveBeenCalledTimes(1);
    });

    // ENG-2308 fix-of-a-fix, caught live: runCompetitor claims this SAME
    // axis itself when the orchestrator fires the step, inside the SAME
    // reconcile pass this function delegates to. Must check eager status
    // and skip claiming entirely in that case.
    it("does not claim the axis itself on the eager pipeline — leaves the claim to runCompetitor", async () => {
      userDb.getUserById.mockResolvedValue({ userId: "user-1", useEagerPipeline: true });
      const orchestratorWiring = require("../services/onboardingOrchestratorWiring");
      const reconcileSpy = jest
        .spyOn(orchestratorWiring, "reconcileForUser")
        .mockImplementation(async () => {});
      try {
        const result = await startCompetitorStrategyForUser("user-1");

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

      await expect(startCompetitorStrategyForUser("user-1")).rejects.toThrow(
        "boom",
      );
    });
  });

  // Mirror v2 onboarding competitors → marketStrategy.competitors[].
  // Same backfill as the icp service. See onboardingIcpService.test.ts for
  // the matching ICP-side coverage.
  describe("mapCompetitorResultToMarketStrategy", () => {
    it("flattens per_icp competitors into deduped {name, description}[]", () => {
      const out = mapCompetitorResultToMarketStrategy({
        per_icp: [
          {
            icp_id: "icp-1",
            competitor_names: ["Apollo", "Clay"],
            offer_angles: ["AI prospecting", "Data enrichment"],
            meta_targeting_brief: "founders, SaaS",
          },
          {
            icp_id: "icp-2",
            competitor_names: ["Apollo", "Outreach"],
            offer_angles: ["Sequencing"],
            meta_targeting_brief: "agencies",
          },
        ],
      });
      // Apollo deduped (appears in both ICPs); descriptions collected
      // across both.
      expect(out).toHaveLength(3);
      const apollo = out.find((c) => c.name === "Apollo");
      expect(apollo).toBeDefined();
      expect(apollo!.description).toContain("AI prospecting");
      // Other competitors get their own descriptions from their own ICP.
      const clay = out.find((c) => c.name === "Clay");
      expect(clay!.description).toBe("AI prospecting; Data enrichment");
      const outreach = out.find((c) => c.name === "Outreach");
      expect(outreach!.description).toBe("Sequencing");
    });

    it("returns an empty array for empty / malformed input", () => {
      expect(mapCompetitorResultToMarketStrategy({ per_icp: [] })).toEqual([]);
      expect(
        mapCompetitorResultToMarketStrategy(null as any),
      ).toEqual([]);
      expect(
        mapCompetitorResultToMarketStrategy({ per_icp: null as any }),
      ).toEqual([]);
    });

    it("falls back to a generic description when no offer angles are present", () => {
      const out = mapCompetitorResultToMarketStrategy({
        per_icp: [
          {
            icp_id: "icp-1",
            competitor_names: ["Acme"],
            offer_angles: [],
            meta_targeting_brief: "",
          },
        ],
      });
      expect(out).toEqual([
        { name: "Acme", description: "Identified during onboarding" },
      ]);
    });

    it("caps at 10 competitors", () => {
      const names = Array.from({ length: 15 }, (_, i) => `Competitor ${i}`);
      const out = mapCompetitorResultToMarketStrategy({
        per_icp: [
          {
            icp_id: "icp-1",
            competitor_names: names,
            offer_angles: ["angle"],
            meta_targeting_brief: "",
          },
        ],
      });
      expect(out).toHaveLength(10);
    });
  });

  describe("triggerCompetitorStrategyForUser — marketStrategy mirror", () => {
    it("writes marketStrategy.competitors[] alongside the competitorReadyPatch", async () => {
      // The competitor service reads the user record before the LLM call
      // (gate check on icpStatus=ready) and then again before the
      // readyPatch + once more for the mirror. So we need 3 mocks for the
      // happy path.
      const personas = [samplePersona(1), samplePersona(2)];
      userDb.getUserById
        // 1: gate read — needs icpStatus ready and personas
        .mockResolvedValueOnce({
          userId: "user-1",
          icpStatus: "ready",
          icpResult: personas,
          icps: personas,
          competitorStatus: "running",
        })
        // 2: post-LLM read for competitorReadyPatch
        .mockResolvedValueOnce({
          userId: "user-1",
          competitorStatus: "running",
          competitorStartedAt: "2026-04-25T11:59:00.000Z",
        })
        // 3: mirror read — preserves existing icp[] + businessOverview
        .mockResolvedValueOnce({
          userId: "user-1",
          marketStrategy: {
            businessOverview: "existing overview",
            competitors: [],
            icp: [{ title: "preserved", description: "icp", valueProposition: "vp", buyerPersonas: [] }],
            createdAt: "2026-04-01T00:00:00.000Z",
            updatedAt: "2026-04-01T00:00:00.000Z",
            icpUpdatedAt: "2026-04-01T00:00:00.000Z",
          },
        });
      userDb.updateUser.mockResolvedValue({});

      const llm = new FakeLlm([
        sampleCompetitorResp(1),
        sampleCompetitorResp(2),
      ]);
      await triggerCompetitorStrategyForUser("user-1", { llm: llm as any });

      // First update = readyPatch, second update = mirror.
      expect(userDb.updateUser).toHaveBeenCalledTimes(2);

      const mirrorWrite = userDb.updateUser.mock.calls[1][1];
      expect(mirrorWrite.marketStrategy).toBeDefined();
      // Existing icp[] preserved.
      expect(mirrorWrite.marketStrategy.icp).toEqual([
        { title: "preserved", description: "icp", valueProposition: "vp", buyerPersonas: [] },
      ]);
      // Competitors populated from the freshly generated result.
      expect(Array.isArray(mirrorWrite.marketStrategy.competitors)).toBe(true);
      expect(mirrorWrite.marketStrategy.competitors.length).toBeGreaterThan(0);
      // createdAt preserved, updatedAt bumped.
      expect(mirrorWrite.marketStrategy.createdAt).toBe(
        "2026-04-01T00:00:00.000Z",
      );
      expect(mirrorWrite.marketStrategy.updatedAt).not.toBe(
        "2026-04-01T00:00:00.000Z",
      );
      // ENG-1955 follow-up: this write never touches `icp`, so
      // icpUpdatedAt must survive UNCHANGED even though updatedAt bumps —
      // userDb.updateUser fully replaces the marketStrategy map, so
      // dropping this field here would erase a real ICP edit's timestamp
      // and silently reintroduce the staleness bug on the very next
      // GET /icp/filters call, for every onboarded user (this competitor
      // mirror runs unconditionally right after ICP generation).
      expect(mirrorWrite.marketStrategy.icpUpdatedAt).toBe(
        "2026-04-01T00:00:00.000Z",
      );
    });

    it("preserves a MISSING icpUpdatedAt as missing, rather than inventing one (ENG-1955 follow-up)", async () => {
      const personas = [samplePersona(1), samplePersona(2)];
      userDb.getUserById
        .mockResolvedValueOnce({
          userId: "user-1",
          icpStatus: "ready",
          icpResult: personas,
          icps: personas,
          competitorStatus: "running",
        })
        .mockResolvedValueOnce({
          userId: "user-1",
          competitorStatus: "running",
          competitorStartedAt: "2026-04-25T11:59:00.000Z",
        })
        // No icpUpdatedAt on the existing record at all (pre-ENG-1955 data).
        .mockResolvedValueOnce({
          userId: "user-1",
          marketStrategy: {
            businessOverview: "existing overview",
            competitors: [],
            icp: [],
            createdAt: "2026-04-01T00:00:00.000Z",
            updatedAt: "2026-04-01T00:00:00.000Z",
          },
        });
      userDb.updateUser.mockResolvedValue({});

      const llm = new FakeLlm([
        sampleCompetitorResp(1),
        sampleCompetitorResp(2),
      ]);
      await triggerCompetitorStrategyForUser("user-1", { llm: llm as any });

      const mirrorWrite = userDb.updateUser.mock.calls[1][1];
      expect(mirrorWrite.marketStrategy.icpUpdatedAt).toBeUndefined();
    });
  });
});
