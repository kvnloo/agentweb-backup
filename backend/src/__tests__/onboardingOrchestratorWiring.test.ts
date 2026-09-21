/**
 * Eager DAG sub-task 2 — wiring tests for the production
 * `OnboardingPipelineOrchestrator` glue.
 *
 * Covered:
 *   - Each runner delegates to the matching legacy `triggerXForUser`
 *   - `reconcileForUser` short-circuits when the env flag is off AND the
 *     user is not on `useEagerPipeline` (legacy cascade keeps owning the
 *     work)
 *   - `reconcileForUser` runs the DAG when the user is on
 *     `useEagerPipeline` (env flag stays off)
 *   - `reconcileForUser` runs the DAG when the env flag is on (regardless
 *     of per-user opt-in)
 *   - Errors thrown during reconcile are swallowed and don't propagate
 *   - `isEagerPipelineActiveFor` covers env-flag, per-user opt-in, and
 *     null/undefined user
 */

// `jest.isolateModules` is used per-test so the orchestrator singleton
// inside the wiring module can be re-built with each test's freshly
// mocked dependencies.

const ORIGINAL_ENV = process.env.EAGER_ONBOARDING_PIPELINE_ENABLED;

afterEach(() => {
  process.env.EAGER_ONBOARDING_PIPELINE_ENABLED = ORIGINAL_ENV;
  jest.resetModules();
  jest.clearAllMocks();
});

describe("isEagerPipelineActiveFor", () => {
  it("returns false when neither env flag nor per-user opt-in is set", () => {
    delete process.env.EAGER_ONBOARDING_PIPELINE_ENABLED;
    const { isEagerPipelineActiveFor } = require("../services/onboardingOrchestratorWiring");
    expect(isEagerPipelineActiveFor({})).toBe(false);
    expect(isEagerPipelineActiveFor(null)).toBe(false);
    expect(isEagerPipelineActiveFor(undefined)).toBe(false);
    expect(isEagerPipelineActiveFor({ useEagerPipeline: false })).toBe(false);
  });

  it("returns true when the env flag is on, regardless of per-user opt-in", () => {
    process.env.EAGER_ONBOARDING_PIPELINE_ENABLED = "true";
    const { isEagerPipelineActiveFor } = require("../services/onboardingOrchestratorWiring");
    expect(isEagerPipelineActiveFor({})).toBe(true);
    expect(isEagerPipelineActiveFor({ useEagerPipeline: false })).toBe(true);
    expect(isEagerPipelineActiveFor(null)).toBe(true);
  });

  it("returns true when env flag is off but the user has opted in", () => {
    delete process.env.EAGER_ONBOARDING_PIPELINE_ENABLED;
    const { isEagerPipelineActiveFor } = require("../services/onboardingOrchestratorWiring");
    expect(isEagerPipelineActiveFor({ useEagerPipeline: true })).toBe(true);
  });
});

describe("reconcileForUser", () => {
  it("is a no-op when neither env flag nor per-user opt-in is set (legacy cascade keeps owning the work)", async () => {
    delete process.env.EAGER_ONBOARDING_PIPELINE_ENABLED;

    await jest.isolateModulesAsync(async () => {
      const triggerIcp = jest.fn();
      const triggerCompetitor = jest.fn();
      const triggerCreativeDir = jest.fn();
      const triggerAdImage = jest.fn();
      const triggerAdCopy = jest.fn();
      const triggerBrandBuild = jest.fn();

      jest.doMock("../services/db", () => ({
        userDb: {
          getUserById: jest.fn().mockResolvedValue({
            userId: "u1",
            // No useEagerPipeline field — legacy mode.
          }),
          updateUser: jest.fn().mockResolvedValue(undefined),
        },
      }));
      jest.doMock("../services/onboardingIcpService", () => ({
        triggerIcpDiscoveryForUser: triggerIcp,
      }));
      jest.doMock("../services/onboardingCompetitorService", () => ({
        triggerCompetitorStrategyForUser: triggerCompetitor,
      }));
      jest.doMock("../services/onboardingCreativeDirService", () => ({
        triggerCreativeDirForUser: triggerCreativeDir,
      }));
      const claimAdImageRunMock = jest.fn(async () => ({
        runId: "adimg_test-run",
        startedAt: "2026-08-04T00:00:00.000Z",
      }));
      jest.doMock("../services/onboardingAdImageService", () => ({
        // The eager runner claims the axis for ITS OWN invocation and hands
        // that identity to the worker — a worker that re-reads identity from
        // the shared record cannot tell two overlapping runs apart (ENG-792).
        claimAdImageRun: claimAdImageRunMock,
        triggerAdImageGenerationForUser: triggerAdImage,
      }));
      jest.doMock("../services/onboardingAdCopyService", () => ({
        triggerAdCopyForUser: triggerAdCopy,
      }));
      jest.doMock("../services/onboardingBrandBuildService", () => ({
        triggerBrandBuildForUser: triggerBrandBuild,
      }));

      const { reconcileForUser } = require("../services/onboardingOrchestratorWiring");
      const report = await reconcileForUser("u1");

      expect(report).toEqual(
        expect.objectContaining({
          userId: "u1",
          fired: [],
          gatedBy: "feature flag off",
        }),
      );
      // None of the legacy triggers should have been invoked.
      expect(triggerIcp).not.toHaveBeenCalled();
      expect(triggerCompetitor).not.toHaveBeenCalled();
      expect(triggerCreativeDir).not.toHaveBeenCalled();
      expect(triggerAdImage).not.toHaveBeenCalled();
      expect(triggerAdCopy).not.toHaveBeenCalled();
      expect(triggerBrandBuild).not.toHaveBeenCalled();
    });
  });

  it("walks the DAG and invokes each legacy trigger when the user has opted in (env flag off)", async () => {
    delete process.env.EAGER_ONBOARDING_PIPELINE_ENABLED;

    await jest.isolateModulesAsync(async () => {
      const persisted: Record<string, any> = {
        userId: "u2",
        useEagerPipeline: true,
        // Inputs for the brandDna step. Without these, brandDna's
        // gatherInputs hashes to {url:null,name:null,goal:null} which is
        // still consistent — the runner still fires the first time
        // because no prior `inputsHash` exists.
        companyUrl: "https://acme.test",
        companyName: "Acme",
        goal: "growth",
      };

      // Each fake trigger writes the result the orchestrator's runner
      // expects to find when it re-reads the user record.
      const triggerBrandBuild = jest.fn(async () => {
        persisted.brandGuidelines = { tone: "punchy" };
      });
      const triggerIcp = jest.fn(async () => {
        persisted.icpResult = [{ name: "P1" }];
      });
      const triggerCompetitor = jest.fn(async () => {
        persisted.competitorResult = { per_icp: [] };
      });
      const triggerCreativeDir = jest.fn(async () => {
        persisted.creativeDirResult = { concepts: [] };
      });
      const triggerAdImage = jest.fn(async () => {
        persisted.adImageResult = { variants: [] };
      });
      const triggerAdCopy = jest.fn(async () => {
        persisted.adCopyResult = { copies: [] };
      });

      jest.doMock("../services/db", () => ({
        userDb: {
          getUserById: jest.fn(async () => ({ ...persisted })),
          updateUser: jest.fn(async (_id: string, patch: any) => {
            if (patch && patch.steps) {
              persisted.steps = patch.steps;
            } else if (patch) {
              Object.assign(persisted, patch);
            }
          }),
        },
      }));
      jest.doMock("../services/onboardingIcpService", () => ({
        triggerIcpDiscoveryForUser: triggerIcp,
      }));
      jest.doMock("../services/onboardingCompetitorService", () => ({
        triggerCompetitorStrategyForUser: triggerCompetitor,
      }));
      jest.doMock("../services/onboardingCreativeDirService", () => ({
        triggerCreativeDirForUser: triggerCreativeDir,
      }));
      const claimAdImageRunMock = jest.fn(async () => ({
        runId: "adimg_test-run",
        startedAt: "2026-08-04T00:00:00.000Z",
      }));
      jest.doMock("../services/onboardingAdImageService", () => ({
        // The eager runner claims the axis for ITS OWN invocation and hands
        // that identity to the worker — a worker that re-reads identity from
        // the shared record cannot tell two overlapping runs apart (ENG-792).
        claimAdImageRun: claimAdImageRunMock,
        triggerAdImageGenerationForUser: triggerAdImage,
      }));
      jest.doMock("../services/onboardingAdCopyService", () => ({
        triggerAdCopyForUser: triggerAdCopy,
      }));
      jest.doMock("../services/onboardingBrandBuildService", () => ({
        triggerBrandBuildForUser: triggerBrandBuild,
      }));

      const {
        reconcileForUser,
        _resetOrchestratorForTests,
      } = require("../services/onboardingOrchestratorWiring");
      // Reset the singleton so it picks up the freshly-mocked userDb.
      _resetOrchestratorForTests();
      // Also reset the in-process rate limiter — earlier tests in the
      // suite may have left fires for other userIds in the map.
      const {
        _resetRateLimitState,
      } = require("../services/onboardingPipelineOrchestrator");
      _resetRateLimitState();
      const report = await reconcileForUser("u2");

      expect(report).not.toBeNull();
      expect(report.gatedBy).toBeNull();

      // Every legacy trigger fired exactly once.
      expect(triggerBrandBuild).toHaveBeenCalledWith("u2");
      expect(triggerIcp).toHaveBeenCalledWith("u2");
      expect(triggerCompetitor).toHaveBeenCalledWith("u2");
      expect(triggerCreativeDir).toHaveBeenCalledWith("u2");
      expect(triggerAdImage).toHaveBeenCalledWith("u2", {
        run: { runId: "adimg_test-run", startedAt: "2026-08-04T00:00:00.000Z" },
      });
      expect(triggerAdCopy).toHaveBeenCalledWith("u2");

      // Every step ended in `ready` and stamped its output back to
      // User.steps via updateUserSteps.
      const fired = (report.fired as Array<{ step: string; status: string }>)
        .map((f) => f.step);
      expect(fired).toEqual([
        "brandDna",
        "icp",
        "competitor",
        "creativeDir",
        "adImage",
        "adCopy",
      ]);
      expect(persisted.steps?.brandDna?.status).toBe("ready");
      expect(persisted.steps?.adCopy?.status).toBe("ready");
      // Output from each runner was persisted into User.steps[step].output.
      expect(persisted.steps?.icp?.output).toEqual([{ name: "P1" }]);
    });
  });

  it("records adImage as FAILED when the service failed the run (ENG-792)", async () => {
    // The ad-image service signals business failures by patching
    // adImageStatus, never by throwing. The orchestrator only marks a step
    // failed when its runner throws, so without the re-raise in runAdImage
    // this was recorded as "ready" with a null output.
    delete process.env.EAGER_ONBOARDING_PIPELINE_ENABLED;

    await jest.isolateModulesAsync(async () => {
      const persisted: Record<string, any> = {
        userId: "u-eng792",
        useEagerPipeline: true,
        companyUrl: "https://acme.test",
        companyName: "Acme",
        goal: "growth",
      };

      const triggerBrandBuild = jest.fn(async () => {
        persisted.brandGuidelines = { tone: "punchy" };
      });
      const triggerIcp = jest.fn(async () => {
        persisted.icpResult = [{ name: "P1" }];
      });
      const triggerCompetitor = jest.fn(async () => {
        persisted.competitorResult = { per_icp: [] };
      });
      const triggerCreativeDir = jest.fn(async () => {
        persisted.creativeDirResult = { concepts: [] };
      });
      // Mirrors the real service on a total-variant failure: adImageFailedPatch
      // writes status + error + completedAt, and no adImageResult.
      const triggerAdImage = jest.fn(async () => {
        persisted.adImageStatus = "failed";
        persisted.adImageError = "all 3 variants failed";
        persisted.adImageCompletedAt = new Date().toISOString();
      });
      const triggerAdCopy = jest.fn(async () => {
        persisted.adCopyResult = { copies: [] };
      });

      jest.doMock("../services/db", () => ({
        userDb: {
          getUserById: jest.fn(async () => ({ ...persisted })),
          updateUser: jest.fn(async (_id: string, patch: any) => {
            if (patch && patch.steps) {
              persisted.steps = patch.steps;
            } else if (patch) {
              Object.assign(persisted, patch);
            }
          }),
        },
      }));
      jest.doMock("../services/onboardingIcpService", () => ({
        triggerIcpDiscoveryForUser: triggerIcp,
      }));
      jest.doMock("../services/onboardingCompetitorService", () => ({
        triggerCompetitorStrategyForUser: triggerCompetitor,
      }));
      jest.doMock("../services/onboardingCreativeDirService", () => ({
        triggerCreativeDirForUser: triggerCreativeDir,
      }));
      const claimAdImageRunMock = jest.fn(async () => ({
        runId: "adimg_test-run",
        startedAt: "2026-08-04T00:00:00.000Z",
      }));
      jest.doMock("../services/onboardingAdImageService", () => ({
        // The eager runner claims the axis for ITS OWN invocation and hands
        // that identity to the worker — a worker that re-reads identity from
        // the shared record cannot tell two overlapping runs apart (ENG-792).
        claimAdImageRun: claimAdImageRunMock,
        triggerAdImageGenerationForUser: triggerAdImage,
      }));
      jest.doMock("../services/onboardingAdCopyService", () => ({
        triggerAdCopyForUser: triggerAdCopy,
      }));
      jest.doMock("../services/onboardingBrandBuildService", () => ({
        triggerBrandBuildForUser: triggerBrandBuild,
      }));

      const {
        reconcileForUser,
        _resetOrchestratorForTests,
      } = require("../services/onboardingOrchestratorWiring");
      _resetOrchestratorForTests();
      const {
        _resetRateLimitState,
      } = require("../services/onboardingPipelineOrchestrator");
      _resetRateLimitState();
      const report = await reconcileForUser("u-eng792");

      expect(triggerAdImage).toHaveBeenCalledWith("u-eng792", {
        run: { runId: "adimg_test-run", startedAt: "2026-08-04T00:00:00.000Z" },
      });
      expect(persisted.steps?.adImage?.status).toBe("failed");
      expect(persisted.steps?.adImage?.failedReason).toMatch(/all 3 variants failed/);
      const fired = (report.fired as Array<{ step: string; status: string }>);
      expect(fired.find((f) => f.step === "adImage")?.status).toBe("failed");
      // Ad copy is a SIBLING of ad images (both dep on creativeDir), not a
      // dependent — the Epic deliberately splits image and copy into
      // independent axes so one failing does not block the other. It must
      // still run and still succeed.
      expect(triggerAdCopy).toHaveBeenCalledWith("u-eng792");
      expect(fired.find((f) => f.step === "adCopy")?.status).toBe("ready");
    });
  });

  it("fails creativeDir and gates its real dependents (ENG-792 sibling runners)", async () => {
    // Unlike adImage (which has no dependents), creativeDir is a real
    // upstream of both adImage and adCopy — so re-raising its failure does
    // gate them, which is the DAG behaving as intended.
    delete process.env.EAGER_ONBOARDING_PIPELINE_ENABLED;

    await jest.isolateModulesAsync(async () => {
      const persisted: Record<string, any> = {
        userId: "u-cd",
        useEagerPipeline: true,
        companyUrl: "https://acme.test",
        companyName: "Acme",
        goal: "growth",
      };

      const triggerBrandBuild = jest.fn(async () => {
        persisted.brandGuidelines = { tone: "punchy" };
      });
      const triggerIcp = jest.fn(async () => {
        persisted.icpResult = [{ name: "P1" }];
      });
      const triggerCompetitor = jest.fn(async () => {
        persisted.competitorResult = { per_icp: [] };
      });
      const triggerCreativeDir = jest.fn(async () => {
        persisted.creativeDirStatus = "failed";
        persisted.creativeDirError = "creative direction model returned nothing";
        persisted.creativeDirCompletedAt = new Date().toISOString();
      });
      const triggerAdImage = jest.fn(async () => undefined);
      const triggerAdCopy = jest.fn(async () => undefined);

      jest.doMock("../services/db", () => ({
        userDb: {
          getUserById: jest.fn(async () => ({ ...persisted })),
          updateUser: jest.fn(async (_id: string, patch: any) => {
            if (patch && patch.steps) {
              persisted.steps = patch.steps;
            } else if (patch) {
              Object.assign(persisted, patch);
            }
          }),
        },
      }));
      jest.doMock("../services/onboardingIcpService", () => ({
        triggerIcpDiscoveryForUser: triggerIcp,
      }));
      jest.doMock("../services/onboardingCompetitorService", () => ({
        triggerCompetitorStrategyForUser: triggerCompetitor,
      }));
      jest.doMock("../services/onboardingCreativeDirService", () => ({
        triggerCreativeDirForUser: triggerCreativeDir,
      }));
      const claimAdImageRunMock = jest.fn(async () => ({
        runId: "adimg_test-run",
        startedAt: "2026-08-04T00:00:00.000Z",
      }));
      jest.doMock("../services/onboardingAdImageService", () => ({
        // The eager runner claims the axis for ITS OWN invocation and hands
        // that identity to the worker — a worker that re-reads identity from
        // the shared record cannot tell two overlapping runs apart (ENG-792).
        claimAdImageRun: claimAdImageRunMock,
        triggerAdImageGenerationForUser: triggerAdImage,
      }));
      jest.doMock("../services/onboardingAdCopyService", () => ({
        triggerAdCopyForUser: triggerAdCopy,
      }));
      jest.doMock("../services/onboardingBrandBuildService", () => ({
        triggerBrandBuildForUser: triggerBrandBuild,
      }));

      const {
        reconcileForUser,
        _resetOrchestratorForTests,
      } = require("../services/onboardingOrchestratorWiring");
      _resetOrchestratorForTests();
      const {
        _resetRateLimitState,
      } = require("../services/onboardingPipelineOrchestrator");
      _resetRateLimitState();
      const report = await reconcileForUser("u-cd");

      expect(persisted.steps?.creativeDir?.status).toBe("failed");
      expect(persisted.steps?.creativeDir?.failedReason).toMatch(
        /creative direction model returned nothing/,
      );
      // Both dependents are gated by the upstream-not-ready check.
      expect(triggerAdImage).not.toHaveBeenCalled();
      expect(triggerAdCopy).not.toHaveBeenCalled();
      const fired = (report.fired as Array<{ step: string }>).map((f) => f.step);
      expect(fired).not.toContain("adImage");
      expect(fired).not.toContain("adCopy");
    });
  });

  it("ignores a STALE failed status left by an earlier attempt (ENG-792)", async () => {
    // The DAG calls triggerXForUser directly, but the *StartPatch that flips
    // status to 'running' lives in the startXForUser route wrappers — so a
    // previous attempt's `failed` can still be on the record when a fresh run
    // begins. Attributing by completedAt keeps that from failing a run that
    // actually succeeded, which for icp would gate the entire rest of the DAG.
    delete process.env.EAGER_ONBOARDING_PIPELINE_ENABLED;

    await jest.isolateModulesAsync(async () => {
      const stale = new Date(Date.now() - 60_000).toISOString();
      const persisted: Record<string, any> = {
        userId: "u-stale",
        useEagerPipeline: true,
        companyUrl: "https://acme.test",
        companyName: "Acme",
        goal: "growth",
        // Left over from an earlier run, never cleared.
        icpStatus: "failed",
        icpError: "an old failure",
        icpCompletedAt: stale,
      };

      const triggerBrandBuild = jest.fn(async () => {
        persisted.brandGuidelines = { tone: "punchy" };
      });
      // Succeeds this time, but does not reset the stale status fields.
      const triggerIcp = jest.fn(async () => {
        persisted.icpResult = [{ name: "P1" }];
      });
      const triggerCompetitor = jest.fn(async () => {
        persisted.competitorResult = { per_icp: [] };
      });
      const triggerCreativeDir = jest.fn(async () => {
        persisted.creativeDirResult = { concepts: [] };
      });
      const triggerAdImage = jest.fn(async () => {
        persisted.adImageResult = { variants: [] };
      });
      const triggerAdCopy = jest.fn(async () => {
        persisted.adCopyResult = { copies: [] };
      });

      jest.doMock("../services/db", () => ({
        userDb: {
          getUserById: jest.fn(async () => ({ ...persisted })),
          updateUser: jest.fn(async (_id: string, patch: any) => {
            if (patch && patch.steps) {
              persisted.steps = patch.steps;
            } else if (patch) {
              Object.assign(persisted, patch);
            }
          }),
        },
      }));
      jest.doMock("../services/onboardingIcpService", () => ({
        triggerIcpDiscoveryForUser: triggerIcp,
      }));
      jest.doMock("../services/onboardingCompetitorService", () => ({
        triggerCompetitorStrategyForUser: triggerCompetitor,
      }));
      jest.doMock("../services/onboardingCreativeDirService", () => ({
        triggerCreativeDirForUser: triggerCreativeDir,
      }));
      const claimAdImageRunMock = jest.fn(async () => ({
        runId: "adimg_test-run",
        startedAt: "2026-08-04T00:00:00.000Z",
      }));
      jest.doMock("../services/onboardingAdImageService", () => ({
        // The eager runner claims the axis for ITS OWN invocation and hands
        // that identity to the worker — a worker that re-reads identity from
        // the shared record cannot tell two overlapping runs apart (ENG-792).
        claimAdImageRun: claimAdImageRunMock,
        triggerAdImageGenerationForUser: triggerAdImage,
      }));
      jest.doMock("../services/onboardingAdCopyService", () => ({
        triggerAdCopyForUser: triggerAdCopy,
      }));
      jest.doMock("../services/onboardingBrandBuildService", () => ({
        triggerBrandBuildForUser: triggerBrandBuild,
      }));

      const {
        reconcileForUser,
        _resetOrchestratorForTests,
      } = require("../services/onboardingOrchestratorWiring");
      _resetOrchestratorForTests();
      const {
        _resetRateLimitState,
      } = require("../services/onboardingPipelineOrchestrator");
      _resetRateLimitState();
      const report = await reconcileForUser("u-stale");

      expect(persisted.steps?.icp?.status).toBe("ready");
      expect(persisted.steps?.icp?.output).toEqual([{ name: "P1" }]);
      // The whole DAG still walked — nothing was gated by the stale record.
      const fired = (report.fired as Array<{ step: string; status: string }>);
      expect(fired.map((f) => f.step)).toEqual([
        "brandDna",
        "icp",
        "competitor",
        "creativeDir",
        "adImage",
        "adCopy",
      ]);
      expect(fired.every((f) => f.status === "ready")).toBe(true);
    });
  });

  it("walks the DAG when the env flag is on, regardless of per-user opt-in", async () => {
    process.env.EAGER_ONBOARDING_PIPELINE_ENABLED = "true";

    await jest.isolateModulesAsync(async () => {
      const triggerBrandBuild = jest.fn(async () => undefined);
      const triggerIcp = jest.fn(async () => undefined);
      const triggerCompetitor = jest.fn(async () => undefined);
      const triggerCreativeDir = jest.fn(async () => undefined);
      const triggerAdImage = jest.fn(async () => undefined);
      const triggerAdCopy = jest.fn(async () => undefined);

      jest.doMock("../services/db", () => ({
        userDb: {
          getUserById: jest.fn().mockResolvedValue({
            userId: "u3",
            // useEagerPipeline NOT set — env flag should still drive it.
          }),
          updateUser: jest.fn().mockResolvedValue(undefined),
        },
      }));
      jest.doMock("../services/onboardingIcpService", () => ({
        triggerIcpDiscoveryForUser: triggerIcp,
      }));
      jest.doMock("../services/onboardingCompetitorService", () => ({
        triggerCompetitorStrategyForUser: triggerCompetitor,
      }));
      jest.doMock("../services/onboardingCreativeDirService", () => ({
        triggerCreativeDirForUser: triggerCreativeDir,
      }));
      const claimAdImageRunMock = jest.fn(async () => ({
        runId: "adimg_test-run",
        startedAt: "2026-08-04T00:00:00.000Z",
      }));
      jest.doMock("../services/onboardingAdImageService", () => ({
        // The eager runner claims the axis for ITS OWN invocation and hands
        // that identity to the worker — a worker that re-reads identity from
        // the shared record cannot tell two overlapping runs apart (ENG-792).
        claimAdImageRun: claimAdImageRunMock,
        triggerAdImageGenerationForUser: triggerAdImage,
      }));
      jest.doMock("../services/onboardingAdCopyService", () => ({
        triggerAdCopyForUser: triggerAdCopy,
      }));
      jest.doMock("../services/onboardingBrandBuildService", () => ({
        triggerBrandBuildForUser: triggerBrandBuild,
      }));

      const {
        reconcileForUser,
        _resetOrchestratorForTests,
      } = require("../services/onboardingOrchestratorWiring");
      _resetOrchestratorForTests();
      const {
        _resetRateLimitState,
      } = require("../services/onboardingPipelineOrchestrator");
      _resetRateLimitState();
      const report = await reconcileForUser("u3");

      expect(report).not.toBeNull();
      expect(report.gatedBy).toBeNull();
      expect(triggerBrandBuild).toHaveBeenCalled();
      expect(triggerIcp).toHaveBeenCalled();
    });
  });

  it("swallows runner errors so callers can fire-and-forget", async () => {
    process.env.EAGER_ONBOARDING_PIPELINE_ENABLED = "true";

    await jest.isolateModulesAsync(async () => {
      jest.doMock("../services/db", () => ({
        userDb: {
          getUserById: jest.fn().mockRejectedValue(new Error("dynamo down")),
          updateUser: jest.fn(),
        },
      }));
      jest.doMock("../services/onboardingIcpService", () => ({
        triggerIcpDiscoveryForUser: jest.fn(),
      }));
      jest.doMock("../services/onboardingCompetitorService", () => ({
        triggerCompetitorStrategyForUser: jest.fn(),
      }));
      jest.doMock("../services/onboardingCreativeDirService", () => ({
        triggerCreativeDirForUser: jest.fn(),
      }));
      const claimAdImageRunMock = jest.fn(async () => ({
        runId: "adimg_test-run",
        startedAt: "2026-08-04T00:00:00.000Z",
      }));
      jest.doMock("../services/onboardingAdImageService", () => ({
        triggerAdImageGenerationForUser: jest.fn(),
      }));
      jest.doMock("../services/onboardingAdCopyService", () => ({
        triggerAdCopyForUser: jest.fn(),
      }));
      jest.doMock("../services/onboardingBrandBuildService", () => ({
        triggerBrandBuildForUser: jest.fn(),
      }));

      const {
        reconcileForUser,
        _resetOrchestratorForTests,
      } = require("../services/onboardingOrchestratorWiring");
      _resetOrchestratorForTests();
      const {
        _resetRateLimitState,
      } = require("../services/onboardingPipelineOrchestrator");
      _resetRateLimitState();

      // Should not throw.
      const result = await reconcileForUser("u4");
      expect(result).toBeNull();
    });
  });
});

describe("PRODUCTION_DAG", () => {
  it("declares the same topology as DEFAULT_DAG (sub-task 1)", () => {
    const {
      PRODUCTION_DAG,
    } = require("../services/onboardingOrchestratorWiring");
    const {
      DEFAULT_DAG,
    } = require("../services/onboardingPipelineOrchestrator");

    expect(Object.keys(PRODUCTION_DAG).sort()).toEqual(
      Object.keys(DEFAULT_DAG).sort(),
    );
    for (const step of Object.keys(DEFAULT_DAG)) {
      expect(PRODUCTION_DAG[step].deps).toEqual(DEFAULT_DAG[step].deps);
    }
  });

  it("has runners that are NOT the placeholder error-throwers from DEFAULT_DAG", async () => {
    // The DEFAULT_DAG runners throw "placeholder" errors. The production
    // runners must do real work — at minimum, they must not throw
    // synchronously when invoked.
    const {
      PRODUCTION_DAG,
    } = require("../services/onboardingOrchestratorWiring");
    for (const step of Object.keys(PRODUCTION_DAG)) {
      const runner = PRODUCTION_DAG[step].runner;
      // These runners require mocked deps to actually run — but the fact
      // that they don't throw the literal "placeholder" string from
      // sub-task 1 is what we're asserting.
      expect(runner.toString()).not.toContain("placeholder");
    }
  });
});
