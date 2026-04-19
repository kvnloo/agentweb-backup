/**
 * Lifecycle Drip Phase 4 — Execution + Safety.
 *
 * Cron-driven drip email executor. Runs every 15 minutes in prod/dev, reads
 * active campaigns from `AW-DripCampaigns`, segments users with the Phase 1/2
 * helpers (`getAllUsers` + `deriveOnboardingStage`), applies safety gates, and
 * dispatches emails via the existing `emailService`.
 *
 * Safety gates (in order — short-circuit on first fail):
 *   1. Global kill switch — `DRIP_CAMPAIGNS_ENABLED=false` in env disables all sends.
 *   2. Per-campaign kill switch — `killSwitch=true` on the campaign record.
 *   3. Per-campaign active flag — `isActive=false` → skip.
 *   4. maxSends cap — user already received `maxSends` of this campaign.
 *   5. Cadence gate — user's last send for this campaign was within cadence window.
 *   6. Unsubscribe flag — `user.dripUnsubscribed === true`.
 *   7. Hourly rate limit — campaign already sent `DRIP_MAX_PER_HOUR` emails in
 *      the last 60 minutes.
 *   8. Dry-run flag — `DRIP_DRY_RUN=true` (default) records DripSend rows with
 *      status='dry_run' and does NOT call the real email provider.
 *
 * Dry-run is the DEFAULT. Real sends require `DRIP_DRY_RUN=false` AND
 * `DRIP_CAMPAIGNS_ENABLED=true` — two explicit env flips, because this writes
 * to real user inboxes. Getting only one right leaves us safe.
 *
 * See Phase 3 config surface: backend/src/services/dripCampaignDb.ts
 * See Phase 2 segmentation: backend/src/routes/onboardingEvents.ts
 * See Notion: Lifecycle drip Phase 4 — Execution + Safety
 */

import { userDb, User } from "../services/db";
import {
  getDripCampaignDb,
  DripCampaign,
  renderTemplate,
} from "../services/dripCampaignDb";
import { getDripSendsDb } from "../services/dripSendsDb";
import { emailService } from "../services/emailService";
import { deriveOnboardingStage } from "../utils/onboardingStage";

/**
 * Default per-campaign per-hour rate cap. Keeps a misconfigured cron from
 * blasting the entire user base in one tick. Override with `DRIP_MAX_PER_HOUR`.
 */
export const DEFAULT_MAX_PER_HOUR = 50;

export interface ExecutorRunSummary {
  campaignsConsidered: number;
  campaignsSkipped: number;
  candidatesConsidered: number;
  emailsSent: number;
  emailsFailed: number;
  emailsSkipped: number;
  dryRuns: number;
  skippedReasons: Record<string, number>;
  dryRun: boolean;
  globalKillSwitch: boolean;
}

/** Dependency-injection surface — makes unit tests trivial. */
export interface ExecutorDeps {
  listActiveCampaigns: () => Promise<DripCampaign[]>;
  listAllUsers: () => Promise<User[]>;
  countSendsForUserCampaign: (
    userId: string,
    campaignId: string,
  ) => Promise<number>;
  getMostRecentSendAt: (
    userId: string,
    campaignId: string,
  ) => Promise<string | null>;
  countSendsInWindow: (
    campaignId: string,
    sinceIso: string,
  ) => Promise<number>;
  recordSend: (args: {
    campaignId: string;
    userId: string;
    email: string;
    templateSnapshot: string;
    subjectSnapshot: string;
    messageId: string | null;
    status: "sent" | "failed" | "dry_run";
    error?: string;
    dryRun: boolean;
  }) => Promise<void>;
  sendEmail: (args: {
    to: string;
    subject: string;
    html: string;
  }) => Promise<{ messageId: string }>;
  now: () => Date;
  env: {
    DRIP_CAMPAIGNS_ENABLED?: string;
    DRIP_DRY_RUN?: string;
    DRIP_MAX_PER_HOUR?: string;
  };
}

/** Default real-world deps wired to production services. */
function defaultDeps(): ExecutorDeps {
  return {
    listActiveCampaigns: () => getDripCampaignDb().listActive(),
    listAllUsers: () => userDb.getAllUsers(),
    countSendsForUserCampaign: (userId, campaignId) =>
      getDripSendsDb().countSendsForUserCampaign(userId, campaignId),
    getMostRecentSendAt: (userId, campaignId) =>
      getDripSendsDb().getMostRecentSendAt(userId, campaignId),
    countSendsInWindow: (campaignId, sinceIso) =>
      getDripSendsDb().countSendsInWindow(campaignId, sinceIso),
    recordSend: async (args) => {
      await getDripSendsDb().record(args);
    },
    sendEmail: async ({ to, subject, html }) => {
      // Use `sendEmailStrict` — it throws on transporter failure and returns
      // the real provider messageId. The non-strict `emailService.sendEmail`
      // swallows errors and returns void, which would let the executor record
      // status='sent' for an email that never left the box. For an audited,
      // compliance-adjacent send path like drip, ground truth matters.
      // Text body = stripped HTML (minimal — mail client fallback).
      const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      const { messageId } = await emailService.sendEmailStrict(
        to,
        subject,
        text,
        html,
      );
      return { messageId };
    },
    now: () => new Date(),
    env: process.env as any,
  };
}

/**
 * Is global kill switch engaged?
 *
 * Defaults to DISABLED (kill switch engaged) unless env explicitly says
 * `true` or `1`. This is a hard no-send default — operators have to opt in
 * per-env to actually send drip emails.
 */
export function isGloballyEnabled(env: ExecutorDeps["env"]): boolean {
  const raw = (env.DRIP_CAMPAIGNS_ENABLED ?? "").toLowerCase().trim();
  return raw === "true" || raw === "1";
}

/**
 * Is dry-run mode active?
 *
 * Defaults to TRUE (safe). Real sends require an explicit
 * `DRIP_DRY_RUN=false` in env. Any other value → dry run.
 */
export function isDryRun(env: ExecutorDeps["env"]): boolean {
  const raw = (env.DRIP_DRY_RUN ?? "true").toLowerCase().trim();
  return !(raw === "false" || raw === "0");
}

/** Parse the rate-limit env with sane fallback. */
export function getMaxPerHour(env: ExecutorDeps["env"]): number {
  const raw = env.DRIP_MAX_PER_HOUR;
  if (!raw) return DEFAULT_MAX_PER_HOUR;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0 || !Number.isInteger(parsed)) {
    return DEFAULT_MAX_PER_HOUR;
  }
  return parsed;
}

/**
 * Check whether `user` matches `campaign.segmentQuery`. Reproduces the Phase 2
 * HTTP-endpoint filter logic in-process so the executor doesn't need to
 * self-HTTP-call for every tick.
 */
export function userMatchesSegment(
  user: User,
  campaign: DripCampaign,
): boolean {
  const q = campaign.segmentQuery ?? {};

  // Stage filter
  if (q.stage) {
    const derivedStage =
      (user as any).onboardingStage ||
      deriveOnboardingStage(
        ((user as any).onboardingEvents ?? []) as any,
        { lastActiveAt: user.lastActiveAt },
      );
    if (derivedStage !== q.stage) return false;
  }

  // Activity cutoff — user's lastActiveAt must be strictly before the cutoff.
  // Users with no lastActiveAt are EXCLUDED (same rule as Phase 2).
  if (q.lastActivityBefore) {
    const cutoff = Date.parse(q.lastActivityBefore);
    if (Number.isNaN(cutoff)) return false;
    if (typeof user.lastActiveAt !== "string" || !user.lastActiveAt) {
      return false;
    }
    const la = Date.parse(user.lastActiveAt);
    if (Number.isNaN(la) || la >= cutoff) return false;
  }

  // Goal filter — pull latest `goal_selected` event's data.goal
  if (q.goal) {
    const events = ((user as any).onboardingEvents ?? []) as Array<{
      event: string;
      ts: string;
      data?: any;
    }>;
    const goalEvents = events
      .filter((e) => e?.event === "goal_selected")
      .slice()
      .sort((a, b) => Date.parse(b.ts || "") - Date.parse(a.ts || ""));
    const latestGoal = goalEvents
      .map((e) => (typeof e.data?.goal === "string" ? e.data.goal : null))
      .find((g) => !!g);
    if (latestGoal !== q.goal) return false;
  }

  return true;
}

/**
 * Extract merge-field values for a user. Kept small + pure — no DB calls.
 * Uses the same field allowlist as the Phase 3 preview endpoint.
 */
export function buildMergeFields(user: User): {
  firstName: string;
  companyName: string;
  lastStep: string;
  goal: string;
} {
  const display = user.displayName || "";
  const firstName = display.trim().split(/\s+/)[0] || "";
  const companyName = (user as any).companyName || "";
  const events = ((user as any).onboardingEvents ?? []) as Array<{
    event: string;
    ts: string;
    data?: any;
  }>;
  const sortedDesc = events
    .slice()
    .sort((a, b) => Date.parse(b.ts || "") - Date.parse(a.ts || ""));
  const lastStep = sortedDesc[0]?.event || "";
  const goalEvent = sortedDesc.find((e) => e.event === "goal_selected");
  const goal =
    (goalEvent?.data?.goal && typeof goalEvent.data.goal === "string"
      ? goalEvent.data.goal
      : "") || "";
  return { firstName, companyName, lastStep, goal };
}

function cadenceWindowMs(c: DripCampaign): number {
  const unitMs =
    c.cadenceUnit === "hours"
      ? 60 * 60 * 1000
      : c.cadenceUnit === "weeks"
        ? 7 * 24 * 60 * 60 * 1000
        : 24 * 60 * 60 * 1000; // days (default)
  return c.cadenceValue * unitMs;
}

/**
 * Module-level in-flight guard.
 *
 * If one tick runs longer than DRIP_INTERVAL_MS (15 min) — slow scans over a
 * large audit table, DynamoDB throttling, provider back-pressure — the next
 * `setInterval` callback fires while the previous one is still running. Two
 * concurrent ticks can both pass the same user's maxSends / cadence gate and
 * then both record a send, because the idempotency guarantee of the safety
 * gates assumes serialized execution.
 *
 * This guard serializes ticks at the process level: if a tick is already in
 * flight when `runDripExecutor` is invoked, log and return a no-op summary.
 * Tests with `{ skipInFlightGuard: true }` for direct invocation without
 * touching global state.
 */
let tickInFlight = false;
export function _resetInFlightGuardForTests(): void {
  tickInFlight = false;
}

/**
 * Main entry — runs one executor tick. Returns a summary that the caller
 * (cron setInterval callback) can log.
 */
export async function runDripExecutor(
  overrideDeps?: Partial<ExecutorDeps> & { skipInFlightGuard?: boolean },
): Promise<ExecutorRunSummary> {
  const skipInFlightGuard = overrideDeps?.skipInFlightGuard === true;
  // Strip the flag before merging — it's not part of ExecutorDeps.
  const { skipInFlightGuard: _ignored, ...depOverrides } =
    overrideDeps ?? ({} as Partial<ExecutorDeps> & { skipInFlightGuard?: boolean });
  void _ignored;
  const deps: ExecutorDeps = { ...defaultDeps(), ...depOverrides };
  const now = deps.now();
  const summary: ExecutorRunSummary = {
    campaignsConsidered: 0,
    campaignsSkipped: 0,
    candidatesConsidered: 0,
    emailsSent: 0,
    emailsFailed: 0,
    emailsSkipped: 0,
    dryRuns: 0,
    skippedReasons: {},
    dryRun: isDryRun(deps.env),
    globalKillSwitch: !isGloballyEnabled(deps.env),
  };

  const bump = (reason: string) => {
    summary.skippedReasons[reason] = (summary.skippedReasons[reason] ?? 0) + 1;
  };

  // In-flight guard — serialize ticks at the process level.
  if (!skipInFlightGuard) {
    if (tickInFlight) {
      console.log(
        "[DripExecutor] Previous tick still in flight. Skipping this tick.",
      );
      bump("tick_in_flight");
      return summary;
    }
    tickInFlight = true;
  }

  try {
    return await _runDripExecutorBody(deps, now, summary, bump);
  } finally {
    if (!skipInFlightGuard) {
      tickInFlight = false;
    }
  }
}

async function _runDripExecutorBody(
  deps: ExecutorDeps,
  now: Date,
  summary: ExecutorRunSummary,
  bump: (reason: string) => void,
): Promise<ExecutorRunSummary> {
  // Gate 1: global kill switch.
  if (!isGloballyEnabled(deps.env)) {
    console.log(
      "[DripExecutor] Global kill switch engaged (DRIP_CAMPAIGNS_ENABLED != true). Skipping tick.",
    );
    return summary;
  }

  const maxPerHour = getMaxPerHour(deps.env);
  const hourAgo = new Date(now.getTime() - 60 * 60 * 1000).toISOString();

  const campaigns = await deps.listActiveCampaigns();
  summary.campaignsConsidered = campaigns.length;

  if (campaigns.length === 0) {
    console.log("[DripExecutor] No active campaigns.");
    return summary;
  }

  const allUsers = await deps.listAllUsers();
  const nonDeletedUsers = allUsers.filter(
    (u) => !u.userId?.startsWith("deleted_"),
  );

  for (const campaign of campaigns) {
    // Gate 2+3 — per-campaign active + killSwitch (belt-and-braces; listActive
    // should already filter these, but don't trust it blindly).
    if (!campaign.isActive || campaign.killSwitch) {
      summary.campaignsSkipped += 1;
      bump("campaign_paused");
      continue;
    }

    // Gate 7 — per-campaign hourly rate limit.
    const sentInWindow = await deps.countSendsInWindow(
      campaign.campaignId,
      hourAgo,
    );
    let remainingInWindow = Math.max(0, maxPerHour - sentInWindow);
    if (remainingInWindow <= 0) {
      summary.campaignsSkipped += 1;
      bump("rate_limit_exceeded");
      console.log(
        `[DripExecutor] Campaign ${campaign.campaignId} hit hourly rate limit (${sentInWindow}/${maxPerHour}). Skipping.`,
      );
      continue;
    }

    // Segment users
    const candidates = nonDeletedUsers.filter((u) =>
      userMatchesSegment(u, campaign),
    );
    summary.candidatesConsidered += candidates.length;

    for (const user of candidates) {
      if (remainingInWindow <= 0) {
        bump("rate_limit_exceeded");
        summary.emailsSkipped += 1;
        continue;
      }

      // Gate 6 — unsubscribe
      if ((user as any).dripUnsubscribed === true) {
        bump("unsubscribed");
        summary.emailsSkipped += 1;
        continue;
      }

      // Sanity — user needs an email address
      if (!user.email) {
        bump("no_email");
        summary.emailsSkipped += 1;
        continue;
      }

      // Gate 4 — maxSends
      const prior = await deps.countSendsForUserCampaign(
        user.userId,
        campaign.campaignId,
      );
      if (prior >= campaign.maxSends) {
        bump("max_sends_reached");
        summary.emailsSkipped += 1;
        continue;
      }

      // Gate 5 — cadence
      const lastSentIso = await deps.getMostRecentSendAt(
        user.userId,
        campaign.campaignId,
      );
      if (lastSentIso) {
        const lastSentMs = Date.parse(lastSentIso);
        if (!Number.isNaN(lastSentMs)) {
          const windowMs = cadenceWindowMs(campaign);
          if (now.getTime() - lastSentMs < windowMs) {
            bump("cadence_not_met");
            summary.emailsSkipped += 1;
            continue;
          }
        }
      }

      // Build merge fields + render
      const merge = buildMergeFields(user);
      const html = renderTemplate(campaign.templateHtml, merge);
      const subject = renderTemplate(campaign.subjectLine, merge);

      // Gate 8 — dry-run
      if (summary.dryRun) {
        try {
          await deps.recordSend({
            campaignId: campaign.campaignId,
            userId: user.userId,
            email: user.email,
            templateSnapshot: html,
            subjectSnapshot: subject,
            messageId: null,
            status: "dry_run",
            dryRun: true,
          });
          summary.dryRuns += 1;
          remainingInWindow -= 1;
        } catch (err) {
          console.error(
            `[DripExecutor] Failed to record dry-run for user ${user.userId} campaign ${campaign.campaignId}:`,
            err,
          );
          summary.emailsFailed += 1;
        }
        continue;
      }

      // Real send
      try {
        const { messageId } = await deps.sendEmail({
          to: user.email,
          subject,
          html,
        });
        await deps.recordSend({
          campaignId: campaign.campaignId,
          userId: user.userId,
          email: user.email,
          templateSnapshot: html,
          subjectSnapshot: subject,
          messageId,
          status: "sent",
          dryRun: false,
        });
        summary.emailsSent += 1;
        remainingInWindow -= 1;
      } catch (err) {
        summary.emailsFailed += 1;
        const msg = err instanceof Error ? err.message : String(err);
        console.error(
          `[DripExecutor] Send failed for user ${user.userId} campaign ${campaign.campaignId}:`,
          msg,
        );
        // Best-effort record the failure so support can trace it
        try {
          await deps.recordSend({
            campaignId: campaign.campaignId,
            userId: user.userId,
            email: user.email,
            templateSnapshot: html,
            subjectSnapshot: subject,
            messageId: null,
            status: "failed",
            error: msg,
            dryRun: false,
          });
        } catch (recordErr) {
          console.error(
            "[DripExecutor] Also failed to record the failure:",
            recordErr,
          );
        }
        // Don't count the failed send against the rate limit budget — the
        // email never went out, so retrying within the window is fine.
      }
    }
  }

  console.log(
    `[DripExecutor] Tick complete. considered=${summary.campaignsConsidered} sent=${summary.emailsSent} dry_runs=${summary.dryRuns} failed=${summary.emailsFailed} skipped=${summary.emailsSkipped} reasons=${JSON.stringify(summary.skippedReasons)}`,
  );
  return summary;
}
