/**
 * AgentRunRecorder — the bridge from AgentMode's hot path into the shared
 * Dev-AW-LoopEvents table (Layer-1 writer for the agent-mode loop).
 *
 * Each method maps one lifecycle point to one NormalizedEvent, keyed by
 * subjectId = runId so all events for one response attempt form a single run
 * timeline (the AgentRun / AgentRunEvent debugging timeline Rui named). Include
 * sessionId in dimensions when the caller wants to join a run back to a chat:
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
import { classifyToolErrorClass } from '../../../utils/toolErrorClassifier';
import { classifyToolFailureType } from '../../../utils/toolFailureType';
import { AGENT_MODE_LOOP_ID } from './eventTypes';
import {
  EVT_DECISION,
  EVT_RUN_COMPLETED,
  EVT_RUN_FAILED,
  EVT_RUN_STARTED,
  EVT_RUN_VERDICT,
  EVT_TOOL_FAILED,
  EVT_TOOL_INVOKED,
  EVT_TOOL_SUCCEEDED,
} from './eventTypes';

let recorderSeq = 0;

export type RunOutcomeVerdict = 'ok' | 'degraded' | 'failed';

export interface RunVerdictInput {
  failed: boolean;
  toolCalls: number;
  failedToolCalls: number;
  /** Highest per-tool failure count in the run — catches retry spirals that a
   * low overall ratio hides (e.g. one tool retried 15× in a 100-call run). */
  maxSameToolFailures?: number;
}

/**
 * Deterministic post-run verdict. June 12 telemetry: 165 runs, 0 hard
 * failures, 60+ tool failures absorbed — "completed" ≠ "succeeded". Thresholds
 * tuned against that window: 1-2 sporadic failures in a busy run are normal
 * (ok); 3+ failures, a third of calls failing, or one tool failing repeatedly
 * are user-visible degradation.
 */
export function computeRunVerdict(input: RunVerdictInput): {
  verdict: RunOutcomeVerdict;
  reasons: string[];
} {
  if (input.failed) return { verdict: 'failed', reasons: ['run_failed'] };

  const reasons: string[] = [];
  if (input.failedToolCalls >= 3) reasons.push('failed_tool_calls');
  if (input.toolCalls > 0 && input.failedToolCalls / input.toolCalls >= 1 / 3) {
    reasons.push('high_failure_ratio');
  }
  if ((input.maxSameToolFailures ?? 0) >= 3) reasons.push('repeated_tool_failures');

  return reasons.length > 0 ? { verdict: 'degraded', reasons } : { verdict: 'ok', reasons: [] };
}

export class AgentRunRecorder {
  constructor(
    private readonly dynamo: DynamoPort,
    private readonly clock: ClockPort,
    private readonly tableName: string = LOOP_EVENTS_TABLE,
  ) {}

  async runStarted(
    runId: string,
    info: { llmModel?: string; sessionType?: string; userId?: string; sessionId?: string } = {},
  ): Promise<void> {
    await this.emit(runId, EVT_RUN_STARTED, cleanDims(info));
  }

  async decision(
    runId: string,
    info: {
      iteration: number;
      toolNames: readonly string[];
      sessionId?: string;
      toolArgKeys?: string;
      toolArgsPreview?: string;
      decisionExplanation?: string;
      explanationSource?: string;
      toolPolicyFlags?: string;
      toolPolicySummary?: string;
      /** Tools whose args the contract layer repaired before execution. */
      argsRepairedCount?: number;
      /** Failed tools classified as invalid_args (model emitted bad args). */
      schemaErrorCount?: number;
    },
  ): Promise<void> {
    await this.emit(runId, EVT_DECISION, {
      iteration: info.iteration,
      toolNames: info.toolNames.join(','),
      toolCount: info.toolNames.length,
      ...(info.sessionId ? { sessionId: info.sessionId } : {}),
      ...(info.toolArgKeys ? { toolArgKeys: info.toolArgKeys } : {}),
      ...(info.toolArgsPreview ? { toolArgsPreview: info.toolArgsPreview } : {}),
      ...(info.decisionExplanation ? { decisionExplanation: info.decisionExplanation } : {}),
      ...(info.explanationSource ? { explanationSource: info.explanationSource } : {}),
      ...(info.toolPolicyFlags ? { toolPolicyFlags: info.toolPolicyFlags } : {}),
      ...(info.toolPolicySummary ? { toolPolicySummary: info.toolPolicySummary } : {}),
      ...(info.argsRepairedCount != null ? { argsRepairedCount: info.argsRepairedCount } : {}),
      ...(info.schemaErrorCount != null ? { schemaErrorCount: info.schemaErrorCount } : {}),
    });
  }

  async toolInvoked(
    runId: string,
    info: { toolName: string; iteration?: number; sessionId?: string },
  ): Promise<void> {
    await this.emit(runId, EVT_TOOL_INVOKED, cleanDims(info));
  }

  async toolSucceeded(
    runId: string,
    info: { toolName: string; durationMs?: number; sessionId?: string },
  ): Promise<void> {
    await this.emit(runId, EVT_TOOL_SUCCEEDED, cleanDims(info));
  }

  async toolFailed(
    runId: string,
    info: { toolName: string; error: unknown; durationMs?: number; sessionId?: string; args?: unknown },
  ): Promise<void> {
    const failedArgsJson = serializeFailedArgs(info.args);
    const errorClass = errorClassOf(info.error);
    const errorMessage = errorMessageOf(info.error);
    await this.emit(runId, EVT_TOOL_FAILED, {
      toolName: info.toolName,
      ...(info.durationMs != null ? { durationMs: info.durationMs } : {}),
      ...(info.sessionId ? { sessionId: info.sessionId } : {}),
      errorClass,
      errorMessage,
      // Decision-layer tag so the scorecard can separate real bugs from
      // by-design rejections / uninstalled-tool calls / config issues.
      failureType: classifyToolFailureType(errorClass, errorMessage),
      ...(failedArgsJson ? { failedArgsJson } : {}),
    });
  }

  async runCompleted(
    runId: string,
    info: { toolCalls?: number; failedToolCalls?: number; maxSameToolFailures?: number; sessionId?: string } = {},
  ): Promise<void> {
    await this.emit(runId, EVT_RUN_COMPLETED, cleanDims(info));
    await this.emitVerdict(runId, false, info);
  }

  async runFailed(
    runId: string,
    info: { error: unknown; toolCalls?: number; failedToolCalls?: number; maxSameToolFailures?: number; sessionId?: string },
  ): Promise<void> {
    await this.emit(runId, EVT_RUN_FAILED, {
      ...(info.toolCalls != null ? { toolCalls: info.toolCalls } : {}),
      ...(info.failedToolCalls != null ? { failedToolCalls: info.failedToolCalls } : {}),
      ...(info.sessionId ? { sessionId: info.sessionId } : {}),
      errorClass: errorClassOf(info.error),
      errorMessage: errorMessageOf(info.error),
    });
    await this.emitVerdict(runId, true, info);
  }

  /** Durable outcome verdict alongside the terminal event — the loop's sensor
   * reads these; the inspector's read-time flags are invisible to the policy. */
  private async emitVerdict(
    runId: string,
    failed: boolean,
    info: { toolCalls?: number; failedToolCalls?: number; maxSameToolFailures?: number; sessionId?: string },
  ): Promise<void> {
    const { verdict, reasons } = computeRunVerdict({
      failed,
      toolCalls: info.toolCalls ?? 0,
      failedToolCalls: info.failedToolCalls ?? 0,
      maxSameToolFailures: info.maxSameToolFailures,
    });
    await this.emit(runId, EVT_RUN_VERDICT, {
      verdict,
      reasons: reasons.join(','),
      toolCalls: info.toolCalls ?? 0,
      failedToolCalls: info.failedToolCalls ?? 0,
      ...(info.maxSameToolFailures != null ? { maxSameToolFailures: info.maxSameToolFailures } : {}),
      ...(info.sessionId ? { sessionId: info.sessionId } : {}),
    });
  }

  /** Build + put one event row. Swallows errors — telemetry must never break
   * the caller's hot path. */
  private async emit(runId: string, eventType: string, dimensions: EventDimensions): Promise<void> {
    try {
      recorderSeq++;
      const event: NormalizedEvent = {
        subjectId: asSubjectId(runId),
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
  // Semantic taxonomy (timeout/auth/rate_limit/…) with the old name-based
  // class as fallback — most tools throw plain Error, which carried no signal.
  return classifyToolErrorClass(error);
}

function errorMessageOf(error: unknown): string {
  const msg = error instanceof Error ? error.message : String(error);
  return msg.slice(0, 300);
}

/**
 * Serialize a failing call's arguments for root-cause investigation.
 * Failed calls only — successes never store full args (size + privacy).
 * Secret-like keys are redacted at any nesting depth; output is capped so a
 * single chatty payload can't bloat the event row. Returns undefined when
 * args are absent or unserializable (telemetry must never throw).
 */
const FAILED_ARGS_MAX_CHARS = 4096;
const SECRET_KEY_PATTERN = /token|secret|password|api[_-]?key|authorization|credential|private[_-]?key/i;

function serializeFailedArgs(args: unknown): string | undefined {
  if (args == null) return undefined;
  try {
    const json = JSON.stringify(args, (key, value) =>
      key && SECRET_KEY_PATTERN.test(key) ? '[redacted]' : value,
    );
    if (!json) return undefined;
    if (json.length <= FAILED_ARGS_MAX_CHARS) return json;
    return json.slice(0, FAILED_ARGS_MAX_CHARS - 12) + '…[truncated]';
  } catch {
    return undefined;
  }
}
