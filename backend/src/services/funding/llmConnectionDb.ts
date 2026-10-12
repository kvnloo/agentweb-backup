/**
 * ENG-2105 (A1): DynamoDB store for LlmConnection records.
 *
 * One item per connection. The sealed provider key lives on the item and is removed
 * in the same write that revokes it. Nothing here decrypts.
 */

import AWS from "aws-sdk";
import type { LlmConnectionKind, LlmConnectionStatus } from "./llmConnection";
import type { SealedSecret } from "./llmConnectionCrypto";

const TABLE_PREFIX = process.env.NODE_ENV === "development" ? "Dev-" : "";
export const LLM_CONNECTIONS_TABLE = `${TABLE_PREFIX}AW-LlmConnections`;
export const LLM_CONNECTIONS_OWNER_INDEX = "OwnerIndex";
export const LLM_CONNECTIONS_ORG_INDEX = "OrgIndex";
export const LLM_CONNECTIONS_PROVIDER_INDEX = "ProviderIndex";

/**
 * The table definition the boot-time ensureCriticalTables creates. The copy in
 * scripts/create-tables.ts must match it (that script cannot import from services);
 * llmConnectionTable.test.ts fails if the two differ.
 *
 * Deletion protection is on. Point-in-time recovery is deliberately NOT enabled:
 * revoking a connection deletes its encrypted key, and a recovery window would keep
 * that ciphertext restorable for up to 35 days after the customer revoked it. Losing
 * the table costs customers a re-paste of their keys; that is the cheaper failure.
 */
export const LLM_CONNECTIONS_TABLE_SPEC: AWS.DynamoDB.CreateTableInput = {
  TableName: LLM_CONNECTIONS_TABLE,
  AttributeDefinitions: [
    { AttributeName: "connectionId", AttributeType: "S" },
    { AttributeName: "ownerUserId", AttributeType: "S" },
    { AttributeName: "orgId", AttributeType: "S" },
    { AttributeName: "createdAt", AttributeType: "S" },
    { AttributeName: "provider", AttributeType: "S" },
  ],
  KeySchema: [{ AttributeName: "connectionId", KeyType: "HASH" }],
  GlobalSecondaryIndexes: [
    {
      IndexName: LLM_CONNECTIONS_OWNER_INDEX,
      KeySchema: [
        { AttributeName: "ownerUserId", KeyType: "HASH" },
        { AttributeName: "createdAt", KeyType: "RANGE" },
      ],
      Projection: { ProjectionType: "ALL" },
    },
    {
      // Sparse: only connections currently shared with an org carry orgId.
      IndexName: LLM_CONNECTIONS_ORG_INDEX,
      KeySchema: [
        { AttributeName: "orgId", KeyType: "HASH" },
        { AttributeName: "createdAt", KeyType: "RANGE" },
      ],
      Projection: { ProjectionType: "ALL" },
    },
    {
      // Cross-user lookup for incident response: "every connection for provider X",
      // active or revoked. Not used by the service today — only by an operator.
      IndexName: LLM_CONNECTIONS_PROVIDER_INDEX,
      KeySchema: [
        { AttributeName: "provider", KeyType: "HASH" },
        { AttributeName: "createdAt", KeyType: "RANGE" },
      ],
      Projection: { ProjectionType: "ALL" },
    },
  ],
  BillingMode: "PAY_PER_REQUEST",
  DeletionProtectionEnabled: true,
};

export interface LlmConnectionRecord {
  connectionId: string;
  ownerUserId: string;
  kind: LlmConnectionKind;
  provider: string;
  status: LlmConnectionStatus;
  keyLast4: string;
  createdAt: string;
  updatedAt: string;
  /** Present only while the key is shared with the owner's org; it is the OrgIndex key. */
  orgId?: string;
  /** Present until the connection is revoked. */
  sealed?: SealedSecret;
  /** The admin who acted in a delegated session, when one did. */
  addedByAdminId?: string;
  revokedAt?: string;
  revokedByUserId?: string;
  revokedByAdminId?: string;
  lastCheckedAt?: string;
  lastCheckResult?: string;
  lastOkAt?: string;
}

type DocClient = Pick<AWS.DynamoDB.DocumentClient, "put" | "get" | "update" | "query" | "transactWrite">;

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

function isConditionFailure(err: unknown): boolean {
  return (err as { code?: string })?.code === "ConditionalCheckFailedException";
}

/** The owner's per-owner slot counter lives as its own item, invisible to every GSI
 * (it carries none of their key attributes), so it never surfaces as a phantom
 * connection in `listByOwner`/`listSharedWithOrg`/`listByProvider`. */
function slotCounterKey(ownerUserId: string): string {
  return `limit#${ownerUserId}`;
}

export class LlmConnectionDb {
  constructor(private readonly client: DocClient = docClient()) {}

  async create(record: LlmConnectionRecord): Promise<void> {
    await this.client
      .put({ TableName: LLM_CONNECTIONS_TABLE, Item: record, ConditionExpression: "attribute_not_exists(connectionId)" })
      .promise();
  }

  /**
   * Creates the connection only if doing so keeps the owner's active count at or under
   * `cap`, both checked and applied in one DynamoDB transaction. A plain
   * read-then-write (count the owner's rows, then `create`) has a window between the
   * two where concurrent calls each see a count under the cap and all succeed; this
   * closes it by making the count itself a conditional write in the same transaction
   * as the create, which DynamoDB evaluates and applies atomically.
   *
   * Returns false when the cap was reached. Throws on any other failure, including
   * the astronomically unlikely case of a `connectionId` collision, which is a bug to
   * surface rather than a limit to report.
   */
  async createWithinLimit(record: LlmConnectionRecord, cap: number): Promise<boolean> {
    try {
      await this.client
        .transactWrite({
          TransactItems: [
            {
              Update: {
                TableName: LLM_CONNECTIONS_TABLE,
                Key: { connectionId: slotCounterKey(record.ownerUserId) },
                UpdateExpression: "SET activeCount = if_not_exists(activeCount, :zero) + :one",
                ConditionExpression: "attribute_not_exists(activeCount) OR activeCount < :cap",
                ExpressionAttributeValues: { ":zero": 0, ":one": 1, ":cap": cap },
              },
            },
            {
              Put: {
                TableName: LLM_CONNECTIONS_TABLE,
                Item: record,
                ConditionExpression: "attribute_not_exists(connectionId)",
              },
            },
          ],
        })
        .promise();
      return true;
    } catch (err) {
      const reasons = (err as { code?: string; CancellationReasons?: { Code?: string }[] })?.CancellationReasons;
      if ((err as { code?: string })?.code === "TransactionCanceledException" && Array.isArray(reasons)) {
        // Items are positional: index 0 is the slot counter, index 1 is the create.
        // Only a counter failure is the cap; a create failure is a real id collision.
        if (reasons[0]?.Code === "ConditionalCheckFailed") return false;
      }
      throw err;
    }
  }

  /**
   * Gives back the slot a revoked connection held. Best-effort by design: the revoke
   * itself has already succeeded by the time this runs, and a bookkeeping miss here
   * must never be mistaken for the revoke having failed. Floors at zero so a missing
   * or already-zero counter is a no-op, not an error.
   */
  async releaseSlot(ownerUserId: string): Promise<void> {
    try {
      await this.client
        .update({
          TableName: LLM_CONNECTIONS_TABLE,
          Key: { connectionId: slotCounterKey(ownerUserId) },
          UpdateExpression: "SET activeCount = activeCount - :one",
          ConditionExpression: "attribute_exists(activeCount) AND activeCount > :zero",
          ExpressionAttributeValues: { ":one": 1, ":zero": 0 },
        })
        .promise();
    } catch (err) {
      if (isConditionFailure(err)) return;
      throw err;
    }
  }

  /** Strongly consistent: a revoke must be visible to the very next read. */
  async get(connectionId: string): Promise<LlmConnectionRecord | null> {
    const result = await this.client
      .get({ TableName: LLM_CONNECTIONS_TABLE, Key: { connectionId }, ConsistentRead: true })
      .promise();
    return (result.Item as LlmConnectionRecord | undefined) ?? null;
  }

  /** Oldest first, which is the order connections are tried in. */
  async listByOwner(ownerUserId: string): Promise<LlmConnectionRecord[]> {
    return this.queryAll({
      TableName: LLM_CONNECTIONS_TABLE,
      IndexName: LLM_CONNECTIONS_OWNER_INDEX,
      KeyConditionExpression: "ownerUserId = :owner",
      ExpressionAttributeValues: { ":owner": ownerUserId },
      ScanIndexForward: true,
    });
  }

  /** For incident response: every connection for a provider, active or revoked, across every user. */
  async listByProvider(provider: string): Promise<LlmConnectionRecord[]> {
    return this.queryAll({
      TableName: LLM_CONNECTIONS_TABLE,
      IndexName: LLM_CONNECTIONS_PROVIDER_INDEX,
      KeyConditionExpression: "provider = :provider",
      ExpressionAttributeValues: { ":provider": provider },
      ScanIndexForward: true,
    });
  }

  async listSharedWithOrg(orgId: string): Promise<LlmConnectionRecord[]> {
    return this.queryAll({
      TableName: LLM_CONNECTIONS_TABLE,
      IndexName: LLM_CONNECTIONS_ORG_INDEX,
      KeyConditionExpression: "orgId = :org",
      ExpressionAttributeValues: { ":org": orgId },
      ScanIndexForward: true,
    });
  }

  private async queryAll(params: AWS.DynamoDB.DocumentClient.QueryInput): Promise<LlmConnectionRecord[]> {
    const items: LlmConnectionRecord[] = [];
    let startKey: AWS.DynamoDB.DocumentClient.Key | undefined;
    do {
      const page = await this.client.query({ ...params, ...(startKey ? { ExclusiveStartKey: startKey } : {}) }).promise();
      items.push(...((page.Items as LlmConnectionRecord[] | undefined) ?? []));
      startKey = page.LastEvaluatedKey;
    } while (startKey);
    return items;
  }

  /**
   * Marks the connection revoked and removes the sealed key and the org share in the
   * same write. Returns false when it was already revoked or does not exist.
   */
  async revoke(connectionId: string, by: { userId: string; adminId?: string }, now: string): Promise<boolean> {
    try {
      await this.client
        .update({
          TableName: LLM_CONNECTIONS_TABLE,
          Key: { connectionId },
          UpdateExpression:
            "SET #status = :revoked, revokedAt = :now, updatedAt = :now, revokedByUserId = :by" +
            (by.adminId ? ", revokedByAdminId = :admin" : "") +
            " REMOVE sealed, orgId",
          ConditionExpression: "attribute_exists(connectionId) AND attribute_not_exists(revokedAt)",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: {
            ":revoked": "revoked",
            ":now": now,
            ":by": by.userId,
            ...(by.adminId ? { ":admin": by.adminId } : {}),
          },
        })
        .promise();
      return true;
    } catch (err) {
      if (isConditionFailure(err)) return false;
      throw err;
    }
  }

  /** Shares with an org, or stops sharing when orgId is null. Never touches a revoked connection. */
  async setSharedOrg(connectionId: string, orgId: string | null, now: string): Promise<boolean> {
    try {
      await this.client
        .update({
          TableName: LLM_CONNECTIONS_TABLE,
          Key: { connectionId },
          UpdateExpression: orgId ? "SET orgId = :org, updatedAt = :now" : "SET updatedAt = :now REMOVE orgId",
          ConditionExpression: "attribute_exists(connectionId) AND attribute_not_exists(revokedAt)",
          ExpressionAttributeValues: { ":now": now, ...(orgId ? { ":org": orgId } : {}) },
        })
        .promise();
      return true;
    } catch (err) {
      if (isConditionFailure(err)) return false;
      throw err;
    }
  }

  /** Records a validation outcome. Never revives a revoked connection. */
  async recordCheck(
    connectionId: string,
    check: { result: string; status: Extract<LlmConnectionStatus, "active" | "invalid">; ok: boolean },
    now: string,
  ): Promise<boolean> {
    try {
      await this.client
        .update({
          TableName: LLM_CONNECTIONS_TABLE,
          Key: { connectionId },
          UpdateExpression:
            "SET #status = :status, lastCheckedAt = :now, lastCheckResult = :result, updatedAt = :now" +
            (check.ok ? ", lastOkAt = :now" : ""),
          ConditionExpression: "attribute_exists(connectionId) AND attribute_not_exists(revokedAt)",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: { ":status": check.status, ":now": now, ":result": check.result },
        })
        .promise();
      return true;
    } catch (err) {
      if (isConditionFailure(err)) return false;
      throw err;
    }
  }
}
