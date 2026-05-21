// Tests for buildIdentityDeps().apolloBrokerChain async polling — verifies the
// shared waitForApolloAsyncResult path returns the webhook result.
import { buildIdentityDeps } from '../services/enrichmentV3RealDeps';
import * as apolloServiceModule from '../services/apolloService';
import { crmDb } from '../services/db';

afterEach(() => {
  jest.restoreAllMocks();
});

function mockApollo(findEmailResult: any) {
  const findEmail = jest.fn().mockResolvedValue(findEmailResult);
  jest.spyOn(apolloServiceModule, 'isApolloServiceReady').mockReturnValue(true);
  jest.spyOn(apolloServiceModule, 'getApolloService').mockReturnValue({ findEmail } as any);
  jest.spyOn(crmDb, 'putEnrichmentCacheItem').mockResolvedValue(undefined as any);
}

describe('apolloBrokerChain — async polling via shared waitForApolloAsyncResult', () => {
  it('returns the email once the placeholder row is marked completed', async () => {
    mockApollo({ found: false, asyncPending: true, asyncRequestId: 'req-123' });
    jest.spyOn(crmDb, 'getEnrichmentCacheItem').mockResolvedValue({
      rawData: { status: 'completed', result: { email: 'jane@acme.com', emailStatus: 'verified' } },
    } as any);

    const deps = buildIdentityDeps('user-1');
    const result = await deps.apolloBrokerChain(
      { firstName: 'Jane', lastName: 'Doe', domain: 'acme.com' },
      { listId: 'list-1', leadId: 'lead-1' },
    );

    expect(result).toEqual({ email: 'jane@acme.com', emailStatus: 'verified' });
    expect(crmDb.getEnrichmentCacheItem).toHaveBeenCalled();
  });

  it('returns null when the placeholder row resolves to no_email', async () => {
    mockApollo({ found: false, asyncPending: true, asyncRequestId: 'req-456' });
    jest.spyOn(crmDb, 'getEnrichmentCacheItem').mockResolvedValue({
      rawData: { status: 'no_email' },
    } as any);

    const deps = buildIdentityDeps('user-1');
    const result = await deps.apolloBrokerChain(
      { firstName: 'Jane', lastName: 'Doe', domain: 'acme.com' },
      { listId: 'list-1', leadId: 'lead-1' },
    );

    expect(result).toBeNull();
  });
});
