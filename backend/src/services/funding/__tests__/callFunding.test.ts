/**
 * ENG-2108 (A2): per-call funding resolution. The rule under test: a customer who has a
 * key for the call's provider is NEVER silently served on AgentWeb's account. The
 * connection service and flags are stubbed at the module boundary.
 */
const routingStateFor = jest.fn();
jest.mock('../llmConnectionService', () => ({
  getLlmConnectionService: () => ({ routingStateFor }),
}));
const getFundingFlags = jest.fn();
jest.mock('../fundingFlags', () => ({ getFundingFlags: (...a: unknown[]) => getFundingFlags(...a) }));

import { resolveCallFunding, CONNECTION_LOOKUP_TIMEOUT_MS, ROUTING_CACHE_MAX_ENTRIES, ROUTING_CACHE_TTL_MS, __callFundingCacheSizeForTests, __resetCallFundingCacheForTests } from '../callFunding';
import { registerCustomerRouteProvisioner } from '../transport/customerRouteProvisioner';
import type { RunFunding } from '../runFunding';

const run: RunFunding = {
  route: 'agentweb',
  fallback: 'agentweb', // what resolveRunFunding really sets today: the old fallback guard never fired
  ownerUserId: 'member-1',
  billingUserId: 'member-1',
  resolvedAt: '2026-10-13T00:00:00.000Z',
};
const conn = (over: Record<string, unknown> = {}) => ({
  connectionId: 'c1',
  ownerUserId: 'owner-1',
  kind: 'api_key',
  provider: 'anthropic',
  status: 'active',
  ownedByCaller: false,
  ...over,
});
const input: any = { userId: 'member-1', modelLab: 'anthropic', customerRoutable: true };
const stateWith = (...usable: any[]) => ({ hasConnection: true, usable });
const thrown = (p: Promise<unknown>) => p.then(() => undefined, (e) => e);

describe('resolveCallFunding', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    __resetCallFundingCacheForTests();
    registerCustomerRouteProvisioner({ clientFor: jest.fn() });
    getFundingFlags.mockResolvedValue({ killSwitch: false, byok: { enabled: true, allowUserIds: ['*'] } });
    routingStateFor.mockResolvedValue(stateWith(conn()));
  });
  afterAll(() => registerCustomerRouteProvisioner(null));

  describe('routing to the customer\'s key', () => {
    it('routes a call to the matching key, paid by the key\'s owner', async () => {
      expect(await resolveCallFunding(run, input)).toMatchObject({
        route: 'api_key',
        connectionId: 'c1',
        provider: 'anthropic',
        fundingPrincipalId: 'owner-1',
        ownerUserId: 'member-1',
      });
    });

    it('never inherits the run\'s AgentWeb fallback: a customer-funded call defaults to stop', async () => {
      expect(run.fallback).toBe('agentweb'); // what resolveRunFunding really sets
      expect((await resolveCallFunding(run, input))?.fallback).toBe('stop');
    });

    it('looks nobody up and stays on AgentWeb for a user the BYOK allowlist does not name, even if the store is failing', async () => {
      getFundingFlags.mockResolvedValue({ killSwitch: false, byok: { enabled: true, allowUserIds: ['someone-else'] } });
      routingStateFor.mockRejectedValue(new Error('store down'));
      expect(await resolveCallFunding(run, input)).toBe(run);
      expect(routingStateFor).not.toHaveBeenCalled();
    });

    it('routes a user the allowlist names by id, and everyone under *', async () => {
      getFundingFlags.mockResolvedValue({ killSwitch: false, byok: { enabled: true, allowUserIds: ['member-1'] } });
      expect(await resolveCallFunding(run, input)).toMatchObject({ route: 'api_key' });
      getFundingFlags.mockResolvedValue({ killSwitch: false, byok: { enabled: true, allowUserIds: ['*'] } });
      __resetCallFundingCacheForTests();
      expect(await resolveCallFunding(run, { ...input, userId: 'anyone' })).toMatchObject({ route: 'api_key' });
    });

    it('bounds the routing cache and still answers correctly past the bound', async () => {
      for (let i = 0; i < ROUTING_CACHE_MAX_ENTRIES + 20; i++) await resolveCallFunding(run, { ...input, userId: `u${i}` });
      expect(__callFundingCacheSizeForTests()).toBeLessThanOrEqual(ROUTING_CACHE_MAX_ENTRIES);
      expect(await resolveCallFunding(run, { ...input, userId: 'u0' })).toMatchObject({ route: 'api_key' });
    });

    it('lists every usable same-provider key in order, and takes the first', async () => {
      routingStateFor.mockResolvedValue(stateWith(conn({ connectionId: 'a' }), conn({ connectionId: 'b', ownerUserId: 'owner-2' })));
      const funding = await resolveCallFunding(run, input);
      expect(funding?.connectionId).toBe('a');
      expect(funding?.candidates).toEqual([
        { connectionId: 'a', fundingPrincipalId: 'owner-1' },
        { connectionId: 'b', fundingPrincipalId: 'owner-2' },
      ]);
    });

    it('lets a direct-Anthropic caller use an active Anthropic key with no provisioner', async () => {
      registerCustomerRouteProvisioner(null);
      expect(await resolveCallFunding(run, { ...input, canCallAnthropicDirect: true })).toMatchObject({ route: 'api_key', connectionId: 'c1' });
    });
  });

  describe('FAIL CLOSED: a customer with a key is never silently served on AgentWeb', () => {
    it.each([
      ['an invalid key', stateWith()],
      ['a key that is pending, failed, suspended or not provisioned (usable is empty)', stateWith()],
    ])('throws connection_unavailable for %s', async (_label, state) => {
      routingStateFor.mockResolvedValue(state);
      expect(await thrown(resolveCallFunding(run, input))).toMatchObject({ name: 'CustomerRouteError', code: 'connection_unavailable' });
    });

    it('throws connection_unavailable for a customer whose only usable key needs OpenRouter provisioning that is not there', async () => {
      registerCustomerRouteProvisioner(null);
      expect(await thrown(resolveCallFunding(run, input))).toMatchObject({ code: 'connection_unavailable' });
    });

    it('throws for a direct-Anthropic caller whose key is not active', async () => {
      registerCustomerRouteProvisioner(null);
      routingStateFor.mockResolvedValue(stateWith(conn({ status: 'invalid' })));
      expect(await thrown(resolveCallFunding(run, { ...input, canCallAnthropicDirect: true }))).toMatchObject({ code: 'connection_unavailable' });
    });

    it('throws lookup_failed, and never returns AgentWeb funding, when the lookup fails, whatever the run\'s fallback says', async () => {
      const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
      routingStateFor.mockRejectedValue(Object.assign(new Error('secret detail'), { code: 'ThrottlingException' }));
      for (const fallback of ['agentweb', 'stop'] as const) {
        __resetCallFundingCacheForTests();
        expect(await thrown(resolveCallFunding({ ...run, fallback }, input))).toMatchObject({ code: 'lookup_failed' });
      }
      const logged = spy.mock.calls.flat().join(' ');
      spy.mockRestore();
      expect(logged).toContain('ThrottlingException');
      expect(logged).not.toContain('secret detail');
    });

    it('treats a lookup that hangs as a failed lookup', async () => {
      jest.useFakeTimers();
      const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
      routingStateFor.mockReturnValue(new Promise(() => {}));
      const pending = thrown(resolveCallFunding(run, input));
      await jest.advanceTimersByTimeAsync(CONNECTION_LOOKUP_TIMEOUT_MS + 1);
      expect(await pending).toMatchObject({ code: 'lookup_failed' });
      spy.mockRestore();
      jest.useRealTimers();
    });
  });

  describe('when the call legitimately stays on AgentWeb', () => {
    it('stays on AgentWeb for a user with no connection for this provider', async () => {
      routingStateFor.mockResolvedValue({ hasConnection: false, usable: [] });
      expect(await resolveCallFunding(run, input)).toBe(run);
    });

    it.each([
      ['BYOK off', { killSwitch: false, byok: { enabled: false, allowUserIds: [] } }],
      ['kill switch on', { killSwitch: true, byok: { enabled: true, allowUserIds: ['*'] } }],
    ])('stays on AgentWeb with %s, without a connection lookup', async (_label, flags) => {
      getFundingFlags.mockResolvedValue(flags);
      expect(await resolveCallFunding(run, input)).toBe(run);
      expect(routingStateFor).not.toHaveBeenCalled();
    });

    it.each([['xai'], ['deepseek'], ['other'], [undefined]])('keeps a %s model on AgentWeb without a lookup', async (modelLab) => {
      expect(await resolveCallFunding(run, { ...input, modelLab })).toBe(run);
      expect(routingStateFor).not.toHaveBeenCalled();
    });

    it('keeps every call that is not the agent\'s own working loop on AgentWeb', async () => {
      expect(await resolveCallFunding(run, { ...input, customerRoutable: false })).toBe(run);
      expect(routingStateFor).not.toHaveBeenCalled();
    });

    it('leaves a run that already has a non-AgentWeb funding, or none, or no user, untouched', async () => {
      const sub: RunFunding = { ...run, route: 'claude_subscription' };
      expect(await resolveCallFunding(sub, input)).toBe(sub);
      expect(await resolveCallFunding(undefined, input)).toBeUndefined();
      expect(await resolveCallFunding(run, { ...input, userId: undefined })).toBe(run);
    });
  });

  describe('the per-process routing cache', () => {
    it('reuses a routing answer for a few seconds, then looks again', async () => {
      jest.useFakeTimers();
      await resolveCallFunding(run, input);
      await resolveCallFunding(run, input);
      expect(routingStateFor).toHaveBeenCalledTimes(1);
      jest.advanceTimersByTime(ROUTING_CACHE_TTL_MS + 1);
      await resolveCallFunding(run, input);
      expect(routingStateFor).toHaveBeenCalledTimes(2);
      jest.useRealTimers();
    });

    it('keeps separate answers per user and per provider, and never caches a failed lookup', async () => {
      const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
      await resolveCallFunding(run, input);
      await resolveCallFunding(run, { ...input, userId: 'member-2' });
      await resolveCallFunding(run, { ...input, modelLab: 'openai' });
      expect(routingStateFor).toHaveBeenCalledTimes(3);

      __resetCallFundingCacheForTests();
      routingStateFor.mockRejectedValueOnce(new Error('blip')).mockResolvedValue(stateWith(conn()));
      expect(await thrown(resolveCallFunding(run, input))).toMatchObject({ code: 'lookup_failed' });
      expect(await resolveCallFunding(run, input)).toMatchObject({ route: 'api_key' });
      spy.mockRestore();
    });
  });
});
