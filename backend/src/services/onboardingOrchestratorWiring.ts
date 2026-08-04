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

async function runBrandDna(userId: string): Promise<unknown> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { triggerBrandBuildForUser } = require("./onboardingBrandBuildService");
  await triggerBrandBuildForUser(userId);
  const user = (await userDb.getUserById(userId)) as Record<string, unknown> | null;
  return user?.brandGuidelines ?? null;
}

async function runIcp(userId: string): Promise<unknown> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { triggerIcpDiscoveryForUser } = require("./onboardingIcpService");
  await triggerIcpDiscoveryForUser(userId);
  const user = (await userDb.getUserById(userId)) as Record<string, unknown> | null;
  return user?.icpResult ?? null;
}

async function runCompetitor(userId: string): Promise<unknown> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const {
    triggerCompetitorStrategyForUser,
  } = require("./onboardingCompetitorService");
  await triggerCompetitorStrategyForUser(userId);
  const user = (await userDb.getUserById(userId)) as Record<string, unknown> | null;
  return user?.competitorResult ?? null;
}

async function runCreativeDir(userId: string): Promise<unknown> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { triggerCreativeDirForUser } = require("./onboardingCreativeDirService");
  await triggerCreativeDirForUser(userId);
  const user = (await userDb.getUserById(userId)) as Record<string, unknown> | null;
  return user?.creativeDirResult ?? null;
}

async function runAdImage(userId: string): Promise<unknown> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const {
    triggerAdImageGenerationForUser,
  } = require("./onboardingAdImageService");
  await triggerAdImageGenerationForUser(userId);
  const user = (await userDb.getUserById(userId)) as Record<string, unknown> | null;
  // ENG-792: the service signals every business failure by patching
  // adImageStatus (missing logo, unfetchable logo, all variants failed) and
  // never by throwing. The orchestrator only records a step as `failed` when
  // its runner throws, so without this re-raise the DAG stamped adImage
  // "ready" with a null output — the same "reports success, delivered
  // nothing" shape this ticket is about, one layer up.
  //
  // This does NOT gate ad copy: adCopy deps on creativeDir, not adImage, so
  // the two remain independent axes by design (see adImageStatusService).
  // What it fixes is the step record itself — a failed run is now visible as
  // failed, with its reason, instead of masquerading as a ready step whose
  // output happens to be null.
  if (user?.adImageStatus === "failed") {
    throw new Error(
      typeof user.adImageError === "string" && user.adImageError
        ? user.adImageError
        : "ad image generation failed",
    );
  }
  return user?.adImageResult ?? null;
}

async function runAdCopy(userId: string): Promise<unknown> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { triggerAdCopyForUser } = require("./onboardingAdCopyService");
  await triggerAdCopyForUser(userId);
  const user = (await userDb.getUserById(userId)) as Record<string, unknown> | null;
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
}

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
