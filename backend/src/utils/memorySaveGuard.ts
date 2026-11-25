import { MEMORY_CATEGORIES, isMemoryCategory } from './memoryCategories';
import { assertMemoryContentWithinLimit } from './memoryContentLimit';

/**
 * The refusals `addMemory` makes, with the same messages and in the same order, for a caller that would otherwise pay for an
 * embedding first and be refused afterwards (the embedding is billed to the caller's cap whether or not the row is saved).
 * Throws; the save routes map a message containing "Invalid category" or "Content" to a 400, as they do for `addMemory`'s own errors.
 */
export function assertMemorySaveable(category: string, content: string): void {
  if (!isMemoryCategory(category)) {
    throw new Error(`Invalid category: ${category}. Must be one of: ${MEMORY_CATEGORIES.join(', ')}`);
  }
  if (!content || content.trim().length === 0) {
    throw new Error('Content is required');
  }
  assertMemoryContentWithinLimit(content);
}
