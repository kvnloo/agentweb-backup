/**
 * Seed script (ENG-1880, Phase B): daily scheduled reports on Harsha's own account.
 *
 * WHY THIS EXISTS. Per the 2026-09-14 call decision (Harsha + Manan): before the
 * autonomous report ever reaches a real customer, run it as a scheduled chat on
 * Harsha's own account — not a customer's, not the founder's — across every major
 * client currently running real Meta ad spend, for a few days, to (a) judge real
 * report accuracy and (b) compute real per-report LLM/API cost. Only once that's
 * satisfactory does this move to a customer-facing opt-in (Phase C).
 *
 * WHY ONE SCHEDULE ROW PER CLIENT. A schedule fires with exactly one fixed
 * `startingMessage` — there is no per-run client parameter. Running this for N
 * clients means N separate `AW-TaskSchedules` rows, each with that client's name
 * baked into its own starting message.
 *
 * WHY THIS EXACT MESSAGE WORDING. Not invented — copied from a real, already-live
 * schedule (scheduleId `1816cb76-11a6-4cd5-bfd1-bfb6d0217196`, monthly, targeting
 * the earlier internal-validation plan for Haven) that already proved this exact
 * "run the private work plan titled X, target client Y" phrasing correctly resolves
 * via the model's own `launch_predefined_work_plan` tool call — `AW-TaskSchedules`
 * has no `planId` field, so the target plan is identified by exact title match
 * inside the message text, not a structured reference.
 *
 * WHY DAILY. Matches the "here's what happened while you were away" framing and
 * gives a fresh accuracy/cost data point every day during the short monitoring
 * window, rather than waiting a week between samples.
 *
 * CLIENT LIST — real accounts with real Meta ad spend in the last 30 days, ranked
 * by spend, confirmed live against `AW-AdsMetricsSnapshots` on 2026-09-15 (4 other
 * connected accounts showed $0 spend across the same window and were excluded —
 * not "major clients running Meta ads" in the sense the call described):
 *   Phoenix Technologies ($32,090.54), Haven AI ($13,292.91), My Health Surveys
 *   ($3,996.96), Omega Tech MS ($703.20), Kraftersland ($310.31), Toa Works /
 *   Bodylever ($275.72).
 *
 * IDEMPOTENCY. `createSchedule` has no fixed-id upsert. This script checks for an
 * existing schedule with the same `scheduleName` before creating one, so re-running
 * it is a no-op per client rather than a duplicate.
 *
 * COST MEASUREMENT (separate from this script, noted for whoever reviews the
 * monitoring window): each run's real per-report cost is queryable after the fact
 * from `AW-SpendEvents` (`listSpendEvents(billingUserId, start, end)`, filtered
 * client-side on `event.references.sessionId === <that run's sessionId>`, summed
 * over `costMicroUsd`) — a real per-call ledger, not the daily-aggregate
 * `AW-UsageRecords` table, which is not sessionId-attributable.
 *
 * Run:
 *   NODE_ENV=development npx ts-node src/scripts/seed-eng1880-phase-b-scheduled-reports.ts
 *   NODE_ENV=production  npx ts-node src/scripts/seed-eng1880-phase-b-scheduled-reports.ts
 */

import { v4 as uuidv4 } from 'uuid';
import { scheduleDb } from '../services/db';

const PLAN_TITLE = 'Meta_Ads_Perf_Report_Autonomous';

const HARSHA_OWNER_USER_ID = process.env.SEED_OWNER_USER_ID || '1743956381327';

const REQUIRED_FUNCTION_CALLS = [
  'list_meta_ads_campaigns',
  'get_meta_ads_metrics',
  'monitor_lead_volume',
  'list_html_templates',
  'perform_data_analysis',
  'create_html_from_template',
];

interface ClientTarget {
  name: string;
  email: string;
}

export const PHASE_B_CLIENTS: ClientTarget[] = [
  { name: 'Phoenix Technologies', email: 'vince@phoenixtechnologies.io' },
  { name: 'Haven AI', email: 'juan@usehaven.ai' },
  { name: 'My Health Surveys', email: 'roni.dasgupta@atlasprimary.io' },
  { name: 'Omega Tech MS', email: 'info@omegatechms.com' },
  { name: 'Kraftersland', email: 'order@kraftersland.com' },
  { name: 'Toa Works Inc. (Bodylever)', email: 'info@bodylever.com' },
];

export function buildStartingMessage(client: ClientTarget): string {
  return (
    `Run the private work plan titled exactly '${PLAN_TITLE}'. The target client for ` +
    `this run is ${client.email} — use this exact email whenever a step calls ` +
    `get_meta_ads_metrics, list_meta_ads_campaigns, or monitor_lead_volume, since this ` +
    `is an internal admin run analyzing that client's account on their behalf, not the ` +
    `caller's own account. Use a 30-day reporting window. Do not ask me any questions ` +
    `at any point in this run — proceed autonomously through all three steps and ` +
    `produce the final HTML report link.`
  );
}

export function buildScheduleName(client: ClientTarget): string {
  return `${PLAN_TITLE} — ${client.name} (Phase B)`;
}

function nextDailyRunTime(): string {
  // Next occurrence of 09:00 UTC, matching the existing metrics-snapshot cron's own
  // 09:00 UTC timing (ENG-916), so this fires after that day's fresh snapshot data
  // is already written rather than racing it.
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 9, 0, 0));
  if (next <= now) {
    next.setUTCDate(next.getUTCDate() + 1);
  }
  return next.toISOString();
}

export function buildSchedule(client: ClientTarget, ownerId: string = HARSHA_OWNER_USER_ID) {
  const now = new Date().toISOString();
  return {
    scheduleId: uuidv4(),
    taskId: 'global',
    userId: ownerId,
    frequency: 'daily',
    nextRunTime: nextDailyRunTime(),
    status: 'active',
    createdAt: now,
    updatedAt: now,
    type: 'scheduled_chat',
    scheduleName: buildScheduleName(client),
    description: `ENG-1880 Phase B monitoring run for ${client.name} — private, admin-only, not customer-facing.`,
    startingMessage: buildStartingMessage(client),
    requiredFunctionCalls: REQUIRED_FUNCTION_CALLS,
  };
}

export async function main() {
  const existing = await scheduleDb.getSchedulesByUserId(HARSHA_OWNER_USER_ID);
  const existingNames = new Set((existing || []).map((s: any) => s.scheduleName));

  const created: any[] = [];
  for (const client of PHASE_B_CLIENTS) {
    const scheduleName = buildScheduleName(client);
    if (existingNames.has(scheduleName)) {
      console.log(`Schedule "${scheduleName}" already exists — skipping.`);
      continue;
    }
    const schedule = await scheduleDb.createSchedule(buildSchedule(client));
    console.log(`Created schedule "${scheduleName}" (scheduleId: ${schedule!.scheduleId}, nextRunTime: ${schedule!.nextRunTime})`);
    created.push(schedule);
  }
  return created;
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Seed script failed:', err);
      process.exit(1);
    });
}
