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
import { buildAgentRunSummaries, AgentRunEventRow } from '../services/agentRunInspectorService';

const router = express.Router();

const dynamodb = new AWS.DynamoDB.DocumentClient({
  region: process.env.AWS_REGION || 'us-west-2',
});

const DEFAULT_LIMIT = 120;
const MAX_LIMIT = 500;

router.get('/', async (req: Request, res: Response) => {
  try {
    const limit = parseLimit(req.query.limit);
    const runId = parseOptionalString(req.query.runId);
    const sessionId = parseOptionalString(req.query.sessionId);
    const userId = parseOptionalString(req.query.userId);

    const result = await dynamodb.query({
      TableName: LOOP_EVENTS_TABLE,
      KeyConditionExpression: 'loopId = :loopId',
      ExpressionAttributeValues: { ':loopId': AGENT_MODE_LOOP_ID },
      ScanIndexForward: false,
      Limit: limit,
    }).promise();

    const rows = ((result.Items ?? []) as AgentRunEventRow[])
      .filter((row) => row.eventType && row.subjectId && row.ts)
      .filter((row) => !runId || row.subjectId === runId);

    const runs = buildAgentRunSummaries(rows)
      .filter((run) => !sessionId || run.sessionId === sessionId)
      .filter((run) => !userId || run.userId === userId);
    return res.status(200).json({
      runs,
      count: runs.length,
      scannedEvents: result.Items?.length ?? 0,
      filters: { runId, sessionId, userId, limit },
    });
  } catch (err) {
    console.error('[agentRuns] failed to inspect AgentRuns:', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

function parseLimit(raw: unknown): number {
  const value = Array.isArray(raw) ? raw[0] : raw;
  const n = typeof value === 'string' ? Number(value) : DEFAULT_LIMIT;
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(n), MAX_LIMIT);
}

function parseOptionalString(raw: unknown): string | undefined {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

export default router;
