/**
 * ENG-2106 (A3): the DynamoDB-backed AttemptUsageJournal.
 *
 * One immutable row per recorded attempt, in `AW-AttemptUsage`. The write is a single
 * conditional put on `attemptId`, so a retried write (or a duplicate report of the same
 * provider generation) records exactly once. Nothing here updates or deletes a row: a
 * correction is a new row, and every derived total is rebuilt by replaying rows through
 * `iterateAttempts`.
 *
 * The table holds no secrets: it is usage facts about a connection, never the key.
 */

import AWS from "aws-sdk";
import type { AttemptUsage, AttemptUsageJournal } from "./attemptUsageJournal";

const TABLE_PREFIX = process.env.NODE_ENV === "development" ? "Dev-" : "";
export const ATTEMPT_USAGE_TABLE = `${TABLE_PREFIX}AW-AttemptUsage`;
export const ATTEMPT_USAGE_RUN_INDEX = "RunIndex";
export const ATTEMPT_USAGE_CONNECTION_INDEX = "ConnectionIndex";
export const ATTEMPT_USAGE_PRINCIPAL_INDEX = "PrincipalIndex";
export const ATTEMPT_USAGE_TTL_ATTRIBUTE = "ttl";
export const ATTEMPT_USAGE_RETENTION_DAYS = 400;

/**
 * The table definition ensureCriticalTables creates at boot. The copy in
 * scripts/create-tables.ts must match it (that script cannot import from services);
 * attemptUsageTable.test.ts fails if the two differ.
 *
 * Point-in-time recovery and TTL are NOT settable by CreateTable; ensureCriticalTables
 * enables both as separate calls (see finding-boot-created-tables-need-manual-ttl).
 * `ConnectionIndex` is sparse: only rows with a connection are in it.
 */
export const ATTEMPT_USAGE_TABLE_SPEC: AWS.DynamoDB.CreateTableInput = {
  TableName: ATTEMPT_USAGE_TABLE,
  AttributeDefinitions: [
    { AttributeName: "attemptId", AttributeType: "S" },
    { AttributeName: "runId", AttributeType: "S" },
    { AttributeName: "connectionId", AttributeType: "S" },
    { AttributeName: "fundingPrincipalId", AttributeType: "S" },
    { AttributeName: "startedAt", AttributeType: "S" },
  ],
  KeySchema: [{ AttributeName: "attemptId", KeyType: "HASH" }],
  GlobalSecondaryIndexes: [
    {
      IndexName: ATTEMPT_USAGE_RUN_INDEX,
      KeySchema: [
        { AttributeName: "runId", KeyType: "HASH" },
        { AttributeName: "startedAt", KeyType: "RANGE" },
      ],
      Projection: { ProjectionType: "ALL" },
    },
    {
      IndexName: ATTEMPT_USAGE_CONNECTION_INDEX,
      KeySchema: [
        { AttributeName: "connectionId", KeyType: "HASH" },
        { AttributeName: "startedAt", KeyType: "RANGE" },
      ],
      Projection: { ProjectionType: "ALL" },
    },
    {
      IndexName: ATTEMPT_USAGE_PRINCIPAL_INDEX,
      KeySchema: [
        { AttributeName: "fundingPrincipalId", KeyType: "HASH" },
        { AttributeName: "startedAt", KeyType: "RANGE" },
      ],
      Projection: { ProjectionType: "ALL" },
    },
  ],
  BillingMode: "PAY_PER_REQUEST",
  DeletionProtectionEnabled: true,
};

type DocClient = Pick<AWS.DynamoDB.DocumentClient, "put" | "query">;

let defaultClient: DocClient | null = null;
function docClient(): DocClient {
  if (!defaultClient) {
    defaultClient = new AWS.DynamoDB.DocumentClient({
      region: process.env.AWS_REGION || "us-west-2",
      // Leave the SDK's own credential chain alone when no static keys are configured.
      ...(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
        ? {
            credentials: {
              accessKeyId: process.env.AWS_ACCESS_KEY_ID,
              secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
              ...(process.env.AWS_SESSION_TOKEN ? { sessionToken: process.env.AWS_SESSION_TOKEN } : {}),
            },
          }
        : {}),
    });
  }
  return defaultClient;
}

/** Failures worth retrying: the request never produced an answer, or DynamoDB shed load. */
const RETRYABLE_CODES = new Set([
  "ProvisionedThroughputExceededException",
  "ThrottlingException",
  "RequestLimitExceeded",
  "InternalServerError",
  "ServiceUnavailable",
  "TimeoutError",
  "NetworkingError",
  "RequestTimeout",
]);

const BACKOFF_MS = [50, 200];
/** A rate-limit readout is a few hundred bytes; anything bigger is not one. */
const MAX_ENTITLEMENT_BYTES = 16 * 1024;

export class AttemptUsageWriteError extends Error {
  constructor(
    readonly attemptId: string,
    readonly code: string,
  ) {
    super(`attempt usage write failed (${code})`);
    this.name = "AttemptUsageWriteError";
  }
}

function toItem(attempt: AttemptUsage, now: Date): Record<string, unknown> {
  if (!attempt.attemptId || !attempt.runId || !attempt.fundingPrincipalId || !attempt.startedAt) {
    throw new AttemptUsageWriteError(attempt.attemptId || "(none)", "invalid_attempt");
  }
  let entitlementObs = attempt.entitlementObs;
  if (entitlementObs !== undefined) {
    let size = Infinity;
    try {
      size = Buffer.byteLength(JSON.stringify(entitlementObs) ?? "", "utf8");
    } catch {
      // not serializable: treated as oversized below
    }
    if (size > MAX_ENTITLEMENT_BYTES) entitlementObs = { truncated: true };
  }
  return {
    ...attempt,
    entitlementObs,
    recordedAt: now.toISOString(),
    [ATTEMPT_USAGE_TTL_ATTRIBUTE]: Math.floor(now.getTime() / 1000) + ATTEMPT_USAGE_RETENTION_DAYS * 86_400,
  };
}

export type AttemptQuery =
  | { connectionId: string }
  | { fundingPrincipalId: string }
  | { runId: string };

export class DynamoAttemptUsageJournal implements AttemptUsageJournal {
  constructor(
    private readonly client: DocClient = docClient(),
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Records the attempt exactly once. A duplicate (the same `attemptId` already
   * recorded) is a success, not an error. Transient failures are retried a bounded
   * number of times, which is safe because the write is idempotent; anything else, or
   * running out of retries, throws an error that carries the attempt id and an error
   * code and nothing else.
   */
  async record(attempt: AttemptUsage): Promise<void> {
    const item = toItem(attempt, this.now());
    let lastCode = "unknown";
    for (let tryNo = 0; tryNo <= BACKOFF_MS.length; tryNo++) {
      try {
        await this.client
          .put({
            TableName: ATTEMPT_USAGE_TABLE,
            Item: item,
            ConditionExpression: "attribute_not_exists(attemptId)",
          })
          .promise();
        return;
      } catch (err) {
        const code = (err as { code?: string })?.code ?? "unknown";
        if (code === "ConditionalCheckFailedException") return; // already recorded
        lastCode = code;
        if (!RETRYABLE_CODES.has(code) || tryNo === BACKOFF_MS.length) break;
        await this.sleep(BACKOFF_MS[tryNo]);
      }
    }
    throw new AttemptUsageWriteError(attempt.attemptId, lastCode);
  }

  /**
   * Replays attempts in time order for one connection, customer or run, optionally
   * within [from, to] (ISO strings). This is what every projection (a connection's
   * monthly usage, a run's total, the reconciliation with the ledger) is rebuilt from.
   */
  async *iterateAttempts(query: AttemptQuery, range: { from?: string; to?: string } = {}): AsyncGenerator<AttemptUsage> {
    const [indexName, keyName, keyValue] =
      "connectionId" in query
        ? [ATTEMPT_USAGE_CONNECTION_INDEX, "connectionId", query.connectionId]
        : "fundingPrincipalId" in query
          ? [ATTEMPT_USAGE_PRINCIPAL_INDEX, "fundingPrincipalId", query.fundingPrincipalId]
          : [ATTEMPT_USAGE_RUN_INDEX, "runId", query.runId];

    let startKey: AWS.DynamoDB.DocumentClient.Key | undefined;
    do {
      const page = await this.client
        .query({
          TableName: ATTEMPT_USAGE_TABLE,
          IndexName: indexName,
          KeyConditionExpression: `${keyName} = :key AND startedAt BETWEEN :from AND :to`,
          ExpressionAttributeValues: {
            ":key": keyValue,
            ":from": range.from ?? "0000-01-01T00:00:00.000Z",
            ":to": range.to ?? "9999-12-31T23:59:59.999Z",
          },
          ScanIndexForward: true,
          ...(startKey ? { ExclusiveStartKey: startKey } : {}),
        })
        .promise();
      for (const row of (page.Items ?? []) as Array<AttemptUsage & { ttl?: number; recordedAt?: string }>) {
        const { ttl: _ttl, recordedAt: _recordedAt, ...attempt } = row;
        yield attempt;
      }
      startKey = page.LastEvaluatedKey;
    } while (startKey);
  }
}
