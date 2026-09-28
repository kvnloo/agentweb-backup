/**
 * Migration script (ENG-2160 PR): create the daily Luma lead-screening scheduled
 * chat on ThinkingAI's account.
 *
 * WHY THIS EXISTS. ThinkingAI is hosting the "Agentic Growth Summit 2026" Luma
 * event (evt-HjqqW76FE1c9Jx5, starts 2026-09-28). We want each day's new
 * registrants screened against ThinkingAI's ICP and the matches posted to their
 * Slack channel, unattended, until the event. The "Luma Event Lead Engagement"
 * catalog skill (published, skillId c096a1a1-…) already does the work when driven
 * interactively; this schedule fires it once a day so nobody has to.
 *
 * WHY A SCRIPT AND NOT A UI CLICK. So the exact schedule (owner, cadence, message,
 * required-calls) is reviewable in the PR and reproducible, and so it is created by
 * someone with production write access (the vendor read-only role cannot write
 * AW-TaskSchedules). Run it once, post-deploy.
 *
 * WHY THIS OWNER. daniel.liu@thinkingai.io (userId 36496472-…) is ThinkingAI's org
 * owner and the ONLY ThinkingAI account with (a) a live Luma session in
 * AW-BrowserCookies, (b) #thinkingai-agentweb-diy in slackChannels, and (c) the
 * connected accounts the skill needs. Dan's own account (dusedom@) is Free, has no
 * Slack channel, and never completed a Luma login — it cannot run this.
 *
 * WHY "last 2 days" AND NOT "since a fixed date". A daily run only needs a rolling
 * window; a 2-day window gives one run of overlap so a missed/slow day never drops a
 * registrant. Dedupe on guest_id (inside the skill) makes the overlap free.
 *
 * WHY requiredFunctionCalls IS MINIMAL. ENG-480: a scheduled prompt that lists
 * per-run-conditional tools (e.g. add_leads_to_list, which does NOT run on a day
 * with zero ICP matches) fails goalCompletion validation every quiet day. So this
 * lists ONLY the pull-path tools that fire on every single run regardless of
 * whether any match is found.
 *
 * WHY NO llmModel. Left unset so the account's configured default applies, matching
 * the ENG-1880 seed script. If a run needs a specific model for skill adherence,
 * set it on the schedule afterward rather than hardcoding a possibly-stale id here.
 *
 * IDEMPOTENCY. createSchedule has no fixed-id upsert; this checks for an existing
 * schedule with the same scheduleName on the owner before creating, so re-running is
 * a no-op rather than a duplicate.
 *
 * Run (post-deploy, by someone with prod write):
 *   NODE_ENV=production  npx ts-node src/scripts/seed-thinkingai-luma-daily-schedule.ts
 *   NODE_ENV=development npx ts-node src/scripts/seed-thinkingai-luma-daily-schedule.ts
 *
 * The schedule is additive and DRAFT-ONLY: the skill never sends LinkedIn messages
 * and never approves/declines guests on Luma. To stop it, set the row's status to
 * 'inactive' (or delete it) after the event.
 */

import { v4 as uuidv4 } from 'uuid';
import { scheduleDb } from '../services/db';

// ThinkingAI org owner (daniel.liu@thinkingai.io). Overridable for a dry run on a
// different account, but defaults to the real target.
const OWNER_USER_ID = process.env.SEED_OWNER_USER_ID || '36496472-3be3-4760-bf43-6f8b0bd7c5c1';

const EVENT_API_ID = 'evt-HjqqW76FE1c9Jx5';
const RAW_LIST_ID = 'list_1790272321475_54e6agqon';       // "ThinkingAI Agentic Growth Summit 2026" (dedupe against)
const SHORTLIST_ID = 'list_1790009443611_7h9t0kzbu';      // "ThinkingAI Agentic Growth 2026 ICP shortlist" (add to)
const ALERT_CHANNEL = '#thinkingai-agentweb-diy';

const SCHEDULE_NAME = 'Luma Event Lead Engagement — ThinkingAI Summit (Daily)';

// Only tools that run on EVERY execution (the pull path). Conditional tools
// (add_leads_to_list, linkedin_outreach, enrich_leads_execute) are intentionally
// omitted — see ENG-480 note above.
const REQUIRED_FUNCTION_CALLS = [
  'load_browser_cookies',
  'playwright_browser_navigate',
  'playwright_browser_evaluate',
  'read_market_strategy',
];

export function buildStartingMessage(): string {
  return (
    `Using the Luma Event Lead Engagement skill: pull guests from ${EVENT_API_ID} registered in ` +
    `the last 2 days, dedupe against "ThinkingAI Agentic Growth Summit 2026" (${RAW_LIST_ID}), ` +
    `score new ones against our ICP, add ICP matches to "ThinkingAI Agentic Growth 2026 ICP ` +
    `shortlist" (${SHORTLIST_ID}) with icp_tier / icp_reason / linkedin_invite_note / ` +
    `linkedin_followup_message, and post each new match to ${ALERT_CHANNEL}. Draft only — do not ` +
    `send any message and do not approve or decline any guest. Proceed autonomously; do not ask ` +
    `questions. If nothing new registered, say so and stop.`
  );
}

// First run at the next 06:00 UTC (≈11:30 IST); daily thereafter.
function nextFirstRunTime(now: Date = new Date()): string {
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 6, 0, 0));
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString();
}

export function buildSchedule(ownerId: string = OWNER_USER_ID, now: Date = new Date()) {
  const ts = now.toISOString();
  return {
    scheduleId: uuidv4(),
    taskId: 'global',
    userId: ownerId,
    frequency: 'daily',
    nextRunTime: nextFirstRunTime(now),
    status: 'active',
    createdAt: ts,
    updatedAt: ts,
    type: 'scheduled_chat',
    scheduleName: SCHEDULE_NAME,
    description:
      'Daily Luma lead screening for the ThinkingAI Agentic Growth Summit 2026 — ' +
      'pull new registrants, dedupe, ICP-score, add matches to the shortlist, alert Slack. ' +
      'Draft-only. Disable after 2026-09-28.',
    startingMessage: buildStartingMessage(),
    requiredFunctionCalls: REQUIRED_FUNCTION_CALLS,
  };
}

export async function main() {
  // db.ts's TABLE_PREFIX treats anything other than exactly "development" as
  // production. Guard against a mistyped/unset NODE_ENV silently writing a real row.
  if (process.env.NODE_ENV !== 'development' && process.env.NODE_ENV !== 'production') {
    throw new Error(
      `NODE_ENV must be exactly 'development' or 'production' (got: ${JSON.stringify(process.env.NODE_ENV)}). ` +
      `Any other value falls through to the unprefixed production table in db.ts's TABLE_PREFIX logic.`
    );
  }

  const existing = await scheduleDb.getSchedulesByUserId(OWNER_USER_ID);
  if ((existing || []).some((s: any) => s.scheduleName === SCHEDULE_NAME)) {
    console.log(`Schedule "${SCHEDULE_NAME}" already exists for ${OWNER_USER_ID} — skipping (no-op).`);
    return null;
  }

  const schedule = buildSchedule();
  await scheduleDb.createSchedule(schedule as any);
  console.log(
    `Created schedule "${SCHEDULE_NAME}" ` +
    `(scheduleId: ${schedule.scheduleId}, owner: ${OWNER_USER_ID}, ` +
    `frequency: daily, firstRun: ${schedule.nextRunTime}).`
  );
  console.log('Reminder: DRAFT-ONLY. Set status to inactive (or delete) after 2026-09-28.');
  return schedule;
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Migration script failed:', err);
      process.exit(1);
    });
}
