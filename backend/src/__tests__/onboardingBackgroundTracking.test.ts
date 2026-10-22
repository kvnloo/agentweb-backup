/**
 * ENG-2308: onboarding background runs must be registered with cronJobRegistry.
 *
 * gracefulShutdown() drains cronJobRegistry before it closes the listener. The
 * per-axis onboarding runs (icp, competitor, creative-dir, ad-copy, ad-image,
 * brand-build, and the eager reconcile walk) were launched with a bare
 * `void trigger…()`, so a deploy killed them mid-flight. That leaves the axis
 * `running` with a claim nobody will ever complete; with exclusive claims that
 * shows up as a retry that does nothing until the axis times out. Tracking them
 * lets a deploy wait for the run instead.
 */

import * as fs from "fs";
import * as path from "path";
import { cronJobRegistry } from "../utils/cronJobRegistry";

jest.mock("../services/brandGuidelinesPopulation", () => ({
  populateEmptyBrandGuidelines: jest.fn().mockResolvedValue(undefined),
}));

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const flush = () => new Promise((r) => setImmediate(r));

function mockDb(user: Record<string, unknown>) {
  jest.doMock("../services/db", () => ({
    taskDb: { getTasksWithKnowledgeBase: jest.fn().mockResolvedValue([]) },
    userDb: {
      getUserById: jest.fn(async () => ({ ...user })),
      updateUser: jest.fn().mockResolvedValue({}),
    },
  }));
}

afterEach(() => {
  // jest.doMock factories survive resetModules(): without this, the icp test's
  // stub of the competitor service leaks into the competitor test, which then
  // calls a no-op and registers nothing.
  jest.dontMock("../services/db");
  jest.dontMock("../services/onboardingCompetitorService");
  jest.resetModules();
  jest.clearAllMocks();
});

describe("onboarding background runs are tracked for graceful shutdown", () => {
  it("icp: registered while the LLM call is pending, released when it settles", async () => {
    await jest.isolateModulesAsync(async () => {
      mockDb({ userId: "u1", email: "u1@x.com", icpStatus: "running", icpStartedAt: new Date().toISOString(), companyName: "Acme" });
      jest.doMock("../services/onboardingCompetitorService", () => ({
        startCompetitorStrategyForUser: jest.fn(),
        triggerCompetitorStrategyForUser: jest.fn(),
      }));
      const { cronJobRegistry: registry } = require("../utils/cronJobRegistry");
      const { startIcpDiscoveryForUser } = require("../services/onboardingIcpService");
      const llm = deferred<unknown>();

      expect(registry.size()).toBe(0);
      await startIcpDiscoveryForUser("u1", { llm: { generateJsonRobust: () => llm.promise } });
      await flush();
      expect(registry.snapshot()).toEqual({ onboardingIcp: 1 });

      llm.resolve({ icps: [] }); // fails fast inside the trigger; the run still settles
      await flush();
      await flush();
      expect(registry.size()).toBe(0);
    });
  });

  it("competitor: registered while pending, released when it settles", async () => {
    await jest.isolateModulesAsync(async () => {
      const personas = [{ id: "p1", name: "P", pain: "p", desire: "d", objection: "o", meta_targeting_brief: "b" }];
      mockDb({ userId: "u1", email: "u1@x.com", icpStatus: "ready", icpResult: personas, competitorStatus: "running", competitorStartedAt: new Date().toISOString(), companyName: "Acme" });
      const { cronJobRegistry: registry } = require("../utils/cronJobRegistry");
      const { startCompetitorStrategyForUser } = require("../services/onboardingCompetitorService");
      const llm = deferred<unknown>();

      await startCompetitorStrategyForUser("u1", {
        llm: { generateJsonRobust: () => llm.promise },
        webSearchFn: async () => [],
      });
      await flush();
      expect(registry.snapshot()).toEqual({ onboardingCompetitor: 1 });

      llm.resolve({});
      await flush();
      await flush();
      await flush();
      expect(registry.size()).toBe(0);
    });
  });

  it("creative-dir: registered while pending, released when it settles", async () => {
    await jest.isolateModulesAsync(async () => {
      mockDb({ userId: "u1", email: "u1@x.com", creativeDirStatus: "running", creativeDirStartedAt: new Date().toISOString(), icpResult: [], companyName: "Acme" });
      const { cronJobRegistry: registry } = require("../utils/cronJobRegistry");
      const { startCreativeDirForUser } = require("../services/onboardingCreativeDirService");
      const llm = deferred<unknown>();

      await startCreativeDirForUser("u1", { llm: { generateJsonRobust: () => llm.promise } });
      await flush();
      expect(registry.snapshot()).toEqual({ onboardingCreativeDir: 1 });

      llm.resolve({});
      await flush();
      await flush();
      expect(registry.size()).toBe(0);
    });
  });

  it("the eager reconcile walk is tracked as one job per user, however many callers share it", async () => {
    await jest.isolateModulesAsync(async () => {
      const gate = deferred<void>();
      jest.doMock("../services/db", () => ({
        userDb: {
          // the orchestrator reads the user first; hold it here so the walk stays in flight
          getUserById: jest.fn(async () => {
            await gate.promise;
            return { userId: "u1" };
          }),
          updateUser: jest.fn().mockResolvedValue(undefined),
        },
      }));
      const { cronJobRegistry: registry } = require("../utils/cronJobRegistry");
      const { reconcileForUser, _resetOrchestratorForTests } = require("../services/onboardingOrchestratorWiring");
      _resetOrchestratorForTests();
      process.env.EAGER_ONBOARDING_PIPELINE_ENABLED = "true";
      try {
        const a = reconcileForUser("u1");
        const b = reconcileForUser("u1");
        await flush();
        expect(registry.snapshot()).toEqual({ onboardingReconcile: 1 });
        gate.resolve();
        await Promise.all([a, b]);
        expect(registry.size()).toBe(0);
      } finally {
        delete process.env.EAGER_ONBOARDING_PIPELINE_ENABLED;
      }
    });
  });

  it("no onboarding service launches a run with a bare `void trigger…()` (structural guard)", () => {
    const root = path.resolve(__dirname, "..");
    const files = [
      "services/onboardingIcpService.ts",
      "services/onboardingCompetitorService.ts",
      "services/onboardingCreativeDirService.ts",
      "services/onboardingAdCopyService.ts",
      "services/onboardingAdImageService.ts",
      "routes/brandBuild.ts",
      "routes/onboardingSteps.ts",
    ];
    for (const f of files) {
      const src = fs.readFileSync(path.join(root, f), "utf8");
      expect({ file: f, bare: /void\s+trigger\w+ForUser\s*\(/.test(src) }).toEqual({ file: f, bare: false });
      expect({ file: f, tracked: /(cronJobRegistry\.track|trackBackgroundRun)\(/.test(src) }).toEqual({ file: f, tracked: true });
    }
  });

  it("sanity: the registry used by the tests is the same singleton gracefulShutdown drains", () => {
    expect(cronJobRegistry.size()).toBe(0);
  });
});
