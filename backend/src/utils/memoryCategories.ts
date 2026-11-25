/**
 * ENG-2840 (W2-1): the one list of memory categories.
 *
 * `services/db.ts` validates every memory write against it, and `emma/impl/memory.ts` checks it before it
 * spends anything on an embedding. It lives in its own file, with no imports, so `emma/impl/memory.ts` can read
 * it at module scope without pulling in `services/db` (which builds a DynamoDB client when it loads).
 */
export const MEMORY_CATEGORIES = ['preference', 'history', 'insight', 'workflow'] as const;

export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];

export function isMemoryCategory(value: unknown): value is MemoryCategory {
  return typeof value === 'string' && (MEMORY_CATEGORIES as readonly string[]).includes(value);
}
