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
