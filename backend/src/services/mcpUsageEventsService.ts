import { isTransactionConditionFailure, writeWithEvaluationGuard } from './evaluationPersistence';
import AWS from 'aws-sdk';
import { LOOP_EVENTS_TABLE } from '../loops/core/sensors/eventTableEventSource';
import type { DynamoAttributeMap, DynamoAttributeValue } from '../loops/core/ports';
import { userDb } from './db';
import { normalizeProduct, validateRef, type JourneyProduct } from './journeyAttribution';
import { isDatabricksRedirectUri } from '../mcp/zomaDatabricksReadOnly';

export const EMMA_MCP_LOOP_ID = 'emma-mcp';
export const EVT_MCP_OAUTH_STARTED = 'mcp_oauth_started';
export const EVT_MCP_OAUTH_AUTHORIZED = 'mcp_oauth_authorized';
export const EVT_MCP_OAUTH_TOKEN_ISSUED = 'mcp_oauth_token_issued';
export const EVT_MCP_CONNECTION_ATTEMPTED = 'mcp_connection_attempted';
export const EVT_MCP_TOOL_USED = 'mcp_tool_used';
export const EVT_MCP_FIRST_TOOL_USED = 'mcp_first_tool_used';
/** ENG-2303 P4: a Meta Toolkit write that was dispatched to Meta (the billable unit). */
export const EVT_MCP_WRITE_EXECUTED = 'mcp_write_executed';
/** ENG-3130: a call that failed in-band. Audit only: never counted as a tool call and never billed. */
export const EVT_MCP_TOOL_FAILED = 'mcp_tool_failed';

export type McpAuthMethod = 'api_key' | 'oauth' | 'internal_token' | 'zoma_token' | 'unknown';
export type McpClientType =
  | 'claude_ai'
  | 'claude_code'
  | 'codex'
  | 'chatgpt'
  | 'hermes'
  | 'openclaw'
  | 'databricks'
  | 'api_key'
  | 'unknown';

export interface McpUsageEventStore {
  put(item: DynamoAttributeMap, options?: { condition?: 'attribute_not_exists' }): Promise<void>;
  queryByLoopId(loopId: string): Promise<DynamoAttributeMap[]>;
  /** Range read on the existing (loopId, tsSession) key; ts-prefixed sort keys only. */
  queryByLoopIdTsRange?(loopId: string, startIso: string, endIso: string, subjectId: string): Promise<DynamoAttributeMap[]>;
  /** Exact-key read (one GetItem). Used for rows written with a dedupeKey, whose sort key carries no timestamp. */
  get?(loopId: string, tsSession: string): Promise<DynamoAttributeMap | undefined>;
}

export interface McpConnectionAttemptInput {
  /** ENG-2906: zoma | emma_mcp | emma_web | unknown (attribution only). Defaults to unknown. */
  product?: JourneyProduct;
  userId?: string;
  authMethod?: McpAuthMethod;
  apiKeyId?: string;
  clientId?: string;
  clientName?: string;
  clientType?: McpClientType;
  sessionId?: string;
  userAgent?: string;
  requestId?: string;
  /** ENG-2906: validated `ref` from the MCP URL (?ref=); dropped when invalid. */
  ref?: string;
  now?: Date;
}

export interface McpOAuthStartedInput {
  /** ENG-2906: zoma | emma_mcp | emma_web | unknown (attribution only). Defaults to unknown. */
  product?: JourneyProduct;
  clientId: string;
  clientName?: string;
  clientType?: McpClientType;
  redirectUri?: string;
  scope?: string;
  userAgent?: string;
  now?: Date;
}

export interface McpOAuthUserEventInput {
  /** ENG-2906: zoma | emma_mcp | emma_web | unknown (attribution only). Defaults to unknown. */
  product?: JourneyProduct;
  userId?: string;
  clientId?: string;
  clientName?: string;
  clientType?: McpClientType;
  redirectUri?: string;
  scope?: string;
  userAgent?: string;
  now?: Date;
}

export interface McpToolUseInput {
  /** ENG-2906: zoma | emma_mcp | emma_web | unknown (attribution only). Defaults to unknown. */
  product?: JourneyProduct;
  userId?: string;
  toolName: string;
  authMethod?: McpAuthMethod;
  apiKeyId?: string;
  clientId?: string;
  clientName?: string;
  clientType?: McpClientType;
  sessionId?: string;
  llmModel?: string;
  userAgent?: string;
  /** ENG-2823: ad platform a Zoma toolkit call ran against ('meta' | 'google_ads'). */
  platform?: string;
  /** ENG-2906: validated `ref` from the MCP URL (?ref=); dropped when invalid. */
  ref?: string;
  now?: Date;
}

export interface McpWriteExecutedInput extends McpToolUseInput {
  entityType: string;
  action: string;
  /** Read-back verdict: CONFIRMED | MISMATCH | UNCONFIRMED. */
  verification: string;
  objectId?: string;
  /** ENG-2902: create | edit | pause | approve (status→ACTIVE go-live); scoreboard input. */
  writeKind?: string;
}

export interface McpUserUsage {
  start: string;
  end: string;
  toolCalls: number;
  writes: { total: number; confirmed: number; mismatch: number; unconfirmed: number };
  recentWrites: Array<{ ts: string; platform?: string; entityType?: string; action?: string; verification?: string; objectId?: string }>;
}

export interface McpUsageReport {
  start: string;
  end: string;
  summary: {
    oauthStarts: number;
    authorizedUsers: number;
    tokenIssuedUsers: number;
    connectionAttempts: number;
    connectedUsers: number;
    toolCalls: number;
    firstUseUsers: number;
    firstUseRate: number;
  };
  clients: Array<{
    clientType: McpClientType;
    oauthStarts: number;
    authorizedUsers: number;
    tokenIssuedUsers: number;
    connectionAttempts: number;
    connectedUsers: number;
    toolCalls: number;
    firstUseUsers: number;
    clientNames: string[];
  }>;
  users: Array<{
    userId: string;
    email?: string;
    companyName?: string;
    oauthAuthorizedAt?: string;
    tokenIssuedAt?: string;
    connectionAttempts: number;
    firstConnectedAt?: string;
    lastConnectedAt?: string;
    toolCalls: number;
    lastUsedAt?: string;
    lastToolName?: string;
    firstUsedAt?: string;
    firstToolName?: string;
    authMethods: string[];
    apiKeyIds: string[];
    clientIds: string[];
    clientNames: string[];
    clientTypes: McpClientType[];
  }>;
}

class DynamoMcpUsageEventStore implements McpUsageEventStore {
  private readonly doc = new AWS.DynamoDB.DocumentClient({
    region: process.env.AWS_REGION || 'us-west-2',
  });

  async put(item: DynamoAttributeMap, options?: { condition?: 'attribute_not_exists' }): Promise<void> {
    const prefix = process.env.NODE_ENV === 'development' ? 'Dev-' : '';
    await writeWithEvaluationGuard(this.doc, typeof item.subjectId === 'string' ? item.subjectId : undefined, prefix, { Put: {
      TableName: LOOP_EVENTS_TABLE,
      Item: item as Record<string, unknown>,
      ...(options?.condition === 'attribute_not_exists'
        ? { ConditionExpression: 'attribute_not_exists(loopId) AND attribute_not_exists(tsSession)' }
        : {}),
    } });
  }

  async queryByLoopIdTsRange(loopId: string, startIso: string, endIso: string, subjectId: string): Promise<DynamoAttributeMap[]> {
    const items: DynamoAttributeMap[] = [];
    let lastKey: AWS.DynamoDB.DocumentClient.Key | undefined;
    do {
      const result = await this.doc
        .query({
          TableName: LOOP_EVENTS_TABLE,
          KeyConditionExpression: 'loopId = :loopId AND tsSession BETWEEN :start AND :end',
          FilterExpression: 'subjectId = :subjectId',
          ExpressionAttributeValues: { ':loopId': loopId, ':start': startIso, ':end': endIso, ':subjectId': subjectId },
          ExclusiveStartKey: lastKey,
        })
        .promise();
      items.push(...((result.Items ?? []) as DynamoAttributeMap[]));
      lastKey = result.LastEvaluatedKey;
    } while (lastKey);
    return items;
  }

  async get(loopId: string, tsSession: string): Promise<DynamoAttributeMap | undefined> {
    const result = await this.doc.get({ TableName: LOOP_EVENTS_TABLE, Key: { loopId, tsSession } }).promise();
    return result.Item as DynamoAttributeMap | undefined;
  }

  async queryByLoopId(loopId: string): Promise<DynamoAttributeMap[]> {
    const items: DynamoAttributeMap[] = [];
    let lastKey: AWS.DynamoDB.DocumentClient.Key | undefined;

    do {
      const result = await this.doc
        .query({
          TableName: LOOP_EVENTS_TABLE,
          KeyConditionExpression: 'loopId = :loopId',
          ExpressionAttributeValues: { ':loopId': loopId },
          ExclusiveStartKey: lastKey,
        })
        .promise();
      items.push(...((result.Items ?? []) as DynamoAttributeMap[]));
      lastKey = result.LastEvaluatedKey;
    } while (lastKey);

    return items;
  }
}

const defaultStore = new DynamoMcpUsageEventStore();

export async function recordMcpOAuthStarted(
  input: McpOAuthStartedInput,
  store: McpUsageEventStore = defaultStore,
): Promise<boolean> {
  const clientId = cleanString(input.clientId);
  if (!clientId) return false;

  const ts = (input.now ?? new Date()).toISOString();
  const item = eventItem({
    eventType: EVT_MCP_OAUTH_STARTED,
    subjectId: `client:${clientId}`,
    ts,
    tsSession: `${ts}#${clientId}#${EVT_MCP_OAUTH_STARTED}#${Math.random().toString(36).slice(2, 10)}`,
    dimensions: {
      product: normalizeProduct(input.product),
      clientId,
      clientName: cleanString(input.clientName),
      clientType: input.clientType ?? classifyMcpClient(input),
      redirectUri: cleanString(input.redirectUri),
      scope: cleanString(input.scope),
      userAgent: cleanString(input.userAgent),
    },
  });

  await store.put(item);
  return true;
}

export async function recordMcpOAuthAuthorized(
  input: McpOAuthUserEventInput,
  store: McpUsageEventStore = defaultStore,
): Promise<boolean> {
  return recordMcpUserEvent(EVT_MCP_OAUTH_AUTHORIZED, input, store);
}

export async function recordMcpOAuthTokenIssued(
  input: McpOAuthUserEventInput,
  store: McpUsageEventStore = defaultStore,
): Promise<boolean> {
  return recordMcpUserEvent(EVT_MCP_OAUTH_TOKEN_ISSUED, input, store);
}

export async function recordMcpConnectionAttempt(
  input: McpConnectionAttemptInput,
  store: McpUsageEventStore = defaultStore,
): Promise<boolean> {
  if (!input.userId) return false;

  const ts = (input.now ?? new Date()).toISOString();
  const requestId = cleanString(input.requestId) ?? `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const item = eventItem({
    eventType: EVT_MCP_CONNECTION_ATTEMPTED,
    subjectId: input.userId,
    ts,
    tsSession: `${ts}#${input.userId}#${EVT_MCP_CONNECTION_ATTEMPTED}#${requestId}`,
    dimensions: {
      product: normalizeProduct(input.product),
      authMethod: input.authMethod ?? 'unknown',
      apiKeyId: cleanString(input.apiKeyId),
      clientId: cleanString(input.clientId),
      clientName: cleanString(input.clientName),
      clientType: input.clientType ?? classifyMcpClient(input),
      sessionId: cleanString(input.sessionId),
      userAgent: cleanString(input.userAgent),
      requestId,
      ref: validateRef(input.ref),
    },
  });

  await store.put(item);
  return true;
}

export async function recordMcpToolUse(
  input: McpToolUseInput,
  store: McpUsageEventStore = defaultStore,
): Promise<boolean> {
  if (!input.userId) return false;

  const ts = (input.now ?? new Date()).toISOString();
  const item = eventItem({
    eventType: EVT_MCP_TOOL_USED,
    subjectId: input.userId,
    ts,
    tsSession: `${ts}#${input.userId}#${EVT_MCP_TOOL_USED}#${Math.random().toString(36).slice(2, 10)}`,
    dimensions: {
      product: normalizeProduct(input.product),
      authMethod: input.authMethod ?? 'unknown',
      apiKeyId: cleanString(input.apiKeyId),
      clientId: cleanString(input.clientId),
      clientName: cleanString(input.clientName),
      clientType: input.clientType ?? classifyMcpClient(input),
      sessionId: cleanString(input.sessionId),
      llmModel: cleanString(input.llmModel),
      toolName: input.toolName,
      userAgent: cleanString(input.userAgent),
      platform: cleanString(input.platform),
      ref: validateRef(input.ref),
    },
  });

  await store.put(item);
  return true;
}

/**
 * ENG-3130: audit row for a call that finished but reported failure in-band (`success:false`).
 * Same table and key shape as tool use, but a different event type: it is not in
 * MCP_USAGE_EVENT_TYPES and `getMcpUserUsage` counts only `mcp_tool_used`, so a failed call is
 * never counted as usage and never billed. Tool name, platform and client only, no arguments or
 * error text (they can hold ad copy and ids).
 */
export async function recordMcpToolFailed(
  input: McpToolUseInput,
  store: McpUsageEventStore = defaultStore,
): Promise<boolean> {
  if (!input.userId) return false;

  const ts = (input.now ?? new Date()).toISOString();
  const item = eventItem({
    eventType: EVT_MCP_TOOL_FAILED,
    subjectId: input.userId,
    ts,
    tsSession: `${ts}#${input.userId}#${EVT_MCP_TOOL_FAILED}#${Math.random().toString(36).slice(2, 10)}`,
    dimensions: {
      product: normalizeProduct(input.product),
      outcome: 'failed',
      authMethod: input.authMethod ?? 'unknown',
      apiKeyId: cleanString(input.apiKeyId),
      clientId: cleanString(input.clientId),
      clientType: input.clientType ?? classifyMcpClient(input),
      sessionId: cleanString(input.sessionId),
      toolName: input.toolName,
      userAgent: cleanString(input.userAgent),
      platform: cleanString(input.platform),
    },
  });

  await store.put(item);
  return true;
}

/**
 * ENG-2303 P4: one event per Meta Toolkit write dispatched to Meta, distinct from
 * `mcp_tool_used` (which still counts every call, previews included). Recorded only —
 * no Stripe charge is made (price undecided). Same table and key shape as tool use.
 */
export async function recordMcpWriteExecuted(
  input: McpWriteExecutedInput,
  store: McpUsageEventStore = defaultStore,
): Promise<boolean> {
  if (!input.userId) return false;
  const ts = (input.now ?? new Date()).toISOString();
  const item = eventItem({
    eventType: EVT_MCP_WRITE_EXECUTED,
    subjectId: input.userId,
    ts,
    tsSession: `${ts}#${input.userId}#${EVT_MCP_WRITE_EXECUTED}#${Math.random().toString(36).slice(2, 10)}`,
    dimensions: {
      product: normalizeProduct(input.product),
      authMethod: input.authMethod ?? 'unknown',
      apiKeyId: cleanString(input.apiKeyId),
      clientId: cleanString(input.clientId),
      clientType: input.clientType ?? classifyMcpClient(input),
      sessionId: cleanString(input.sessionId),
      toolName: input.toolName,
      userAgent: cleanString(input.userAgent),
      platform: cleanString(input.platform),
      entityType: input.entityType,
      action: input.action,
      verification: input.verification,
      objectId: cleanString(input.objectId),
      writeKind: cleanString(input.writeKind),
    },
  });
  await store.put(item);
  return true;
}

/** ENG-3131: Zoma plan funnel (paywall → checkout → paid → trial converted/canceled). */
export const EVT_ZOMA_BILLING_FUNNEL = 'zoma_billing_funnel';
export type ZomaBillingFunnelStep =
  | 'paywall_shown'
  | 'checkout_started'
  | 'paid'
  | 'checkout_canceled'
  | 'checkout_expired'
  | 'trial_reminder_claimed'
  | 'trial_reminder_sent'
  | 'trial_converted'
  | 'trial_canceled'
  | 'subscription_canceled'
  /** ENG-3133: weekly ad-performance email (claim = one send per user per week; opt_out = the user's unsubscribe). */
  | 'weekly_report_claimed'
  | 'weekly_report_sent'
  | 'weekly_report_opt_out';

export interface ZomaBillingFunnelInput {
  userId: string;
  step: ZomaBillingFunnelStep;
  /** Stable id (Stripe event / session id). With it the row is written once, so webhook retries never double count. */
  dedupeKey?: string;
  dimensions?: Record<string, unknown>;
  now?: Date;
}

/** Same table and key shape as tool use; no new persistence. Returns false for a deduped repeat. */
export async function recordZomaBillingFunnel(
  input: ZomaBillingFunnelInput,
  store: McpUsageEventStore = defaultStore,
): Promise<boolean> {
  if (!input.userId) return false;
  const ts = (input.now ?? new Date()).toISOString();
  // With a dedupeKey the sort key carries no timestamp: a key that embeds `ts` is different on every
  // call, so the conditional put below could never see a repeat.
  const tsSession = input.dedupeKey
    ? zomaFunnelDedupeSortKey(input.userId, input.step, input.dedupeKey)
    : `${ts}#${input.userId}#${EVT_ZOMA_BILLING_FUNNEL}#${input.step}#${Math.random().toString(36).slice(2, 10)}`;
  const item = eventItem({
    eventType: EVT_ZOMA_BILLING_FUNNEL,
    subjectId: input.userId,
    ts,
    tsSession,
    dimensions: { product: 'zoma', step: input.step, ...(input.dimensions ?? {}) },
  });
  if (!input.dedupeKey) {
    await store.put(item);
    return true;
  }
  try {
    await store.put(item, { condition: 'attribute_not_exists' });
    return true;
  } catch (error: any) {
    if (error?.code === 'ConditionalCheckFailedException' || isTransactionConditionFailure(error)) return false;
    throw error;
  }
}

/** The sort key `recordZomaBillingFunnel` writes for a row that has a dedupeKey (no timestamp in it). */
export const zomaFunnelDedupeSortKey = (userId: string, step: ZomaBillingFunnelStep, dedupeKey: string) =>
  `${EVT_ZOMA_BILLING_FUNNEL}#${userId}#${step}#${dedupeKey}`;

/** True when the funnel row (userId, step, dedupeKey) exists. One GetItem; a store without `get` answers false. */
export async function hasZomaFunnelRow(
  userId: string,
  step: ZomaBillingFunnelStep,
  dedupeKey: string,
  store: McpUsageEventStore = defaultStore,
): Promise<boolean> {
  if (!userId || !store.get) return false;
  return !!(await store.get(EMMA_MCP_LOOP_ID, zomaFunnelDedupeSortKey(userId, step, dedupeKey)));
}

/** Per-user usage for [start, end): tool calls and dispatched writes by read-back verdict. */
export async function getMcpUserUsage(
  userId: string,
  params: { start: string; end: string },
  store: McpUsageEventStore = defaultStore,
): Promise<McpUserUsage> {
  const rows = store.queryByLoopIdTsRange
    ? await store.queryByLoopIdTsRange(EMMA_MCP_LOOP_ID, params.start, params.end, userId)
    : await store.queryByLoopId(EMMA_MCP_LOOP_ID);
  const startMs = Date.parse(params.start);
  const endMs = Date.parse(params.end);
  const events = rows
    .map(parseEventRow)
    .filter((e): e is ParsedMcpEvent => !!e && e.subjectId === userId && e.ts.getTime() >= startMs && e.ts.getTime() < endMs);
  const writes = events.filter((e) => e.eventType === EVT_MCP_WRITE_EXECUTED).sort((a, b) => a.ts.getTime() - b.ts.getTime());
  const count = (v: string) => writes.filter((w) => w.dimensions.verification === v).length;
  return {
    start: params.start,
    end: params.end,
    toolCalls: events.filter((e) => e.eventType === EVT_MCP_TOOL_USED).length,
    writes: { total: writes.length, confirmed: count('CONFIRMED'), mismatch: count('MISMATCH'), unconfirmed: count('UNCONFIRMED') },
    recentWrites: writes.slice(-5).map((w) => ({
      ts: w.tsIso,
      ...(w.dimensions.platform ? { platform: w.dimensions.platform } : {}),
      entityType: w.dimensions.entityType,
      action: w.dimensions.action,
      verification: w.dimensions.verification,
      objectId: w.dimensions.objectId,
    })),
  };
}

export async function recordMcpFirstToolUse(
  input: McpToolUseInput,
  store: McpUsageEventStore = defaultStore,
): Promise<boolean> {
  if (!input.userId) return false;

  const ts = (input.now ?? new Date()).toISOString();
  const item = eventItem({
    eventType: EVT_MCP_FIRST_TOOL_USED,
    subjectId: input.userId,
    ts,
    tsSession: `first_use#${input.userId}`,
    dimensions: {
      product: normalizeProduct(input.product),
      authMethod: input.authMethod ?? 'unknown',
      apiKeyId: cleanString(input.apiKeyId),
      clientId: cleanString(input.clientId),
      clientName: cleanString(input.clientName),
      clientType: input.clientType ?? classifyMcpClient(input),
      sessionId: cleanString(input.sessionId),
      llmModel: cleanString(input.llmModel),
      toolName: input.toolName,
      userAgent: cleanString(input.userAgent),
    },
  });

  try {
    await store.put(item, { condition: 'attribute_not_exists' });
    return true;
  } catch (error: any) {
    if (error?.code === 'ConditionalCheckFailedException' || isTransactionConditionFailure(error)) return false;
    throw error;
  }
}

export async function buildMcpUsageReport(
  params: { start: string; end: string },
  store: McpUsageEventStore = defaultStore,
  resolveUsers: (userIds: string[]) => Promise<Map<string, { email?: string; companyName?: string }>> = defaultResolveUsers,
): Promise<McpUsageReport> {
  const startInclusive = new Date(`${params.start}T00:00:00.000Z`);
  const endExclusive = new Date(`${params.end}T00:00:00.000Z`);
  endExclusive.setUTCDate(endExclusive.getUTCDate() + 1);

  const rows = (await store.queryByLoopId(EMMA_MCP_LOOP_ID))
    .map(parseEventRow)
    .filter((row): row is ParsedMcpEvent => Boolean(row))
    .filter((row) => row.ts >= startInclusive && row.ts < endExclusive)
    .filter((row) => MCP_USAGE_EVENT_TYPES.has(row.eventType))
    .sort((a, b) => a.ts.toISOString().localeCompare(b.ts.toISOString()));

  const byUser = new Map<string, UserAccumulator>();
  const byClient = new Map<McpClientType, ClientAccumulator>();

  for (const row of rows) {
    const clientType = cleanClientType(row.dimensions.clientType) ?? classifyMcpClient(row.dimensions);
    const clientAcc = getClientAccumulator(byClient, clientType);
    addString(clientAcc.clientNames, row.dimensions.clientName);

    if (row.eventType === EVT_MCP_OAUTH_STARTED) {
      clientAcc.oauthStarts += 1;
    }

    if (row.subjectId.startsWith('client:')) continue;

    const acc = getAccumulator(byUser, row.subjectId);
    addString(acc.authMethods, row.dimensions.authMethod);
    addString(acc.apiKeyIds, row.dimensions.apiKeyId);
    addString(acc.clientIds, row.dimensions.clientId);
    addString(acc.clientNames, row.dimensions.clientName);
    acc.clientTypes.add(clientType);

    if (row.eventType === EVT_MCP_OAUTH_AUTHORIZED) {
      acc.oauthAuthorizedAt = minIso(acc.oauthAuthorizedAt, row.tsIso);
      clientAcc.authorizedUserIds.add(row.subjectId);
    }

    if (row.eventType === EVT_MCP_OAUTH_TOKEN_ISSUED) {
      acc.tokenIssuedAt = minIso(acc.tokenIssuedAt, row.tsIso);
      clientAcc.tokenIssuedUserIds.add(row.subjectId);
    }

    if (row.eventType === EVT_MCP_CONNECTION_ATTEMPTED) {
      acc.connectionAttempts += 1;
      acc.firstConnectedAt = minIso(acc.firstConnectedAt, row.tsIso);
      acc.lastConnectedAt = maxIso(acc.lastConnectedAt, row.tsIso);
      clientAcc.connectionAttempts += 1;
      clientAcc.connectedUserIds.add(row.subjectId);
    }

    if (row.eventType === EVT_MCP_TOOL_USED) {
      acc.toolCalls += 1;
      acc.lastUsedAt = maxIso(acc.lastUsedAt, row.tsIso);
      if (acc.lastUsedAt === row.tsIso) acc.lastToolName = cleanString(row.dimensions.toolName);
      clientAcc.toolCalls += 1;
    }

    if (row.eventType === EVT_MCP_FIRST_TOOL_USED && !acc.firstUsedAt) {
      acc.firstUsedAt = row.tsIso;
      acc.firstToolName = cleanString(row.dimensions.toolName);
      clientAcc.firstUseUserIds.add(row.subjectId);
    }
  }

  const userDetails = await resolveUsers([...byUser.keys()]);
  const users = [...byUser.values()]
    .map((acc) => ({
      userId: acc.userId,
      ...(userDetails.get(acc.userId)?.email ? { email: userDetails.get(acc.userId)!.email } : {}),
      ...(userDetails.get(acc.userId)?.companyName ? { companyName: userDetails.get(acc.userId)!.companyName } : {}),
      ...(acc.oauthAuthorizedAt ? { oauthAuthorizedAt: acc.oauthAuthorizedAt } : {}),
      ...(acc.tokenIssuedAt ? { tokenIssuedAt: acc.tokenIssuedAt } : {}),
      connectionAttempts: acc.connectionAttempts,
      ...(acc.firstConnectedAt ? { firstConnectedAt: acc.firstConnectedAt } : {}),
      ...(acc.lastConnectedAt ? { lastConnectedAt: acc.lastConnectedAt } : {}),
      toolCalls: acc.toolCalls,
      ...(acc.lastUsedAt ? { lastUsedAt: acc.lastUsedAt } : {}),
      ...(acc.lastToolName ? { lastToolName: acc.lastToolName } : {}),
      ...(acc.firstUsedAt ? { firstUsedAt: acc.firstUsedAt } : {}),
      ...(acc.firstToolName ? { firstToolName: acc.firstToolName } : {}),
      authMethods: [...acc.authMethods].sort(),
      apiKeyIds: [...acc.apiKeyIds].sort(),
      clientIds: [...acc.clientIds].sort(),
      clientNames: [...acc.clientNames].sort(),
      clientTypes: [...acc.clientTypes].sort(),
    }))
    .sort((a, b) => String(a.firstConnectedAt ?? a.lastUsedAt ?? a.firstUsedAt ?? a.tokenIssuedAt ?? a.oauthAuthorizedAt ?? '').localeCompare(String(b.firstConnectedAt ?? b.lastUsedAt ?? b.firstUsedAt ?? b.tokenIssuedAt ?? b.oauthAuthorizedAt ?? '')));

  const connectedUsers = users.filter((u) => u.connectionAttempts > 0).length;
  const firstUseUsers = users.filter((u) => Boolean(u.firstUsedAt)).length;
  const clients = [...byClient.values()]
    .map((acc) => ({
      clientType: acc.clientType,
      oauthStarts: acc.oauthStarts,
      authorizedUsers: acc.authorizedUserIds.size,
      tokenIssuedUsers: acc.tokenIssuedUserIds.size,
      connectionAttempts: acc.connectionAttempts,
      connectedUsers: acc.connectedUserIds.size,
      toolCalls: acc.toolCalls,
      firstUseUsers: acc.firstUseUserIds.size,
      clientNames: [...acc.clientNames].sort(),
    }))
    .filter((client) => client.oauthStarts > 0 || client.authorizedUsers > 0 || client.tokenIssuedUsers > 0 || client.connectionAttempts > 0 || client.toolCalls > 0 || client.firstUseUsers > 0)
    .sort((a, b) => b.connectionAttempts - a.connectionAttempts || b.toolCalls - a.toolCalls || a.clientType.localeCompare(b.clientType));

  return {
    start: params.start,
    end: params.end,
    summary: {
      oauthStarts: rows.filter((row) => row.eventType === EVT_MCP_OAUTH_STARTED).length,
      authorizedUsers: users.filter((u) => Boolean(u.oauthAuthorizedAt)).length,
      tokenIssuedUsers: users.filter((u) => Boolean(u.tokenIssuedAt)).length,
      connectionAttempts: rows.filter((row) => row.eventType === EVT_MCP_CONNECTION_ATTEMPTED).length,
      connectedUsers,
      toolCalls: rows.filter((row) => row.eventType === EVT_MCP_TOOL_USED).length,
      firstUseUsers,
      firstUseRate: connectedUsers === 0 ? 0 : firstUseUsers / connectedUsers,
    },
    clients,
    users,
  };
}

interface EventItemInput {
  eventType: string;
  subjectId: string;
  ts: string;
  tsSession: string;
  dimensions: Record<string, unknown>;
}

const MCP_USAGE_EVENT_TYPES = new Set([
  EVT_MCP_OAUTH_STARTED,
  EVT_MCP_OAUTH_AUTHORIZED,
  EVT_MCP_OAUTH_TOKEN_ISSUED,
  EVT_MCP_CONNECTION_ATTEMPTED,
  EVT_MCP_TOOL_USED,
  EVT_MCP_FIRST_TOOL_USED,
]);

async function recordMcpUserEvent(
  eventType: typeof EVT_MCP_OAUTH_AUTHORIZED | typeof EVT_MCP_OAUTH_TOKEN_ISSUED,
  input: McpOAuthUserEventInput,
  store: McpUsageEventStore,
): Promise<boolean> {
  if (!input.userId) return false;

  const ts = (input.now ?? new Date()).toISOString();
  const item = eventItem({
    eventType,
    subjectId: input.userId,
    ts,
    tsSession: `${eventType}#${input.userId}#${cleanString(input.clientId) ?? 'unknown'}`,
    dimensions: {
      product: normalizeProduct(input.product),
      authMethod: 'oauth',
      clientId: cleanString(input.clientId),
      clientName: cleanString(input.clientName),
      clientType: input.clientType ?? classifyMcpClient(input),
      redirectUri: cleanString(input.redirectUri),
      scope: cleanString(input.scope),
      userAgent: cleanString(input.userAgent),
    },
  });

  try {
    await store.put(item, { condition: 'attribute_not_exists' });
    return true;
  } catch (error: any) {
    if (error?.code === 'ConditionalCheckFailedException' || isTransactionConditionFailure(error)) return false;
    throw error;
  }
}

function eventItem(input: EventItemInput): DynamoAttributeMap {
  const dimensions = sanitizeDimensions(input.dimensions);
  return {
    loopId: EMMA_MCP_LOOP_ID,
    tsSession: input.tsSession,
    eventType: input.eventType,
    subjectId: input.subjectId,
    ts: input.ts,
    ...(Object.keys(dimensions).length > 0 ? { dimensions } : {}),
  };
}

function sanitizeDimensions(raw: Record<string, unknown>): Record<string, DynamoAttributeValue> {
  const out: Record<string, DynamoAttributeValue> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string' && value.trim() !== '') out[key] = value.slice(0, 500);
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
    if (typeof value === 'boolean' || value === null) out[key] = value;
  }
  return out;
}

interface ParsedMcpEvent {
  eventType: string;
  subjectId: string;
  ts: Date;
  tsIso: string;
  dimensions: Record<string, string>;
}

function parseEventRow(item: DynamoAttributeMap): ParsedMcpEvent | null {
  const eventType = cleanString(item.eventType);
  const subjectId = cleanString(item.subjectId);
  const tsIso = cleanString(item.ts);
  if (!eventType || !subjectId || !tsIso) return null;
  const ts = new Date(tsIso);
  if (Number.isNaN(ts.getTime())) return null;

  const dimensions: Record<string, string> = {};
  const rawDimensions = item.dimensions;
  if (rawDimensions && typeof rawDimensions === 'object' && !Array.isArray(rawDimensions)) {
    for (const [key, value] of Object.entries(rawDimensions as Record<string, DynamoAttributeValue>)) {
      if (typeof value === 'string' && value) dimensions[key] = value;
    }
  }

  return { eventType, subjectId, ts, tsIso, dimensions };
}

interface UserAccumulator {
  userId: string;
  oauthAuthorizedAt?: string;
  tokenIssuedAt?: string;
  connectionAttempts: number;
  toolCalls: number;
  firstConnectedAt?: string;
  lastConnectedAt?: string;
  lastUsedAt?: string;
  lastToolName?: string;
  firstUsedAt?: string;
  firstToolName?: string;
  authMethods: Set<string>;
  apiKeyIds: Set<string>;
  clientIds: Set<string>;
  clientNames: Set<string>;
  clientTypes: Set<McpClientType>;
}

function getAccumulator(map: Map<string, UserAccumulator>, userId: string): UserAccumulator {
  let acc = map.get(userId);
  if (!acc) {
    acc = {
      userId,
      connectionAttempts: 0,
      toolCalls: 0,
      authMethods: new Set(),
      apiKeyIds: new Set(),
      clientIds: new Set(),
      clientNames: new Set(),
      clientTypes: new Set(),
    };
    map.set(userId, acc);
  }
  return acc;
}

interface ClientAccumulator {
  clientType: McpClientType;
  oauthStarts: number;
  connectionAttempts: number;
  toolCalls: number;
  authorizedUserIds: Set<string>;
  tokenIssuedUserIds: Set<string>;
  connectedUserIds: Set<string>;
  firstUseUserIds: Set<string>;
  clientNames: Set<string>;
}

function getClientAccumulator(map: Map<McpClientType, ClientAccumulator>, clientType: McpClientType): ClientAccumulator {
  let acc = map.get(clientType);
  if (!acc) {
    acc = {
      clientType,
      oauthStarts: 0,
      connectionAttempts: 0,
      toolCalls: 0,
      authorizedUserIds: new Set(),
      tokenIssuedUserIds: new Set(),
      connectedUserIds: new Set(),
      firstUseUserIds: new Set(),
      clientNames: new Set(),
    };
    map.set(clientType, acc);
  }
  return acc;
}

function addString(set: Set<string>, value?: string) {
  if (value) set.add(value);
}

function minIso(current: string | undefined, candidate: string): string {
  return !current || candidate < current ? candidate : current;
}

function maxIso(current: string | undefined, candidate: string): string {
  return !current || candidate > current ? candidate : current;
}

function cleanString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

const MCP_CLIENT_TYPES = new Set<McpClientType>([
  'claude_ai',
  'claude_code',
  'codex',
  'chatgpt',
  'hermes',
  'openclaw',
  'databricks',
  'api_key',
  'unknown',
]);

function cleanClientType(value: unknown): McpClientType | undefined {
  if (typeof value !== 'string') return undefined;
  return MCP_CLIENT_TYPES.has(value as McpClientType) ? (value as McpClientType) : undefined;
}

export function classifyMcpClient(input: {
  authMethod?: unknown;
  clientName?: unknown;
  userAgent?: unknown;
  redirectUri?: unknown;
}): McpClientType {
  const clientName = cleanString(input.clientName)?.toLowerCase() ?? '';
  const userAgent = cleanString(input.userAgent)?.toLowerCase() ?? '';
  const redirectUri = cleanString(input.redirectUri)?.toLowerCase() ?? '';
  const haystack = `${clientName} ${userAgent} ${redirectUri}`;

  // ENG-2747: Databricks registers its OAuth client through DCR as "Databricks" with a redirect on a
  // Databricks host. Checked first (a Databricks agent may run any model, so a model name elsewhere
  // must not win), but never for aw_ key callers, which stay in the api_key bucket. The redirect
  // uses the same host test as the Zoma read-only gate, so analytics and access agree.
  if (
    input.authMethod !== 'api_key' &&
    (clientName === 'databricks' || (redirectUri !== '' && isDatabricksRedirectUri(redirectUri)))
  ) {
    return 'databricks';
  }

  if (haystack.includes('claude-code') || haystack.includes('claude code') || haystack.includes('claudecode')) {
    return 'claude_code';
  }
  if (haystack.includes('claude.ai') || haystack.includes('claude') || haystack.includes('anthropic')) {
    return 'claude_ai';
  }
  if (haystack.includes('codex')) return 'codex';
  if (haystack.includes('chatgpt') || haystack.includes('openai')) return 'chatgpt';
  if (haystack.includes('hermes')) return 'hermes';
  if (haystack.includes('openclaw')) return 'openclaw';
  if (input.authMethod === 'api_key') return 'api_key';
  return 'unknown';
}

async function defaultResolveUsers(userIds: string[]): Promise<Map<string, { email?: string; companyName?: string }>> {
  const result = new Map<string, { email?: string; companyName?: string }>();
  await Promise.all(
    userIds.map(async (userId) => {
      try {
        const user = await userDb.getUserById(userId);
        if (user) {
          result.set(userId, {
            ...(typeof user.email === 'string' ? { email: user.email } : {}),
            ...(typeof user.companyName === 'string' ? { companyName: user.companyName } : {}),
          });
        }
      } catch (error) {
        console.error('[mcpUsageEvents] failed to resolve user', userId, error);
      }
    }),
  );
  return result;
}
