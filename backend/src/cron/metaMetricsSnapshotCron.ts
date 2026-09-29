import { userDb, crmDb } from "../services/db";
import { getMetaAccountCredentials, cleanAccountId } from "../services/metaAccountCredentials";
import { isMetaAdAccount } from "../services/metaTokenRefresh";
import { ConnectedAccount } from "../services/connectedAccountsDb";
import {
  adsMetricsDb,
  buildAdEntityKey,
  buildEntityKey,
  ACCOUNT_DAY_SENTINEL,
  AdsPlatform,
} from "../services/adsMetricsDb";
import { leadTotals, type MetaAction } from "../utils/metaActionFamilies";
import { META_GRAPH_TIMEOUT_MS } from "../utils/metaApiFetch";
import { promoteAttributionFromCustomFields, type AttributionTouch } from "../types/attribution";
import { isEvaluationUser } from "../services/evaluationPolicy";

/**
 * ENG-993: Every.io's Meta CAPI gap means its Meta-reported conversions read as
 * artificially low/zero even with real leads landing in the CRM — snapshotting it risks
 * misreading a measurement gap as a real performance problem. Keyed by ACCOUNT id, not
 * userId — the exclusion is a property of that ad account's own data, not of any one
 * `AW-Users` row, and the same account can in principle be reachable from more than one
 * user record (see the doc comment on `enumerateDistinctMetaAdAccounts` below). Add
 * Every.io's account back once ENG-993 ships and is verified the same way Haven was.
 * Resolved via a live, read-only scan of AW-Users on 2026-09-09 — lyndi@every.io's own
 * account, unshared with any other user.
 */
const EXCLUDED_META_ACCOUNT_IDS = new Set<string>(["1358071355944019"]);

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
// Cost is one Graph call per date per account plus pagination. The final two
// refresh dates add a bounded two calls per account to the existing daily pass.
// Keep two additional reporting dates: at the 09:00 UTC run, today-30
// has passed its reporting-day end + 28 elapsed days even at UTC-12.
// This supplies the final settled refresh consumed by ENG-502; no backfill.
const REFRESH_WINDOW_DAYS = 30;

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
 * so calling it once per day meant REFRESH_WINDOW_DAYS full walks of every list on every run.
 * At a 28-day window that is ~9x the DynamoDB read load of the original 3-day version for no extra
 * information: the pages are identical each time, only the date filter differs. Bucketing once and
 * indexing by date is strictly less work and changes no behaviour — a date with no leads simply has
 * no entry, which the caller reads as an empty list exactly as before.
 */
export async function getLeadsByDateForUser(
  userId: string,
  /**
   * Optional inclusive date window. Leads outside it are DISCARDED while paging rather than
   * retained — the cron wants every day in its settling window so it passes nothing, but a
   * backfill processing two days has no reason to hold the account's entire lead history in
   * memory. Purely a retention bound: the same pages are read either way.
   */
  bounds?: { from: string; to: string }
): Promise<Map<string, any[]>> {
  const byDate = new Map<string, any[]>();
  const leadLists = await crmDb.getLeadListsByUserId(userId);
  for (const list of leadLists) {
    let lastKey: any = undefined;
    do {
      const { items, lastEvaluatedKey } = await crmDb.getLeadsByListId(list.listId, 100, lastKey);
      for (const lead of items) {
        const leadDate = (lead.createdAt || "").split("T")[0];
        if (!leadDate) continue;
        if (bounds && (leadDate < bounds.from || leadDate > bounds.to)) continue;
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
 * CRM leads by exact `campaignId` string equality against the campaign id resolved by
 * `promoteAttributionFromCustomFields` (empirically verified for Haven's real ad traffic,
 * not assumed), and writes one row per campaign Meta reported activity for. Also usable
 * by a backfill script without duplicating this logic —
 * `scripts/backfill-eng1601-meta-metrics-history.ts` does exactly that.
 *
 * ⚠ This previously read `firstTouch.utm.campaign` DIRECTLY, and this comment said so. That
 * dropped 36% of attributable leads, because the id lives in `customFields` for leads that
 * have no `firstTouch` at all (ENG-1601). The comment is called out rather than quietly
 * corrected because it survived the fix by two commits, and a stale contract sitting above an
 * exported function is precisely what a backfill author would build against.
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

/** One page of a Meta insights response. */
interface MetaInsightsPage<Row> {
  data?: Row[];
  paging?: { next?: string };
  error?: { message?: string };
}

/** A level=campaign insights row. Meta returns every metric as a decimal string. */
interface CampaignInsightsRow {
  campaign_id: string;
  campaign_name?: string;
  spend: string;
  impressions: string;
  clicks: string;
  ctr: string;
  cpm: string;
  frequency: string;
}

/**
 * Follows Meta's cursor pagination (`paging.next`) until exhausted. A single-page read silently
 * truncated campaigns past the first page, leaving them with no snapshot row and their CRM leads
 * counted as unattributed (ENG-916 Greptile P1 #1).
 */
async function fetchAllInsightsPages<Row>(insightsUrl: string, dateStr: string): Promise<Row[]> {
  const rows: Row[] = [];
  let nextUrl: string | undefined = insightsUrl;
  while (nextUrl) {
    // Bounded deliberately: Node's fetch applies NO default deadline, and these reads run
    // sequentially inside the settling-window loop — so one connection that accepts a request
    // and never completes stalls every remaining day and surfaces as "the cron did not run"
    // rather than as a network fault. AbortSignal.timeout is preferred over a manual controller
    // so no timer can outlive the process.
    const res = await fetch(nextUrl, { signal: AbortSignal.timeout(META_GRAPH_TIMEOUT_MS) });
    const body = (await res.json()) as MetaInsightsPage<Row> | null;
    if (!res.ok || body?.error) {
      throw new Error(
        `[ENG-916] Meta Insights API failed for ${dateStr}: ${body?.error?.message || res.status}`
      );
    }
    rows.push(...(body?.data || []));
    nextUrl = body?.paging?.next;
  }
  return rows;
}

export async function snapshotMetaMetricsForDate(
  userId: string,
  dateStr: string,
  resolvedCredentials?: ResolvedMetaCredentials,
  leadsByDate?: Map<string, any[]>,
  accountContext?: MetaAccountContext,
  /**
   * What produced this row. Defaults to "daily" so the cron is unchanged; a backfill passes
   * "backfill" so the data plane can tell a replayed row from a same-day one. Without it a
   * rewritten history is indistinguishable from what the cron observed live — which matters
   * precisely because a backfill OVERWRITES.
   *
   * Appended LAST on purpose: this function is called positionally, so inserting a parameter
   * anywhere else silently shifts every existing caller's arguments.
   */
  snapshotSource: "daily" | "backfill" = "daily"
): Promise<SnapshotResult> {
  // Credentials are resolved ONCE PER RUN by runMetaMetricsSnapshot and passed in, because
  // getMetaAccountCredentials reads the user record and can refresh + PERSIST the Meta token
  // inline (fb_exchange_token). Resolving per day meant REFRESH_WINDOW_DAYS redundant reads
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

  // ⚠ SCOPE LIMIT of this STANDALONE fallback only (no resolvedCredentials passed in) —
  // getMetaAccountCredentials with no explicit accountId throws if the user has more than
  // one connected Meta account, rather than picking one. `runMetaMetricsSnapshot` below
  // does not hit this path at all: it enumerates every distinct account across every user
  // (`enumerateDistinctMetaAdAccounts`) and always resolves + passes credentials per
  // account, explicit accountId included. This fallback exists only for a future direct
  // caller (e.g. a backfill script) that wants "the one account this user has" — it is not
  // itself account-widened, and doesn't need to be for the cron's own correctness.
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

  const campaignRows = await fetchAllInsightsPages<CampaignInsightsRow>(insightsUrl, dateStr);

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
      snapshotSource,
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
    snapshotSource,
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
 * ENG-2141: ad-level rows are written only when this is exactly "true". Unset in production until
 * OPS-3 (ENG-2148) enables it; the campaign and account_day rows are unaffected either way.
 */
export const AD_LEVEL_SNAPSHOTS_ENV = "META_AD_LEVEL_SNAPSHOTS_ENABLED";

export function isAdLevelSnapshotEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env[AD_LEVEL_SNAPSHOTS_ENV] === "true";
}

/** Video fields Meta returns only for video ads; recorded when present, never defaulted to 0. */
const VIDEO_METRIC_FIELDS: ReadonlyArray<["video_p25_watched_actions" | "video_thruplay_watched_actions", string]> = [
  ["video_p25_watched_actions", "videoP25Watched"],
  ["video_thruplay_watched_actions", "videoThruplayWatched"],
];

/** A level=ad insights row. Metrics arrive as decimal strings; action lists only when non-empty. */
interface AdInsightsRow {
  ad_id?: string;
  ad_name?: string;
  adset_id?: string;
  campaign_id?: string;
  spend?: string;
  impressions?: string;
  clicks?: string;
  ctr?: string;
  cpm?: string;
  frequency?: string;
  actions?: MetaAction[];
  video_p25_watched_actions?: MetaAction[];
  video_thruplay_watched_actions?: MetaAction[];
}

/** Sum of a Meta video action list (`[{action_type: "video_view", value}]`), or null when absent. */
function sumActionValues(actions: MetaAction[] | undefined): number | null {
  if (!Array.isArray(actions) || actions.length === 0) return null;
  let total = 0;
  for (const a of actions) {
    const n = typeof a?.value === "number" ? a.value : parseFloat(String(a?.value ?? ""));
    if (Number.isFinite(n)) total += n;
  }
  return total;
}

/**
 * ENG-2194: 3-second video plays. Meta reports them as the `video_view` entry of `actions` (Ads
 * Manager's "3-second video plays"); `video_play_actions` counts every play start, however short,
 * so it would overstate a hook rate. Null when the ad reported none (image ads).
 */
function threeSecondVideoPlays(actions: MetaAction[] | undefined): number | null {
  return sumActionValues(actions?.filter((a) => a?.action_type === "video_view"));
}

/** The parts of an AW-Leads item the ad-level CRM join reads. */
export interface CrmLeadAttributionFields {
  customFields?: unknown;
  firstTouch?: AttributionTouch;
}

/**
 * ENG-2194: CRM leads per ad, joined on `utm_content`, which our ads carry as Meta's `{{ad.id}}`
 * macro (utils/adUtm.ts). Resolved through promoteAttributionFromCustomFields exactly like the
 * campaign join, and bounded the same way: only ads Meta reported for this date can match, so a
 * lead whose utm_content is anything else (a campaign id, free text) is simply not counted here.
 */
export function countCrmLeadsByAd(
  leads: ReadonlyArray<CrmLeadAttributionFields>,
  reportedAdIds: ReadonlySet<string>
): Map<string, number> {
  const byAd = new Map<string, number>();
  for (const lead of leads) {
    const content = promoteAttributionFromCustomFields(lead.customFields, lead.firstTouch)?.utm?.content;
    const adId = typeof content === "string" ? content.trim() : "";
    if (adId && reportedAdIds.has(adId)) byAd.set(adId, (byAd.get(adId) ?? 0) + 1);
  }
  return byAd;
}

export interface AdSnapshotResult {
  adRowsWritten: number;
}

/**
 * ENG-2141: one row per ad Meta reported activity for on `dateStr` (level=ad insights), so a
 * generated creative linked to its ad (services/creativeLineage.ts) can be compared with that ad's
 * delivery and conversions. Same account context, pagination and overwrite-within-the-refresh-window
 * behaviour as the campaign rows, so each date is rewritten until Meta has settled it; readers
 * decide settledness per row with isMetaRowSettled.
 *
 * `platformLeadCount` is Meta-reported (the `actions` lead family, counted once). When the day's
 * CRM leads are passed, `crmLeadCount` is the ad-level CRM join (countCrmLeadsByAd, ENG-2194); it is
 * omitted when they are not, so "not joined" never reads as "zero CRM leads".
 */
export async function snapshotMetaAdMetricsForDate(
  userId: string,
  dateStr: string,
  resolvedCredentials: ResolvedMetaCredentials,
  accountContext: MetaAccountContext,
  /** Same meaning and position rule as snapshotMetaMetricsForDate's `snapshotSource`. */
  snapshotSource: "daily" | "backfill" = "daily",
  /** This date's CRM leads (getLeadsByDateForUser bucket); omit to skip the CRM join. */
  crmLeadsForDate?: ReadonlyArray<CrmLeadAttributionFields>
): Promise<AdSnapshotResult> {
  const { accountId, accessToken } = resolvedCredentials;
  const insightsUrl =
    `https://graph.facebook.com/${META_API_VERSION}/act_${accountId}/insights` +
    `?fields=ad_id,ad_name,adset_id,campaign_id,spend,impressions,clicks,ctr,cpm,frequency,actions,` +
    VIDEO_METRIC_FIELDS.map(([field]) => field).join(",") +
    `&time_range={'since':'${dateStr}','until':'${dateStr}'}` +
    `&level=ad&access_token=${accessToken}`;
  const adRows = await fetchAllInsightsPages<AdInsightsRow>(insightsUrl, dateStr);
  const crmLeadsByAd = crmLeadsForDate
    ? countCrmLeadsByAd(crmLeadsForDate, new Set(adRows.filter((r) => r?.ad_id).map((r) => String(r.ad_id))))
    : null;

  const capturedAt = new Date().toISOString();
  let written = 0;
  for (const r of adRows) {
    if (!r?.ad_id) continue;
    const adId = String(r.ad_id);
    const platformMetrics: Record<string, number> = {
      ctr: parseFloat(r.ctr ?? "") || 0,
      cpm: parseFloat(r.cpm ?? "") || 0,
      frequency: parseFloat(r.frequency ?? "") || 0,
    };
    for (const [field, key] of VIDEO_METRIC_FIELDS) {
      const value = sumActionValues(r[field]);
      if (value !== null) platformMetrics[key] = value;
    }
    const plays3s = threeSecondVideoPlays(r.actions);
    if (plays3s !== null) platformMetrics.videoPlays3s = plays3s;
    await adsMetricsDb.putAdSnapshot({
      entityKey: buildAdEntityKey(PLATFORM, accountId, adId),
      date: dateStr,
      rowType: "ad",
      platform: PLATFORM,
      accountId,
      parentAccountId: null,
      ownerUserId: userId,
      currency: accountContext.currency,
      reportingTimezone: accountContext.reportingTimezone,
      dataQuality: "exact",
      adId,
      adName: r.ad_name || "",
      adsetId: r.adset_id ? String(r.adset_id) : null,
      campaignId: r.campaign_id ? String(r.campaign_id) : null,
      spend: parseFloat(r.spend ?? "") || 0,
      impressions: parseInt(r.impressions ?? "", 10) || 0,
      clicks: parseInt(r.clicks ?? "", 10) || 0,
      platformLeadCount: leadTotals(r.actions).total,
      ...(crmLeadsByAd ? { crmLeadCount: crmLeadsByAd.get(adId) ?? 0 } : {}),
      platformMetrics,
      snapshotSource,
      capturedAt,
    });
    written++;
  }
  return { adRowsWritten: written };
}

/** One distinct Meta ad account, resolved down to the single user record it will be
 * snapshotted under. */
export interface DistinctMetaAdAccount {
  accountId: string;
  canonicalUserId: string;
  canonicalUser: any;
}

/**
 * Enumerate every distinct Meta ad account reachable from any user's `connected_accounts`,
 * deduped by cleaned account id. `AdsMetricsSnapshotRow`'s primary key is `entityKey`
 * (`platform#accountId#campaignId`) + `date` — `userId` is a plain GSI-read attribute, not
 * part of the key — so writing the same account/date under two different `userId`s is not
 * duplicated work, it is LOSSY: the second write overwrites the first, and whichever
 * `userId` was written last silently wins the GSI read every sharing user's
 * `monitor_lead_volume` call depends on.
 *
 * A shared account is real, not hypothetical — confirmed via a live, read-only scan of
 * `AW-Users` on 2026-09-09: 22 connection rows resolve to 17 distinct accounts, with 3
 * genuine multi-user shares (AgentWeb's own team account, Argusoft's own team account, and
 * a real customer, RankAI, whose account is shared across 3 team members). When an account
 * has more than one connection row, this picks exactly one canonical user deterministically
 * — earliest `connected_accounts[].created_at` wins. `userDb.getAllUsers()` already filters
 * out `deleted_`-prefixed (soft-deleted) userIds, so a deleted user's stale connection row
 * (confirmed real: `dyllan1@rankai.ai`'s row survives under `deleted_...` after their
 * account was removed) is never even a candidate here — no extra filtering needed.
 */
export async function enumerateDistinctMetaAdAccounts(): Promise<DistinctMetaAdAccount[]> {
  const users = await userDb.getAllUsers();
  const byAccountId = new Map<string, Array<{ userId: string; user: any; createdAt: string }>>();

  for (const user of users) {
    // ENG-1907: a sandbox principal's Meta connection is simulated; never snapshot it.
    // getAllUsers already excludes these — this keeps the cron correct even if a caller opts in.
    if (isEvaluationUser((user as any).userId)) continue;
    const raw = (user as any).connected_accounts;
    const accounts: ConnectedAccount[] = Array.isArray(raw) ? raw : [];
    for (const account of accounts) {
      if (!isMetaAdAccount(account)) continue;
      const accountId = cleanAccountId(account.account_id || (account.config as any)?.ad_account_id || "");
      if (!accountId) continue;
      const entry = { userId: (user as any).userId, user, createdAt: account.created_at || "" };
      const existing = byAccountId.get(accountId);
      if (existing) existing.push(entry);
      else byAccountId.set(accountId, [entry]);
    }
  }

  const result: DistinctMetaAdAccount[] = [];
  for (const [accountId, entries] of byAccountId) {
    // Earliest created_at wins. A missing/empty created_at sorts LAST (treated as
    // "unknown", never picked over a real timestamp) rather than first.
    const canonical = entries.reduce((best, cur) => {
      const bestTime = best.createdAt ? Date.parse(best.createdAt) : Infinity;
      const curTime = cur.createdAt ? Date.parse(cur.createdAt) : Infinity;
      return curTime < bestTime ? cur : best;
    });
    result.push({ accountId, canonicalUserId: canonical.userId, canonicalUser: canonical.user });
  }
  return result;
}

/**
 * Cron entry point — for every distinct Meta ad account (see
 * `enumerateDistinctMetaAdAccounts`), re-pulls and overwrites the last
 * REFRESH_WINDOW_DAYS days (excluding today, which is never complete) every run. Each
 * ACCOUNT is isolated (one account's credential/CRM failure does not stop the others), and
 * within an account each DAY is isolated the same way it always was.
 */
export async function runMetaMetricsSnapshot(): Promise<void> {
  console.log("[MetaMetricsSnapshotCron] Starting execution...");

  let accounts: DistinctMetaAdAccount[];
  try {
    accounts = (await enumerateDistinctMetaAdAccounts()).filter(
      (a) => !EXCLUDED_META_ACCOUNT_IDS.has(a.accountId)
    );
  } catch (error) {
    console.error(
      "[MetaMetricsSnapshotCron] CRITICAL ERROR enumerating Meta ad accounts — no accounts attempted:",
      error
    );
    return;
  }
  console.log(`[MetaMetricsSnapshotCron] ${accounts.length} distinct Meta ad account(s) to snapshot.`);
  const adLevel = isAdLevelSnapshotEnabled();

  for (const { accountId, canonicalUserId, canonicalUser } of accounts) {
    // Resolve credentials once per ACCOUNT (not per day, and not once for the whole run —
    // each account is its own credential/CRM scope). If they cannot be resolved, no day
    // for THIS account can succeed, so fail fast for this account and continue with the
    // next rather than repeating the same error once per day, or aborting the whole run.
    let credentials: ResolvedMetaCredentials;
    let accountContext: MetaAccountContext;
    try {
      credentials = await getMetaAccountCredentials(canonicalUser, canonicalUserId, accountId);
      accountContext = await fetchMetaAccountContext(credentials.accountId, credentials.accessToken);
    } catch (error) {
      console.error(
        `[MetaMetricsSnapshotCron] CRITICAL ERROR resolving credentials/account context for account ${accountId} (user ${canonicalUserId}) — no days attempted for this account:`,
        error
      );
      continue;
    }

    // One walk of every list serves all REFRESH_WINDOW_DAYS days for this account's
    // canonical user. A failure here is fatal to this account for the same reason a
    // credential failure is, but does not affect any other account.
    let leadsByDate: Map<string, any[]>;
    try {
      leadsByDate = await getLeadsByDateForUser(canonicalUserId);
    } catch (error) {
      console.error(
        `[MetaMetricsSnapshotCron] CRITICAL ERROR reading CRM leads for account ${accountId} (user ${canonicalUserId}) — no days attempted for this account:`,
        error
      );
      continue;
    }

    const today = new Date();
    for (let daysAgo = 1; daysAgo <= REFRESH_WINDOW_DAYS; daysAgo++) {
      const target = new Date(today);
      target.setUTCDate(target.getUTCDate() - daysAgo);
      const dateStr = toDateStr(target);

      try {
        const result = await snapshotMetaMetricsForDate(canonicalUserId, dateStr, credentials, leadsByDate, accountContext);
        console.log(
          `[MetaMetricsSnapshotCron] account ${accountId} ${dateStr}: wrote ${result.rowsWritten} campaign rows, ` +
            `${result.leadCount} attributed leads, ${result.unattributedLeadCount} unattributed`
        );
      } catch (error) {
        // A missed day is recoverable later (Meta retains historical insights data) —
        // but only if the miss is visible. Never fail silently.
        console.error(`[MetaMetricsSnapshotCron] CRITICAL ERROR for account ${accountId} ${dateStr}:`, error);
      }

      // ENG-2141: isolated from the campaign pass above — a failed ad read never costs the day's
      // campaign rows, and a failed campaign read does not skip the ad rows.
      if (adLevel) {
        try {
          const { adRowsWritten } = await snapshotMetaAdMetricsForDate(
            canonicalUserId, dateStr, credentials, accountContext, "daily", leadsByDate.get(dateStr) ?? []
          );
          console.log(`[MetaMetricsSnapshotCron] account ${accountId} ${dateStr}: wrote ${adRowsWritten} ad rows`);
        } catch (error) {
          console.error(`[MetaMetricsSnapshotCron] CRITICAL ERROR (ad level) for account ${accountId} ${dateStr}:`, error);
        }
      }
    }
  }

  console.log("[MetaMetricsSnapshotCron] Execution completed.");
}
