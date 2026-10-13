/**
 * ENG-2378: per-step model in Work Plans.
 *
 * A Work Plan step may carry an OPTIONAL `model` (canonical registry id; additive optional key inside the existing
 * JSON `steps` array of AW-WorkPlans: no migration, table, index or attribute). Absent = the plan's `defaultModel`
 * pin, then the account default (today's behaviour). The model is an explicit choice by a plan author (user or
 * admin) and is NEVER substituted: a step whose model cannot be served stops the plan loudly instead.
 *
 * Switch: AW-Settings row `work_plan_step_models_enabled`. ONLY the exact string 'true' (no trim, no case folding)
 * enables the feature; absent / any other value / a cold-start read failure => off, i.e. exactly today's behaviour
 * (writes drop `model`, launches do not copy it, the engine ignores it). A successful read is cached ~60s; a failed
 * refresh keeps the last-known value. Same pattern as compareSaveAlternatives.ts / compareProviderPolicy.ts.
 *
 * This module has no dependency on the service graph apart from modelPin (so it is unit-testable); the process-wide
 * switch instance lives in workPlanStepModelsInstance.ts.
 */
import {
  checkPlanDefaultModelWrite,
  resolvePlanLaunchModel,
  type ModelPinRegistry,
} from './modelPin';
import {
  buildModelUnavailableBody,
  isModelUnavailableError,
  type ModelUnavailableBody,
  type ModelUnavailableError,
} from './modelUnavailable';

export const WORK_PLAN_STEP_MODELS_SETTING = 'work_plan_step_models_enabled';

const CACHE_TTL_MS = 60_000;
/** After a failed refresh, retry sooner than a full window but not on every request. */
const ERROR_RETRY_MS = 5_000;

export interface WorkPlanStepModelsSwitchDeps {
  getSetting(name: string): Promise<{ settingValue?: unknown } | null>;
  now(): number;
  log(message: string, fields?: Record<string, unknown>): void;
}

export function createWorkPlanStepModelsSwitch(deps: WorkPlanStepModelsSwitchDeps) {
  let known = false; // last successfully read value; cold start => off
  let validUntil = 0;
  let inFlight: Promise<void> | null = null; // one refresh at a time

  async function refresh(now: number): Promise<void> {
    try {
      const row = await deps.getSetting(WORK_PLAN_STEP_MODELS_SETTING);
      known = row?.settingValue === 'true';
      validUntil = now + CACHE_TTL_MS;
    } catch (error) {
      deps.log('WorkPlanStepModels: failed to read the step-models switch; keeping last-known value (off if none)', {
        errorClass: (error as Error)?.name ?? 'Error',
        known,
      });
      validUntil = now + ERROR_RETRY_MS;
    }
  }

  async function isEnabled(): Promise<boolean> {
    const now = deps.now();
    if (now >= validUntil) {
      inFlight ??= refresh(now).finally(() => { inFlight = null; });
      await inFlight;
    }
    return known;
  }

  return { isEnabled };
}

type StepLike = { stepCount?: unknown; title?: unknown; model?: unknown; status?: unknown };

/** A step's explicit model, or undefined when it has none (absent, blank or not a string). */
export function stepModelOf(step: StepLike | null | undefined): string | undefined {
  return typeof step?.model === 'string' && step.model.trim() ? step.model.trim() : undefined;
}

/**
 * Whether any step in the list carries a `model` key at all. The write routes read the switch only when this is
 * true for the submitted or stored steps: a plan that has never had a step model behaves identically with the
 * switch on or off, so it must not pay for (or depend on) the settings read.
 */
export function anyStepCarriesModel(steps: unknown): boolean {
  return Array.isArray(steps)
    && steps.some((s) => s && typeof s === 'object' && (s as StepLike).model !== undefined && (s as StepLike).model !== null);
}

/**
 * The step the engine is working on: the first one that is neither completed nor skipped (the same definition of
 * "still pending" the autocomplete continuation uses).
 */
export function currentPendingStep<T extends { status?: unknown }>(
  workPlan: { steps?: T[] } | null | undefined,
): T | undefined {
  const steps = Array.isArray(workPlan?.steps) ? workPlan!.steps! : [];
  return steps.find((s) => s?.status !== 'completed' && s?.status !== 'skipped');
}

export type StepModelRefusal = { stepCount: number; body: ModelUnavailableBody & { stepCount: number } };

function stepNumber(step: StepLike, index: number): number {
  const n = Number(step?.stepCount);
  return Number.isFinite(n) && n > 0 ? n : index + 1;
}

/**
 * The stored step that a submitted step replaces, for the "unchanged stored value is tolerated" rule: matched by
 * title when exactly one stored step has it (a reorder renumbers but keeps titles), else by stepCount.
 */
function storedCounterpart(stored: StepLike[], step: StepLike, index: number): StepLike | undefined {
  const title = typeof step.title === 'string' ? step.title.trim().toLowerCase() : '';
  if (title) {
    const byTitle = stored.filter((s) => typeof s?.title === 'string' && s.title.trim().toLowerCase() === title);
    if (byTitle.length === 1) return byTitle[0];
  }
  const n = stepNumber(step, index);
  return stored.find((s) => Number(s?.stepCount) === n);
}

/**
 * Write-time validation of every step's model on a plan create/update, with the SAME semantics as the plan-level
 * `defaultModel` (checkPlanDefaultModelWrite): an UNCHANGED stored value is tolerated (a since-retired model must
 * not block unrelated edits); a new or changed value must be a served, selectable model, otherwise the shared
 * `model_unavailable` 422 body is returned, extended with the offending `stepCount`.
 *
 * `storedSteps` omitted (create, or the plan's launcher scope widened) = every model is validated as new.
 */
export async function checkPlanStepModelsWrite(
  isAdmin: () => Promise<boolean>,
  steps: ReadonlyArray<StepLike>,
  storedSteps?: ReadonlyArray<StepLike>,
): Promise<{ ok: true } | { ok: false; body: ModelUnavailableBody & { stepCount: number } }> {
  for (let i = 0; i < steps.length; i++) {
    const model = stepModelOf(steps[i]);
    if (!model) continue;
    const counterpart = storedSteps ? storedCounterpart([...storedSteps], steps[i], i) : undefined;
    const check = await checkPlanDefaultModelWrite(isAdmin, model, stepModelOf(counterpart));
    if (!check.ok) return { ok: false, body: { ...check.body, stepCount: stepNumber(steps[i], i) } };
  }
  return { ok: true };
}

/** Stored steps that carry a model, re-validated as a (non-admin) launcher would: used when a plan's scope widens. */
export function stepsWithModels(steps: ReadonlyArray<StepLike> | undefined): StepLike[] {
  return (steps ?? []).filter((s) => stepModelOf(s));
}

/** Thrown by launch validation: the shared ModelUnavailableError plus the step that carries the model. */
export class StepModelUnavailableError extends Error {
  readonly stepCount: number;
  readonly cause: ModelUnavailableError;
  constructor(stepCount: number, cause: ModelUnavailableError) {
    super(cause.message);
    this.name = 'StepModelUnavailableError';
    this.stepCount = stepCount;
    this.cause = cause;
  }
}

/**
 * Launch-time validation of ALL steps' models, up front and before any state is written. Each model must be served
 * and selectable by the LAUNCHING user (resolvePlanLaunchModel: no silent swap). Returns the canonical id per step
 * (keyed by index) so a launch stores canonical ids; throws StepModelUnavailableError for the first bad step.
 */
export async function resolvePlanStepModelsForLaunch(
  registry: ModelPinRegistry,
  isAdmin: () => Promise<boolean>,
  steps: ReadonlyArray<StepLike>,
): Promise<Map<number, string>> {
  const canonical = new Map<number, string>();
  for (let i = 0; i < steps.length; i++) {
    // A present-but-malformed value (e.g. a number) is refused rather than skipped: skipping it would silently run
    // the step on another model. Only absent / null / blank means "no model on this step".
    const raw = steps[i]?.model;
    if (raw === undefined || raw === null || (typeof raw === 'string' && !raw.trim())) continue;
    try {
      const resolved = await resolvePlanLaunchModel(registry, isAdmin, raw);
      if (resolved) canonical.set(i, resolved);
    } catch (error) {
      if (isModelUnavailableError(error)) throw new StepModelUnavailableError(stepNumber(steps[i], i), error);
      throw error;
    }
  }
  return canonical;
}

/** The shared 422 `model_unavailable` body for a launch refused by a step's model, extended with `stepCount`. */
export function buildStepModelUnavailableBody(
  error: StepModelUnavailableError,
  displayName?: string | null,
): ModelUnavailableBody & { stepCount: number } {
  return { ...buildModelUnavailableBody(error.cause, displayName, 'work_plan_pin'), stepCount: error.stepCount };
}

export function isStepModelUnavailableError(error: unknown): error is StepModelUnavailableError {
  return error instanceof StepModelUnavailableError;
}

/** Text shown in the chat when a plan is paused because the current step's model is no longer served. */
export function buildStepModelPausedMessage(stepCount: number, modelLabel: string): string {
  return `Step ${stepCount} uses ${modelLabel}, which is no longer available. Pick another model for this step to continue. `
    + 'The plan is paused and nothing was sent to a different model.';
}
