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
const listUsableForUser = jest.fn();
jest.mock('../services/funding/llmConnectionService', () => ({
  getLlmConnectionService: () => ({ listUsableForUser }),
}));
const getFundingFlags = jest.fn();
jest.mock('../services/funding/fundingFlags', () => ({
  getFundingFlags: (...a: unknown[]) => getFundingFlags(...a),
}));

import { AgentModeService } from '../services/agentModeService';
import { recordLlmUsage } from '../services/funding/recordLlmUsage';
import { withRunFunding, type RunFunding } from '../services/funding/runFunding';
import { registerCustomerRouteProvisioner } from '../services/funding/transport/customerRouteProvisioner';

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
    service.callLLM(model, [{ role: 'user', content: 'Hello' }], { usageContext: { userId: 'member-1', feature } as any, ...extra }),
  );
const fundingSeen = () => (recordLlmUsage as jest.Mock).mock.calls.map((c: any[]) => c[0]);

describe('callLLM per-call funding (ENG-2108)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.OPENROUTER_API_KEY = 'platform-key';
    getFundingFlags.mockResolvedValue({ killSwitch: false, byok: { enabled: true, allowUserIds: ['*'] } });
    listUsableForUser.mockResolvedValue([connection]);
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

  it('keeps helper calls on AgentWeb even when a matching key exists', async () => {
    const { service, platformCreate, customerCreate } = setup();
    await call(service, CLAUDE, 'session_title:interactive');

    expect(customerCreate).not.toHaveBeenCalled();
    expect(platformCreate).toHaveBeenCalledTimes(1);
    expect(fundingSeen()).toEqual([expect.objectContaining({ route: 'agentweb' })]);
  });

  it('changes nothing when BYOK is off', async () => {
    getFundingFlags.mockResolvedValue({ killSwitch: false, byok: { enabled: false, allowUserIds: [] } });
    const { service, platformCreate, customerCreate } = setup();
    await call(service, CLAUDE, 'agent_task:interactive');

    expect(customerCreate).not.toHaveBeenCalled();
    expect(platformCreate).toHaveBeenCalledTimes(1);
    expect(listUsableForUser).not.toHaveBeenCalled();
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
});
