/**
 * Versioned, framework-neutral stream parts for an AgentMode run.
 *
 * The monolith still has a legacy progress callback.  RunEmitter keeps that
 * callback as an adapter boundary while callers migrate one emission site at
 * a time; the wire contract itself is typed and sequenceable.
 */

export type FinishReason = 'stop' | 'length' | 'content-filter' | 'error' | 'cancelled';

/** Outcome of one attempt at a run. Mirrors the run telemetry lifecycle (agent_run_completed / agent_run_failed). */
export type AttemptOutcome = 'completed' | 'failed' | 'cancelled';

/*
 * ENG-2104 (F3) also names these parts, deliberately NOT in `StreamPart` yet because their
 * payload shapes would be guesses until an emitter and consumer exist: route-selected,
 * route-unavailable, funding-changed, usage-observed, approval-requested, checkpoint, paused.
 * Each needs one of:
 *  - an ambient emitter, so code outside a backend's own turn loop (`recordLlmUsage`, the
 *    approval deck) can reach the run's emitter: usage-observed, funding-changed,
 *    approval-requested;
 *  - a real decision to report: route-selected / route-unavailable (every run resolves
 *    route 'agentweb' today), paused (no pause mechanism exists);
 *  - a defined persistence point: checkpoint.
 * Add each to `StreamPart` together with its first emitter.
 */

export type StreamPart =
  | { type: 'text-delta'; text: string }
  | { type: 'tool-input-available'; toolCallId: string; toolName: string; input: unknown }
  | { type: 'tool-output-available'; toolCallId: string; output: unknown }
  | { type: 'tool-approval-request'; toolCallId: string; toolName: string; input: unknown }
  | { type: 'finish'; reason: FinishReason }
  /**
   * One attempt at the run ended. `toolCalls` is set for completed/cancelled and omitted for
   * failed (the loop's partial count is unavailable when it throws). Today an attempt is the whole run, so this fires once
   * per run (1:1 with `finish`). Whoever wires real retry / fallback (decideFallback,
   * Track A/B) must revisit this: it should then fire once per attempt, not per run.
   */
  | { type: 'attempt-finished'; outcome: AttemptOutcome; toolCalls?: number };

export interface RunEvent<P extends StreamPart = StreamPart> {
  v: 1;
  runId: string;
  seq: number;
  part: P;
}

export interface LegacyProgress {
  iteration: number;
  status: string;
  toolCalls?: any[];
  pendingTools?: string[];
  suggestions?: string[];
}

export type StreamSink = (event: RunEvent) => void;
export type LegacyProgressSink = (progress: LegacyProgress) => void;

/** Emits monotonically sequenced parts and preserves the existing callback adapter. */
export class RunEmitter {
  private nextSeq = 0;

  constructor(
    private readonly runId: string,
    private readonly sink: StreamSink,
    private readonly legacySink?: LegacyProgressSink,
  ) {}

  emit<P extends StreamPart>(part: P): RunEvent<P> {
    const event: RunEvent<P> = { v: 1, runId: this.runId, seq: this.nextSeq++, part };
    this.sink(event);
    return event;
  }

  /** Transitional adapter for an untouched legacy onProgress call site. */
  emitLegacy(progress: LegacyProgress): void {
    this.legacySink?.(progress);
  }
}

/**
 * Emit a part without ever letting a failure reach the caller. `RunEmitter.emit()`
 * deliberately throws when its sink throws (see streamEvents.test.ts), so any call made
 * from inside a live turn must go through this. Same best-effort idiom as
 * recordAgentModeDuplicateSuppression in agentModeService.ts.
 */
export function emitBestEffort(emitter: RunEmitter | undefined, part: StreamPart): void {
  if (!emitter) return;
  try {
    emitter.emit(part);
  } catch (err) {
    console.error('[agent-mode] run event emit failed (swallowed):', err instanceof Error ? err.message : String(err));
  }
}
