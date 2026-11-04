// Tests for buildIdentityDeps().apolloBrokerChain async polling — verifies the
// shared waitForApolloAsyncResult path returns the webhook result.
import { buildIdentityDeps, brokerWaitMs } from '../services/enrichmentV3RealDeps';
import * as apolloServiceModule from '../services/apolloService';
import { crmDb } from '../services/db';

const WAIT_ENV = 'APOLLO_BROKER_WAIT_MS';
const savedWait = process.env[WAIT_ENV];
afterEach(() => {
  jest.restoreAllMocks();
  if (savedWait === undefined) delete process.env[WAIT_ENV]; else process.env[WAIT_ENV] = savedWait;
});

function mockApollo(findEmailResult: any) {
  const findEmail = jest.fn().mockResolvedValue(findEmailResult);
  jest.spyOn(apolloServiceModule, 'isApolloServiceReady').mockReturnValue(true);
  jest.spyOn(apolloServiceModule, 'getApolloService').mockReturnValue({ findEmail } as any);
  jest.spyOn(crmDb, 'putEnrichmentCacheItem').mockResolvedValue(undefined as any);
}

describe('apolloBrokerChain — async polling via shared waitForApolloAsyncResult', () => {
  it('returns the email once the placeholder row is marked completed', async () => {
    process.env[WAIT_ENV] = '30000';
    mockApollo({ found: false, asyncPending: true, asyncRequestId: 'req-123' });
    jest.spyOn(crmDb, 'getEnrichmentCacheItem').mockResolvedValue({
      rawData: { status: 'completed', result: { email: 'jane@acme.com', emailStatus: 'verified' } },
    } as any);
    // the placeholder must exist BEFORE we start waiting, or a callback that lands during the wait finds no row
    const orderOfCalls = () => ({
      put: (crmDb.putEnrichmentCacheItem as jest.Mock).mock.invocationCallOrder[0],
      get: (crmDb.getEnrichmentCacheItem as jest.Mock).mock.invocationCallOrder[0],
    });

    const deps = buildIdentityDeps('user-1');
    const result = await deps.apolloBrokerChain(
      { firstName: 'Jane', lastName: 'Doe', domain: 'acme.com' },
      { listId: 'list-1', leadId: 'lead-1' },
    );

    expect(result).toEqual({ email: 'jane@acme.com', emailStatus: 'verified' });
    expect(crmDb.getEnrichmentCacheItem).toHaveBeenCalled();
    const { put, get } = orderOfCalls();
    expect(put).toBeDefined();
    expect(put).toBeLessThan(get);
  });

  it('returns null when the placeholder row resolves to no_email', async () => {
    process.env[WAIT_ENV] = '30000';
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

  // ENG-2801: the placeholder is what lets Apollo's callback find the lead; the wait is only an opt-in on top of it.
  it('writes the placeholder but does NOT wait by default (no run-time change)', async () => {
    delete process.env[WAIT_ENV];
    mockApollo({ found: false, asyncPending: true, asyncRequestId: '8327452971617011608' });
    const get = jest.spyOn(crmDb, 'getEnrichmentCacheItem').mockResolvedValue(null as any);

    const deps = buildIdentityDeps('user-1');
    const t0 = Date.now();
    const result = await deps.apolloBrokerChain(
      { firstName: 'Jane', lastName: 'Doe', domain: 'acme.com' },
      { listId: 'list-1', leadId: 'lead-1' },
    );

    expect(result).toBeNull();
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(get).not.toHaveBeenCalled(); // no polling
    expect(crmDb.putEnrichmentCacheItem).toHaveBeenCalledTimes(1);
    const row = (crmDb.putEnrichmentCacheItem as jest.Mock).mock.calls[0][0];
    expect(row.rawData).toMatchObject({ listId: 'list-1', leadId: 'lead-1', userId: 'user-1', status: 'pending' });
    expect(row.fieldGroup).toBe('apollo:async_request#v1');
  });

  it('brokerWaitMs: unset, blank, junk, zero and negative mean no wait; a positive value opts in, capped at 120 s', () => {
    const set = (v?: string) => { if (v === undefined) delete process.env[WAIT_ENV]; else process.env[WAIT_ENV] = v; };
    for (const v of [undefined, '', '  ', 'abc', 'NaN', '0', '-5', 'Infinity']) { set(v); expect(brokerWaitMs()).toBe(0); }
    set('30000'); expect(brokerWaitMs()).toBe(30000);
    set('1500.9'); expect(brokerWaitMs()).toBe(1500);
    set('999999999'); expect(brokerWaitMs()).toBe(120000);
  });
});
