/**
 * Creative lineage (ENG-2141, ENG-2128 T9, decision D3).
 *
 * Gives every agent-mode generated image a `creativeId` and records which Meta ad creative and
 * ad it became, so a creative's judge scores can later be compared with that ad's performance.
 *
 * INERT BY DEFAULT. Nothing is read or written unless BOTH
 *   CREATIVE_LINEAGE_ENABLED=true   and   CREATIVE_LINEAGE_TABLE=<table name>
 * are set. The table is created by OPS-3 (ENG-2148), not by this code; see
 * createCreativesTable in scripts/create-tables.ts for its shape.
 *
 * How a creativeId is resolved
 * ----------------------------
 * `creativeId` is derived from the image's S3 object key: `cr_` + the first 32 hex characters of
 * sha256(key). Every generated image gets a fresh key (users/<userId>/files/<ts>/<random>/<name>),
 * so the key identifies the creative, and deriving the id from it means any later step that holds
 * the S3 URL resolves the creative with a GetItem, no index and no guessing:
 *   1. generate_image          → record written (creativeId from the uploaded URL).
 *   2. Meta UPLOAD_IMAGE(url)   → the URL resolves to the creativeId; Meta's image hash is added.
 *   3. Meta CREATE creative     → each image_url that is one of our S3 URLs resolves directly; each
 *                                image_hash resolves through the creatives of the same user that
 *                                carry that hash (step 2). The Meta creative id is added.
 *   4. Meta CREATE ad           → the creative_id resolves through the creatives of the same user
 *                                that carry it (step 3). The ad link is appended.
 * Steps 3 and 4 look up by user (GSI userId-createdAt-index, bounded to LOOKUP_WINDOW_DAYS), so an
 * image hash or creative id can never link across accounts of different users. An image the agent
 * did not generate (a CDN URL, an uploaded asset) resolves to nothing and is skipped.
 *
 * The rubric judge result is NOT copied here. It is written asynchronously, for a sample, onto the
 * human-eval candidate (ENG-2140); the record keeps `humanEvalCandidateId` and readers join on it.
 * Prompt text is never stored: only its sha256.
 *
 * Every entry point is fire-and-forget safe: it never throws and never delays generation or publish.
 * One user's writes run one at a time in the order they started (see `serialized`), and a publish
 * lookup that finds nothing yet is re-tried (see LOOKUP_RETRY_DELAYS_MS), so overlapping tool calls
 * and index lag do not drop a link.
 */

import AWS from 'aws-sdk';
import { createHash } from 'crypto';
import type { CreativeGateResult } from './creativeGates';
import { extractS3KeyFromUrl } from '../utils/s3Utils';

export const CREATIVE_LINEAGE_ENABLED_ENV = 'CREATIVE_LINEAGE_ENABLED';
export const CREATIVE_LINEAGE_TABLE_ENV = 'CREATIVE_LINEAGE_TABLE';
export const CREATIVE_LINEAGE_USER_INDEX = 'userId-createdAt-index';
export const CREATIVE_LINEAGE_SCHEMA_VERSION = 1;

/** How far back a publish looks for the creative an image hash / Meta creative id belongs to. */
export const LOOKUP_WINDOW_DAYS = 180;
/** Page cap on a per-user lookup. Reaching it is logged; the stamp is then best-effort. */
const LOOKUP_MAX_PAGES = 20;

const TABLE_NAME_PATTERN = /^[A-Za-z0-9_.-]{3,255}$/;

type Env = Record<string, string | undefined>;

export interface CreativeLineageConfig {
  /** The configured table, or null when lineage is off (flag unset or table missing/invalid). */
  tableName: string | null;
}

export function readCreativeLineageConfig(env: Env = process.env): CreativeLineageConfig {
  const table = env[CREATIVE_LINEAGE_TABLE_ENV]?.trim();
  const enabled = env[CREATIVE_LINEAGE_ENABLED_ENV] === 'true';
  return { tableName: enabled && table && TABLE_NAME_PATTERN.test(table) ? table : null };
}

/** Compact view of the ENG-2139 gate result; the full result stays on the human-eval candidate. */
export interface CreativeGatesSummary {
  version: string;
  passed: boolean;
  failedChecks: string[];
  placement?: string;
  width?: number;
  height?: number;
}

export type MetaPublishVia = 'create_creative' | 'create_ad' | 'copy_ad' | 'swap_creative';

export interface MetaCreativeLink {
  accountId: string;
  metaCreativeId: string;
  /** Absent when the creative was built from our image URL rather than an uploaded hash. */
  imageHash?: string;
  via: MetaPublishVia;
  linkedAt: string;
}

export interface MetaAdLink {
  accountId: string;
  adId: string;
  metaCreativeId: string;
  imageHash?: string;
  via: MetaPublishVia;
  /** When the ad started carrying this creative. Performance before this date is not its own. */
  linkedAt: string;
}

/**
 * The ad stopped carrying this creative: its creative was changed to another one (which may not be
 * a generated image at all, so it may have no record of its own to link). Performance from this
 * date on is not this creative's.
 */
export interface MetaAdLinkEnd {
  accountId: string;
  adId: string;
  endedAt: string;
}

/**
 * ENG-2235: a Google Ads ad that uses this generated image. Google has no per-ad "creative" object;
 * the image is uploaded as an asset (customers/{c}/assets/{id}) and ads reference that asset.
 */
export interface GoogleAdLink {
  customerId: string;
  /** customers/{c}/adGroupAds/{adGroupId}~{adId} — the key ENG-2215's ad metrics join on. */
  adResourceName: string;
  assetResourceName: string;
  linkedAt: string;
}

export interface CreativeLineageRecord {
  creativeId: string;
  userId: string;
  s3Key: string;
  artifactUrl: string;
  sessionId?: string;
  category?: string;
  /** sha256 (hex) of the generation prompt. The prompt text itself is never stored. */
  promptHash: string;
  generatorModel: string;
  gatesSummary?: CreativeGatesSummary;
  /** AW-HumanEvalQueue candidate for this image; the rubric judge result (ENG-2140) lives there. */
  humanEvalCandidateId?: string;
  /** Meta image hashes this image was uploaded as. A string set, so the lookups can use `contains`. */
  metaImageHashes?: AWS.DynamoDB.DocumentClient.DynamoDbSet;
  /** Meta ad creative ids built from this image (string set, as above). */
  metaCreativeIds?: AWS.DynamoDB.DocumentClient.DynamoDbSet;
  metaCreativeLinks?: MetaCreativeLink[];
  metaAdLinks?: MetaAdLink[];
  /** Ad ids in metaAdLinks (string set), so a later creative change on the ad can find this record. */
  metaAdIds?: AWS.DynamoDB.DocumentClient.DynamoDbSet;
  metaAdLinkEnds?: MetaAdLinkEnd[];
  /** ENG-2235: Google Ads image-asset resource names this image was uploaded as (string set). */
  googleAssetResourceNames?: AWS.DynamoDB.DocumentClient.DynamoDbSet;
  googleAdLinks?: GoogleAdLink[];
  /** Ad resource names in googleAdLinks (string set), for idempotency and later lookups. */
  googleAdResourceNames?: AWS.DynamoDB.DocumentClient.DynamoDbSet;
  schemaVersion: number;
  createdAt: string;
  updatedAt: string;
}

/** The DynamoDB calls the store makes, as promises (so tests can pass a plain fake). */
export interface CreativeLineageDb {
  get(params: AWS.DynamoDB.DocumentClient.GetItemInput): Promise<AWS.DynamoDB.DocumentClient.GetItemOutput>;
  put(params: AWS.DynamoDB.DocumentClient.PutItemInput): Promise<AWS.DynamoDB.DocumentClient.PutItemOutput>;
  update(params: AWS.DynamoDB.DocumentClient.UpdateItemInput): Promise<AWS.DynamoDB.DocumentClient.UpdateItemOutput>;
  query(params: AWS.DynamoDB.DocumentClient.QueryInput): Promise<AWS.DynamoDB.DocumentClient.QueryOutput>;
  /** DocumentClient string set, so ADD merges members atomically. */
  stringSet(values: string[]): AWS.DynamoDB.DocumentClient.DynamoDbSet;
}

let defaultDb: CreativeLineageDb | null = null;

function documentClientDb(): CreativeLineageDb {
  if (!defaultDb) {
    const client = new AWS.DynamoDB.DocumentClient();
    defaultDb = {
      get: (params) => client.get(params).promise(),
      put: (params) => client.put(params).promise(),
      update: (params) => client.update(params).promise(),
      query: (params) => client.query(params).promise(),
      stringSet: (values) => client.createSet(values),
    };
  }
  return defaultDb;
}

export interface CreativeLineageDeps {
  env?: Env;
  db?: CreativeLineageDb;
  now?: () => Date;
  /** Waits before re-trying a user-index lookup that found nothing (default LOOKUP_RETRY_DELAYS_MS). */
  lookupRetryDelaysMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
}

/**
 * The user index (userId-createdAt-index) is eventually consistent, and the agent can dispatch a
 * publish step while the previous step's stamp is still being written, so a lookup that finds
 * nothing is re-tried after these delays. Stamps are fire-and-forget: the wait delays nothing.
 */
export const LOOKUP_RETRY_DELAYS_MS: readonly number[] = [2000, 5000];

interface Ctx {
  table: string;
  db: CreativeLineageDb;
  now: () => Date;
  retryDelaysMs: readonly number[];
  sleep: (ms: number) => Promise<void>;
}

function resolveDeps(deps: CreativeLineageDeps): Ctx | null {
  const { tableName } = readCreativeLineageConfig(deps.env);
  if (!tableName) return null;
  return {
    table: tableName,
    db: deps.db ?? documentClientDb(),
    now: deps.now ?? (() => new Date()),
    retryDelaysMs: deps.lookupRetryDelaysMs ?? LOOKUP_RETRY_DELAYS_MS,
    sleep: deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
  };
}

const userQueues = new Map<string, Promise<void>>();

/**
 * Runs one user's lineage writes one at a time, in the order they were started. Each entry point
 * calls this before its first await, so a generate → upload → creative → ad sequence is written in
 * that order even when the calls overlap (the agent dispatches same-iteration tools concurrently).
 * Per process: one session's tool calls run in one process.
 */
function serialized<T>(userId: string, task: () => Promise<T>): Promise<T> {
  const previous = userQueues.get(userId) ?? Promise.resolve();
  const run = previous.then(task);
  const tail = run.then(() => undefined, () => undefined);
  userQueues.set(userId, tail);
  void tail.then(() => {
    if (userQueues.get(userId) === tail) userQueues.delete(userId);
  });
  return run;
}

/**
 * Runs `attempt` serialized for the user; while it reports `retry` (a lookup found nothing yet),
 * waits OUTSIDE the queue and tries again, so the write it is waiting for can run meanwhile.
 */
async function withLookupRetry<T>(
  ctx: Ctx,
  userId: string,
  attempt: (n: number) => Promise<{ result: T; retry: boolean }>,
  combine: (acc: T | undefined, next: T) => T,
): Promise<T> {
  let acc: T | undefined;
  for (let n = 0; ; n++) {
    const { result, retry } = await serialized(userId, () => attempt(n));
    acc = combine(acc, result);
    const delay = ctx.retryDelaysMs[n];
    if (!retry || delay === undefined) return acc;
    await ctx.sleep(delay);
  }
}

const concatIds = (acc: string[] | undefined, next: string[]): string[] => [...(acc ?? []), ...next];

function decodeKey(key: string): string {
  try {
    return decodeURIComponent(key);
  } catch {
    return key;
  }
}

/** The S3 object key of one of our uploaded files, or null for any other URL. */
export function s3KeyForUrl(url: string | undefined | null): string | null {
  if (!url) return null;
  const key = extractS3KeyFromUrl(url);
  return key ? decodeKey(key) : null;
}

export function creativeIdForS3Key(s3Key: string): string {
  return `cr_${createHash('sha256').update(s3Key).digest('hex').slice(0, 32)}`;
}

/** The creativeId for a generated image's URL, or null when it is not one of our S3 objects. */
export function creativeIdForUrl(url: string | undefined | null): string | null {
  const key = s3KeyForUrl(url);
  return key ? creativeIdForS3Key(key) : null;
}

export function hashPrompt(prompt: string): string {
  return createHash('sha256').update(prompt).digest('hex');
}

export function summarizeGates(gates: CreativeGateResult | undefined): CreativeGatesSummary | undefined {
  if (!gates) return undefined;
  return {
    version: gates.version,
    passed: gates.passed,
    failedChecks: gates.checks.filter((c) => c.status === 'fail').map((c) => c.id),
    ...(gates.placement ? { placement: gates.placement } : {}),
    ...(gates.width !== undefined ? { width: gates.width } : {}),
    ...(gates.height !== undefined ? { height: gates.height } : {}),
  };
}

function isConditionFailure(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === 'ConditionalCheckFailedException';
}

function warn(message: string, err?: unknown): void {
  console.warn(`[creative-lineage] ${message}${err ? `: ${err instanceof Error ? err.message : String(err)}` : ''}`);
}

// ---------------------------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------------------------

export interface GeneratedCreativeInput {
  userId: string;
  artifactUrl: string;
  sessionId?: string;
  category?: string;
  prompt: string;
  generatorModel: string;
  gates?: CreativeGateResult;
}

/**
 * Writes the creative record for a freshly generated image, then (when the human-eval enqueue
 * produced a candidate) links the candidate. Returns the creativeId written, or null when lineage
 * is off, the URL is not one of our S3 objects, or the write failed. Never throws.
 */
export async function recordGeneratedCreative(
  input: GeneratedCreativeInput,
  humanEvalCandidate?: Promise<{ candidateId: string } | null>,
  deps: CreativeLineageDeps = {},
): Promise<string | null> {
  const ctx = resolveDeps(deps);
  if (!ctx) return null;
  try {
    const s3Key = s3KeyForUrl(input.artifactUrl);
    if (!s3Key || !input.userId) return null;
    const creativeId = creativeIdForS3Key(s3Key);
    const now = ctx.now().toISOString();
    const gatesSummary = summarizeGates(input.gates);
    const record: CreativeLineageRecord = {
      creativeId,
      userId: input.userId,
      s3Key,
      artifactUrl: input.artifactUrl,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.category ? { category: input.category } : {}),
      promptHash: hashPrompt(input.prompt ?? ''),
      generatorModel: input.generatorModel,
      ...(gatesSummary ? { gatesSummary } : {}),
      schemaVersion: CREATIVE_LINEAGE_SCHEMA_VERSION,
      createdAt: now,
      updatedAt: now,
    };
    // Queued before any await, so a publish step started after generation finds the record.
    await serialized(input.userId, async () => {
      try {
        await ctx.db.put({ TableName: ctx.table, Item: record, ConditionExpression: 'attribute_not_exists(creativeId)' });
      } catch (err) {
        // Same S3 key twice means the same image: keep the first record and its links.
        if (!isConditionFailure(err)) throw err;
      }
    });

    // Awaited outside the queue: the enqueue (Slack, S3 copy) must not hold up publish stamps.
    const candidate = humanEvalCandidate ? await humanEvalCandidate.catch(() => null) : null;
    if (candidate?.candidateId) {
      await serialized(input.userId, () => ctx.db.update({
        TableName: ctx.table,
        Key: { creativeId },
        UpdateExpression: 'SET humanEvalCandidateId = :candidateId, updatedAt = :now',
        ConditionExpression: 'attribute_exists(creativeId)',
        ExpressionAttributeValues: { ':candidateId': candidate.candidateId, ':now': ctx.now().toISOString() },
      }));
    }
    return creativeId;
  } catch (err) {
    warn(`record for generated image failed (non-fatal)`, err);
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Publish
// ---------------------------------------------------------------------------------------------

/**
 * Stamps a Meta image upload: the uploaded URL resolves to its creative, which gains the image hash.
 * Returns the creativeId stamped, or null. Never throws.
 */
export async function stampMetaImageUpload(
  input: { userId: string; imageUrl: string; imageHash: string },
  deps: CreativeLineageDeps = {},
): Promise<string | null> {
  const ctx = resolveDeps(deps);
  if (!ctx) return null;
  const creativeId = creativeIdForUrl(input.imageUrl);
  if (!creativeId || !input.imageHash || !input.userId) return null;
  try {
    await serialized(input.userId, () => ctx.db.update({
      TableName: ctx.table,
      Key: { creativeId },
      UpdateExpression: 'ADD metaImageHashes :hash SET updatedAt = :now',
      ConditionExpression: 'attribute_exists(creativeId) AND userId = :userId',
      ExpressionAttributeValues: {
        ':hash': ctx.db.stringSet([input.imageHash]),
        ':now': ctx.now().toISOString(),
        ':userId': input.userId,
      },
    }));
    return creativeId;
  } catch (err) {
    // Condition failure = an image we have no record for (generated before lineage was on, or
    // another user's URL). Nothing to stamp.
    if (!isConditionFailure(err)) warn(`image upload stamp for ${creativeId} failed (non-fatal)`, err);
    return null;
  }
}

/** The image references a Meta ad creative request can carry, wherever they sit in it. */
export interface MetaCreativeMediaParams {
  image_hash?: string;
  image_url?: string;
  carousel_cards?: Array<{ image_hash?: string; image_url?: string }>;
  placement_assets?: Array<{ image_hash?: string; image_url?: string }>;
}

/**
 * The images Meta will actually serve. Per reference the hash wins over the URL, as it does in
 * MetaService.createAdCreative (`link_data.image_hash` else `picture`): a creative swap that
 * passes a new image_url while carrying the old creative's image_hash still serves the old image,
 * so linking the URL's creative there would credit it with another image's performance.
 */
export function collectCreativeMedia(params: MetaCreativeMediaParams): { imageUrls: string[]; imageHashes: string[] } {
  const refs = [params, ...(params.carousel_cards ?? []), ...(params.placement_assets ?? [])];
  const imageUrls = new Set<string>();
  const imageHashes = new Set<string>();
  for (const ref of refs) {
    if (typeof ref?.image_hash === 'string' && ref.image_hash) imageHashes.add(ref.image_hash);
    else if (typeof ref?.image_url === 'string' && ref.image_url) imageUrls.add(ref.image_url);
  }
  return { imageUrls: [...imageUrls], imageHashes: [...imageHashes] };
}

type LookupAttribute = 'metaImageHashes' | 'metaCreativeIds' | 'metaAdIds' | 'googleAssetResourceNames';

/** This user's creative records (within the lookup window) whose string set holds `value`. */
async function findUserCreativesContaining(
  ctx: Ctx,
  userId: string,
  attribute: LookupAttribute,
  value: string,
): Promise<CreativeLineageRecord[]> {
  const since = new Date(ctx.now().getTime() - LOOKUP_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const matches: CreativeLineageRecord[] = [];
  let lastKey: AWS.DynamoDB.DocumentClient.Key | undefined;
  let pages = 0;
  do {
    const res = await ctx.db.query({
      TableName: ctx.table,
      IndexName: CREATIVE_LINEAGE_USER_INDEX,
      KeyConditionExpression: 'userId = :userId AND createdAt >= :since',
      FilterExpression: 'contains(#attr, :value)',
      ExpressionAttributeNames: { '#attr': attribute },
      ExpressionAttributeValues: { ':userId': userId, ':since': since, ':value': value },
      ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
    });
    matches.push(...((res.Items ?? []) as CreativeLineageRecord[]));
    lastKey = res.LastEvaluatedKey;
    pages++;
  } while (lastKey && pages < LOOKUP_MAX_PAGES);
  if (lastKey) warn(`lookup of ${attribute} for a user hit the ${LOOKUP_MAX_PAGES}-page cap; the stamp may be incomplete`);
  return matches;
}

interface ResolvedCreative {
  creativeId: string;
  imageHash?: string;
}

async function stampCreative(
  ctx: Ctx,
  input: { userId: string; accountId: string; metaCreativeId: string; via: MetaPublishVia },
  media: { imageUrls: string[]; imageHashes: string[] },
): Promise<{ stamped: ResolvedCreative[]; unresolvedHashes: string[] }> {
  const resolved = new Map<string, ResolvedCreative>();
  for (const url of media.imageUrls) {
    const creativeId = creativeIdForUrl(url);
    if (creativeId && !resolved.has(creativeId)) resolved.set(creativeId, { creativeId });
  }
  const unresolvedHashes: string[] = [];
  for (const imageHash of media.imageHashes) {
    const records = await findUserCreativesContaining(ctx, input.userId, 'metaImageHashes', imageHash);
    if (records.length === 0) unresolvedHashes.push(imageHash);
    for (const record of records) resolved.set(record.creativeId, { creativeId: record.creativeId, imageHash });
  }

  const stamped: ResolvedCreative[] = [];
  for (const target of resolved.values()) {
    const linkedAt = ctx.now().toISOString();
    const link: MetaCreativeLink = {
      accountId: input.accountId,
      metaCreativeId: input.metaCreativeId,
      ...(target.imageHash ? { imageHash: target.imageHash } : {}),
      via: input.via,
      linkedAt,
    };
    try {
      await ctx.db.update({
        TableName: ctx.table,
        Key: { creativeId: target.creativeId },
        UpdateExpression:
          'ADD metaCreativeIds :creativeIdSet ' +
          'SET metaCreativeLinks = list_append(if_not_exists(metaCreativeLinks, :empty), :link), updatedAt = :now',
        ConditionExpression: 'attribute_exists(creativeId) AND userId = :userId',
        ExpressionAttributeValues: {
          ':creativeIdSet': ctx.db.stringSet([input.metaCreativeId]),
          ':empty': [],
          ':link': [link],
          ':now': linkedAt,
          ':userId': input.userId,
        },
      });
      stamped.push(target);
    } catch (err) {
      if (!isConditionFailure(err)) warn(`creative stamp for ${target.creativeId} failed (non-fatal)`, err);
    }
  }
  return { stamped, unresolvedHashes };
}

/**
 * Stamps the Meta creative on the generated images it uses and, when `adId` is given, the ad on
 * those same creatives (read back consistently). An image hash that resolves to nothing yet is
 * re-tried (an image hash of an asset we did not generate simply never resolves).
 */
function stampCreativeAndAd(
  ctx: Ctx,
  input: { userId: string; accountId: string; metaCreativeId: string; params: MetaCreativeMediaParams; via: MetaPublishVia; adId?: string },
  beforeFirstAttempt?: () => Promise<unknown>,
): Promise<string[]> {
  const media = collectCreativeMedia(input.params);
  let pending = media;
  return withLookupRetry(ctx, input.userId, async (n) => {
    if (n === 0 && beforeFirstAttempt) await beforeFirstAttempt();
    const { stamped, unresolvedHashes } = await stampCreative(ctx, input, pending);
    pending = { imageUrls: [], imageHashes: unresolvedHashes };
    let ids = stamped.map((s) => s.creativeId);
    if (input.adId) {
      const records: CreativeLineageRecord[] = [];
      for (const creativeId of ids) {
        const res = await ctx.db.get({ TableName: ctx.table, Key: { creativeId }, ConsistentRead: true });
        if (res.Item) records.push(res.Item as CreativeLineageRecord);
      }
      ids = await stampAd(ctx, { ...input, adId: input.adId }, records);
    }
    return { result: ids, retry: unresolvedHashes.length > 0 };
  }, concatIds);
}

/** True when the ad's latest link on this record is to `metaCreativeId` and has not ended since. */
function hasOpenAdLink(record: CreativeLineageRecord, accountId: string, adId: string, metaCreativeId: string): boolean {
  const links = (record.metaAdLinks ?? []).filter((l) => l.accountId === accountId && l.adId === adId);
  const latest = links.reduce<MetaAdLink | undefined>((a, l) => (!a || l.linkedAt > a.linkedAt ? l : a), undefined);
  if (!latest || latest.metaCreativeId !== metaCreativeId) return false;
  return !(record.metaAdLinkEnds ?? []).some((e) => e.accountId === accountId && e.adId === adId && e.endedAt >= latest.linkedAt);
}

/**
 * The ad's creative changed: every creative of this user linked to the ad gets an end marker, so
 * the report stops crediting it from this moment, whether or not the new creative is ours.
 */
async function closeAdLinks(
  ctx: Ctx,
  input: { userId: string; accountId: string; adId: string },
): Promise<string[]> {
  const closed: string[] = [];
  const endedAt = ctx.now().toISOString();
  const end: MetaAdLinkEnd = { accountId: input.accountId, adId: input.adId, endedAt };
  for (const record of await findUserCreativesContaining(ctx, input.userId, 'metaAdIds', input.adId)) {
    try {
      await ctx.db.update({
        TableName: ctx.table,
        Key: { creativeId: record.creativeId },
        UpdateExpression: 'SET metaAdLinkEnds = list_append(if_not_exists(metaAdLinkEnds, :empty), :end), updatedAt = :now',
        ConditionExpression: 'attribute_exists(creativeId) AND userId = :userId',
        ExpressionAttributeValues: { ':empty': [], ':end': [end], ':now': endedAt, ':userId': input.userId },
      });
      closed.push(record.creativeId);
    } catch (err) {
      if (!isConditionFailure(err)) warn(`ad link end for ${record.creativeId} failed (non-fatal)`, err);
    }
  }
  return closed;
}

async function stampAd(
  ctx: Ctx,
  input: { userId: string; accountId: string; metaCreativeId: string; adId: string; via: MetaPublishVia },
  targets: CreativeLineageRecord[],
): Promise<string[]> {
  const stamped: string[] = [];
  for (const record of targets) {
    if (hasOpenAdLink(record, input.accountId, input.adId, input.metaCreativeId)) {
      stamped.push(record.creativeId);
      continue;
    }
    const imageHash = record.metaCreativeLinks?.find((l) => l.metaCreativeId === input.metaCreativeId)?.imageHash;
    const linkedAt = ctx.now().toISOString();
    const link: MetaAdLink = {
      accountId: input.accountId,
      adId: input.adId,
      metaCreativeId: input.metaCreativeId,
      ...(imageHash ? { imageHash } : {}),
      via: input.via,
      linkedAt,
    };
    try {
      await ctx.db.update({
        TableName: ctx.table,
        Key: { creativeId: record.creativeId },
        UpdateExpression:
          'ADD metaAdIds :adIdSet SET metaAdLinks = list_append(if_not_exists(metaAdLinks, :empty), :link), updatedAt = :now',
        ConditionExpression: 'attribute_exists(creativeId) AND userId = :userId',
        ExpressionAttributeValues: {
          ':adIdSet': ctx.db.stringSet([input.adId]),
          ':empty': [],
          ':link': [link],
          ':now': linkedAt,
          ':userId': input.userId,
        },
      });
      stamped.push(record.creativeId);
    } catch (err) {
      if (!isConditionFailure(err)) warn(`ad stamp for ${record.creativeId} failed (non-fatal)`, err);
    }
  }
  return stamped;
}

/**
 * Stamps a created Meta ad creative on every generated image it uses. Returns the creativeIds
 * stamped (empty when lineage is off or no image was ours). Never throws.
 */
export async function stampMetaCreativeCreated(
  input: { userId: string; accountId: string; metaCreativeId: string; params: MetaCreativeMediaParams; via?: MetaPublishVia },
  deps: CreativeLineageDeps = {},
): Promise<string[]> {
  const ctx = resolveDeps(deps);
  if (!ctx || !input.userId || !input.metaCreativeId) return [];
  try {
    return await stampCreativeAndAd(ctx, { ...input, via: input.via ?? 'create_creative' });
  } catch (err) {
    warn(`creative stamp failed (non-fatal)`, err);
    return [];
  }
}

/**
 * Stamps a created Meta ad on the creatives whose Meta creative it uses (found through the
 * creative stamp). Returns the creativeIds stamped. Never throws.
 */
export async function stampMetaAdCreated(
  input: { userId: string; accountId: string; metaCreativeId: string; adId: string; via?: MetaPublishVia },
  deps: CreativeLineageDeps = {},
): Promise<string[]> {
  const ctx = resolveDeps(deps);
  if (!ctx || !input.userId || !input.metaCreativeId || !input.adId) return [];
  try {
    return await withLookupRetry(ctx, input.userId, async () => {
      const targets = await findUserCreativesContaining(ctx, input.userId, 'metaCreativeIds', input.metaCreativeId);
      return { result: await stampAd(ctx, { ...input, via: input.via ?? 'create_ad' }, targets), retry: targets.length === 0 };
    }, concatIds);
  } catch (err) {
    warn(`ad stamp failed (non-fatal)`, err);
    return [];
  }
}

/**
 * One-step publish (copy an ad, swap an ad's creative): the Meta creative and the ad are known
 * together, so the ad is stamped on exactly the creatives the creative stamp resolved, read back
 * consistently rather than through the (eventually consistent) user index. Never throws.
 */
export async function stampMetaPublish(
  input: {
    userId: string;
    accountId: string;
    metaCreativeId: string;
    adId: string;
    params: MetaCreativeMediaParams;
    via: MetaPublishVia;
  },
  deps: CreativeLineageDeps = {},
): Promise<string[]> {
  const ctx = resolveDeps(deps);
  if (!ctx || !input.userId || !input.metaCreativeId || !input.adId) return [];
  try {
    // A swap replaces what the ad carried before; end those links first so they stop here.
    return await stampCreativeAndAd(ctx, input, input.via === 'swap_creative' ? () => closeAdLinks(ctx, input) : undefined);
  } catch (err) {
    warn(`publish stamp failed (non-fatal)`, err);
    return [];
  }
}

/**
 * An existing ad was pointed at an already-built Meta creative (AD UPDATE with creative_id). Ends
 * the ad's previous links, then links the ad to the generated creatives that Meta creative uses,
 * if any. Returns the creativeIds newly linked. Never throws.
 */
export async function stampMetaAdCreativeChanged(
  input: { userId: string; accountId: string; metaCreativeId: string; adId: string },
  deps: CreativeLineageDeps = {},
): Promise<string[]> {
  const ctx = resolveDeps(deps);
  if (!ctx || !input.userId || !input.metaCreativeId || !input.adId) return [];
  try {
    return await withLookupRetry(ctx, input.userId, async (n) => {
      if (n === 0) await closeAdLinks(ctx, input);
      const targets = await findUserCreativesContaining(ctx, input.userId, 'metaCreativeIds', input.metaCreativeId);
      return { result: await stampAd(ctx, { ...input, via: 'swap_creative' }, targets), retry: targets.length === 0 };
    }, concatIds);
  } catch (err) {
    warn(`ad creative change stamp failed (non-fatal)`, err);
    return [];
  }
}

// ---------------------------------------------------------------------------------------------
// Google Ads (ENG-2235)
// ---------------------------------------------------------------------------------------------

/**
 * Stamps a Google Ads image-asset upload: the uploaded URL resolves to its creative, which gains
 * the asset resource name. Buffer uploads (no URL) cannot be linked. Returns the creativeId stamped,
 * or null. Never throws.
 */
export async function stampGoogleAssetUpload(
  input: { userId: string; imageUrl: string; assetResourceName: string },
  deps: CreativeLineageDeps = {},
): Promise<string | null> {
  const ctx = resolveDeps(deps);
  if (!ctx) return null;
  const creativeId = creativeIdForUrl(input.imageUrl);
  if (!creativeId || !input.assetResourceName || !input.userId) return null;
  try {
    await serialized(input.userId, () => ctx.db.update({
      TableName: ctx.table,
      Key: { creativeId },
      UpdateExpression: 'ADD googleAssetResourceNames :asset SET updatedAt = :now',
      ConditionExpression: 'attribute_exists(creativeId) AND userId = :userId',
      ExpressionAttributeValues: {
        ':asset': ctx.db.stringSet([input.assetResourceName]),
        ':now': ctx.now().toISOString(),
        ':userId': input.userId,
      },
    }));
    return creativeId;
  } catch (err) {
    if (!isConditionFailure(err)) warn(`google asset upload stamp for ${creativeId} failed (non-fatal)`, err);
    return null;
  }
}

/**
 * Stamps a created Google Ads ad on every generated creative whose uploaded asset it uses.
 * Returns the creativeIds stamped (empty when lineage is off or no asset was ours). Never throws.
 */
export async function stampGoogleAdCreated(
  input: { userId: string; customerId: string; adResourceName: string; assetResourceNames: string[] | undefined },
  deps: CreativeLineageDeps = {},
): Promise<string[]> {
  const ctx = resolveDeps(deps);
  const assets = [...new Set((input.assetResourceNames ?? []).filter((a) => typeof a === 'string' && a))];
  if (!ctx || !input.userId || !input.adResourceName || assets.length === 0) return [];
  const done = new Set<string>();
  // GSI reads are eventually consistent: keep retrying while ANY asset is still unmatched.
  const resolvedAssets = new Set<string>();
  try {
    return await withLookupRetry(ctx, input.userId, async () => {
      const stamped: string[] = [];
      for (const assetResourceName of assets) {
        if (resolvedAssets.has(assetResourceName)) continue;
        const records = await findUserCreativesContaining(ctx, input.userId, 'googleAssetResourceNames', assetResourceName);
        if (records.length > 0) resolvedAssets.add(assetResourceName);
        for (const record of records) {
          if (done.has(record.creativeId)) continue;
          if ((record.googleAdLinks ?? []).some((l) => l.adResourceName === input.adResourceName)) {
            done.add(record.creativeId);
            stamped.push(record.creativeId);
            continue;
          }
          const linkedAt = ctx.now().toISOString();
          const link: GoogleAdLink = { customerId: input.customerId, adResourceName: input.adResourceName, assetResourceName, linkedAt };
          try {
            await ctx.db.update({
              TableName: ctx.table,
              Key: { creativeId: record.creativeId },
              UpdateExpression:
                'ADD googleAdResourceNames :adSet SET googleAdLinks = list_append(if_not_exists(googleAdLinks, :empty), :link), updatedAt = :now',
              // Reject a duplicate link atomically (concurrent stamps may both read pre-link state).
              ConditionExpression:
                'attribute_exists(creativeId) AND userId = :userId AND NOT contains(googleAdResourceNames, :adName)',
              ExpressionAttributeValues: {
                ':adSet': ctx.db.stringSet([input.adResourceName]),
                ':adName': input.adResourceName,
                ':empty': [],
                ':link': [link],
                ':now': linkedAt,
                ':userId': input.userId,
              },
            });
            done.add(record.creativeId);
            stamped.push(record.creativeId);
          } catch (err) {
            if (isConditionFailure(err)) {
              // Record came from a user-scoped lookup, so the failure is the duplicate-link guard:
              // the ad is already linked on this creative.
              done.add(record.creativeId);
              stamped.push(record.creativeId);
            } else {
              warn(`google ad stamp for ${record.creativeId} failed (non-fatal)`, err);
            }
          }
        }
      }
      return { result: stamped, retry: resolvedAssets.size < assets.length };
    }, concatIds);
  } catch (err) {
    warn(`google ad stamp failed (non-fatal)`, err);
    return [];
  }
}
