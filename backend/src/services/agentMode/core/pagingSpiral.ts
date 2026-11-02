/**
 * ENG-2778: paging-spiral detection.
 *
 * The exact-signature anti-loop guards in agentModeService key on tool name AND full
 * arguments, so a model that pages the same resource with a different offset/limit on
 * every step (25x get_session_transcript across 5 sessions in session 3d6be53d) never
 * trips them and burns the whole step budget. This module keys calls on the tool name
 * plus their NON-pagination arguments, so "same resource, different page" collapses to
 * one key and can be counted.
 */

/** Argument names that only select a page/window of the same underlying resource. */
export const PAGINATION_ARG_KEYS: ReadonlySet<string> = new Set([
  'offset',
  'limit',
  'page',
  'page_size',
  'pageSize',
  'page_token',
  'pageToken',
  'cursor',
  'next_token',
  'nextToken',
  'start',
  'end',
  'skip',
  'take',
]);

/** Calls to one resource (pagination ignored) within a turn before the nudge fires. */
export const PAGING_SPIRAL_THRESHOLD = 5;

export const PAGING_SPIRAL_STOP_MESSAGE =
  '[SYSTEM] You are paging through the same resource repeatedly (same tool and target, different offset/limit). STOP paging it. Use what you already have, prefer an aggregate source (e.g. CRM/lead-list tools for counts and status) over reconstructing data from transcripts, and move toward your final response.';

function parseArgs(raw: unknown): Record<string, unknown> | null {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw !== 'string') return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Key for one tool call with pagination arguments removed. Returns null when the call
 * carries no pagination argument at all — repeating a non-paged call is the exact-repeat
 * guard's job, not this one's.
 */
export function pagingResourceKey(toolCall: any): string | null {
  const name = toolCall?.function?.name;
  if (!name) return null;
  const args = parseArgs(toolCall.function.arguments);
  if (!args) return null;
  const keys = Object.keys(args);
  if (!keys.some((k) => PAGINATION_ARG_KEYS.has(k))) return null;
  const rest = keys
    .filter((k) => !PAGINATION_ARG_KEYS.has(k))
    .sort()
    .map((k) => `${k}=${JSON.stringify(args[k])}`)
    .join('&');
  return `${name}?${rest}`;
}

/**
 * Record this step's tool calls into `counts` (mutated; one map per turn) and return
 * the resource keys whose count has just reached `threshold`.
 */
export function recordPagingCalls(
  counts: Map<string, number>,
  toolCalls: any[] | null | undefined,
  threshold: number = PAGING_SPIRAL_THRESHOLD,
): string[] {
  const tripped: string[] = [];
  for (const tc of toolCalls ?? []) {
    const key = pagingResourceKey(tc);
    if (!key) continue;
    const next = (counts.get(key) ?? 0) + 1;
    counts.set(key, next);
    if (next === threshold) tripped.push(key);
  }
  return tripped;
}
