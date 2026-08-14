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

/* ─── Work-plan step guards (ENG-1221) ──────────────────────────────────────
 *
 * These moved here from the MCP tool file. They were private to
 * `manage_predefined_work_plan`, which meant the destructive-update guard
 * lived one layer ABOVE the endpoint that performs the write — so any caller
 * reaching `PUT /api/admin/work-plans/:planId` directly got no protection at
 * all, and a partial steps array silently erased every omitted field.
 *
 * That is not theoretical: it destroyed all ten step descriptions on the
 * Google Pre-Launch Gate plan on 2026-08-14, returning HTTP 200 with a null
 * diff. Shared here so the route and the tool enforce the SAME rules.
 * ────────────────────────────────────────────────────────────────────────── */

function normalizeStepTitle(value: unknown): string {
  return String(value ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * The step fields worth guarding. The admin route rebuilds every step from a
 * fixed field list and defaults these to empty (services/workPlanSteps.ts), so
 * re-sending a step without them blanks whatever was stored — at an unchanged
 * step count, which no length check can see.
 */
const STEP_CONTENT_FIELDS = [
  'description',
  'requiredFunctionCalls',
  'skillIds',
  'userInstructions',
  'expectedAssetCount',
] as const;

function isEmptyStepValue(value: unknown): boolean {
  return value === undefined || value === null || value === ''
    || (Array.isArray(value) && value.length === 0);
}

/**
 * Locate `probe`'s counterpart in `steps`. Title first, then position: a caller
 * reordering a plan renumbers the steps but keeps their titles, so matching on
 * stepCount first would pair up the wrong two.
 */
function findStepIndex(steps: any[], probe: any): number {
  if (probe.title !== undefined) {
    const title = normalizeStepTitle(probe.title);
    const matches = steps.filter((s: any) => normalizeStepTitle(s.title) === title);
    // A title shared by two steps identifies neither — fall through to position
    // rather than pairing everything against the first one.
    if (matches.length === 1) return steps.indexOf(matches[0]);
  }
  if (probe.stepCount === undefined || probe.stepCount === null) return -1;
  return steps.findIndex((s: any) => Number(s.stepCount) === Number(probe.stepCount));
}

/**
 * Titles in `from` with no counterpart left in `to`. Counts occurrences instead
 * of testing set membership, so dropping one of two steps that share a title is
 * still reported as a drop.
 */
function diffStepTitles(from: any[], to: any[]): any[] {
  const available = new Map<string, number>();
  for (const step of to) {
    const title = normalizeStepTitle(step.title);
    available.set(title, (available.get(title) || 0) + 1);
  }
  const unmatched: any[] = [];
  for (const step of from) {
    const title = normalizeStepTitle(step.title);
    const remaining = available.get(title) || 0;
    if (remaining > 0) available.set(title, remaining - 1);
    else unmatched.push(step.title);
  }
  return unmatched;
}

/**
 * Incoming merge steps that name no stepCount and whose title matches more than
 * one existing step. Amending "whichever came first" is a silent wrong-step
 * edit, so the caller is asked to disambiguate instead.
 */
export function findAmbiguousMergeTargets(existingSteps: any[], incomingSteps: any[]) {
  const ambiguous: { title: any; matchingStepCounts: any[] }[] = [];
  for (const incoming of incomingSteps) {
    // A stepCount only settles the target if it names a step that exists.
    // mergeWorkPlanSteps falls back to the title otherwise, so a stale or
    // invented count must not buy a pass through this check.
    const named = incoming.stepCount !== undefined && incoming.stepCount !== null
      && existingSteps.some((s: any) => Number(s.stepCount) === Number(incoming.stepCount));
    if (named) continue;
    if (incoming.title === undefined) continue;
    const title = normalizeStepTitle(incoming.title);
    const matches = existingSteps.filter((s: any) => normalizeStepTitle(s.title) === title);
    if (matches.length > 1) {
      ambiguous.push({ title: incoming.title, matchingStepCounts: matches.map((s: any) => s.stepCount) });
    }
  }
  return ambiguous;
}

/**
 * Two incoming entries that resolve to the same existing step. One request
 * saying both "rename step 1" and "amend the step titled <its old name>" is a
 * contradiction; applying them in array order silently lets the later one undo
 * the earlier, which is the kind of quiet resolution this tool no longer does.
 */
export function findConflictingMergeTargets(existingSteps: any[], incomingSteps: any[]) {
  const byIndex = new Map<number, any[]>();
  for (const { index, incoming } of resolveMergeTargets(existingSteps, incomingSteps)) {
    if (index === -1) continue;
    byIndex.set(index, [...(byIndex.get(index) || []), incoming]);
  }
  return [...byIndex.entries()]
    .filter(([, entries]) => entries.length > 1)
    .map(([index, entries]) => ({
      stepCount: existingSteps[index]?.stepCount,
      title: existingSteps[index]?.title,
      entries: entries.length,
    }));
}

/**
 * Fields a replace would blank on steps the caller plainly meant to keep. A
 * step with no counterpart at all is skipped: that is a removal or a rewrite,
 * which the count guard and the dropped-titles diff already report.
 */
export function findStepContentLoss(before: any[], after: any[]) {
  const losses: { stepCount: any; title: any; fields: string[] }[] = [];
  for (const existing of before) {
    const index = findStepIndex(after, existing);
    if (index === -1) continue;
    const fields = STEP_CONTENT_FIELDS.filter(
      (field) => !isEmptyStepValue(existing[field]) && isEmptyStepValue(after[index][field]),
    );
    if (fields.length > 0) {
      losses.push({ stepCount: existing.stepCount, title: existing.title, fields: [...fields] });
    }
  }
  return losses;
}

/** Apply the caller-supplied fields of `incoming` on top of an existing step. */
function mergeWorkPlanStep(existing: any, incoming: any): any {
  const merged = { ...existing };
  for (const [key, value] of Object.entries(incoming)) {
    // stepCount only selects which step to amend. Copying it through would
    // renumber — and could duplicate — positions whenever the match came from
    // the title instead.
    if (key === 'stepCount') continue;
    // A model emits null for a field it is not setting (ENG-889), so treating
    // null as a value would blank an existing field in what is meant to be the
    // non-destructive mode.
    if (value === undefined || value === null) continue;
    merged[key] = value;
  }
  return merged;
}

/**
 * Resolve each incoming step to the index it amends, or -1 to append.
 *
 * Deliberately stepCount-before-title, the opposite of findStepIndex: here the
 * caller has explicitly named the step to amend, and the schema says so.
 * findStepIndex infers identity across two full arrays with no such selector.
 *
 * A shared title resolves to nothing rather than to the first match — the same
 * rule findAmbiguousMergeTargets pre-checks, kept here so the two cannot drift.
 */
function resolveMergeTargets(existingSteps: any[], incomingSteps: any[]) {
  return incomingSteps.map((incoming: any) => {
    const targetCount = incoming.stepCount;
    if (targetCount !== undefined && targetCount !== null) {
      const byCount = existingSteps.findIndex((s: any) => Number(s.stepCount) === Number(targetCount));
      if (byCount !== -1) return { index: byCount, incoming };
    }
    if (incoming.title !== undefined) {
      const title = normalizeStepTitle(incoming.title);
      const matches = existingSteps
        .map((s: any, i: number) => ({ s, i }))
        .filter(({ s }: any) => normalizeStepTitle(s.title) === title);
      if (matches.length === 1) return { index: matches[0].i, incoming };
    }
    return { index: -1, incoming };
  });
}

/**
 * Merge partial steps into the plan's current steps. Never removes a step.
 *
 * Targets are resolved for ALL entries first, against the plan as it was read.
 * Resolving during application would read a half-mutated array, so one request
 * could rename a step and then fail to find it for a later, already-validated
 * entry — turning an amendment into an append, and making the result depend on
 * the order the entries happened to arrive in. Resolution and the ambiguity
 * pre-check now share one frame of reference.
 */
export function mergeWorkPlanSteps(existingSteps: any[], incomingSteps: any[]): any[] {
  const merged = existingSteps.map((s: any) => ({ ...s }));

  for (const { index, incoming } of resolveMergeTargets(existingSteps, incomingSteps)) {
    if (index === -1) {
      merged.push(mergeWorkPlanStep({ stepCount: merged.length + 1 }, incoming));
    } else {
      merged[index] = mergeWorkPlanStep(merged[index], incoming);
    }
  }

  return merged;
}

/** Diff summary returned to the caller so step removals can never go unnoticed. */
export function summarizeStepChange(before: any[], after: any[], mode: 'merge' | 'replace') {
  const contentLoss = findStepContentLoss(before, after);
  return {
    mode,
    stepsBefore: before.length,
    stepsAfter: after.length,
    stepsRemoved: Math.max(0, before.length - after.length),
    droppedStepTitles: diffStepTitles(before, after),
    addedStepTitles: diffStepTitles(after, before),
    // Omitted rather than empty so a clean update's summary stays quiet.
    ...(contentLoss.length > 0 && { stepContentLoss: contentLoss }),
  };
}
