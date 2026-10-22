/**
 * Admin AgentRun inspector.
 *
 * Read-only view over the AgentMode runtime spine rows in Dev-AW-LoopEvents.
 * This turns the flight recorder into something operators can query without
 * manually spelunking DynamoDB.
 */

import express, { Request, Response } from 'express';
import AWS from 'aws-sdk';
import {
  AgentRunChatContext,
  AgentRunChatMessageRow,
  AgentRunChatSessionRow,
  buildAgentRunChatContext,
  fetchAgentRunSummaries,
} from '../services/agentRunInspectorService';
import { ASK_LOOKBACK_MS, buildAgentRunTrace, type TraceMessageRow, type TraceSessionRow } from '../services/agentRunTrace';
import { TABLE_PREFIX } from '../config/constants';

const router = express.Router();

const dynamodb = new AWS.DynamoDB.DocumentClient({
  region: process.env.AWS_REGION || 'us-west-2',
});

const CHAT_SESSIONS_TABLE = `${TABLE_PREFIX}AW-ChatSessions`;
const CHAT_MESSAGES_TABLE = `${TABLE_PREFIX}AW-ChatMessages`;
// `limit` counts RUNS returned, not events scanned. A single chatty run emits
// hundreds of spine events, so an event-based window only ever shows the
// newest run or two and makes every older sessionId filter come back empty.
const DEFAULT_RUN_LIMIT = 50;
const MAX_RUN_LIMIT = 500;
const FIRST_MESSAGE_LIMIT = 25;
const LATEST_MESSAGE_LIMIT = 60;
const TRACE_MESSAGE_PAGE = 200;
const TRACE_MAX_MESSAGES = 1000;
/** Read back a minute past the ask lookback, so the run's own ask is always fetched. */
const TRACE_READ_BACK_MS = ASK_LOOKBACK_MS + 60_000;

router.get('/', async (req: Request, res: Response) => {
  try {
    const limit = parseLimit(req.query.limit);
    const runId = parseOptionalString(req.query.runId);
    const sessionId = parseOptionalString(req.query.sessionId);
    const userId = parseOptionalString(req.query.userId);

    const { runs: limitedRuns, scannedEvents, truncated } = await fetchAgentRunSummaries({
      runId,
      sessionId,
      userId,
      limit,
    });

    const chatContexts = await fetchChatContexts([...new Set(limitedRuns.map((run) => run.sessionId).filter(isPresent))]);
    const enrichedRuns = limitedRuns.map((run) => ({
      ...run,
      chat: run.sessionId ? chatContexts.get(run.sessionId) : undefined,
    }));

    return res.status(200).json({
      runs: enrichedRuns,
      count: enrichedRuns.length,
      scannedEvents,
      truncated,
      filters: { runId, sessionId, userId, limit },
    });
  } catch (err) {
    console.error('[agentRuns] failed to inspect AgentRuns:', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

/**
 * One run's step-by-step trace (services/agentRunTrace.ts): work-plan steps, every tool call with
 * redacted arguments and a capped result, and the final reply. `startedAt`/`completedAt` (from the
 * list response) scope a multi-run session to this run; `nextStartedAt`, the session's next run,
 * bounds a run with no completion. Admin JWT only: the agent-runs secret is limited to the list
 * (middleware/agentRunsAuth.ts).
 */
router.get('/trace', async (req: Request, res: Response) => {
  const sessionId = parseOptionalString(req.query.sessionId);
  if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });
  const startedAt = parseOptionalIso(req.query.startedAt);
  const completedAt = parseOptionalIso(req.query.completedAt);
  const nextStartedAt = parseOptionalIso(req.query.nextStartedAt);
  try {
    const [session, { messages, truncated }] = await Promise.all([
      fetchChatSession(sessionId) as Promise<TraceSessionRow | null>,
      fetchRunMessages(sessionId, startedAt),
    ]);
    const trace = buildAgentRunTrace({ sessionId, session, messages, startedAt, completedAt, nextStartedAt });
    return res.status(200).json({ trace: { ...trace, messagesTruncated: truncated } });
  } catch (err) {
    console.error('[agentRuns] failed to build AgentRun trace:', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

function parseLimit(raw: unknown): number {
  const value = Array.isArray(raw) ? raw[0] : raw;
  const n = typeof value === 'string' ? Number(value) : DEFAULT_RUN_LIMIT;
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_RUN_LIMIT;
  return Math.min(Math.floor(n), MAX_RUN_LIMIT);
}

function parseOptionalString(raw: unknown): string | undefined {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

async function fetchChatContexts(sessionIds: string[]): Promise<Map<string, AgentRunChatContext>> {
  const entries = await Promise.all(sessionIds.map(async (sessionId) => {
    try {
      const [session, messages] = await Promise.all([
        fetchChatSession(sessionId),
        fetchChatMessages(sessionId),
      ]);

      return [
        sessionId,
        buildAgentRunChatContext({
          sessionId,
          session,
          messages,
          customerPortalBaseUrl: process.env.CUSTOMER_FRONTEND_URL || 'http://localhost:5174',
        }),
      ] as const;
    } catch (err) {
      console.warn(`[agentRuns] failed to enrich chat context for session ${sessionId}:`, err);
      return [
        sessionId,
        buildAgentRunChatContext({
          sessionId,
          messages: [],
          customerPortalBaseUrl: process.env.CUSTOMER_FRONTEND_URL || 'http://localhost:5174',
        }),
      ] as const;
    }
  }));

  return new Map(entries);
}

async function fetchChatSession(sessionId: string): Promise<AgentRunChatSessionRow | null> {
  try {
    const result = await dynamodb.get({
      TableName: CHAT_SESSIONS_TABLE,
      Key: { sessionId },
    }).promise();
    return (result.Item as AgentRunChatSessionRow | undefined) ?? null;
  } catch (err: any) {
    if (err?.code === 'ResourceNotFoundException') return null;
    throw err;
  }
}

async function fetchChatMessages(sessionId: string): Promise<AgentRunChatMessageRow[]> {
  try {
    const [firstMessages, latestMessages] = await Promise.all([
      queryChatMessages(sessionId, true, FIRST_MESSAGE_LIMIT),
      queryChatMessages(sessionId, false, LATEST_MESSAGE_LIMIT),
    ]);
    const byIndex = new Map<string, AgentRunChatMessageRow>();
    for (const message of [...firstMessages, ...latestMessages]) {
      byIndex.set(String(message.messageIndex ?? byIndex.size), message);
    }
    return [...byIndex.values()].sort((a, b) => (a.messageIndex ?? 0) - (b.messageIndex ?? 0));
  } catch (err: any) {
    if (err?.code === 'ResourceNotFoundException') return [];
    throw err;
  }
}

async function queryChatMessages(
  sessionId: string,
  scanForward: boolean,
  limit: number
): Promise<AgentRunChatMessageRow[]> {
  const result = await dynamodb.query({
    TableName: CHAT_MESSAGES_TABLE,
    KeyConditionExpression: 'sessionId = :sessionId',
    ExpressionAttributeValues: {
      ':sessionId': sessionId,
    },
    ScanIndexForward: scanForward,
    Limit: limit,
  }).promise();
  return (result.Items ?? []) as AgentRunChatMessageRow[];
}

/**
 * The session's messages back to the run's start, oldest first. Read newest-first so the latest
 * run of a long session is always inside the TRACE_MAX_MESSAGES cap; without a start time the
 * newest TRACE_MAX_MESSAGES are returned. `truncated` means the cap cut the window short.
 */
async function fetchRunMessages(sessionId: string, startedAt?: string): Promise<{ messages: TraceMessageRow[]; truncated: boolean }> {
  const stopBefore = startedAt ? Date.parse(startedAt) - TRACE_READ_BACK_MS : NaN;
  const messages: TraceMessageRow[] = [];
  let lastKey: AWS.DynamoDB.DocumentClient.Key | undefined;
  let reachedStart = false;
  try {
    do {
      const result = await dynamodb.query({
        TableName: CHAT_MESSAGES_TABLE,
        KeyConditionExpression: 'sessionId = :sessionId',
        ExpressionAttributeValues: { ':sessionId': sessionId },
        ScanIndexForward: false,
        Limit: TRACE_MESSAGE_PAGE,
        ExclusiveStartKey: lastKey,
      }).promise();
      const page = (result.Items ?? []) as TraceMessageRow[];
      messages.push(...page);
      lastKey = result.LastEvaluatedKey;
      // Stop only once a whole page is older than the read-back point, so one stale timestamp inside
      // the run can't end the read early. Older rows keep their fields on the row itself.
      const stamps = page
        .map((row) => {
          const m = (row.message ?? row) as any;
          return Date.parse(String(m?.metadata?.timestamp ?? m?.timestamp ?? ''));
        })
        .filter((ts) => Number.isFinite(ts));
      reachedStart = Number.isFinite(stopBefore) && stamps.length > 0 && stamps.every((ts) => ts < stopBefore);
    } while (lastKey && !reachedStart && messages.length < TRACE_MAX_MESSAGES);
  } catch (err: any) {
    if (err?.code === 'ResourceNotFoundException') return { messages: [], truncated: false };
    throw err;
  }
  return {
    messages: messages.slice(0, TRACE_MAX_MESSAGES).reverse(),
    truncated: Boolean(lastKey) && !reachedStart && messages.length >= TRACE_MAX_MESSAGES,
  };
}

function parseOptionalIso(raw: unknown): string | undefined {
  const value = parseOptionalString(raw);
  return value && Number.isFinite(Date.parse(value)) ? value : undefined;
}

function isPresent<T>(value: T | null | undefined): value is T {
  return value != null;
}

export default router;
