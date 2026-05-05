/**
 * Wires the real Unipile SDK call (linkedInOutreachService.getCompanyProfile)
 * and the DynamoDB cache store to UnipileCompanyService. Mirrors
 * unipileProfileServiceFactory.ts.
 *
 * Lazy-init on first call so workers without a separate boot path still
 * resolve the singleton.
 */

import { linkedInOutreachService } from './linkedInOutreachService';
import { crmDb } from './db';
import {
  UnipileCompanyService,
  setUnipileCompanyServiceSingleton,
  getUnipileCompanyServiceSingleton,
  type UnipileCompanyHttpClient,
  type UnipileCompanyCacheStore,
} from './unipileCompanyService';

function buildHttpClient(): UnipileCompanyHttpClient {
  return {
    async fetchCompany(identifier: string, accountId: string): Promise<any> {
      // linkedInOutreachService.getCompanyProfile accepts the company's
      // identifier (vanity name or URN) and an account_id. It does not
      // accept linkedin_sections — the company endpoint returns a full
      // payload (industry, headcount, description, specialties, etc.) by
      // default.
      return await linkedInOutreachService.getCompanyProfile(identifier, accountId);
    },
  };
}

function buildCacheStore(): UnipileCompanyCacheStore {
  return {
    async get(canonicalId, sk) {
      const item = await crmDb.getEnrichmentCacheItem(canonicalId, sk);
      if (!item) return null;
      if (item.cacheType !== 'unipile_company') return null;
      return item as any;
    },
    async put(row) {
      await crmDb.putEnrichmentCacheItem({
        ...row,
        cacheType: 'unipile_company',
      });
    },
  };
}

export function initUnipileCompanyService(): void {
  if (getUnipileCompanyServiceSingleton()) return;
  const svc = new UnipileCompanyService({
    http: buildHttpClient(),
    store: buildCacheStore(),
  });
  setUnipileCompanyServiceSingleton(svc);
}

/**
 * Lazy-init singleton resolver. Both deps (linkedInOutreachService + crmDb)
 * are module-level imports with no async setup, so workers that never run
 * initUnipileCompanyService() at boot still resolve the service on demand.
 */
export function getUnipileCompanyService(): UnipileCompanyService {
  let svc = getUnipileCompanyServiceSingleton();
  if (!svc) {
    initUnipileCompanyService();
    svc = getUnipileCompanyServiceSingleton();
  }
  if (!svc) {
    throw new Error('UnipileCompanyService initialization failed');
  }
  return svc;
}
