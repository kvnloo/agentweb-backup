/**
 * Versioned, framework-neutral stream parts for an AgentMode run.
 *
 * The monolith still has a legacy progress callback.  RunEmitter keeps that
 * callback as an adapter boundary while callers migrate one emission site at
 * a time; the wire contract itself is typed and sequenceable.
 */

export type FinishReason = 'stop' | 'length' | 'content-filter' | 'error' | 'cancelled';

export type StreamPart =
  | { type: 'text-delta'; text: string }
  | { type: 'tool-input-available'; toolCallId: string; toolName: string; input: unknown }
  | { type: 'tool-output-available'; toolCallId: string; output: unknown }
  | { type: 'tool-approval-request'; toolCallId: string; toolName: string; input: unknown }
  | { type: 'finish'; reason: FinishReason };

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
