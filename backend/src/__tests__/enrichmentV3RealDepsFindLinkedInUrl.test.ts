// Tests for findLinkedInUrlImpl — error-driven cache invalidation.
// Verifies that any failure after accountId is resolved purges both the
// resolved-account cache and the connectivity-status cache, so a newly-connected
// replacement account is picked up on the next call (within 30 min max).

import { findLinkedInUrlImpl } from '../services/enrichmentV3RealDeps';
import { linkedInOutreachService } from '../services/linkedInOutreachService';

jest.mock('../services/linkedInOutreachService', () => ({
  linkedInOutreachService: {
    resolveAccountIdForEnrichment: jest.fn(),
    searchPeople: jest.fn(),
    invalidateResolvedAccount: jest.fn(),
    clearStatusCache: jest.fn(),
  },
}));

const svc = linkedInOutreachService as unknown as {
  resolveAccountIdForEnrichment: jest.Mock;
  searchPeople: jest.Mock;
  invalidateResolvedAccount: jest.Mock;
  clearStatusCache: jest.Mock;
};

beforeEach(() => {
  jest.clearAllMocks();
  svc.resolveAccountIdForEnrichment.mockResolvedValue('acct-1');
});

describe('findLinkedInUrlImpl — cache invalidation on error', () => {
  it('invalidates both caches on NOT_FOUND error', async () => {
    const err = Object.assign(new Error('not found'), {
      structuredError: { classification: 'NOT_FOUND' },
    });
    svc.searchPeople.mockRejectedValue(err);

    const result = await findLinkedInUrlImpl('user-1', 'Jane', 'Doe', 'Acme');

    expect(result).toBeNull();
    expect(svc.invalidateResolvedAccount).toHaveBeenCalledWith('user-1');
    expect(svc.clearStatusCache).toHaveBeenCalledWith('acct-1');
  });

  it('invalidates both caches on non-NOT_FOUND error (500)', async () => {
    svc.searchPeople.mockRejectedValue(new Error('Internal server error'));

    const result = await findLinkedInUrlImpl('user-1', 'Jane', 'Doe', 'Acme');

    expect(result).toBeNull();
    expect(svc.invalidateResolvedAccount).toHaveBeenCalledWith('user-1');
    expect(svc.clearStatusCache).toHaveBeenCalledWith('acct-1');
  });

  it('does NOT invalidate when no account resolved (null accountId)', async () => {
    svc.resolveAccountIdForEnrichment.mockResolvedValue(null);

    const result = await findLinkedInUrlImpl('user-1', 'Jane', 'Doe', 'Acme');

    expect(result).toBeNull();
    expect(svc.invalidateResolvedAccount).not.toHaveBeenCalled();
    expect(svc.clearStatusCache).not.toHaveBeenCalled();
  });

  it('does NOT invalidate on successful lookup', async () => {
    svc.searchPeople.mockResolvedValue({
      items: [{ public_identifier: 'jane-doe', first_name: 'Jane', last_name: 'Doe' }],
    });

    await findLinkedInUrlImpl('user-1', 'Jane', 'Doe', 'Acme');

    expect(svc.invalidateResolvedAccount).not.toHaveBeenCalled();
    expect(svc.clearStatusCache).not.toHaveBeenCalled();
  });
});
