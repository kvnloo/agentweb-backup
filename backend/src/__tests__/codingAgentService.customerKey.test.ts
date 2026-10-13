/**
 * ENG-2108 (A2 PR 2): a coding-agent turn paid for with the customer's own key.
 * Anthropic keys are called directly; only an outage moves the turn to OpenRouter, still
 * on the customer's key. Nothing here may reach the platform client or the AgentWeb rails.
 */
const mockDirectCreate = jest.fn();
const mockAnthropicCtor = jest.fn();
jest.mock('@anthropic-ai/sdk', () => {
  const actual = jest.requireActual('@anthropic-ai/sdk');
  const Ctor: any = function (config: unknown) {
    mockAnthropicCtor(config);
    return { messages: { create: mockDirectCreate } };
  };
  // The real error classes, so the tests use the shapes the SDK really throws.
  Ctor.APIConnectionError = actual.APIConnectionError;
  Ctor.APIConnectionTimeoutError = actual.APIConnectionTimeoutError;
  return { __esModule: true, default: Ctor };
});
// eslint-disable-next-line @typescript-eslint/no-var-requires
const RealAnthropic = jest.requireActual('@anthropic-ai/sdk');
jest.mock('../services/usageRecorderService', () => ({
  ...jest.requireActual('../services/usageRecorderService'),
  recordUsage: jest.fn(async () => undefined),
}));
jest.mock('../mcp/server/httpClient', () => ({ mcpFetch: jest.fn() }));
jest.mock('axios', () => {
  const actual = jest.requireActual('axios');
  return { __esModule: true, default: { ...actual, get: jest.fn(), post: jest.fn(), put: jest.fn(), patch: jest.fn(), delete: jest.fn() } };
});
jest.mock('../utils/secretsManager', () => ({
  ...jest.requireActual('../utils/secretsManager'),
  getGitHubOrgToken: jest.fn(async () => ({ token: 'gh-test-token', org: 'AgentWebPro' })),
  getSecret: jest.fn(async () => 'platform-or-key'),
}));
jest.mock('../services/v0Service', () => ({
  getLandingPageById: jest.fn(),
  getLandingPagesByOwner: jest.fn(),
  canUserEditLandingPage: jest.fn(),
}));
const mockResolveCallFunding = jest.fn();
jest.mock('../services/funding/callFunding', () => ({
  resolveCallFunding: (...a: unknown[]) => mockResolveCallFunding(...a),
}));
const mockGetKeyMaterial = jest.fn();
jest.mock('../services/funding/llmConnectionService', () => ({
  getLlmConnectionService: () => ({ getKeyMaterial: mockGetKeyMaterial }),
}));
const mockRecordLlmUsage = jest.fn();
jest.mock('../services/funding/recordLlmUsage', () => ({
  ...jest.requireActual('../services/funding/recordLlmUsage'),
  recordLlmUsage: (...a: unknown[]) => mockRecordLlmUsage(...a),
}));

import { runCodingAgent, _setOpenRouterClientForTest, toNativeAnthropicModel, CodingAgentContext } from '../services/codingAgentService';
import { recordUsage } from '../services/usageRecorderService';
import { mcpFetch } from '../mcp/server/httpClient';
import { registerCustomerRouteProvisioner } from '../services/funding/transport/customerRouteProvisioner';
import type { RunFunding } from '../services/funding/runFunding';

const context: CodingAgentContext = {
  pageId: 'page-1',
  userId: 'user-1',
  sessionId: 'session-1',
  llmModel: 'anthropic.claude-sonnet-4-6',
};
const customerFunding = (over: Partial<RunFunding> = {}): RunFunding => ({
  route: 'api_key',
  connectionId: 'conn-1',
  provider: 'anthropic',
  fallback: 'stop',
  ownerUserId: 'user-1',
  billingUserId: 'user-1',
  fundingPrincipalId: 'owner-1',
  resolvedAt: '2026-10-13T00:00:00.000Z',
  ...over,
});
const finalTurn = {
  content: [{ type: 'tool_use', id: 'tu', name: 'report_to_user', input: { message: 'Done', status: 'success' } }],
  stop_reason: 'tool_use',
  usage: { input_tokens: 100, output_tokens: 20 },
};

describe('coding agent on the customer\'s own key (ENG-2108)', () => {
  const platformCreate = jest.fn();
  const orCreate = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    (mcpFetch as jest.Mock).mockReset();
    (mcpFetch as jest.Mock).mockResolvedValue({ files: [{ path: 'app/page.tsx', size: 10 }] });
    _setOpenRouterClientForTest({ messages: { create: platformCreate } } as any);
    mockGetKeyMaterial.mockResolvedValue({ provider: 'anthropic', apiKey: 'sk-ant-customer' });
    mockResolveCallFunding.mockResolvedValue(customerFunding());
    registerCustomerRouteProvisioner({
      clientFor: jest.fn(),
      messagesClientFor: async () => ({ messages: { create: orCreate } }),
    });
  });
  afterEach(() => registerCustomerRouteProvisioner(null));
  afterAll(() => _setOpenRouterClientForTest(null));

  it('calls Anthropic directly with the customer\'s key and the native model id, with none of AgentWeb\'s OpenRouter fields', async () => {
    mockDirectCreate.mockResolvedValueOnce(finalTurn);
    await runCodingAgent('edit', context);

    expect(mockAnthropicCtor).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'sk-ant-customer' }));
    // An explicit host and no auth token, so the environment can never redirect the key.
    expect(mockAnthropicCtor.mock.calls[0][0]).toMatchObject({ baseURL: 'https://api.anthropic.com', authToken: null });
    const sent = mockDirectCreate.mock.calls[0][0];
    expect(sent.model).toBe('claude-sonnet-4-6');
    for (const field of ['provider', 'plugins', 'fallbacks', 'session_id']) expect(sent).not.toHaveProperty(field);
    expect(platformCreate).not.toHaveBeenCalled();
    expect(orCreate).not.toHaveBeenCalled();
  });

  it('records the turn in the attempt journal with the funding that paid, and never on the AgentWeb rails or the cap total', async () => {
    mockDirectCreate.mockResolvedValueOnce(finalTurn);
    const result = await runCodingAgent('edit', context);

    expect(mockRecordLlmUsage).toHaveBeenCalledTimes(1);
    const [funding, ctx] = mockRecordLlmUsage.mock.calls[0];
    expect(funding).toMatchObject({ route: 'api_key', connectionId: 'conn-1', fundingPrincipalId: 'owner-1' });
    expect(ctx).toMatchObject({ userId: 'user-1', sessionId: 'session-1', feature: 'coding_agent', inputTokens: 100, outputTokens: 20, provider: 'anthropic' });
    expect(recordUsage).not.toHaveBeenCalled();
    // The callers charge usageTotals to the per-user cap, so a customer-funded run has none.
    expect(result.usageTotals).toBeUndefined();
  });

  it.each([[529], [503], [500]])('moves a turn to OpenRouter, on the customer\'s key and pinned to Anthropic, when Anthropic returns %s', async (status) => {
    mockDirectCreate.mockRejectedValueOnce(Object.assign(new Error('overloaded'), { status }));
    orCreate.mockResolvedValueOnce(finalTurn);
    await runCodingAgent('edit', context);

    const sent = orCreate.mock.calls[0][0];
    expect(sent.model).toBe('anthropic/claude-sonnet-4.6');
    expect(sent.provider).toEqual({ require_parameters: true, only: ['anthropic'], allow_fallbacks: false });
    for (const field of ['plugins', 'fallbacks']) expect(sent).not.toHaveProperty(field);
    expect(platformCreate).not.toHaveBeenCalled();
    expect(recordUsage).not.toHaveBeenCalled();
  });

  it.each([
    ['a connection error', () => new RealAnthropic.APIConnectionError({ message: 'Connection error.' })],
    ['a timeout', () => new RealAnthropic.APIConnectionTimeoutError({ message: 'Request timed out.' })],
    ['a reset connection', () => Object.assign(new Error('socket hang up'), { cause: { code: 'ECONNRESET' } })],
  ])('moves a turn to OpenRouter on %s, which carry no HTTP status', async (_label, makeError) => {
    mockDirectCreate.mockRejectedValueOnce(makeError());
    orCreate.mockResolvedValueOnce(finalTurn);
    await runCodingAgent('edit', context);

    expect(orCreate).toHaveBeenCalledTimes(1);
    expect(platformCreate).not.toHaveBeenCalled();
  });

  it.each([
    ['revoked', 'not_usable'],
    ['switched off', 'byok_disabled'],
  ])('fails the turn, without trying OpenRouter, when the key is %s', async (_label, code) => {
    // The service's own error class, whose name contains "Connection".
    const error = Object.assign(new Error(code), { name: 'LlmConnectionError', code });
    mockGetKeyMaterial.mockRejectedValue(error);
    const result = await runCodingAgent('edit', context);

    expect(result.success).toBe(false);
    expect(orCreate).not.toHaveBeenCalled();
    expect(platformCreate).not.toHaveBeenCalled();
  });

  it.each([
    ['an HTTP 503', () => Object.assign(new Error('kms unavailable'), { status: 503 })],
    ['a connection error', () => new RealAnthropic.APIConnectionError({ message: 'Connection error.' })],
    ['a reset connection', () => Object.assign(new Error('reset'), { cause: { code: 'ECONNRESET' } })],
  ])('fails the turn, without trying OpenRouter, when reading the key itself fails with %s', async (_label, makeError) => {
    // Errors from the key store look like outages but are not the provider being down: a
    // key that cannot be read must fail the turn, not move it to another route.
    mockGetKeyMaterial.mockRejectedValue(makeError());
    orCreate.mockResolvedValue(finalTurn);
    const result = await runCodingAgent('edit', context);

    expect(result.success).toBe(false);
    expect(mockDirectCreate).not.toHaveBeenCalled();
    expect(orCreate).not.toHaveBeenCalled();
    expect(platformCreate).not.toHaveBeenCalled();
  });

  it('refuses a subscription route rather than running its turns on AgentWeb\'s key', async () => {
    mockResolveCallFunding.mockResolvedValue(customerFunding({ route: 'claude_subscription' }));
    // Every client would succeed, so only the refusal itself can make the turn fail.
    mockDirectCreate.mockResolvedValue(finalTurn);
    orCreate.mockResolvedValue(finalTurn);
    platformCreate.mockResolvedValue(finalTurn);
    const result = await runCodingAgent('edit', context);

    expect(result.success).toBe(false);
    expect(mockDirectCreate).not.toHaveBeenCalled();
    expect(orCreate).not.toHaveBeenCalled();
    expect(platformCreate).not.toHaveBeenCalled();
    expect(recordUsage).not.toHaveBeenCalled();
  });

  it.each([[401], [403], [429], [400]])('does not retry a %s on OpenRouter, because the same key fails there too', async (status) => {
    mockDirectCreate.mockRejectedValueOnce(Object.assign(new Error('key problem'), { status }));
    const result = await runCodingAgent('edit', context);

    expect(result.success).toBe(false);
    expect(orCreate).not.toHaveBeenCalled();
    expect(platformCreate).not.toHaveBeenCalled();
    expect(recordUsage).not.toHaveBeenCalled();
  });

  it('fails the turn, never using AgentWeb\'s key, when Anthropic is down and there is no OpenRouter leg', async () => {
    registerCustomerRouteProvisioner({ clientFor: jest.fn() });
    mockDirectCreate.mockRejectedValueOnce(Object.assign(new Error('overloaded'), { status: 529 }));
    const result = await runCodingAgent('edit', context);

    expect(result.success).toBe(false);
    expect(platformCreate).not.toHaveBeenCalled();
    expect(recordUsage).not.toHaveBeenCalled();
  });

  it('uses the OpenRouter leg alone for a customer key from another provider', async () => {
    mockResolveCallFunding.mockResolvedValue(customerFunding({ provider: 'openai' }));
    orCreate.mockResolvedValueOnce(finalTurn);
    await runCodingAgent('edit', context);

    expect(mockDirectCreate).not.toHaveBeenCalled();
    expect(orCreate.mock.calls[0][0].provider).toMatchObject({ only: ['openai'], allow_fallbacks: false });
    expect(platformCreate).not.toHaveBeenCalled();
  });

  it('fails the turn, never using AgentWeb\'s key, when the key cannot be read (revoked)', async () => {
    mockGetKeyMaterial.mockRejectedValue(Object.assign(new Error('not usable'), { code: 'not_usable' }));
    const result = await runCodingAgent('edit', context);

    expect(result.success).toBe(false);
    expect(mockDirectCreate).not.toHaveBeenCalled();
    expect(platformCreate).not.toHaveBeenCalled();
    expect(recordUsage).not.toHaveBeenCalled();
  });

  it('is exactly today\'s behavior when the call stays on AgentWeb', async () => {
    mockResolveCallFunding.mockResolvedValue({ ...customerFunding(), route: 'agentweb' });
    platformCreate.mockResolvedValueOnce(finalTurn);
    const result = await runCodingAgent('edit', context);

    expect(platformCreate).toHaveBeenCalledTimes(1);
    expect(mockDirectCreate).not.toHaveBeenCalled();
    expect(recordUsage).toHaveBeenCalledTimes(1);
    expect(mockRecordLlmUsage).not.toHaveBeenCalled();
    expect(result.usageTotals).toBeDefined();
  });

  it('asks for a funding decision per turn, for the model\'s lab, as the agent loop', async () => {
    mockDirectCreate.mockResolvedValueOnce(finalTurn);
    await runCodingAgent('edit', context);

    expect(mockResolveCallFunding).toHaveBeenCalledWith(undefined, {
      userId: 'user-1',
      modelLab: 'anthropic',
      customerRoutable: true,
      canCallAnthropicDirect: true,
    });
  });
});

describe('toNativeAnthropicModel', () => {
  it('derives the native Anthropic id from the OpenRouter slug, and only for Anthropic models', () => {
    expect(toNativeAnthropicModel('anthropic.claude-sonnet-4-6')).toBe('claude-sonnet-4-6');
    expect(toNativeAnthropicModel('anthropic.claude-opus-4-8')).toBe('claude-opus-4-8');
    expect(toNativeAnthropicModel('gpt-5.4')).toBeUndefined();
  });
});
