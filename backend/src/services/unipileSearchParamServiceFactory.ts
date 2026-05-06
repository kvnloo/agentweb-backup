/**
 * Wires the real Unipile HTTP client (linkedInOutreachService.searchParameters)
 * and the DynamoDB cache store to UnipileSearchParamService.
 *
 * Kept separate from unipileSearchParamService.ts so the core service stays
 * free of AWS / Unipile-SDK imports for fast unit tests.
 *
 * Call initUnipileSearchParamService() once at server boot.
 */

import { linkedInOutreachService } from './linkedInOutreachService';
import { crmDb } from './db';
import {
  UnipileSearchParamService,
  initUnipileSearchParamService,
  peekUnipileSearchParamServiceSingleton,
  type UnipileSearchParamHttpClient,
  type UnipileSearchParamCacheStore,
} from './unipileSearchParamService';

function buildHttpClient(): UnipileSearchParamHttpClient {
  return {
    async searchParameters(accountId, args) {
      return await linkedInOutreachService.searchParameters(accountId, args);
    },
  };
}

function buildCacheStore(): UnipileSearchParamCacheStore {
  return {
    async get(canonicalId, sk) {
      const item = await crmDb.getEnrichmentCacheItem(canonicalId, sk);
      if (!item) return null;
      // Discriminator check — defends against any legacy row colliding
      // even though namespacing makes that practically impossible.
      if (item.cacheType !== 'unipile_search_param') return null;
      return item as any;
    },
    async put(row) {
      await crmDb.putEnrichmentCacheItem({
        ...row,
        cacheType: 'unipile_search_param',
      });
    },
  };
}

export function initUnipileSearchParamServiceFromEnv(): void {
  const svc = new UnipileSearchParamService({
    http: buildHttpClient(),
    store: buildCacheStore(),
  });
  initUnipileSearchParamService(svc);
}

/**
 * Resolve the singleton, lazy-initializing on first call. Both deps
 * (linkedInOutreachService + crmDb) are module-level imports with no async
 * setup, so a forked worker process that never ran initUnipileSearchParamServiceFromEnv()
 * at boot can still resolve the service on demand. Mirrors the
 * unipileProfileServiceFactory.getUnipileProfileService pattern.
 *
 * Application code (Emma agentMode, CRM enrichment) should import this
 * getter instead of the throwing one in unipileSearchParamService.ts.
 */
export function getUnipileSearchParamService(): UnipileSearchParamService {
  let svc = peekUnipileSearchParamServiceSingleton();
  if (!svc) {
    initUnipileSearchParamServiceFromEnv();
    svc = peekUnipileSearchParamServiceSingleton();
  }
  if (!svc) {
    // Should be unreachable — initUnipileSearchParamServiceFromEnv is synchronous
    // and unconditionally sets the singleton.
    throw new Error('UnipileSearchParamService initialization failed');
  }
  return svc;
}
