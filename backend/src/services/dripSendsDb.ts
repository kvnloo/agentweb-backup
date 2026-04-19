/**
 * Lifecycle Drip Phase 4 — DripSends DB service.
 *
 * Per-send audit log for drip campaigns. Every email dispatched by the
 * Phase 4 executor writes one record here so we can:
 *   1. Enforce `maxSends` per-user-per-campaign (lifetime cap).
 *   2. Enforce `cadenceDays` (don't resend before the cadence window).
 *   3. Audit what went out (support, debugging, unsubscribe enforcement).
 *   4. Rate-limit per campaign per hour.
 *
 * Schema (one DynamoDB item per send):
 *   sendId:     uuid (partition key)
 *   campaignId: string — links back to AW-DripCampaigns
 *   userId:     string — recipient's user id
 *   email:      string — recipient's email at send time (audit trail)
 *   templateSnapshot: string — rendered HTML that actually went out
 *   subjectSnapshot:  string — rendered subject that actually went out
 *   sentAt:     ISO datetime
 *   messageId:  string | null — provider-side message id if the send succeeded
 *   status:     'sent' | 'failed' | 'dry_run'
 *   error:      string — only populated when status='failed'
 *   dryRun:     boolean — true when the send was simulated (no real email)
 *
 * GSIs:
 *   CampaignIndex: campaignId (PK), sentAt (SK) — for rate-limit queries
 *   UserCampaignIndex: `${userId}#${campaignId}` (PK), sentAt (SK) —
 *       for maxSends + cadence lookups
 *
 * Table auto-provisions with `Dev-` prefix in non-prod (matches the rest of
 * the codebase). See reference at AW-DripCampaigns in dripCampaignDb.ts.
 */

import AWS from "aws-sdk";
import { v4 as uuidv4 } from "uuid";

export type DripSendStatus = "sent" | "failed" | "dry_run";

export interface DripSend {
  sendId: string;
  campaignId: string;
  userId: string;
  email: string;
  templateSnapshot: string;
  subjectSnapshot: string;
  sentAt: string;
  messageId: string | null;
  status: DripSendStatus;
  error?: string;
  dryRun: boolean;
}

export class DripSendsDb {
  private tableName: string;
  private docClient: AWS.DynamoDB.DocumentClient;

  constructor(tableName?: string) {
    const TABLE_PREFIX = process.env.NODE_ENV === "development" ? "Dev-" : "";
    this.tableName = tableName || `${TABLE_PREFIX}AW-DripSends`;
    this.docClient = new AWS.DynamoDB.DocumentClient();
  }

  /** Record a send. `sendId` is auto-generated. Returns the full record. */
  async record(
    input: Omit<DripSend, "sendId" | "sentAt"> & { sentAt?: string },
  ): Promise<DripSend> {
    if (!input.campaignId) throw new Error("campaignId is required");
    if (!input.userId) throw new Error("userId is required");
    if (!input.email) throw new Error("email is required");
    if (
      input.status !== "sent" &&
      input.status !== "failed" &&
      input.status !== "dry_run"
    ) {
      throw new Error("status must be one of: sent, failed, dry_run");
    }

    const record: DripSend = {
      sendId: uuidv4(),
      campaignId: input.campaignId,
      userId: input.userId,
      email: input.email,
      templateSnapshot: input.templateSnapshot,
      subjectSnapshot: input.subjectSnapshot,
      sentAt: input.sentAt || new Date().toISOString(),
      messageId: input.messageId ?? null,
      status: input.status,
      dryRun: input.dryRun ?? false,
      ...(input.error !== undefined && { error: input.error }),
    };

    await this.docClient
      .put({
        TableName: this.tableName,
        Item: record,
      })
      .promise();

    return record;
  }

  /**
   * Count sends for a specific user+campaign. Counts only status='sent'
   * (dry_run + failed don't count against the user's cap). Used for
   * `maxSends` enforcement.
   */
  async countSendsForUserCampaign(
    userId: string,
    campaignId: string,
  ): Promise<number> {
    const result = await this.docClient
      .scan({
        TableName: this.tableName,
        FilterExpression:
          "userId = :uid AND campaignId = :cid AND #status = :sent",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":uid": userId,
          ":cid": campaignId,
          ":sent": "sent",
        },
      })
      .promise();
    return result.Items?.length ?? 0;
  }

  /**
   * Get the most recent send timestamp for a user+campaign. Returns null if
   * no send exists. Used for cadence enforcement — "don't resend within N
   * days of the last send".
   */
  async getMostRecentSendAt(
    userId: string,
    campaignId: string,
  ): Promise<string | null> {
    const result = await this.docClient
      .scan({
        TableName: this.tableName,
        FilterExpression:
          "userId = :uid AND campaignId = :cid AND #status = :sent",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":uid": userId,
          ":cid": campaignId,
          ":sent": "sent",
        },
      })
      .promise();
    const items = (result.Items ?? []) as DripSend[];
    if (items.length === 0) return null;
    items.sort((a, b) => {
      const ta = Date.parse(a.sentAt || "");
      const tb = Date.parse(b.sentAt || "");
      return tb - ta;
    });
    return items[0].sentAt;
  }

  /**
   * Count sends for a campaign within a time window. Used to enforce the
   * per-campaign per-hour rate limit so a cron tick can't blast 5000 emails.
   */
  async countSendsInWindow(
    campaignId: string,
    sinceIso: string,
  ): Promise<number> {
    const result = await this.docClient
      .scan({
        TableName: this.tableName,
        FilterExpression:
          "campaignId = :cid AND sentAt >= :since AND #status = :sent",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":cid": campaignId,
          ":since": sinceIso,
          ":sent": "sent",
        },
      })
      .promise();
    return result.Items?.length ?? 0;
  }

  async listForCampaign(campaignId: string): Promise<DripSend[]> {
    const result = await this.docClient
      .scan({
        TableName: this.tableName,
        FilterExpression: "campaignId = :cid",
        ExpressionAttributeValues: { ":cid": campaignId },
      })
      .promise();
    return (result.Items ?? []) as DripSend[];
  }
}

// Lazy singleton — avoids DynamoDB client creation at import time (breaks test mocks)
let _instance: DripSendsDb | null = null;
export function getDripSendsDb(): DripSendsDb {
  if (!_instance) _instance = new DripSendsDb();
  return _instance;
}

// Test-only: reset the singleton so per-test Dynamo mocks work reliably.
export function __resetDripSendsDbForTests(): void {
  _instance = null;
}
