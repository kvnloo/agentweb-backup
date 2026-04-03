import { CRMTrigger } from '../types/crmTriggers';
import { crmTriggerDb } from './crmTriggerDb';

const CACHE_TTL_MS = 2 * 60 * 1000; // 2 minutes
const MAX_CACHE_ENTRIES = 2000;

interface CacheEntry {
  triggers: CRMTrigger[];
  loadedAt: number;
}

const cache = new Map<string, CacheEntry>();

export const crmTriggerCache = {
  async getTriggersForList(listId: string): Promise<CRMTrigger[]> {
    const entry = cache.get(listId);
    if (entry && Date.now() - entry.loadedAt < CACHE_TTL_MS) {
      return entry.triggers;
    }

    const triggers = await crmTriggerDb.getTriggersByListId(listId);

    // Evict oldest entry when at capacity (Map preserves insertion order)
    if (cache.size >= MAX_CACHE_ENTRIES) {
      const oldestKey = cache.keys().next().value;
      if (oldestKey) cache.delete(oldestKey);
    }

    cache.set(listId, { triggers, loadedAt: Date.now() });
    return triggers;
  },

  invalidate(listId: string): void {
    cache.delete(listId);
  },
};
