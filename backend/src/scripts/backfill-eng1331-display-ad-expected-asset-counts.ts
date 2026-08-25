/**
 * ENG-1331 remediation — set `expectedAssetCount` on the "Display Ad Set Production —
 * One Master, Every Size" predefined work plan's render, QA, and variant-run steps, so
 * the (now Playwright-screenshot-aware — see extractProducedAssetCount in
 * agentMode/core/synthesisResidue.ts) step-completion gate can actually block this
 * template from closing a step with fewer assets than it claims.
 *
 * Production incident this repairs: session b78a3203 rendered only 4 of 12 requested
 * display-ad sizes on its "Optional: Variant Run" step, yet the step was marked
 * completed and the closing message claimed all 12 were rendered, QA'd, and saved.
 * `expectedAssetCount` was never set on this template, so the completion gate — which
 * exists and works when a step declares it — had nothing to enforce.
 *
 * ── Why NOT "12 for every media step" ──────────────────────────────────────────────
 * The gate scopes each step's produced-asset count to only what THAT step produced
 * since the previous step resolved (ENG-1188) — an earlier step's assets never satisfy
 * a later step's requirement. Given this template's actual step descriptions (read from
 * a live production session, not guessed):
 *   - Step 3 "Render the Full Size Matrix" renders all 12 sizes — expectedAssetCount: 12,
 *     expectedAssetCountTools: [playwright_browser_take_screenshot] (see below).
 *   - Step 4 "QA, Contact Sheet & Delivery" VERIFIES the existing 12 renders (no
 *     re-render in the normal case) and produces exactly ONE new asset, the contact
 *     sheet — expectedAssetCount: 12 here (as a since-superseded draft of this fix
 *     proposed) would make the step permanently unable to complete.
 *   - Step 5 "Optional: Variant Run" is the step the actual incident happened on — reset
 *     and re-completed once per variant (2, 3, 4, ...), each cycle rendering 12 NEW
 *     sizes. The gate's sinceIso step-boundary logic already handles this reset-and-
 *     recomplete pattern explicitly (see the ENG-1188 CodeRabbit-follow-up comment in
 *     agentModeService.ts's setWorkPlanStatus). expectedAssetCount: 12,
 *     expectedAssetCountTools: [playwright_browser_take_screenshot].
 *
 * ── Why expectedAssetCountTools on steps 3 and 5 ────────────────────────────────────
 * Both steps' requiredFunctionCalls list BOTH create_html_file (a handful of reusable
 * per-archetype templates) AND playwright_browser_take_screenshot (one per requested
 * size) — real work, not padding, but not interchangeable units of "the 12 sizes"
 * either. Without naming the counted tool, the gate's safe default (max across every
 * producing tool) already prevents a false completion, but naming it removes the
 * ambiguity outright instead of relying on a heuristic. Step 4 is left unset: its
 * contact-sheet deliverable's producing tool isn't evidenced clearly enough in the
 * template to name safely, and the max-based default already handles "1 of any
 * producing tool" correctly.
 *
 * ── NOTE (CLAUDE.md data-plane gate) ───────────────────────────────────────────────
 * This is a production data change (a persistent work-plan template mutation) and needs
 * Harsha's approval before anyone runs it with --apply. It also cannot be run from a
 * read-only autofix environment — the autofix EC2 instance role is explicitly read-only
 * on prod AW-* tables, so this script must be run somewhere with real prod AWS write
 * credentials.
 *
 * ── Usage ───────────────────────────────────────────────────────────────────────────
 *   NODE_ENV=production npx ts-node src/scripts/backfill-eng1331-display-ad-expected-asset-counts.ts            # DRY RUN (default, no writes)
 *   NODE_ENV=production npx ts-node src/scripts/backfill-eng1331-display-ad-expected-asset-counts.ts --apply    # writes
 *
 * Run the dry run first and read the report. If any step reports title-mismatch or
 * step-missing, STOP — the template has changed since this script was written and the
 * hardcoded step targets below need to be re-verified against the live plan before
 * writing anything.
 */
import { workPlanService, type WorkPlan, type WorkPlanStep } from "../services/workPlanService";

export const PLAN_TITLE = "Display Ad Set Production — One Master, Every Size";

export interface ExpectedAssetCountTarget {
  stepCount: number;
  title: string;
  count: number;
  /**
   * ENG-1331 (post-launch hardening): which tool's successes count toward `count`,
   * when a step calls more than one asset-producing tool that aren't interchangeable
   * (see synthesisResidue.ts's countProducedAssets). Steps 3 and 5 both declare
   * create_html_file (a handful of reusable per-archetype templates) AND
   * playwright_browser_take_screenshot (one per requested size) as
   * requiredFunctionCalls — only the screenshot count is "the N sizes" per each
   * step's own description. Without this, the gate's safe default (max across every
   * producing tool) already prevents the padding failure this fixes for, but leaving
   * it unset means max, not an explicit, unambiguous "only this tool counts" —
   * setting it removes the ambiguity entirely rather than relying on a heuristic.
   * Omitted for step 4: its contact-sheet deliverable's producing tool isn't
   * evidenced clearly enough in the template to name safely — the max-based default
   * already handles it correctly (1 succeeded call of any producing tool).
   */
  tools?: string[];
}

export const ENG1331_EXPECTED_ASSET_COUNT_TARGETS: ExpectedAssetCountTarget[] = [
  { stepCount: 3, title: "Render the Full Size Matrix", count: 12, tools: ["playwright_browser_take_screenshot"] },
  { stepCount: 4, title: "QA, Contact Sheet & Delivery", count: 1 },
  { stepCount: 5, title: "Optional: Variant Run", count: 12, tools: ["playwright_browser_take_screenshot"] },
];

export type StepChangeAction = "set" | "already-set" | "title-mismatch";

export interface StepChangeResult {
  stepCount: number;
  action: StepChangeAction;
  detail: string;
}

type PlanStepLike = Pick<WorkPlanStep, "stepCount" | "title" | "expectedAssetCount" | "expectedAssetCountTools">;

const sameTools = (a: string[] | undefined, b: string[] | undefined): boolean => {
  if (a === undefined && b === undefined) return true;
  if (!a || !b || a.length !== b.length) return false;
  return a.every((t, i) => t === b[i]);
};

/**
 * Pure planning function: given a plan's current steps and the target list, decide what
 * SHOULD change without doing any I/O — so the policy governing a production data write
 * is unit-tested rather than inferred from a dry run (same pattern as
 * backfill-eng967-lead-list-public-access.ts's classifyBoundList).
 *
 * A step whose title doesn't match what this script expects is reported as
 * title-mismatch and left UNTOUCHED rather than blindly overwritten —
 * expectedAssetCount is safety-critical (too low gates nothing, too high permanently
 * blocks completion), so a template that changed since this script was written must be
 * re-verified by a human before any write happens. A target `stepCount` absent from the
 * plan entirely never appears in `updatedSteps` and produces no result — the caller
 * must diff the target list against `results` to notice a missing step.
 */
export function planExpectedAssetCountUpdates(
  steps: PlanStepLike[],
  targets: ExpectedAssetCountTarget[] = ENG1331_EXPECTED_ASSET_COUNT_TARGETS,
): { updatedSteps: PlanStepLike[]; results: StepChangeResult[] } {
  const results: StepChangeResult[] = [];
  const updatedSteps = steps.map((step) => {
    const target = targets.find((t) => t.stepCount === step.stepCount);
    if (!target) return step;
    if (step.title !== target.title) {
      results.push({
        stepCount: step.stepCount,
        action: "title-mismatch",
        detail: `expected title "${target.title}", found "${step.title}" — leaving this step untouched`,
      });
      return step;
    }
    if (step.expectedAssetCount === target.count && sameTools(step.expectedAssetCountTools, target.tools)) {
      results.push({
        stepCount: step.stepCount,
        action: "already-set",
        detail: `expectedAssetCount already ${target.count}${target.tools ? ` (tools: ${target.tools.join(", ")})` : ""}`,
      });
      return step;
    }
    results.push({
      stepCount: step.stepCount,
      action: "set",
      detail: `expectedAssetCount ${step.expectedAssetCount ?? "(unset)"} -> ${target.count}` +
        (target.tools ? `, expectedAssetCountTools ${JSON.stringify(step.expectedAssetCountTools ?? null)} -> ${JSON.stringify(target.tools)}` : ""),
    });
    // CodeRabbit (ENG-1331 follow-up): a plain conditional spread only ever ADDS
    // expectedAssetCountTools, never removes it — a step with a target that has
    // no tools (step 4) but a pre-existing/stale expectedAssetCountTools value
    // would keep that stale value forever instead of falling back to the
    // intended max-based default. Not triggered by the current live template
    // (step 4 never had a value), but latent — explicit delete closes it.
    const updatedStep: PlanStepLike = { ...step, expectedAssetCount: target.count };
    if (target.tools) {
      updatedStep.expectedAssetCountTools = target.tools;
    } else {
      delete updatedStep.expectedAssetCountTools;
    }
    return updatedStep;
  });
  return { updatedSteps, results };
}

const APPLY = process.argv.includes("--apply");

export async function main() {
  console.log("ENG-1331 expectedAssetCount backfill", {
    planTitle: PLAN_TITLE,
    mode: APPLY ? "APPLY (will write)" : "DRY RUN (no writes — pass --apply to write)",
  });

  // Predefined work plans surfaced generically to any agent-mode user (as this one is —
  // confirmed live: session b78a3203's pageIdentifier was `plan-${PLAN_TITLE}` with no
  // owner/org scoping) are system or public visibility, never private/pending_review —
  // those require an authenticated owner. getPublicPlansForAgentMode covers both.
  const candidates = (await workPlanService.getPublicPlansForAgentMode()).filter(
    (p: WorkPlan) => p.title === PLAN_TITLE,
  );

  if (candidates.length !== 1) {
    console.error(
      `Expected exactly 1 plan titled "${PLAN_TITLE}" in system/public visibility, found ${candidates.length}` +
        (candidates.length ? ` (planIds: ${candidates.map((p) => p.planId).join(", ")})` : "") +
        ". Aborting — nothing written.",
    );
    process.exitCode = 1;
    return;
  }

  const plan = candidates[0];
  console.log(
    `Found plan ${plan.planId} (visibility=${plan.visibility}, ${plan.steps.length} steps, ` +
      `steps_rev=${plan.steps_rev ?? "(none)"})`,
  );

  const { updatedSteps, results } = planExpectedAssetCountUpdates(plan.steps);
  for (const r of results) {
    console.log(`  step ${r.stepCount}: ${r.action} — ${r.detail}`);
  }

  const targetStepCounts = new Set(ENG1331_EXPECTED_ASSET_COUNT_TARGETS.map((t) => t.stepCount));
  const foundStepCounts = new Set(plan.steps.map((s) => s.stepCount));
  const missingSteps = [...targetStepCounts].filter((sc) => !foundStepCounts.has(sc));
  for (const sc of missingSteps) {
    console.warn(`  step ${sc}: MISSING — no step with this stepCount exists in the live plan`);
  }

  const toWrite = results.filter((r) => r.action === "set");
  const problems = results.filter((r) => r.action === "title-mismatch").length + missingSteps.length;
  if (problems > 0) {
    console.warn(
      `\n${problems} step(s) could not be safely matched (see title-mismatch/MISSING above) — ` +
        "the template may have changed since this script was written. Re-verify the targets " +
        "above against the live plan before proceeding.",
    );
  }

  if (toWrite.length === 0) {
    console.log("\nNo changes needed — plan already has the correct expectedAssetCount values.");
    return;
  }

  if (!APPLY) {
    console.log(`\nDry run complete — ${toWrite.length} step(s) would be updated. Re-run with --apply to write.`);
    return;
  }

  const newRev = await workPlanService.updateWorkPlan(
    { ...plan, steps: updatedSteps as WorkPlanStep[] },
    { expectedStepsRev: plan.steps_rev ?? null },
  );
  console.log(`\nApplied. ${toWrite.length} step(s) updated. New steps_rev: ${newRev}`);
}

/**
 * CodeRabbit (ENG-1331 follow-up): the previous fix for the exit-code-masking bug
 * (`process.exit(process.exitCode ?? 0)`) was only provable by testing `main()`
 * directly and inferring the runner would respect `process.exitCode` — main()
 * itself never called `process.exit`, so no test actually exercised the runner's
 * own exit-code selection. Extracted here as a pure-ish (no direct process.exit)
 * async function so a test can invoke the FULL CLI flow — main() plus the exact
 * exit-code logic the real CLI entry point uses — and assert on its return value
 * instead of on `process.exit`/`process.exitCode` side effects.
 */
export async function runCli(): Promise<number> {
  try {
    await main();
    // Node types process.exitCode as string | number | undefined (it accepts a
    // numeric string too); this script only ever sets it to the literal number
    // 1, but coerce defensively rather than assume.
    return Number(process.exitCode ?? 0);
  } catch (err) {
    console.error("Fatal:", err);
    return 1;
  }
}

if (require.main === module) {
  runCli().then((code) => process.exit(code));
}
