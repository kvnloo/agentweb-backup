import type { WorkPlanStep } from "./workPlanService";

/**
 * The step fields a submitted work plan can actually persist. The write routes
 * rebuild every step from this list rather than storing the caller's object, so
 * anything absent here is discarded — historically on a silent 200/201, which
 * has now bitten us three times (userInstructions, the snake_case
 * `required_function_calls` alias, and expectedAssetCount — ENG-889).
 * normalizeWorkPlanSteps is the single place that list lives.
 *
 * Deliberately its own module rather than part of workPlanService: this is a
 * pure function, and ~18 route tests `jest.mock` the service wholesale, which
 * would blank out an export living there.
 */
const WORK_PLAN_STEP_FIELDS = new Set([
  'stepCount',
  'title',
  'description',
  'userInstructions',
  'requiredFunctionCalls',
  'skillIds',
  'expectedAssetCount',
]);

export interface NormalizedWorkPlanSteps {
  steps: WorkPlanStep[];
  /** One entry per step that carried fields we did not store, naming them.
   *  Surfaced in the write routes' responses so a caller — including an LLM
   *  driving the MCP tool — sees the drop instead of guessing (ENG-889). */
  warnings: string[];
}

/**
 * Project submitted steps onto the storable field set, reporting what was
 * discarded. Shared by the admin and user create/update routes so the field
 * list cannot drift between them again.
 */
export function normalizeWorkPlanSteps(steps: any[]): NormalizedWorkPlanSteps {
  const warnings: string[] = [];

  const normalized = steps.map((raw: any, i: number) => {
    const s = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};

    const ignored = Object.keys(s).filter((key) => !WORK_PLAN_STEP_FIELDS.has(key));
    if (ignored.length > 0) {
      const names = ignored.map((key) => `'${key}'`).join(', ');
      warnings.push(
        `step ${i + 1}: ignored unrecognized field${ignored.length > 1 ? 's' : ''} ${names}`,
      );
    }

    // A wrong-shaped value is worse than a missing one: it stores without
    // complaint and every consumer then skips it. setWorkPlanStatus gates on
    // `typeof expectedAssetCount === 'number'`, so "18" would save and the gate
    // would never fire — the silent no-op this issue is about. Report and drop.
    const listOf = (key: 'requiredFunctionCalls' | 'skillIds') => {
      const value = s[key];
      if (value === undefined) return [];
      if (!Array.isArray(value)) {
        warnings.push(`step ${i + 1}: ignored ${key} — expected an array`);
        return [];
      }
      // Both lists are looked up by string — a tool name or a skill id. A
      // non-string entry can never match, so keeping it would just be another
      // value that stores cleanly and is then skipped downstream.
      const usable = value.filter((entry: unknown) => typeof entry === 'string' && entry !== '');
      if (usable.length !== value.length) {
        warnings.push(
          `step ${i + 1}: dropped ${value.length - usable.length} non-string entries from ${key}`,
        );
      }
      return usable;
    };

    const assetCount = s.expectedAssetCount;
    let keepAssetCount = assetCount !== undefined;
    if (assetCount !== undefined
      && (typeof assetCount !== 'number' || !Number.isFinite(assetCount) || assetCount < 0)) {
      warnings.push(`step ${i + 1}: ignored expectedAssetCount — expected a non-negative number`);
      keepAssetCount = false;
    }

    return {
      stepCount: s.stepCount || i + 1,
      title: s.title || `Step ${i + 1}`,
      description: s.description,
      ...(s.userInstructions !== undefined && { userInstructions: s.userInstructions }),
      requiredFunctionCalls: listOf('requiredFunctionCalls'),
      skillIds: listOf('skillIds'),
      ...(keepAssetCount && { expectedAssetCount: assetCount }),
    };
  });

  return { steps: normalized, warnings };
}
