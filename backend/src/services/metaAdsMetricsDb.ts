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
export const metaAdsMetricsDb = {
  async putSnapshot(row: MetaAdsMetricsSnapshotRow): Promise<void> {
    await dynamodb
      .put({
        TableName: `${TABLE_PREFIX}AW-MetaAdsMetricsSnapshots`,
        Item: row,
      })
      .promise();
  },
};
