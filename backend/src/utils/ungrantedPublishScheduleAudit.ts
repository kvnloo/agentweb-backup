/**
 * ENG-1245 follow-up — a deterministic replacement for the detection path this
 * ticket's own fix quietly removed.
 *
 * WHY THIS EXISTS
 * ---------------
 * ENG-1245 only got filed because the LLM judges incorrectly penalized a
 * correctly-withheld publish, and the daily satisfaction report auto-files a
 * product issue for low-scoring sessions — that accidental chain took THREE
 * occurrences to escalate (AGW-264/ENG-1190, a recurrence the next day, then
 * this ticket), and the automated pipeline that first investigated it still
 * landed on the wrong root cause. Once judges correctly stop penalizing honest
 * withholding (the actual fix), that chain goes permanently dark for every
 * OTHER schedule stuck in the identical state — nothing is left to notice it.
 *
 * This module reads the fact directly instead of waiting for an LLM to
 * stumble onto it: a schedule is active, its own prompt says it means to
 * publish unattended, and `resolveSchedulePublishAuthorization` resolves it
 * unauthorized for the 'not_granted' reason specifically. A genuine owner-set
 * "Require approval before publishing" hold is deliberately EXCLUDED — that is
 * correct, intentional behavior, not a bug, and must never be flagged as one.
 *
 * This is read-only and detects; it does not grant anything. Granting a
 * flagged schedule still goes through grant-schedule-autopublish.ts with an
 * explicit owner confirmation, per this repo's data-plane rules.
 */
import {
  resolveSchedulePublishAuthorization,
  describePublishAuthorizationWithholdReason,
  isPublishCapableTool,
  SchedulePublishAuthorizationInput,
} from './schedulePublishAuthorization';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Matches the same signal the original ENG-827 population survey used ("25 ACTIVE are
// publishing-shaped... 21 whose prompt says post/publish/tweet/reply") — kept
// deliberately simple and over-inclusive: a false positive here just means a schedule
// gets a second look, while a false negative means a broken schedule goes unseen.
const PUBLISH_INTENT_PATTERN = /\b(posts?|publish(es|ing|ed)?|tweets?|repl(y|ies|ied))\b/i;

interface AuditableSchedule extends SchedulePublishAuthorizationInput {
  scheduleId: string;
  scheduleName?: string;
  name?: string;
  userId: string;
  status?: string;
  startingMessage?: string;
  runResults?: Array<{ createdAt?: string; actualFunctionCalls?: unknown }>;
}

export interface UngrantedPublishingScheduleFinding {
  scheduleId: string;
  scheduleName: string;
  userId: string;
  /** undefined when no run in the available history ever called a publish-capable tool. */
  daysSinceLastPublish: number | undefined;
  lastRunAt: string | undefined;
}

/** Does this schedule's own configuration say it means to publish unattended? */
export function scheduleSignalsPublishIntent(schedule: { startingMessage?: string; scheduleName?: string; name?: string }): boolean {
  const text = `${schedule?.startingMessage || ''} ${schedule?.scheduleName || schedule?.name || ''}`;
  return PUBLISH_INTENT_PATTERN.test(text);
}

function daysBetween(iso: string | undefined, now: Date): number | undefined {
  if (!iso) return undefined;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return undefined;
  return Math.floor((now.getTime() - then) / MS_PER_DAY);
}

/**
 * Scan a set of schedules for the ENG-1245 bug class: active, publish-intent, and
 * unauthorized only because standing publish authorization was never granted — not
 * because the owner asked to be held.
 */
export function findUngrantedPublishingSchedules(
  schedules: AuditableSchedule[],
  now: Date = new Date(),
): UngrantedPublishingScheduleFinding[] {
  const findings: UngrantedPublishingScheduleFinding[] = [];

  for (const schedule of schedules || []) {
    if (!schedule || schedule.status !== 'active') continue;
    if (!scheduleSignalsPublishIntent(schedule)) continue;

    const authorization = resolveSchedulePublishAuthorization(schedule);
    if (authorization.authorized) continue;

    if (describePublishAuthorizationWithholdReason(schedule) !== 'not_granted') continue;

    const runResults = Array.isArray(schedule.runResults) ? schedule.runResults : [];
    let lastPublishAt: string | undefined;
    for (let i = runResults.length - 1; i >= 0; i--) {
      const calls = Array.isArray(runResults[i]?.actualFunctionCalls) ? (runResults[i]!.actualFunctionCalls as unknown[]) : [];
      if (calls.some((c) => typeof c === 'string' && isPublishCapableTool(c))) {
        lastPublishAt = runResults[i]?.createdAt;
        break;
      }
    }

    findings.push({
      scheduleId: schedule.scheduleId,
      scheduleName: schedule.scheduleName || schedule.name || '(unnamed)',
      userId: schedule.userId,
      daysSinceLastPublish: daysBetween(lastPublishAt, now),
      lastRunAt: runResults[runResults.length - 1]?.createdAt,
    });
  }

  return findings;
}
