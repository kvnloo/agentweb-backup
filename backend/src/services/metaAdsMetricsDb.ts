import AWS from "aws-sdk";

const TABLE_PREFIX = process.env.NODE_ENV === "development" ? "Dev-" : "";
const dynamodb = new AWS.DynamoDB.DocumentClient();

export interface MetaAdsMetricsSnapshotRow {
  campaignId: string;
  date: string; // YYYY-MM-DD
  accountId: string;
  userId: string;
  campaignName: string;
  spend: number;
  impressions: number;
  clicks: number;
  ctr: number;
  cpm: number;
  frequency: number;
  leadCount: number;
  unattributedLeadCount: number;
  snapshotSource: "daily" | "backfill";
  capturedAt: string;
}

/**
 * ENG-916: per-campaign, per-day Meta ad metrics + CRM lead-count snapshots.
 * `campaignId` + `date` is the full key — writing the same pair again is a
 * deliberate overwrite (used by the 3-day settling-window re-pull), not a bug.
 */
/**
 * A page cap, not a page size. Reaching it means the caller is NOT holding the whole answer,
 * which is why `truncated` exists — a paging loop that returns partial data as if it were
 * complete turns a read failure into a wrong verdict, and every consumer of this store is
 * computing a trend where a missing tail reads as a real decline.
 */
const MAX_QUERY_PAGES = 50;

export interface SnapshotQueryResult {
  /** OLDEST-FIRST. This ordering is a contract: consumers read these as a left-to-right series. */
  rows: MetaAdsMetricsSnapshotRow[];
  /** True when MAX_QUERY_PAGES was hit. Callers MUST NOT read a truncated result as complete. */
  truncated: boolean;
}

// `date` is a DynamoDB reserved word, so it can never appear bare in a KeyConditionExpression.
const DATE_NAME = { "#date": "date" };

export const metaAdsMetricsDb = {
  async putSnapshot(row: MetaAdsMetricsSnapshotRow): Promise<void> {
    await dynamodb
      .put({
        TableName: `${TABLE_PREFIX}AW-MetaAdsMetricsSnapshots`,
        Item: row,
      })
      .promise();
  },

  /**
   * One campaign's history, oldest-first. Reads the base table (campaignId HASH + date RANGE).
   * `since`/`until` are inclusive `YYYY-MM-DD`; omit both for the campaign's full history.
   */
  async getSnapshotsByCampaign(
    campaignId: string,
    opts: { since?: string; until?: string } = {}
  ): Promise<SnapshotQueryResult> {
    const { since, until } = opts;
    let keyCondition = "campaignId = :campaignId";
    const values: Record<string, any> = { ":campaignId": campaignId };
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
      TableName: `${TABLE_PREFIX}AW-MetaAdsMetricsSnapshots`,
      KeyConditionExpression: keyCondition,
      ExpressionAttributeValues: values,
      ...(keyCondition.includes("#date") ? { ExpressionAttributeNames: DATE_NAME } : {}),
      ScanIndexForward: true,
    });
  },

  /**
   * Every campaign row for one user across a date range, oldest-first, via the
   * `userId-date-index` GSI. This is the read the 1%-reconciliation check needs: it answers
   * "what did we store for this account on this day" without knowing campaign ids up front.
   */
  async getSnapshotsByUserDateRange(
    userId: string,
    since: string,
    until: string
  ): Promise<SnapshotQueryResult> {
    return queryAllPages({
      TableName: `${TABLE_PREFIX}AW-MetaAdsMetricsSnapshots`,
      IndexName: "userId-date-index",
      KeyConditionExpression: "userId = :userId AND #date BETWEEN :since AND :until",
      ExpressionAttributeNames: DATE_NAME,
      ExpressionAttributeValues: { ":userId": userId, ":since": since, ":until": until },
      ScanIndexForward: true,
    });
  },
};

/**
 * Follows LastEvaluatedKey to exhaustion, bounded by MAX_QUERY_PAGES. Returns `truncated: true`
 * rather than silently handing back a short read — see MAX_QUERY_PAGES.
 */
async function queryAllPages(
  params: AWS.DynamoDB.DocumentClient.QueryInput
): Promise<SnapshotQueryResult> {
  const rows: MetaAdsMetricsSnapshotRow[] = [];
  let lastKey: AWS.DynamoDB.DocumentClient.Key | undefined;
  let pages = 0;

  do {
    const res = await dynamodb
      .query({ ...params, ...(lastKey ? { ExclusiveStartKey: lastKey } : {}) })
      .promise();
    rows.push(...((res.Items || []) as MetaAdsMetricsSnapshotRow[]));
    lastKey = res.LastEvaluatedKey;
    pages++;
  } while (lastKey && pages < MAX_QUERY_PAGES);

  return { rows, truncated: Boolean(lastKey) };
}
