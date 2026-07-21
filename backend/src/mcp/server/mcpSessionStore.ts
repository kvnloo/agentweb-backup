/**
 * MCP Session Store — durable, optionally-shared metadata store for MCP
 * Streamable-HTTP sessions.
 *
 * WHY THIS EXISTS (ENG-114)
 * -------------------------
 * The live `StreamableHTTPServerTransport` objects are process-local and cannot
 * be serialized across instances. What CAN be shared is the small amount of
 * session *metadata* the receiving instance needs to rehydrate a transport for a
 * session that was initialized on another instance: the authenticated user id and
 * whether the caller is an internal (backend-to-backend) client.
 *
 * With the default in-memory store the behavior is identical to the previous
 * per-process `Map`: the store and the local transport map are always in sync, so
 * an unknown session id is a genuine miss (→ 404 → SDK auto-reinitialize). With
 * the Dynamo-backed store selected (`MCP_SESSION_STORE=dynamo`) the store becomes
 * the cross-instance source of truth for session existence + liveness, so a tool
 * call that lands on an instance which did not create the session can be served
 * without a client-visible reinit.
 *
 * Follows the AW-MCPOAuth / AW-OAuthSessions DynamoDB pattern already used in
 * `oauthService.ts`: DocumentClient + TABLE_PREFIX, epoch-seconds `ttl` attribute
 * for native DynamoDB TTL, plus an explicit expiry check on read so eviction is
 * consistent across instances even before DynamoDB prunes the row.
 */

import AWS from "aws-sdk";

const TABLE_PREFIX = process.env.NODE_ENV === "development" ? "Dev-" : "";

/** Persisted session metadata. The live transport is NEVER stored here. */
export interface McpSessionRecord {
  sessionId: string;
  agentUserId?: string; // authenticated user id from API key / OAuth token
  isInternal: boolean; // internal backend-to-backend client (may override userId)
  createdAt: string; // ISO timestamp
  lastActivity: number; // epoch ms
  ttl: number; // epoch SECONDS — DynamoDB native TTL attribute
}

/** Fields the caller supplies; the store derives createdAt/lastActivity/ttl. */
export interface McpSessionInput {
  sessionId: string;
  agentUserId?: string;
  isInternal: boolean;
}

export interface McpSessionStore {
  /** Returns the record, or null if absent OR expired (consistent eviction). */
  get(sessionId: string): Promise<McpSessionRecord | null>;
  /** Create/replace a session record, stamping createdAt/lastActivity/ttl. */
  set(input: McpSessionInput): Promise<void>;
  /** Refresh lastActivity + ttl for a live session (no-op if absent). */
  touch(sessionId: string): Promise<void>;
  /** Remove a session record (idempotent). */
  delete(sessionId: string): Promise<void>;
}

const secondsFromNow = (ms: number) => Math.floor((Date.now() + ms) / 1000);

// ─── In-memory store (default; single-instance — behavior-preserving) ─────────

export class InMemoryMcpSessionStore implements McpSessionStore {
  private readonly records = new Map<string, McpSessionRecord>();

  constructor(private readonly sessionTtlMs: number) {}

  async get(sessionId: string): Promise<McpSessionRecord | null> {
    const record = this.records.get(sessionId);
    if (!record) return null;
    if (record.ttl <= Math.floor(Date.now() / 1000)) {
      // Expired — evict so memory stays bounded and reads are consistent.
      this.records.delete(sessionId);
      return null;
    }
    return record;
  }

  async set(input: McpSessionInput): Promise<void> {
    const now = Date.now();
    this.records.set(input.sessionId, {
      sessionId: input.sessionId,
      agentUserId: input.agentUserId,
      isInternal: input.isInternal,
      createdAt: new Date(now).toISOString(),
      lastActivity: now,
      ttl: secondsFromNow(this.sessionTtlMs),
    });
  }

  async touch(sessionId: string): Promise<void> {
    const record = this.records.get(sessionId);
    if (!record) return;
    record.lastActivity = Date.now();
    record.ttl = secondsFromNow(this.sessionTtlMs);
  }

  async delete(sessionId: string): Promise<void> {
    this.records.delete(sessionId);
  }
}

// ─── DynamoDB store (opt-in; shared across instances) ─────────────────────────

/**
 * Minimum wall-clock gap between persisted `touch` writes for a single session.
 * A live session refreshes its ttl at most once per interval to avoid a DynamoDB
 * write on every request while still keeping the row comfortably alive.
 */
const TOUCH_PERSIST_INTERVAL_MS = 60_000;

export class DynamoMcpSessionStore implements McpSessionStore {
  private readonly tableName: string;
  private readonly dynamodb: AWS.DynamoDB.DocumentClient;
  private readonly lastPersistedTouch = new Map<string, number>();

  constructor(private readonly sessionTtlMs: number) {
    this.tableName = `${TABLE_PREFIX}AW-MCPSessions`;
    this.dynamodb = new AWS.DynamoDB.DocumentClient({
      region: process.env.AWS_REGION || "us-west-2",
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID || "",
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "",
      },
    });
  }

  async get(sessionId: string): Promise<McpSessionRecord | null> {
    const result = await this.dynamodb
      .get({ TableName: this.tableName, Key: { sessionId } })
      .promise();
    const record = result.Item as McpSessionRecord | undefined;
    if (!record) return null;
    if (record.ttl <= Math.floor(Date.now() / 1000)) {
      // Expired (DynamoDB TTL deletion lags up to ~48h) — treat as gone so
      // eviction is consistent across instances.
      return null;
    }
    return record;
  }

  async set(input: McpSessionInput): Promise<void> {
    const now = Date.now();
    const record: McpSessionRecord = {
      sessionId: input.sessionId,
      // DynamoDB rejects `undefined` attribute values — only set when present.
      ...(input.agentUserId ? { agentUserId: input.agentUserId } : {}),
      isInternal: input.isInternal,
      createdAt: new Date(now).toISOString(),
      lastActivity: now,
      ttl: secondsFromNow(this.sessionTtlMs),
    };
    await this.dynamodb
      .put({ TableName: this.tableName, Item: record })
      .promise();
    this.lastPersistedTouch.set(input.sessionId, now);
  }

  async touch(sessionId: string): Promise<void> {
    const now = Date.now();
    const last = this.lastPersistedTouch.get(sessionId) || 0;
    if (now - last < TOUCH_PERSIST_INTERVAL_MS) return; // throttle writes
    this.lastPersistedTouch.set(sessionId, now);
    try {
      await this.dynamodb
        .update({
          TableName: this.tableName,
          Key: { sessionId },
          // Only refresh a row that still exists — never resurrect a deleted one.
          ConditionExpression: "attribute_exists(sessionId)",
          UpdateExpression: "SET lastActivity = :la, #ttl = :ttl",
          ExpressionAttributeNames: { "#ttl": "ttl" },
          ExpressionAttributeValues: {
            ":la": now,
            ":ttl": secondsFromNow(this.sessionTtlMs),
          },
        })
        .promise();
    } catch (err: any) {
      if (err?.code === "ConditionalCheckFailedException") return; // gone — fine
      throw err;
    }
  }

  async delete(sessionId: string): Promise<void> {
    this.lastPersistedTouch.delete(sessionId);
    await this.dynamodb
      .delete({ TableName: this.tableName, Key: { sessionId } })
      .promise();
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Selects the store implementation from `MCP_SESSION_STORE`:
 *   - "dynamo" → shared, cross-instance DynamoDB store
 *   - anything else (default) → in-memory store (single-instance, unchanged)
 */
export function createMcpSessionStore(sessionTtlMs: number): McpSessionStore {
  if ((process.env.MCP_SESSION_STORE || "memory").toLowerCase() === "dynamo") {
    console.log("[MCP] Session store: DynamoDB (shared, multi-instance)");
    return new DynamoMcpSessionStore(sessionTtlMs);
  }
  return new InMemoryMcpSessionStore(sessionTtlMs);
}
