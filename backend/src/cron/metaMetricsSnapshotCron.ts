import { userDb, crmDb } from "../services/db";
import { getMetaAccountCredentials } from "../services/metaAccountCredentials";
import {
  adsMetricsDb,
  buildEntityKey,
  ACCOUNT_DAY_SENTINEL,
  AdsPlatform,
} from "../services/adsMetricsDb";
import { META_GRAPH_TIMEOUT_MS } from "../utils/metaApiFetch";
import { promoteAttributionFromCustomFields } from "../types/attribution";

// ENG-916: Haven only, deliberately. Every.io's Meta CAPI gap (ENG-993) means its
// Meta-reported conversions would read as artificially low/zero even with real leads
// landing in the CRM — including it here risks misreading a measurement gap as a real
// performance problem. Add Every.io once ENG-993 ships and is verified the same way
// Haven was.
const HAVEN_USER_ID = "a3917669-1c7d-45ed-8ef9-f454de109b6f";

const META_API_VERSION = process.env.META_API_VERSION || "v25.0";

/**
 * This cron is the Meta ADAPTER. The store it writes to is shared with Google Ads and LinkedIn Ads,
 * but the ingestion deliberately is NOT: the three disagree on units (decimal string vs micros vs
 * local-currency string), pagination (cursor vs page token vs none at all), retention, and — most
 * importantly — how long a reported figure keeps moving. Meta settles at 28 days; Google keeps
 * attributing for up to 90. One cron with one settling window would be wrong for two of the three.
 */
const PLATFORM: AdsPlatform = "meta";

// How many days back from "yesterday" to re-pull and overwrite each run.
//
// Sized against Meta's INSIGHTS MUTABILITY window, which is 28 days — NOT the conversion
// ATTRIBUTION window (~7 days). They are different things and only the former governs when a
// stored row stops moving. Meta, verbatim (Marketing API > Insights > Best Practices):
// "Insights refresh every 15 minutes and do not change after 28 days of being reported",
// plus "metrics may continue updating for a couple of days after an ad completes its run".
// It applies to insights generally, not only to conversion fields.
//
// This was 3, with a TODO asking to confirm against "Meta's actual attribution-window docs" —
// that framing pointed at the 7-day number, which is the wrong window. At 3 we froze a day's row
// while Meta kept revising it for another 25 days, which breaks ENG-885 Phase 1's own gate
// ("stored figures reconcile with Meta Ads Manager to within 1%") in the flattering direction:
// reconcile inside 3 days and it passes, reconcile at day 10 and the gap has opened.
//
// Cost is one Graph call per day per account, so 28 is trivial at this card's Haven-only scope.
// If this ever covers the fleet, TIER it (daily for the recent tail, weekly for days 8-28) —
// the cost multiplies by accounts and by pagination, not just by days.
const SETTLING_WINDOW_DAYS = 28;

/**
 * The spellings a campaign name can legitimately arrive as in a `utm_campaign` value.
 *
 * The `{{campaign.name}}` macro expands into a URL, so the value reaching a lead is percent- or
 * plus-encoded depending on the path it took. Decoding is attempted but never assumed —
 * `decodeURIComponent` THROWS on a malformed sequence (a lone `%`), which is ordinary in
 * hand-written ad URLs, so a failure falls back to the raw value rather than dropping the lead.
 *
 * Deliberately NOT case-folded and NOT otherwise normalised: the macro emits the advertiser's exact
 * name, and folding case would let two genuinely different campaigns collide into one — the same
 * over-normalisation trap that makes two distinct pages share one verdict elsewhere in this codebase.
 */
export function campaignNameKeys(name: unknown): string[] {
  const raw = name === undefined || name === null ? "" : String(name).trim();
  if (!raw) return [];
  const keys = new Set<string>([raw]);
  const plusDecoded = raw.replace(/\+/g, " ");
  keys.add(plusDecoded);
  for (const candidate of [raw, plusDecoded]) {
    try {
      keys.add(decodeURIComponent(candidate));
    } catch {
      // Malformed percent-encoding — keep the undecoded spellings we already have.
    }
  }
  return [...keys].filter(Boolean);
}

function toDateStr(d: Date): string {
  return d.toISOString().split("T")[0];
}

/**
 * Every lead for a user, across all their lists, bucketed by `createdAt` date.
 *
 * ONE walk of each list serves the WHOLE settling window. The per-date helper below must scan
 * every page (see its comment — ordering is by `leadId`, not `createdAt`, so it cannot early-stop),
 * so calling it once per day meant SETTLING_WINDOW_DAYS full walks of every list on every run.
 * At a 28-day window that is ~9x the DynamoDB read load of the original 3-day version for no extra
 * information: the pages are identical each time, only the date filter differs. Bucketing once and
 * indexing by date is strictly less work and changes no behaviour — a date with no leads simply has
 * no entry, which the caller reads as an empty list exactly as before.
 */
async function getLeadsByDateForUser(userId: string): Promise<Map<string, any[]>> {
  const byDate = new Map<string, any[]>();
  const leadLists = await crmDb.getLeadListsByUserId(userId);
  for (const list of leadLists) {
    let lastKey: any = undefined;
    do {
      const { items, lastEvaluatedKey } = await crmDb.getLeadsByListId(list.listId, 100, lastKey);
      for (const lead of items) {
        const leadDate = (lead.createdAt || "").split("T")[0];
        if (!leadDate) continue;
        const bucket = byDate.get(leadDate);
        if (bucket) bucket.push(lead);
        else byDate.set(leadDate, [lead]);
      }
      lastKey = lastEvaluatedKey;
    } while (lastKey);
  }
  return byDate;
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
export interface ResolvedMetaCredentials {
  accountId: string;
  accessToken: string;
}

/**
 * Per-account facts that must be RECORDED on every row rather than inferred later.
 * Resolved once per run with a single Graph call, not per day.
 */
export interface MetaAccountContext {
  currency: string;
  reportingTimezone: string | null;
}

/**
 * One Graph read for the two things the insights response does not carry.
 *
 * `currency` genuinely varies between accounts of the SAME user (mvarma holds Meta accounts in INR
 * and USD), and a mis-stated currency is an ~80x silent error, so it is read from Meta rather than
 * assumed. `timezone_name` is what Meta buckets `date` in — ours are UTC, so without recording it a
 * cross-platform comparison silently mixes different 24-hour windows.
 */
export async function fetchMetaAccountContext(
  accountId: string,
  accessToken: string
): Promise<MetaAccountContext> {
  const url =
    `https://graph.facebook.com/${META_API_VERSION}/act_${accountId}` +
    `?fields=currency,timezone_name&access_token=${accessToken}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(META_GRAPH_TIMEOUT_MS) });
  const body: any = await res.json();
  if (!res.ok || body?.error) {
    throw new Error(`[ENG-916] Meta account context failed: ${body?.error?.message || res.status}`);
  }
  const currency = String(body.currency || "").trim();
  if (!currency) {
    // FAIL CLOSED. A spend figure whose unit is unknown is not a weaker measurement, it is an
    // uninterpretable one — and writing it beside dataQuality: "exact" actively asserts a
    // confidence we do not have. The entire reason currency is stored rather than inferred is that
    // a mis-stated one once reported a $5,000 deal as ₹5,000, ~80x off and silently; an EMPTY
    // currency is the same failure with the evidence removed. Better no row than an unusable one.
    throw new Error(
      `[ENG-916] Meta account ${accountId} returned no currency — refusing to store spend whose unit is unknown`
    );
  }

  return {
    currency,
    // Null is honest here in a way it is not for currency: a missing timezone makes cross-platform
    // day-boundary comparison unsafe, which a consumer can detect and decline, whereas a missing
    // currency makes the number itself meaningless.
    reportingTimezone: body.timezone_name ? String(body.timezone_name) : null,
  };
}

export async function snapshotMetaMetricsForDate(
  userId: string,
  dateStr: string,
  resolvedCredentials?: ResolvedMetaCredentials,
  leadsByDate?: Map<string, any[]>,
  accountContext?: MetaAccountContext
): Promise<SnapshotResult> {
  // Credentials are resolved ONCE PER RUN by runMetaMetricsSnapshot and passed in, because
  // getMetaAccountCredentials reads the user record and can refresh + PERSIST the Meta token
  // inline (fb_exchange_token). Resolving per day meant SETTLING_WINDOW_DAYS redundant reads
  // against a live managed client's record every run, and — once a token finally expires —
  // that many identical CRITICAL ERRORs instead of one. The parameter stays optional so this
  // function is still usable standalone (a future backfill script) without duplicating the
  // resolution.
  let accountId: string;
  let accessToken: string;
  if (resolvedCredentials) {
    ({ accountId, accessToken } = resolvedCredentials);
  } else {
    const user = await userDb.getUserById(userId);
    if (!user) {
      throw new Error(`[ENG-916] User ${userId} not found`);
    }

  // ⚠ SCOPE LIMIT, deliberate while this card is Haven-only: getMetaAccountCredentials returns
  // exactly ONE {accountId, accessToken}. A user with two connected ad accounts therefore gets one
  // snapshotted and NO signal that the others were skipped. One ad account can also sit on several
  // user records (21 connection rows resolve to 15 distinct ad accounts), so a user-keyed read can
  // resolve an account whose leads live under a different record. Widening past Haven means
  // iterating accounts here, not just changing HAVEN_USER_ID.
    ({ accountId, accessToken } = await getMetaAccountCredentials(user, userId));
  }

  // Resolved once per run by the caller; the fallback keeps this function usable standalone.
  const context = accountContext ?? (await fetchMetaAccountContext(accountId, accessToken));

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
    // Bounded deliberately: Node's fetch applies NO default deadline, and these reads run
    // sequentially inside the settling-window loop — so one connection that accepts a request
    // and never completes stalls every remaining day and surfaces as "the cron did not run"
    // rather than as a network fault. AbortSignal.timeout is preferred over a manual controller
    // so no timer can outlive the process.
    const res = await fetch(nextUrl, { signal: AbortSignal.timeout(META_GRAPH_TIMEOUT_MS) });
    const body: any = await res.json();
    if (!res.ok || body?.error) {
      throw new Error(
        `[ENG-916] Meta Insights API failed for ${dateStr}: ${body?.error?.message || res.status}`
      );
    }
    campaignRows.push(...(body?.data || []));
    nextUrl = body?.paging?.next;
  }

  // This user's leads for the date, across all their lists — reused for every campaign's join
  // below rather than re-querying per campaign. runMetaMetricsSnapshot prefetches the whole
  // settling window in one pass and passes it in; the per-list fallback keeps this function
  // usable standalone (a future backfill script) without duplicating the walk.
  let leadsForDate: any[];
  if (leadsByDate) {
    leadsForDate = leadsByDate.get(dateStr) || [];
  } else {
    const leadLists = await crmDb.getLeadListsByUserId(userId);
    leadsForDate = [];
    for (const list of leadLists) {
      const leads = await getLeadsForListOnDate(list.listId, dateStr);
      leadsForDate.push(...leads);
    }
  }

  const knownCampaignIds = new Set(campaignRows.map((c) => String(c.campaign_id)));

  /*
   * NAME FALLBACK — measured 2026-08-25, not speculative.
   *
   * A lead's `utm_campaign` is whatever the ad's `url_tags` macro expanded to, and across the real
   * managed accounts that is NOT reliably the campaign id:
   *   Haven   — 3 of 9 ACTIVE ads carry `{{campaign.id}}`; the other 6 carry no url_tags at all
   *   Phoenix — 46 of 46 ACTIVE ads carry `{{campaign.name}}`, so an id-only join misses 100% of
   *             the portfolio's biggest spender (~$5.6k/7d)
   *
   * Matching name as well as id costs NOTHING — `campaign_name` already comes back in the same
   * insights response — and it takes Phoenix from structurally unjoinable to joining today. The
   * alternative, retagging the ads to `{{campaign.id}}`, is per-ad and manual AND swaps the
   * creative, which RESETS Meta's learning phase. Nobody should pay that to fix a reporting join.
   *
   * ⚠ AMBIGUOUS NAMES ARE EXCLUDED, NOT GUESSED. Meta permits two campaigns to share a name, and a
   * lead tagged with a duplicated name cannot be attributed to either without inventing a fact.
   * Such names are dropped from the map entirely, so those leads land in unattributedLeadCount —
   * visibly uncounted rather than silently misattributed.
   */
  const nameToCampaignId = new Map<string, string>();
  const ambiguousNames = new Set<string>();
  for (const c of campaignRows) {
    for (const key of campaignNameKeys(c.campaign_name)) {
      const existing = nameToCampaignId.get(key);
      if (existing && existing !== String(c.campaign_id)) ambiguousNames.add(key);
      else nameToCampaignId.set(key, String(c.campaign_id));
    }
  }
  // NOTE: ambiguous keys are deliberately LEFT IN the map. They are needed as a positive signal
  // when matching below — deleting them made an ambiguous name merely "absent", which a lead's
  // OTHER spelling could then route around.

  // Named for what it actually is. It counts leads MATCHED to a campaign the platform reported —
  // it is not the day's total, and calling it that made the account_day row able to claim
  // `totalLeadCount: 0` alongside `unattributedLeadCount: 1` (CodeRabbit Major).
  let attributedLeadCount = 0;
  let unattributedLeadCount = 0;
  const leadCountByCampaign = new Map<string, number>();

  for (const lead of leadsForDate) {
    /*
     * ENG-1601: resolve the touch through the promoter, not the raw field.
     *
     * Reading `lead.firstTouch?.utm?.campaign` directly dropped 36% of attributable leads.
     * Measured on Haven, 2026-07-29..08-25: of 36 inbound leads carrying a usable campaign id,
     * 23 had it in `firstTouch` and 13 had it ONLY in `customFields` with no `firstTouch` at all
     * — the same two campaign ids, from the same two campaigns. The attribution arrived; the
     * join looked in one of the two places it can live.
     *
     * `promoteAttributionFromCustomFields` was written for exactly this (ENG-926 §A) and is
     * already used at ingest by routes/webhooks.ts. It GAP-FILLS: a structured value always
     * wins, so a lead with a proper envelope is untouched, and it promotes only an allowlisted
     * set so a free-form bag cannot assert paid acquisition.
     *
     * Why the original passed verification: every end-to-end check ran against Dev CRM, which
     * holds none of Haven's production leads, so the join only ever saw ONE write path.
     *
     * ⚠ STALENESS: the bag carries no timestamp — none of the 13 real leads had a `landing_ts` —
     * so a promoted `utm_campaign` cannot be dated. What bounds it is the join's EXISTING
     * same-day constraint below: `knownCampaignIds` holds only campaigns Meta reported for THIS
     * date, so a tag naming a campaign that was not running cannot match. That bound applies
     * identically to a structured firstTouch, so promotion does not widen the exposure — it
     * applies the same bound to more leads. Pinned by a test.
     */
    const touch = promoteAttributionFromCustomFields(lead.customFields, lead.firstTouch);
    const campaign = touch?.utm?.campaign;
    const raw = campaign === undefined || campaign === null ? "" : String(campaign);
    // Id first — it is exact and unambiguous. Only then name, which is a convention.
    let matchedId: string | undefined;
    if (raw && knownCampaignIds.has(raw)) matchedId = raw;
    else if (raw) {
      /*
       * EVERY spelling is evaluated before deciding — first-match-wins was wrong (CodeRabbit Major).
       * With campaigns named `A+B` and `A B`, only the shared key `A B` was marked ambiguous, so a
       * lead tagged `A+B` matched the raw key and was attributed to the first campaign — even though
       * `+` is a legitimate encoding of the ambiguous `A B`. The lead genuinely could have come from
       * either, so attributing it invents a fact.
       *
       * Attribute ONLY when every spelling agrees on exactly one campaign and none of them is known
       * to be ambiguous. Anything else stays unattributed — visibly uncounted beats silently wrong.
       */
      const resolved = new Set<string>();
      let ambiguous = false;
      for (const key of campaignNameKeys(raw)) {
        if (ambiguousNames.has(key)) { ambiguous = true; break; }
        const hit = nameToCampaignId.get(key);
        if (hit) resolved.add(hit);
      }
      if (!ambiguous && resolved.size === 1) matchedId = [...resolved][0];
    }
    if (matchedId) {
      leadCountByCampaign.set(matchedId, (leadCountByCampaign.get(matchedId) || 0) + 1);
      attributedLeadCount++;
    } else {
      // Not silently dropped — a future UTM-convention drift must be visible, not
      // invisible undercounting.
      unattributedLeadCount++;
    }
  }

  const capturedAt = new Date().toISOString();
  for (const c of campaignRows) {
    const campaignId = String(c.campaign_id);
    await adsMetricsDb.putSnapshot({
      entityKey: buildEntityKey(PLATFORM, accountId, campaignId),
      date: dateStr,
      rowType: "campaign",
      platform: PLATFORM,
      campaignId,
      accountId,
      // Meta has no manager-account hierarchy; Google does (login_customer_id) and fills this.
      parentAccountId: null,
      currency: context.currency,
      reportingTimezone: context.reportingTimezone,
      dataQuality: "exact",
      userId,
      campaignName: c.campaign_name || "",
      spend: parseFloat(c.spend) || 0,
      impressions: parseInt(c.impressions, 10) || 0,
      clicks: parseInt(c.clicks, 10) || 0,
      leadCount: leadCountByCampaign.get(campaignId) || 0,
      // Meta-only rate metrics. Google reports averageCpc instead of cpm and has no frequency at
      // all; LinkedIn reports neither. They live in the bag rather than as columns because the
      // three platforms do not agree on them and never will.
      platformMetrics: {
        ctr: parseFloat(c.ctr) || 0,
        cpm: parseFloat(c.cpm) || 0,
        frequency: parseFloat(c.frequency) || 0,
      },
      snapshotSource: "daily",
      capturedAt,
    });
  }

  // ⚠ ALWAYS WRITTEN — including when campaignRows is EMPTY. That is the whole point.
  //
  // Previously the per-campaign loop above was the only write, so a date on which Meta reported no
  // campaign activity produced NO ROW AT ALL, and a gap in the series was indistinguishable from
  // "the cron never ran for this date" (Greptile P1). A row saying campaignsReported: 0 is a
  // measurement; no row is an absence, and the store exists precisely so a consumer can tell those
  // apart.
  //
  // It also gives unattributedLeadCount a real home. It used to be stamped on EVERY campaign row
  // because there was no campaign-less place to put it, which meant summing N campaign rows
  // reported N x the true figure — the same over-count shape as spendDuringAbsence in the tracking
  // monitor. One row per account per date, so there is nothing left to sum wrongly.
  await adsMetricsDb.putSnapshot({
    entityKey: buildEntityKey(PLATFORM, accountId, ACCOUNT_DAY_SENTINEL),
    date: dateStr,
    rowType: "account_day",
    platform: PLATFORM,
    accountId,
    parentAccountId: null,
    userId,
    currency: context.currency,
    reportingTimezone: context.reportingTimezone,
    dataQuality: "exact",
    campaignId: null,
    campaignName: "",
    spend: 0,
    impressions: 0,
    clicks: 0,
    // Every lead the account received that date, attributed or not. Attributed is derivable as
    // totalLeadCount - unattributedLeadCount, so nothing is lost by storing the honest total —
    // whereas storing only the matched subset under this name silently undercounts the day by
    // exactly the population the store exists to watch for drift in.
    totalLeadCount: attributedLeadCount + unattributedLeadCount,
    unattributedLeadCount,
    campaignsReported: campaignRows.length,
    platformMetrics: {},
    snapshotSource: "daily",
    capturedAt,
  });

  return {
    success: true,
    rowsWritten: campaignRows.length,
    // Deliberately the ATTRIBUTED count — the cron's log line already reads "N attributed leads",
    // and the honest day total lives on the account_day row.
    leadCount: attributedLeadCount,
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

  // Resolve credentials once for the whole run. If they cannot be resolved, NO day can succeed,
  // so fail fast with one clear line rather than repeating the same error once per day.
  let credentials: ResolvedMetaCredentials;
  let accountContext: MetaAccountContext;
  try {
    const user = await userDb.getUserById(HAVEN_USER_ID);
    if (!user) {
      throw new Error(`[ENG-916] User ${HAVEN_USER_ID} not found`);
    }
    credentials = await getMetaAccountCredentials(user, HAVEN_USER_ID);
    accountContext = await fetchMetaAccountContext(credentials.accountId, credentials.accessToken);
  } catch (error) {
    console.error(
      "[MetaMetricsSnapshotCron] CRITICAL ERROR resolving Meta credentials/account context — no days attempted:",
      error
    );
    return;
  }

  // One walk of every list serves all SETTLING_WINDOW_DAYS days. A failure here is fatal to the
  // run for the same reason a credential failure is: every day would repeat the identical error.
  let leadsByDate: Map<string, any[]>;
  try {
    leadsByDate = await getLeadsByDateForUser(HAVEN_USER_ID);
  } catch (error) {
    console.error(
      "[MetaMetricsSnapshotCron] CRITICAL ERROR reading CRM leads — no days attempted:",
      error
    );
    return;
  }

  const today = new Date();
  for (let daysAgo = 1; daysAgo <= SETTLING_WINDOW_DAYS; daysAgo++) {
    const target = new Date(today);
    target.setUTCDate(target.getUTCDate() - daysAgo);
    const dateStr = toDateStr(target);

    try {
      const result = await snapshotMetaMetricsForDate(HAVEN_USER_ID, dateStr, credentials, leadsByDate, accountContext);
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
