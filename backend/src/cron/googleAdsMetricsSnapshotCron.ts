import { userDb } from "../services/db";
import { googleAdsService } from "../services/googleAdsService";
import { ConnectedAccount, GoogleAdsConfig } from "../services/connectedAccountsDb";
import {
  adsMetricsDb,
  buildEntityKey,
  ACCOUNT_DAY_SENTINEL,
  AdsPlatform,
} from "../services/adsMetricsDb";

/**
 * This cron is the Google Ads ADAPTER for the shared AW-AdsMetricsSnapshots store (see
 * services/adsMetricsDb.ts). It writes CAMPAIGN and ACCOUNT_DAY rows only — ad-level rows and
 * CRM lead attribution are explicitly out of scope here (ENG-2215 narrows ENG-2128's original
 * "Google Ads ad-level lineage and snapshot rows" ask down to a read-only campaign/account
 * snapshot; linking a generated creative to the Google Ads ad it became is tracked separately
 * and is NOT attempted by this file).
 *
 * The store is shared with Meta and LinkedIn, but the ingestion deliberately is NOT
 * (metaMetricsSnapshotCron.ts's own header comment says the same thing for the same reason):
 * the three platforms disagree on units, pagination, retention and settling windows.
 *   - Units: Google reports cost as MICROS (millionths of the currency unit) — cost_micros AND
 *     average_cpc, even though average_cpc's field name carries no `_micros` suffix. Meta's
 *     ingestion assumes a decimal currency string; that assumption would under-report every
 *     currency figure here by 6 orders of magnitude. See microsToCurrency below.
 *   - Pagination: Google uses a page-token model. This cron does not re-implement it — it reuses
 *     googleAdsService.search, which already follows `nextPageToken` to exhaustion (bounded by
 *     its own MAX_PAGES safety cap) — but it DOES own the decision of what to do if that cap is
 *     ever hit: refuse to write a day it cannot prove is complete (see the `truncated` check).
 *   - Settling window: Google's click-through conversion lookback window can be configured up to
 *     90 days (Google Ads Help, "About conversion windows": "any integer between 1 and 90 days"),
 *     and reported metrics continue moving for days/weeks after the click as conversions keep
 *     landing against past dates. That is a materially longer tail than Meta's 28-day insights
 *     mutability window, so REFRESH_WINDOW_DAYS below is sized off Google's number, not Meta's.
 *
 * Account enumeration and credential/token-refresh handling are NOT reimplemented here — this
 * reuses googleAdsService.getAccountCredentials (routes/googleAdsAuth.ts's own connect flow,
 * services/googleAdsService.ts) exactly as every other Google Ads read in this codebase does.
 */
const PLATFORM: AdsPlatform = "google_ads";

/**
 * How many days back from "yesterday" to re-pull and overwrite each run.
 *
 * Sized off Google's own MAXIMUM click-through conversion lookback window (90 days — Google Ads
 * Help "About conversion windows": configurable 1-90 days, and recent data always understates
 * final performance because conversions keep landing against past dates for as long as that
 * window allows). +2 days is the same worst-case-timezone buffer Meta's REFRESH_WINDOW_DAYS uses
 * (adsMetricsDb.ts's LATEST_DAY_END_MS): a reporting day in an account timezone as far behind UTC
 * as UTC-12 can still be "today" for up to 12 hours after UTC midnight, so the final settled
 * refresh needs a couple of extra days of margin past the raw window to guarantee it lands after
 * the day has actually closed everywhere.
 *
 * This is deliberately NOT the same constant as Meta's 30 — freezing a Google Ads row at day 30
 * would still be inside Google's own attribution window for another 60 days, which is exactly the
 * "reconcile early and call it settled" trap META_INSIGHTS_SETTLING_DAYS exists to avoid on the
 * Meta side.
 */
const REFRESH_WINDOW_DAYS = 92;

function toDateStr(d: Date): string {
  return d.toISOString().split("T")[0];
}

/**
 * Google Ads reports MONEY fields as micros (millionths of the account's currency unit) —
 * `metrics.cost_micros` AND `metrics.average_cpc` (verified against Google's API reference:
 * average_cpc is documented as "DOUBLE ... expressed in micros" despite its field name carrying
 * no `_micros` suffix, unlike cost_micros/cost_per_conversion). Any Google Ads money field read
 * from this API must go through this, never be stored raw — a raw micros value stored as if it
 * were already currency reads as ~1,000,000x the real figure.
 */
function microsToCurrency(value: string | number | undefined): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n / 1_000_000 : 0;
}

/** A `campaign` resource row from the level-campaign GAQL query below. Google's REST JSON returns
 * every field camelCased and every int64/money value as a numeric string. */
interface CampaignMetricsRow {
  campaign?: { id?: string | number; name?: string };
  metrics?: {
    impressions?: string | number;
    clicks?: string | number;
    costMicros?: string | number;
    conversions?: string | number;
    ctr?: string | number;
    averageCpc?: string | number;
  };
}

export interface ResolvedGoogleAdsCredentials {
  customerId: string;
  accessToken: string;
  /** The manager (MCC) id when this leaf is reached through one; equals customerId otherwise. */
  loginCustomerId: string;
}

/** Per-account facts that must be RECORDED on every row rather than inferred later. */
export interface GoogleAdsAccountContext {
  currency: string;
  reportingTimezone: string | null;
}

/**
 * One GAQL read for the two things the campaign insights query does not carry.
 *
 * Read LIVE rather than trusted from the stored connected-account config (which
 * googleAdsService.getAccountCredentials defaults to 'USD' when absent) for the same reason
 * Meta's fetchMetaAccountContext reads live rather than trusting a cache: `currency` genuinely
 * varies between accounts, and a mis-stated one is a silent, multi-order-of-magnitude error in
 * every spend figure stored under it.
 */
/** A `customer` resource row from the account-context GAQL query below. */
interface CustomerContextRow {
  customer?: { currencyCode?: string; timeZone?: string };
}

export async function fetchGoogleAdsAccountContext(
  customerId: string,
  accessToken: string,
  loginCustomerId: string
): Promise<GoogleAdsAccountContext> {
  const rows = (await googleAdsService.search(
    customerId,
    accessToken,
    "SELECT customer.currency_code, customer.time_zone FROM customer LIMIT 1",
    loginCustomerId
  )) as CustomerContextRow[];
  const currency = String(rows[0]?.customer?.currencyCode || "").trim();
  if (!currency) {
    // FAIL CLOSED — see fetchMetaAccountContext's identical guard and comment. A spend figure
    // whose unit is unknown is not a weaker measurement, it is an uninterpretable one.
    throw new Error(
      `[ENG-2215] Google Ads account ${customerId} returned no currency — refusing to store spend whose unit is unknown`
    );
  }
  const timeZone = rows[0]?.customer?.timeZone;
  return {
    currency,
    reportingTimezone: timeZone ? String(timeZone) : null,
  };
}

export interface GoogleAdsSnapshotResult {
  success: boolean;
  rowsWritten: number;
}

/**
 * Shared per-day snapshot logic — pulls Google Ads' campaign-level metrics for exactly one date
 * (dynamic campaign discovery: no hardcoded campaign list, campaigns with no activity that date
 * simply do not appear in the result) and writes one row per campaign Google reported activity
 * for, plus one account_day row (always, even when zero campaigns reported — see the comment
 * above that write).
 *
 * `dryRun` runs the exact same read and pagination path and returns the same rowsWritten count,
 * but never calls adsMetricsDb — used by the standalone dry-run script
 * (scripts/googleAdsMetricsSnapshotDryRun.ts) so a read-only verification pass against real prod
 * data exercises the identical query/conversion code the live cron uses, not a parallel copy of it.
 */
export async function snapshotGoogleAdsMetricsForDate(
  userId: string,
  dateStr: string,
  resolvedCredentials: ResolvedGoogleAdsCredentials,
  accountContext: GoogleAdsAccountContext,
  snapshotSource: "daily" | "backfill" = "daily",
  dryRun = false
): Promise<GoogleAdsSnapshotResult> {
  const { customerId, accessToken, loginCustomerId } = resolvedCredentials;

  const query =
    "SELECT campaign.id, campaign.name, metrics.impressions, metrics.clicks, metrics.cost_micros, " +
    "metrics.conversions, metrics.ctr, metrics.average_cpc FROM campaign " +
    `WHERE segments.date = '${dateStr}'`;

  // googleAdsService.search already follows nextPageToken to exhaustion — see the module
  // header. `completeness` is the out-param it sets when its own MAX_PAGES cap stopped the walk
  // with rows still unread.
  const completeness: { truncated?: boolean } = {};
  const campaignRows = (await googleAdsService.search(
    customerId,
    accessToken,
    query,
    loginCustomerId,
    completeness
  )) as CampaignMetricsRow[];

  if (completeness.truncated) {
    // A page cap stopping a SINGLE DAY's campaign read is implausible (it would take ~500k
    // campaigns active in one account on one date) but not impossible, and a short day here
    // would read as "the account under-spent" rather than "we stopped reading" — exactly the
    // silent under-report this cron exists to avoid. Refuse the whole day rather than write a
    // partial one.
    throw new Error(
      `[ENG-2215] Google Ads campaign read for account ${customerId} ${dateStr} was truncated — refusing to write a partial day`
    );
  }

  // Manager (MCC) id only when this leaf is actually reached through one — see the doc comment
  // on AdsMetricsSnapshotRow.parentAccountId. A standalone account's loginCustomerId equals its
  // own customerId, which is not a "parent" of anything.
  const parentAccountId = loginCustomerId && loginCustomerId !== customerId ? loginCustomerId : null;
  const capturedAt = new Date().toISOString();

  for (const row of campaignRows) {
    const campaignId = row.campaign?.id !== undefined ? String(row.campaign.id) : "";
    if (!campaignId) continue; // Defensive only — GAQL always returns the selected key field.

    if (dryRun) continue;

    await adsMetricsDb.putSnapshot({
      entityKey: buildEntityKey(PLATFORM, customerId, campaignId),
      date: dateStr,
      rowType: "campaign",
      platform: PLATFORM,
      campaignId,
      accountId: customerId,
      parentAccountId,
      currency: accountContext.currency,
      reportingTimezone: accountContext.reportingTimezone,
      dataQuality: "exact",
      userId,
      campaignName: row.campaign?.name || "",
      spend: microsToCurrency(row.metrics?.costMicros),
      impressions: parseInt(String(row.metrics?.impressions ?? "0"), 10) || 0,
      clicks: parseInt(String(row.metrics?.clicks ?? "0"), 10) || 0,
      // Google-only metrics that don't survive normalisation. `ctr` and `conversions` are plain
      // ratios/counts; `averageCpc` is ALSO in micros (see microsToCurrency's doc comment) so it
      // is converted the same way spend is, never stored raw.
      platformMetrics: {
        ctr: Number(row.metrics?.ctr ?? 0) || 0,
        averageCpc: microsToCurrency(row.metrics?.averageCpc),
        conversions: Number(row.metrics?.conversions ?? 0) || 0,
      },
      snapshotSource,
      capturedAt,
    });
  }

  // ALWAYS written — including when campaignRows is EMPTY — for the identical reason Meta's
  // account_day row is (see metaMetricsSnapshotCron.ts): a date with campaignsReported: 0 is a
  // measurement ("Google reported no activity"); no row at all is an absence ("we never
  // collected this date"), and the store exists precisely so a consumer can tell those apart.
  //
  // No lead-attribution fields (totalLeadCount / unattributedLeadCount) are populated — those
  // are optional on AdsMetricsSnapshotRow specifically because not every platform's ingestion
  // does the CRM join, and Google's utm/CRM attribution join is out of scope for this cron.
  if (!dryRun) {
    await adsMetricsDb.putSnapshot({
      entityKey: buildEntityKey(PLATFORM, customerId, ACCOUNT_DAY_SENTINEL),
      date: dateStr,
      rowType: "account_day",
      platform: PLATFORM,
      accountId: customerId,
      parentAccountId,
      userId,
      currency: accountContext.currency,
      reportingTimezone: accountContext.reportingTimezone,
      dataQuality: "exact",
      campaignId: null,
      campaignName: "",
      spend: 0,
      impressions: 0,
      clicks: 0,
      campaignsReported: campaignRows.length,
      platformMetrics: {},
      snapshotSource,
      capturedAt,
    });
  }

  return { success: true, rowsWritten: campaignRows.length };
}

/** One distinct Google Ads account, resolved down to the single user record it will be
 * snapshotted under. */
export interface DistinctGoogleAdsAccount {
  customerId: string;
  canonicalUserId: string;
}

/**
 * Enumerate every distinct Google Ads account reachable from any user's `connected_accounts`,
 * deduped by customer id. Mirrors enumerateDistinctMetaAdAccounts's reasoning exactly:
 * `AdsMetricsSnapshotRow`'s primary key is `entityKey` (`platform#accountId#campaignId`) + `date`
 * — `userId` is a plain GSI-read attribute, not part of the key — so writing the same account/date
 * under two different `userId`s is not duplicated work, it is LOSSY (the second write silently
 * wins). When an account has more than one connection row this picks exactly one canonical user
 * deterministically — earliest `connected_accounts[].created_at` wins, same tie-break as Meta's.
 *
 * Unlike Meta, Google Ads has exactly one connected-account shape for this platform (there is no
 * page/Instagram-style split to filter out — see GoogleAdsConfig in connectedAccountsDb.ts), so
 * this needs no isMetaAdAccount-equivalent predicate: `platform === 'google_ads'` is sufficient.
 *
 * `userDb.getAllUsers()` already excludes soft-deleted (`deleted_`-prefixed) and sandbox/
 * evaluation userIds — see its own filter — so no extra filtering is needed here either.
 */
export async function enumerateDistinctGoogleAdsAccounts(): Promise<DistinctGoogleAdsAccount[]> {
  const users = await userDb.getAllUsers();
  const byCustomerId = new Map<string, Array<{ userId: string; createdAt: string }>>();

  for (const user of users) {
    // `User.connected_accounts` (services/db.ts) is a narrower, stale inline type that predates
    // `google_ads` being added to PlatformType — it is read here as `unknown` and re-typed
    // through the real, current `ConnectedAccount` shape (connectedAccountsDb.ts), the same
    // widen-then-narrow every other reader of this field has to do.
    const raw: unknown = user.connected_accounts;
    const accounts: ConnectedAccount[] = Array.isArray(raw) ? (raw as ConnectedAccount[]) : [];
    for (const account of accounts) {
      if (account.platform !== "google_ads") continue;
      const cfg = account.config as GoogleAdsConfig;
      const customerId = String(account.account_id || cfg?.customer_id || "").trim();
      if (!customerId) continue;
      const entry = { userId: user.userId, createdAt: account.created_at || "" };
      const existing = byCustomerId.get(customerId);
      if (existing) existing.push(entry);
      else byCustomerId.set(customerId, [entry]);
    }
  }

  const result: DistinctGoogleAdsAccount[] = [];
  for (const [customerId, entries] of byCustomerId) {
    // Earliest created_at wins; a missing/empty created_at sorts LAST rather than first.
    const canonical = entries.reduce((best, cur) => {
      const bestTime = best.createdAt ? Date.parse(best.createdAt) : Infinity;
      const curTime = cur.createdAt ? Date.parse(cur.createdAt) : Infinity;
      return curTime < bestTime ? cur : best;
    });
    result.push({ customerId, canonicalUserId: canonical.userId });
  }
  return result;
}

/**
 * Inert by default. `GOOGLE_ADS_METRICS_SNAPSHOT_ENABLED=true` is the OPS switch (mirrors every
 * other new cron this cycle — EVAL_V2_SAMPLER_ENABLED, FAILURE_REPLAY_NIGHTLY_ENABLED,
 * CREATIVE_CALIBRATION_ENABLED, CREATIVE_CONTENT_CHECKS_ENABLED — all default-off).
 */
export const GOOGLE_ADS_METRICS_SNAPSHOT_ENV = "GOOGLE_ADS_METRICS_SNAPSHOT_ENABLED";

export function isGoogleAdsMetricsSnapshotEnabled(
  env: Record<string, string | undefined> = process.env
): boolean {
  return env[GOOGLE_ADS_METRICS_SNAPSHOT_ENV] === "true";
}

export interface GoogleAdsMetricsSnapshotOptions {
  /** GOOGLE_ADS_METRICS_SNAPSHOT_ENABLED. A live run refuses without it; dryRun bypasses this. */
  enabled: boolean;
  /** Read and compute, write nothing — see snapshotGoogleAdsMetricsForDate's `dryRun` param. */
  dryRun: boolean;
}

export type GoogleAdsMetricsSnapshotSummary =
  | { status: "refused"; reason: "flag_off" }
  | { status: "ran"; accountsAttempted: number; datesAttempted: number; rowsWritten: number };

/**
 * Cron entry point — for every distinct Google Ads account (see
 * enumerateDistinctGoogleAdsAccounts), re-pulls and overwrites the last REFRESH_WINDOW_DAYS days
 * (excluding today, which is never complete) every run. Each ACCOUNT is isolated (one account's
 * credential/API failure does not stop the others), and within an account each DAY is isolated
 * the same way.
 */
export async function runGoogleAdsMetricsSnapshot(
  opts: GoogleAdsMetricsSnapshotOptions = { enabled: isGoogleAdsMetricsSnapshotEnabled(), dryRun: false }
): Promise<GoogleAdsMetricsSnapshotSummary> {
  if (!opts.dryRun && !opts.enabled) {
    console.log(
      `[GoogleAdsMetricsSnapshotCron] Disabled (${GOOGLE_ADS_METRICS_SNAPSHOT_ENV} is not "true") — no accounts attempted.`
    );
    return { status: "refused", reason: "flag_off" };
  }

  console.log(`[GoogleAdsMetricsSnapshotCron] Starting execution${opts.dryRun ? " (DRY RUN)" : ""}...`);

  let accounts: DistinctGoogleAdsAccount[];
  try {
    accounts = await enumerateDistinctGoogleAdsAccounts();
  } catch (error) {
    console.error(
      "[GoogleAdsMetricsSnapshotCron] CRITICAL ERROR enumerating Google Ads accounts — no accounts attempted:",
      error
    );
    return { status: "ran", accountsAttempted: 0, datesAttempted: 0, rowsWritten: 0 };
  }
  console.log(`[GoogleAdsMetricsSnapshotCron] ${accounts.length} distinct Google Ads account(s) to snapshot.`);

  let datesAttempted = 0;
  let rowsWritten = 0;

  for (const { customerId, canonicalUserId } of accounts) {
    let credentials: ResolvedGoogleAdsCredentials;
    let accountContext: GoogleAdsAccountContext;
    try {
      const creds = await googleAdsService.getAccountCredentials(canonicalUserId, customerId);
      credentials = {
        customerId: creds.customerId,
        accessToken: creds.accessToken,
        loginCustomerId: creds.loginCustomerId,
      };
      accountContext = await fetchGoogleAdsAccountContext(
        credentials.customerId,
        credentials.accessToken,
        credentials.loginCustomerId
      );
    } catch (error) {
      console.error(
        `[GoogleAdsMetricsSnapshotCron] CRITICAL ERROR resolving credentials/account context for account ${customerId} (user ${canonicalUserId}) — no days attempted for this account:`,
        error
      );
      continue;
    }

    const today = new Date();
    for (let daysAgo = 1; daysAgo <= REFRESH_WINDOW_DAYS; daysAgo++) {
      const target = new Date(today);
      target.setUTCDate(target.getUTCDate() - daysAgo);
      const dateStr = toDateStr(target);
      datesAttempted++;

      try {
        const result = await snapshotGoogleAdsMetricsForDate(
          canonicalUserId,
          dateStr,
          credentials,
          accountContext,
          "daily",
          opts.dryRun
        );
        console.log(
          `[GoogleAdsMetricsSnapshotCron]${opts.dryRun ? " (dry run)" : ""} account ${customerId} ${dateStr}: ` +
            `${opts.dryRun ? "would write" : "wrote"} ${result.rowsWritten} campaign row(s) + 1 account_day row.`
        );
        rowsWritten += result.rowsWritten;
      } catch (error) {
        // A missed day is recoverable later (Google retains historical reporting data) — but
        // only if the miss is visible. Never fail silently.
        console.error(`[GoogleAdsMetricsSnapshotCron] CRITICAL ERROR for account ${customerId} ${dateStr}:`, error);
      }
    }
  }

  console.log("[GoogleAdsMetricsSnapshotCron] Execution completed.");
  return { status: "ran", accountsAttempted: accounts.length, datesAttempted, rowsWritten };
}
