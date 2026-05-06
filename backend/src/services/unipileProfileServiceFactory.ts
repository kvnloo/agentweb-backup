/**
 * Wires the real Unipile HTTP client (linkedInOutreachService) and the
 * DynamoDB cache store to UnipileProfileService. Kept separate from
 * unipileProfileService.ts so the core service stays free of AWS imports
 * and remains fast to unit-test.
 *
 * Call initUnipileProfileService() once at server boot.
 */

import { linkedInOutreachService } from './linkedInOutreachService';
import { crmDb } from './db';
import {
  UnipileProfileService,
  setUnipileProfileServiceSingleton,
  getUnipileProfileServiceSingleton,
  type UnipileHttpClient,
  type UnipileCacheStore,
} from './unipileProfileService';

function buildHttpClient(): UnipileHttpClient {
  return {
    async fetchProfile(identifierOrUrl: string, accountId: string): Promise<any> {
      // linkedInOutreachService.getLinkedInProfile handles URL-format inputs;
      // getProfile handles bare provider_id / public_identifier. We try URL
      // form first (it does the /in/ extraction internally) and fall back
      // to the raw identifier path when the input doesn't contain /in/.
      if (identifierOrUrl.includes('/in/')) {
        return await linkedInOutreachService.getLinkedInProfile(identifierOrUrl, accountId);
      }
      return await linkedInOutreachService.getProfile(identifierOrUrl, accountId);
    },
  };
}

function buildCacheStore(): UnipileCacheStore {
  return {
    async get(canonicalId, sk) {
      const item = await crmDb.getEnrichmentCacheItem(canonicalId, sk);
      if (!item) return null;
      // Discriminator check — defends against any legacy row colliding
      // even though namespacing makes that practically impossible.
      if (item.cacheType !== 'unipile') return null;
      return item as any;
    },
    async put(row) {
      await crmDb.putEnrichmentCacheItem({
        ...row,
        cacheType: 'unipile',
      });
    },
  };
}

export function initUnipileProfileService(): void {
  if (getUnipileProfileServiceSingleton()) return;  // idempotent
  const svc = new UnipileProfileService({
    http: buildHttpClient(),
    store: buildCacheStore(),
  });
  setUnipileProfileServiceSingleton(svc);
}

/**
 * Resolve the singleton, lazy-initializing on first call. Both deps
 * (linkedInOutreachService + crmDb) are module-level imports with no async
 * setup, so a worker process that never ran initUnipileProfileService() at
 * boot can still resolve the service on demand.
 */
export function getUnipileProfileService(): UnipileProfileService {
  let svc = getUnipileProfileServiceSingleton();
  if (!svc) {
    initUnipileProfileService();
    svc = getUnipileProfileServiceSingleton();
  }
  if (!svc) {
    // Should be unreachable — initUnipileProfileService is synchronous and
    // unconditionally sets the singleton when none exists.
    throw new Error('UnipileProfileService initialization failed');
  }
  return svc;
}
