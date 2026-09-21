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
import type { LoggerPort } from '../../core/ports';
import type { EventDimensions, NormalizedEvent } from '../../core/types';
import { asSubjectId } from '../../core/types';
import { eventToItem, LOOP_EVENTS_TABLE } from '../../core/sensors/eventTableEventSource';
import { classifyToolErrorClass } from '../../../utils/toolErrorClassifier';
import { classifyToolFailureType } from '../../../utils/toolFailureType';
import { AGENT_MODE_LOOP_ID } from './eventTypes';
import {
  EVT_CLAIM_CHECK_ERROR,
  EVT_DECISION,
  EVT_RUN_COMPLETED,
  EVT_RUN_FAILED,
  EVT_RUN_STARTED,
  EVT_RUN_VERDICT,
  EVT_TOOL_DEFERRED,
  EVT_TOOL_FAILED,
  EVT_TOOL_INVOKED,
  EVT_TOOL_PARTIAL_FAILURE,
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
  /** The finalize guard found the final message claiming a completed action the
   * tool ledger does not back, and the corrective turn did not resolve it
   * (ENG-143). User-facing degradation even with zero tool failures. */
  claimMismatch?: boolean;
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
  if (input.claimMismatch) reasons.push('claim_mismatch');

  return reasons.length > 0 ? { verdict: 'degraded', reasons } : { verdict: 'ok', reasons: [] };
}

/**
 * What a terminal run event (completed/failed) reports about the run.
 *
 * `llmModel`/`modelAtStart` are the ENG-1210 AC14 evidence dimensions: AC14 wants
 * unchanged-behaviour evidence for below-hard-cap calls, and since the runway
 * feature exists to move customers between models, that evidence is per-model run
 * outcomes accumulated over time. They are recorded on the verdict rather than
 * joined from `agent_run_started` for two reasons: that event carries the
 * REQUESTED model, taken before `resolveGenerationModel` maps legacy ids forward
 * and before any allow-list fallback (ENG-46); and a run that switches to a backup
 * model mid-flight ends under a different model than it began.
 *
 * Neither field feeds `computeRunVerdict`. The model is a dimension on the grade,
 * never an input to it — otherwise per-model outcome rates would be measuring
 * their own definition.
 */
export interface RunTerminalInfo {
  toolCalls?: number;
  failedToolCalls?: number;
  maxSameToolFailures?: number;
  sessionId?: string;
  claimMismatch?: boolean;
  /** The model in effect when the run ended — the one that actually produced this outcome. */
  llmModel?: string;
  /** The model the run began under, when a mid-run substitution moved it. */
  modelAtStart?: string;
}

export class AgentRunRecorder {
  /**
   * Monotonic write chain (ENG-102). Every emit is appended SYNCHRONOUSLY onto
   * this chain, so call-order == write-order for one recorder: a terminal run
   * record (runCompleted/runFailed) enqueued after the per-tool records can
   * never have its Dynamo put start before the tool puts complete. Without this,
   * the per-tool telemetry and the terminal record were independent detached
   * promises and the terminal put could (and did) land first, and unflushed
   * writes were silently lost when the worker process exited.
   */
  private writeChain: Promise<void> = Promise.resolve();

  /** Count of Dynamo write failures surfaced this process (ENG-102) — exposed so
   * callers/metrics can observe persistence failures instead of them being
   * console-only. */
  public writeFailures = 0;

  constructor(
    private readonly dynamo: DynamoPort,
    private readonly clock: ClockPort,
    private readonly tableName: string = LOOP_EVENTS_TABLE,
    private readonly logger?: LoggerPort,
  ) {}

  /**
   * Append a write segment onto the monotonic chain. Returns the segment so the
   * caller MAY await its own write, while the chain itself is kept alive with a
   * swallowing `.catch` so one failed write never breaks ordering for the next.
   */
  private enqueue(fn: () => Promise<void>): Promise<void> {
    const segment = this.writeChain.then(fn);
    this.writeChain = segment.catch(() => {});
    return segment;
  }

  /**
   * Resolve once every write enqueued so far has settled. Callers drain this
   * before worker/IPC teardown so no telemetry is lost on process exit — the
   * terminal run record's flush implies all per-tool records are durably written.
   */
  flush(): Promise<void> {
    return this.writeChain;
  }

  async runStarted(
    runId: string,
    /** `traceId` is the OTel bridge (ENG-141): the active trace id, so a run in
     * Dev-AW-LoopEvents can be joined to its Langfuse/Okareo trace by ID. */
    info: { llmModel?: string; sessionType?: string; userId?: string; sessionId?: string; traceId?: string } = {},
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

  /**
   * A tool call was DEFERRED — skipped without executing (ENG-103). Recorded as
   * its own event class (not toolInvoked/succeeded/failed) so deferred calls are
   * accounted separately from success and failure and never touch the
   * reliability ratio or the failure-cluster policy. Carries the tool name, a
   * reason/category, and the budget/defer context.
   */
  async toolDeferred(
    runId: string,
    info: {
      toolName: string;
      reason: string;
      iteration?: number;
      sessionId?: string;
      mediaAssetsProducedThisRun?: number;
      deadlineMs?: number;
    },
  ): Promise<void> {
    await this.emit(runId, EVT_TOOL_DEFERRED, cleanDims(info));
  }

  /**
   * A tool call SUCCEEDED but with a partial result — some sub-sections of its
   * output were unavailable (ENG-104). Recorded as its OWN event class, NOT as
   * toolFailed: the call did not error, so it must not enter the failure ratio or
   * the failure-cluster policy. It also is NOT toolDeferred (the call DID execute).
   * The unavailable sections are stored as a comma-joined string + a numeric count
   * so a section silently going dark is queryable in Dev-AW-LoopEvents.
   */
  async toolPartialFailure(
    runId: string,
    info: {
      toolName: string;
      unavailableSections: string[];
      iteration?: number;
      sessionId?: string;
    },
  ): Promise<void> {
    await this.emit(runId, EVT_TOOL_PARTIAL_FAILURE, cleanDims({
      toolName: info.toolName,
      unavailableSections: info.unavailableSections.join(','),
      unavailableCount: info.unavailableSections.length,
      iteration: info.iteration,
      sessionId: info.sessionId,
    }));
  }

  async runCompleted(
    runId: string,
    info: RunTerminalInfo = {},
  ): Promise<void> {
    // Enqueue BOTH the terminal record and its verdict SYNCHRONOUSLY (no await
    // between) so they are both on the write chain before this method yields —
    // otherwise a flush() captured right after a fire-and-forget runCompleted
    // could miss the not-yet-enqueued verdict (ENG-102). Order is still
    // completed → verdict because emit() enqueues in call order.
    const completed = this.emit(runId, EVT_RUN_COMPLETED, terminalDims(info));
    const verdict = this.emitVerdict(runId, false, info);
    await Promise.all([completed, verdict]);
  }

  async runFailed(
    runId: string,
    info: RunTerminalInfo & { error: unknown },
  ): Promise<void> {
    const failed = this.emit(runId, EVT_RUN_FAILED, {
      ...(info.toolCalls != null ? { toolCalls: info.toolCalls } : {}),
      ...(info.failedToolCalls != null ? { failedToolCalls: info.failedToolCalls } : {}),
      ...(info.sessionId ? { sessionId: info.sessionId } : {}),
      ...modelDimensions(info),
      errorClass: errorClassOf(info.error),
      errorMessage: errorMessageOf(info.error),
    });
    const verdict = this.emitVerdict(runId, true, info);
    await Promise.all([failed, verdict]);
  }

  /**
   * The finalize guard's claim check itself failed (judge/correction LLM call
   * errored, ENG-143). Emitted LOUDLY as its own event class: on judge failure
   * the guard delivers the chat unchanged, so this event is the only durable
   * trace that a truthfulness check was skipped for the run.
   */
  async claimCheckError(
    runId: string,
    info: { error: unknown; sessionId?: string },
  ): Promise<void> {
    await this.emit(runId, EVT_CLAIM_CHECK_ERROR, {
      ...(info.sessionId ? { sessionId: info.sessionId } : {}),
      errorClass: errorClassOf(info.error),
      errorMessage: errorMessageOf(info.error),
    });
  }

  /** Durable outcome verdict alongside the terminal event — the loop's sensor
   * reads these; the inspector's read-time flags are invisible to the policy. */
  private async emitVerdict(
    runId: string,
    failed: boolean,
    info: RunTerminalInfo,
  ): Promise<void> {
    // Note what is NOT passed: no model. The grade is a pure function of failure
    // counts, so per-model outcome rates read off these rows stay falsifiable.
    const { verdict, reasons } = computeRunVerdict({
      failed,
      toolCalls: info.toolCalls ?? 0,
      failedToolCalls: info.failedToolCalls ?? 0,
      maxSameToolFailures: info.maxSameToolFailures,
      claimMismatch: info.claimMismatch,
    });
    await this.emit(runId, EVT_RUN_VERDICT, {
      verdict,
      reasons: reasons.join(','),
      toolCalls: info.toolCalls ?? 0,
      failedToolCalls: info.failedToolCalls ?? 0,
      ...(info.maxSameToolFailures != null ? { maxSameToolFailures: info.maxSameToolFailures } : {}),
      ...(info.sessionId ? { sessionId: info.sessionId } : {}),
      ...modelDimensions(info),
    });
  }

  /** Build + put one event row through the serialized write chain. Swallows its
   * own write errors — telemetry must never break the caller's hot path — but
   * surfaces them as a structured logger signal + writeFailures counter rather
   * than console-only (ENG-102). The timestamp is captured synchronously at
   * enqueue time so the event's ts reflects when it happened, not when written. */
  private emit(runId: string, eventType: string, dimensions: EventDimensions): Promise<void> {
    const ts = this.clock.now();
    return this.enqueue(async () => {
      recorderSeq++;
      const event: NormalizedEvent = {
        subjectId: asSubjectId(runId),
        eventType,
        ts,
        dimensions,
      };
      const item = eventToItem(AGENT_MODE_LOOP_ID, event);
      // Disambiguate same-session same-type events fired within the same ms
      // (eventToItem keys on ts#subject#type) by appending a monotonic counter.
      const disambiguated = {
        ...item,
        tsSession: `${item.tsSession as string}#${recorderSeq}`,
      };
      try {
        await this.dynamo.putItem(this.tableName, disambiguated);
      } catch (err) {
        this.writeFailures++;
        if (this.logger) {
          this.logger.log('error', 'agent_recorder_write_failed', {
            eventType,
            runId,
            errorClass: classifyToolErrorClass(err),
          });
        } else {
          console.error('[agent-mode-recorder] failed to record event (swallowed):', eventType, err);
        }
      }
    });
  }
}

/**
 * The AC14 model dimensions for one verdict row.
 *
 * Keyed off the END-of-run model: that is the one that produced the outcome being
 * graded. A substitution is recorded as its own flag rather than by simply
 * overwriting, because a run that fell back to a backup model is not evidence
 * about that backup — the fallback path is disproportionately degraded, so
 * folding those runs in silently would bias per-model rates against exactly the
 * cheaper models the runway feature recommends. Flagged, they can be excluded.
 *
 * Nothing is emitted without an end model: `modelAtStart` alone would read as
 * "the model this run ran under", which in that case is unknown.
 */
function modelDimensions(info: RunTerminalInfo): Record<string, string | boolean> {
  if (!info.llmModel) return {};
  const substituted = Boolean(info.modelAtStart && info.modelAtStart !== info.llmModel);
  return {
    llmModel: info.llmModel,
    ...(substituted ? { modelAtStart: info.modelAtStart as string, modelSubstituted: true } : {}),
  };
}

/**
 * Dimensions for a terminal run event. The model fields go through
 * `modelDimensions` rather than the raw spread so `modelAtStart` means the same
 * thing on the terminal event as on the verdict — present only when the run
 * actually changed model. Two events disagreeing on what one attribute name means
 * is how an analysis quietly draws the wrong conclusion.
 */
function terminalDims(info: RunTerminalInfo): EventDimensions {
  const { llmModel, modelAtStart, ...rest } = info;
  return { ...cleanDims(rest), ...modelDimensions({ llmModel, modelAtStart }) };
}

function cleanDims(obj: object): EventDimensions {
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
