/**
 * Admin AgentRun inspector.
 *
 * Read-only view over the AgentMode runtime spine rows in Dev-AW-LoopEvents.
 * This turns the flight recorder into something operators can query without
 * manually spelunking DynamoDB.
 */

import express, { Request, Response } from 'express';
import AWS from 'aws-sdk';
import { AGENT_MODE_LOOP_ID } from '../loops/instances/agent-mode/eventTypes';
import { LOOP_EVENTS_TABLE } from '../loops/core/sensors/eventTableEventSource';
import {
  AgentRunChatContext,
  AgentRunChatMessageRow,
  AgentRunChatSessionRow,
  buildAgentRunChatContext,
  buildAgentRunSummaries,
  AgentRunEventRow,
} from '../services/agentRunInspectorService';

const router = express.Router();

const dynamodb = new AWS.DynamoDB.DocumentClient({
  region: process.env.AWS_REGION || 'us-west-2',
});

const TABLE_PREFIX = process.env.NODE_ENV === 'development' ? 'Dev-' : '';
const CHAT_SESSIONS_TABLE = `${TABLE_PREFIX}AW-ChatSessions`;
const CHAT_MESSAGES_TABLE = `${TABLE_PREFIX}AW-ChatMessages`;
// `limit` counts RUNS returned, not events scanned. A single chatty run emits
// hundreds of spine events, so an event-based window only ever shows the
// newest run or two and makes every older sessionId filter come back empty.
const DEFAULT_RUN_LIMIT = 50;
const MAX_RUN_LIMIT = 500;
const PAGE_EVENT_LIMIT = 1000;
const MAX_SCANNED_EVENTS = 20000;
const FIRST_MESSAGE_LIMIT = 25;
const LATEST_MESSAGE_LIMIT = 60;

router.get('/', async (req: Request, res: Response) => {
  try {
    const limit = parseLimit(req.query.limit);
    const runId = parseOptionalString(req.query.runId);
    const sessionId = parseOptionalString(req.query.sessionId);
    const userId = parseOptionalString(req.query.userId);

    const matchesFilters = (run: { runId: string; sessionId?: string; userId?: string }) =>
      (!runId || run.runId === runId)
      && (!sessionId || run.sessionId === sessionId)
      && (!userId || run.userId === userId);

    const rows: AgentRunEventRow[] = [];
    let runs: ReturnType<typeof buildAgentRunSummaries> = [];
    let lastKey: AWS.DynamoDB.DocumentClient.Key | undefined;
    let scannedEvents = 0;
    let truncated = false;

    do {
      const result = await dynamodb.query({
        TableName: LOOP_EVENTS_TABLE,
        KeyConditionExpression: 'loopId = :loopId',
        ExpressionAttributeValues: {
          ':loopId': AGENT_MODE_LOOP_ID,
          ...(runId ? { ':runId': runId } : {}),
        },
        ...(runId ? { FilterExpression: 'subjectId = :runId' } : {}),
        ScanIndexForward: false,
        Limit: PAGE_EVENT_LIMIT,
        ExclusiveStartKey: lastKey,
      }).promise();

      const items = (result.Items ?? []) as AgentRunEventRow[];
      scannedEvents += result.ScannedCount ?? items.length;
      rows.push(...items.filter((row) => row.eventType && row.subjectId && row.ts));
      lastKey = result.LastEvaluatedKey;

      runs = buildAgentRunSummaries(rows).filter(matchesFilters);

      // Collect one run beyond the limit: the oldest collected run may still be
      // missing events on the next page, and the slice below drops it anyway.
      if (lastKey && runs.length > limit) break;
      if (lastKey && scannedEvents >= MAX_SCANNED_EVENTS) {
        truncated = true;
        break;
      }
    } while (lastKey);

    const limitedRuns = runs.slice(0, limit);
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

function isPresent<T>(value: T | null | undefined): value is T {
  return value != null;
}

export default router;
