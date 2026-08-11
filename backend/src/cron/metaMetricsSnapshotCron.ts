import { userDb, crmDb } from "../services/db";
import { getMetaAccountCredentials } from "../services/metaAccountCredentials";
import { metaAdsMetricsDb } from "../services/metaAdsMetricsDb";

// ENG-916: Haven only, deliberately. Every.io's Meta CAPI gap (ENG-993) means its
// Meta-reported conversions would read as artificially low/zero even with real leads
// landing in the CRM — including it here risks misreading a measurement gap as a real
// performance problem. Add Every.io once ENG-993 ships and is verified the same way
// Haven was.
const HAVEN_USER_ID = "a3917669-1c7d-45ed-8ef9-f454de109b6f";

const META_API_VERSION = process.env.META_API_VERSION || "v25.0";

// How many days back from "yesterday" to re-pull and overwrite each run. Ad platforms
// keep attributing click-through conversions back to a day for a while after it ends —
// pulling a day only once would let our stored number silently drift out of sync with
// what Meta's own dashboard shows for that same day later. This is a starting
// assumption, not a researched attribution-window constant — confirm against Meta's
// actual attribution-window docs and adjust if it needs to be longer.
const SETTLING_WINDOW_DAYS = 3;

function toDateStr(d: Date): string {
  return d.toISOString().split("T")[0];
}

/**
 * Leads for a single list on a single date. Scans every page for the list rather than
 * early-stopping on the first lead whose `createdAt` sorts before the target date.
 *
 * An early-stop optimization would only be safe if pages arrived in `createdAt` order, but
 * `crmDb.getLeadsByListId` orders by `leadId` (ScanIndexForward: false — newest leadId
 * first), not by `createdAt`. Those two orderings are not guaranteed to agree (e.g. a lead
 * whose `createdAt` was backdated, imported, or otherwise set independently of when its
 * leadId was assigned), so an older-`createdAt` lead can sort ahead of a target-date lead
 * that only shows up on a later page — stopping early would silently drop it from the
 * persisted campaign counts (ENG-916 Greptile P1 #2). Full-page scan is the correct
 * behavior until the query is actually ordered by `createdAt` (would need a new GSI on
 * `AW-Leads`, a database/data-plane change out of scope here).
 */
async function getLeadsForListOnDate(listId: string, dateStr: string): Promise<any[]> {
  const matches: any[] = [];
  let lastKey: any = undefined;
  do {
    const { items, lastEvaluatedKey } = await crmDb.getLeadsByListId(listId, 100, lastKey);
    for (const lead of items) {
      const leadDate = (lead.createdAt || "").split("T")[0];
      if (leadDate === dateStr) {
        matches.push(lead);
      }
    }
    lastKey = lastEvaluatedKey;
  } while (lastKey);
  return matches;
}

export interface SnapshotResult {
  success: boolean;
  rowsWritten: number;
  leadCount: number;
  unattributedLeadCount: number;
}

/**
 * Shared per-day snapshot logic — pulls Meta's campaign-level insights for exactly one
 * date (dynamic campaign discovery, never a hardcoded list), joins against that day's
 * CRM leads by exact `campaignId` === `firstTouch.utm.campaign` string equality
 * (empirically verified for Haven's real ad traffic, not assumed), and writes one row
 * per campaign Meta reported activity for. Also usable by a future backfill script
 * without duplicating this logic.
 */
export async function snapshotMetaMetricsForDate(
  userId: string,
  dateStr: string
): Promise<SnapshotResult> {
  const user = await userDb.getUserById(userId);
  if (!user) {
    throw new Error(`[ENG-916] User ${userId} not found`);
  }

  const { accountId, accessToken } = await getMetaAccountCredentials(user, userId);

  // No campaign filter — this IS the dynamic-discovery step. Meta's level=campaign
  // insights query returns one row per campaign that had any activity in the window,
  // so a campaign launched or paused after this code shipped is picked up automatically.
  const insightsUrl =
    `https://graph.facebook.com/${META_API_VERSION}/act_${accountId}/insights` +
    `?fields=campaign_id,campaign_name,spend,impressions,clicks,ctr,cpm,frequency` +
    `&time_range={'since':'${dateStr}','until':'${dateStr}'}` +
    `&level=campaign&access_token=${accessToken}`;

  // Follow Meta's cursor pagination (`paging.next`) until exhausted. A single-page read
  // silently truncated campaigns past the first page, leaving them with no snapshot row and
  // their CRM leads counted as unattributed (ENG-916 Greptile P1 #1).
  const campaignRows: any[] = [];
  let nextUrl: string | undefined = insightsUrl;
  while (nextUrl) {
    const res = await fetch(nextUrl);
    const body: any = await res.json();
    if (!res.ok || body?.error) {
      throw new Error(
        `[ENG-916] Meta Insights API failed for ${dateStr}: ${body?.error?.message || res.status}`
      );
    }
    campaignRows.push(...(body?.data || []));
    nextUrl = body?.paging?.next;
  }

  // Resolve this user's leads for the date once, across all their lists — reused for
  // every campaign's join below rather than re-querying per campaign.
  const leadLists = await crmDb.getLeadListsByUserId(userId);
  const leadsForDate: any[] = [];
  for (const list of leadLists) {
    const leads = await getLeadsForListOnDate(list.listId, dateStr);
    leadsForDate.push(...leads);
  }

  const knownCampaignIds = new Set(campaignRows.map((c) => String(c.campaign_id)));
  let totalLeadCount = 0;
  let unattributedLeadCount = 0;
  const leadCountByCampaign = new Map<string, number>();

  for (const lead of leadsForDate) {
    const campaign = lead.firstTouch?.utm?.campaign;
    if (campaign && knownCampaignIds.has(String(campaign))) {
      leadCountByCampaign.set(String(campaign), (leadCountByCampaign.get(String(campaign)) || 0) + 1);
      totalLeadCount++;
    } else {
      // Not silently dropped — a future UTM-convention drift must be visible, not
      // invisible undercounting.
      unattributedLeadCount++;
    }
  }

  const capturedAt = new Date().toISOString();
  for (const c of campaignRows) {
    const campaignId = String(c.campaign_id);
    await metaAdsMetricsDb.putSnapshot({
      campaignId,
      date: dateStr,
      accountId,
      userId,
      campaignName: c.campaign_name || "",
      spend: parseFloat(c.spend) || 0,
      impressions: parseInt(c.impressions, 10) || 0,
      clicks: parseInt(c.clicks, 10) || 0,
      ctr: parseFloat(c.ctr) || 0,
      cpm: parseFloat(c.cpm) || 0,
      frequency: parseFloat(c.frequency) || 0,
      leadCount: leadCountByCampaign.get(campaignId) || 0,
      // Account-wide for the date, not per-campaign — the same total is stamped on every
      // campaign row for this date/user since there's no campaign-less place to persist it.
      // Previously hardcoded to 0, which made a real lost-attribution count indistinguishable
      // from a genuine zero (ENG-916 Greptile P1 #3); the value now survives past the cron's
      // own log line.
      unattributedLeadCount,
      snapshotSource: "daily",
      capturedAt,
    });
  }

  return {
    success: true,
    rowsWritten: campaignRows.length,
    leadCount: totalLeadCount,
    unattributedLeadCount,
  };
}

/**
 * Cron entry point — re-pulls and overwrites the last SETTLING_WINDOW_DAYS days
 * (excluding today, which is never complete) every run. Each day is isolated: one
 * day's failure is logged clearly and does not stop the others from running.
 */
export async function runMetaMetricsSnapshot(): Promise<void> {
  console.log("[MetaMetricsSnapshotCron] Starting execution...");

  const today = new Date();
  for (let daysAgo = 1; daysAgo <= SETTLING_WINDOW_DAYS; daysAgo++) {
    const target = new Date(today);
    target.setUTCDate(target.getUTCDate() - daysAgo);
    const dateStr = toDateStr(target);

    try {
      const result = await snapshotMetaMetricsForDate(HAVEN_USER_ID, dateStr);
      console.log(
        `[MetaMetricsSnapshotCron] ${dateStr}: wrote ${result.rowsWritten} campaign rows, ` +
          `${result.leadCount} attributed leads, ${result.unattributedLeadCount} unattributed`
      );
    } catch (error) {
      // A missed day is recoverable later (Meta retains historical insights data) —
      // but only if the miss is visible. Never fail silently.
      console.error(`[MetaMetricsSnapshotCron] CRITICAL ERROR for ${dateStr}:`, error);
    }
  }

  console.log("[MetaMetricsSnapshotCron] Execution completed.");
}
