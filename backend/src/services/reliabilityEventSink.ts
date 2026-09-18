/**
 * H-LEARN-1: append-only reliability event sink (fail-open).
 */

import {
  buildReliabilityEvent,
  validateReliabilityEvent,
  type ReliabilityEvent,
  type ReliabilityOutcome,
} from './reliabilityEvent';

export interface RecordReliabilityEventInput {
  tool: string;
  outcome: ReliabilityOutcome;
  latencyMs: number;
  sessionId?: string;
  userId?: string;
  userEdit?: boolean;
  errorSummary?: string;
  platform?: string;
}

export interface ReliabilityEventSink {
  record(input: RecordReliabilityEventInput): ReliabilityEvent | null;
  drain(): ReliabilityEvent[];
  size(): number;
  clear(): void;
}

const MAX_BUFFER = 512;

function parseSinkBackend(raw: string | undefined): 'memory' | 'off' {
  return (raw ?? 'memory').trim().toLowerCase() === 'off' ? 'off' : 'memory';
}

class MemoryReliabilityEventSink implements ReliabilityEventSink {
  private buffer: ReliabilityEvent[] = [];

  record(input: RecordReliabilityEventInput): ReliabilityEvent | null {
    const event = buildReliabilityEvent(input);
    const validationError = validateReliabilityEvent(event);
    if (validationError) {
      console.warn('[H-LEARN] reliability event rejected:', validationError);
      return null;
    }
    this.buffer.push(event);
    if (this.buffer.length > MAX_BUFFER) this.buffer.splice(0, this.buffer.length - MAX_BUFFER);
    return event;
  }

  drain(): ReliabilityEvent[] {
    const copy = [...this.buffer];
    this.buffer = [];
    return copy;
  }

  size(): number {
    return this.buffer.length;
  }

  clear(): void {
    this.buffer = [];
  }
}

const OFF_SINK: ReliabilityEventSink = {
  record: () => null,
  drain: () => [],
  size: () => 0,
  clear: () => undefined,
};

let defaultSink: ReliabilityEventSink | null = null;

export function getReliabilityEventSink(env: NodeJS.ProcessEnv = process.env): ReliabilityEventSink {
  if (parseSinkBackend(env.RELIABILITY_EVENT_SINK) === 'off') return OFF_SINK;
  if (!defaultSink) defaultSink = new MemoryReliabilityEventSink();
  return defaultSink;
}

export function setReliabilityEventSinkForTests(sink: ReliabilityEventSink | null): void {
  defaultSink = sink;
}

export function recordReliabilityEventSafe(input: RecordReliabilityEventInput): ReliabilityEvent | null {
  try {
    return getReliabilityEventSink().record(input);
  } catch (err) {
    console.warn('[H-LEARN] reliability sink failed (non-fatal):', err);
    return null;
  }
}
