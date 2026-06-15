/**
 * Lander lifecycle sensor — Layer-1 events for the landing-page funnel.
 *
 * Why route-layer emission: the artifact lifecycle spans two channels (Emma
 * tools call the same /api/landing-pages/v0 routes via mcpFetch that the
 * portal UI calls directly), and agent-tool telemetry alone cannot see UI
 * actions — the 2026-06-12 funnel analysis came back blind (24 "created"
 * sessions, 0 visible publishes) for exactly that reason. Emitting once at the
 * shared route chokepoint makes the funnel read true for both channels.
 *
 * Same contract as the AgentRunRecorder: best-effort, errors swallowed —
 * telemetry must never break a live request.
 */

import AWS from 'aws-sdk';
import { asLoopId, asSubjectId } from '../loops/core/types';
import type { NormalizedEvent } from '../loops/core/types';
import { eventToItem, LOOP_EVENTS_TABLE } from '../loops/core/sensors/eventTableEventSource';

export const LANDER_LIFECYCLE_LOOP_ID = asLoopId('lander-lifecycle');

export type LanderLifecycleEvent =
  | 'created'          // /generate — a new lander came into existence (cold start)
  | 'deploy_retried'   // /generated/:id/deploy — retry after failed deploy
  | 'iterated'         // /generated/:id/iterate — v0 refinement round
  | 'edited'           // /generated/:id/github-edit — direct file edit
  | 'published'        // /generated/:id/publish — the commit point
  | 'publish_reverted';// /generated/:id/revert-publish

export interface LanderLifecycleInfo {
  pageId: string;
  /** 'agent' when the request came through the Emma MCP tools, 'ui' otherwise. */
  channel: 'agent' | 'ui';
  userId?: string;
  /** cold_start = net-new generation; incremental = changes to an existing lander. */
  mode?: 'cold_start' | 'incremental';
  outcome?: 'ok' | 'failed';
  sessionId?: string;
}

let dynamo: AWS.DynamoDB.DocumentClient | null = null;
function getDynamo(): AWS.DynamoDB.DocumentClient {
  if (!dynamo) {
    dynamo = new AWS.DynamoDB.DocumentClient({ region: process.env.AWS_REGION || 'us-west-2' });
  }
  return dynamo;
}

/** Derive the request channel from the header mcpFetch attaches. */
export function landerChannelFromRequest(req: { headers: Record<string, unknown> }): 'agent' | 'ui' {
  return req.headers['x-agentweb-channel'] === 'agent' ? 'agent' : 'ui';
}

export async function emitLanderLifecycle(
  event: LanderLifecycleEvent,
  info: LanderLifecycleInfo,
): Promise<void> {
  try {
    const dimensions: Record<string, string> = { channel: info.channel };
    if (info.userId) dimensions.userId = info.userId;
    if (info.mode) dimensions.mode = info.mode;
    if (info.outcome) dimensions.outcome = info.outcome;
    if (info.sessionId) dimensions.sessionId = info.sessionId;

    const normalized: NormalizedEvent = {
      eventType: `lander_${event}`,
      subjectId: asSubjectId(info.pageId),
      ts: new Date(),
      dimensions,
    } as NormalizedEvent;

    const item = eventToItem(LANDER_LIFECYCLE_LOOP_ID, normalized);
    await getDynamo().put({ TableName: LOOP_EVENTS_TABLE, Item: item }).promise();
  } catch (err) {
    console.warn('[lander-lifecycle] event write failed (swallowed):', event, err instanceof Error ? err.message : err);
  }
}
