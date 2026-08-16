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

  // ── Vendor dimension (ENG-693). All optional and all NON-KEY: an existing row
  // stays valid and readable without any of them, so no backfill is required. ──

  /** Vendor that served the call: "bedrock", "openai", "v0", "you.com", … */
  provider?: string;
  /**
   * Chat session this CALL came from (declared on the caller context since Ship 1).
   * Persisted as the row's `lastSessionId` breadcrumb — see `UsageRecordRow`.
   */
  sessionId?: string;
  /**
   * The thing being counted for a vendor that does NOT bill by tokens
   * ("render", "query", "character"). Its presence is what marks this write as a
   * per-unit entry: token counters are then omitted entirely rather than written
   * as zeros, so a reader can tell "no tokens" from "zero tokens".
   */
  unit?: string;
  /** How many `unit`s this call consumed. Accumulates across calls on the row. */
  quantity?: number;
  /**
   * Whether `costMicroUsd` is a figure the vendor reported ("measured") or one we
   * produced by applying our own rate ("allocated"). Absent on pre-ENG-693 rows.
   */
  costSource?: CostSource;
}

/** Provenance of a cost figure — see `UsageRecordIncrement.costSource`. */
export type CostSource = "measured" | "allocated";

export interface UsageRecordRow {
  userId: string;
  sk: string;
  date: string;
  model: string;
  feature: string;
  /** Absent on per-unit vendor rows, which carry no token counters at all. */
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTokens?: number;
  costMicroUsd: number;
  callCount: number;
  billingUserId: string;
  onBehalfOf?: string;
  updatedAt: string;
  ttl: number;
  /** Vendor dimension (ENG-693) — absent on every row written before that change. */
  provider?: string;
  /**
   * The most recent session that contributed to this row — a trace breadcrumb, NOT
   * an attribution key. The row aggregates every session that used this
   * {date}#{model}#{feature}, so its counters are not this session's alone. Never
   * read it as "the session that owns this usage".
   */
  lastSessionId?: string;
  unit?: string;
  quantity?: number;
  costSource?: CostSource;
}

/**
 * True only for a per-unit vendor entry (ENG-693).
 *
 * Deliberately requires BOTH `provider` and `unit`. A row written before this
 * change has neither, so it reports false and is never surfaced as a vendor
 * entry costing $0 — its real token cost keeps being read from `costMicroUsd`.
 * An LLM row carries `provider` but no `unit`, and is likewise not a vendor
 * entry: it is token-priced spend that happens to name its provider.
 */
export function isVendorEntry(row: UsageRecordRow): boolean {
  return row.provider != null && row.unit != null;
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
    // A per-unit vendor entry counts `quantity`, not tokens. Writing the token
    // counters as zeros would make "this vendor doesn't bill by tokens"
    // indistinguishable from "this call used zero tokens", so they're omitted.
    const isUnitEntry = inc.unit != null;
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
      ":cost": Math.round(inc.costMicroUsd),
      ":one": 1,
      ":date": inc.date,
      ":model": inc.model,
      ":feature": inc.feature,
      ":billing": inc.billingUserId,
      ":now": now,
      ":ttl": Math.floor(Date.now() / 1000) + TTL_SECONDS,
    };

    const addClauses: string[] = [];
    if (isUnitEntry) {
      names["#quantity"] = "quantity";
      values[":qty"] = Math.max(0, Math.round(inc.quantity || 0));
      addClauses.push("#quantity :qty");
    } else {
      Object.assign(values, {
        ":in": inc.inputTokens,
        ":out": inc.outputTokens,
        ":cr": cacheReadTokens,
        ":cw": cacheWriteTokens,
        ":tt": totalTokens,
      });
      addClauses.push(
        "inputTokens :in",
        "outputTokens :out",
        "cacheReadTokens :cr",
        "cacheWriteTokens :cw",
        "totalTokens :tt"
      );
    }
    addClauses.push("costMicroUsd :cost", "callCount :one");

    const setClauses = [
      "#date = :date",
      "#model = :model",
      "#feature = :feature",
      "billingUserId = :billing",
      "updatedAt = :now",
      "#ttl = if_not_exists(#ttl, :ttl)",
    ];
    if (inc.onBehalfOf) {
      setClauses.push("onBehalfOf = :obo");
      values[":obo"] = inc.onBehalfOf;
    }

    // Descriptive (non-counter) attributes of the row. A row is a DAILY AGGREGATE
    // of N calls, so these are written with if_not_exists: the first writer's
    // value sticks and the row never flaps between concurrent callers. That is
    // sound only because each of these is constant across every writer to a given
    // key — `recordVendorUsage` namespaces the model slot as `{provider}:{operation}`,
    // so one row cannot mix vendors, units, or cost provenance. All three go through
    // ExpressionAttributeNames because `unit` is a DynamoDB reserved word.
    const descriptive: Array<[string, unknown]> = [
      ["provider", inc.provider],
      ["unit", inc.unit],
      ["costSource", inc.costSource],
    ];
    for (const [attr, value] of descriptive) {
      if (value == null) continue;
      names[`#${attr}`] = attr;
      values[`:${attr}`] = value;
      setClauses.push(`#${attr} = if_not_exists(#${attr}, :${attr})`);
    }

    // Session is the one call-level fact that is NOT constant across a row. The sort
    // key is {date}#{model}#{feature}, so N sessions share one bucket while its
    // counters accumulate all of their usage. Pinning a single id onto that row —
    // the first (if_not_exists) or the last — reads as "this session owns this
    // usage" and is false for every session but one. Stored as `lastSessionId`
    // under plain SET so the attribute name states exactly what it holds: a trace
    // breadcrumb to the most recent contributing session, never an attribution key.
    // Session-granular spend would need the session in the sort key, which is a key
    // change this slice deliberately excludes (see the issue's out-of-scope list).
    if (inc.sessionId != null) {
      values[":lastSessionId"] = inc.sessionId;
      setClauses.push("lastSessionId = :lastSessionId");
    }

    await getDocumentClient()
      .update({
        TableName: TABLE_NAME,
        Key: { userId: inc.userId, sk: buildSortKey(inc.date, inc.model, inc.feature) },
        UpdateExpression: `ADD ${addClauses.join(", ")} SET ${setClauses.join(", ")}`,
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

  /**
   * Scan ALL users' rows between two dates (inclusive, YYYY-MM-DD), for the
   * admin cost aggregation (ENG-366). Paginates through LastEvaluatedKey.
   *
   * A Scan is deliberate here: the table holds compact daily aggregates (one
   * row per user/day/model/feature) with a 180-day TTL, so the scan is bounded
   * and this is an admin-only, low-frequency read path. If row volume ever
   * makes this slow, the upgrade path is a date-keyed GSI — not client-side
   * filtering.
   */
  async scanByDateRange(startDate: string, endDate: string): Promise<UsageRecordRow[]> {
    const rows: UsageRecordRow[] = [];
    let lastKey: AWS.DynamoDB.DocumentClient.Key | undefined;

    do {
      const result = await getDocumentClient()
        .scan({
          TableName: TABLE_NAME,
          FilterExpression: "#date BETWEEN :start AND :end",
          ExpressionAttributeNames: { "#date": "date" },
          ExpressionAttributeValues: { ":start": startDate, ":end": endDate },
          ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
        })
        .promise();
      rows.push(...((result.Items || []) as UsageRecordRow[]));
      lastKey = result.LastEvaluatedKey;
    } while (lastKey);

    return rows;
  },

  /**
   * Scan for every row attributed to a given billing owner, regardless of
   * which acting user's partition it lives under (ENG-1251 Greptile P1).
   *
   * The table's partition key is the ACTING user's own userId, but a pooled
   * org member's usage must appear on the OWNER's itemized report. The
   * owner's own rows are already reachable via queryByUserDateRange; this
   * covers every OTHER row (current pooled members, and -- since
   * billingUserId is stamped once at write time and never rewritten --
   * FORMER pooled members' historical rows too, as long as they were
   * written while genuinely pooled).
   *
   * A Scan is deliberate here, same reasoning as scanByDateRange above: this
   * table holds compact daily aggregates with a bounded TTL, and itemized
   * usage is a low-frequency, per-user read (one customer viewing their own
   * month), not a hot path. If row volume ever makes this slow, the upgrade
   * path is a billingUserId GSI -- not client-side filtering. Tracked as
   * ENG-1273 (Low priority, not urgent -- table is 4,747 items as of
   * 2026-08-16), gated behind Harsha's approval since a new GSI is a
   * database/data-plane change.
   */
  async queryByBillingUserDateRange(
    billingUserId: string,
    startDate: string,
    endDate: string
  ): Promise<UsageRecordRow[]> {
    const rows: UsageRecordRow[] = [];
    let lastKey: AWS.DynamoDB.DocumentClient.Key | undefined;

    do {
      const result = await getDocumentClient()
        .scan({
          TableName: TABLE_NAME,
          FilterExpression: "billingUserId = :billing AND #date BETWEEN :start AND :end",
          ExpressionAttributeNames: { "#date": "date" },
          ExpressionAttributeValues: { ":billing": billingUserId, ":start": startDate, ":end": endDate },
          ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
        })
        .promise();
      rows.push(...((result.Items || []) as UsageRecordRow[]));
      lastKey = result.LastEvaluatedKey;
    } while (lastKey);

    return rows;
  },
};
