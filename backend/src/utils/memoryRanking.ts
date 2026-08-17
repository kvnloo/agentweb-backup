/**
 * Pure ranking helpers for account / org memory retrieval.
 *
 * The legacy memory layer injected only the 20 most-recent memories every turn, so a
 * relevant older fact was never placed in front of the model. These helpers rank memories
 * by semantic relevance to the current query (cosine similarity over text-embedding-3-large
 * vectors) with a mild recency tie-breaker, so the right memory surfaces regardless of age.
 *
 * Intentionally dependency-free (no AWS / OpenAI imports) so it is trivially unit-testable.
 */

/** Cosine similarity. Returns 0 for empty, mismatched-length, or zero vectors (never NaN). */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (!a || !b || a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export interface RankableMemory {
  embedding?: number[];
  createdAt?: string;
  [key: string]: any;
}

export interface RankOptions {
  /** Weight of the recency tie-breaker relative to cosine similarity. Small by design. */
  recencyWeight?: number;
}

const DEFAULT_RECENCY_WEIGHT = 0.05;

/** Newest first; missing createdAt sorts last. */
function byCreatedAtDesc(a: RankableMemory, b: RankableMemory): number {
  const ax = a.createdAt || '';
  const bx = b.createdAt || '';
  if (ax < bx) return 1;
  if (ax > bx) return -1;
  return 0;
}

/**
 * Rank memories by relevance to `queryEmbedding`, returning at most `limit`.
 *
 * - If the whole set fits within `limit`, returns all of them newest-first — identical to
 *   the legacy behavior, and avoids any embedding cost for small accounts.
 * - Otherwise scores each memory by cosine similarity (memories lacking a usable embedding
 *   score 0, so they fall back to recency and are never silently dropped) plus a small
 *   recency bonus, and returns the top `limit`.
 */
export function rankMemoriesByRelevance<T extends RankableMemory>(
  memories: T[],
  queryEmbedding: number[],
  limit: number,
  opts: RankOptions = {}
): T[] {
  if (!memories || memories.length === 0) return [];

  const sortedByRecency = [...memories].sort(byCreatedAtDesc);
  if (memories.length <= limit) {
    return sortedByRecency;
  }

  const recencyWeight = opts.recencyWeight ?? DEFAULT_RECENCY_WEIGHT;
  const n = sortedByRecency.length;
  const hasQuery = Array.isArray(queryEmbedding) && queryEmbedding.length > 0;

  const scored = sortedByRecency.map((memory, idx) => {
    const similarity = hasQuery && memory.embedding
      ? cosineSimilarity(memory.embedding, queryEmbedding)
      : 0;
    // Newest → bonus ~recencyWeight, oldest → ~0. (n > 1 here because length > limit >= 1.)
    const recencyBonus = n > 1 ? recencyWeight * (1 - idx / (n - 1)) : recencyWeight;
    return { memory, score: similarity + recencyBonus };
  });

  scored.sort((x, y) => y.score - x.score);
  return scored.slice(0, Math.max(0, limit)).map((s) => s.memory);
}

const MS_PER_DAY = 86_400_000;

export interface FormattableMemory {
  category?: string;
  content?: string;
  createdAt?: string;
  updatedAt?: string;
  [key: string]: any;
}

/**
 * Human-readable age of a saved memory relative to `now`, e.g. "today", "yesterday",
 * "4 days ago". Returns null when the timestamp is missing, unparseable (never "NaN days"),
 * or in the future — a future saved-date labelled "today" would contradict its own stamp.
 */
export function describeMemoryAge(savedAtIso: string | undefined, now: Date): string | null {
  if (!savedAtIso) return null;
  const savedMs = Date.parse(savedAtIso);
  if (Number.isNaN(savedMs)) return null;
  // Compare UTC calendar dates, not raw 24h windows: the displayed saved-date is the UTC
  // calendar date, so bucketing by elapsed hours would emit self-contradictory stamps like
  // "(saved 2026-07-12, today)" around midnight — exactly when scheduled runs fire (ENG-305).
  const savedDay = Date.parse(new Date(savedMs).toISOString().split('T')[0]);
  const nowDay = Date.parse(new Date(now.getTime()).toISOString().split('T')[0]);
  const days = Math.round((nowDay - savedDay) / MS_PER_DAY);
  // A future saved-date (clock skew, or an updatedAt bumped ahead) would otherwise render as
  // "(saved <future-date>, today)" — a self-contradiction. Fall back to the unstamped line.
  if (days < 0) return null;
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  return `${days} days ago`;
}

/**
 * Render one stored memory as a context line, stamped with when it was saved.
 *
 * Memories are historical notes, not live state (ENG-305): without a recency signal the model
 * treated a days-old operational note ("Instagram token expired — skip Instagram") as still
 * true and silently skipped a configured channel, and reused stale dates baked into old
 * memories. The saved-date + age prefix lets the model judge staleness and re-verify
 * time-sensitive facts before acting. Falls back to an unstamped line when no timestamp
 * exists so legacy memories still render.
 */
export function formatMemoryLine(memory: FormattableMemory, now: Date): string {
  const category = memory.category ?? 'general';
  const content = memory.content ?? '';
  const savedAt = memory.updatedAt || memory.createdAt;
  const age = describeMemoryAge(savedAt, now);
  if (!savedAt || !age) {
    return `- [${category}] ${content}`;
  }
  const savedDate = savedAt.split('T')[0];
  return `- [${category}] (saved ${savedDate}, ${age}) ${content}`;
}

/**
 * Caution appended to injected memory so the model treats it as historical, not live, state —
 * the guard against a stale memory silently disabling a configured channel (ENG-305).
 */
export const MEMORY_STALENESS_NOTE =
  'These are historical notes from previous sessions, not live state. Before acting on — or ' +
  'repeating to the user as current — any time-sensitive fact (e.g. a channel/account being ' +
  'disabled, a token or connection having expired, a specific date, or a stated metric, count, ' +
  'or KPI such as a conversion count, session number, or funnel figure), re-verify it with the ' +
  'relevant tool in THIS session rather than assuming an older note still holds — never ' +
  'silently skip a configured action, and never quote a number, based on a memory alone.';

/**
 * Build the memory-context message injected into the agent conversation: a header, one dated
 * line per memory, and the staleness caution. Returns null when there are no memories so the
 * caller can skip injecting an empty block.
 */
export function buildMemoryContextMessage(
  header: string,
  memories: FormattableMemory[],
  now: Date
): string | null {
  if (!memories || memories.length === 0) return null;
  const lines = memories.map((m) => formatMemoryLine(m, now));
  return `${header}\n${lines.join('\n')}\n\n${MEMORY_STALENESS_NOTE}`;
}
