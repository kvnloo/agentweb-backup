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
 * Does `candidate` carry through every populated content field of `existing`,
 * unchanged? Used to tell a renamed step from a different step wearing its
 * number — the one distinction position alone cannot make.
 */
function preservesContent(existing: any, candidate: any): boolean {
  return STEP_CONTENT_FIELDS.every((field) => {
    if (isEmptyStepValue(existing[field])) return true;
    return JSON.stringify(existing[field]) === JSON.stringify(candidate?.[field]);
  });
}

/**
 * Pair every step in `before` with its counterpart in `after`, as indices into
 * `after` (-1 where there is none).
 *
 * Title first, then stepCount: a caller reordering a plan renumbers the steps
 * but keeps their titles, so matching on stepCount first would pair up the
 * wrong two. A rename that stays in place still pairs, via the second pass.
 *
 * Each `after` entry can be claimed once. Without that, a step that was renamed
 * AND moved matches no title and then falls through to a stepCount now held by
 * a DIFFERENT incoming step — so its erased fields get compared against that
 * other step's intact ones and the loss is reported as none.
 */
function pairSteps(before: any[], after: any[]): number[] {
  const pairs: number[] = new Array(before.length).fill(-1);
  const claimed = new Set<number>();

  before.forEach((step: any, i: number) => {
    if (step.title === undefined) return;
    const title = normalizeStepTitle(step.title);
    const matches: number[] = [];
    after.forEach((candidate: any, j: number) => {
      if (!claimed.has(j) && normalizeStepTitle(candidate.title) === title) matches.push(j);
    });
    // A title shared by two steps identifies neither — leave it to the second
    // pass rather than pairing everything against the first match.
    if (matches.length === 1) {
      pairs[i] = matches[0];
      claimed.add(matches[0]);
    }
  });

  // Titles that belong to some OTHER existing step. An `after` entry carrying
  // one of these is that step's counterpart, however the numbers line up, so
  // positional matching must not hand it to a different step. Without this a
  // caller could erase step A and send a second copy of step B in its place:
  // the duplicated title makes pass 1 ambiguous, position then pairs A with a
  // fully-populated B, every field reads "changed, not blanked", and A's
  // destruction is reported as no loss at all.
  const titlesOf = (steps: any[]) =>
    new Set(steps.map((s: any) => normalizeStepTitle(s.title)).filter((t) => t !== ''));
  const beforeTitles = titlesOf(before);

  before.forEach((step: any, i: number) => {
    if (pairs[i] !== -1) return;
    if (step.stepCount === undefined || step.stepCount === null) return;
    const ownTitle = normalizeStepTitle(step.title);
    const j = after.findIndex((candidate: any, index: number) => {
      if (claimed.has(index)) return false;
      if (Number(candidate.stepCount) !== Number(step.stepCount)) return false;
      const candidateTitle = normalizeStepTitle(candidate.title);
      // Same title, or none supplied at all (the common partial payload, which
      // carries stepCount and the field being changed and nothing else) — the
      // number is the only identity on offer, so trust it.
      if (candidateTitle === ownTitle || candidateTitle === '') return true;
      // A title belonging to another existing step is that step's, whatever the
      // numbers say. Taking it here pairs two unrelated steps.
      if (beforeTitles.has(candidateTitle)) return false;
      // Otherwise the title is new, and position alone cannot tell a RENAME of
      // this step from a REPLACEMENT of it by a different one. Both look like
      // "old title gone, new title at the same number". So accept the pairing
      // only where the distinction does not matter — where this step's content
      // survives intact. A newcomer that brings its own content is treated as a
      // different step, leaving this one unpaired and its content reported as
      // lost, which is exactly what happened to it.
      return preservesContent(step, candidate);
    });
    if (j !== -1) {
      pairs[i] = j;
      claimed.add(j);
    }
  });

  return pairs;
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
 * Fields a replace would blank on the steps the caller sent back.
 *
 * A step with no counterpart loses everything it had — but only counts as loss
 * when some OTHER step was recognised. That distinction is the whole rule:
 *
 *  - Nothing recognised at all is a deliberate wholesale rewrite. There is no
 *    step the caller plainly meant to preserve, and droppedStepTitles already
 *    says what went. Refusing it would make replacing a plan impossible.
 *  - Something recognised means the caller was amending THIS plan, so a step
 *    that quietly failed to come back is content they did not mean to drop.
 *
 * That second case used to be skipped as "a removal, which the count guard
 * already reports". The count guard only sees a SHRINK, so a same-length
 * rewrite — one step renamed and reordered, its fields gutted — slipped past
 * both checks and blanked the step with nothing said.
 */
export function findStepContentLoss(before: any[], after: any[]) {
  const pairs = pairSteps(before, after);
  const keptAnything = pairs.some((index) => index !== -1);
  // A wholesale rewrite brings its own content. If the replacement contains a
  // step with no content of its own, this is not "a new plan" — it is erasure,
  // and the carve-out must not cover it. Without this, renaming AND reordering
  // every step at once pairs nothing, `keptAnything` stays false, and a
  // same-length write blanks a step with neither guard firing.
  const replacementCarriesContent = after.length > 0
    && after.every((step: any) => STEP_CONTENT_FIELDS.some((field) => !isEmptyStepValue(step[field])));
  // "Carries content" only asks whether each step has SOME content, so a payload
  // that renamed and renumbered everything while keeping the descriptions and
  // dropping the skillIds still looked like a new plan, and every loss was
  // suppressed into a silent 200.
  //
  // A genuinely new plan does not reuse the prose of the one it replaces. A step
  // description repeated byte for byte is an amendment that lost its footing, not
  // a rewrite. Only prose counts: skillIds and requiredFunctionCalls recur across
  // unrelated plans, so reading those as evidence would refuse ordinary rewrites.
  const REWRITE_IDENTITY_FIELDS = ['description', 'userInstructions'] as const;
  const existingProse = new Set<string>();
  before.forEach((step: any) => {
    REWRITE_IDENTITY_FIELDS.forEach((field) => {
      if (!isEmptyStepValue(step[field])) existingProse.add(`${field}:${JSON.stringify(step[field])}`);
    });
  });
  const reusesExistingProse = after.some((step: any) =>
    REWRITE_IDENTITY_FIELDS.some((field) =>
      !isEmptyStepValue(step[field]) && existingProse.has(`${field}:${JSON.stringify(step[field])}`)));
  const isWholesaleRewrite = !keptAnything && replacementCarriesContent && !reusesExistingProse;
  const claimed = new Set(pairs.filter((index) => index !== -1));
  const losses: { stepCount: any; title: any; fields: string[]; kind: 'blanked' | 'unpaired' }[] = [];
  before.forEach((existing: any, i: number) => {
    const index = pairs[i];
    if (index === -1 && isWholesaleRewrite) return;
    const populated = STEP_CONTENT_FIELDS.filter((field) => !isEmptyStepValue(existing[field]));
    if (index !== -1) {
      const fields = populated.filter((field) => isEmptyStepValue(after[index][field]));
      if (fields.length > 0) {
        losses.push({ stepCount: existing.stepCount, title: existing.title, fields: [...fields], kind: 'blanked' });
      }
      return;
    }
    // Unpaired. Something else may still be occupying this step's number — a
    // rename that also edited a field lands here, because a renamed step and a
    // brand-new one in its place are the same bytes and pairing refuses to guess
    // between them. Report it either way; at equal length nothing else would.
    //
    // But report it TRUTHFULLY. Listing every populated field accused such a
    // payload of dropping skillIds that are sitting in that very slot, unchanged.
    // Only fields actually missing from the step now holding the number are lost.
    const occupant = after.find((candidate: any, j: number) =>
      !claimed.has(j)
      && existing.stepCount !== undefined && existing.stepCount !== null
      && Number(candidate.stepCount) === Number(existing.stepCount));
    const fields = occupant
      ? populated.filter((field) => isEmptyStepValue(occupant[field]))
      : populated;
    losses.push({ stepCount: existing.stepCount, title: existing.title, fields: [...fields], kind: 'unpaired' });
  });
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
 * Deliberately stepCount-before-title, the opposite of pairSteps: here the
 * caller has explicitly named the step to amend, and the schema says so.
 * pairSteps infers identity across two full arrays with no such selector — and
 * the route must therefore never hand this function a stepCount the caller did
 * not actually supply, or the explicit selector is a fabricated one.
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
