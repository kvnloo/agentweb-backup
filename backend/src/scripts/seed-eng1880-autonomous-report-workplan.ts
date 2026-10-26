/**
 * Seed script (ENG-1880): the private, autonomous "Meta_Ads_Perf_Report" variant.
 *
 * WHY THIS EXISTS. The published `Meta_Ads_Perf_Report` work plan is human-in-the-loop
 * (structural timeframe picker, asks the user which campaign, asks how many leads
 * converted) and cannot run unattended — this is what Harsha's 2026-09-01 "user-facing
 * reports" ask ("Emma got you four leads while you were away") needs instead.
 *
 * The step content below is NOT invented — it is adapted, near-verbatim, from an
 * internal validation plan (planId `e5763948-4283-467b-9443-21cb68de50ff`) that was
 * already run twice live against real Haven data and proved the autonomous-selection
 * approach: auto-selecting every campaign with nonzero spend, excluding
 * OUTCOME_ENGAGEMENT/LINK_CLICKS campaigns with no destination URL from being misread
 * as conversion failures (a mistake that produced two false blackout alerts previously),
 * and pulling lead counts from `monitor_lead_volume` instead of asking. Two corrections
 * were made on top of that proven content:
 *   1. Step 2 now explicitly tells the model to extract the 4 CSV links already present
 *      in step 1's `get_meta_ads_metrics` result rather than constructing new ones via
 *      `save_file` — the validation plan's own step 2 wording left this ambiguous, and
 *      an ambiguous instruction here is exactly what caused both validation runs to
 *      silently self-heal into the freeform `create_html_file` fallback instead of using
 *      the (at the time, still-missing) template.
 *   2. Step 3 drops the "INTERNAL VALIDATION — not for customer distribution" framing
 *      for real customer-facing wording, and explicitly tells the model to omit any of
 *      the 4 analysis sections that had no data rather than fabricate or leave a
 *      placeholder — the template's own auto-omission only covers array variables, not
 *      the scalar chart/insight variables these sections use.
 *
 * WHY PRIVATE (Phase A). Depends on two things not yet true in prod at authoring time:
 * the `multi_campaign_performance_report` template actually existing (ENG-1879, blocked
 * on the same prod-write-access gap this script itself needs) and the widened metrics
 * cron (ENG-916 widening) having run at least once for the account under test. Runs
 * `visibility: 'private', showInAgentMode: false` — reachable only via admin delegation
 * or an admin-triggered scheduled-chat run, the same access pattern the validation plan
 * itself used. Publishing (Phase C, flipping visibility to `system`) is a deliberate,
 * separate, human-reviewed step this script never performs.
 *
 * WHY A SCRIPT AND NOT THE `manage_predefined_work_plan` CHAT TOOL. That tool's `create`
 * action deliberately omits a `visibility` parameter (see the comment at its call site in
 * `apiTools.ts`, ENG-889) specifically so a misread chat instruction cannot publish a plan
 * live to every customer. Calling `workPlanService.createWorkPlan` directly, the same
 * function the admin REST route itself delegates to, is the only way to set
 * `visibility: 'private'` explicitly.
 *
 * IDEMPOTENCY. `createWorkPlan` always mints a fresh `planId` — there is no fixed-id
 * upsert the way `upsertPublicTemplate` has for templates. This script checks for an
 * existing plan with the same TITLE before creating one, so re-running it is a no-op
 * rather than a duplicate.
 *
 * Run:
 *   NODE_ENV=development npx ts-node src/scripts/seed-eng1880-autonomous-report-workplan.ts
 *   NODE_ENV=production  npx ts-node src/scripts/seed-eng1880-autonomous-report-workplan.ts
 */

import { workPlanService, type WorkPlanStep } from '../services/workPlanService';

export const AUTONOMOUS_REPORT_WORKPLAN_TITLE = 'Meta_Ads_Perf_Report_Autonomous';

export const AUTONOMOUS_REPORT_WORKPLAN_DESCRIPTION =
  'Autonomous variant of Meta_Ads_Perf_Report (see ENG-1880): auto-selects campaigns ' +
  'with spend and derives lead counts from CRM data instead of asking, so it can run ' +
  'unattended on a schedule and deliver a report to the customer without any prompts. ' +
  'Phase A — created private, reachable only via admin-triggered runs; not yet visible ' +
  'to customers. Depends on the multi_campaign_performance_report template (ENG-1879) ' +
  'and the widened metrics cron (ENG-916) both being live in prod. Publishing ' +
  '(Phase C, flip to visibility: system) is a deliberate, separate, human-reviewed step ' +
  '— never done by this script.';

export const AUTONOMOUS_REPORT_WORKPLAN_WELCOME_MESSAGE =
  "Here's what happened with your campaigns while you were away.";

export const AUTONOMOUS_REPORT_WORKPLAN_STEPS: WorkPlanStep[] = [
  {
    stepCount: 1,
    title: 'Load Campaign Metrics (autonomous selection)',
    skillIds: [],
    requiredFunctionCalls: ['list_meta_ads_campaigns', 'get_meta_ads_metrics'],
    description:
      "Call list_meta_ads_campaigns and get_meta_ads_metrics for the client and timeframe " +
      "given in this run's instructions (default timeframe: 30 days if not specified — do " +
      "not ask the user to choose). Automatically include EVERY campaign that has nonzero " +
      "spend in the window; do not ask the user to pick one. EXCLUDE from being reported as " +
      "a zero-conversion failure any campaign whose objective is OUTCOME_ENGAGEMENT or " +
      "LINK_CLICKS and has no destination URL — these correctly produce zero attributed " +
      "conversions by design, and reporting that as a problem is a false positive (this " +
      "exact mistake produced two false blackout alerts previously). Note which campaigns " +
      "were excluded and why in your working notes for step 3.",
  },
  {
    stepCount: 2,
    title: 'Perform data analysis on metrics',
    skillIds: [],
    requiredFunctionCalls: ['list_html_templates', 'perform_data_analysis', 'monitor_lead_volume'],
    description:
      "Call monitor_lead_volume for the SAME client and window as step 1 to get " +
      "CRM-attributed lead counts per campaign per day — do NOT ask the user how many " +
      "leads converted. Use the campaign-level totalLeads figures it returns for the " +
      "conversion-rate calculation. Do not read totalUnattributedLeads/unattributedContext " +
      "as evidence any specific campaign's leads collapsed — report that figure separately " +
      "if relevant, never folded into a campaign's own count. List the html templates and " +
      "find multi_campaign_performance_report, understand its structure and variables. The " +
      "Ad-Level Data, Demographics Breakdown, Placement Breakdown, and Device Breakdown CSV " +
      "links are already included in step 1's get_meta_ads_metrics result — extract and " +
      "reuse those exact links, do not construct new CSVs via save_file. For each CSV that " +
      "is actually present (a small account may produce fewer than 4), call " +
      "perform_data_analysis once per file to produce a summary of insights and a chart; " +
      "skip any breakdown whose CSV was not produced rather than inventing data for it.",
  },
  {
    stepCount: 3,
    title: 'Create HTML report',
    skillIds: [],
    requiredFunctionCalls: ['create_html_from_template'],
    description:
      "Create an HTML report using the multi_campaign_performance_report template with " +
      "the data and charts you gathered in step 2. For any of the four analysis sections " +
      "(ad-level, demographics, placement, device) that had no data in step 2, omit that " +
      "section from the report entirely rather than leaving a placeholder or fabricating " +
      "figures. If any campaigns were excluded in step 1, briefly note which ones and why. " +
      "Provide the report as a clickable link.",
  },
];

// Every other `visibility: 'private'` work plan in the codebase pairs it with a real
// `ownerId` (userWorkPlanRoutes.ts's create route always sets both together) — an
// undefined ownerId makes orgShareService.canEditItem's ownership check unconditionally
// false for every caller, permanently blocking the plan from the standard user-facing
// edit route. This script has no authenticated "calling user" the way that route does,
// so it accepts an explicit override. The default must match the Phase B schedule
// owner in seed-eng1880-phase-b-scheduled-reports.ts: this plan is private.
const DEFAULT_SEED_OWNER_USER_ID = '1743956381327';

export function buildAutonomousReportWorkPlan(
  ownerId: string = process.env.SEED_OWNER_USER_ID || DEFAULT_SEED_OWNER_USER_ID,
) {
  return {
    title: AUTONOMOUS_REPORT_WORKPLAN_TITLE,
    description: AUTONOMOUS_REPORT_WORKPLAN_DESCRIPTION,
    welcomeMessage: AUTONOMOUS_REPORT_WORKPLAN_WELCOME_MESSAGE,
    steps: AUTONOMOUS_REPORT_WORKPLAN_STEPS,
    category: 'Paid Ads',
    defaultModel: 'gemini-3.7-flash',
    visibility: 'private' as const,
    ownerId,
    showInAgentMode: false,
    isBuiltIn: false,
    autocomplete: true,
    requireLogin: false,
    showLoginSignup: 'after_plan_completed' as const,
  };
}

export async function main() {
  const existing = (await workPlanService.getAllWorkPlans()).find(
    (p) => p.title === AUTONOMOUS_REPORT_WORKPLAN_TITLE,
  );
  if (existing) {
    console.log(
      `Work plan "${AUTONOMOUS_REPORT_WORKPLAN_TITLE}" already exists (planId: ${existing.planId}) — skipping.`,
    );
    return existing;
  }

  const plan = await workPlanService.createWorkPlan(buildAutonomousReportWorkPlan());
  console.log(`Created private work plan "${plan.title}" with id: ${plan.planId}`);
  console.log(`  visibility: ${plan.visibility}, showInAgentMode: ${plan.showInAgentMode}`);
  return plan;
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Seed script failed:', err);
      process.exit(1);
    });
}
