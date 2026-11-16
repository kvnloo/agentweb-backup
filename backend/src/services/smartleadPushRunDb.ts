/**
 * ENG-673: the DynamoDB table behind a Smartlead push run, and the only code that reads or writes it.
 *
 * A push run walks a CRM lead list with a cursor and adds leads to a customer's Smartlead campaign in the background. The
 * per-lead state lives on the leads themselves (`system.smartlead_<campaignId>`, see smartleadMarkers.ts), so this table holds
 * only a few small items per run:
 *
 *   Run   pk = runId (ULID), sk = "RUN"     status, who and what, a cursor, counts, and a lease so one worker runs it
 *   Lock  pk = "LOCK#<listId>#<campaignId>"  the id of the one live run for that list and campaign
 *
 * Every write is a single-item conditional write. There are NO transactions: the backend's role has been denied them before
 * (ENG-2321). The Run item carries a `leaseEpoch` that rises on every claim; the write that advances the cursor is conditioned on
 * it and on `status = running`, so a worker that lost its lease, or whose run was paused or canceled, cannot move the run on.
 *
 * Extending this table (see dev/pending/eng-673-smartlead-push-runs-table.md):
 *  - a new field on a run: add it to PushRun, toItem and fromItem. Readers ignore attributes they do not know, and every item has
 *    `schemaVersion`, so older code keeps working;
 *  - a new kind of record (per-batch results, an event log): a new sort-key prefix under the same runId, no change to existing keys;
 *  - a new way to search runs: a new index. Indexes are NOT added to an existing table by ensureCriticalTables, so that needs a
 *    one-off migration (the note says how); the four below were chosen to make that rare.
 *  - business rules (what to push, when to pause) stay out of this file: it stores and fences, it does not decide.
 */

import AWS from "aws-sdk";
import { ulid } from "ulid";

const TABLE_PREFIX = process.env.NODE_ENV === "development" ? "Dev-" : "";
export const SMARTLEAD_PUSH_RUNS_TABLE = `${TABLE_PREFIX}AW-SmartleadPushRuns`;
export const LIST_RUNS_INDEX = "ListRunsIndex";
export const OWNER_RUNS_INDEX = "OwnerRunsIndex";
export const RUNS_BY_TIME_INDEX = "RunsByTimeIndex";
export const ACTIVE_RUNS_INDEX = "ActiveRunsIndex";
export const SMARTLEAD_PUSH_RUNS_TTL_ATTRIBUTE = "ttl";

export const SCHEMA_VERSION = 1;
/** A run is an audit record: kept this long after it is created or finished. */
export const RUN_RETENTION_DAYS = 400;
/** A lock is released explicitly; this is only a backstop. */
export const LOCK_RETENTION_DAYS = 15;
/** A worker's lease; it renews every HEARTBEAT_MS, so a lease only lapses when the worker is gone or stuck. */
export const LEASE_MS = 90_000;
export const HEARTBEAT_MS = 20_000;
/** A batch that fails this many times in a row stops the run (`partial`) instead of retrying for ever. */
export const MAX_BATCH_ATTEMPTS = 3;

const DAY_S = 86_400;

/** Runs summaries carried by the three history indexes; `listId`, `ownerId`, `kind` and `createdAt` are those indexes' own keys. */
// `ttl` is included so a run DynamoDB has not yet deleted (its TTL sweep lags by up to about two days) can be filtered out of a listing.
const SUMMARY_ATTRIBUTES = ["status", "campaignId", "campaignName", "counts", "startedAt", "finishedAt", "pushedBy", "channel", "ttl"];

/**
 * The table definition ensureCriticalTables creates at boot. The copy in scripts/create-tables.ts must match it (that script
 * cannot import from services); smartleadPushRunsTable.test.ts fails if the two differ. Point-in-time recovery and TTL are not
 * settable by CreateTable; ensureCriticalTables enables both as separate calls. Deletion protection is NOT on yet: indexes cannot
 * be changed after creation, so it is added (the boot reconcile already does that for an existing table) once the table is proven.
 */
export const SMARTLEAD_PUSH_RUNS_TABLE_SPEC: AWS.DynamoDB.CreateTableInput = {
  TableName: SMARTLEAD_PUSH_RUNS_TABLE,
  AttributeDefinitions: [
    { AttributeName: "pk", AttributeType: "S" },
    { AttributeName: "sk", AttributeType: "S" },
    { AttributeName: "listId", AttributeType: "S" },
    { AttributeName: "ownerId", AttributeType: "S" },
    { AttributeName: "kind", AttributeType: "S" },
    { AttributeName: "createdAt", AttributeType: "S" },
    { AttributeName: "active", AttributeType: "S" },
    { AttributeName: "leaseUntil", AttributeType: "N" },
  ],
  KeySchema: [
    { AttributeName: "pk", KeyType: "HASH" },
    { AttributeName: "sk", KeyType: "RANGE" },
  ],
  GlobalSecondaryIndexes: [
    {
      IndexName: LIST_RUNS_INDEX,
      KeySchema: [
        { AttributeName: "listId", KeyType: "HASH" },
        { AttributeName: "createdAt", KeyType: "RANGE" },
      ],
      Projection: { ProjectionType: "INCLUDE", NonKeyAttributes: SUMMARY_ATTRIBUTES },
    },
    {
      IndexName: OWNER_RUNS_INDEX,
      KeySchema: [
        { AttributeName: "ownerId", KeyType: "HASH" },
        { AttributeName: "createdAt", KeyType: "RANGE" },
      ],
      Projection: { ProjectionType: "INCLUDE", NonKeyAttributes: [...SUMMARY_ATTRIBUTES, "listId"] },
    },
    {
      IndexName: RUNS_BY_TIME_INDEX,
      KeySchema: [
        { AttributeName: "kind", KeyType: "HASH" },
        { AttributeName: "createdAt", KeyType: "RANGE" },
      ],
      Projection: { ProjectionType: "INCLUDE", NonKeyAttributes: [...SUMMARY_ATTRIBUTES, "listId", "ownerId"] },
    },
    {
      IndexName: ACTIVE_RUNS_INDEX,
      KeySchema: [
        { AttributeName: "active", KeyType: "HASH" },
        { AttributeName: "leaseUntil", KeyType: "RANGE" },
      ],
      Projection: { ProjectionType: "INCLUDE", NonKeyAttributes: ["status", "listId", "campaignId"] },
    },
  ],
  BillingMode: "PAY_PER_REQUEST",
};

// ─── Types ──────────────────────────────────────────────────────────────

export type PushRunStatus = "running" | "paused" | "partial" | "completed" | "failed" | "canceled";
/** A run that still holds its lock. */
export const LIVE_STATUSES: readonly PushRunStatus[] = ["running", "paused", "partial"];
export const TERMINAL_STATUSES: readonly PushRunStatus[] = ["completed", "failed", "canceled"];
const KNOWN_STATUSES = new Set<string>([...LIVE_STATUSES, ...TERMINAL_STATUSES]);

export interface PushRunCounts {
  examined: number;
  added: number;
  alreadyInCampaign: number;
  unconfirmed: number;
  withdrawn: number;
  skippedByReason: Record<string, number>;
}

/** What Smartlead later reported about the contacts of a run (ENG-673, slice 3). Contacts, not messages: a second reply from the same contact does not count again. */
export type ContactEventKind = "replied" | "bounced" | "unsubscribed";
export const CONTACT_EVENT_KINDS: readonly ContactEventKind[] = ["replied", "bounced", "unsubscribed"];
export interface PushRunEvents {
  replied: number;
  bounced: number;
  unsubscribed: number;
}

export interface LeadCursor {
  listId: string;
  leadId: string;
}

export interface PushRun {
  runId: string;
  schemaVersion: number;
  status: PushRunStatus;
  pauseReason?: string;
  ownerId: string;
  orgId?: string;
  pushedBy: string;
  keyOwnerId: string;
  smartleadAccountId: string;
  channel: "ui" | "agent";
  listId: string;
  campaignId: number;
  campaignName: string;
  /** `selected` now; `created` when AgentWeb one day creates the campaign itself. */
  campaignSource: "selected" | "created";
  options: Record<string, unknown>;
  sequenceHash: string;
  /** The count the user approved: a hard ceiling for the run. */
  previewEligible: number;
  counts: PushRunCounts;
  /** Absent until Smartlead first reports an event for one of this run's contacts (and for every run made before this existed). */
  events?: PushRunEvents;
  /** The key of the last lead examined; null at the start. */
  cursor: LeadCursor | null;
  /** True only when the walk reached the end of the list. A null cursor alone means both "start" and "finished". */
  listExhausted: boolean;
  batchAttempts: number;
  leaseOwner: string;
  leaseEpoch: number;
  leaseUntil: number;
  createdAt: string;
  startedAt: string;
  finishedAt?: string;
  failure?: { code: string; message: string };
  /**
   * True from the moment a start writes the run until the service has confirmed to the user that it started (confirmStart). While it is
   * set NOTHING may claim the run, and the resumer cancels it once its lease lapses: a start that failed or crashed half way, or was
   * reported as failed, can therefore never be picked up and sent unannounced.
   */
  startUnconfirmed?: boolean;
}

/** What the history indexes return: a summary, not the whole run. */
export interface PushRunSummary {
  runId: string;
  status: PushRunStatus;
  campaignId?: number;
  campaignName?: string;
  counts?: PushRunCounts;
  /** Not carried by the history indexes (a projection cannot be changed on a table that exists): the service fills it in from the base table. */
  events?: PushRunEvents;
  startedAt?: string;
  finishedAt?: string;
  pushedBy?: string;
  channel?: string;
  listId?: string;
  ownerId?: string;
  createdAt?: string;
  leaseUntil?: number;
}

export interface NewPushRun {
  ownerId: string;
  orgId?: string;
  pushedBy: string;
  keyOwnerId: string;
  smartleadAccountId: string;
  channel: "ui" | "agent";
  listId: string;
  campaignId: number;
  campaignName: string;
  campaignSource: "selected" | "created";
  options: Record<string, unknown>;
  sequenceHash: string;
  previewEligible: number;
}

export interface AdvanceStep {
  /** Where the walk is now: the key of the last lead examined. */
  /** Null only together with `listExhausted` (an empty list); the stored cursor is then left as it is. */
  cursor: LeadCursor | null;
  listExhausted?: boolean;
  counts: Partial<Record<"examined" | "added" | "alreadyInCampaign" | "unconfirmed" | "withdrawn", number>>;
  /** Skip reasons for this batch, e.g. `{ missing_tag: 3 }`. */
  skipped?: Record<string, number>;
}

export type StartResult =
  | { started: true; run: PushRun }
  /** The list and campaign already have a live run (`existing`), or a lock whose run is gone (`lockHeldBy`, needs an operator). */
  | { started: false; existing: PushRun | null; lockHeldBy?: string };

export type StoreErrorCode = "table_missing" | "access_denied" | "throttled" | "unavailable" | "unsupported_item" | "invalid_input";

/** The store could not do what was asked. The caller must fail closed (HTTP 503, push nothing); it must never be swallowed. */
export class SmartleadPushRunStoreError extends Error {
  /** Set when a start could not settle whether the run it wrote is live: the caller must keep trying to cancel THAT run. */
  constructor(public readonly code: StoreErrorCode, message: string, public readonly runId?: string) {
    super(message);
    this.name = "SmartleadPushRunStoreError";
  }
}

// ─── Items ──────────────────────────────────────────────────────────────

const RUN_SK = "RUN";
const LOCK_SK = "LOCK";
const TOKEN_SK = "TOKEN";
const lockKey = (listId: string, campaignId: number) => `LOCK#${listId}#${campaignId}`;

const emptyCounts = (): PushRunCounts => ({ examined: 0, added: 0, alreadyInCampaign: 0, unconfirmed: 0, withdrawn: 0, skippedByReason: {} });

type Item = Record<string, any>;

function num(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** The stored event counters, or undefined when the run has none. Tolerant: a missing or odd value counts as zero, never as an error. */
function readEvents(value: unknown): PushRunEvents | undefined {
  if (!value || typeof value !== "object") return undefined;
  const e = value as Record<string, unknown>;
  return { replied: num(e.replied), bounced: num(e.bounced), unsubscribed: num(e.unsubscribed) };
}

/** Builds the stored Run item. `active` (the sparse resume index) is present only while the run is live. */
export function toRunItem(run: PushRun, ttl: number): Item {
  const item: Item = {
    pk: run.runId,
    sk: RUN_SK,
    kind: "RUN",
    schemaVersion: run.schemaVersion,
    status: run.status,
    ownerId: run.ownerId,
    pushedBy: run.pushedBy,
    keyOwnerId: run.keyOwnerId,
    smartleadAccountId: run.smartleadAccountId,
    channel: run.channel,
    listId: run.listId,
    campaignId: run.campaignId,
    campaignName: run.campaignName,
    campaignSource: run.campaignSource,
    options: run.options,
    sequenceHash: run.sequenceHash,
    previewEligible: run.previewEligible,
    counts: run.counts,
    listExhausted: run.listExhausted,
    batchAttempts: run.batchAttempts,
    leaseOwner: run.leaseOwner,
    leaseEpoch: run.leaseEpoch,
    leaseUntil: run.leaseUntil,
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    ttl,
    active: run.status === "running" ? "Y" : run.status === "paused" || run.status === "partial" ? "P" : undefined,
  };
  if (run.orgId) item.orgId = run.orgId;
  if (run.cursor) item.cursor = run.cursor;
  if (run.pauseReason) item.pauseReason = run.pauseReason;
  if (run.startUnconfirmed) item.startUnconfirmed = true;
  if (item.active === undefined) delete item.active; // a terminal run is absent from the sparse resume index
  return item;
}

/**
 * Reads a Run item tolerantly: attributes it does not know are ignored, optional ones may be missing. A status it does not know
 * (written by newer code) is refused, never guessed: an older instance must stop, not act on a state it does not understand.
 */
export function fromRunItem(item: Item): PushRun {
  if (typeof item?.pk !== "string" || item.sk !== RUN_SK) throw new SmartleadPushRunStoreError("unsupported_item", "Not a Smartlead push run item");
  if (!KNOWN_STATUSES.has(item.status)) throw new SmartleadPushRunStoreError("unsupported_item", `Unknown push run status "${String(item.status)}"`);
  const c = item.counts ?? {};
  const cursor = item.cursor && typeof item.cursor.listId === "string" && typeof item.cursor.leadId === "string" ? { listId: item.cursor.listId, leadId: item.cursor.leadId } : null;
  return {
    runId: item.pk,
    schemaVersion: num(item.schemaVersion, 1),
    status: item.status,
    ...(item.pauseReason ? { pauseReason: String(item.pauseReason) } : {}),
    ownerId: String(item.ownerId ?? ""),
    ...(item.orgId ? { orgId: String(item.orgId) } : {}),
    pushedBy: String(item.pushedBy ?? ""),
    keyOwnerId: String(item.keyOwnerId ?? ""),
    smartleadAccountId: String(item.smartleadAccountId ?? ""),
    channel: item.channel === "agent" ? "agent" : "ui",
    listId: String(item.listId ?? ""),
    campaignId: num(item.campaignId),
    campaignName: String(item.campaignName ?? ""),
    campaignSource: item.campaignSource === "created" ? "created" : "selected",
    options: item.options && typeof item.options === "object" ? item.options : {},
    sequenceHash: String(item.sequenceHash ?? ""),
    previewEligible: num(item.previewEligible),
    counts: {
      examined: num(c.examined),
      added: num(c.added),
      alreadyInCampaign: num(c.alreadyInCampaign),
      unconfirmed: num(c.unconfirmed),
      withdrawn: num(c.withdrawn),
      skippedByReason: c.skippedByReason && typeof c.skippedByReason === "object" ? { ...c.skippedByReason } : {},
    },
    ...(readEvents(item.events) ? { events: readEvents(item.events)! } : {}),
    cursor,
    listExhausted: item.listExhausted === true,
    batchAttempts: num(item.batchAttempts),
    leaseOwner: String(item.leaseOwner ?? ""),
    leaseEpoch: num(item.leaseEpoch),
    leaseUntil: num(item.leaseUntil),
    createdAt: String(item.createdAt ?? ""),
    startedAt: String(item.startedAt ?? ""),
    ...(item.finishedAt ? { finishedAt: String(item.finishedAt) } : {}),
    ...(item.startUnconfirmed === true ? { startUnconfirmed: true } : {}),
    ...(item.failure && typeof item.failure.code === "string" ? { failure: { code: item.failure.code, message: String(item.failure.message ?? "") } } : {}),
  };
}

function toSummary(item: Item): PushRunSummary {
  if (typeof item?.pk !== "string" || !KNOWN_STATUSES.has(item.status)) throw new SmartleadPushRunStoreError("unsupported_item", "Unreadable push run summary");
  const c = item.counts;
  return {
    runId: item.pk,
    status: item.status,
    ...(item.campaignId !== undefined ? { campaignId: num(item.campaignId) } : {}),
    ...(item.campaignName !== undefined ? { campaignName: String(item.campaignName) } : {}),
    ...(c && typeof c === "object" ? { counts: { examined: num(c.examined), added: num(c.added), alreadyInCampaign: num(c.alreadyInCampaign), unconfirmed: num(c.unconfirmed), withdrawn: num(c.withdrawn), skippedByReason: { ...(c.skippedByReason ?? {}) } } } : {}),
    ...(item.startedAt ? { startedAt: String(item.startedAt) } : {}),
    ...(item.finishedAt ? { finishedAt: String(item.finishedAt) } : {}),
    ...(item.pushedBy ? { pushedBy: String(item.pushedBy) } : {}),
    ...(item.channel ? { channel: String(item.channel) } : {}),
    ...(item.listId ? { listId: String(item.listId) } : {}),
    ...(item.ownerId ? { ownerId: String(item.ownerId) } : {}),
    ...(item.createdAt ? { createdAt: String(item.createdAt) } : {}),
    ...(item.leaseUntil !== undefined ? { leaseUntil: num(item.leaseUntil) } : {}),
  };
}

// ─── Client ─────────────────────────────────────────────────────────────

type DocClient = Pick<AWS.DynamoDB.DocumentClient, "get" | "put" | "update" | "delete" | "query">;

let defaultClient: DocClient | null = null;
function docClient(): DocClient {
  if (!defaultClient) {
    defaultClient = new AWS.DynamoDB.DocumentClient({
      region: process.env.AWS_REGION || "us-west-2",
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

const RETRYABLE = new Set(["ProvisionedThroughputExceededException", "ThrottlingException", "RequestLimitExceeded", "InternalServerError", "ServiceUnavailable", "TimeoutError", "NetworkingError", "RequestTimeout", "TransactionConflictException"]);
const BACKOFF_MS = [50, 200, 800];

const isConditionFailure = (error: any): boolean => error?.code === "ConditionalCheckFailedException";

function storeError(error: any): SmartleadPushRunStoreError {
  const code = error?.code as string | undefined;
  if (code === "ResourceNotFoundException") return new SmartleadPushRunStoreError("table_missing", "The Smartlead push runs table does not exist");
  if (code === "AccessDeniedException" || code === "UnrecognizedClientException" || code === "ExpiredTokenException") return new SmartleadPushRunStoreError("access_denied", `Access to the Smartlead push runs table was denied (${code})`);
  if (code && RETRYABLE.has(code)) return new SmartleadPushRunStoreError("throttled", `The Smartlead push runs table is busy (${code})`);
  return new SmartleadPushRunStoreError("unavailable", `The Smartlead push runs table could not be used (${code ?? "unknown error"})`);
}

/** Smartlead puts the API key in the URL (?api_key=), and error text can echo it: nothing free-form is stored unredacted. */
export function redactSecrets(text: string): string {
  // Cut first: the patterns below are cheap on bounded input, and callers store at most 500 characters anyway.
  return text
    .slice(0, 2000)
    .replace(/(api[_-]?key|token|secret|password)(%3D|["']?\s{0,3}[:=]\s{0,3}["']?)[^&\s"',}]+/gi, "$1=[redacted]")
    .replace(/(bearer|basic)\s{1,5}[A-Za-z0-9._~+/-]+=*/gi, "$1 [redacted]")
    .replace(/[A-Z0-9._%+-]{1,64}@[A-Z0-9.-]{1,255}\.[A-Z]{2,24}/gi, "[email]");
}

const REASON = /^[a-z][a-z0-9_]{0,39}$/;

// ─── Repository ─────────────────────────────────────────────────────────

export class SmartleadPushRunDb {
  constructor(
    private readonly client: DocClient = docClient(),
    private readonly table: string = SMARTLEAD_PUSH_RUNS_TABLE,
    private readonly nowMs: () => number = () => Date.now(),
    private readonly sleep: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms)),
  ) {}

  /**
   * Runs one DynamoDB call. A failed CONDITION is not an error here: it returns `lost` (the caller decides what losing means).
   * Throttling is retried with a short backoff; anything else becomes a SmartleadPushRunStoreError the caller must not swallow.
   */
  private async call<T>(op: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; lost: true }> {
    for (let attempt = 0; ; attempt++) {
      try {
        return { ok: true, value: await op() };
      } catch (error: any) {
        if (isConditionFailure(error)) return { ok: false, lost: true };
        if (error?.code && RETRYABLE.has(error.code) && attempt < BACKOFF_MS.length) {
          await this.sleep(BACKOFF_MS[attempt]);
          continue;
        }
        throw storeError(error);
      }
    }
  }

  // ── reads

  async getRun(runId: string): Promise<PushRun | null> {
    const r = await this.call(() => this.client.get({ TableName: this.table, Key: { pk: runId, sk: RUN_SK }, ConsistentRead: true }).promise());
    if (!r.ok || !r.value.Item) return null;
    return fromRunItem(r.value.Item);
  }

  /** Just the event counters of a run, from the base table. A failed read is an error for the caller to ignore: the counters are display only. */
  async getRunEvents(runId: string): Promise<PushRunEvents | undefined> {
    const r = await this.call(() => this.client.get({ TableName: this.table, Key: { pk: runId, sk: RUN_SK }, ProjectionExpression: "#e", ExpressionAttributeNames: { "#e": "events" } }).promise());
    if (!r.ok || !r.value.Item) return undefined;
    return readEvents(r.value.Item.events);
  }

  async getLock(listId: string, campaignId: number): Promise<{ runId: string } | null> {
    const r = await this.call(() => this.client.get({ TableName: this.table, Key: { pk: lockKey(listId, campaignId), sk: LOCK_SK }, ConsistentRead: true }).promise());
    if (!r.ok || !r.value.Item || typeof r.value.Item.runId !== "string") return null;
    return { runId: r.value.Item.runId };
  }

  private async queryIndex(index: string, keyExpr: string, names: Record<string, string>, values: Record<string, any>, limit: number, newestFirst: boolean): Promise<PushRunSummary[]> {
    const out: PushRunSummary[] = [];
    let startKey: AWS.DynamoDB.DocumentClient.Key | undefined;
    // Pages until `limit` readable, unexpired rows are found: a TTL-expired or unreadable row must not hide a later healthy one.
    for (let page = 0; page < 10 && out.length < limit; page++) {
      const r = await this.call(() =>
        this.client.query({ TableName: this.table, IndexName: index, KeyConditionExpression: keyExpr, ExpressionAttributeNames: names, ExpressionAttributeValues: values, Limit: limit, ScanIndexForward: !newestFirst, ...(startKey ? { ExclusiveStartKey: startKey } : {}) }).promise(),
      );
      if (!r.ok) return out;
      const nowS = Math.floor(this.nowMs() / 1000);
      for (const item of r.value.Items ?? []) {
        // TTL deletion lags by up to about two days, so an expired item can still be returned: never show it.
        if (typeof item.ttl === "number" && item.ttl <= nowS) continue;
        try {
          out.push(toSummary(item));
        } catch (error) {
          // One row written by newer code must not stop the resumer from seeing the healthy ones; getRun still refuses it.
          console.warn("[smartleadPushRunDb] skipping an unreadable run row", item?.pk, (error as Error).message);
        }
        if (out.length >= limit) break;
      }
      startKey = r.value.LastEvaluatedKey;
      if (!startKey) break;
    }
    return out;
  }

  listRunsForList(listId: string, limit = 25): Promise<PushRunSummary[]> {
    return this.queryIndex(LIST_RUNS_INDEX, "#l = :l", { "#l": "listId" }, { ":l": listId }, limit, true);
  }

  listRunsForOwner(ownerId: string, limit = 25): Promise<PushRunSummary[]> {
    return this.queryIndex(OWNER_RUNS_INDEX, "#o = :o", { "#o": "ownerId" }, { ":o": ownerId }, limit, true);
  }

  /** Every run created at or after `sinceIso`, newest first (the opt-out sweep and an admin audit). */
  listRunsSince(sinceIso: string, limit = 100): Promise<PushRunSummary[]> {
    return this.queryIndex(RUNS_BY_TIME_INDEX, "#k = :k AND #c >= :since", { "#k": "kind", "#c": "createdAt" }, { ":k": "RUN", ":since": sinceIso }, limit, true);
  }

  /** Running runs whose lease has lapsed: a crashed or stuck worker. Eventually consistent: re-read the run before claiming it. */
  findExpiredLeases(limit = 50): Promise<PushRunSummary[]> {
    return this.queryIndex(ACTIVE_RUNS_INDEX, "#a = :a AND #u < :now", { "#a": "active", "#u": "leaseUntil" }, { ":a": "Y", ":now": this.nowMs() }, limit, false);
  }

  /** Paused or partial runs that nobody resumed for `olderThanMs`: the resumer cancels them. */
  findStalePaused(olderThanMs: number, limit = 50): Promise<PushRunSummary[]> {
    return this.queryIndex(ACTIVE_RUNS_INDEX, "#a = :a AND #u < :cutoff", { "#a": "active", "#u": "leaseUntil" }, { ":a": "P", ":cutoff": this.nowMs() - olderThanMs }, limit, false);
  }

  // ── start

  /**
   * Creates a run and takes the lock for its list and campaign, or says why not. The Run is written FIRST and the Lock second
   * (review 4: with the Lock first, two starters could both take over a lock whose Run did not exist yet). A live holder, or a
   * second starter that loses the race, gets the existing run back and its own Run is canceled.
   */
  async startRun(input: NewPushRun, workerId: string): Promise<StartResult> {
    if (!Number.isInteger(input.campaignId) || input.campaignId <= 0 || !input.listId) throw new SmartleadPushRunStoreError("invalid_input", "A push run needs a list and a positive campaign id");
    if (!input.ownerId || !input.pushedBy || !input.keyOwnerId || !workerId) throw new SmartleadPushRunStoreError("invalid_input", "A push run needs an owner, a pusher, a key owner and a worker id");

    const held = await this.getLock(input.listId, input.campaignId);
    let takeOver: string | undefined;
    if (held) {
      const holder = await this.getRun(held.runId);
      if (!holder) return { started: false, existing: null, lockHeldBy: held.runId }; // a missing Run is never a takeover
      if ((LIVE_STATUSES as readonly string[]).includes(holder.status)) return { started: false, existing: holder };
      takeOver = held.runId; // the holder finished: its lock was left behind
    }

    const now = this.nowMs();
    const iso = new Date(now).toISOString();
    const run: PushRun = {
      runId: ulid(now),
      schemaVersion: SCHEMA_VERSION,
      status: "running",
      ownerId: input.ownerId,
      ...(input.orgId ? { orgId: input.orgId } : {}),
      pushedBy: input.pushedBy,
      keyOwnerId: input.keyOwnerId,
      smartleadAccountId: input.smartleadAccountId,
      channel: input.channel,
      listId: input.listId,
      campaignId: input.campaignId,
      campaignName: input.campaignName,
      campaignSource: input.campaignSource,
      options: input.options,
      sequenceHash: input.sequenceHash,
      previewEligible: input.previewEligible,
      counts: emptyCounts(),
      cursor: null,
      listExhausted: false,
      batchAttempts: 0,
      leaseOwner: workerId,
      leaseEpoch: 1,
      leaseUntil: now + LEASE_MS,
      createdAt: iso,
      startedAt: iso,
      startUnconfirmed: true,
    };

    let put: { ok: boolean };
    try {
      put = await this.call(() => this.client.put({ TableName: this.table, Item: toRunItem(run, Math.floor(now / 1000) + RUN_RETENTION_DAYS * DAY_S), ConditionExpression: "attribute_not_exists(pk)" }).promise());
    } catch (error) {
      // Any error here may have arrived AFTER the write committed (a lost reply). If the Run is there, carry on with it; if not, nothing was written.
      if (!(await this.getRun(run.runId).catch(() => null))) throw error;
      put = { ok: true };
    }
    if (!put.ok) {
      // A condition failure on a fresh id can only be OUR OWN earlier attempt having committed (the reply was lost and the call retried).
      // Carry on with that run rather than failing: failing would leave a committed, running Run with no lock behind.
      if (!(await this.getRun(run.runId))) throw new SmartleadPushRunStoreError("unavailable", "A run id collided; try again");
    }

    const lockItem = { pk: lockKey(input.listId, input.campaignId), sk: LOCK_SK, runId: run.runId, ttl: Math.floor(now / 1000) + LOCK_RETENTION_DAYS * DAY_S };
    let lock: { ok: boolean };
    try {
      lock = await this.call(() =>
        takeOver
          ? this.client.put({ TableName: this.table, Item: lockItem, ConditionExpression: "#r = :old", ExpressionAttributeNames: { "#r": "runId" }, ExpressionAttributeValues: { ":old": takeOver } }).promise()
          : this.client.put({ TableName: this.table, Item: lockItem, ConditionExpression: "attribute_not_exists(pk)" }).promise(),
      );
    } catch (error) {
      // Any error here may have arrived AFTER the lock write committed. If the lock is ours the run is live and the caller must hear
      // "started" (a run that holds a lock but was reported as failed would be claimed and sent later, unannounced). Otherwise the
      // Run we wrote is abandoned so it cannot be claimed either.
      let ours: boolean | undefined;
      try {
        ours = (await this.getLock(input.listId, input.campaignId))?.runId === run.runId;
      } catch {
        ours = undefined; // the read failed: we do not know
      }
      if (ours === true) return { started: true, run };
      // Not ours, or unknown: cancel the run we wrote BEFORE reporting anything. A run cancelled before any worker was told "started" is
      // dead whether or not the lock write committed, so nothing can claim it later. A lock left pointing at it is taken over by the next start.
      if (!(await this.abandonWithRetry(run.runId))) {
        throw new SmartleadPushRunStoreError("unavailable", "A start could not be settled; the run it wrote must be cancelled", run.runId);
      }
      throw error;
    }
    if (!lock.ok) {
      // The lock write was refused. Either our own earlier attempt committed (a retry hit its own write), or another run holds the lock. The
      // read may itself fail: then we do not know, and the run we wrote is cancelled before anything is reported.
      let winner: { runId: string } | null | undefined;
      try {
        winner = await this.getLock(input.listId, input.campaignId);
      } catch {
        winner = undefined;
      }
      if (winner?.runId === run.runId) return { started: true, run }; // our own earlier lock write committed
      if (!(await this.abandonWithRetry(run.runId))) {
        throw new SmartleadPushRunStoreError("unavailable", "A start could not be settled; the run it wrote must be cancelled", run.runId);
      }
      if (winner === undefined) throw new SmartleadPushRunStoreError("unavailable", "The lock could not be read after a conflicting start");
      const existing = winner ? await this.getRun(winner.runId) : null;
      return { started: false, existing, ...(winner && !existing ? { lockHeldBy: winner.runId } : {}) };
    }
    // The resumer may have canceled our Run as an orphan between the two writes: do not hand back a run that is already dead.
    const check = await this.getRun(run.runId);
    if (!check || (TERMINAL_STATUSES as readonly string[]).includes(check.status)) {
      await this.safeRelease(input.listId, input.campaignId, run.runId);
      return { started: false, existing: null };
    }
    return { started: true, run };
  }

  /** Tells the store the start was reported to the caller as started: from now on the run may be claimed like any other. */
  async confirmStart(runId: string): Promise<boolean> {
    // Only a run that is still running: one the resumer already cancelled must not be reported as started.
    const r = await this.call(() =>
      this.client.update({
        TableName: this.table,
        Key: { pk: runId, sk: RUN_SK },
        UpdateExpression: "REMOVE startUnconfirmed",
        ConditionExpression: "attribute_exists(pk) AND #s = :running",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: { ":running": "running" },
      }).promise(),
    );
    return r.ok;
  }

  /** abandonRun with a few retries; true once the run is cancelled (or was already finished), false if it could not be confirmed. */
  private async abandonWithRetry(runId: string): Promise<boolean> {
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        await this.abandonRun(runId);
        return true;
      } catch {
        if (attempt < 3) await this.sleep(BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]);
      }
    }
    return false;
  }

  /** Cancels a run that never got its lock. */
  private async abandonRun(runId: string): Promise<void> {
    await this.call(() =>
      this.client.update({
        TableName: this.table,
        Key: { pk: runId, sk: RUN_SK },
        UpdateExpression: "SET #s = :canceled, finishedAt = :f REMOVE #a",
        ConditionExpression: "#s = :running",
        ExpressionAttributeNames: { "#s": "status", "#a": "active" },
        ExpressionAttributeValues: { ":canceled": "canceled", ":running": "running", ":f": new Date(this.nowMs()).toISOString() },
      }).promise(),
    );
  }

  // ── lease

  /** Extends the lock's expiry, only if it already points at this run (never creates it). */
  private async refreshLock(run: PushRun): Promise<boolean> {
    const r = await this.call(() =>
      this.client.put({
        TableName: this.table,
        Item: { pk: lockKey(run.listId, run.campaignId), sk: LOCK_SK, runId: run.runId, ttl: Math.floor(this.nowMs() / 1000) + LOCK_RETENTION_DAYS * DAY_S },
        ConditionExpression: "#r = :me",
        ExpressionAttributeNames: { "#r": "runId" },
        ExpressionAttributeValues: { ":me": run.runId },
      }).promise(),
    );
    return r.ok;
  }

  /**
   * Re-takes the lock for a run the USER is resuming (creating it if it expired while the run sat paused) and refreshes its expiry. Fails if the lock points at
   * another run: the lock's 15-day expiry can pass while a run sits paused, and a new run may have started since.
   */
  private async retakeLock(run: PushRun): Promise<boolean> {
    const now = this.nowMs();
    const r = await this.call(() =>
      this.client.put({
        TableName: this.table,
        Item: { pk: lockKey(run.listId, run.campaignId), sk: LOCK_SK, runId: run.runId, ttl: Math.floor(now / 1000) + LOCK_RETENTION_DAYS * DAY_S },
        ConditionExpression: "attribute_not_exists(pk) OR #r = :me",
        ExpressionAttributeNames: { "#r": "runId" },
        ExpressionAttributeValues: { ":me": run.runId },
      }).promise(),
    );
    return r.ok;
  }

  /** Takes over a run whose lease lapsed (or that was released). Returns the run with the new epoch, or null if someone else got it. */
  async claimLease(runId: string, workerId: string, seenEpoch: number, skewMs = 30_000): Promise<PushRun | null> {
    const current = await this.getRun(runId);
    // The lock must already point at this run. A running run with NO lock is an orphan (a crash between a start's two writes): letting it
    // take the lock would let an approval that never started run later, so the resumer cancels it instead.
    if (!current || current.status !== "running" || current.startUnconfirmed || !(await this.refreshLock(current))) return null;
    const now = this.nowMs();
    const r = await this.call(() =>
      this.client.update({
        TableName: this.table,
        Key: { pk: runId, sk: RUN_SK },
        UpdateExpression: "SET leaseEpoch = leaseEpoch + :one, leaseOwner = :me, leaseUntil = :until",
        ConditionExpression: "#a = :y AND #s = :running AND leaseUntil < :cutoff AND leaseEpoch = :seen AND attribute_not_exists(startUnconfirmed)",
        ExpressionAttributeNames: { "#a": "active", "#s": "status" },
        ExpressionAttributeValues: { ":one": 1, ":me": workerId, ":until": now + LEASE_MS, ":y": "Y", ":running": "running", ":cutoff": now - skewMs, ":seen": seenEpoch },
        ReturnValues: "ALL_NEW",
      }).promise(),
    );
    return r.ok && r.value.Attributes ? fromRunItem(r.value.Attributes) : null;
  }

  /** Renews the lease. False means the worker lost the run (paused, canceled, or taken over) and must stop. */
  async heartbeat(runId: string, epoch: number): Promise<boolean> {
    const r = await this.call(() =>
      this.client.update({
        TableName: this.table,
        Key: { pk: runId, sk: RUN_SK },
        UpdateExpression: "SET leaseUntil = :until",
        ConditionExpression: "leaseEpoch = :e AND #s = :running",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: { ":until": this.nowMs() + LEASE_MS, ":e": epoch, ":running": "running" },
      }).promise(),
    );
    return r.ok;
  }

  // ── the fence

  /**
   * Records a fully marked batch and moves the cursor. THIS is the fence: it succeeds only for the worker that holds the current
   * lease epoch while the run is `running`, so a worker that lost its lease, or whose run was paused or canceled, gets false and
   * must stop (at most the batch it had in flight completes).
   */
  async advance(runId: string, epoch: number, step: AdvanceStep): Promise<boolean> {
    // DynamoDB rejects a request that declares a name or value the expression does not use, so each is added only when it is used.
    const names: Record<string, string> = { "#s": "status", "#cur": "cursor", "#ba": "batchAttempts" };
    // A cursor is required to move the walk. Without one the stored cursor is left alone (never rewound), which is only meaningful when
    // the walk ended: an empty list has no lead to point at but must still be markable as exhausted.
    const hasCursor = !!(step.cursor?.listId && step.cursor?.leadId);
    if (!hasCursor && !step.listExhausted) throw new SmartleadPushRunStoreError("invalid_input", "advance needs a cursor, unless it marks the list exhausted");
    const values: Record<string, any> = { ":e": epoch, ":running": "running", ":until": this.nowMs() + LEASE_MS, ":zero": 0 };
    const sets = ["#ba = :zero", "leaseUntil = :until"];
    if (hasCursor) {
      values[":cursor"] = step.cursor;
      sets.push("#cur = :cursor");
    } else {
      delete names["#cur"];
    }
    let i = 0;
    for (const [name, delta] of Object.entries(step.counts)) {
      if (!delta) continue;
      if (!["examined", "added", "alreadyInCampaign", "unconfirmed", "withdrawn"].includes(name) || !Number.isInteger(delta) || delta < 0) throw new SmartleadPushRunStoreError("invalid_input", `Bad count "${name}"`);
      names["#c"] = "counts";
      names[`#k${i}`] = name;
      values[`:d${i}`] = delta;
      sets.push(`#c.#k${i} = #c.#k${i} + :d${i}`);
      i++;
    }
    for (const [reason, n] of Object.entries(step.skipped ?? {})) {
      if (!n) continue;
      if (!REASON.test(reason) || !Number.isInteger(n) || n < 0) throw new SmartleadPushRunStoreError("invalid_input", `Bad skip reason "${reason}"`);
      names["#c"] = "counts";
      names["#sbr"] = "skippedByReason";
      names[`#r${i}`] = reason;
      values[`:d${i}`] = n;
      sets.push(`#c.#sbr.#r${i} = if_not_exists(#c.#sbr.#r${i}, :zero) + :d${i}`);
      i++;
    }
    if (step.listExhausted) {
      names["#le"] = "listExhausted";
      values[":true"] = true;
      sets.push("#le = :true");
    }
    const r = await this.call(() =>
      this.client.update({
        TableName: this.table,
        Key: { pk: runId, sk: RUN_SK },
        UpdateExpression: `SET ${sets.join(", ")}`,
        ConditionExpression: "leaseEpoch = :e AND #s = :running",
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
      }).promise(),
    );
    return r.ok;
  }

  /**
   * Adds one to the run's `replied`, `bounced` or `unsubscribed` counter. Needs no lease and works on a finished run: replies and opt-outs
   * arrive long after a push ends. Only ever adds to a counter; it never touches the run's status, cursor or lease. Returns false when the run
   * is gone. The counter is for display, so a caller treats any failure here as non-fatal.
   */
  async countContactEvent(runId: string, kind: ContactEventKind): Promise<boolean> {
    if (!CONTACT_EVENT_KINDS.includes(kind)) throw new SmartleadPushRunStoreError("invalid_input", `Bad event kind "${String(kind)}"`);
    const key = { pk: runId, sk: RUN_SK };
    const bump = () =>
      this.call(() =>
        this.client.update({
          TableName: this.table,
          Key: key,
          UpdateExpression: "SET #e.#k = if_not_exists(#e.#k, :zero) + :one",
          ConditionExpression: "attribute_exists(pk) AND attribute_exists(#e)",
          ExpressionAttributeNames: { "#e": "events", "#k": kind },
          ExpressionAttributeValues: { ":zero": 0, ":one": 1 },
        }).promise(),
      );
    let r = await bump();
    if (r.ok) return true;
    // No `events` map yet (a run made before this, or its first event): create it once, never over an existing one, then count.
    await this.call(() =>
      this.client.update({
        TableName: this.table,
        Key: key,
        UpdateExpression: "SET #e = :empty",
        ConditionExpression: "attribute_exists(pk) AND attribute_not_exists(#e)",
        ExpressionAttributeNames: { "#e": "events" },
        ExpressionAttributeValues: { ":empty": { replied: 0, bounced: 0, unsubscribed: 0 } },
      }).promise(),
    );
    r = await bump();
    return r.ok;
  }

  /** A batch failed (an error, or an outcome we cannot know). Returns the attempt count; at MAX_BATCH_ATTEMPTS the run becomes `partial`. */
  async recordBatchFailure(runId: string, epoch: number): Promise<{ attempts: number; partial: boolean } | null> {
    const r = await this.call(() =>
      this.client.update({
        TableName: this.table,
        Key: { pk: runId, sk: RUN_SK },
        UpdateExpression: "SET #ba = #ba + :one",
        ConditionExpression: "leaseEpoch = :e AND #s = :running",
        ExpressionAttributeNames: { "#ba": "batchAttempts", "#s": "status" },
        ExpressionAttributeValues: { ":one": 1, ":e": epoch, ":running": "running" },
        ReturnValues: "UPDATED_NEW",
      }).promise(),
    );
    if (!r.ok) return null;
    const attempts = num(r.value.Attributes?.batchAttempts);
    if (attempts < MAX_BATCH_ATTEMPTS) return { attempts, partial: false };
    const p = await this.call(() =>
      this.client.update({
        TableName: this.table,
        Key: { pk: runId, sk: RUN_SK },
        UpdateExpression: "SET #s = :partial, #a = :p, pauseReason = :why",
        ConditionExpression: "leaseEpoch = :e AND #s = :running",
        ExpressionAttributeNames: { "#s": "status", "#a": "active" },
        ExpressionAttributeValues: { ":partial": "partial", ":p": "P", ":why": "batch_failed", ":e": epoch, ":running": "running" },
      }).promise(),
    );
    return { attempts, partial: p.ok };
  }

  // ── pause, resume, cancel, finish

  /** Pauses a running run (a sequence change, a status change, a rejected key, or the user). `epoch` is given when the worker pauses itself. */
  async pauseRun(runId: string, reason: string, epoch?: number): Promise<boolean> {
    const r = await this.call(() =>
      this.client.update({
        TableName: this.table,
        Key: { pk: runId, sk: RUN_SK },
        UpdateExpression: "SET #s = :paused, #a = :p, pauseReason = :why",
        ConditionExpression: epoch === undefined ? "#s = :running" : "#s = :running AND leaseEpoch = :e",
        ExpressionAttributeNames: { "#s": "status", "#a": "active" },
        ExpressionAttributeValues: { ":paused": "paused", ":p": "P", ":why": redactSecrets(reason).slice(0, 200), ":running": "running", ...(epoch === undefined ? {} : { ":e": epoch }) },
      }).promise(),
    );
    return r.ok;
  }

  /** Resumes a paused or partial run under a new lease epoch. */
  async resumeRun(runId: string, workerId: string, seenEpoch: number): Promise<PushRun | null> {
    const current = await this.getRun(runId);
    // A start that was never confirmed to the user can not be resumed by pausing it first: it is cancelled instead.
    if (!current || (current.status !== "paused" && current.status !== "partial") || current.startUnconfirmed || !(await this.retakeLock(current))) return null;
    const now = this.nowMs();
    const r = await this.call(() =>
      this.client.update({
        TableName: this.table,
        Key: { pk: runId, sk: RUN_SK },
        UpdateExpression: "SET #s = :running, #a = :y, #ba = :zero, leaseEpoch = leaseEpoch + :one, leaseOwner = :me, leaseUntil = :until REMOVE pauseReason",
        ConditionExpression: "#s IN (:paused, :partial) AND leaseEpoch = :seen AND attribute_not_exists(startUnconfirmed)",
        ExpressionAttributeNames: { "#s": "status", "#a": "active", "#ba": "batchAttempts" },
        ExpressionAttributeValues: { ":running": "running", ":y": "Y", ":zero": 0, ":one": 1, ":me": workerId, ":until": now + LEASE_MS, ":paused": "paused", ":partial": "partial", ":seen": seenEpoch },
        ReturnValues: "ALL_NEW",
      }).promise(),
    );
    return r.ok && r.value.Attributes ? fromRunItem(r.value.Attributes) : null;
  }

  /** Cancels a live run (no epoch needed: the user, or the resumer for a stale paused run) and releases its lock. */
  async cancelRun(runId: string): Promise<boolean> {
    const now = this.nowMs();
    const r = await this.call(() =>
      this.client.update({
        TableName: this.table,
        Key: { pk: runId, sk: RUN_SK },
        UpdateExpression: "SET #s = :canceled, finishedAt = :f, #ttl = :ttl REMOVE #a",
        ConditionExpression: "#s IN (:running, :paused, :partial)",
        ExpressionAttributeNames: { "#s": "status", "#a": "active", "#ttl": SMARTLEAD_PUSH_RUNS_TTL_ATTRIBUTE },
        ExpressionAttributeValues: { ":canceled": "canceled", ":f": new Date(now).toISOString(), ":ttl": Math.floor(now / 1000) + RUN_RETENTION_DAYS * DAY_S, ":running": "running", ":paused": "paused", ":partial": "partial" },
        ReturnValues: "ALL_NEW",
      }).promise(),
    );
    if (!r.ok || !r.value.Attributes) return false;
    const run = fromRunItem(r.value.Attributes);
    await this.safeRelease(run.listId, run.campaignId, runId);
    return true;
  }

  /** Ends a run the worker finished (`completed`, only when the walk reached the end of the list) or gave up on (`failed`), and releases its lock. */
  async finishRun(runId: string, epoch: number, status: "completed" | "failed", failure?: { code: string; message: string }): Promise<boolean> {
    const now = this.nowMs();
    const r = await this.call(() =>
      this.client.update({
        TableName: this.table,
        Key: { pk: runId, sk: RUN_SK },
        UpdateExpression: `SET #s = :done, finishedAt = :f, #ttl = :ttl${failure ? ", failure = :failure" : ""} REMOVE #a`,
        ConditionExpression: `leaseEpoch = :e AND #s = :running${status === "completed" ? " AND listExhausted = :true" : ""}`,
        ExpressionAttributeNames: { "#s": "status", "#a": "active", "#ttl": SMARTLEAD_PUSH_RUNS_TTL_ATTRIBUTE },
        ExpressionAttributeValues: {
          ":done": status,
          ":f": new Date(now).toISOString(),
          ":ttl": Math.floor(now / 1000) + RUN_RETENTION_DAYS * DAY_S,
          ":e": epoch,
          ":running": "running",
          ...(status === "completed" ? { ":true": true } : {}),
          ...(failure ? { ":failure": { code: redactSecrets(failure.code).slice(0, 60), message: redactSecrets(failure.message).slice(0, 500) } } : {}),
        },
        ReturnValues: "ALL_NEW",
      }).promise(),
    );
    if (!r.ok || !r.value.Attributes) return false;
    const run = fromRunItem(r.value.Attributes);
    await this.safeRelease(run.listId, run.campaignId, runId);
    return true;
  }

  // ── single-use approvals

  /**
   * Consumes an approval token's id (`jti`) with one conditional put. True means this caller is the one that may start the run; false
   * means the token was already used. A token item is just another record kind in this table (sk `TOKEN`): no new index, no key change.
   */
  async claimToken(jti: string, ttlSeconds: number): Promise<boolean> {
    if (!jti || jti.length > 100) throw new SmartleadPushRunStoreError("invalid_input", "A token id is required");
    const r = await this.call(() =>
      this.client.put({ TableName: this.table, Item: { pk: `TOKEN#${jti}`, sk: TOKEN_SK, ttl: Math.floor(this.nowMs() / 1000) + ttlSeconds }, ConditionExpression: "attribute_not_exists(pk)" }).promise(),
    );
    return r.ok;
  }

  /** Remembers which run a consumed token started, so a second submit of the same approval can be shown that run. Best effort. */
  async setTokenRun(jti: string, runId: string): Promise<void> {
    await this.call(() =>
      this.client.update({ TableName: this.table, Key: { pk: `TOKEN#${jti}`, sk: TOKEN_SK }, UpdateExpression: "SET runId = :r", ConditionExpression: "attribute_exists(pk)", ExpressionAttributeValues: { ":r": runId } }).promise(),
    );
  }

  async getTokenRun(jti: string): Promise<string | null> {
    const r = await this.call(() => this.client.get({ TableName: this.table, Key: { pk: `TOKEN#${jti}`, sk: TOKEN_SK }, ConsistentRead: true }).promise());
    return r.ok && typeof r.value.Item?.runId === "string" ? r.value.Item.runId : null;
  }

  /** Gives an approval back when the start it was spent on did not happen (the user can submit it again). */
  async releaseToken(jti: string): Promise<void> {
    await this.call(() => this.client.delete({ TableName: this.table, Key: { pk: `TOKEN#${jti}`, sk: TOKEN_SK } }).promise());
  }

  // ── lock

  /** Release that never throws: the run's own write already succeeded, and a leaked lock is taken over by the next start. */
  private async safeRelease(listId: string, campaignId: number, runId: string): Promise<void> {
    try {
      await this.releaseLock(listId, campaignId, runId);
    } catch (error) {
      console.warn("[smartleadPushRunDb] could not release the lock for", runId, (error as Error).message);
    }
  }

  /** Deletes the lock only if it still points at this run. */
  async releaseLock(listId: string, campaignId: number, runId: string): Promise<void> {
    await this.call(() =>
      this.client.delete({ TableName: this.table, Key: { pk: lockKey(listId, campaignId), sk: LOCK_SK }, ConditionExpression: "#r = :r", ExpressionAttributeNames: { "#r": "runId" }, ExpressionAttributeValues: { ":r": runId } }).promise(),
    );
  }

  /**
   * The resumer's check before it claims a run: the lock must point at that run. A run with no lock (a crash between the two
   * writes of startRun) is canceled, because a second run could already be using the list and campaign.
   */
  async lockPointsAt(run: PushRun): Promise<boolean> {
    const lock = await this.getLock(run.listId, run.campaignId);
    return lock?.runId === run.runId;
  }
}

/** A fresh worker id for a process (used as `leaseOwner`; the epoch, not this, is the fence). */
export const newWorkerId = (): string => `${process.env.HOSTNAME ?? "worker"}:${process.pid}:${ulid()}`;
