/**
 * Onboarding stuck/abandoned user detector.
 *
 * Runs hourly. Scans users with an `onboardingStage` that's not yet terminal
 * and fires `reportUIError` for users who haven't progressed in N hours.
 * The 30-min dedup in errorReporter prevents repeated alerts for the same
 * stuck user — a Notion task fires once per fingerprint per dedup window.
 *
 * Together with PR A's silent-error capture, this closes the loop on
 * onboarding observability:
 *   - PR A: real-time error capture (LLM failures, FE swallows)
 *   - this:  stuck/abandoned-user detection (no errors, just inactivity)
 *
 * Both routes flow through the same reportUIError → Notion oncall pipeline,
 * so Rui investigates from one Notion view regardless of whether the user
 * hit an error or just stopped responding.
 *
 * Tuning:
 *   STUCK_HOURS — last event > N hours ago, stage NOT in terminal set
 *     (default 1h — catches users idle on a building/review screen)
 *   ABANDON_HOURS — last event > N hours ago AND stage was advanced past
 *     signed_up_no_start (default 24h — distinguishes real abandonment
 *     from a user who just signed up minutes ago)
 *
 * Both fire reportUIError but with different operation tags so Rui can
 * triage by severity. Stuck = "user is on a screen waiting", Abandoned =
 * "user closed the tab and never came back".
 */
import { userDb } from '../services/db';
import { reportUIError } from '../utils/errorReporter';

const STUCK_HOURS = Number(process.env.ONBOARDING_STUCK_HOURS ?? '1');
const ABANDON_HOURS = Number(process.env.ONBOARDING_ABANDON_HOURS ?? '24');

// Stages that indicate the user has finished. We don't want to alert on
// these — by definition they're done. Sourced from utils/onboardingStage.ts
// (do not import to avoid a circular dep risk; keep this set in sync).
const TERMINAL_STAGES = new Set<string>(['onboarding_completed', 'active']);

// Stages that indicate the user has ENGAGED past signup. Used to filter the
// abandonment check — a user who just signed up 5 minutes ago and hasn't
// done anything yet isn't "abandoned", they're just new.
const ENGAGED_STAGES = new Set<string>([
  'goal_selected',
  'brand_submitted',
  'brand_skipped',
  'data_connected',
  'data_skipped',
  'channel_connected',
  'channel_selected',
  'icp_selected',
  'value_prop_edited',
  'ads_generated',
  'ads_regenerated',
  'welcome_offer_shown',
  'welcome_offer_outcome',
  'brand_build_status',
]);

interface StuckCandidate {
  userId: string;
  email: string;
  stage: string;
  lastEventTs: string | null;
  hoursSinceLastEvent: number;
  classification: 'stuck' | 'abandoned';
}

function classifyUser(
  user: any,
  now: number,
): StuckCandidate | null {
  const stage = user?.onboardingStage as string | undefined;
  if (!stage) return null;
  if (TERMINAL_STAGES.has(stage)) return null;

  const events = Array.isArray(user.onboardingEvents) ? user.onboardingEvents : [];
  const lastEvent = events.length > 0 ? events[events.length - 1] : null;
  const lastEventTs = lastEvent?.ts ?? user.createdAt ?? null;
  if (!lastEventTs) return null;

  const lastMs = Date.parse(lastEventTs);
  if (!Number.isFinite(lastMs)) return null;
  const hoursSinceLastEvent = (now - lastMs) / (60 * 60 * 1000);

  // Abandonment first — strictly stricter test, takes priority.
  if (ENGAGED_STAGES.has(stage) && hoursSinceLastEvent >= ABANDON_HOURS) {
    return {
      userId: user.userId,
      email: user.email ?? '',
      stage,
      lastEventTs,
      hoursSinceLastEvent,
      classification: 'abandoned',
    };
  }
  if (hoursSinceLastEvent >= STUCK_HOURS) {
    return {
      userId: user.userId,
      email: user.email ?? '',
      stage,
      lastEventTs,
      hoursSinceLastEvent,
      classification: 'stuck',
    };
  }
  return null;
}

export async function runOnboardingStuckDetector(): Promise<{
  scanned: number;
  fired: number;
  byClassification: Record<string, number>;
}> {
  const now = Date.now();
  // hideBotLike=true skips test/smoketest accounts and Gmail dot-trick bots.
  // This is a Slack-noise reduction — bots fail "onboarding" all the time
  // because they never finish; alerting on them is pure noise.
  const users = await userDb.getAllUsers(true);
  let fired = 0;
  const byClassification: Record<string, number> = { stuck: 0, abandoned: 0 };

  for (const user of users) {
    const c = classifyUser(user, now);
    if (!c) continue;
    byClassification[c.classification] = (byClassification[c.classification] ?? 0) + 1;
    fired += 1;

    void reportUIError({
      operation: `onboarding:${c.classification}`,
      errorMessage: `User ${c.email || c.userId} ${c.classification} at stage=${c.stage} for ${c.hoursSinceLastEvent.toFixed(1)}h`,
      userId: c.userId,
      context: {
        Source: 'cron',
        Detector: 'onboardingStuckDetector',
        Stage: c.stage,
        'Hours Since Last Event': c.hoursSinceLastEvent.toFixed(2),
        'Last Event Ts': c.lastEventTs ?? '',
      },
    });
  }

  return { scanned: users.length, fired, byClassification };
}
