/**
 * Two reconcile passes over the same user must not both start the same step.
 *
 * `reconcile()` reads `User.steps` once, decides what to fire and persists a
 * `running` record before calling the runner. The per-process dedup in
 * onboardingOrchestratorWiring collapses concurrent calls inside ONE backend
 * process, but nothing stopped two instances (or any two passes that read before
 * either wrote) from both deciding to fire the same step: both computed the same
 * next generation, both ran the runner, and the second run's output was written
 * over the first's. The claim is now a compare-and-swap on the stored map.
 *
 * Two orchestrators over one shared store stand in for two backend instances.
 */

import {
  OnboardingPipelineOrchestrator,
  type OrchestratorUser,
  type UserSteps,
  _resetRateLimitState,
} from "../services/onboardingPipelineOrchestrator";

type Store = { user: OrchestratorUser; writes: number; conditionalFailures: number };

/** A shared store whose conditional write behaves like DynamoDB's: apply only while the stored map is exactly what was expected. */
function sharedStore(initial: Partial<OrchestratorUser> = {}) {
  const store: Store = { user: { userId: "u1", useEagerPipeline: true, ...initial }, writes: 0, conditionalFailures: 0 };
  const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
  const deps = {
    getUser: async () => clone(store.user),
    updateUserSteps: async (_id: string, steps: UserSteps, expected?: { steps: UserSteps | null }) => {
      if (expected) {
        const stored = store.user.steps ?? null;
        if (JSON.stringify(stored) !== JSON.stringify(expected.steps)) {
          store.conditionalFailures += 1;
          throw Object.assign(new Error("The conditional request failed"), { code: "ConditionalCheckFailedException" });
        }
      }
      store.user = { ...store.user, steps: clone(steps) };
      store.writes += 1;
    },
  };
  return { store, deps };
}

function dagWith(runs: { a: jest.Mock; b: jest.Mock }) {
  return {
    a: { deps: [], gatherInputs: () => ({ x: 1 }), runner: runs.a },
    b: { deps: ["a"], gatherInputs: (u: OrchestratorUser) => ({ a: u.steps?.a?.output ?? null }), runner: runs.b },
  } as any;
}

beforeEach(() => _resetRateLimitState());

describe("concurrent reconcile passes over one user", () => {
  it("run each step once, however the passes interleave", async () => {
    const runs = { a: jest.fn(async () => ({ made: "by-a" })), b: jest.fn(async () => ({ made: "by-b" })) };
    const { store, deps } = sharedStore();

    // Both passes read the user before either writes anything.
    let reads = 0;
    let bothRead!: () => void;
    const gate = new Promise<void>((r) => (bothRead = r));
    const gatedGetUser = async () => {
      const user = await deps.getUser();
      if (++reads <= 2) {
        if (reads === 2) bothRead();
        await Promise.race([gate, new Promise((r) => setTimeout(r, 200))]);
      }
      return user;
    };
    const make = () =>
      new OnboardingPipelineOrchestrator({ dag: dagWith(runs), isEnabledGlobally: () => true, ...deps, getUser: gatedGetUser });

    const reports = await Promise.all([make().reconcile("u1"), make().reconcile("u1")]);

    expect(runs.a).toHaveBeenCalledTimes(1);
    expect(runs.b).toHaveBeenCalledTimes(1);
    expect(store.user.steps?.a?.status).toBe("ready");
    expect(store.user.steps?.b?.status).toBe("ready");
    expect(store.user.steps?.a?.generation).toBe(1);
    // Exactly one pass fired each step; the other reported it as already taken.
    const fired = reports.flatMap((r) => r.fired.map((f) => f.step)).sort();
    expect(fired).toEqual(["a", "b"]);
    expect(store.conditionalFailures).toBeGreaterThan(0);
  });

  it("does not leave a step unfired when the claim loses only to an unrelated step's write", async () => {
    const runs = { a: jest.fn(async () => ({ made: "by-a" })), b: jest.fn(async () => ({ made: "by-b" })) };
    const { store, deps } = sharedStore();
    // Another writer touches the map (here: a record for a different step) between
    // this pass's read and its claim. That must cost a re-read, not the step.
    let injected = false;
    const noisy = {
      ...deps,
      updateUserSteps: async (id: string, steps: UserSteps, expected?: { steps: UserSteps | null }) => {
        if (!injected && expected) {
          injected = true;
          store.user = { ...store.user, steps: { z: { output: null, inputsHash: "h", generation: 1, provenance: "anticipated", status: "ready", ranAt: "t" } } as any };
        }
        return deps.updateUserSteps(id, steps, expected);
      },
    };
    const orch = new OnboardingPipelineOrchestrator({ dag: dagWith(runs), isEnabledGlobally: () => true, ...noisy });

    await orch.reconcile("u1");

    expect(runs.a).toHaveBeenCalledTimes(1);
    expect(runs.b).toHaveBeenCalledTimes(1);
    expect(store.user.steps?.a?.status).toBe("ready");
    expect(store.user.steps?.z?.status).toBe("ready");
  });
});
