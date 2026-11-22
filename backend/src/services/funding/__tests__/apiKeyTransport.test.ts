/**
 * ENG-2108 (A2): ApiKeyTransport never reaches the platform client, never lets OpenRouter
 * move a request to another provider, and never falls back to AgentWeb on failure.
 */
import { ApiKeyTransport, CustomerRouteError, OPENROUTER_PROVIDER_SLUG } from '../transport/apiKeyTransport';
import { pickTransport } from '../transport';
import { OpenRouterPlatformTransport } from '../transport/openRouterPlatformTransport';
import { registerCustomerRouteProvisioner } from '../transport/customerRouteProvisioner';
import type { RunFunding } from '../runFunding';

const funding = (over: Partial<RunFunding> = {}): RunFunding => ({
  route: 'api_key',
  connectionId: 'c1',
  provider: 'anthropic',
  fallback: 'stop',
  ownerUserId: 'u',
  billingUserId: 'u',
  resolvedAt: '2026-10-13T00:00:00.000Z',
  ...over,
});
const options = {
  timeoutMs: 1000,
  maxAttempts: 1,
  isRetryableError: () => false,
  computeBackoff: () => ({ ms: 0, honoredRetryAfter: false }),
  sleep: async () => undefined,
};
const okResponse = { choices: [{ message: { content: 'hi' } }], usage: {} };
function clientReturning(result: unknown) {
  const create = jest.fn(async () => {
    if (result instanceof Error) throw result;
    return result;
  });
  return { client: { chat: { completions: { create } } } as any, create };
}

describe('ApiKeyTransport', () => {
  afterEach(() => registerCustomerRouteProvisioner(null));

  it('sends on the customer\'s client, never the platform one, pinned to the customer\'s provider with fallbacks off', async () => {
    const customer = clientReturning(okResponse);
    const platform = clientReturning(okResponse);
    registerCustomerRouteProvisioner({ clientFor: async () => customer.client });
    const params: any = {
      model: 'anthropic/claude-sonnet-5.5',
      messages: [],
      provider: { order: ['x'], ignore: ['Google'], allow_fallbacks: true, require_parameters: true },
    };

    await new ApiKeyTransport(funding()).send(platform.client, 'm', params, options);

    expect(platform.create).not.toHaveBeenCalled();
    expect(customer.create).toHaveBeenCalledTimes(1);
    expect(params.provider).toEqual({ require_parameters: true, only: ['anthropic'], allow_fallbacks: false });
  });

  it.each([['anthropic', 'anthropic'], ['openai', 'openai'], ['google', 'google-ai-studio']])(
    'pins %s to the %s provider slug',
    async (provider, slug) => {
      const customer = clientReturning(okResponse);
      registerCustomerRouteProvisioner({ clientFor: async () => customer.client });
      const params: any = { messages: [], provider: {} };
      await new ApiKeyTransport(funding({ provider })).send({} as any, 'm', params, options);
      expect(params.provider.only).toEqual([slug]);
      expect(OPENROUTER_PROVIDER_SLUG[provider]).toBe(slug);
    },
  );

  it('fails with not_provisioned, touching no client, when nothing can mint the customer\'s client', async () => {
    const platform = clientReturning(okResponse);
    await expect(new ApiKeyTransport(funding()).send(platform.client, 'm', { messages: [] }, options)).rejects.toMatchObject({
      name: 'CustomerRouteError',
      code: 'not_provisioned',
    });
    expect(platform.create).not.toHaveBeenCalled();
  });

  it('fails closed for a connection or provider it cannot route', async () => {
    registerCustomerRouteProvisioner({ clientFor: async () => clientReturning(okResponse).client });
    await expect(new ApiKeyTransport(funding({ connectionId: undefined })).send({} as any, 'm', {}, options)).rejects.toMatchObject({ code: 'no_connection' });
    await expect(new ApiKeyTransport(funding({ provider: 'xai' })).send({} as any, 'm', {}, options)).rejects.toMatchObject({ code: 'unsupported_provider' });
    await expect(new ApiKeyTransport(funding({ provider: undefined })).send({} as any, 'm', {}, options)).rejects.toBeInstanceOf(CustomerRouteError);
  });

  it('surfaces a key failure as an error and never retries it on the platform client', async () => {
    const customer = clientReturning(Object.assign(new Error('401 invalid key'), { status: 401 }));
    const platform = clientReturning(okResponse);
    registerCustomerRouteProvisioner({ clientFor: async () => customer.client });
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    await expect(new ApiKeyTransport(funding()).send(platform.client, 'm', { messages: [], provider: {} }, options)).rejects.toThrow('401 invalid key');
    spy.mockRestore();
    expect(platform.create).not.toHaveBeenCalled();
  });

  it('does not let a provisioner failure reach the platform client either', async () => {
    const platform = clientReturning(okResponse);
    registerCustomerRouteProvisioner({ clientFor: async () => { throw new Error('openrouter key revoked'); } });
    await expect(new ApiKeyTransport(funding()).send(platform.client, 'm', { messages: [] }, options)).rejects.toThrow('openrouter key revoked');
    expect(platform.create).not.toHaveBeenCalled();
  });
});

describe('pickTransport', () => {
  it('uses the customer-key transport only for api_key funding', () => {
    expect(pickTransport(funding(), 'm')).toBeInstanceOf(ApiKeyTransport);
    expect(pickTransport(funding({ route: 'agentweb' }), 'm')).toBeInstanceOf(OpenRouterPlatformTransport);
    expect(pickTransport(undefined, 'm')).toBeInstanceOf(OpenRouterPlatformTransport);
  });

  it.each(['claude_subscription', 'codex_subscription'] as const)(
    'refuses a %s route rather than sending it out on AgentWeb\'s key',
    (route) => {
      expect(() => pickTransport(funding({ route }), 'm')).toThrow(expect.objectContaining({ code: 'unsupported_route' }));
    },
  );
});
