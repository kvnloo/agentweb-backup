jest.mock('../services/brandGuidelinesPopulation', () => ({ populateEmptyBrandGuidelines: jest.fn().mockResolvedValue(undefined) }));
/**
 * Onboarding brand-build service tests.
 *
 * The service is a thin orchestrator around Emma's existing chat-session
 * entry points. We test the orchestration logic — failure paths, mirroring
 * marketStrategy → icpResult/competitorResult, status flips — by injecting
 * fakes for `createChatSession` and `generateSessionResponse`. We do NOT
 * exercise Emma's tool loop here (that's the job of agentModeService tests).
 */

jest.mock("../services/db", () => ({
  userDb: {
    getUserById: jest.fn(),
    updateUser: jest.fn(),
  },
}));

import {
  claimBrandBuildRun,
  triggerBrandBuildForUser,
  mapMarketIcpToResult,
  mapMarketCompetitorsToResult,
} from "../services/onboardingBrandBuildService";
const { userDb } = require("../services/db");

beforeEach(() => {
  userDb.getUserById.mockReset();
  userDb.updateUser.mockReset();
});

describe("onboardingBrandBuildService", () => {
  // ENG-2308 follow-up, caught live: the orchestrator's runBrandDna used to
  // call triggerBrandBuildForUser directly with nothing ever flipping
  // brandBuildStatus to building first — the real Emma session ran, really
  // called update_brand_guidelines, but that tool's own "flip to ready if
  // we were building" hook silently no-op'd, and triggerBrandBuildForUser's
  // own final check then misreported "Emma finished but did not call
  // update_brand_guidelines". claimBrandBuildRun is the extracted, reusable
  // claim both /brand-build/start and runBrandDna now go through.
  describe("claimBrandBuildRun", () => {
    it("claims the axis and returns the persisted patch", async () => {
      userDb.updateUser.mockResolvedValue({});
      const patch = await claimBrandBuildRun("user-1");
      expect(patch).not.toBeNull();
      expect(patch?.brandBuildStatus).toBe("building");
      const options = userDb.updateUser.mock.calls[0][2];
      expect(options?.condition?.expression).toContain("brandBuildStatus");
    });

    it("clears the previous attempt's error (null REMOVEs it; undefined is skipped by updateUser)", async () => {
      userDb.updateUser.mockResolvedValue({});
      await claimBrandBuildRun("user-1");
      expect(userDb.updateUser.mock.calls[0][1].brandBuildError).toBeNull();
    });

    it("returns null without throwing when it loses the claim", async () => {
      const conditionalFailure = Object.assign(
        new Error("The conditional request failed"),
        { code: "ConditionalCheckFailedException" },
      );
      userDb.updateUser.mockRejectedValueOnce(conditionalFailure);
      const patch = await claimBrandBuildRun("user-1");
      expect(patch).toBeNull();
    });

    it("re-throws a non-conditional DynamoDB error", async () => {
      userDb.updateUser.mockRejectedValue(
        Object.assign(new Error("boom"), {
          code: "ProvisionedThroughputExceededException",
        }),
      );
      await expect(claimBrandBuildRun("user-1")).rejects.toThrow("boom");
    });
  });

  describe("mapMarketIcpToResult", () => {
    it("maps marketStrategy.icp[] entries into the icpResult persona shape", () => {
      const input = [
        {
          title: "Solo Founders",
          description: "First-time founders shipping to small teams",
          valueProposition: "10x faster MVP iteration",
          buyerPersonas: ["Founder/CEO making all marketing calls"],
        },
        {
          title: "Growth-stage CMOs",
          description: "VPs at Series B startups",
          valueProposition: "Scale ads without hiring",
          buyerPersonas: ["VP Marketing", "Head of Growth"],
        },
      ];
      const out = mapMarketIcpToResult(input);
      expect(out).toHaveLength(2);
      expect(out[0].name).toBe("Solo Founders");
      expect(out[0].pain).toBe(
        "First-time founders shipping to small teams",
      );
      expect(out[0].desire).toBe("10x faster MVP iteration");
      expect(out[0].meta_targeting_brief).toBe(
        "Founder/CEO making all marketing calls",
      );
      expect(out[0].id).toMatch(/icp-/);
      expect(out[1].meta_targeting_brief).toBe("VP Marketing");
    });

    it("returns [] for non-array input (Emma may not have called update_market_strategy)", () => {
      expect(mapMarketIcpToResult(undefined)).toEqual([]);
      expect(mapMarketIcpToResult(null)).toEqual([]);
      expect(mapMarketIcpToResult({} as any)).toEqual([]);
    });

    it("caps at 5 personas even if Emma writes more", () => {
      const six = Array.from({ length: 6 }, (_, i) => ({
        title: `ICP ${i + 1}`,
        description: "x",
        valueProposition: "y",
        buyerPersonas: ["z"],
      }));
      expect(mapMarketIcpToResult(six)).toHaveLength(5);
    });
  });

  describe("mapMarketCompetitorsToResult", () => {
    it("maps marketStrategy.competitors[] entries into the competitor result shape", () => {
      const out = mapMarketCompetitorsToResult([
        { name: "Jasper AI", description: "AI content writing" },
        { name: "HubSpot", description: "All-in-one CRM" },
      ]);
      expect(out).toHaveLength(2);
      expect(out[0].name).toBe("Jasper AI");
      expect(out[0].description).toBe("AI content writing");
      expect(out[0].id).toMatch(/comp-/);
    });

    it("returns [] for non-array input", () => {
      expect(mapMarketCompetitorsToResult(undefined)).toEqual([]);
      expect(mapMarketCompetitorsToResult(null)).toEqual([]);
    });
  });

  describe("triggerBrandBuildForUser (orchestration)", () => {
    it("marks the build failed when the user has no companyUrl", async () => {
      userDb.getUserById.mockResolvedValueOnce({
        userId: "u1",
        brandBuildStatus: "building",
        brandBuildStartedAt: new Date().toISOString(),
      });
      const createChatSession = jest.fn();
      const generateSessionResponse = jest.fn();

      await triggerBrandBuildForUser("u1", {
        createChatSession,
        generateSessionResponse,
      });

      expect(createChatSession).not.toHaveBeenCalled();
      expect(generateSessionResponse).not.toHaveBeenCalled();
      const lastCall =
        userDb.updateUser.mock.calls[userDb.updateUser.mock.calls.length - 1];
      expect(lastCall[0]).toBe("u1");
      expect(lastCall[1].brandBuildStatus).toBe("failed");
      expect(lastCall[1].brandBuildError).toMatch(/companyUrl/i);
    });

    // ENG-2308 review follow-up, confirmed by direct reproduction (same
    // reasoning as onboardingIcpService's icpOwnershipCondition tests):
    // the round-3 stale-claim escape hatch lets a reclaim supersede a
    // merely-slow (not crashed) run. buildFailedPatch's own write is
    // unconditional by design ("allowed from any state so watchdogs can
    // flip stale runs") — the FAILURE WRITE SITE here must condition on
    // this run's own claim so a zombie failure can't stomp a reclaiming
    // run's state. (The `ready` transition is written by Emma's
    // update_brand_guidelines tool-call hook, out of scope for this fix.)
    it("conditions the failure write on this run's own brandBuildStartedAt when expectedStartedAt is provided", async () => {
      userDb.getUserById.mockResolvedValueOnce({
        userId: "u1",
        brandBuildStatus: "building",
        brandBuildStartedAt: "2026-04-24T11:59:00.000Z",
      });

      await triggerBrandBuildForUser("u1", {
        createChatSession: jest.fn(),
        generateSessionResponse: jest.fn(),
        expectedStartedAt: "2026-04-24T11:59:00.000Z",
      });

      const lastCall =
        userDb.updateUser.mock.calls[userDb.updateUser.mock.calls.length - 1];
      expect(lastCall[2]?.condition?.expression).toBe(
        "#brandBuildStartedAt = :brandBuildOwnerStartedAt",
      );
      expect(lastCall[2]?.condition?.values?.[":brandBuildOwnerStartedAt"]).toBe(
        "2026-04-24T11:59:00.000Z",
      );
    });

    it("drops the failure silently when a reclaim has superseded this run (ConditionalCheckFailedException)", async () => {
      userDb.getUserById.mockResolvedValueOnce({
        userId: "u1",
        brandBuildStatus: "building",
        // A reclaim's fresh startedAt — different from the stale
        // expectedStartedAt this (zombie) run was given below.
        brandBuildStartedAt: "2026-04-24T12:05:00.000Z",
      });
      const conditionalFailure = Object.assign(
        new Error("The conditional request failed"),
        { code: "ConditionalCheckFailedException" },
      );
      userDb.updateUser.mockRejectedValueOnce(conditionalFailure);

      await expect(
        triggerBrandBuildForUser("u1", {
          createChatSession: jest.fn(),
          generateSessionResponse: jest.fn(),
          expectedStartedAt: "2026-04-24T11:59:00.000Z",
        }),
      ).resolves.toBeUndefined();

      expect(userDb.updateUser).toHaveBeenCalledTimes(1);
    });

    // ENG-2308 review follow-up: the update_brand_guidelines hook identifies a
    // superseded ("zombie") brand-build session by the claim named in its
    // pageIdentifier, so the build MUST create its session with that marker.
    it("creates the Emma session with a pageIdentifier naming this run's claim", async () => {
      const CLAIM = "2026-04-24T11:59:00.000Z";
      userDb.getUserById.mockResolvedValue({
        userId: "u1",
        productDomain: "https://acme.com",
        brandBuildStatus: "building",
        brandBuildStartedAt: CLAIM,
      });
      const createChatSession = jest.fn().mockResolvedValue({ sessionId: "s1" });

      await triggerBrandBuildForUser("u1", {
        createChatSession,
        generateSessionResponse: jest.fn().mockResolvedValue(undefined),
        ensureBrandLogo: async () => ({ persisted: true, logoUrl: null, reason: "test" }),
        expectedStartedAt: CLAIM,
      });

      expect(createChatSession).toHaveBeenCalledWith("u1", {
        pageIdentifier: `brand-build|claim:${CLAIM}`,
      });
    });

    it("keeps the default session identifier when the caller holds no claim", async () => {
      userDb.getUserById.mockResolvedValue({
        userId: "u1",
        productDomain: "https://acme.com",
        brandBuildStatus: "building",
        brandBuildStartedAt: new Date().toISOString(),
      });
      const createChatSession = jest.fn().mockResolvedValue({ sessionId: "s1" });

      await triggerBrandBuildForUser("u1", {
        createChatSession,
        generateSessionResponse: jest.fn().mockResolvedValue(undefined),
        ensureBrandLogo: async () => ({ persisted: true, logoUrl: null, reason: "test" }),
      });

      expect(createChatSession).toHaveBeenCalledWith("u1", undefined);
    });

    it("marks the build failed when chat-session creation throws", async () => {
      userDb.getUserById
        .mockResolvedValueOnce({
          userId: "u1",
          productDomain: "https://acme.com",
          brandBuildStatus: "building",
          brandBuildStartedAt: new Date().toISOString(),
        })
        .mockResolvedValueOnce({
          userId: "u1",
          productDomain: "https://acme.com",
          brandBuildStatus: "building",
          brandBuildStartedAt: new Date().toISOString(),
        });
      const createChatSession = jest
        .fn()
        .mockRejectedValueOnce(new Error("DynamoDB unavailable"));

      await triggerBrandBuildForUser("u1", {
        createChatSession,
        generateSessionResponse: jest.fn(),
      });

      const lastCall =
        userDb.updateUser.mock.calls[userDb.updateUser.mock.calls.length - 1];
      expect(lastCall[1].brandBuildStatus).toBe("failed");
      expect(lastCall[1].brandBuildError).toMatch(/DynamoDB unavailable/);
    });

    it("marks the build failed when Emma's session throws", async () => {
      userDb.getUserById
        .mockResolvedValueOnce({
          userId: "u1",
          productDomain: "https://acme.com",
          brandBuildStatus: "building",
          brandBuildStartedAt: new Date().toISOString(),
        })
        .mockResolvedValueOnce({
          userId: "u1",
          productDomain: "https://acme.com",
          brandBuildStatus: "building",
          brandBuildStartedAt: new Date().toISOString(),
        });
      const createChatSession = jest
        .fn()
        .mockResolvedValueOnce({ sessionId: "s1" });
      const generateSessionResponse = jest
        .fn()
        .mockRejectedValueOnce(new Error("Bedrock 503"));

      await triggerBrandBuildForUser("u1", {
        createChatSession,
        generateSessionResponse,
      });

      const lastCall =
        userDb.updateUser.mock.calls[userDb.updateUser.mock.calls.length - 1];
      expect(lastCall[1].brandBuildStatus).toBe("failed");
      expect(lastCall[1].brandBuildError).toMatch(/Bedrock 503/);
    });

    it("force-fails a HUNG session at its own timeout wall — never leaves it 'building' past budget (watchdog-safety invariant)", async () => {
      // This is the invariant that makes the status-read watchdog
      // (BRAND_BUILD_HARD_TIMEOUT_MS = 330s) safe: the orchestrator's own
      // withTimeout wall (BRAND_BUILD_TIMEOUT_MS = 300s) fires FIRST, so a
      // live build that "would have succeeded" can never still be 'building'
      // when the 330s watchdog runs. If Emma's session hangs forever, the
      // orchestrator flips the record to 'failed' at the wall — the watchdog
      // at 330s only ever catches genuinely-orphaned builds (process crash /
      // deploy recycle) where this code path never got to run.
      userDb.getUserById
        .mockResolvedValueOnce({
          userId: "u1",
          productDomain: "https://acme.com",
          brandBuildStatus: "building",
          brandBuildStartedAt: new Date().toISOString(),
        })
        .mockResolvedValueOnce({
          userId: "u1",
          productDomain: "https://acme.com",
          brandBuildStatus: "building",
          brandBuildStartedAt: new Date().toISOString(),
        });
      const createChatSession = jest
        .fn()
        .mockResolvedValueOnce({ sessionId: "s1" });
      // Session never settles — simulates Emma's tool loop hanging.
      const generateSessionResponse = jest
        .fn()
        .mockReturnValueOnce(new Promise<never>(() => {}));

      await triggerBrandBuildForUser("u1", {
        createChatSession,
        generateSessionResponse,
        timeoutMs: 20, // tiny wall so the test runs fast; real wall is 300s
      });

      const lastCall =
        userDb.updateUser.mock.calls[userDb.updateUser.mock.calls.length - 1];
      expect(lastCall[1].brandBuildStatus).toBe("failed");
      expect(lastCall[1].brandBuildStatus).not.toBe("building");
      expect(lastCall[1].brandBuildError).toMatch(/timed out/i);
    });

    it("marks the build failed when Emma finishes without calling update_brand_guidelines", async () => {
      // Emma's session ran fine, but she never wrote brandGuidelines —
      // brandBuildStatus stays at 'building'. The orchestrator should
      // detect this and surface a clear error.
      userDb.getUserById
        // entrance read
        .mockResolvedValueOnce({
          userId: "u1",
          productDomain: "https://acme.com",
          brandBuildStatus: "building",
          brandBuildStartedAt: new Date().toISOString(),
        })
        // post-Emma read (brandBuildStatus still 'building' — Emma didn't write brand)
        .mockResolvedValueOnce({
          userId: "u1",
          productDomain: "https://acme.com",
          brandBuildStatus: "building",
          brandBuildStartedAt: new Date().toISOString(),
          marketStrategy: undefined,
        })
        // final-status check
        .mockResolvedValueOnce({
          userId: "u1",
          productDomain: "https://acme.com",
          brandBuildStatus: "building",
          brandBuildStartedAt: new Date().toISOString(),
        });
      const createChatSession = jest
        .fn()
        .mockResolvedValueOnce({ sessionId: "s1" });
      const generateSessionResponse = jest.fn().mockResolvedValueOnce({});

      await triggerBrandBuildForUser("u1", {
        createChatSession,
        generateSessionResponse,
      });

      const lastCall =
        userDb.updateUser.mock.calls[userDb.updateUser.mock.calls.length - 1];
      expect(lastCall[1].brandBuildStatus).toBe("failed");
      expect(lastCall[1].brandBuildError).toMatch(
        /update_brand_guidelines/i,
      );
    });

    // The client-side timeout calls /brand-build/fail then /start, which
    // reclaims the axis while the first run's Emma session is still going. That
    // run's trigger then carries on after its (refused) session returns.
    describe("a run reclaimed while its session was still going", () => {
      const OURS = "2026-04-24T11:59:00.000Z";
      const NEWER = "2026-04-24T12:05:00.000Z";
      const market = {
        icp: [{ title: "Stale ICP", description: "d", valueProposition: "v", buyerPersonas: ["p"] }],
        competitors: [{ name: "Stale Co", description: "d" }],
      };
      const entrance = {
        userId: "u1",
        productDomain: "https://acme.com",
        brandBuildStatus: "building",
        brandBuildStartedAt: OURS,
      };
      // triggerBrandBuildForUser also fires an unrelated fire-and-forget Slack
      // Connect provisioning write at its start; only count writes that belong
      // to the brand build itself.
      const buildWrites = () =>
        userDb.updateUser.mock.calls.filter(
          ([, patch]: any) => !Object.keys(patch).every((k) => k.startsWith("slackConnect")),
        );
      const deps = () => ({
        createChatSession: jest.fn().mockResolvedValue({ sessionId: "s1" }),
        generateSessionResponse: jest.fn().mockResolvedValue({}),
        ensureBrandLogo: async () => ({ persisted: true, logoUrl: null, reason: "test" }),
        expectedStartedAt: OURS,
      });

      it("skips every post-session write once it sees a newer claim: no mirror, no failure, no logo step", async () => {
        const ensureBrandLogo = jest.fn();
        // The reads a real run would make if it did NOT stop at the check, so
        // that removing the check makes this test fail instead of passing
        // because the mocks ran dry.
        const newer = { ...entrance, brandBuildStartedAt: NEWER, brandBuildStatus: "ready", marketStrategy: market };
        userDb.getUserById
          .mockResolvedValueOnce(entrance)
          .mockResolvedValueOnce(newer)
          .mockResolvedValueOnce(newer)
          .mockResolvedValueOnce(newer);
        userDb.updateUser.mockResolvedValue({});

        await triggerBrandBuildForUser("u1", { ...deps(), ensureBrandLogo });

        expect(buildWrites()).toHaveLength(0);
        expect(ensureBrandLogo).not.toHaveBeenCalled();
      });

      it("conditions the mirror write on its own claim and drops it quietly when a reclaim lands first", async () => {
        const conditionalFailure = Object.assign(new Error("cond"), { code: "ConditionalCheckFailedException" });
        userDb.getUserById
          .mockResolvedValueOnce(entrance)
          .mockResolvedValueOnce({ ...entrance }) // still ours at the check
          .mockResolvedValueOnce({ ...entrance, marketStrategy: market }); // post-populate read
        // Reject only the mirror write (the first updateUser call is the
        // unrelated Slack Connect provisioning write).
        userDb.updateUser.mockImplementation(async (_id: string, patch: any) => {
          if (patch.icpResult) throw conditionalFailure;
          return {};
        });

        await triggerBrandBuildForUser("u1", deps());

        // Exactly one brand-build write was attempted (the mirror), and nothing
        // after it: no final-status failure write either.
        expect(buildWrites()).toHaveLength(1);
        const [, patch, options] = buildWrites()[0];
        expect(patch.icpResult).toBeTruthy();
        expect(options.condition.values[":brandBuildOwnerStartedAt"]).toBe(OURS);
      });

      it("a run that still owns the claim mirrors as before, with the condition", async () => {
        userDb.getUserById
          .mockResolvedValueOnce(entrance)
          .mockResolvedValueOnce({ ...entrance })
          .mockResolvedValueOnce({ ...entrance, brandBuildStatus: "ready", marketStrategy: market })
          .mockResolvedValueOnce({ ...entrance, brandBuildStatus: "ready" });
        userDb.updateUser.mockResolvedValue({});

        await triggerBrandBuildForUser("u1", deps());

        const mirror = userDb.updateUser.mock.calls.find(([, p]: any) => p.icpResult);
        expect(mirror).toBeTruthy();
        expect(mirror[2].condition.values[":brandBuildOwnerStartedAt"]).toBe(OURS);
      });
    });

    it("mirrors marketStrategy → icpResult + competitorResult and flips statuses on the happy path", async () => {
      const builtMarketStrategy = {
        businessOverview: "Acme makes rockets",
        icp: [
          {
            title: "Coyotes with grudges",
            description: "Solo predators with persistent prey",
            valueProposition: "Same-day delivery of rocket-skates",
            buyerPersonas: ["Wile E. Coyote"],
          },
        ],
        competitors: [
          { name: "Looney Inc", description: "Old-school cartoon ordnance" },
        ],
      };

      userDb.getUserById
        // entrance
        .mockResolvedValueOnce({
          userId: "u1",
          productDomain: "https://acme.com",
          brandBuildStatus: "building",
          brandBuildStartedAt: new Date().toISOString(),
        })
        // post-Emma read (brandBuildStatus already flipped to ready by the
        // agentModeService hook when update_brand_guidelines was called)
        .mockResolvedValueOnce({
          userId: "u1",
          productDomain: "https://acme.com",
          brandBuildStatus: "ready",
          brandGuidelines: { brandData: { brandName: "Acme" } },
          marketStrategy: builtMarketStrategy,
        })
        // final-status check
        .mockResolvedValueOnce({
          userId: "u1",
          brandBuildStatus: "ready",
        });
      const createChatSession = jest
        .fn()
        .mockResolvedValueOnce({ sessionId: "s1" });
      const generateSessionResponse = jest.fn().mockResolvedValueOnce({});

      await triggerBrandBuildForUser("u1", {
        createChatSession,
        generateSessionResponse,
      });

      // Emma was called with a tight prompt that mentions the URL.
      expect(generateSessionResponse).toHaveBeenCalledTimes(1);
      const promptArg = generateSessionResponse.mock.calls[0][1] as string;
      expect(promptArg).toContain("https://acme.com");
      expect(promptArg).toMatch(/do not ask the user/i);
      expect(promptArg).toMatch(/update_brand_guidelines/);
      expect(promptArg).toMatch(/update_market_strategy/);
      // ENG-792: the reported account's logo became a google favicon-proxy
      // URL that 404s, because Emma generalized the third-party-logo
      // convention (correct for landing pages) onto the user's OWN logo.
      // The prompt must forbid it and prefer omitting logoUrl, which
      // self-heals via ensureBrandLogoPersisted.
      expect(promptArg).toMatch(/s2\/favicons/);
      expect(promptArg).toMatch(/NEVER substitute a third-party favicon proxy/);
      expect(promptArg).toMatch(/OMIT logoUrl/);

      // Mirror write: icpResult + competitorResult + statuses
      const writes = userDb.updateUser.mock.calls.map((c: any[]) => c[1]);
      const mirror = writes.find((w: any) => w.icpResult);
      expect(require('../services/brandGuidelinesPopulation').populateEmptyBrandGuidelines).toHaveBeenCalledWith('u1');
      expect(mirror).toBeTruthy();
      expect(mirror.icpResult[0].name).toBe("Coyotes with grudges");
      expect(mirror.competitorResult.competitors[0].name).toBe("Looney Inc");
      expect(mirror.icpStatus).toBe("ready");
      expect(mirror.competitorStatus).toBe("ready");

      // brandBuildStatus is NOT written by us — the agentModeService hook
      // owns that field. Our writes should not touch it on the happy path.
      const touchedBrandStatus = writes.find(
        (w: any) => w.brandBuildStatus !== undefined,
      );
      expect(touchedBrandStatus).toBeUndefined();
    });
  });

  describe("deterministic brand-logo persistence (ENG-326 AC-1)", () => {
    const readyFlow = () => {
      userDb.getUserById
        // entrance
        .mockResolvedValueOnce({
          userId: "u1",
          productDomain: "https://acme.com",
          brandBuildStatus: "building",
          brandBuildStartedAt: new Date().toISOString(),
        })
        // post-Emma read
        .mockResolvedValueOnce({
          userId: "u1",
          productDomain: "https://acme.com",
          brandBuildStatus: "ready",
          brandGuidelines: { brandData: { brandName: "Acme" } },
        })
        // final-status check
        .mockResolvedValueOnce({ userId: "u1", brandBuildStatus: "ready" });
      return {
        createChatSession: jest.fn().mockResolvedValueOnce({ sessionId: "s1" }),
        generateSessionResponse: jest.fn().mockResolvedValueOnce({}),
      };
    };

    it("runs the deterministic logo step with the company URL after a successful build", async () => {
      const ensureBrandLogo = jest
        .fn()
        .mockResolvedValue({ persisted: true, logoUrl: "https://s3/logo.png", reason: "persisted" });

      await triggerBrandBuildForUser("u1", {
        ...readyFlow(),
        ensureBrandLogo,
      });

      expect(ensureBrandLogo).toHaveBeenCalledTimes(1);
      expect(ensureBrandLogo).toHaveBeenCalledWith("u1", "https://acme.com");
      // The build must not be flipped to failed by the logo step.
      const failedWrite = userDb.updateUser.mock.calls.find(
        (c: any[]) => c[1]?.brandBuildStatus === "failed",
      );
      expect(failedWrite).toBeUndefined();
    });

    it("does NOT run the logo step when the build failed (Emma never wrote the brand)", async () => {
      userDb.getUserById
        .mockResolvedValueOnce({
          userId: "u1",
          productDomain: "https://acme.com",
          brandBuildStatus: "building",
          brandBuildStartedAt: new Date().toISOString(),
        })
        .mockResolvedValueOnce({
          userId: "u1",
          productDomain: "https://acme.com",
          brandBuildStatus: "building",
          brandBuildStartedAt: new Date().toISOString(),
        })
        .mockResolvedValueOnce({
          userId: "u1",
          productDomain: "https://acme.com",
          brandBuildStatus: "building",
          brandBuildStartedAt: new Date().toISOString(),
        });
      const ensureBrandLogo = jest.fn();

      await triggerBrandBuildForUser("u1", {
        createChatSession: jest.fn().mockResolvedValueOnce({ sessionId: "s1" }),
        generateSessionResponse: jest.fn().mockResolvedValueOnce({}),
        ensureBrandLogo,
      });

      expect(ensureBrandLogo).not.toHaveBeenCalled();
    });

    it("a crashing logo step never fails a build that already succeeded", async () => {
      const ensureBrandLogo = jest
        .fn()
        .mockRejectedValue(new Error("Puppeteer exploded"));

      await triggerBrandBuildForUser("u1", {
        ...readyFlow(),
        ensureBrandLogo,
      });

      expect(ensureBrandLogo).toHaveBeenCalledTimes(1);
      const failedWrite = userDb.updateUser.mock.calls.find(
        (c: any[]) => c[1]?.brandBuildStatus === "failed",
      );
      expect(failedWrite).toBeUndefined();
    });
  });
});
