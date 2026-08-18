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
import { LLM_CHARGE_EVENTS_TABLE, LlmChargeAuditEvent } from "./llmChargeAuditDb";

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
  /**
   * ENG-1251 Greptile P1: how many calls this ONE increment represents.
   * Every existing caller increments one call at a time and omits this
   * (defaults to 1, unchanged behavior). The atomic charge-coupled path
   * below sums a whole charge group's calls into a single increment, so it
   * must add the true count to callCount, not always 1.
   */
  calls?: number;
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

/**
 * The daily aggregate's identity, INCLUDING the payer (ENG-1210, raised by
 * Greptile on PR #2407).
 *
 * `billingUserId` used to be a plain attribute written with an unconditional SET,
 * so a member whose billing owner changed mid-day left ONE row holding both
 * payers' counters, stamped with whichever call wrote last. The whole day was
 * then attributed to one of them -- the other's spend vanished from their bill and
 * appeared on someone else's.
 *
 * Putting the payer in the key means counters can never mix: each payer gets its
 * own aggregate, and a transition simply starts a second row.
 *
 * Safe to change without a migration, and deliberately done that way:
 *  - nothing parses `sk`; every reader uses the `date`/`model`/`feature`
 *    attributes, which are still written on the row;
 *  - the date stays the LEADING segment, so the `sk BETWEEN :start AND :end~`
 *    range queries match exactly as before -- '#' sorts below '~';
 *  - rows written before this keep their old key and remain readable and
 *    summable. They keep their last-writer attribution, which is the pre-existing
 *    state, not a regression. Only new spend is attributed correctly, the same
 *    forward-only choice ENG-1210 made for the scheduled-vs-interactive tag.
 */
function buildSortKey(date: string, model: string, feature: string, billingUserId: string): string {
  return `${date}#${model}#${feature}#${billingUserId}`;
}

/**
 * Pure builder for the ledger row's atomic increment — shared by the plain
 * single-item `update()` call (incrementUsage) and the DynamoDB TransactWrite
 * item used to couple a ledger write with a charge event atomically
 * (incrementUsageWithChargeEvent). Kept as one function so the two paths can
 * never drift: whatever incrementUsage writes standalone is byte-identical
 * to what the atomic path writes as part of a transaction.
 */
function buildIncrementUsageUpdate(inc: UsageRecordIncrement): {
  Key: AWS.DynamoDB.DocumentClient.Key;
  UpdateExpression: string;
  ExpressionAttributeNames: Record<string, string>;
  ExpressionAttributeValues: Record<string, any>;
} {
  // A per-unit vendor entry counts `quantity`, not tokens. Writing the token
  // counters as zeros would make "this vendor doesn't bill by tokens"
  // indistinguishable from "this call used zero tokens", so they're omitted.
  const isUnitEntry = inc.unit != null;
  const cacheReadTokens = inc.cacheReadTokens || 0;
  const cacheWriteTokens = inc.cacheWriteTokens || 0;
  const totalTokens =
    inc.inputTokens + inc.outputTokens + cacheReadTokens + cacheWriteTokens;
  const now = new Date().toISOString();
  const calls = Math.max(1, Math.round(inc.calls ?? 1));

  const names: Record<string, string> = {
    "#date": "date",
    "#model": "model",
    "#feature": "feature",
    "#ttl": "ttl",
  };
  const values: Record<string, any> = {
    ":cost": Math.round(inc.costMicroUsd),
    ":calls": calls,
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
  addClauses.push("costMicroUsd :cost", "callCount :calls");

  const setClauses = [
    "#date = :date",
    "#model = :model",
    "#feature = :feature",
    // Still written as an attribute even though it is now part of the key: every
    // reader (the attribute scan, isBilledTo, itemization) reads it off the row,
    // and rows written before the key change only have the attribute.
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

  return {
    Key: { userId: inc.userId, sk: buildSortKey(inc.date, inc.model, inc.feature, inc.billingUserId) },
    UpdateExpression: `ADD ${addClauses.join(", ")} SET ${setClauses.join(", ")}`,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
  };
}

export const usageRecordDb = {
  tableName: TABLE_NAME,

  /**
   * Atomically increment the daily aggregate row for (userId, date, model, feature).
   * Single UpdateExpression with ADD — creates the row on first write.
   */
  async incrementUsage(inc: UsageRecordIncrement): Promise<void> {
    const params = buildIncrementUsageUpdate(inc);
    await getDocumentClient()
      .update({ TableName: TABLE_NAME, ...params })
      .promise();
  },

  /**
   * ENG-1251 Greptile P1 ("Coverage suppresses unrelated aggregate usage"):
   * couples this ledger increment with its paired charge event in ONE
   * DynamoDB transaction, so the two either both land or neither does.
   *
   * Before this, internalUsage.ts pre-checked the charge event via a
   * standalone recordLlmChargeEvent() call, then wrote the ledger row as a
   * SEPARATE step. recordUsage() is fail-open by design (never throws), so a
   * real write failure on that second step left the charge event recorded
   * with NO matching ledger contribution. Reconciliation still matched the
   * event to whatever pre-existing aggregate row shared its (actor, date,
   * model, feature) key and subtracted the event's tokens/calls from it —
   * discarding real usage that row's OWN successful writes actually
   * represented, usage the failed write never contributed in the first
   * place. Structural fix: an atomic transaction makes "charge event exists
   * but its own ledger contribution doesn't" impossible going forward, so
   * reconciliation's assumption (an event's coverage always has a matching
   * ledger contribution) is sound rather than merely usually true.
   *
   * Returns:
   *  - "applied": both items were written.
   *  - "duplicate": the charge event already existed (confirmed retry) —
   *    neither item was written this call; the caller must not also skip
   *    writing the ledger via ANY other path, since a genuinely-new-but-
   *    unwritten contribution would then be lost forever.
   *  - "conflict": a transient DynamoDB contention error (not a confirmed
   *    duplicate) — the caller should fail toward writing via its own
   *    non-atomic fallback, per this route's existing "undercounting is
   *    worse than an occasional double-count" policy.
   */
  async incrementUsageWithChargeEvent(
    inc: UsageRecordIncrement,
    chargeEvent: LlmChargeAuditEvent
  ): Promise<"applied" | "duplicate" | "conflict"> {
    const ledgerParams = buildIncrementUsageUpdate(inc);
    const ledgerItem: AWS.DynamoDB.DocumentClient.TransactWriteItem = {
      Update: { TableName: TABLE_NAME, ...ledgerParams },
    };
    const chargeItem: AWS.DynamoDB.DocumentClient.TransactWriteItem = {
      Put: {
        TableName: LLM_CHARGE_EVENTS_TABLE,
        Item: { ...chargeEvent, ttl: Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60 },
        // Same guard as recordLlmChargeEvent's standalone put.
        ConditionExpression: "attribute_not_exists(billingUserId) AND attribute_not_exists(eventId)",
      },
    };

    try {
      await getDocumentClient()
        .transactWrite({ TransactItems: [ledgerItem, chargeItem] })
        .promise();
      return "applied";
    } catch (error: any) {
      // Same classification as db.ts's applyMonthlyChargeAtomic: a
      // TransactWriteItems condition failure surfaces as
      // TransactionCanceledException with a per-item CancellationReasons
      // array (index order matches TransactItems: 0 = ledger, 1 = charge),
      // not the single-item ConditionalCheckFailedException recordLlmChargeEvent
      // catches on its own standalone put.
      const reasons = error?.CancellationReasons as Array<{ Code?: string }> | undefined;
      if (error?.code === "TransactionConflictException") return "conflict";
      if (error?.code === "TransactionCanceledException" && reasons) {
        if (reasons[1]?.Code === "ConditionalCheckFailed") return "duplicate";
        const isPureConflict =
          reasons.some((reason) => reason?.Code === "TransactionConflict") &&
          reasons.every((reason) => reason?.Code === "TransactionConflict" || reason?.Code === "None");
        if (isPureConflict) return "conflict";
      }
      throw error;
    }
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
