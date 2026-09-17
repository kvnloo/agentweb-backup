export interface OpeningActionCall {
  tool: string;
  args?: Record<string, unknown>;
}

export interface OpeningAction {
  type: 'prefetch';
  calls: OpeningActionCall[];
  maxCalls?: number;
  timeoutMs?: number;
  maxChars?: number;
}

export const OPENING_ACTION_MAX_CALLS = 5;
export const OPENING_ACTION_MAX_TIMEOUT_MS = 30_000;
export const OPENING_ACTION_MAX_CHARS = 8_000;

export const OPENING_ACTION_VALIDATION_ERROR =
  'openingAction must be a bounded prefetch of read tools from the skill tool set';

export function validateOpeningAction(value: unknown, skillToolNames: string[] = []): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return OPENING_ACTION_VALIDATION_ERROR;
  }
  const action = value as Record<string, unknown>;
  if (action.type !== 'prefetch') return OPENING_ACTION_VALIDATION_ERROR;
  if (!Array.isArray(action.calls) || action.calls.length === 0) {
    return 'openingAction.calls must be a non-empty array of { tool, args }';
  }
  const maxCalls = typeof action.maxCalls === 'number' ? action.maxCalls : action.calls.length;
  if (!Number.isInteger(maxCalls) || maxCalls < 1 || maxCalls > OPENING_ACTION_MAX_CALLS) {
    return `openingAction.maxCalls must be an integer between 1 and ${OPENING_ACTION_MAX_CALLS}`;
  }
  if (action.calls.length > maxCalls) {
    return `openingAction declares ${action.calls.length} calls but maxCalls is ${maxCalls}`;
  }
  const allowed = new Set(skillToolNames);
  for (const call of action.calls) {
    if (typeof call !== 'object' || call === null || typeof (call as any).tool !== 'string' || !(call as any).tool) {
      return 'openingAction.calls entries must carry a non-empty tool name';
    }
    if (!allowed.has((call as any).tool)) {
      return `openingAction tool "${(call as any).tool}" is not in the skill tool set`;
    }
  }
  if (action.timeoutMs !== undefined && (typeof action.timeoutMs !== 'number' || action.timeoutMs <= 0 || action.timeoutMs > OPENING_ACTION_MAX_TIMEOUT_MS)) {
    return `openingAction.timeoutMs must be within 1..${OPENING_ACTION_MAX_TIMEOUT_MS}ms`;
  }
  if (action.maxChars !== undefined && (typeof action.maxChars !== 'number' || !Number.isInteger(action.maxChars) || action.maxChars <= 0 || action.maxChars > OPENING_ACTION_MAX_CHARS)) {
    return `openingAction.maxChars must be an integer within 1..${OPENING_ACTION_MAX_CHARS}`;
  }
  return undefined;
}
