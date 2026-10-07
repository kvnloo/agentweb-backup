/**
 * Production wiring for the `OnboardingPipelineOrchestrator`.
 *
 * Sub-task 2 of the Eager DAG epic. The orchestrator service itself
 * (`onboardingPipelineOrchestrator.ts`, sub-task 1) is pure logic — it
 * defines the DAG and the reconcile loop but has no idea how to fetch
 * users or what the runners actually do. This file is the glue:
 *
 *   1. Wraps `userDb` for the orchestrator's `getUser` / `updateUserSteps`
 *      ports.
 *   2. Builds runners that delegate to the existing legacy
 *      `triggerXForUser` services. The runners call into the same
 *      generation logic the legacy services use, then return the resulting
 *      result so the orchestrator can stamp `User.steps[step].output`.
 *   3. Exports `reconcileForUser(userId)` — the single entry point the
 *      legacy onboarding services call when a user is on the
 *      `useEagerPipeline` flag.
 *
 * Backwards-compat:
 *   - When `useEagerPipeline` is off (the default for everyone not in the
 *     test cohort), `reconcileForUser` short-circuits inside the
 *     orchestrator (`isEnabledGlobally` + per-user opt-in check) and the
 *     legacy `triggerXForUser` cross-call cascade keeps doing its thing.
 *     Calling `reconcileForUser` for a non-flag user is a cheap no-op.
 *   - When `useEagerPipeline` is on, the orchestrator is the source of
 *     truth. The `start*ForUser` entry points still flip the per-axis
 *     status fields (legacy UI continues to read them), but instead of
 *     cross-calling each other they call `reconcileForUser` and let the
 *     orchestrator walk the DAG.
 *
 * Once Phase 2 KPIs validate and the env flag is enabled globally, a
 * follow-up cleanup PR removes the legacy cross-call paths and the
 * per-axis status fields.
 */

import {
  OnboardingPipelineOrchestrator,
  type DagNode,
  type OrchestratorUser,
  type ReconcileReport,
  type StepName,
  type UserSteps,
  DEFAULT_DAG,
} from "./onboardingPipelineOrchestrator";
import { userDb } from "./db";

// ──────────────────────────────────────────────────────────────────────
// Runners — delegate to the legacy `triggerXForUser` services.
// ──────────────────────────────────────────────────────────────────────
//
// Each runner is responsible for:
//   1. Invoking the legacy service's body (which reads inputs from User,
//      runs the LLM/Emma/etc., and writes the per-axis ready/failed patch
//      via `userDb.updateUser`).
//   2. Re-reading the user record to extract the freshly-persisted result
//      and returning it so the orchestrator stamps it into
//      `User.steps[step].output`.
//
// We deliberately keep the legacy patch writes in place (rather than
// hoisting them up to the orchestrator) so the `useEagerPipeline = false`
// path does not need to be re-derived. The orchestrator's `User.steps`
// table becomes a parallel record of truth that the FE in sub-task 3
// reads from. The legacy per-axis status fields still drive the
// non-flag UI paths.
//
// `require` (not `import`) for the legacy services to avoid circular
// imports — the legacy services will import this file once they wrap
// their cascades in the flag check.

/**
 * Re-raise a step's business failure so the orchestrator can see it (ENG-792).
 *
 * Every onboarding step service reports failure the same way — by patching
 * `<step>Status = "failed"` / `<step>Error` on the User record — and never by
 * throwing. The orchestrator only records a step as `failed` when its runner
 * throws, so without this every failed run was stamped `ready` with a null
 * output: the same "reports success, delivered nothing" shape ENG-792 is
 * about, one layer up.
 *
 * Only a failure THIS run produced counts. The DAG invokes the
 * `triggerXForUser` services directly, while the `<step>StartPatch` that
 * flips status to `running` lives in the `startXForUser` route wrappers — so
 * a stale `failed` from an earlier attempt can still be sitting on the record
 * when a fresh run begins. Attribute it via `<step>CompletedAt` (every
 * failed-patch builder stamps one): throw only when the terminal write landed
 * at or after this run started.
 *
 * When we cannot prove the failure is ours we return normally. A false
 * positive is the more expensive error here — marking `icp` failed would gate
 * both `competitor` and `creativeDir`, and everything below them.
 */
function throwIfStepFailed(
  user: Record<string, unknown> | null,
  field: string,
  startedAtMs: number,
  fallbackMessage: string,
): void {
  if (user?.[`${field}Status`] !== "failed") return;
  const completedAt = user[`${field}CompletedAt`];
  const completedMs =
    typeof completedAt === "string" ? Date.parse(completedAt) : NaN;
  if (!Number.isFinite(completedMs) || completedMs < startedAtMs) return;
  const error = user[`${field}Error`];
  throw new Error(
    typeof error === "string" && error ? error : fallbackMessage,
  );
}

/**
 * Every runner below claims its axis (atomic ConditionExpression, flips the
 * legacy `<axis>Status` field to its in-flight value) BEFORE calling the
 * legacy trigger function, mirroring `runAdImage`'s pre-existing pattern.
 *
 * ENG-2308 follow-up, caught live: these runners used to call
 * `trigger<Axis>ForUser` directly. Each trigger's own completion logic
 * (`<axis>ReadyPatch` / the `update_brand_guidelines` tool-call hook for
 * brandDna) requires the legacy status field to already be `running` (or
 * `building`) before it will persist a result — a precondition normally
 * satisfied by the `/axis/start` ROUTE (`start<Axis>ForUser`), which claims
 * first and only then either triggers directly or hands off to
 * `reconcileForUser`. A pure orchestrator-driven cascade — the whole point
 * of "eager" pipeline, firing once and letting every downstream step run on
 * its own — never went through that route for any step beyond whichever
 * one's `/axis/start` happened to be called to kick the cascade off in the
 * first place. So the trigger ran for real, produced a real result, and
 * then silently dropped it (the completion function returned null, the
 * trigger returned without writing or throwing), while the orchestrator
 * recorded the step `ready` with a `null` output anyway — and
 * `shouldFire`'s hash-match means a later reconcile pass never retries it.
 * Confirmed live end to end: brandDna, icp, and competitor each "worked" in
 * earlier testing only because the test happened to also call that axis's
 * own `/start` route manually; creativeDir (never called directly) failed
 * on every attempt, which then starved adImage (its own gate reads the
 * never-set legacy `creativeDirStatus` field).
 */

async function runBrandDna(userId: string): Promise<unknown> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const {
    claimBrandBuildRun,
    triggerBrandBuildForUser,
  } = require("./onboardingBrandBuildService");
  const startedAtMs = Date.now();
  const claimed = await claimBrandBuildRun(userId);
  if (!claimed) {
    // Lost the claim to a concurrent caller (e.g. /brand-build/start
    // itself, mid-flight). Don't run a second Emma session.
    const current = (await userDb.getUserById(userId)) as Record<string, unknown> | null;
    return current?.brandGuidelines ?? null;
  }
  await triggerBrandBuildForUser(userId);
  const user = (await userDb.getUserById(userId)) as Record<string, unknown> | null;
  throwIfStepFailed(user, "brandBuild", startedAtMs, "brand build failed");
  return user?.brandGuidelines ?? null;
}

async function runIcp(userId: string): Promise<unknown> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { claimIcpRun, triggerIcpDiscoveryForUser } = require("./onboardingIcpService");
  const startedAtMs = Date.now();
  const claimed = await claimIcpRun(userId);
  if (!claimed) {
    const current = (await userDb.getUserById(userId)) as Record<string, unknown> | null;
    return current?.icpResult ?? null;
  }
  // expectedStartedAt: this invocation's own claim, so a later reclaim's
  // zombie completion can't be mistaken for a terminal state WE published
  // (ENG-2308 review follow-up).
  await triggerIcpDiscoveryForUser(userId, {
    expectedStartedAt: (claimed as { icpStartedAt?: string }).icpStartedAt,
  });
  const user = (await userDb.getUserById(userId)) as Record<string, unknown> | null;
  throwIfStepFailed(user, "icp", startedAtMs, "ICP discovery failed");
  return user?.icpResult ?? null;
}

async function runCompetitor(userId: string): Promise<unknown> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const {
    claimCompetitorRun,
    triggerCompetitorStrategyForUser,
  } = require("./onboardingCompetitorService");
  const startedAtMs = Date.now();
  const claimed = await claimCompetitorRun(userId);
  if (!claimed) {
    const current = (await userDb.getUserById(userId)) as Record<string, unknown> | null;
    return current?.competitorResult ?? null;
  }
  await triggerCompetitorStrategyForUser(userId, {
    expectedStartedAt: (claimed as { competitorStartedAt?: string }).competitorStartedAt,
  });
  const user = (await userDb.getUserById(userId)) as Record<string, unknown> | null;
  throwIfStepFailed(user, "competitor", startedAtMs, "competitor strategy failed");
  return user?.competitorResult ?? null;
}

async function runCreativeDir(userId: string): Promise<unknown> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const {
    claimCreativeDirRun,
    triggerCreativeDirForUser,
  } = require("./onboardingCreativeDirService");
  const startedAtMs = Date.now();
  const claimed = await claimCreativeDirRun(userId);
  if (!claimed) {
    const current = (await userDb.getUserById(userId)) as Record<string, unknown> | null;
    return current?.creativeDirResult ?? null;
  }
  await triggerCreativeDirForUser(userId, {
    expectedStartedAt: (claimed as { creativeDirStartedAt?: string }).creativeDirStartedAt,
  });
  const user = (await userDb.getUserById(userId)) as Record<string, unknown> | null;
  throwIfStepFailed(user, "creativeDir", startedAtMs, "creative direction failed");
  return user?.creativeDirResult ?? null;
}

async function runAdImage(userId: string): Promise<unknown> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const {
    claimAdImageRun,
    triggerAdImageGenerationForUser,
  } = require("./onboardingAdImageService");
  const startedAtMs = Date.now();
  // Claim the axis for THIS invocation and hand the identity to the worker.
  // The orchestrator only fires a step that is not already ready/running with
  // these inputs (see shouldFire), so firing means a genuinely new run. Going
  // through the trigger without an identity would make the worker adopt
  // whatever the record names when it reads — two overlapping eager starts
  // would then share one nonce and could overwrite each other (Greptile).
  const run = await claimAdImageRun(userId);
  if (!run) {
    // Lost the claim (ENG-2308) — a concurrent caller (the legacy route, or
    // another reconcile pass) already owns a `running` run for this axis.
    // This invocation contributed nothing, which is not a failure of ITS
    // run — return whatever is currently persisted rather than launching a
    // second worker or throwing.
    const current = (await userDb.getUserById(userId)) as Record<string, unknown> | null;
    return current?.adImageResult ?? null;
  }
  await triggerAdImageGenerationForUser(userId, { run });
  const user = (await userDb.getUserById(userId)) as Record<string, unknown> | null;
  // Covers all three ad-image gates: missing logo, unfetchable logo, and
  // every variant failing. Note this does NOT gate ad copy — adCopy deps on
  // creativeDir, not adImage, so the two stay independent axes by design
  // (see adImageStatusService). What it fixes is the step record itself.
  throwIfStepFailed(user, "adImage", startedAtMs, "ad image generation failed");
  return user?.adImageResult ?? null;
}

async function runAdCopy(userId: string): Promise<unknown> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { claimAdCopyRun, triggerAdCopyForUser } = require("./onboardingAdCopyService");
  const startedAtMs = Date.now();
  const claimed = await claimAdCopyRun(userId);
  if (!claimed) {
    const current = (await userDb.getUserById(userId)) as Record<string, unknown> | null;
    return current?.adCopyResult ?? null;
  }
  await triggerAdCopyForUser(userId, {
    expectedStartedAt: (claimed as { adCopyStartedAt?: string }).adCopyStartedAt,
  });
  const user = (await userDb.getUserById(userId)) as Record<string, unknown> | null;
  throwIfStepFailed(user, "adCopy", startedAtMs, "ad copy generation failed");
  return user?.adCopyResult ?? null;
}

/**
 * Build a DAG that delegates each runner to the legacy `triggerXForUser`
 * service. Topology + `gatherInputs` are inherited from the orchestrator's
 * `DEFAULT_DAG` (sub-task 1) so the input-hashing dedup behavior is
 * identical to the test DAG used in the orchestrator's unit suite.
 *
 * Exported for tests to assert the wiring is correct without spinning up
 * an actual orchestrator instance.
 */
export const PRODUCTION_DAG: Record<StepName, DagNode> = {
  brandDna: {
    deps: DEFAULT_DAG.brandDna.deps,
    gatherInputs: DEFAULT_DAG.brandDna.gatherInputs,
    runner: async ({ userId }) => runBrandDna(userId),
  },
  icp: {
    deps: DEFAULT_DAG.icp.deps,
    gatherInputs: DEFAULT_DAG.icp.gatherInputs,
    runner: async ({ userId }) => runIcp(userId),
  },
  competitor: {
    deps: DEFAULT_DAG.competitor.deps,
    gatherInputs: DEFAULT_DAG.competitor.gatherInputs,
    runner: async ({ userId }) => runCompetitor(userId),
  },
  creativeDir: {
    deps: DEFAULT_DAG.creativeDir.deps,
    gatherInputs: DEFAULT_DAG.creativeDir.gatherInputs,
    runner: async ({ userId }) => runCreativeDir(userId),
  },
  adImage: {
    deps: DEFAULT_DAG.adImage.deps,
    gatherInputs: DEFAULT_DAG.adImage.gatherInputs,
    runner: async ({ userId }) => runAdImage(userId),
  },
  adCopy: {
    deps: DEFAULT_DAG.adCopy.deps,
    gatherInputs: DEFAULT_DAG.adCopy.gatherInputs,
    runner: async ({ userId }) => runAdCopy(userId),
  },
};

// ──────────────────────────────────────────────────────────────────────
// Singleton orchestrator + entry point
// ──────────────────────────────────────────────────────────────────────

let _orchestrator: OnboardingPipelineOrchestrator | null = null;

function getOrchestrator(): OnboardingPipelineOrchestrator {
  if (_orchestrator) return _orchestrator;
  _orchestrator = new OnboardingPipelineOrchestrator({
    dag: PRODUCTION_DAG,
    getUser: async (userId): Promise<OrchestratorUser | null> => {
      const u = (await userDb.getUserById(userId)) as
        | (Record<string, unknown> & { steps?: UserSteps; useEagerPipeline?: boolean })
        | null;
      if (!u) return null;
      // The orchestrator's `OrchestratorUser` is `Record<string, unknown>` +
      // `userId/steps/useEagerPipeline`. The User record from db.ts has
      // those fields plus a lot more — passing it as-is is fine because
      // `gatherInputs` reads through arbitrary keys.
      return {
        userId,
        steps: u.steps,
        useEagerPipeline: u.useEagerPipeline,
        ...u,
      };
    },
    updateUserSteps: async (userId, steps) => {
      await userDb.updateUser(userId, { steps } as Partial<
        Parameters<typeof userDb.updateUser>[1]
      >);
    },
  });
  return _orchestrator;
}

/**
 * Test-only — drop the cached orchestrator instance so tests that mock
 * `userDb` after this module is first imported can re-build with the
 * mocked deps. Production code never calls this.
 */
export function _resetOrchestratorForTests(): void {
  _orchestrator = null;
  _inFlightReconciles.clear();
}

/**
 * Per-user in-process dedup for concurrent `reconcileForUser` calls
 * (ENG-2308 review follow-up, confirmed by direct reproduction — see
 * PR discussion). `reconcile()` reads `User.steps` ONCE at the top of
 * its topo walk into a local `workingSteps` copy, then fires every
 * step that's ready in that single pass. Six different call sites
 * (every axis's `start*ForUser` on the eager branch, plus the
 * brand-build route) each fire `reconcileForUser` independently with
 * no mutual exclusion between THEM — only the per-axis DynamoDB claims
 * arbitrate who actually runs real work for a given axis.
 *
 * That claim only protects the *legacy* status field. It does nothing
 * for the orchestrator's OWN bookkeeping: if two reconcile() passes
 * both start before either has persisted anything, both decide to
 * fire the same step (same starting generation, since both compute
 * `(prev?.generation ?? 0) + 1` from the same pre-write read), one
 * loses the per-axis claim and resolves fast with a null/placeholder
 * output, and that pass's OWN topo walk then treats the step as
 * "ready" with that null output and proceeds to fire the NEXT step for
 * real using it — a genuine extra LLM call with degraded context, the
 * exact class of waste/corruption this ticket exists to eliminate, one
 * layer up. Reproduced directly against the real orchestrator with two
 * concurrent `reconcile()` calls for the same user.
 *
 * Fix: collapse concurrent calls for the same userId into the ONE
 * already-in-flight `reconcile()` promise instead of starting a second
 * walk. That walk will itself fire whatever the second caller wanted
 * fired (reconcile() always walks the full topo order), so nothing is
 * lost — only the redundant, racy second pass is. In-process only,
 * same scoping as `defaultShouldRateLimit`'s in-memory counter above
 * (its own docstring already defers cross-instance durability to a
 * follow-up); this does not protect against two different backend
 * instances reconciling the same user at the same instant.
 */
const _inFlightReconciles = new Map<string, Promise<ReconcileReport | null>>();

/**
 * Drive the eager DAG forward for `userId`. Cheap no-op when neither the
 * env flag nor the user opt-in is set — the orchestrator gates internally.
 *
 * Errors are swallowed and logged so this can be called fire-and-forget
 * from anywhere in the legacy onboarding services.
 */
export async function reconcileForUser(
  userId: string,
): Promise<ReconcileReport | null> {
  const existing = _inFlightReconciles.get(userId);
  if (existing) return existing;

  const run = (async () => {
    try {
      return await getOrchestrator().reconcile(userId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.error("[onboardingOrchestratorWiring] reconcile failed", {
        userId,
        err: msg,
      });
      return null;
    }
  })();

  _inFlightReconciles.set(userId, run);
  try {
    return await run;
  } finally {
    _inFlightReconciles.delete(userId);
  }
}

/**
 * Returns true when the user record indicates the eager DAG pipeline is
 * active for this user. Reads the env flag first, then falls back to the
 * per-user opt-in. Used by the legacy `triggerXForUser` services to gate
 * their cross-call cascades:
 *
 *   if (!isEagerPipelineActiveFor(user)) { ...legacy cascade... }
 *
 * Pure function over a User-shaped object — no DB read. Callers pass the
 * user record they already have in scope.
 */
export function isEagerPipelineActiveFor(
  user: { useEagerPipeline?: boolean } | null | undefined,
): boolean {
  if (process.env.EAGER_ONBOARDING_PIPELINE_ENABLED === "true") return true;
  return Boolean(user?.useEagerPipeline);
}
