/**
 * Drip campaigns — Execution + Safety (Phase A: multi-tenant, CRM-scoped).
 *
 * Cron-driven drip email executor. Runs every 15 minutes in prod/dev, reads
 * active campaigns from `AW-DripCampaigns`, and for each campaign segments
 * its owner's CRM leads (AW-Leads, scoped to the campaign's userId) instead
 * of broadcasting across AW-Users. That makes drip a customer-facing
 * product feature — each tenant runs their own campaigns against their
 * own leads.
 *
 * Safety gates (in order — short-circuit on first fail):
 *   1. Global kill switch — `DRIP_CAMPAIGNS_ENABLED=false` in env disables all sends.
 *   2. Per-campaign kill switch — `killSwitch=true` on the campaign record.
 *   3. Per-campaign active flag — `isActive=false` → skip.
 *   4. maxSends cap — lead already received `maxSends` of this campaign.
 *   5. Cadence gate — lead's last send for this campaign was within cadence window.
 *   6. Unsubscribe flag — `lead.contactStatus === 'unsubscribed'` or `do-not-contact`.
 *   7. Hourly rate limit — campaign already sent `DRIP_MAX_PER_HOUR` emails in
 *      the last 60 minutes.
 *   8. Dry-run flag — `DRIP_DRY_RUN=true` (default) records DripSend rows with
 *      status='dry_run' and does NOT call the real email provider.
 *
 * Dry-run is the DEFAULT. Real sends require `DRIP_DRY_RUN=false` AND
 * `DRIP_CAMPAIGNS_ENABLED=true` — two explicit env flips, because this writes
 * to real user inboxes.
 *
 * See Phase 3 config surface: backend/src/services/dripCampaignDb.ts
 * See Notion: https://www.notion.so/34709247c951814f90d8f109e5883882
 */

import { userDb } from "../services/db";
import {
  getDripCampaignDb,
  DripCampaign,
  renderTemplate,
} from "../services/dripCampaignDb";
import { getDripSendsDb } from "../services/dripSendsDb";
import { emailService } from "../services/emailService";

/**
 * Default per-campaign per-hour rate cap. Keeps a misconfigured cron from
 * blasting the entire lead base in one tick. Override with `DRIP_MAX_PER_HOUR`.
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

/**
 * Minimal Lead shape the executor cares about. Matches the AW-Leads row
 * fields used by segmentation + merge-field rendering. Declared locally so
 * this file doesn't depend on a full DB type, which keeps the DI surface
 * tiny and tests trivial.
 */
export interface DripLead {
  listId: string;
  leadId: string;
  userId?: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  company?: string;
  lifecycle?: string;
  heatScore?: number;
  utmSource?: string;
  contactStatus?: "active" | "do-not-contact" | "unsubscribed" | string;
  [key: string]: any;
}

/** Dependency-injection surface — makes unit tests trivial. */
export interface ExecutorDeps {
  /** All currently-active, non-paused campaigns across all tenants. */
  listActiveCampaigns: () => Promise<DripCampaign[]>;
  /**
   * Load the candidate leads for a single campaign. Implementation queries
   * AW-Leads via the owner's lead lists and applies the CRM-criteria
   * segment filter. Returning only candidates (not every lead) keeps the
   * tick budget in check on large tenants.
   */
  listLeadsForCampaign: (campaign: DripCampaign) => Promise<DripLead[]>;
  countSendsForUserCampaign: (
    leadKey: string,
    campaignId: string,
  ) => Promise<number>;
  getMostRecentSendAt: (
    leadKey: string,
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

/**
 * Load leads for a campaign by pulling its owner's lead lists and filtering
 * by the CRM criteria in `segmentQuery`. If `leadListId` is set, only that
 * list is scanned. Exported for test seams.
 *
 * Kept pure-ish: `userDb.getLeadListsByUserId` + `userDb.getLeadsByListId`
 * are the only DB touches; the rest is in-memory filter. No cross-tenant
 * reads possible here because lead lists are indexed by `userId` (see
 * `getLeadListsByUserId` + `userId-index` GSI on AW-LeadLists).
 */
export async function defaultListLeadsForCampaign(
  campaign: DripCampaign,
): Promise<DripLead[]> {
  if (!campaign.userId) return [];
  const q = campaign.segmentQuery ?? {};

  // Resolve candidate lead lists — all the user's lists unless narrowed.
  let listIds: string[] = [];
  if (q.leadListId) {
    // Confirm the caller actually owns this list — otherwise bail with
    // empty set so cross-tenant misconfigurations are silent no-ops,
    // not a leak.
    const ownerLists = await (userDb as any).getLeadListsByUserId(
      campaign.userId,
    );
    const owned = (ownerLists as Array<{ listId: string }>).some(
      (l) => l.listId === q.leadListId,
    );
    if (!owned) return [];
    listIds = [q.leadListId];
  } else {
    const lists = (await (userDb as any).getLeadListsByUserId(
      campaign.userId,
    )) as Array<{ listId: string }>;
    listIds = lists.map((l) => l.listId);
  }

  // Pull every lead in those lists (paginate).
  const leads: DripLead[] = [];
  for (const listId of listIds) {
    let lastEvaluatedKey: any = undefined;
    do {
      const page = (await (userDb as any).getLeadsByListId(
        listId,
        undefined,
        lastEvaluatedKey,
      )) as { items: DripLead[]; lastEvaluatedKey: any };
      leads.push(...(page.items ?? []));
      lastEvaluatedKey = page.lastEvaluatedKey;
    } while (lastEvaluatedKey);
  }

  return leads.filter((lead) => leadMatchesSegment(lead, campaign));
}

/** Default real-world deps wired to production services. */
function defaultDeps(): ExecutorDeps {
  return {
    listActiveCampaigns: () => getDripCampaignDb().listActiveAllTenants(),
    listLeadsForCampaign: (campaign) => defaultListLeadsForCampaign(campaign),
    countSendsForUserCampaign: (leadKey, campaignId) =>
      getDripSendsDb().countSendsForUserCampaign(leadKey, campaignId),
    getMostRecentSendAt: (leadKey, campaignId) =>
      getDripSendsDb().getMostRecentSendAt(leadKey, campaignId),
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
 * `true` or `1`.
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
 * Check whether `lead` matches `campaign.segmentQuery`. CRM criteria only in
 * Phase A — lifecycle / minHeatScore / utmSource are the supported filters.
 * Exported so tests + the `get_leads_by_crm_criteria` tool share one code path.
 */
export function leadMatchesSegment(
  lead: DripLead,
  campaign: DripCampaign,
): boolean {
  const q = campaign.segmentQuery ?? {};

  if (q.lifecycle) {
    if (lead.lifecycle !== q.lifecycle) return false;
  }

  if (typeof q.minHeatScore === "number") {
    const score =
      typeof lead.heatScore === "number" && Number.isFinite(lead.heatScore)
        ? lead.heatScore
        : 0;
    if (score < q.minHeatScore) return false;
  }

  if (q.utmSource) {
    if (lead.utmSource !== q.utmSource) return false;
  }

  // leadListId is enforced at the DB-read layer (we only pull leads from
  // that list), but re-check here for defense-in-depth.
  if (q.leadListId) {
    if (lead.listId !== q.leadListId) return false;
  }

  return true;
}

/**
 * Extract merge-field values for a lead. Kept small + pure — no DB calls.
 * Uses the same field allowlist as the Phase 3 preview endpoint. For leads
 * (vs users), `lastStep` / `goal` are not applicable and default to empty.
 */
export function buildMergeFields(lead: DripLead): {
  firstName: string;
  companyName: string;
  lastStep: string;
  goal: string;
} {
  const firstName = (lead.firstName || "").trim();
  const companyName = (lead.company || "").trim();
  // lastStep / goal are user-onboarding concepts. Leads do not have them,
  // so they render as empty strings (renderTemplate handles that safely).
  return { firstName, companyName, lastStep: "", goal: "" };
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
 * concurrent ticks can both pass the same lead's maxSends / cadence gate and
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

  for (const campaign of campaigns) {
    // Gate 2+3 — per-campaign active + killSwitch (belt-and-braces; list
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

    // Pull candidate leads for this campaign (owner's AW-Leads, filtered
    // by CRM criteria).
    const candidates = await deps.listLeadsForCampaign(campaign);
    summary.candidatesConsidered += candidates.length;

    for (const lead of candidates) {
      if (remainingInWindow <= 0) {
        bump("rate_limit_exceeded");
        summary.emailsSkipped += 1;
        continue;
      }

      // Gate 6 — unsubscribe / do-not-contact flag on the lead
      if (
        lead.contactStatus === "unsubscribed" ||
        lead.contactStatus === "do-not-contact"
      ) {
        bump("unsubscribed");
        summary.emailsSkipped += 1;
        continue;
      }

      // Sanity — lead needs an email address
      if (!lead.email) {
        bump("no_email");
        summary.emailsSkipped += 1;
        continue;
      }

      // DripSends rows are keyed by (listId, leadId) instead of user userId
      // now. Build a stable per-lead key so cadence + maxSends queries still
      // hit the right index.
      const leadKey = `${lead.listId}:${lead.leadId}`;

      // Gate 4 — maxSends
      const prior = await deps.countSendsForUserCampaign(
        leadKey,
        campaign.campaignId,
      );
      if (prior >= campaign.maxSends) {
        bump("max_sends_reached");
        summary.emailsSkipped += 1;
        continue;
      }

      // Gate 5 — cadence
      const lastSentIso = await deps.getMostRecentSendAt(
        leadKey,
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
      const merge = buildMergeFields(lead);
      const html = renderTemplate(campaign.templateHtml, merge);
      const subject = renderTemplate(campaign.subjectLine, merge);

      // Gate 8 — dry-run
      if (summary.dryRun) {
        try {
          await deps.recordSend({
            campaignId: campaign.campaignId,
            userId: leadKey,
            email: lead.email,
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
            `[DripExecutor] Failed to record dry-run for lead ${leadKey} campaign ${campaign.campaignId}:`,
            err,
          );
          summary.emailsFailed += 1;
        }
        continue;
      }

      // Real send
      try {
        const { messageId } = await deps.sendEmail({
          to: lead.email,
          subject,
          html,
        });
        await deps.recordSend({
          campaignId: campaign.campaignId,
          userId: leadKey,
          email: lead.email,
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
          `[DripExecutor] Send failed for lead ${leadKey} campaign ${campaign.campaignId}:`,
          msg,
        );
        // Best-effort record the failure so support can trace it
        try {
          await deps.recordSend({
            campaignId: campaign.campaignId,
            userId: leadKey,
            email: lead.email,
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
