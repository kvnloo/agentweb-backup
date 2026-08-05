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
