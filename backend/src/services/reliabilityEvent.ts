/**
 * H-LEARN-0: ReliabilityEvent schema for append-only tool outcome telemetry.
 */

export type ReliabilityOutcome =
  | 'success'
  | 'error'
  | 'blocked'
  | 'skipped'
  | 'timeout'
  | 'user_refused';

export interface ReliabilityEvent {
  at: string;
  tool: string;
  sessionId?: string;
  userId?: string;
  outcome: ReliabilityOutcome;
  latencyMs: number;
  userEdit?: boolean;
  errorSummary?: string;
  platform?: string;
}

export const RELIABILITY_EVENT_MAX_STRING = 500;
export const RELIABILITY_EVENT_MAX_LATENCY_MS = 30 * 60 * 1000;

export function validateReliabilityEvent(event: ReliabilityEvent): string | null {
  if (!event.at || !Number.isFinite(Date.parse(event.at))) return 'at must be a valid ISO-8601 timestamp';
  if (!event.tool?.trim()) return 'tool is required';
  if (event.tool.length > 120) return 'tool name too long';
  if (!Number.isFinite(event.latencyMs) || event.latencyMs < 0) return 'latencyMs must be non-negative';
  if (event.latencyMs > RELIABILITY_EVENT_MAX_LATENCY_MS) return 'latencyMs exceeds maximum';
  if (event.errorSummary && event.errorSummary.length > RELIABILITY_EVENT_MAX_STRING) return 'errorSummary too long';
  return null;
}

export function buildReliabilityEvent(params: {
  tool: string;
  outcome: ReliabilityOutcome;
  latencyMs: number;
  sessionId?: string;
  userId?: string;
  userEdit?: boolean;
  errorSummary?: string;
  platform?: string;
  at?: string;
}): ReliabilityEvent {
  return {
    at: params.at ?? new Date().toISOString(),
    tool: params.tool,
    sessionId: params.sessionId,
    userId: params.userId,
    outcome: params.outcome,
    latencyMs: Math.max(0, Math.round(params.latencyMs)),
    userEdit: params.userEdit,
    errorSummary: params.errorSummary?.slice(0, RELIABILITY_EVENT_MAX_STRING),
    platform: params.platform?.slice(0, 64),
  };
}

export function classifyToolResultOutcome(result: unknown, thrownError?: unknown): ReliabilityOutcome {
  if (thrownError) return 'error';
  if (!result || typeof result !== 'object') return 'success';
  const r = result as Record<string, unknown>;
  if (r.awaitingUserConfirmation === true || r.requiresConfirmation === true) return 'user_refused';
  if (r.skipped === true) return 'skipped';
  if (r.success === false) {
    const msg = typeof r.message === 'string' ? r.message : typeof r.error === 'string' ? r.error : '';
    if (/blocked|not available|not authorized|refused/i.test(msg)) return 'blocked';
    if (/timeout|timed out/i.test(msg)) return 'timeout';
    return 'error';
  }
  if (r.error) return 'error';
  return 'success';
}

export function summarizeToolError(result: unknown, thrownError?: unknown): string | undefined {
  if (thrownError instanceof Error) return thrownError.message.slice(0, RELIABILITY_EVENT_MAX_STRING);
  if (!result || typeof result !== 'object') return undefined;
  const r = result as Record<string, unknown>;
  const msg =
    (typeof r.message === 'string' && r.message) ||
    (typeof r.error === 'string' && r.error) ||
    (r.error && typeof r.error === 'object' && typeof (r.error as any).message === 'string'
      ? (r.error as any).message
      : '');
  return msg ? String(msg).slice(0, RELIABILITY_EVENT_MAX_STRING) : undefined;
}
