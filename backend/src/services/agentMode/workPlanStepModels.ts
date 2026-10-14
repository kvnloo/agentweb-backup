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
  let everRead = false; // a read has succeeded at least once (otherwise the state is UNKNOWN, not "off")
  let validUntil = 0;
  let inFlight: Promise<void> | null = null; // one refresh at a time

  async function refresh(now: number): Promise<void> {
    try {
      const row = await deps.getSetting(WORK_PLAN_STEP_MODELS_SETTING);
      known = row?.settingValue === 'true';
      everRead = true;
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

  /** 'unknown' = no read has ever succeeded (cold-start settings outage); NOT the same as a definite 'off'. */
  async function getState(): Promise<'on' | 'off' | 'unknown'> {
    await isEnabled();
    return everRead ? (known ? 'on' : 'off') : 'unknown';
  }

  /**
   * Whether a STORED step model must be honoured by the engine / launch: on, or unknown. Only a definite 'off'
   * ignores it, so a settings outage can never silently swap a user's explicit choice for another model.
   */
  async function shouldHonor(): Promise<boolean> {
    return (await getState()) !== 'off';
  }

  return { isEnabled, getState, shouldHonor };
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
 * title when exactly one UNCLAIMED stored step has it (a reorder renumbers but keeps titles), else by stepCount. A
 * stored step is the counterpart of at most one submitted step (`claimed`), so a model copied onto a second step is new.
 */
function storedCounterpart(stored: StepLike[], step: StepLike, index: number, claimed: Set<StepLike>): StepLike | undefined {
  const free = stored.filter((s) => !claimed.has(s));
  const title = typeof step.title === 'string' ? step.title.trim().toLowerCase() : '';
  if (title) {
    const byTitle = free.filter((s) => typeof s?.title === 'string' && s.title.trim().toLowerCase() === title);
    if (byTitle.length === 1) return byTitle[0];
  }
  const n = stepNumber(step, index);
  return free.find((s) => Number(s?.stepCount) === n);
}

const normTitle = (value: unknown): string => (typeof value === 'string' ? value.trim().toLowerCase() : '');

const CONTENT_KEYS = ['description', 'userInstructions', 'requiredFunctionCalls', 'skillIds'] as const;
const emptyish = (v: unknown) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
/** A step with nothing but a (new) title cannot be told apart from a different empty step: it never inherits a RENAME match. */
const hasStepContent = (step: StepLike): boolean => CONTENT_KEYS.some((k) => !emptyish((step as any)?.[k]));
/** A rename keeps what the step says; a replacement does not. Compared on the descriptive fields only. */
function sameStepContent(a: StepLike, b: StepLike): boolean {
  return CONTENT_KEYS.every((k) => {
    const x = (a as any)?.[k];
    const y = (b as any)?.[k];
    return (emptyish(x) && emptyish(y)) || JSON.stringify(x) === JSON.stringify(y);
  });
}

/**
 * Carry the STORED model of the matching existing step onto each incoming step that does not carry one, so a write
 * can never erase a stored model by omission. A wrong model is worse than none, so a step only inherits a model when
 * the match is unambiguous; in doubt it gets none:
 *  1. by title: a title held by exactly one stored step AND one incoming step matches that pair; when a title is
 *     duplicated (either side) a step matches the stored step with the same title at the SAME stepCount, nothing else;
 *  2. a rename: only when the incoming list has exactly as many steps as the stored one, exactly ONE incoming and
 *     ONE stored step are left unmatched at the same stepCount, and they say the same thing (description,
 *     instructions, required calls, skills: a replacement does not). With a different count (an insert or delete around
 *     the rename), several unmatched steps or changed content, nothing is bound by position.
 * Each stored step is used at most once. `allow(i)` lets the caller exempt steps (e.g. an explicit clear); exempt and
 * model-carrying steps still take part in the matching so they cannot lend their counterpart's model to another step.
 */
export function carryStoredStepModels<T extends StepLike>(
  incoming: ReadonlyArray<T>,
  stored: ReadonlyArray<StepLike> | undefined,
  allow: (index: number) => boolean = () => true,
): T[] {
  const storedSteps = [...(stored ?? [])];
  if (!storedSteps.some((s) => stepModelOf(s))) return [...incoming];

  const matchOf = new Map<number, number>(); // incoming index -> stored index
  const claimed = new Set<number>();
  const claim = (i: number, j: number) => { matchOf.set(i, j); claimed.add(j); };
  const count = <U extends StepLike>(list: ReadonlyArray<U>, title: string) => list.filter((x) => normTitle(x?.title) === title).length;

  incoming.forEach((step, i) => {
    const title = normTitle(step?.title);
    if (!title) return;
    const hits = storedSteps.map((s, j) => ({ s, j })).filter(({ s, j }) => !claimed.has(j) && normTitle(s?.title) === title);
    if (hits.length === 0) return;
    if (hits.length === 1 && count(storedSteps, title) === 1 && count(incoming, title) === 1) {
      claim(i, hits[0].j);
      return;
    }
    const n = Number(step?.stepCount);
    // Duplicated title: only the same-numbered stored step that also says the same thing (a shifted duplicate, e.g. after
    // a delete or insert, is a different step). Fully identical duplicates cannot be told apart; they match by number.
    const sameSlot = hits.find(({ s }) => Number(s?.stepCount) === n && sameStepContent(step, s));
    if (sameSlot) claim(i, sameSlot.j);
  });

  // A blank-titled incoming step (partial payload) can only be identified by its number.
  incoming.forEach((step, i) => {
    if (matchOf.has(i) || normTitle(step?.title)) return;
    const n = Number(step?.stepCount);
    const j = storedSteps.findIndex((s, k) => !claimed.has(k) && Number(s?.stepCount) === n);
    if (j !== -1) claim(i, j);
  });

  // Rename in place: exactly one step on each side is left over (which also means the counts are equal and nothing
  // else was inserted, deleted or renamed), at the same number, saying the same thing.
  {
    const freeIncoming = incoming.map((_, i) => i).filter((i) => !matchOf.has(i));
    const freeStored = storedSteps.map((_, j) => j).filter((j) => !claimed.has(j));
    if (freeIncoming.length === 1 && freeStored.length === 1
      && Number(incoming[freeIncoming[0]]?.stepCount) === Number(storedSteps[freeStored[0]]?.stepCount)
      && hasStepContent(incoming[freeIncoming[0]])
      && sameStepContent(incoming[freeIncoming[0]], storedSteps[freeStored[0]])) {
      claim(freeIncoming[0], freeStored[0]);
    }
  }

  return incoming.map((step, i) => {
    if (!allow(i) || stepModelOf(step) || (step as StepLike)?.model === '') return step;
    const j = matchOf.get(i);
    const model = j === undefined ? undefined : stepModelOf(storedSteps[j]);
    return model ? { ...step, model } : step;
  });
}

/**
 * The model that belongs to the ORIGINAL step a modified step stands for: the original at the same number when its
 * title is unchanged, else the one original step with that title (a step that moved), else none (a new or retitled
 * step starts with no model; it is never inherited from whatever used to sit in the slot).
 */
export function modelBoundToStep(
  originals: ReadonlyArray<StepLike>,
  stepCount: number,
  title: unknown,
): string | undefined {
  const t = normTitle(title);
  if (!t) return undefined;
  const slot = originals.find((s) => Number(s?.stepCount) === stepCount);
  if (slot && normTitle(slot.title) === t) return stepModelOf(slot);
  const hits = originals.filter((s) => normTitle(s?.title) === t);
  return hits.length === 1 ? stepModelOf(hits[0]) : undefined;
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
  const stored = storedSteps ? [...storedSteps] : [];
  const claimed = new Set<StepLike>();
  const counterpartOf = new Map<number, StepLike>();
  // Pass 1: a step that still carries exactly the model of a same-titled stored step claims it first, so a copy of that
  // model on another step (or an earlier step with a different model) cannot steal the "unchanged" tolerance.
  steps.forEach((step, i) => {
    const model = stepModelOf(step);
    if (!model) return;
    const t = normTitle(step.title);
    const hit = stored.find((s) => !claimed.has(s) && stepModelOf(s) === model && (!t || normTitle(s.title) === t));
    if (hit) { claimed.add(hit); counterpartOf.set(i, hit); }
  });
  // Pass 2: everything else is matched by title, then number, against what is still unclaimed.
  steps.forEach((step, i) => {
    if (!stepModelOf(step) || counterpartOf.has(i)) return;
    const hit = storedCounterpart(stored, step, i, claimed);
    if (hit) { claimed.add(hit); counterpartOf.set(i, hit); }
  });
  for (let i = 0; i < steps.length; i++) {
    const model = stepModelOf(steps[i]);
    if (!model) continue;
    const check = await checkPlanDefaultModelWrite(isAdmin, model, stepModelOf(counterpartOf.get(i)));
    if (!check.ok) return { ok: false, body: { ...check.body, stepCount: stepNumber(steps[i], i) } };
  }
  return { ok: true };
}

/**
 * Validation of a plan's STORED step models as a NON-admin launcher would face them, run before the plan becomes
 * available to non-admins (submit for review, approve). Only while per-step models are honoured, and only for plans
 * that carry one. Same 422 body as a write (`model_unavailable` + `stepCount`).
 */
export async function checkStoredStepModelsForPublic(
  steps: unknown,
  honor: () => Promise<boolean>,
): Promise<{ ok: true } | { ok: false; body: ModelUnavailableBody & { stepCount: number } }> {
  if (!anyStepCarriesModel(steps) || !(await honor())) return { ok: true };
  return checkPlanStepModelsWrite(async () => false, steps as StepLike[]);
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
  return `Step ${stepCount} uses ${modelLabel}, which is no longer available. Choose another model in the model picker and send again to resume this step. `
    + 'The plan is paused and nothing was sent to a different model.';
}
