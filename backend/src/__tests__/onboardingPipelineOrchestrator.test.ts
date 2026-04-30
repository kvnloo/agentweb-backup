/**
 * Tests for `OnboardingPipelineOrchestrator`.
 *
 * Pure logic — no DynamoDB, no real runners. Each test wires an
 * in-memory `getUser` / `updateUserSteps` pair and a synthetic DAG
 * (when convenient) so the assertions stay focused on orchestration
 * semantics: hash dedup, generation counter, topo-sort order, upstream
 * gating, feature flag, provenance precedence, rate limit, error
 * handling.
 */

import {
  DEFAULT_DAG,
  OnboardingPipelineOrchestrator,
  OrchestratorUser,
  StepName,
  UserSteps,
  _resetRateLimitState,
  defaultShouldRateLimit,
  hashInputs,
  isResultFresh,
  resolveProvenance,
  shouldFire,
  topoSort,
} from "../services/onboardingPipelineOrchestrator";

// ──────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────

interface InMemoryStore {
  user: OrchestratorUser;
  writeCount: number;
}

function buildStore(initial: Partial<OrchestratorUser>): {
  store: InMemoryStore;
  getUser: (id: string) => Promise<OrchestratorUser | null>;
  updateUserSteps: (id: string, steps: UserSteps) => Promise<void>;
} {
  const store: InMemoryStore = {
    user: {
      userId: "u1",
      ...initial,
    },
    writeCount: 0,
  };
  return {
    store,
    getUser: async (id) => (id === store.user.userId ? store.user : null),
    updateUserSteps: async (id, steps) => {
      if (id !== store.user.userId) return;
      store.user = { ...store.user, steps: { ...steps } };
      store.writeCount += 1;
    },
  };
}

beforeEach(() => {
  _resetRateLimitState();
  delete process.env.EAGER_ONBOARDING_PIPELINE_ENABLED;
});

// ──────────────────────────────────────────────────────────────────────
// hashInputs — pure
// ──────────────────────────────────────────────────────────────────────

describe("hashInputs", () => {
  it("returns equal hashes for equivalent objects regardless of key order", () => {
    expect(hashInputs({ a: 1, b: 2 })).toBe(hashInputs({ b: 2, a: 1 }));
  });

  it("differentiates hashes when values differ", () => {
    expect(hashInputs({ a: 1 })).not.toBe(hashInputs({ a: 2 }));
  });

  it("treats undefined and missing keys as equivalent", () => {
    expect(hashInputs({ a: 1, b: undefined })).toBe(hashInputs({ a: 1 }));
  });

  it("handles nested arrays and objects deterministically", () => {
    const a = { x: [{ k: 1 }, { k: 2 }], y: { p: 1, q: 2 } };
    const b = { y: { q: 2, p: 1 }, x: [{ k: 1 }, { k: 2 }] };
    expect(hashInputs(a)).toBe(hashInputs(b));
  });

  it("treats null and undefined as equivalent (canonical JSON null)", () => {
    // JSON.stringify maps undefined → null at the top level, so both
    // canonicalize to the same string. This is fine — gatherInputs
    // normalizes optional fields to `?? null` before hashing.
    expect(hashInputs(null)).toBe(hashInputs(undefined));
  });
});

// ──────────────────────────────────────────────────────────────────────
// topoSort — pure
// ──────────────────────────────────────────────────────────────────────

describe("topoSort", () => {
  it("orders the default DAG with brandDna first and adCopy after creativeDir", () => {
    const order = topoSort(DEFAULT_DAG);
    expect(order[0]).toBe("brandDna");
    expect(order.indexOf("brandDna")).toBeLessThan(order.indexOf("icp"));
    expect(order.indexOf("icp")).toBeLessThan(order.indexOf("competitor"));
    expect(order.indexOf("icp")).toBeLessThan(order.indexOf("creativeDir"));
    expect(order.indexOf("creativeDir")).toBeLessThan(order.indexOf("adImage"));
    expect(order.indexOf("creativeDir")).toBeLessThan(order.indexOf("adCopy"));
  });

  it("throws on a cyclic DAG", () => {
    const dag: any = {
      a: { deps: ["b"], gatherInputs: () => null, runner: async () => null },
      b: { deps: ["a"], gatherInputs: () => null, runner: async () => null },
    };
    expect(() => topoSort(dag)).toThrow(/Cycle detected/);
  });

  it("throws on a DAG with a missing dep", () => {
    const dag: any = {
      a: {
        deps: ["ghost"],
        gatherInputs: () => null,
        runner: async () => null,
      },
    };
    expect(() => topoSort(dag)).toThrow(/depends on unknown step/);
  });
});

// ──────────────────────────────────────────────────────────────────────
// resolveProvenance — pure
// ──────────────────────────────────────────────────────────────────────

describe("resolveProvenance", () => {
  it("user_authored beats user_confirmed beats anticipated", () => {
    const v = resolveProvenance<string>([
      { value: "anticipated", provenance: "anticipated" },
      { value: "user_confirmed", provenance: "user_confirmed" },
      { value: "user_authored", provenance: "user_authored" },
    ]);
    expect(v).toBe("user_authored");
  });

  it("falls through to lower priority when higher is missing", () => {
    const v = resolveProvenance<string>([
      { value: null, provenance: "user_authored" },
      { value: "user_confirmed", provenance: "user_confirmed" },
      { value: "anticipated", provenance: "anticipated" },
    ]);
    expect(v).toBe("user_confirmed");
  });

  it("returns null when all candidates are null/undefined", () => {
    const v = resolveProvenance<string>([
      { value: null, provenance: "user_authored" },
      { value: undefined, provenance: "user_confirmed" },
    ]);
    expect(v).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────────
// shouldFire — pure
// ──────────────────────────────────────────────────────────────────────

describe("shouldFire", () => {
  const dag = DEFAULT_DAG;

  it("does not fire when an upstream dep is missing", () => {
    const user: OrchestratorUser = { userId: "u1" };
    expect(shouldFire("icp", user, dag, hashInputs).fire).toBe(false);
  });

  it("does not fire when stored ready record matches input hash", () => {
    const user: OrchestratorUser = {
      userId: "u1",
      companyUrl: "x.com",
      steps: {
        brandDna: {
          output: "anything",
          inputsHash: hashInputs({
            companyUrl: "x.com",
            companyName: null,
            goal: null,
          }),
          generation: 1,
          provenance: "anticipated",
          status: "ready",
          ranAt: 0,
        },
      },
    };
    const decision = shouldFire("brandDna", user, dag, hashInputs);
    expect(decision.fire).toBe(false);
    if (!decision.fire) {
      expect(decision.reason).toMatch(/hash matches/);
    }
  });

  it("fires when stored ready record's hash does not match", () => {
    const user: OrchestratorUser = {
      userId: "u1",
      companyUrl: "new.com",
      steps: {
        brandDna: {
          output: "anything",
          inputsHash: "stale-hash",
          generation: 1,
          provenance: "anticipated",
          status: "ready",
          ranAt: 0,
        },
      },
    };
    const decision = shouldFire("brandDna", user, dag, hashInputs);
    expect(decision.fire).toBe(true);
  });

  it("does not fire over a user_authored step even on hash mismatch", () => {
    const user: OrchestratorUser = {
      userId: "u1",
      companyUrl: "new.com",
      steps: {
        brandDna: {
          output: "user-typed-this",
          inputsHash: "anything",
          generation: 1,
          provenance: "user_authored",
          status: "ready",
          ranAt: 0,
        },
      },
    };
    const decision = shouldFire("brandDna", user, dag, hashInputs);
    expect(decision.fire).toBe(false);
    if (!decision.fire) expect(decision.reason).toMatch(/user_authored/);
  });

  it("does not fire a second time when running with the same inputs", () => {
    const user: OrchestratorUser = {
      userId: "u1",
      companyUrl: "x.com",
      steps: {
        brandDna: {
          output: null,
          inputsHash: hashInputs({
            companyUrl: "x.com",
            companyName: null,
            goal: null,
          }),
          generation: 1,
          provenance: "anticipated",
          status: "running",
          ranAt: 0,
        },
      },
    };
    const decision = shouldFire("brandDna", user, dag, hashInputs);
    expect(decision.fire).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────
// isResultFresh — pure
// ──────────────────────────────────────────────────────────────────────

describe("isResultFresh", () => {
  it("rejects stale-generation results", () => {
    expect(isResultFresh(1, 2)).toBe(false);
  });
  it("accepts current-generation results", () => {
    expect(isResultFresh(2, 2)).toBe(true);
  });
  it("accepts a result that races ahead of stored state", () => {
    expect(isResultFresh(3, 2)).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────
// reconcile() — orchestration semantics
// ──────────────────────────────────────────────────────────────────────

/** Build a simple A → B DAG for reconcile() integration tests. */
function makeAtoBDag(opts: {
  runA?: jest.Mock;
  runB?: jest.Mock;
} = {}): any {
  const runA =
    opts.runA ??
    jest.fn(async ({ generation }: any) => ({ tag: "A-output", g: generation }));
  const runB =
    opts.runB ??
    jest.fn(async ({ inputs, generation }: any) => ({
      tag: "B-output",
      g: generation,
      seenA: (inputs as any).a,
    }));
  return {
    dag: {
      a: {
        deps: [],
        gatherInputs: (u: OrchestratorUser) => ({ x: u.x ?? null }),
        runner: runA,
      },
      b: {
        deps: ["a"],
        gatherInputs: (u: OrchestratorUser) => ({
          a: u.steps?.a?.output ?? null,
        }),
        runner: runB,
      },
    },
    runA,
    runB,
  };
}

describe("OnboardingPipelineOrchestrator.reconcile()", () => {
  it("is a no-op when global flag is off and user has not opted in", async () => {
    const { dag, runA, runB } = makeAtoBDag();
    const { getUser, updateUserSteps, store } = buildStore({});
    const orch = new OnboardingPipelineOrchestrator({
      dag,
      getUser,
      updateUserSteps,
      isEnabledGlobally: () => false,
    });
    const report = await orch.reconcile("u1");
    expect(report.gatedBy).toMatch(/feature flag off/);
    expect(runA).not.toHaveBeenCalled();
    expect(runB).not.toHaveBeenCalled();
    expect(store.writeCount).toBe(0);
  });

  it("runs when env flag is off but user opted in via useEagerPipeline", async () => {
    const { dag, runA, runB } = makeAtoBDag();
    const { getUser, updateUserSteps } = buildStore({ useEagerPipeline: true });
    const orch = new OnboardingPipelineOrchestrator({
      dag,
      getUser,
      updateUserSteps,
      isEnabledGlobally: () => false,
    });
    const report = await orch.reconcile("u1");
    expect(report.gatedBy).toBeNull();
    expect(runA).toHaveBeenCalledTimes(1);
    expect(runB).toHaveBeenCalledTimes(1);
  });

  it("respects topo-sort: A runs before B and B sees A's output", async () => {
    const { dag, runA, runB } = makeAtoBDag();
    const { getUser, updateUserSteps, store } = buildStore({
      useEagerPipeline: true,
      x: "input-x",
    });
    const orch = new OnboardingPipelineOrchestrator({
      dag,
      getUser,
      updateUserSteps,
      isEnabledGlobally: () => true,
    });
    await orch.reconcile("u1");
    expect(runA.mock.invocationCallOrder[0]).toBeLessThan(
      runB.mock.invocationCallOrder[0],
    );
    const aOutput = (store.user.steps?.a?.output as any);
    expect(aOutput.tag).toBe("A-output");
    const bOutput = (store.user.steps?.b?.output as any);
    expect(bOutput.seenA).toEqual(aOutput);
  });

  it("hash dedup: a second reconcile() with no upstream change does not re-fire", async () => {
    const { dag, runA, runB } = makeAtoBDag();
    const { getUser, updateUserSteps } = buildStore({
      useEagerPipeline: true,
    });
    const orch = new OnboardingPipelineOrchestrator({
      dag,
      getUser,
      updateUserSteps,
      isEnabledGlobally: () => true,
    });
    await orch.reconcile("u1");
    const firstReport = await orch.reconcile("u1");
    expect(runA).toHaveBeenCalledTimes(1);
    expect(runB).toHaveBeenCalledTimes(1);
    expect(firstReport.fired).toEqual([]);
    expect(firstReport.skipped.map((s) => s.step)).toEqual(["a", "b"]);
  });

  it("re-fires when user input changes (hash drift)", async () => {
    const { dag, runA, runB } = makeAtoBDag();
    const { store, getUser, updateUserSteps } = buildStore({
      useEagerPipeline: true,
      x: "v1",
    });
    const orch = new OnboardingPipelineOrchestrator({
      dag,
      getUser,
      updateUserSteps,
      isEnabledGlobally: () => true,
    });
    await orch.reconcile("u1");
    expect(runA).toHaveBeenCalledTimes(1);

    // Mutate input x — A's gatherInputs hash changes
    store.user = { ...store.user, x: "v2" };
    await orch.reconcile("u1");
    expect(runA).toHaveBeenCalledTimes(2);
    // B re-fires because A's output (which it gathers) changed
    expect(runB).toHaveBeenCalledTimes(2);
    expect(store.user.steps?.a?.generation).toBe(2);
  });

  it("upstream not ready: skips downstream until upstream is ready", async () => {
    const runA = jest.fn(async () => {
      throw new Error("A always fails");
    });
    const runB = jest.fn(async () => "B-output");
    const { dag } = makeAtoBDag({ runA, runB });
    const { getUser, updateUserSteps, store } = buildStore({
      useEagerPipeline: true,
    });
    const orch = new OnboardingPipelineOrchestrator({
      dag,
      getUser,
      updateUserSteps,
      isEnabledGlobally: () => true,
    });
    const report = await orch.reconcile("u1");
    expect(runA).toHaveBeenCalledTimes(1);
    expect(runB).not.toHaveBeenCalled();
    expect(store.user.steps?.a?.status).toBe("failed");
    expect(report.skipped.find((s) => s.step === "b")?.reason).toMatch(
      /upstream a not ready/,
    );
  });

  it("generation counter: stale runner result is discarded", async () => {
    // Plan: runner for A pauses; while paused, simulate a concurrent
    // reconcile() bumping generation by patching the store directly.
    let resolveRunner: ((v: unknown) => void) | undefined;
    const runA = jest.fn(
      () =>
        new Promise((res) => {
          resolveRunner = res;
        }),
    );
    const dag: any = {
      a: {
        deps: [],
        gatherInputs: (u: OrchestratorUser) => ({ x: u.x ?? null }),
        runner: runA,
      },
    };
    const { store, getUser, updateUserSteps } = buildStore({
      useEagerPipeline: true,
      x: "v1",
    });
    const orch = new OnboardingPipelineOrchestrator({
      dag,
      getUser,
      updateUserSteps,
      isEnabledGlobally: () => true,
    });

    const inFlight = orch.reconcile("u1");
    // Wait a microtask so runA gets invoked + start record is persisted.
    await new Promise((r) => setImmediate(r));

    // Simulate a concurrent reconcile that already bumped the
    // generation forward — this is what cancel-and-replace looks like
    // in production.
    store.user = {
      ...store.user,
      steps: {
        ...(store.user.steps ?? {}),
        a: {
          output: null,
          inputsHash: "newer-hash",
          generation: 99,
          provenance: "anticipated",
          status: "running",
          ranAt: 0,
        },
      },
    };

    // Resolve the original runner. Its result carries generation=1,
    // which is < 99, so it must be discarded.
    resolveRunner!({ tag: "stale" });
    const report = await inFlight;

    expect(report.skipped.find((s) => s.step === "a")?.reason).toMatch(
      /stale generation 1 < 99/,
    );
    // Persisted state for `a` was NOT overwritten with the stale output.
    expect(store.user.steps?.a?.output).toBeNull();
    expect(store.user.steps?.a?.generation).toBe(99);
  });

  it("runner failure persists status=failed with reason and gates downstream", async () => {
    const runA = jest.fn(async () => {
      throw new Error("LLM down");
    });
    const runB = jest.fn(async () => "B-output");
    const { dag } = makeAtoBDag({ runA, runB });
    const { getUser, updateUserSteps, store } = buildStore({
      useEagerPipeline: true,
    });
    const orch = new OnboardingPipelineOrchestrator({
      dag,
      getUser,
      updateUserSteps,
      isEnabledGlobally: () => true,
    });
    const report = await orch.reconcile("u1");
    expect(store.user.steps?.a?.status).toBe("failed");
    expect(store.user.steps?.a?.failedReason).toBe("LLM down");
    expect(runB).not.toHaveBeenCalled();
    expect(report.fired.some((f) => f.step === "a" && f.status === "failed"))
      .toBe(true);
  });

  it("rate limit blocks reconcile() once threshold exceeded", async () => {
    const { dag, runA } = makeAtoBDag();
    const { getUser, updateUserSteps } = buildStore({
      useEagerPipeline: true,
    });
    let calls = 0;
    const orch = new OnboardingPipelineOrchestrator({
      dag,
      getUser,
      updateUserSteps,
      isEnabledGlobally: () => true,
      shouldRateLimit: () => {
        calls += 1;
        return calls > 1; // first call passes, second rate-limits
      },
    });
    await orch.reconcile("u1");
    const blocked = await orch.reconcile("u1");
    expect(blocked.gatedBy).toMatch(/rate limit/);
    // runA fired exactly once (only the first reconcile got through)
    expect(runA).toHaveBeenCalledTimes(1);
  });

  it("respects provenance: user_authored output is never overwritten", async () => {
    const { dag, runA } = makeAtoBDag();
    const { getUser, updateUserSteps, store } = buildStore({
      useEagerPipeline: true,
      x: "v1",
      steps: {
        a: {
          output: "user-typed-this",
          inputsHash: "any",
          generation: 5,
          provenance: "user_authored",
          status: "ready",
          ranAt: 0,
        },
      },
    });
    const orch = new OnboardingPipelineOrchestrator({
      dag,
      getUser,
      updateUserSteps,
      isEnabledGlobally: () => true,
    });
    await orch.reconcile("u1");
    expect(runA).not.toHaveBeenCalled();
    expect(store.user.steps?.a?.output).toBe("user-typed-this");
    expect(store.user.steps?.a?.provenance).toBe("user_authored");
  });

  it("returns gatedBy='user not found' when getUser returns null", async () => {
    const { dag, runA } = makeAtoBDag();
    const orch = new OnboardingPipelineOrchestrator({
      dag,
      getUser: async () => null,
      updateUserSteps: async () => {},
      isEnabledGlobally: () => true,
    });
    const report = await orch.reconcile("ghost");
    expect(report.gatedBy).toMatch(/user not found/);
    expect(runA).not.toHaveBeenCalled();
  });

  it("global env flag = true is honoured (legacy compat path)", async () => {
    const { dag, runA } = makeAtoBDag();
    const { getUser, updateUserSteps } = buildStore({});
    process.env.EAGER_ONBOARDING_PIPELINE_ENABLED = "true";
    const orch = new OnboardingPipelineOrchestrator({
      dag,
      getUser,
      updateUserSteps,
      // No isEnabledGlobally override — falls through to env var.
    });
    await orch.reconcile("u1");
    expect(runA).toHaveBeenCalledTimes(1);
  });
});

// ──────────────────────────────────────────────────────────────────────
// defaultShouldRateLimit — sanity
// ──────────────────────────────────────────────────────────────────────

describe("defaultShouldRateLimit", () => {
  it("returns false until the threshold is exceeded, then true", () => {
    const userId = "rate-limit-user";
    const now = 1_000_000;
    let blocked = 0;
    for (let i = 0; i < 20; i += 1) {
      if (defaultShouldRateLimit(userId, now)) blocked += 1;
    }
    // 20 calls in the same instant — only the calls past the 15-per-hr
    // threshold come back blocked. (15 fires fit; calls 16..20 = 5 are
    // blocked.)
    expect(blocked).toBe(5);
  });

  it("forgets fires older than the 1-hour window", () => {
    const userId = "rate-limit-user-2";
    for (let i = 0; i < 20; i += 1) {
      defaultShouldRateLimit(userId, 0); // far past
    }
    // An hour later, the slate is clean.
    expect(defaultShouldRateLimit(userId, 60 * 60 * 1000 + 1)).toBe(false);
  });
});
