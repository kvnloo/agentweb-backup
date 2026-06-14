/**
 * usageRecordDb — DynamoDB adapter for the shadow usage-metering table (Ship 1).
 *
 * Table: {Dev-}AW-UsageRecords
 *   Partition key: userId (S)
 *   Sort key:      sk (S) = "{date}#{model}#{feature}" where date is YYYY-MM-DD
 *
 * One row per (userId, day, model, feature). All counters are incremented via a
 * SINGLE atomic UpdateExpression using ADD — no read-modify-write, so concurrent
 * LLM calls never lose increments. Cost is stored as INTEGER microdollars
 * (costMicroUsd) — no floats in counters.
 *
 * Rows carry a native DynamoDB TTL (`ttl`, epoch seconds) of 180 days from first
 * write, so the table self-prunes.
 */

import AWS from "aws-sdk";

const TABLE_PREFIX = process.env.NODE_ENV === "development" ? "Dev-" : "";
const TABLE_NAME = `${TABLE_PREFIX}AW-UsageRecords`;

/** 180 days, in seconds. */
const TTL_SECONDS = 180 * 24 * 60 * 60;

// Lazy singleton: constructing at module load breaks test suites that mock
// aws-sdk without DynamoDB and import this transitively (via llmClients).
let dynamodbClient: AWS.DynamoDB.DocumentClient | null = null;
function getDocumentClient(): AWS.DynamoDB.DocumentClient {
  if (!dynamodbClient) {
    dynamodbClient = new AWS.DynamoDB.DocumentClient();
  }
  return dynamodbClient;
}

export interface UsageRecordIncrement {
  userId: string;
  /** YYYY-MM-DD (UTC) */
  date: string;
  model: string;
  feature: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** Integer microdollars (USD * 1e6) for this call. */
  costMicroUsd: number;
  billingUserId: string;
  onBehalfOf?: string;
}

export interface UsageRecordRow {
  userId: string;
  sk: string;
  date: string;
  model: string;
  feature: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  costMicroUsd: number;
  callCount: number;
  billingUserId: string;
  onBehalfOf?: string;
  updatedAt: string;
  ttl: number;
}

function buildSortKey(date: string, model: string, feature: string): string {
  return `${date}#${model}#${feature}`;
}

export const usageRecordDb = {
  tableName: TABLE_NAME,

  /**
   * Atomically increment the daily aggregate row for (userId, date, model, feature).
   * Single UpdateExpression with ADD — creates the row on first write.
   */
  async incrementUsage(inc: UsageRecordIncrement): Promise<void> {
    const cacheReadTokens = inc.cacheReadTokens || 0;
    const cacheWriteTokens = inc.cacheWriteTokens || 0;
    const totalTokens =
      inc.inputTokens + inc.outputTokens + cacheReadTokens + cacheWriteTokens;
    const now = new Date().toISOString();

    const names: Record<string, string> = {
      "#date": "date",
      "#model": "model",
      "#feature": "feature",
      "#ttl": "ttl",
    };
    const values: Record<string, any> = {
      ":in": inc.inputTokens,
      ":out": inc.outputTokens,
      ":cr": cacheReadTokens,
      ":cw": cacheWriteTokens,
      ":tt": totalTokens,
      ":cost": Math.round(inc.costMicroUsd),
      ":one": 1,
      ":date": inc.date,
      ":model": inc.model,
      ":feature": inc.feature,
      ":billing": inc.billingUserId,
      ":now": now,
      ":ttl": Math.floor(Date.now() / 1000) + TTL_SECONDS,
    };

    let setClause =
      "SET #date = :date, #model = :model, #feature = :feature, " +
      "billingUserId = :billing, updatedAt = :now, #ttl = if_not_exists(#ttl, :ttl)";
    if (inc.onBehalfOf) {
      setClause += ", onBehalfOf = :obo";
      values[":obo"] = inc.onBehalfOf;
    }

    await getDocumentClient()
      .update({
        TableName: TABLE_NAME,
        Key: { userId: inc.userId, sk: buildSortKey(inc.date, inc.model, inc.feature) },
        UpdateExpression:
          "ADD inputTokens :in, outputTokens :out, cacheReadTokens :cr, " +
          "cacheWriteTokens :cw, totalTokens :tt, costMicroUsd :cost, callCount :one " +
          setClause,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
      })
      .promise();
  },

  /**
   * Query all rows for a user between two dates (inclusive, YYYY-MM-DD).
   * Paginates through LastEvaluatedKey.
   */
  async queryByUserDateRange(
    userId: string,
    startDate: string,
    endDate: string
  ): Promise<UsageRecordRow[]> {
    const rows: UsageRecordRow[] = [];
    let lastKey: AWS.DynamoDB.DocumentClient.Key | undefined;

    do {
      const result = await getDocumentClient()
        .query({
          TableName: TABLE_NAME,
          KeyConditionExpression: "userId = :uid AND sk BETWEEN :start AND :end",
          ExpressionAttributeValues: {
            ":uid": userId,
            ":start": startDate,
            // '#' sorts below '~', so endDate + '~' includes every sk for endDate.
            ":end": `${endDate}~`,
          },
          ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
        })
        .promise();
      rows.push(...((result.Items || []) as UsageRecordRow[]));
      lastKey = result.LastEvaluatedKey;
    } while (lastKey);

    return rows;
  },
};
