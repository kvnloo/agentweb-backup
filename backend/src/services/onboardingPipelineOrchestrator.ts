/**
 * OnboardingPipelineOrchestrator — single source of orchestration truth.
 *
 * Replaces the ad-hoc `triggerXForUser` cross-calls between onboarding
 * services with a declarative DAG + reconcile() loop. Each step:
 *   - declares its upstream deps
 *   - has a deterministic input hash for dedup
 *   - has a generation counter for cancel-and-replace concurrency
 *   - has a `provenance` field for user_authored > user_confirmed > anticipated
 *
 * The orchestrator is pure logic — runners + persistence are injected via
 * `OrchestratorDeps`. Tests build an in-memory User and pass mock runners;
 * production wires `userDb` + the existing `triggerXForUser` services.
 *
 * This file is the foundation for the Phase 2 eager DAG epic. It is
 * intentionally NOT wired up to any HTTP route in this PR — sub-task 2
 * refactors the existing onboarding services to delegate to this
 * orchestrator instead of cross-calling each other. Sub-task 3 wires the
 * FE polling hooks to read `User.steps` instead of the per-axis status
 * fields. The `useEagerPipeline` feature flag gates the entire entry
 * point so this can be merged without touching production behaviour.
 */

import crypto from "crypto";

// ──────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────

export type StepName =
  | "brandDna"
  | "icp"
  | "competitor"
  | "creativeDir"
  | "adImage"
  | "adCopy";

export type StepProvenance =
  | "anticipated"
  | "user_confirmed"
  | "user_authored";

export type StepStatus = "pending" | "running" | "ready" | "failed";

/**
 * Persisted record for a single pipeline step.
 *
 * `inputsHash` is the SHA-256 of the canonical JSON of the inputs the
 * runner started with. Used by `reconcile()` to skip a step whose stored
 * `ready` result was produced from the same inputs we'd pass now.
 *
 * `generation` is incremented on every `fire()` of the step. The runner
 * stamps its result with the generation it started at; on completion, if
 * `result.generation < user.steps[step].generation` the result is
 * discarded (some later fire is in flight or already won).
 *
 * `provenance` ranks the source of truth for the step's *output*. When
 * the user explicitly authors or confirms a step, `provenance` is
 * promoted and the orchestrator MUST NOT overwrite the output on
 * subsequent fires unless the user demotes it.
 */
export interface StepRecord<T> {
  output: T | null;
  inputsHash: string | null;
  generation: number;
  provenance: StepProvenance;
  status: StepStatus;
  failedReason?: string;
  ranAt: number;
}

/**
 * Container persisted on User.steps. Indexed by string so the
 * orchestrator can be exercised against a synthetic DAG in tests
 * without leaking test-only step names into the canonical type. The
 * production User type in `db.ts` narrows this to the six canonical
 * step names; this looser shape is fine because the orchestrator only
 * reads/writes step records by name and never iterates the keys
 * outside of `topoSort(dag)`.
 */
export type UserSteps = {
  [step: string]: StepRecord<unknown> | undefined;
};

/**
 * Subset of the User record the orchestrator reads. Kept narrow so tests
 * don't need to construct a full User type.
 */
export interface OrchestratorUser {
  userId: string;
  steps?: UserSteps;
  /**
   * Optional per-user opt-in. When true, `reconcile()` runs even if the
   * env-level `EAGER_ONBOARDING_PIPELINE_ENABLED` flag is off. Lets us
   * roll the orchestrator out per-user before flipping it globally.
   */
  useEagerPipeline?: boolean;
  /**
   * Loose pass-through bag of upstream-step inputs the runners read.
   * Each runner's `gatherInputs(user)` decides which fields it cares
   * about. Kept as `Record<string, unknown>` so this file stays
   * decoupled from the heavyweight User type in `db.ts`.
   */
  [key: string]: unknown;
}

export type Runner<I = unknown, O = unknown> = (
  ctx: RunnerContext<I>,
) => Promise<O>;

export interface RunnerContext<I> {
  userId: string;
  inputs: I;
  inputsHash: string;
  generation: number;
}

export interface DagNode {
  deps: StepName[];
  /** Pull the inputs this step needs out of the user record. */
  gatherInputs: (user: OrchestratorUser) => unknown;
  runner: Runner;
}

/**
 * Pluggable persistence + runners. Tests pass an in-memory implementation
 * keyed by userId; production wires `userDb` + the existing onboarding
 * services. Keeping these injected means the orchestrator file has zero
 * AWS imports and can run in unit-test contexts without DynamoDB stubs.
 */
export interface OrchestratorDeps {
  getUser: (userId: string) => Promise<OrchestratorUser | null>;
  /**
   * Persist the whole `steps` map. With `expected`, the write is a
   * compare-and-swap: it must only apply while the stored map is still exactly
   * `expected` (`null` = no map stored yet), and otherwise reject with
   * `code: "ConditionalCheckFailedException"`. `reconcile` claims a step that way
   * so two passes (here, or on another backend instance) cannot both start it.
   */
  updateUserSteps: (
    userId: string,
    steps: UserSteps,
    expected?: { steps: UserSteps | null },
  ) => Promise<void>;
  /**
   * Optional override for the canonical DAG. Tests pass a synthetic DAG
   * to exercise topo-sort + dependency gating without invoking real
   * runners. Production callers omit this and the default DAG is used.
   */
  dag?: Record<string, DagNode>;
  /**
   * Override the env-level flag. Default reads
   * `process.env.EAGER_ONBOARDING_PIPELINE_ENABLED === "true"`.
   */
  isEnabledGlobally?: () => boolean;
  /**
   * Cost-control circuit breaker. Default: max 15 full-chain re-fires per
   * user per hour, in-process. Production wiring will replace this with
   * a DynamoDB-backed counter so it survives process restarts.
   */
  shouldRateLimit?: (userId: string) => boolean;
  /** Override for `Date.now()` — used by tests to assert ranAt. */
  now?: () => number;
  /**
   * Override the SHA-256 hash function. Used by tests to assert that
   * dedup happens by hash equality rather than by reference equality.
   */
  hash?: (input: unknown) => string;
}

// ──────────────────────────────────────────────────────────────────────
// Pure helpers — exported for direct unit testing
// ──────────────────────────────────────────────────────────────────────

/**
 * Deterministic SHA-256 hash of a value's canonical JSON. Stable key
 * ordering so `{a:1,b:2}` and `{b:2,a:1}` hash equal.
 */
export function hashInputs(input: unknown): string {
  return crypto
    .createHash("sha256")
    .update(canonicalize(input))
    .digest("hex");
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value ?? null);
  }
  if (Array.isArray(value)) {
    return "[" + value.map((v) => canonicalize(v)).join(",") + "]";
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return (
    "{" +
    entries
      .map(([k, v]) => JSON.stringify(k) + ":" + canonicalize(v))
      .join(",") +
    "}"
  );
}

/**
 * Topologically sort a DAG. Throws on cycle. Stable: nodes at the same
 * topological depth are returned in the order they appear in the input
 * map's keys. Tests rely on this stability for assertion.
 */
export function topoSort(
  dag: Record<string, DagNode>,
): string[] {
  const result: string[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>();

  const order = Object.keys(dag);

  const visit = (node: string, path: string[]): void => {
    if (visited.has(node)) return;
    if (visiting.has(node)) {
      throw new Error(
        `Cycle detected in onboarding DAG: ${[...path, node].join(" -> ")}`,
      );
    }
    visiting.add(node);
    for (const dep of dag[node].deps) {
      if (!(dep in dag)) {
        throw new Error(
          `DAG node "${node}" depends on unknown step "${dep}"`,
        );
      }
      visit(dep, [...path, node]);
    }
    visiting.delete(node);
    visited.add(node);
    result.push(node);
  };

  for (const node of order) {
    visit(node, []);
  }
  return result;
}

/**
 * Resolve provenance precedence for a single field.
 *
 * Priority: user_authored > user_confirmed > anticipated > undefined.
 * Returns the first non-null candidate by priority, or null if all are
 * null. The orchestrator uses this when assembling step inputs from
 * upstream outputs that may have been authored manually by the user.
 */
export function resolveProvenance<T>(
  candidates: Array<{ value: T | null | undefined; provenance: StepProvenance }>,
): T | null {
  const order: StepProvenance[] = [
    "user_authored",
    "user_confirmed",
    "anticipated",
  ];
  for (const p of order) {
    const hit = candidates.find(
      (c) => c.provenance === p && c.value !== null && c.value !== undefined,
    );
    if (hit) return hit.value as T;
  }
  return null;
}

/**
 * Decide whether a step is ready to fire given current user state.
 *
 * Rules:
 * 1. If the step's stored record is `ready` AND the inputsHash matches,
 *    skip. (Hash dedup — no work to do.)
 * 2. If any upstream dep does not have a `ready` record, skip.
 *    (Upstream-not-ready — wait for them.)
 * 3. If the stored record is `running` AND the inputsHash matches,
 *    skip. (Already in flight with these exact inputs.)
 * 4. If `provenance === "user_authored"` AND status is `ready`, skip
 *    even on hash mismatch. The user's authored output is sacred.
 * 5. Otherwise — fire.
 */
export function shouldFire(
  step: string,
  user: OrchestratorUser,
  dag: Record<string, DagNode>,
  hash: (input: unknown) => string,
): { fire: false; reason: string } | { fire: true; inputsHash: string } {
  const node = dag[step];
  for (const dep of node.deps) {
    const depRec = user.steps?.[dep];
    if (!depRec || depRec.status !== "ready") {
      return { fire: false, reason: `upstream ${dep} not ready` };
    }
  }

  const inputs = node.gatherInputs(user);
  const currentHash = hash(inputs);
  const stored = user.steps?.[step];

  if (
    stored &&
    stored.status === "ready" &&
    stored.provenance === "user_authored"
  ) {
    return { fire: false, reason: "user_authored — sacred" };
  }

  if (
    stored &&
    stored.status === "ready" &&
    stored.inputsHash === currentHash
  ) {
    return { fire: false, reason: "hash matches stored ready output" };
  }

  if (
    stored &&
    stored.status === "running" &&
    stored.inputsHash === currentHash
  ) {
    return { fire: false, reason: "already running with these inputs" };
  }

  return { fire: true, inputsHash: currentHash };
}

/**
 * Decide whether a runner's completion result should be persisted.
 * Stale-generation detection — if some later `fire()` bumped the
 * generation while this runner was in flight, the result is stale and
 * must be discarded.
 */
export function isResultFresh(
  resultGeneration: number,
  storedGeneration: number,
): boolean {
  return resultGeneration >= storedGeneration;
}

// ──────────────────────────────────────────────────────────────────────
// Default DAG declaration
// ──────────────────────────────────────────────────────────────────────

/**
 * The canonical onboarding pipeline DAG.
 *
 * brandDna -> icp -> competitor
 *                 -> creativeDir -> adImage
 *                                -> adCopy
 *
 * `gatherInputs` here is intentionally minimal — runners read what they
 * need off the user record directly. The orchestrator only uses these
 * for hashing. Sub-task 2 (refactor) will wire the actual `runner`
 * functions to the existing `triggerXForUser` services.
 */
export const DEFAULT_DAG: Record<string, DagNode> = {
  brandDna: {
    deps: [],
    gatherInputs: (user) => ({
      companyUrl: user.companyUrl ?? null,
      companyName: user.companyName ?? null,
      goal: user.goal ?? null,
    }),
    runner: async () => {
      throw new Error(
        "default brandDna runner is a placeholder — wire from sub-task 2",
      );
    },
  },
  icp: {
    deps: ["brandDna"],
    gatherInputs: (user) => ({
      brandDna: (user.steps?.brandDna?.output ?? null) as unknown,
    }),
    runner: async () => {
      throw new Error(
        "default icp runner is a placeholder — wire from sub-task 2",
      );
    },
  },
  competitor: {
    deps: ["icp"],
    gatherInputs: (user) => ({
      icp: (user.steps?.icp?.output ?? null) as unknown,
    }),
    runner: async () => {
      throw new Error(
        "default competitor runner is a placeholder — wire from sub-task 2",
      );
    },
  },
  creativeDir: {
    deps: ["icp"],
    gatherInputs: (user) => ({
      brandDna: (user.steps?.brandDna?.output ?? null) as unknown,
      icp: (user.steps?.icp?.output ?? null) as unknown,
    }),
    runner: async () => {
      throw new Error(
        "default creativeDir runner is a placeholder — wire from sub-task 2",
      );
    },
  },
  adImage: {
    deps: ["creativeDir"],
    gatherInputs: (user) => ({
      creativeDir: (user.steps?.creativeDir?.output ?? null) as unknown,
    }),
    runner: async () => {
      throw new Error(
        "default adImage runner is a placeholder — wire from sub-task 2",
      );
    },
  },
  adCopy: {
    deps: ["creativeDir"],
    gatherInputs: (user) => ({
      creativeDir: (user.steps?.creativeDir?.output ?? null) as unknown,
      icp: (user.steps?.icp?.output ?? null) as unknown,
    }),
    runner: async () => {
      throw new Error(
        "default adCopy runner is a placeholder — wire from sub-task 2",
      );
    },
  },
};

// ──────────────────────────────────────────────────────────────────────
// Cost-control rate limiter
// ──────────────────────────────────────────────────────────────────────

const RATE_LIMIT_PER_HOUR = 15;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

const rateLimitState = new Map<string, number[]>();

export function defaultShouldRateLimit(
  userId: string,
  nowMs: number = Date.now(),
): boolean {
  const window = nowMs - RATE_LIMIT_WINDOW_MS;
  const fires = (rateLimitState.get(userId) ?? []).filter((t) => t >= window);
  fires.push(nowMs);
  rateLimitState.set(userId, fires);
  return fires.length > RATE_LIMIT_PER_HOUR;
}

/** Test-only — clear the rate limit state. */
export function _resetRateLimitState(): void {
  rateLimitState.clear();
}

// ──────────────────────────────────────────────────────────────────────
// Orchestrator
// ──────────────────────────────────────────────────────────────────────

const MAX_CLAIM_ATTEMPTS = 4;
const MAX_COMMIT_ATTEMPTS = 6;

export class OnboardingPipelineOrchestrator {
  private readonly deps: Required<OrchestratorDeps>;

  constructor(deps: OrchestratorDeps) {
    this.deps = {
      dag: deps.dag ?? DEFAULT_DAG,
      isEnabledGlobally:
        deps.isEnabledGlobally ??
        (() => process.env.EAGER_ONBOARDING_PIPELINE_ENABLED === "true"),
      shouldRateLimit: deps.shouldRateLimit ?? defaultShouldRateLimit,
      now: deps.now ?? (() => Date.now()),
      hash: deps.hash ?? hashInputs,
      getUser: deps.getUser,
      updateUserSteps: deps.updateUserSteps,
    };
  }

  /**
   * Record a step's terminal result. Rebuilt from the freshest stored map and
   * written as a compare-and-swap, so a sibling step another pass claimed or
   * finished in the meantime is never erased by this write; if the map moved
   * between the read and the write it is re-read and rebuilt. Returns
   * `written: false` when a newer generation of this step exists, whose result
   * this one must not overwrite.
   */
  private async commitStepRecord(
    userId: string,
    step: string,
    generation: number,
    record: StepRecord<unknown>,
    fallback: UserSteps,
  ): Promise<{ written: true; steps: UserSteps } | { written: false; latestGen: number }> {
    for (let attempt = 0; attempt < MAX_COMMIT_ATTEMPTS; attempt++) {
      const latest = await this.deps.getUser(userId);
      const latestGen = latest?.steps?.[step]?.generation ?? generation;
      if (!isResultFresh(generation, latestGen)) return { written: false, latestGen };
      const next: UserSteps = { ...(latest?.steps ?? fallback), [step]: record };
      // The final attempt is unconditional. A step left `running` is never
      // revisited (shouldFire skips a running record with unchanged inputs), so
      // failing to record a finished result would strand it for good, which is
      // worse than the tiny window in which this write could drop a sibling
      // that landed since the read above.
      const lastAttempt = attempt === MAX_COMMIT_ATTEMPTS - 1;
      try {
        await this.deps.updateUserSteps(
          userId,
          next,
          latest && !lastAttempt ? { steps: latest.steps ?? null } : undefined,
        );
        if (lastAttempt && attempt > 0) {
          console.warn("[onboardingPipelineOrchestrator] recorded a step result without the compare-and-swap after repeated conflicts", { userId, step });
        }
        return { written: true, steps: next };
      } catch (err) {
        if ((err as { code?: string })?.code !== "ConditionalCheckFailedException" || lastAttempt) throw err;
        await new Promise((resolve) => setTimeout(resolve, 15 * (attempt + 1) + Math.random() * 25));
      }
    }
    throw new Error(`could not record the result of step ${step}`);
  }

  /**
   * Drive the pipeline forward for `userId` by one pass. Reads the user,
   * walks the DAG in topological order, fires every step whose inputs
   * have changed and whose deps are ready. Each fire mutates the
   * persisted `User.steps` to flip the step into `running` (with a fresh
   * generation), then awaits the runner, then persists the terminal
   * record.
   *
   * Idempotent — calling reconcile() multiple times in a row with no
   * upstream changes is a no-op (hash dedup catches it).
   */
  async reconcile(userId: string): Promise<ReconcileReport> {
    const report: ReconcileReport = {
      userId,
      fired: [],
      skipped: [],
      gatedBy: null,
    };

    if (!this.deps.isEnabledGlobally()) {
      const user = await this.deps.getUser(userId);
      if (!user || !user.useEagerPipeline) {
        report.gatedBy = "feature flag off";
        return report;
      }
    }

    if (this.deps.shouldRateLimit(userId)) {
      report.gatedBy = "rate limit (15/hr)";
      return report;
    }

    const user = await this.deps.getUser(userId);
    if (!user) {
      report.gatedBy = "user not found";
      return report;
    }

    const order = topoSort(this.deps.dag);
    // Mutable copy of the user's step state so subsequent steps in this
    // pass see updates from earlier ones in the same reconcile() call.
    let workingSteps: UserSteps = { ...(user.steps ?? {}) };
    let workingUser: OrchestratorUser = { ...user, steps: workingSteps };
    // The map as stored, as of our last read or write of it: what a claim must
    // still find in place.
    let persisted: UserSteps | undefined = user.steps;

    for (const step of order) {
      let decision = shouldFire(
        step,
        workingUser,
        this.deps.dag,
        this.deps.hash,
      );
      if (!decision.fire) {
        report.skipped.push({ step, reason: decision.reason });
        continue;
      }
      const node = this.deps.dag[step];

      // Claim the step. Another pass may have read the same state and decided to
      // fire it too; the claim is a compare-and-swap on the stored map, so only
      // one of us starts it. A pass that loses re-reads and re-decides: usually
      // the step is now running with these exact inputs and there is nothing
      // left to do, but a conflict caused by an unrelated step's write must not
      // leave THIS step unfired, so the decision is made again, not assumed.
      let claimed: {
        inputs: unknown;
        inputsHash: string;
        generation: number;
        prev: StepRecord<unknown> | undefined;
      } | null = null;
      for (let attempt = 0; attempt < MAX_CLAIM_ATTEMPTS && !claimed; attempt++) {
        if (attempt > 0) {
          const latest = await this.deps.getUser(userId);
          if (!latest) break;
          persisted = latest.steps;
          workingSteps = { ...(latest.steps ?? {}) };
          workingUser = { ...latest, steps: workingSteps };
          decision = shouldFire(step, workingUser, this.deps.dag, this.deps.hash);
          if (!decision.fire) break;
        }
        if (!decision.fire) break;
        const inputs = node.gatherInputs(workingUser);
        const prev = workingSteps[step];
        const generation = (prev?.generation ?? 0) + 1;
        const startRecord: StepRecord<unknown> = {
          output: prev?.output ?? null,
          inputsHash: decision.inputsHash,
          generation,
          provenance: prev?.provenance ?? "anticipated",
          status: "running",
          ranAt: this.deps.now(),
        };
        const next = { ...workingSteps, [step]: startRecord };
        try {
          await this.deps.updateUserSteps(userId, next, { steps: persisted ?? null });
        } catch (err) {
          if ((err as { code?: string })?.code === "ConditionalCheckFailedException") continue;
          throw err;
        }
        workingSteps = next;
        workingUser.steps = workingSteps;
        persisted = next;
        claimed = { inputs, inputsHash: decision.inputsHash, generation, prev };
      }
      if (!claimed) {
        report.skipped.push({
          step,
          reason: decision.fire ? "claim kept losing to concurrent writes" : decision.reason,
        });
        continue;
      }
      const { inputs, inputsHash, generation, prev } = claimed;

      let output: unknown;
      let runFailure: { reason: string } | null = null;
      try {
        output = await node.runner({
          userId,
          inputs,
          inputsHash,
          generation,
        });
      } catch (err) {
        runFailure = { reason: err instanceof Error ? err.message : String(err) };
      }

      // Recording the result is deliberately outside the runner's try: a failure
      // to WRITE a finished step must not be recorded as that step having failed,
      // which would make the next pass run it again.
      const record: StepRecord<unknown> = runFailure
        ? {
            output: prev?.output ?? null,
            inputsHash,
            generation,
            provenance: prev?.provenance ?? "anticipated",
            status: "failed",
            failedReason: runFailure.reason,
            ranAt: this.deps.now(),
          }
        : {
            output,
            inputsHash,
            generation,
            provenance: prev?.provenance ?? "anticipated",
            status: "ready",
            ranAt: this.deps.now(),
          };
      // Compared against the *latest* persisted generation, not our local working
      // copy, to catch cancel-and-replace from concurrent reconcile() calls (see
      // commitStepRecord). On failure, downstream steps stay gated by the
      // upstream-not-ready check above.
      const committed = await this.commitStepRecord(userId, step, generation, record, workingSteps);
      if (!committed.written) {
        report.skipped.push({
          step,
          reason: `stale generation ${generation} < ${committed.latestGen}`,
        });
        continue;
      }
      workingSteps = committed.steps;
      workingUser.steps = workingSteps;
      persisted = workingSteps;
      report.fired.push(
        runFailure
          ? { step, generation, status: "failed", reason: runFailure.reason }
          : { step, generation, status: "ready" },
      );
    }

    return report;
  }
}

export interface ReconcileReport {
  userId: string;
  fired: Array<{
    step: string;
    generation: number;
    status: "ready" | "failed";
    reason?: string;
  }>;
  skipped: Array<{ step: string; reason: string }>;
  gatedBy: string | null;
}
