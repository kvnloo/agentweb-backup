/**
 * ENG-2378: helpers for the per-step model picker in the admin work-plan editor.
 *
 * The backend decides everything (the `work_plan_step_models_enabled` switch, whether a model is served and
 * selectable); the editor only offers the choice when GET /api/agent-mode/model-options says
 * `workPlanStepModelsEnabled`, and never invents or swaps a model.
 */

/** Suffix shown on a stored step model that is no longer in the served list. */
export const STEP_MODEL_UNAVAILABLE_LABEL = "unavailable";

/** True when a step already stores a model that the served list no longer contains (e.g. retired). */
export function isStoredStepModelUnavailable(
  storedModel: string | undefined,
  supportedModels: readonly string[],
): boolean {
  return !!storedModel && !supportedModels.includes(storedModel);
}

export interface StepModelOption {
  value: string;
  label: string;
  /** A stored-but-retired model stays visible (so the editor never silently blanks it) but cannot be re-picked. */
  disabled: boolean;
}

/** Options for a step's model <Select>: the served models, plus the stored one if it is no longer served. */
export function stepModelOptions(
  storedModel: string | undefined,
  supportedModels: readonly string[],
): StepModelOption[] {
  const options: StepModelOption[] = supportedModels.map((m) => ({ value: m, label: m, disabled: false }));
  if (storedModel && isStoredStepModelUnavailable(storedModel, supportedModels)) {
    options.unshift({ value: storedModel, label: `${storedModel} (${STEP_MODEL_UNAVAILABLE_LABEL})`, disabled: true });
  }
  return options;
}

/** The hint from GET /api/agent-mode/model-options; anything but a literal `true` is off. */
export function readStepModelsHint(data: unknown): boolean {
  return (data as { workPlanStepModelsEnabled?: unknown } | null | undefined)?.workPlanStepModelsEnabled === true;
}
