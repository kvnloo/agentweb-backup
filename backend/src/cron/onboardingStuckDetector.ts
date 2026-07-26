/**
 * Onboarding stuck-user detector — DAILY AGGREGATED REPORT.
 *
 * Runs once per day. Scans all users with a non-terminal `onboardingStage`,
 * groups them by stage, and posts ONE Linear issue per day summarizing
 * "how many users are stuck at which stage" with sample emails per stage.
 *
 * History:
 *   - PR #1371 shipped a per-user hourly cron firing reportUIError per stuck
 *     user. The flood (100+ tasks/day, all titled "UI Error: onboarding:stuck")
 *     buried real signal in noise; ftan and Rui both flagged this on Apr 29-30.
 *   - PR #1397 added an all-steps-ready short-circuit + a narrow test-domain
 *     filter, but did NOT change the per-user fire-pattern, so noise continued.
 *   - This rewrite collapses all stuck users into a single daily report. Real
 *     errors (LLM failures, FE swallows) still flow through reportUIError —
 *     this cron now only handles the "users stuck somewhere in the funnel"
 *     observability case, where one daily roll-up is what's actually useful.
 *
 * Tuning:
 *   STUCK_HOURS — minimum hours since last event for a user to count as stuck
 *     (default 1h — keeps existing semantics, aggregation is what fixes noise)
 *
 * Filters retained from PR #1397:
 *   - Terminal stages skipped (`onboarding_completed`, `active`)
 *   - All-six-steps-ready users skipped (legacy stale-stage protection)
 *   - Test-domain emails skipped (`@agenttest.com`, `@example.com`, `+qa` localpart)
 *   - Users without an `onboardingStage` skipped
 *   - Users idle < STUCK_HOURS skipped
 */
import { userDb } from '../services/db';

const STUCK_HOURS = Number(process.env.ONBOARDING_STUCK_HOURS ?? '1');

const TERMINAL_STAGES = new Set<string>(['onboarding_completed', 'active']);

const STEP_STATUS_FIELDS = [
  'brandBuildStatus',
  'icpStatus',
  'competitorStatus',
  'creativeDirStatus',
  'adImageStatus',
  'adCopyStatus',
] as const;

const SAMPLE_EMAILS_PER_STAGE = 5;

/**
 * Test/QA email domain filter. Same rules as PR #1397.
 */
function isTestDomainEmail(email: string | undefined | null): boolean {
  if (!email || typeof email !== 'string') return false;
  const lower = email.toLowerCase();
  if (lower.endsWith('@agenttest.com')) return true;
  if (lower.endsWith('@example.com')) return true;
  const at = lower.indexOf('@');
  const localpart = at >= 0 ? lower.slice(0, at) : lower;
  if (localpart.includes('+qa')) return true;
  return false;
}

interface StuckEntry {
  email: string;
  hoursIdle: number;
}

export interface DailyStuckReport {
  scanned: number;
  totalStuck: number;
  byStage: Record<string, {
    count: number;
    sampleEmails: string[];
    oldestHours: number;
  }>;
  trackerUrl: string | null;
}

function classifyUser(user: any, now: number): { stage: string; hoursIdle: number; email: string } | null {
  const stage = user?.onboardingStage as string | undefined;
  if (!stage) return null;
  if (TERMINAL_STAGES.has(stage)) return null;

  const allStepsReady = STEP_STATUS_FIELDS.every((field) => user[field] === 'ready');
  if (allStepsReady) return null;

  if (isTestDomainEmail(user?.email)) return null;

  const events = Array.isArray(user.onboardingEvents) ? user.onboardingEvents : [];
  const lastEvent = events.length > 0 ? events[events.length - 1] : null;
  const lastEventTs = lastEvent?.ts ?? user.createdAt ?? null;
  if (!lastEventTs) return null;

  const lastMs = Date.parse(lastEventTs);
  if (!Number.isFinite(lastMs)) return null;
  const hoursIdle = (now - lastMs) / (60 * 60 * 1000);
  if (hoursIdle < STUCK_HOURS) return null;

  return { stage, hoursIdle, email: user.email ?? user.userId ?? '' };
}

function formatStageRow(entries: StuckEntry[]): string {
  // Sort by oldest first so the surfaced sample is the most-stuck users.
  const sorted = [...entries].sort((a, b) => b.hoursIdle - a.hoursIdle);
  const sample = sorted.slice(0, SAMPLE_EMAILS_PER_STAGE).map((e) => e.email).filter(Boolean);
  const overflow = sorted.length - sample.length;
  const oldest = sorted[0]?.hoursIdle ?? 0;
  const noun = sorted.length === 1 ? 'user' : 'users';
  const head = `${sorted.length} ${noun} (oldest: ${oldest.toFixed(1)}h)`;
  if (sample.length === 0) return head;
  const tail = overflow > 0 ? `${sample.join(', ')}, +${overflow} more` : sample.join(', ');
  return `${head} — ${tail}`;
}

function todayDateString(): string {
  // YYYY-MM-DD in UTC — stable for daily report titles.
  return new Date().toISOString().slice(0, 10);
}

export async function runOnboardingStuckDetector(): Promise<DailyStuckReport> {
  const now = Date.now();
  // hideBotLike=true filters out smoke-test + bot accounts at the DB layer.
  const users = await userDb.getAllUsers(true);

  const buckets: Record<string, StuckEntry[]> = {};
  for (const user of users) {
    const c = classifyUser(user, now);
    if (!c) continue;
    if (!buckets[c.stage]) buckets[c.stage] = [];
    buckets[c.stage].push({ email: c.email, hoursIdle: c.hoursIdle });
  }

  const byStage: DailyStuckReport['byStage'] = {};
  let totalStuck = 0;
  for (const [stage, entries] of Object.entries(buckets)) {
    const sorted = [...entries].sort((a, b) => b.hoursIdle - a.hoursIdle);
    byStage[stage] = {
      count: entries.length,
      sampleEmails: sorted.slice(0, SAMPLE_EMAILS_PER_STAGE).map((e) => e.email).filter(Boolean),
      oldestHours: sorted[0]?.hoursIdle ?? 0,
    };
    totalStuck += entries.length;
  }

  let trackerUrl: string | null = null;
  if (totalStuck > 0) {
    // Build the per-stage context map. Each stage becomes one bullet in the
    // Linear issue body, sorted by count desc so the biggest funnel leak is
    // first. Tie-break on oldestHours desc so equal-count stages still order
    // by severity.
    const orderedStages = Object.entries(byStage).sort((a, b) => {
      const dc = b[1].count - a[1].count;
      if (dc !== 0) return dc;
      return b[1].oldestHours - a[1].oldestHours;
    });

    const oldestOverall = orderedStages.reduce(
      (max, [, info]) => Math.max(max, info.oldestHours),
      0,
    );

    const context: Record<string, string> = {
      'Total Stuck Users': String(totalStuck),
      'Users Scanned': String(users.length),
      'Stages Affected': String(orderedStages.length),
      'Oldest Stuck (hours)': oldestOverall.toFixed(1),
      'Stuck Threshold (hours)': String(STUCK_HOURS),
    };
    for (const [stage] of orderedStages) {
      context[`Stage: ${stage}`] = formatStageRow(buckets[stage]);
    }

    const date = todayDateString();
    const title = `Onboarding stuck users — daily report ${date}`;
    const description = `${totalStuck} users currently stuck across ${orderedStages.length} onboarding stage(s); oldest has been idle ${oldestOverall.toFixed(1)}h. See Context for per-stage breakdown.`;

    try {
      const { fileAutoIssue } = await import('../services/intakeService');
      const result = await fileAutoIssue({
        title,
        description,
        source: 'Onboarding stuck',
        executionRoute: 'human-triage',
        notionTags: ['Onboarding'],
        notionContext: context,
      });
      trackerUrl = result.url || null;
    } catch (err) {
      console.error('[onboardingStuckDetector] issue filing failed:', err);
      trackerUrl = null;
    }
  }

  return {
    scanned: users.length,
    totalStuck,
    byStage,
    trackerUrl,
  };
}
