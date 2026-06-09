/**
 * AgentRunRecorder — the bridge from AgentMode's hot path into the shared
 * Dev-AW-LoopEvents table (Layer-1 writer for the agent-mode loop).
 *
 * Each method maps one lifecycle point to one NormalizedEvent, keyed by
 * subjectId = sessionId so all events for a chat turn form a single run
 * timeline (the AgentRun / AgentRunEvent debugging timeline Rui named):
 *
 *   runStarted    → agent_run_started        (run begins)
 *   decision      → agent_decision           (why Emma chose tools — AgentDecision)
 *   toolInvoked   → agent_tool_invoked        (reliability denominator)
 *   toolSucceeded → agent_tool_succeeded      (reliability numerator — AgentOutcome)
 *   toolFailed    → agent_tool_failed         (failure signal — AgentOutcome)
 *   runCompleted  → agent_run_completed
 *   runFailed     → agent_run_failed
 *
 * CRITICAL CONTRACT: recording is best-effort telemetry. Every method swallows
 * its own errors — a Dynamo hiccup must NEVER break a live chat turn. The hook
 * in agentModeService also calls these without awaiting on the critical path.
 *
 * Uses the same `eventToItem` row shape as the funnel sensor so the existing
 * EventTableEventSource reads agent-mode events with zero changes.
 */

import type { DynamoPort } from '../../core/ports';
import type { ClockPort } from '../../core/ports';
import type { EventDimensions, NormalizedEvent } from '../../core/types';
import { asSubjectId } from '../../core/types';
import { eventToItem, LOOP_EVENTS_TABLE } from '../../core/sensors/eventTableEventSource';
import { AGENT_MODE_LOOP_ID } from './eventTypes';
import {
  EVT_DECISION,
  EVT_RUN_COMPLETED,
  EVT_RUN_FAILED,
  EVT_RUN_STARTED,
  EVT_TOOL_FAILED,
  EVT_TOOL_INVOKED,
  EVT_TOOL_SUCCEEDED,
} from './eventTypes';

let recorderSeq = 0;

export class AgentRunRecorder {
  constructor(
    private readonly dynamo: DynamoPort,
    private readonly clock: ClockPort,
    private readonly tableName: string = LOOP_EVENTS_TABLE,
  ) {}

  async runStarted(
    sessionId: string,
    info: { llmModel?: string; sessionType?: string; userId?: string } = {},
  ): Promise<void> {
    await this.emit(sessionId, EVT_RUN_STARTED, cleanDims(info));
  }

  async decision(
    sessionId: string,
    info: { iteration: number; toolNames: readonly string[] },
  ): Promise<void> {
    await this.emit(sessionId, EVT_DECISION, {
      iteration: info.iteration,
      toolNames: info.toolNames.join(','),
      toolCount: info.toolNames.length,
    });
  }

  async toolInvoked(
    sessionId: string,
    info: { toolName: string; iteration?: number },
  ): Promise<void> {
    await this.emit(sessionId, EVT_TOOL_INVOKED, cleanDims(info));
  }

  async toolSucceeded(
    sessionId: string,
    info: { toolName: string; durationMs?: number },
  ): Promise<void> {
    await this.emit(sessionId, EVT_TOOL_SUCCEEDED, cleanDims(info));
  }

  async toolFailed(
    sessionId: string,
    info: { toolName: string; error: unknown; durationMs?: number },
  ): Promise<void> {
    await this.emit(sessionId, EVT_TOOL_FAILED, {
      toolName: info.toolName,
      ...(info.durationMs != null ? { durationMs: info.durationMs } : {}),
      errorClass: errorClassOf(info.error),
      errorMessage: errorMessageOf(info.error),
    });
  }

  async runCompleted(
    sessionId: string,
    info: { toolCalls?: number; failedToolCalls?: number } = {},
  ): Promise<void> {
    await this.emit(sessionId, EVT_RUN_COMPLETED, cleanDims(info));
  }

  async runFailed(
    sessionId: string,
    info: { error: unknown; toolCalls?: number; failedToolCalls?: number },
  ): Promise<void> {
    await this.emit(sessionId, EVT_RUN_FAILED, {
      ...(info.toolCalls != null ? { toolCalls: info.toolCalls } : {}),
      ...(info.failedToolCalls != null ? { failedToolCalls: info.failedToolCalls } : {}),
      errorClass: errorClassOf(info.error),
      errorMessage: errorMessageOf(info.error),
    });
  }

  /** Build + put one event row. Swallows errors — telemetry must never break
   * the caller's hot path. */
  private async emit(sessionId: string, eventType: string, dimensions: EventDimensions): Promise<void> {
    try {
      recorderSeq++;
      const event: NormalizedEvent = {
        subjectId: asSubjectId(sessionId),
        eventType,
        ts: this.clock.now(),
        dimensions,
      };
      const item = eventToItem(AGENT_MODE_LOOP_ID, event);
      // Disambiguate same-session same-type events fired within the same ms
      // (eventToItem keys on ts#subject#type) by appending a monotonic counter.
      const disambiguated = {
        ...item,
        tsSession: `${item.tsSession as string}#${recorderSeq}`,
      };
      await this.dynamo.putItem(this.tableName, disambiguated);
    } catch (err) {
      console.error('[agent-mode-recorder] failed to record event (swallowed):', eventType, err);
    }
  }
}

function cleanDims(obj: Record<string, unknown>): EventDimensions {
  const out: Record<string, string | number | boolean | null> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || v === null) {
      out[k] = v;
    }
  }
  return out;
}

function errorClassOf(error: unknown): string {
  if (error instanceof Error) {
    // Prefer an explicitly-set `.name` (e.g. AWS SDK errors set name to the
    // error code); otherwise fall back to the runtime constructor name, which
    // is what custom `class FooError extends Error {}` subclasses carry since
    // `.name` is inherited as the generic 'Error'.
    if (error.name && error.name !== 'Error') return error.name;
    return error.constructor?.name || 'Error';
  }
  if (typeof error === 'string') return 'StringError';
  return 'UnknownError';
}

function errorMessageOf(error: unknown): string {
  const msg = error instanceof Error ? error.message : String(error);
  return msg.slice(0, 300);
}
