import { OPENROUTER_PROVIDER_PREFERENCES } from '../services/agentMode/openRouterRequestParams';
jest.mock('../services/db', () => ({
  getSession: jest.fn(),
  saveMessage: jest.fn(),
  updateSession: jest.fn(),
  getTask: jest.fn(),
  getTaskExecution: jest.fn(),
  getUserById: jest.fn(),
}));

jest.mock('aws-sdk', () => ({
  DynamoDB: {
    DocumentClient: jest.fn().mockImplementation(() => ({
      get: jest.fn(),
      put: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      scan: jest.fn(),
      query: jest.fn(),
    })),
  },
  SecretsManager: jest.fn(),
  S3: jest.fn().mockImplementation(() => ({
    upload: jest.fn().mockReturnValue({
      promise: jest.fn().mockResolvedValue({ Location: 'mock-url', Key: 'mock-key' }),
    }),
  })),
}));

jest.mock('../services/chatbotService');
jest.mock('../services/settingsService');
jest.mock('../utils/secretsManager');

jest.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: jest.fn().mockImplementation(() => ({ send: jest.fn() })),
  ConverseCommand: jest.fn(),
}));

jest.mock('../services/funding/recordLlmUsage', () => ({
  ...jest.requireActual('../services/funding/recordLlmUsage'),
  recordLlmUsage: jest.fn(),
}));
const routingStateFor = jest.fn();
jest.mock('../services/funding/llmConnectionService', () => ({
  getLlmConnectionService: () => ({ routingStateFor }),
}));
const getFundingFlags = jest.fn();
jest.mock('../services/funding/fundingFlags', () => ({
  getFundingFlags: (...a: unknown[]) => getFundingFlags(...a),
}));

import { AgentModeService, titleFromUserMessage } from '../services/agentModeService';
import { LEGACY_MODEL_ALIASES } from '../services/agentMode/llmModelRegistry';
import { recordLlmUsage } from '../services/funding/recordLlmUsage';
import { withRunFunding, type RunFunding } from '../services/funding/runFunding';
import { registerCustomerRouteProvisioner } from '../services/funding/transport/customerRouteProvisioner';
import { __resetCallFundingCacheForTests } from '../services/funding/callFunding';

/**
 * ENG-2108 (A2): callLLM funds each call from the key that actually pays, and the usage
 * record carries that same funding, not the run's ambient one.
 */
const CLAUDE = 'openrouter/anthropic/claude-sonnet-5.5';
const CLAUDE_HAIKU = 'openrouter/anthropic/claude-haiku-5.5';
const GEMINI = 'openrouter/google/gemini-3.5-flash-lite';

const run: RunFunding = {
  route: 'agentweb',
  fallback: 'stop',
  ownerUserId: 'member-1',
  billingUserId: 'member-1',
  resolvedAt: '2026-10-13T00:00:00.000Z',
};
const response = { id: 'gen-1', model: 'anthropic/claude-sonnet-5.5', choices: [{ message: { content: 'hi' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } };
const connection = { connectionId: 'c1', ownerUserId: 'owner-1', kind: 'api_key', provider: 'anthropic', status: 'active', ownedByCaller: false };

function setup() {
  const service = new AgentModeService();
  const platformCreate = jest.fn().mockResolvedValue(response);
  const customerCreate = jest.fn().mockResolvedValue(response);
  jest.spyOn(service, 'getOpenRouterClient').mockResolvedValue({ chat: { completions: { create: platformCreate } } } as any);
  registerCustomerRouteProvisioner({ clientFor: async () => ({ chat: { completions: { create: customerCreate } } }) as any });
  return { service, platformCreate, customerCreate };
}
const call = (service: AgentModeService, model: string, feature: string, extra: Record<string, unknown> = {}) =>
  withRunFunding(run, () =>
    service.callLLM(model, [{ role: 'user', content: 'Hello' }], {
      usageContext: { userId: 'member-1', feature } as any,
      customerRoutable: feature.startsWith('agent_task'),
      ...extra,
    }),
  );
const fundingSeen = () => (recordLlmUsage as jest.Mock).mock.calls.map((c: any[]) => c[0]);

describe('callLLM per-call funding (ENG-2108)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.OPENROUTER_API_KEY = 'platform-key';
    getFundingFlags.mockResolvedValue({ killSwitch: false, byok: { enabled: true, allowUserIds: ['*'] } });
    __resetCallFundingCacheForTests();
    // Provider-aware, like the real service: only the Anthropic key exists.
    routingStateFor.mockImplementation(async (_user: string, provider: string) =>
      provider === 'anthropic' ? { hasConnection: true, usable: [connection] } : { hasConnection: false, usable: [] },
    );
  });
  afterEach(() => registerCustomerRouteProvisioner(null));

  it('sends an agent call on the customer\'s key only, pinned to their provider, and records that funding', async () => {
    const { service, platformCreate, customerCreate } = setup();
    await call(service, CLAUDE, 'agent_task:interactive');

    expect(platformCreate).not.toHaveBeenCalled();
    expect(customerCreate).toHaveBeenCalledTimes(1);
    expect((customerCreate.mock.calls[0] as any[])[0].provider).toMatchObject({ only: ['anthropic'], allow_fallbacks: false });
    expect(fundingSeen()).toEqual([expect.objectContaining({ route: 'api_key', connectionId: 'c1', fundingPrincipalId: 'owner-1' })]);
  });

  it('keeps a call on AgentWeb, and records it as AgentWeb-funded, when no key matches the model\'s provider', async () => {
    const { service, platformCreate, customerCreate } = setup();
    await call(service, GEMINI, 'agent_task:interactive');

    expect(customerCreate).not.toHaveBeenCalled();
    expect(platformCreate).toHaveBeenCalledTimes(1);
    expect(fundingSeen()).toEqual([expect.objectContaining({ route: 'agentweb' })]);
  });

  it('keeps helper calls on AgentWeb even when a matching key exists, including ones that reuse the agent_task feature name', async () => {
    const { service, platformCreate, customerCreate } = setup();
    await call(service, CLAUDE, 'session_title:interactive');
    await call(service, CLAUDE, 'agent_task', { customerRoutable: false });

    expect(customerCreate).not.toHaveBeenCalled();
    expect(platformCreate).toHaveBeenCalledTimes(2);
    expect(fundingSeen()).toEqual([expect.objectContaining({ route: 'agentweb' }), expect.objectContaining({ route: 'agentweb' })]);
  });

  it('changes nothing when BYOK is off', async () => {
    getFundingFlags.mockResolvedValue({ killSwitch: false, byok: { enabled: false, allowUserIds: [] } });
    const { service, platformCreate, customerCreate } = setup();
    await call(service, CLAUDE, 'agent_task:interactive');

    expect(customerCreate).not.toHaveBeenCalled();
    expect(platformCreate).toHaveBeenCalledTimes(1);
    expect(routingStateFor).not.toHaveBeenCalled();
  });

  it('drops fallback models from another lab on a customer key, and keeps same-lab ones', async () => {
    const { service, customerCreate } = setup();
    await call(service, CLAUDE, 'agent_task:interactive', { fallbackModels: [GEMINI, CLAUDE_HAIKU] });

    const sent = (customerCreate.mock.calls[0] as any[])[0];
    expect(sent.models).toEqual(['anthropic/claude-haiku-5.5']);
  });

  it('leaves fallback models alone on AgentWeb-funded calls', async () => {
    const { service, platformCreate } = setup();
    await call(service, GEMINI, 'agent_task:interactive', { fallbackModels: [CLAUDE_HAIKU] });

    expect((platformCreate.mock.calls[0] as any[])[0].models).toEqual(['anthropic/claude-haiku-5.5']);
  });

  it('fails the call, never moving it to AgentWeb, when the customer key cannot be used', async () => {
    const { service, platformCreate, customerCreate } = setup();
    customerCreate.mockRejectedValue(Object.assign(new Error('401 invalid key'), { status: 401 }));
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    await expect(call(service, CLAUDE, 'agent_task:interactive')).rejects.toThrow('401 invalid key');
    spy.mockRestore();

    expect(platformCreate).not.toHaveBeenCalled();
    expect(recordLlmUsage).not.toHaveBeenCalled();
  });

  it('fails the call, never moving it to AgentWeb, when the provisioner cannot mint the customer client', async () => {
    const { service, platformCreate } = setup();
    registerCustomerRouteProvisioner({ clientFor: async () => { throw new Error('openrouter key revoked'); } });
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    await expect(call(service, CLAUDE, 'agent_task:interactive')).rejects.toThrow('openrouter key revoked');
    spy.mockRestore();
    expect(platformCreate).not.toHaveBeenCalled();
  });

  it('ENDS the call, and never serves it on AgentWeb, when the customer has a key that cannot serve (the headline bug)', async () => {
    const { service, platformCreate, customerCreate } = setup();
    // The customer has an Anthropic key, but it is not usable right now (invalid, pending, ...).
    routingStateFor.mockImplementation(async () => ({ hasConnection: true, usable: [] }));
    await expect(call(service, CLAUDE, 'agent_task:interactive')).rejects.toMatchObject({ code: 'connection_unavailable' });

    expect(platformCreate).not.toHaveBeenCalled();
    expect(customerCreate).not.toHaveBeenCalled();
    expect(recordLlmUsage).not.toHaveBeenCalled();
  });

  it('INTENDED: while the agent turn fails closed on a dead key, the helper calls around it (first-turn session title) stay AgentWeb-funded', async () => {
    const { service, platformCreate, customerCreate } = setup();
    routingStateFor.mockImplementation(async () => ({ hasConnection: true, usable: [] }));

    // The turn's own working call ends with the real reason and is never served on AgentWeb...
    await expect(call(service, CLAUDE, 'agent_task:interactive')).rejects.toMatchObject({ code: 'connection_unavailable' });
    expect(platformCreate).not.toHaveBeenCalled();

    // ...while the tiny helper call that runs before the turn (generateSessionTitle, feature 'session_title',
    // customerRoutable false) is AgentWeb-funded by design: it never looks the customer's connection up.
    await expect(call(service, CLAUDE, 'session_title')).resolves.toBeDefined();
    expect(platformCreate).toHaveBeenCalledTimes(1);
    expect(customerCreate).not.toHaveBeenCalled();
    expect(fundingSeen().map((f: any) => f.route)).toEqual(['agentweb']);
  });

  describe('the first-message title when the user\'s own key cannot serve the turn (ENG-2111)', () => {
    const MESSAGE = 'Plan a launch campaign for our new SaaS product';
    const ctxFor = { userId: 'member-1', feature: 'session_title' } as any;
    const deadKey = () => routingStateFor.mockImplementation(async () => ({ hasConnection: true, usable: [] }));

    it('is cut from the message with no AI call, so AgentWeb spends nothing on a turn that fails closed', async () => {
      const { service, platformCreate, customerCreate } = setup();
      deadKey();
      expect(await service.generateSessionTitle(MESSAGE, ctxFor, CLAUDE)).toBe(MESSAGE);
      expect(platformCreate).not.toHaveBeenCalled();
      expect(customerCreate).not.toHaveBeenCalled();
      expect(recordLlmUsage).not.toHaveBeenCalled();
    });

    it('also skips the AI call when the connection lookup fails (fails closed here too)', async () => {
      const { service, platformCreate } = setup();
      const err = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      routingStateFor.mockRejectedValue(Object.assign(new Error('store down'), { code: 'ThrottlingException' }));
      expect(await service.generateSessionTitle(MESSAGE, ctxFor, CLAUDE)).toBe(MESSAGE);
      expect(platformCreate).not.toHaveBeenCalled();
      err.mockRestore();
    });

    it('resolves a legacy model id to the same provider the turn uses', async () => {
      const { service, platformCreate } = setup();
      deadKey();
      const legacy = Object.keys(LEGACY_MODEL_ALIASES).find((k) => (service as any).llmModels[(service as any).normalizeModelId(k)]?.provider === 'anthropic');
      expect(legacy).toBeDefined(); // the registry must still have a legacy alias for an anthropic model, or this test proves nothing
      expect(await service.generateSessionTitle(MESSAGE, ctxFor, legacy!)).toBe(MESSAGE);
      expect(platformCreate).not.toHaveBeenCalled();
    });

    it('still makes the AI title call for everyone else: no connection, BYOK off, no turn model, an unknown model', async () => {
      const cases: Array<[string, () => void, string | undefined]> = [
        ['no connection for the provider', () => routingStateFor.mockImplementation(async () => ({ hasConnection: false, usable: [] })), CLAUDE],
        ['BYOK off', () => { getFundingFlags.mockResolvedValue({ killSwitch: false, byok: { enabled: false, allowUserIds: [] } }); deadKey(); }, CLAUDE],
        ['no turn model passed (other callers)', () => deadKey(), undefined],
        ['a model the registry does not know', () => deadKey(), 'no-such-model'],
      ];
      for (const [label, arrange, model] of cases) {
        jest.clearAllMocks();
        getFundingFlags.mockResolvedValue({ killSwitch: false, byok: { enabled: true, allowUserIds: ['*'] } });
        __resetCallFundingCacheForTests();
        const { service, platformCreate } = setup();
        arrange();
        await service.generateSessionTitle(MESSAGE, ctxFor, model);
        expect({ label, aiCalls: platformCreate.mock.calls.length }).toEqual({ label, aiCalls: 1 });
      }
    });

    it('a message-derived title is clean and bounded', () => {
      expect(titleFromUserMessage('  **Hello**\n\n`world`  ')).toBe('Hello world');
      expect(titleFromUserMessage('')).toBe('Marketing Task');
      const long = titleFromUserMessage('word '.repeat(40));
      expect(long.length).toBeLessThanOrEqual(60);
      expect(long.endsWith(' ')).toBe(false);
    });
  });

  it('ENDS the call, and never serves it on AgentWeb, when the connection lookup fails', async () => {
    const { service, platformCreate } = setup();
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    routingStateFor.mockRejectedValue(Object.assign(new Error('x'), { code: 'ThrottlingException' }));
    await expect(call(service, CLAUDE, 'agent_task:interactive')).rejects.toMatchObject({ code: 'lookup_failed' });
    spy.mockRestore();

    expect(platformCreate).not.toHaveBeenCalled();
  });

  it('rejects an unknown fallback model on a customer key exactly as on an AgentWeb call', async () => {
    const { service } = setup();
    await expect(call(service, CLAUDE, 'agent_task:interactive', { fallbackModels: ['openrouter/no/such-model'] })).rejects.toThrow(/fallback model/i);
  });

  it('does not let a call that omits customerRoutable use a customer key (the default is off)', async () => {
    const { service, platformCreate, customerCreate } = setup();
    await withRunFunding(run, () =>
      service.callLLM(CLAUDE, [{ role: 'user', content: 'Hello' }], { usageContext: { userId: 'member-1', feature: 'agent_task:interactive' } as any }),
    );

    expect(customerCreate).not.toHaveBeenCalled();
    expect(platformCreate).toHaveBeenCalledTimes(1);
    expect(routingStateFor).not.toHaveBeenCalled();
    expect(fundingSeen()).toEqual([expect.objectContaining({ route: 'agentweb' })]);
  });

  it('judges a fallback model\'s lab by its current id, so a legacy alias for another lab is dropped', async () => {
    const { service, customerCreate } = setup();
    // 'gemini-2.5-flash' is a legacy alias that now resolves to a Google model.
    await call(service, CLAUDE, 'agent_task:interactive', { fallbackModels: ['gemini-2.5-flash'] });

    expect((customerCreate.mock.calls[0] as any[])[0].models).toBeUndefined();
  });
});

