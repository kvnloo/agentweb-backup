import type { ReliabilityEvent } from '../services/reliabilityEvent';

export type ReceiptStatus =
  | 'succeeded'
  | 'failed'
  | 'blocked'
  | 'deferred'
  | 'not_attempted'
  | 'unknown';

export interface ReliabilityReceipt {
  tool?: string;
  sessionId?: string;
  status: ReceiptStatus;
  evidence: 'event' | 'unknown';
  latencyMs?: number;
  reason?: string;
}

export function normalizeReliabilityReceipt(
  event: ReliabilityEvent | null | undefined,
): ReliabilityReceipt {
  if (!event) return { status: 'unknown', evidence: 'unknown' };

  const status: ReceiptStatus =
    event.outcome === 'success' ? 'succeeded' :
    event.outcome === 'error' || event.outcome === 'timeout' ? 'failed' :
    event.outcome === 'blocked' || event.outcome === 'user_refused' ? 'blocked' :
    event.outcome === 'pending_confirmation' ? 'deferred' :
    'not_attempted';

  return {
    tool: event.tool,
    sessionId: event.sessionId,
    status,
    evidence: 'event',
    latencyMs: event.latencyMs,
    reason: event.errorSummary,
  };
}
