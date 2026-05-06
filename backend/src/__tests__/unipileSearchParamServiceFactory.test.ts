// Tests for unipileSearchParamServiceFactory — verifies the lazy-init getter
// pattern that lets forked worker subprocesses (e.g. generateMarketingResponseWorker)
// use the resolver without the parent's boot wiring.
//
// Without lazy init, calling getUnipileSearchParamService() in a worker throws
// "UnipileSearchParamService not initialized" — caught in the wild by Playwright
// when Emma's search-parameters action ran in the agentMode worker.

jest.mock('../services/linkedInOutreachService', () => ({
  linkedInOutreachService: {
    searchParameters: jest.fn(),
  },
}));

jest.mock('../services/db', () => ({
  crmDb: {
    getEnrichmentCacheItem: jest.fn().mockResolvedValue(null),
    putEnrichmentCacheItem: jest.fn().mockResolvedValue(undefined),
  },
}));

import {
  __resetUnipileSearchParamServiceForTesting,
  setUnipileSearchParamServiceForTesting,
  UnipileSearchParamService,
} from '../services/unipileSearchParamService';
import { getUnipileSearchParamService } from '../services/unipileSearchParamServiceFactory';

beforeEach(() => {
  __resetUnipileSearchParamServiceForTesting();
});

describe('unipileSearchParamServiceFactory.getUnipileSearchParamService', () => {
  it('lazy-initializes the singleton on first call when uninitialized', () => {
    // Singleton starts null (reset above). The factory getter must NOT throw —
    // it must construct a real service via initUnipileSearchParamServiceFromEnv
    // and return it. This is the worker-subprocess code path.
    const svc = getUnipileSearchParamService();
    expect(svc).toBeInstanceOf(UnipileSearchParamService);
  });

  it('returns the same instance on subsequent calls (caches)', () => {
    const a = getUnipileSearchParamService();
    const b = getUnipileSearchParamService();
    expect(b).toBe(a);
  });

  it('returns the test-injected singleton when one is set, without re-initializing', () => {
    const fake = { resolve: jest.fn(), resolveTopId: jest.fn() } as any;
    setUnipileSearchParamServiceForTesting(fake);
    expect(getUnipileSearchParamService()).toBe(fake);
  });
});
