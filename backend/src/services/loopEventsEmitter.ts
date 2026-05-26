/**
 * loopEventsEmitter — backend-side helper for firing closed-loop events from
 * inside the agentweb backend (controllers, services, crons).
 *
 * The public POST /api/loop-events route handles anonymous frontend ingestion.
 * Backend-internal code (e.g. agent-mode session lifecycle hooks) uses this
 * helper directly to avoid a self-HTTP roundtrip and to access the idempotent
 * fire-once semantics for terminal events (eval_completed, eval_failed).
 *
 * Two firing modes:
 *
 *   - fireLoopEvent(loopId, event)
 *     Always inserts. Use for client-style anonymous events. The SK includes
 *     ts so duplicates at different timestamps coexist.
 *
 *   - fireLoopEventOnce(loopId, eventType, subjectId, dimensions?)
 *     Inserts at deterministic SK `<eventType>#<subjectId>`. Uses
 *     ConditionExpression attribute_not_exists so subsequent calls for the
 *     same (loopId, eventType, subjectId) are no-ops. Use for terminal
 *     events fired from the status-poll path that runs every 5s — without
 *     dedup, a single session would emit 60+ eval_completed events.
 *
 * All firings are best-effort: errors are logged but never thrown to the
 * caller. The agent-mode flow MUST NOT fail because the loop telemetry hit
 * a transient DDB blip.
 */

import AWS from 'aws-sdk';
import { LOOP_EVENTS_TABLE, eventToItem } from '../loops/core/sensors/eventTableEventSource';
import { getRegisteredLoopIds } from '../loops';
import type { LoopId, NormalizedEvent } from '../loops/core/types';
import { asLoopId } from '../loops/core/types';

const dynamodb = new AWS.DynamoDB.DocumentClient({
  region: process.env.AWS_REGION || 'us-west-2',
});

function loopIsRegistered(loopId: string): boolean {
  return (getRegisteredLoopIds() as readonly string[]).includes(loopId);
}

export async function fireLoopEvent(loopId: string, event: NormalizedEvent): Promise<void> {
  if (!loopIsRegistered(loopId)) {
    // Silent no-op when the loop hasn't been registered yet (e.g. during a
    // dev-server boot before app.ts has run registerAiEvalFunnel). Loop
    // events fired before the loop exists are not worth crashing for.
    return;
  }
  try {
    const item = eventToItem(asLoopId(loopId), event);
    await dynamodb.put({ TableName: LOOP_EVENTS_TABLE, Item: item }).promise();
  } catch (err) {
    console.error('[loopEvents] fire failed:', { loopId, eventType: event.eventType, error: String(err) });
  }
}

export async function fireLoopEventOnce(
  loopId: string,
  eventType: string,
  subjectId: string,
  dimensions?: Record<string, string | number | boolean | null>,
): Promise<{ fired: boolean }> {
  if (!loopIsRegistered(loopId)) return { fired: false };

  const tsSession = `${eventType}#${subjectId}`;
  const ts = new Date().toISOString();
  const item: Record<string, unknown> = {
    loopId,
    tsSession,
    eventType,
    subjectId,
    ts,
  };
  if (dimensions) item.dimensions = dimensions;

  try {
    await dynamodb
      .put({
        TableName: LOOP_EVENTS_TABLE,
        Item: item,
        ConditionExpression: 'attribute_not_exists(tsSession)',
      })
      .promise();
    return { fired: true };
  } catch (err) {
    const e = err as { code?: string; name?: string; message?: string };
    if (e.code === 'ConditionalCheckFailedException' || e.name === 'ConditionalCheckFailedException') {
      // Already fired — exactly what we want.
      return { fired: false };
    }
    console.error('[loopEvents] fire-once failed:', { loopId, eventType, subjectId, error: String(err) });
    return { fired: false };
  }
}

// Convenience helpers for the ai-eval-funnel instance ----------------------

export const AI_EVAL_LOOP_ID: LoopId = asLoopId('ai-eval-funnel');

export async function fireEvalStarted(sessionId: string): Promise<void> {
  await fireLoopEventOnce(AI_EVAL_LOOP_ID, 'eval_started', sessionId);
}

export async function fireEvalCompleted(sessionId: string, reportUrl?: string): Promise<void> {
  await fireLoopEventOnce(AI_EVAL_LOOP_ID, 'eval_completed', sessionId, reportUrl ? { reportUrl } : undefined);
}

export async function fireEvalFailed(sessionId: string, errorMessage: string): Promise<void> {
  await fireLoopEventOnce(AI_EVAL_LOOP_ID, 'eval_failed', sessionId, { errorMessage });
}
