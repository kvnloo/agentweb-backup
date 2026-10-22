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
        // ENG-2308 follow-up: runIcp claims its own axis before triggering
        // (same reasoning as adImage's claim below) — the mock must supply
        // a truthy claim or the runner never reaches triggerIcp at all.
        claimIcpRun: jest.fn(async () => ({})),
        triggerIcpDiscoveryForUser: triggerIcp,
      }));
      jest.doMock("../services/onboardingCompetitorService", () => ({
        claimCompetitorRun: jest.fn(async () => ({})),
        triggerCompetitorStrategyForUser: triggerCompetitor,
      }));
      jest.doMock("../services/onboardingCreativeDirService", () => ({
        claimCreativeDirRun: jest.fn(async () => ({})),
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
        claimAdCopyRun: jest.fn(async () => ({})),
        triggerAdCopyForUser: triggerAdCopy,
      }));
      jest.doMock("../services/onboardingBrandBuildService", () => ({
        claimBrandBuildRun: jest.fn(async () => ({})),
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
        // ENG-2308 follow-up: runIcp claims its own axis before triggering
        // (same reasoning as adImage's claim below) — the mock must supply
        // a truthy claim or the runner never reaches triggerIcp at all.
        claimIcpRun: jest.fn(async () => ({})),
        triggerIcpDiscoveryForUser: triggerIcp,
      }));
      jest.doMock("../services/onboardingCompetitorService", () => ({
        claimCompetitorRun: jest.fn(async () => ({})),
        triggerCompetitorStrategyForUser: triggerCompetitor,
      }));
      jest.doMock("../services/onboardingCreativeDirService", () => ({
        claimCreativeDirRun: jest.fn(async () => ({})),
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
        claimAdCopyRun: jest.fn(async () => ({})),
        triggerAdCopyForUser: triggerAdCopy,
      }));
      jest.doMock("../services/onboardingBrandBuildService", () => ({
        claimBrandBuildRun: jest.fn(async () => ({})),
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

      // Every legacy trigger fired exactly once. icp/competitor/creativeDir/
      // adCopy now also receive an `expectedStartedAt` (ENG-2308 review
      // follow-up — the ownership token threaded through so a later
      // reclaim's zombie completion can't be mistaken for THIS run's own),
      // so assert on the call args loosely rather than the exact 1-arg
      // shape this mock happens to supply (undefined, since this test's
      // claim mocks return `{}`).
      expect(triggerBrandBuild).toHaveBeenCalledWith(
        "u2",
        expect.objectContaining({ expectedStartedAt: undefined }),
      );
      expect(triggerIcp).toHaveBeenCalledWith(
        "u2",
        expect.objectContaining({ expectedStartedAt: undefined }),
      );
      expect(triggerCompetitor).toHaveBeenCalledWith(
        "u2",
        expect.objectContaining({ expectedStartedAt: undefined }),
      );
      expect(triggerCreativeDir).toHaveBeenCalledWith(
        "u2",
        expect.objectContaining({ expectedStartedAt: undefined }),
      );
      expect(triggerAdImage).toHaveBeenCalledWith("u2", {
        run: { runId: "adimg_test-run", startedAt: "2026-08-04T00:00:00.000Z" },
      });
      expect(triggerAdCopy).toHaveBeenCalledWith(
        "u2",
        expect.objectContaining({ expectedStartedAt: undefined }),
      );

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
        // ENG-2308 follow-up: runIcp claims its own axis before triggering
        // (same reasoning as adImage's claim below) — the mock must supply
        // a truthy claim or the runner never reaches triggerIcp at all.
        claimIcpRun: jest.fn(async () => ({})),
        triggerIcpDiscoveryForUser: triggerIcp,
      }));
      jest.doMock("../services/onboardingCompetitorService", () => ({
        claimCompetitorRun: jest.fn(async () => ({})),
        triggerCompetitorStrategyForUser: triggerCompetitor,
      }));
      jest.doMock("../services/onboardingCreativeDirService", () => ({
        claimCreativeDirRun: jest.fn(async () => ({})),
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
        claimAdCopyRun: jest.fn(async () => ({})),
        triggerAdCopyForUser: triggerAdCopy,
      }));
      jest.doMock("../services/onboardingBrandBuildService", () => ({
        claimBrandBuildRun: jest.fn(async () => ({})),
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
      expect(triggerAdCopy).toHaveBeenCalledWith(
        "u-eng792",
        expect.objectContaining({ expectedStartedAt: undefined }),
      );
      expect(fired.find((f) => f.step === "adCopy")?.status).toBe("ready");
    });
  });

  it("records adImage as FAILED even when the index still serves the row from before the run (ENG-2308)", async () => {
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
      // The UserIdIndex lags: its copy of the ad-image axis fields is still the
      // one from BEFORE the run, with no failure on it. (Only those fields are
      // stale here, so the orchestrator's own step bookkeeping is unaffected.)
      let staleAxis: Record<string, any> | null = null;
      const triggerAdImage = jest.fn(async () => {
        staleAxis = {
          adImageStatus: persisted.adImageStatus,
          adImageError: persisted.adImageError,
          adImageCompletedAt: persisted.adImageCompletedAt,
        };
        persisted.adImageStatus = "failed";
        persisted.adImageError = "all 3 variants failed";
        persisted.adImageCompletedAt = new Date().toISOString();
      });
      const triggerAdCopy = jest.fn(async () => {
        persisted.adCopyResult = { copies: [] };
      });

      jest.doMock("../services/db", () => ({
        userDb: {
          getUserById: jest.fn(async () => ({ ...persisted, ...(staleAxis ?? {}) })),
          getUserByIdConsistent: jest.fn(async () => ({ ...persisted })),
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
        // ENG-2308 follow-up: runIcp claims its own axis before triggering
        // (same reasoning as adImage's claim below) — the mock must supply
        // a truthy claim or the runner never reaches triggerIcp at all.
        claimIcpRun: jest.fn(async () => ({})),
        triggerIcpDiscoveryForUser: triggerIcp,
      }));
      jest.doMock("../services/onboardingCompetitorService", () => ({
        claimCompetitorRun: jest.fn(async () => ({})),
        triggerCompetitorStrategyForUser: triggerCompetitor,
      }));
      jest.doMock("../services/onboardingCreativeDirService", () => ({
        claimCreativeDirRun: jest.fn(async () => ({})),
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
        claimAdCopyRun: jest.fn(async () => ({})),
        triggerAdCopyForUser: triggerAdCopy,
      }));
      jest.doMock("../services/onboardingBrandBuildService", () => ({
        claimBrandBuildRun: jest.fn(async () => ({})),
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
      expect(triggerAdCopy).toHaveBeenCalledWith(
        "u-eng792",
        expect.objectContaining({ expectedStartedAt: undefined }),
      );
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
        // ENG-2308 follow-up: runIcp claims its own axis before triggering
        // (same reasoning as adImage's claim below) — the mock must supply
        // a truthy claim or the runner never reaches triggerIcp at all.
        claimIcpRun: jest.fn(async () => ({})),
        triggerIcpDiscoveryForUser: triggerIcp,
      }));
      jest.doMock("../services/onboardingCompetitorService", () => ({
        claimCompetitorRun: jest.fn(async () => ({})),
        triggerCompetitorStrategyForUser: triggerCompetitor,
      }));
      jest.doMock("../services/onboardingCreativeDirService", () => ({
        claimCreativeDirRun: jest.fn(async () => ({})),
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
        claimAdCopyRun: jest.fn(async () => ({})),
        triggerAdCopyForUser: triggerAdCopy,
      }));
      jest.doMock("../services/onboardingBrandBuildService", () => ({
        claimBrandBuildRun: jest.fn(async () => ({})),
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
        // ENG-2308 follow-up: runIcp claims its own axis before triggering
        // (same reasoning as adImage's claim below) — the mock must supply
        // a truthy claim or the runner never reaches triggerIcp at all.
        claimIcpRun: jest.fn(async () => ({})),
        triggerIcpDiscoveryForUser: triggerIcp,
      }));
      jest.doMock("../services/onboardingCompetitorService", () => ({
        claimCompetitorRun: jest.fn(async () => ({})),
        triggerCompetitorStrategyForUser: triggerCompetitor,
      }));
      jest.doMock("../services/onboardingCreativeDirService", () => ({
        claimCreativeDirRun: jest.fn(async () => ({})),
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
        claimAdCopyRun: jest.fn(async () => ({})),
        triggerAdCopyForUser: triggerAdCopy,
      }));
      jest.doMock("../services/onboardingBrandBuildService", () => ({
        claimBrandBuildRun: jest.fn(async () => ({})),
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
        // ENG-2308 follow-up: runIcp claims its own axis before triggering
        // (same reasoning as adImage's claim below) — the mock must supply
        // a truthy claim or the runner never reaches triggerIcp at all.
        claimIcpRun: jest.fn(async () => ({})),
        triggerIcpDiscoveryForUser: triggerIcp,
      }));
      jest.doMock("../services/onboardingCompetitorService", () => ({
        claimCompetitorRun: jest.fn(async () => ({})),
        triggerCompetitorStrategyForUser: triggerCompetitor,
      }));
      jest.doMock("../services/onboardingCreativeDirService", () => ({
        claimCreativeDirRun: jest.fn(async () => ({})),
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
        claimAdCopyRun: jest.fn(async () => ({})),
        triggerAdCopyForUser: triggerAdCopy,
      }));
      jest.doMock("../services/onboardingBrandBuildService", () => ({
        claimBrandBuildRun: jest.fn(async () => ({})),
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
        claimIcpRun: jest.fn(async () => ({})),
        triggerIcpDiscoveryForUser: jest.fn(),
      }));
      jest.doMock("../services/onboardingCompetitorService", () => ({
        claimCompetitorRun: jest.fn(async () => ({})),
        triggerCompetitorStrategyForUser: jest.fn(),
      }));
      jest.doMock("../services/onboardingCreativeDirService", () => ({
        claimCreativeDirRun: jest.fn(async () => ({})),
        triggerCreativeDirForUser: jest.fn(),
      }));
      const claimAdImageRunMock = jest.fn(async () => ({
        runId: "adimg_test-run",
        startedAt: "2026-08-04T00:00:00.000Z",
      }));
      jest.doMock("../services/onboardingAdImageService", () => ({
        claimAdImageRun: claimAdImageRunMock,
        triggerAdImageGenerationForUser: jest.fn(),
      }));
      jest.doMock("../services/onboardingAdCopyService", () => ({
        claimAdCopyRun: jest.fn(async () => ({})),
        triggerAdCopyForUser: jest.fn(),
      }));
      jest.doMock("../services/onboardingBrandBuildService", () => ({
        claimBrandBuildRun: jest.fn(async () => ({})),
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

  // ENG-2308 review follow-up, confirmed by direct reproduction: two
  // concurrent reconcileForUser() calls for the same user both read
  // User.steps before either has persisted anything, so both compute the
  // SAME starting generation and both decide a not-yet-claimed step is
  // theirs to fire. The per-axis DynamoDB claim correctly lets only one
  // of them win the real work, but — before this fix — the LOSING pass's
  // own topo walk still treated the step as "ready" (with whatever
  // placeholder/null output the lost claim returned) and proceeded to
  // fire the NEXT step for real using it, a genuine wasted/degraded extra
  // LLM call. Fixed by collapsing concurrent calls for the same userId
  // into the one already-in-flight reconcile() pass.
  it("collapses two concurrent reconcileForUser calls for the same user into a single orchestrator pass", async () => {
    process.env.EAGER_ONBOARDING_PIPELINE_ENABLED = "true";

    await jest.isolateModulesAsync(async () => {
      let releaseIcp: (() => void) | undefined;
      const icpGate = new Promise<void>((resolve) => {
        releaseIcp = resolve;
      });
      // Claim is slow — mirrors a real DynamoDB round-trip — so both
      // concurrent reconcileForUser() calls are guaranteed to be
      // in-flight at the same time before either resolves anything.
      const claimIcpRunMock = jest.fn(async () => {
        await icpGate;
        return { icpStatus: "running" };
      });
      const triggerIcp = jest.fn(async () => undefined);

      // Stateful store: a real pass persists `steps`, which is what makes the
      // follow-up pass (see the coalescing test below) a hash-deduped no-op.
      const concurrentUser: Record<string, any> = { userId: "u-concurrent" };
      jest.doMock("../services/db", () => ({
        userDb: {
          getUserById: jest.fn(async () => ({ ...concurrentUser })),
          updateUser: jest.fn(async (_id: string, patch: Record<string, any>) => {
            Object.assign(concurrentUser, patch);
          }),
        },
      }));
      jest.doMock("../services/onboardingIcpService", () => ({
        claimIcpRun: claimIcpRunMock,
        triggerIcpDiscoveryForUser: triggerIcp,
      }));
      jest.doMock("../services/onboardingCompetitorService", () => ({
        claimCompetitorRun: jest.fn(async () => ({})),
        triggerCompetitorStrategyForUser: jest.fn(async () => undefined),
      }));
      jest.doMock("../services/onboardingCreativeDirService", () => ({
        claimCreativeDirRun: jest.fn(async () => ({})),
        triggerCreativeDirForUser: jest.fn(async () => undefined),
      }));
      jest.doMock("../services/onboardingAdImageService", () => ({
        claimAdImageRun: jest.fn(async () => ({
          runId: "adimg_test-run",
          startedAt: "2026-08-04T00:00:00.000Z",
        })),
        triggerAdImageGenerationForUser: jest.fn(async () => undefined),
      }));
      jest.doMock("../services/onboardingAdCopyService", () => ({
        claimAdCopyRun: jest.fn(async () => ({})),
        triggerAdCopyForUser: jest.fn(async () => undefined),
      }));
      jest.doMock("../services/onboardingBrandBuildService", () => ({
        claimBrandBuildRun: jest.fn(async () => ({})),
        triggerBrandBuildForUser: jest.fn(async () => undefined),
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

      // Two callers fire reconcileForUser for the SAME user before
      // either's icp claim has resolved — exactly the race window
      // reproduced against the bare orchestrator.
      const callA = reconcileForUser("u-concurrent");
      const callB = reconcileForUser("u-concurrent");
      // Let both calls actually reach the (still-paused) icp claim.
      await new Promise((r) => setImmediate(r));
      releaseIcp!();

      const [reportA, reportB] = await Promise.all([callA, callB]);

      // Without the dedup, claimIcpRun/triggerIcp would each be called
      // twice (once per concurrent reconcile pass) — the exact shape of
      // the reproduced bug (a real extra LLM call fired from the losing
      // pass's own topo walk). With the dedup, both callers share the
      // one in-flight pass.
      expect(claimIcpRunMock).toHaveBeenCalledTimes(1);
      expect(triggerIcp).toHaveBeenCalledTimes(1);
      // Both callers share the same result. (It is the last pass's report: the
      // hash-deduped follow-up pass, so its `fired` is empty; that icp ran once
      // is what the claim/trigger counts above prove.)
      expect(reportA).toBe(reportB);
    });
  });

  // Finding C of the third review: a request that arrives while a pass is
  // walking must not be lost. A walk only revisits steps AHEAD of its position,
  // so an upstream change made after the walk passed a step needs another pass.
  it("runs exactly one follow-up pass for requests that arrived mid-walk, and none when nothing arrived", async () => {
    process.env.EAGER_ONBOARDING_PIPELINE_ENABLED = "true";

    await jest.isolateModulesAsync(async () => {
      let releaseBrand: (() => void) | undefined;
      const brandGate = new Promise<void>((r) => { releaseBrand = r; });
      const user: Record<string, any> = { userId: "u-coalesce", companyUrl: "https://a.test" };
      const getUserById = jest.fn(async () => ({ ...user }));
      jest.doMock("../services/db", () => ({
        userDb: {
          getUserById,
          updateUser: jest.fn(async (_id: string, patch: Record<string, any>) => { Object.assign(user, patch); }),
        },
      }));
      const triggerBrand = jest.fn(async () => { await brandGate; user.brandGuidelines = { v: 1 }; });
      jest.doMock("../services/onboardingBrandBuildService", () => ({
        claimBrandBuildRun: jest.fn(async () => ({ brandBuildStartedAt: "s" })),
        triggerBrandBuildForUser: triggerBrand,
      }));
      for (const [mod, claim, trig] of [
        ["onboardingIcpService", "claimIcpRun", "triggerIcpDiscoveryForUser"],
        ["onboardingCompetitorService", "claimCompetitorRun", "triggerCompetitorStrategyForUser"],
        ["onboardingCreativeDirService", "claimCreativeDirRun", "triggerCreativeDirForUser"],
        ["onboardingAdCopyService", "claimAdCopyRun", "triggerAdCopyForUser"],
      ] as const) {
        jest.doMock(`../services/${mod}`, () => ({ [claim]: jest.fn(async () => ({})), [trig]: jest.fn(async () => undefined) }));
      }
      jest.doMock("../services/onboardingAdImageService", () => ({
        claimAdImageRun: jest.fn(async () => ({ runId: "r", startedAt: "s" })),
        triggerAdImageGenerationForUser: jest.fn(async () => undefined),
      }));

      const { reconcileForUser, _resetOrchestratorForTests } = require("../services/onboardingOrchestratorWiring");
      _resetOrchestratorForTests();
      require("../services/onboardingPipelineOrchestrator")._resetRateLimitState();

      const first = reconcileForUser("u-coalesce");
      await new Promise((r) => setImmediate(r)); // first pass is now parked inside brandDna
      // Two more requests arrive mid-walk. They share the in-flight promise...
      const second = reconcileForUser("u-coalesce");
      const third = reconcileForUser("u-coalesce");
      // ...and the user changes an upstream input after the walk passed brandDna's inputs.
      user.companyUrl = "https://changed.test";
      releaseBrand!();
      await Promise.all([first, second, third]);

      // brandDna fired once for the first pass, and once more in the single
      // follow-up pass because its input hash changed; two requests coalesced
      // into ONE extra pass, not two.
      expect(triggerBrand).toHaveBeenCalledTimes(2);

      // With nothing arriving mid-walk there is no follow-up pass.
      const before = getUserById.mock.calls.length;
      await reconcileForUser("u-coalesce");
      const oneQuietPass = getUserById.mock.calls.length - before;
      expect(oneQuietPass).toBeGreaterThan(0);
      expect(triggerBrand).toHaveBeenCalledTimes(2);
    });
  });

  it("does not dedup a SECOND, later-arriving call once the first has already finished", async () => {
    process.env.EAGER_ONBOARDING_PIPELINE_ENABLED = "true";

    await jest.isolateModulesAsync(async () => {
      const getUserByIdMock = jest.fn().mockResolvedValue({ userId: "u-sequential" });

      jest.doMock("../services/db", () => ({
        userDb: {
          getUserById: getUserByIdMock,
          updateUser: jest.fn().mockResolvedValue(undefined),
        },
      }));
      jest.doMock("../services/onboardingIcpService", () => ({
        claimIcpRun: jest.fn(async () => ({})),
        triggerIcpDiscoveryForUser: jest.fn(async () => undefined),
      }));
      jest.doMock("../services/onboardingCompetitorService", () => ({
        claimCompetitorRun: jest.fn(async () => ({})),
        triggerCompetitorStrategyForUser: jest.fn(async () => undefined),
      }));
      jest.doMock("../services/onboardingCreativeDirService", () => ({
        claimCreativeDirRun: jest.fn(async () => ({})),
        triggerCreativeDirForUser: jest.fn(async () => undefined),
      }));
      jest.doMock("../services/onboardingAdImageService", () => ({
        claimAdImageRun: jest.fn(async () => ({
          runId: "adimg_test-run",
          startedAt: "2026-08-04T00:00:00.000Z",
        })),
        triggerAdImageGenerationForUser: jest.fn(async () => undefined),
      }));
      jest.doMock("../services/onboardingAdCopyService", () => ({
        claimAdCopyRun: jest.fn(async () => ({})),
        triggerAdCopyForUser: jest.fn(async () => undefined),
      }));
      jest.doMock("../services/onboardingBrandBuildService", () => ({
        claimBrandBuildRun: jest.fn(async () => ({})),
        triggerBrandBuildForUser: jest.fn(async () => undefined),
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

      await reconcileForUser("u-sequential");
      const callsAfterFirst = getUserByIdMock.mock.calls.length;
      expect(callsAfterFirst).toBeGreaterThan(0);

      await reconcileForUser("u-sequential");
      // The dedup map must release its entry once a pass finishes — a
      // genuinely later, sequential call must run its OWN fresh
      // reconcile() pass (its own getUser read), not reuse a stale
      // in-flight promise left behind by an earlier, already-settled call.
      expect(getUserByIdMock.mock.calls.length).toBeGreaterThan(callsAfterFirst);
    });
  });
});

// ENG-2308: a runner that loses the per-axis claim (to another backend
// instance's reconcile pass, a legacy route, /icp/regenerate-one) must not run
// a second worker, must not report the other run's stale placeholder as a
// result, and must not strand the step at `running` (nothing re-fires it, and
// a winner that is not the orchestrator never updates User.steps). It joins the
// other run: waits for it to leave the in-flight state, then adopts its real
// outcome. Table-driven over all six runners.
const AXIS_CASES = [
  { step: "adImage", prefix: "adImage", inFlight: "running", resultField: "adImageResult", mod: "onboardingAdImageService", claim: "claimAdImageRun", trigger: "triggerAdImageGenerationForUser" },
  { step: "brandDna", prefix: "brandBuild", inFlight: "building", resultField: "brandGuidelines", mod: "onboardingBrandBuildService", claim: "claimBrandBuildRun", trigger: "triggerBrandBuildForUser" },
  { step: "icp", prefix: "icp", inFlight: "running", resultField: "icpResult", mod: "onboardingIcpService", claim: "claimIcpRun", trigger: "triggerIcpDiscoveryForUser" },
  { step: "competitor", prefix: "competitor", inFlight: "running", resultField: "competitorResult", mod: "onboardingCompetitorService", claim: "claimCompetitorRun", trigger: "triggerCompetitorStrategyForUser" },
  { step: "creativeDir", prefix: "creativeDir", inFlight: "running", resultField: "creativeDirResult", mod: "onboardingCreativeDirService", claim: "claimCreativeDirRun", trigger: "triggerCreativeDirForUser" },
  { step: "adCopy", prefix: "adCopy", inFlight: "running", resultField: "adCopyResult", mod: "onboardingAdCopyService", claim: "claimAdCopyRun", trigger: "triggerAdCopyForUser" },
] as const;

type AxisCase = (typeof AXIS_CASES)[number];

/** Runs `fn` with only this axis's service mocked, and a scripted sequence of user reads. */
async function withAxis(
  c: AxisCase,
  opts: { claim: unknown; reads: Array<Record<string, unknown>> },
  fn: (ctx: {
    runner: (a: { userId: string }) => Promise<unknown>;
    claimMock: jest.Mock;
    triggerMock: jest.Mock;
    getUserById: jest.Mock;
    setPoll: (ms: number) => void;
  }) => Promise<void>,
) {
  await jest.isolateModulesAsync(async () => {
    const triggerMock = jest.fn(async () => undefined);
    const claimMock = jest.fn(async () => opts.claim);
    const getUserById = jest.fn();
    opts.reads.forEach((r, idx) =>
      idx === opts.reads.length - 1
        ? getUserById.mockResolvedValue(r)
        : getUserById.mockResolvedValueOnce(r),
    );
    jest.doMock("../services/db", () => ({
      userDb: { getUserById, updateUser: jest.fn().mockResolvedValue(undefined) },
    }));
    jest.doMock(`../services/${c.mod}`, () => ({ [c.claim]: claimMock, [c.trigger]: triggerMock }));
    const wiring = require("../services/onboardingOrchestratorWiring");
    wiring._setJoinPollMsForTests(1);
    await fn({
      runner: (a) => wiring.PRODUCTION_DAG[c.step].runner(a),
      claimMock,
      triggerMock,
      getUserById,
      setPoll: wiring._setJoinPollMsForTests,
    });
  });
}

describe.each(AXIS_CASES)("lost start-claim race — $step (ENG-2308)", (c) => {
  const other = `${c.prefix}StartedAt`;
  const inflight = { userId: "u1", [`${c.prefix}Status`]: c.inFlight, [other]: "2026-10-07T10:00:00.000Z", [c.resultField]: "STALE-PLACEHOLDER" };

  it("does not launch a worker; joins the in-flight run and adopts its REAL result", async () => {
    const real = { real: c.step };
    await withAxis(
      c,
      { claim: null, reads: [inflight, inflight, { userId: "u1", [`${c.prefix}Status`]: "ready", [other]: "2026-10-07T10:00:00.000Z", [c.resultField]: real }] },
      async ({ runner, claimMock, triggerMock, getUserById }) => {
        const result = await runner({ userId: "u1" });
        expect(claimMock).toHaveBeenCalledWith("u1");
        // Must NOT launch a second worker when the claim is owned elsewhere.
        expect(triggerMock).not.toHaveBeenCalled();
        // The stale placeholder must never be reported as the step's output.
        expect(result).toEqual(real);
        expect(getUserById.mock.calls.length).toBeGreaterThanOrEqual(3);
      },
    );
  });

  it("adopts the other run's FAILURE (step is recorded failed, retryable) instead of reporting ready", async () => {
    await withAxis(
      c,
      { claim: null, reads: [inflight, { userId: "u1", [`${c.prefix}Status`]: "failed", [`${c.prefix}CompletedAt`]: new Date(Date.now() + 60_000).toISOString(), [`${c.prefix}Error`]: "winner blew up" }] },
      async ({ runner }) => {
        await expect(runner({ userId: "u1" })).rejects.toThrow("winner blew up");
      },
    );
  });

  it("throws an ordinary error (step recorded failed, NOT stranded running) if the other run outlives the axis timeout", async () => {
    await withAxis(c, { claim: null, reads: [inflight] }, async ({ runner }) => {
      const realNow = Date.now.bind(Date);
      let offset = 0;
      const spy = jest.spyOn(Date, "now").mockImplementation(() => realNow() + offset);
      // Each poll advances the clock by a big step so the deadline passes quickly.
      const origSetTimeout = global.setTimeout;
      jest.spyOn(global, "setTimeout").mockImplementation(((fn: () => void) => {
        offset += 60_000;
        return origSetTimeout(fn, 0);
      }) as any);
      await expect(runner({ userId: "u1" })).rejects.toThrow(/still held by another run/);
      spy.mockRestore();
      (global.setTimeout as any).mockRestore?.();
    });
  });

  it("after its OWN trigger, a dropped completion (another run now owns the axis) is joined, not reported stale", async () => {
    const real = { real: `${c.step}-newer` };
    const own = "2026-10-07T09:00:00.000Z";
    const ownClaim = { [`${c.prefix}StartedAt`]: own, ...(c.step === "adImage" ? { runId: "r", startedAt: own } : {}) };
    await withAxis(
      c,
      { claim: ownClaim, reads: [inflight /* a reclaim superseded us */, { userId: "u1", [`${c.prefix}Status`]: "ready", [other]: "2026-10-07T10:00:00.000Z", [c.resultField]: real }] },
      async ({ runner, triggerMock }) => {
        const result = await runner({ userId: "u1" });
        expect(triggerMock).toHaveBeenCalledTimes(1);
        expect(result).toEqual(real);
      },
    );
  });

  it("returns the record's result at once when the axis is in flight under OUR OWN claim (trigger gated, nothing else running)", async () => {
    const own = "2026-10-07T09:00:00.000Z";
    const ownClaim = { [`${c.prefix}StartedAt`]: own, ...(c.step === "adImage" ? { runId: "r", startedAt: own } : {}) };
    await withAxis(
      c,
      { claim: ownClaim, reads: [{ userId: "u1", [`${c.prefix}Status`]: c.inFlight, [other]: own, [c.resultField]: "OWN-CURRENT" }] },
      async ({ runner, getUserById }) => {
        expect(await runner({ userId: "u1" })).toBe("OWN-CURRENT");
        expect(getUserById).toHaveBeenCalledTimes(1);
      },
    );
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

// ENG-2308 review: settleAxis polls every few seconds while it waits for another
// run. Only its FIRST read follows the runner's own write and needs the base
// table; the polls after it just wait for the in-flight state to clear, so they
// use the cheaper index read instead of paying for a consistent read each time.
describe("settleAxis read cost while joining another run (ENG-2308)", () => {
  it("makes one consistent read, then plain index reads for the polls", async () => {
    await jest.isolateModulesAsync(async () => {
      const inflight = { userId: "u1", icpStatus: "running", icpStartedAt: "2026-10-07T10:00:00.000Z", icpResult: "STALE-PLACEHOLDER" };
      const done = { userId: "u1", icpStatus: "ready", icpStartedAt: "2026-10-07T10:00:00.000Z", icpResult: { real: true } };
      const getUserById = jest.fn().mockResolvedValueOnce(inflight).mockResolvedValue(done);
      const getUserByIdConsistent = jest.fn().mockResolvedValue(inflight);
      jest.doMock("../services/db", () => ({
        userDb: { getUserById, getUserByIdConsistent, updateUser: jest.fn().mockResolvedValue(undefined) },
      }));
      jest.doMock("../services/onboardingIcpService", () => ({
        claimIcpRun: jest.fn(async () => null), // lost the claim: join the other run
        triggerIcpDiscoveryForUser: jest.fn(),
      }));
      const wiring = require("../services/onboardingOrchestratorWiring");
      wiring._setJoinPollMsForTests(1);
      const result = await wiring.PRODUCTION_DAG.icp.runner({ userId: "u1" });
      expect(result).toEqual({ real: true });
      expect(getUserByIdConsistent).toHaveBeenCalledTimes(1);
      expect(getUserById.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
  });
});
