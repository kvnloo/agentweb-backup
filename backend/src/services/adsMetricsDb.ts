import AWS from "aws-sdk";

const TABLE_PREFIX = process.env.NODE_ENV === "development" ? "Dev-" : "";
const dynamodb = new AWS.DynamoDB.DocumentClient();

export const ADS_METRICS_TABLE = `${TABLE_PREFIX}AW-AdsMetricsSnapshots`;

export type AdsPlatform = "meta" | "google_ads" | "linkedin_ads";

/**
 * Sentinel used in place of a campaign id on the per-account, per-day row. It is a suffix of the
 * composite key rather than a bare value precisely so two accounts on the same date cannot collide.
 */
export const ACCOUNT_DAY_SENTINEL = "__account_day__";

/**
 * HASH key. Composite because a single user can hold SEVERAL accounts on the SAME platform —
 * mvarma's own record carries two Meta ad accounts (one INR, one USD) — so `platform + campaignId`
 * alone would collide across accounts.
 */
export function buildEntityKey(platform: AdsPlatform, accountId: string, campaignId: string): string {
  return `${platform}#${accountId}#${campaignId}`;
}

export interface AdsMetricsSnapshotRow {
  /** HASH — `${platform}#${accountId}#${campaignId}` (or #__account_day__). */
  entityKey: string;
  /** RANGE — YYYY-MM-DD, in `reportingTimezone`, NOT necessarily UTC. See that field. */
  date: string;

  rowType: "campaign" | "account_day";
  platform: AdsPlatform;

  accountId: string;
  /**
   * Google Ads only: the MANAGER (MCC) account a leaf account is reached through — Google's
   * `login_customer_id`. Verified live: customer `2883029950` sits under manager `2737828986`, so
   * the pair is required to re-query the account at all. Null for Meta and LinkedIn, which have no
   * equivalent.
   */
  parentAccountId: string | null;
  userId: string;

  /**
   * Per-ACCOUNT and it genuinely varies WITHIN one user — mvarma holds Meta accounts in INR and USD
   * simultaneously. Never infer it from anywhere: a $5,000 deal reported against an INR account once
   * read as ₹5,000, ~80x off and silently.
   */
  currency: string;
  /**
   * The timezone the platform bucketed `date` in. Meta stamps buckets in the AD ACCOUNT's timezone,
   * Google in `customer.time_zone`, and ours are UTC — so the same `date` string can cover DIFFERENT
   * 24-hour windows on different platforms. Recorded rather than normalised: a consumer comparing
   * across platforms must decide what to do, and it cannot decide if we discarded the offset.
   * Null only when the platform did not report one.
   */
  reportingTimezone: string | null;
  /**
   * `approximate` means the platform itself disclaims exactness. LinkedIn's docs state their metrics
   * are approximate and explicitly warn that summing daily rows does not equal the period total —
   * which is precisely what a daily time-series store invites. A learning layer must be able to
   * weight or exclude those rows rather than treating them as ground truth.
   */
  dataQuality: "exact" | "approximate";

  /** Bare platform campaign id. Null on account_day rows. */
  campaignId: string | null;
  campaignName: string;

  /** Normalised core — the only fields guaranteed comparable across platforms. */
  spend: number;
  impressions: number;
  clicks: number;

  /** campaign rows only: leads whose first-touch campaign matched this campaign. */
  leadCount?: number;

  /** account_day rows only. */
  totalLeadCount?: number;
  unattributedLeadCount?: number;
  /**
   * How many campaign rows the platform reported for this account/date. ZERO IS MEANINGFUL: it is
   * the difference between "the platform reported no activity" and "we never collected this date".
   * Without this row those two are indistinguishable, which is the defect it exists to close.
   */
  campaignsReported?: number;

  /**
   * Everything that does NOT survive normalisation. Meta: ctr, cpm, frequency. Google: ctr,
   * averageCpc, conversions. LinkedIn: landingPageClicks, externalWebsiteConversions. Deliberately
   * a bag rather than columns — the three platforms do not agree on these and never will.
   */
  platformMetrics: Record<string, number>;

  snapshotSource: "daily" | "backfill";
  capturedAt: string;
}

/**
 * A page cap, not a page size. Reaching it means the caller is NOT holding the whole answer, which
 * is why `truncated` exists — a paging loop that returns partial data as if it were complete turns
 * a read failure into a wrong verdict, and every consumer here is computing a trend where a missing
 * tail reads as a real decline.
 */
const MAX_QUERY_PAGES = 50;

export interface SnapshotQueryResult {
  /** OLDEST-FIRST. A contract: consumers read these as a left-to-right series. */
  rows: AdsMetricsSnapshotRow[];
  /** True when MAX_QUERY_PAGES was hit. Callers MUST NOT read a truncated result as complete. */
  truncated: boolean;
}

// `date` is a DynamoDB reserved word, so it can never appear bare in a KeyConditionExpression.
const DATE_NAME = { "#date": "date" };

export const adsMetricsDb = {
  async putSnapshot(row: AdsMetricsSnapshotRow): Promise<void> {
    await dynamodb.put({ TableName: ADS_METRICS_TABLE, Item: row }).promise();
  },

  /** One campaign's history, oldest-first. `since`/`until` are inclusive YYYY-MM-DD. */
  async getSnapshotsByCampaign(
    platform: AdsPlatform,
    accountId: string,
    campaignId: string,
    opts: { since?: string; until?: string } = {}
  ): Promise<SnapshotQueryResult> {
    const { since, until } = opts;
    let keyCondition = "entityKey = :entityKey";
    const values: Record<string, any> = {
      ":entityKey": buildEntityKey(platform, accountId, campaignId),
    };
    if (since && until) {
      keyCondition += " AND #date BETWEEN :since AND :until";
      values[":since"] = since;
      values[":until"] = until;
    } else if (since) {
      keyCondition += " AND #date >= :since";
      values[":since"] = since;
    } else if (until) {
      keyCondition += " AND #date <= :until";
      values[":until"] = until;
    }

    return queryAllPages({
      TableName: ADS_METRICS_TABLE,
      KeyConditionExpression: keyCondition,
      ExpressionAttributeValues: values,
      ...(keyCondition.includes("#date") ? { ExpressionAttributeNames: DATE_NAME } : {}),
      ScanIndexForward: true,
    });
  },

  /**
   * Campaign rows for one user across a date range, via the `userId-date-index` GSI. This is the
   * read the 1%-reconciliation check needs — it answers "what did we store for this account on this
   * day" without knowing campaign ids up front.
   *
   * account_day rows are EXCLUDED so this keeps meaning "the campaign series"; a caller asking for
   * campaign metrics must never silently receive a different row type mixed in. Use
   * getAccountDaySnapshots for those. Optionally narrow by platform.
   */
  async getSnapshotsByUserDateRange(
    userId: string,
    since: string,
    until: string,
    opts: { platform?: AdsPlatform } = {}
  ): Promise<SnapshotQueryResult> {
    const result = await queryUserRange(userId, since, until);
    return {
      truncated: result.truncated,
      rows: result.rows.filter(
        (r) => r.rowType === "campaign" && (!opts.platform || r.platform === opts.platform)
      ),
    };
  },

  /** The per-account, per-day rows for a user — where unattributed lead counts actually live. */
  async getAccountDaySnapshots(
    userId: string,
    since: string,
    until: string,
    opts: { platform?: AdsPlatform } = {}
  ): Promise<SnapshotQueryResult> {
    const result = await queryUserRange(userId, since, until);
    return {
      truncated: result.truncated,
      rows: result.rows.filter(
        (r) => r.rowType === "account_day" && (!opts.platform || r.platform === opts.platform)
      ),
    };
  },
};

function queryUserRange(userId: string, since: string, until: string): Promise<SnapshotQueryResult> {
  return queryAllPages({
    TableName: ADS_METRICS_TABLE,
    IndexName: "userId-date-index",
    KeyConditionExpression: "userId = :userId AND #date BETWEEN :since AND :until",
    ExpressionAttributeNames: DATE_NAME,
    ExpressionAttributeValues: { ":userId": userId, ":since": since, ":until": until },
    ScanIndexForward: true,
  });
}

/**
 * Follows LastEvaluatedKey to exhaustion, bounded by MAX_QUERY_PAGES. Returns `truncated: true`
 * rather than silently handing back a short read — see MAX_QUERY_PAGES.
 */
async function queryAllPages(
  params: AWS.DynamoDB.DocumentClient.QueryInput
): Promise<SnapshotQueryResult> {
  const rows: AdsMetricsSnapshotRow[] = [];
  let lastKey: AWS.DynamoDB.DocumentClient.Key | undefined;
  let pages = 0;

  do {
    const res = await dynamodb
      .query({ ...params, ...(lastKey ? { ExclusiveStartKey: lastKey } : {}) })
      .promise();
    rows.push(...((res.Items || []) as AdsMetricsSnapshotRow[]));
    lastKey = res.LastEvaluatedKey;
    pages++;
  } while (lastKey && pages < MAX_QUERY_PAGES);

  return { rows, truncated: Boolean(lastKey) };
}
