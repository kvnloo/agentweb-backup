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
  // ---- claude_subscription only (ENG-2110). Flat attributes, expiries as epoch-ms numbers
  // ---- so conditional compares work in DynamoDB and in the in-memory test double.
  /** Compare-and-swap counter for `sealed`; starts at 1, +1 on every save. */
  subVersion?: number;
  /** Random token of the process that holds the (single) live copy of the login. */
  subLeaseOwner?: string;
  subLeaseUntil?: number;
  subType?: string;
  subTier?: string;
  subAccessExpiresAtMs?: number;
  /** Fixed 30 days from login; does NOT move on refresh. */
  subRefreshExpiresAtMs?: number;
  subSavedAt?: string;
  /** sha256 of the stored login text: lets a writer tell "my earlier write landed" from "someone else's". */
  subContentHash?: string;
  /** The stored login is probably dead (the CLI said so); the owner must sign in again. */
  subNeedsReconnect?: boolean;
  subReconnectReason?: string;
  // ---- hosted logins (ENG-2110 1c): the login lives in a per-customer home on the login host, which only the CLI touches.
  // ---- A hosted row holds NO secret: no `sealed`, no `subVersion`, no lease. All names start with `sub` so subUpdate aliases them.
  subHosted?: boolean;
  /** The credential epoch the host must agree on; moves up on reconnect and on disconnect (fencing). */
  subHostEpoch?: number;
  /** Non-secret account id the provider offers without reading tokens. */
  subAccountFingerprint?: string;
  subRevokeStartedAt?: string;
  /** Set in the SAME transaction that gives the owner's slot back, so the slot is returned exactly once however often a disconnect is retried. */
  subSlotReleased?: boolean;
  subRevokeAttempts?: number;
  subLastRevokeAttemptAt?: string;
}

/** Non-secret facts read from a Claude login, kept next to the sealed blob. */
export interface SubHealth {
  type: string;
  tier: string;
  accessExpiresAtMs: number;
  refreshExpiresAtMs: number;
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
          // A hosted login is never revoked by this write: its home must be wiped by the login host first (hostedMarkRevoked).
          ConditionExpression: "attribute_exists(connectionId) AND attribute_not_exists(revokedAt) AND attribute_not_exists(#hosted)",
          ExpressionAttributeNames: { "#status": "status", "#hosted": "subHosted" },
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
          // API keys only: a Claude login is never shared (ENG-2110).
          ConditionExpression: "attribute_exists(connectionId) AND attribute_not_exists(revokedAt) AND #kind = :apiKey",
          ExpressionAttributeNames: { "#kind": "kind" },
          ExpressionAttributeValues: { ":now": now, ":apiKey": "api_key", ...(orgId ? { ":org": orgId } : {}) },
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
          // API keys only: a provider-key check must never rewrite a Claude login's status.
          ConditionExpression: "attribute_exists(connectionId) AND attribute_not_exists(revokedAt) AND #kind = :apiKey",
          ExpressionAttributeNames: { "#status": "status", "#kind": "kind" },
          ExpressionAttributeValues: { ":status": check.status, ":now": now, ":result": check.result, ":apiKey": "api_key" },
        })
        .promise();
      return true;
    } catch (err) {
      if (isConditionFailure(err)) return false;
      throw err;
    }
  }

  // ===================== claude_subscription (ENG-2110) =====================
  // A refresh token is single-use, so exactly one live copy of a login may exist. The
  // lease says who holds it; the version makes every save a compare-and-swap.

  /** Takes the single live copy for `ms`. False when held, revoked, not active, needs reconnect, or not a subscription. */
  async acquireSubLease(connectionId: string, owner: string, nowMs: number, ms: number): Promise<boolean> {
    return this.subUpdate(connectionId, {
      update: "SET subLeaseOwner = :me, subLeaseUntil = :until",
      condition:
        "attribute_exists(connectionId) AND #kind = :sub AND attribute_not_exists(revokedAt) AND #status = :active AND subNeedsReconnect = :no AND (attribute_not_exists(subLeaseUntil) OR subLeaseUntil < :now)",
      names: { "#kind": "kind", "#status": "status" },
      values: { ":me": owner, ":until": nowMs + ms, ":sub": "claude_subscription", ":active": "active", ":no": false, ":now": nowMs },
    });
  }

  /** Extends the lease only while it is still ours (even if it lapsed, as long as nobody took it). */
  async extendSubLease(connectionId: string, owner: string, nowMs: number, ms: number): Promise<boolean> {
    return this.subUpdate(connectionId, {
      update: "SET subLeaseUntil = :until",
      condition: "attribute_exists(connectionId) AND #kind = :sub AND attribute_not_exists(revokedAt) AND subLeaseOwner = :me",
      names: { "#kind": "kind" },
      values: { ":me": owner, ":until": nowMs + ms, ":sub": "claude_subscription" },
    });
  }

  async releaseSubLease(connectionId: string, owner: string): Promise<void> {
    await this.subUpdate(connectionId, {
      update: "REMOVE subLeaseOwner, subLeaseUntil",
      condition: "attribute_exists(connectionId) AND subLeaseOwner = :me",
      values: { ":me": owner },
    });
  }

  /**
   * Replaces the sealed login if, and only if, the caller still holds the lease and the
   * stored version is the one it started from. 'stale' means the stored copy moved on
   * (or the lease was lost); 'revoked' means the connection is gone.
   */
  async saveSubCredentials(
    connectionId: string,
    save: { owner: string; expectedVersion: number; sealed: SealedSecret; health: SubHealth; nowIso: string; contentHash?: string },
  ): Promise<"ok" | "stale" | "revoked"> {
    const ok = await this.subUpdate(connectionId, {
      update:
        "SET sealed = :sealed, subVersion = :next, subSavedAt = :now, updatedAt = :now, subType = :type, subTier = :tier, subAccessExpiresAtMs = :acc, subRefreshExpiresAtMs = :ref, subContentHash = :hash",
      condition:
        "attribute_exists(connectionId) AND #kind = :sub AND attribute_not_exists(revokedAt) AND subLeaseOwner = :me AND subVersion = :v",
      names: { "#kind": "kind" },
      values: {
        ":hash": save.contentHash ?? "",
        ":sealed": save.sealed,
        ":next": save.expectedVersion + 1,
        ":now": save.nowIso,
        ":type": save.health.type,
        ":tier": save.health.tier,
        ":acc": save.health.accessExpiresAtMs,
        ":ref": save.health.refreshExpiresAtMs,
        ":sub": "claude_subscription",
        ":me": save.owner,
        ":v": save.expectedVersion,
      },
    });
    if (ok) return "ok";
    const current = await this.get(connectionId);
    return !current || current.revokedAt ? "revoked" : "stale";
  }

  /** Sign-in again for an existing connection: replaces the login in place. Refused while anyone holds the lease. */
  async replaceSubCredentials(
    connectionId: string,
    replace: { expectedVersion: number; sealed: SealedSecret; health: SubHealth; nowMs: number; nowIso: string; contentHash?: string },
  ): Promise<boolean> {
    return this.subUpdate(connectionId, {
      update:
        "SET sealed = :sealed, subVersion = :next, subSavedAt = :now, updatedAt = :now, subType = :type, subTier = :tier, subAccessExpiresAtMs = :acc, subRefreshExpiresAtMs = :ref, subContentHash = :hash, #status = :active, subNeedsReconnect = :no REMOVE subReconnectReason, subLeaseOwner, subLeaseUntil",
      condition:
        "attribute_exists(connectionId) AND #kind = :sub AND attribute_not_exists(revokedAt) AND subVersion = :v AND (attribute_not_exists(subLeaseUntil) OR subLeaseUntil < :nowMs)",
      names: { "#kind": "kind", "#status": "status" },
      values: {
        ":hash": replace.contentHash ?? "",
        ":sealed": replace.sealed,
        ":next": replace.expectedVersion + 1,
        ":now": replace.nowIso,
        ":type": replace.health.type,
        ":tier": replace.health.tier,
        ":acc": replace.health.accessExpiresAtMs,
        ":ref": replace.health.refreshExpiresAtMs,
        ":sub": "claude_subscription",
        ":active": "active",
        ":no": false,
        ":v": replace.expectedVersion,
        ":nowMs": replace.nowMs,
      },
    });
  }

  /** The CLI said the stored login is dead. Conditional on the version, so a copy saved meanwhile is never flagged. */
  async markSubNeedsReconnect(connectionId: string, expectedVersion: number, reason: string, nowIso: string): Promise<boolean> {
    return this.subUpdate(connectionId, {
      update: "SET subNeedsReconnect = :yes, subReconnectReason = :reason, updatedAt = :now",
      condition: "attribute_exists(connectionId) AND #kind = :sub AND attribute_not_exists(revokedAt) AND subVersion = :v",
      names: { "#kind": "kind" },
      values: { ":yes": true, ":reason": reason, ":now": nowIso, ":sub": "claude_subscription", ":v": expectedVersion },
    });
  }

  /** The refresh token's fixed lifetime has run out. */
  async markSubExpired(connectionId: string, nowMs: number, nowIso: string): Promise<boolean> {
    return this.subUpdate(connectionId, {
      update: "SET #status = :expired, updatedAt = :now",
      condition:
        "attribute_exists(connectionId) AND #kind = :sub AND attribute_not_exists(revokedAt) AND #status = :active AND subRefreshExpiresAtMs < :nowMs",
      names: { "#kind": "kind", "#status": "status" },
      values: { ":expired": "expired", ":active": "active", ":sub": "claude_subscription", ":nowMs": nowMs, ":now": nowIso },
    });
  }

  // ===================== hosted logins (ENG-2110 1c) =====================
  /**
   * The owner disconnected: fence the connection (epoch up), stop it being usable (`revoking`) and drop any org share. The
   * caller releases the owner's slot when this returns "started". "already" = it is revoking or revoked (retries are fine).
   * The epoch it fenced at is returned: when a concurrent reconnect moved the epoch, this re-reads and fences ABOVE it instead of
   * misreporting "already". Nothing here says the login host has wiped the home: only `hostedMarkRevoked` does.
   */
  async hostedBeginRevoke(
    connectionId: string,
    nextEpoch: number,
    by: { userId: string; adminId?: string },
    nowIso: string,
  ): Promise<{ result: "started" | "already" | "missing" | "not_hosted" | "contended"; epoch: number }> {
    let next = nextEpoch;
    for (let attempt = 0; attempt < 4; attempt++) {
      const started = await this.subUpdate(connectionId, {
        update:
          "SET #status = :revoking, subHostEpoch = :next, subRevokeStartedAt = :now, updatedAt = :now, revokedByUserId = :by" +
          (by.adminId ? ", revokedByAdminId = :admin" : "") +
          " REMOVE orgId",
        condition:
          "attribute_exists(connectionId) AND #kind = :sub AND subHosted = :yes AND attribute_not_exists(revokedAt) AND subHostEpoch < :next AND " +
          "(#status = :active OR #status = :invalid OR #status = :disabled OR #status = :expired)",
        names: { "#kind": "kind", "#status": "status" },
        values: {
          ":revoking": "revoking", ":next": next, ":now": nowIso, ":by": by.userId, ":sub": "claude_subscription", ":yes": true,
          ":active": "active", ":invalid": "invalid", ":disabled": "disabled", ":expired": "expired",
          ...(by.adminId ? { ":admin": by.adminId } : {}),
        },
      });
      if (started) return { result: "started", epoch: next };
      const now = await this.get(connectionId);
      if (!now) return { result: "missing", epoch: next };
      if (!now.subHosted) return { result: "not_hosted", epoch: next };
      if (now.status === "revoking" || now.status === "revoked" || now.revokedAt) return { result: "already", epoch: now.subHostEpoch ?? next };
      // Still usable but the epoch moved under us (a reconnect): fence above whatever it is now.
      next = Math.max(next, (now.subHostEpoch ?? 0) + 1);
    }
    return { result: "contended", epoch: next };
  }

  /**
   * Gives the owner's slot back for a disconnecting hosted login, exactly once: the row's `subSlotReleased` flag and the counter
   * decrement are ONE transaction, so a crash or a failed call between "revoking" and the release cannot leak the slot, and a retry
   * (or the sweeper) cannot release it twice.
   */
  async hostedReleaseSlot(connectionId: string, ownerUserId: string): Promise<"released" | "already"> {
    try {
      await this.client
        .transactWrite({
          TransactItems: [
            {
              Update: {
                TableName: LLM_CONNECTIONS_TABLE,
                Key: { connectionId },
                UpdateExpression: "SET #rel = :t",
                ConditionExpression: "attribute_exists(connectionId) AND #hosted = :t AND attribute_not_exists(#rel)",
                ExpressionAttributeNames: { "#rel": "subSlotReleased", "#hosted": "subHosted" },
                ExpressionAttributeValues: { ":t": true },
              },
            },
            {
              Update: {
                TableName: LLM_CONNECTIONS_TABLE,
                Key: { connectionId: slotCounterKey(ownerUserId) },
                UpdateExpression: "SET activeCount = activeCount - :one",
                ConditionExpression: "attribute_exists(activeCount) AND activeCount > :zero",
                ExpressionAttributeValues: { ":one": 1, ":zero": 0 },
              },
            },
          ],
        })
        .promise();
      return "released";
    } catch (err) {
      const reasons = (err as { code?: string; CancellationReasons?: { Code?: string }[] })?.CancellationReasons;
      if ((err as { code?: string })?.code === "TransactionCanceledException" && Array.isArray(reasons)) {
        if (reasons[0]?.Code === "ConditionalCheckFailed") return "already"; // flag already set (or not a hosted row): nothing to give back
        if (reasons[1]?.Code === "ConditionalCheckFailed") {
          // The counter is already at zero or missing: nothing to decrement, but record that this row's release is done.
          await this.subUpdate(connectionId, {
            update: "SET subSlotReleased = :t",
            condition: "attribute_exists(connectionId) AND subHosted = :t AND attribute_not_exists(subSlotReleased)",
            values: { ":t": true },
          });
          return "released";
        }
      }
      throw err;
    }
  }

  /** The login host confirmed the wipe (or never had the home). Only moves `revoking` -> `revoked`. */
  async hostedMarkRevoked(connectionId: string, nowIso: string): Promise<boolean> {
    return this.subUpdate(connectionId, {
      update: "SET #status = :revoked, revokedAt = :now, updatedAt = :now",
      condition: "attribute_exists(connectionId) AND subHosted = :yes AND #status = :revoking",
      names: { "#status": "status" },
      values: { ":revoked": "revoked", ":revoking": "revoking", ":now": nowIso, ":yes": true },
    });
  }

  async hostedNoteRevokeAttempt(connectionId: string, nowIso: string): Promise<void> {
    await this.subUpdate(connectionId, {
      update: "SET subRevokeAttempts = if_not_exists(subRevokeAttempts, :zero) + :one, subLastRevokeAttemptAt = :now",
      condition: "attribute_exists(connectionId) AND subHosted = :yes AND #status = :revoking",
      names: { "#status": "status" },
      values: { ":zero": 0, ":one": 1, ":now": nowIso, ":yes": true, ":revoking": "revoking" },
    });
  }

  /** Reconnect step 1: the record moves to the epoch the host will be asked to promote. Conditional on the epoch we read. */
  async hostedAdvanceEpoch(connectionId: string, expectedEpoch: number, nextEpoch: number, nowIso: string): Promise<boolean> {
    return this.subUpdate(connectionId, {
      update: "SET subHostEpoch = :next, updatedAt = :now",
      condition:
        "attribute_exists(connectionId) AND subHosted = :yes AND attribute_not_exists(revokedAt) AND subHostEpoch = :cur AND " +
        "(#status = :active OR #status = :invalid OR #status = :disabled OR #status = :expired)",
      names: { "#status": "status" },
      values: { ":next": nextEpoch, ":cur": expectedEpoch, ":now": nowIso, ":yes": true, ":active": "active", ":invalid": "invalid", ":disabled": "disabled", ":expired": "expired" },
    });
  }

  /** The host cannot serve this login any more (home lost, login dead, promote failed): the owner must sign in again. */
  async hostedMarkNeedsReconnect(connectionId: string, epoch: number, reason: string, nowIso: string, ifUpdatedAt?: string): Promise<boolean> {
    return this.subUpdate(connectionId, {
      update: "SET #status = :invalid, subNeedsReconnect = :yes, subReconnectReason = :reason, updatedAt = :now",
      // `ifUpdatedAt`: the sweeper judged the row as it was when it read it; a write since then (a sign-in landing) wins.
      condition:
        "attribute_exists(connectionId) AND subHosted = :yes AND attribute_not_exists(revokedAt) AND subHostEpoch = :e AND (#status = :active OR #status = :invalid)" +
        (ifUpdatedAt ? " AND updatedAt = :readAt" : ""),
      names: { "#status": "status" },
      values: { ":invalid": "invalid", ":yes": true, ":reason": reason, ":now": nowIso, ":e": epoch, ":active": "active", ...(ifUpdatedAt ? { ":readAt": ifUpdatedAt } : {}) },
    });
  }

  /** Reconnect step 3: the host promoted the new login at `epoch`. */
  async hostedMarkReconnected(connectionId: string, epoch: number, ready: { plan?: string; refreshExpiresAtMs?: number; fingerprint?: string; status?: "active" | "disabled" }, nowIso: string): Promise<boolean> {
    // `status`: a host that deliberately keeps a replaced login disabled (an operator did that) stays disabled in the record too.
    const sets = ["#status = :target", "subNeedsReconnect = :no", "updatedAt = :now"];
    const values: Record<string, unknown> = { ":target": ready.status ?? "active", ":active": "active", ":no": false, ":now": nowIso, ":e": epoch, ":yes": true, ":invalid": "invalid", ":expired": "expired" };
    if (ready.plan) {
      sets.push("subType = :type");
      values[":type"] = ready.plan;
    }
    if (ready.refreshExpiresAtMs) {
      sets.push("subRefreshExpiresAtMs = :ref");
      values[":ref"] = ready.refreshExpiresAtMs;
    }
    if (ready.fingerprint) {
      sets.push("subAccountFingerprint = :fp");
      values[":fp"] = ready.fingerprint;
    }
    return this.subUpdate(connectionId, {
      update: `SET ${sets.join(", ")} REMOVE subReconnectReason`,
      condition: "attribute_exists(connectionId) AND subHosted = :yes AND attribute_not_exists(revokedAt) AND subHostEpoch = :e AND (#status = :active OR #status = :invalid OR #status = :expired)",
      names: { "#status": "status" },
      values,
    });
  }

  /** Every hosted login, any status (the sweeper filters). */
  async listHosted(): Promise<LlmConnectionRecord[]> {
    return (await this.listSubscriptions()).filter((r) => r.subHosted === true);
  }

  /** Every Claude-login connection, via the provider index (small: one row per connected customer). */
  async listSubscriptions(): Promise<LlmConnectionRecord[]> {
    return (await this.listByProvider("anthropic")).filter((r) => r.kind === "claude_subscription");
  }

  private async subUpdate(
    connectionId: string,
    u: { update: string; condition: string; names?: Record<string, string>; values?: Record<string, unknown> },
  ): Promise<boolean> {
    // Every attribute of a Claude login is referenced through an alias. DynamoDB's reserved-word list is long
    // and not obvious (`subType` is on it: found by the live test, which the in-memory test double cannot catch),
    // so no attribute is ever written bare in these expressions.
    const names: Record<string, string> = { ...(u.names ?? {}) };
    const alias = (expression: string) =>
      expression.replace(/(?<![#:\w])(sub[A-Z]\w*|sealed)\b/g, (_m, attr: string) => {
        names[`#a_${attr}`] = attr;
        return `#a_${attr}`;
      });
    const update = alias(u.update);
    const condition = alias(u.condition);
    try {
      await this.client
        .update({
          TableName: LLM_CONNECTIONS_TABLE,
          Key: { connectionId },
          UpdateExpression: update,
          ConditionExpression: condition,
          ...(Object.keys(names).length ? { ExpressionAttributeNames: names } : {}),
          ...(u.values ? { ExpressionAttributeValues: u.values } : {}),
        })
        .promise();
      return true;
    } catch (err) {
      if (isConditionFailure(err)) return false;
      throw err;
    }
  }
}
