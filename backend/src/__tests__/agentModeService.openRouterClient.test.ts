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

jest.mock('openai', () => jest.fn().mockImplementation((config: any) => ({ _config: config })));

import { AgentModeService } from '../services/agentModeService';
import { getSecret } from '../utils/secretsManager';
import { resolveOpenRouterUpstreamModelId } from '../utils/openRouterGatewayContract';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const MockOpenAI = require('openai') as jest.Mock;
const mockGetSecret = getSecret as jest.Mock;

describe('AgentModeService - OpenRouter client initialization (ENG-9)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.OPENROUTER_API_KEY = 'test-openrouter-key';
  });

  afterEach(() => {
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_GATEWAY_TASK_CLASSES;
  });

  function openRouterConfig(): any {
    return MockOpenAI.mock.calls.find((call: any[]) => call[0]?.baseURL?.includes('openrouter.ai'))?.[0];
  }

  it('uses the OpenRouter API base URL', async () => {
    const service = new AgentModeService();
    await service.getOpenRouterClient();
    expect(openRouterConfig()?.baseURL).toBe('https://openrouter.ai/api/v1');
  });

  it('passes OPENROUTER_API_KEY to the client', async () => {
    const service = new AgentModeService();
    await service.getOpenRouterClient();
    expect(openRouterConfig()?.apiKey).toBe('test-openrouter-key');
  });

  it('sends HTTP-Referer and X-Title attribution headers', async () => {
    const service = new AgentModeService();
    await service.getOpenRouterClient();
    expect(openRouterConfig()?.defaultHeaders).toEqual(
      expect.objectContaining({
        'HTTP-Referer': expect.any(String),
        'X-Title': expect.any(String),
      })
    );
  });

  it('disables SDK retries and applies a bounded timeout', async () => {
    const service = new AgentModeService();
    await service.getOpenRouterClient();
    expect(openRouterConfig()).toEqual(expect.objectContaining({
      maxRetries: 0,
      timeout: 5 * 60 * 1000,
    }));
  });

  it('caches the client — a second call does not construct a new one', async () => {
    const service = new AgentModeService();
    const first = await service.getOpenRouterClient();
    const callsBeforeSecond = MockOpenAI.mock.calls.filter((call: any[]) =>
      call[0]?.baseURL?.includes('openrouter.ai')
    ).length;
    const second = await service.getOpenRouterClient();
    const callsAfterSecond = MockOpenAI.mock.calls.filter((call: any[]) =>
      call[0]?.baseURL?.includes('openrouter.ai')
    ).length;
    expect(second).toBe(first);
    // Only the OpenRouter-baseURL construction count matters — the constructor
    // also eagerly builds several Azure OpenAI clients via the same mocked ctor.
    expect(callsAfterSecond).toBe(callsBeforeSecond);
  });

  it('falls back to Secrets Manager when OPENROUTER_API_KEY is unset', async () => {
    delete process.env.OPENROUTER_API_KEY;
    mockGetSecret.mockResolvedValue('secrets-manager-openrouter-key');
    const service = new AgentModeService();
    await service.getOpenRouterClient();
    expect(mockGetSecret).toHaveBeenCalledWith(expect.stringMatching(/AgentWeb\/OpenRouter$/));
    expect(openRouterConfig()?.apiKey).toBe('secrets-manager-openrouter-key');
  });

  it('throws if no key is available from env or secrets', async () => {
    delete process.env.OPENROUTER_API_KEY;
    mockGetSecret.mockResolvedValue(undefined);
    const service = new AgentModeService();
    await expect(service.getOpenRouterClient()).rejects.toThrow(/api key/i);
  });
});

describe('AgentModeService.getClientForModel — openrouter/* routing (ENG-9)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.OPENROUTER_API_KEY = 'test-openrouter-key';
  });

  afterEach(() => {
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_GATEWAY_TASK_CLASSES;
  });

  it('routes an openrouter/*-prefixed model id to the OpenRouter client', async () => {
    const service = new AgentModeService();
    const client = await service.getClientForModel('openrouter/openai/gpt-4o-mini');
    expect((client as any)._config?.baseURL).toBe('https://openrouter.ai/api/v1');
  });

  // ENG-9: the broader model roster requested 2026-08-17 (grok + open-source
  // models). One parameterized test, not one per model — the routing logic is
  // shared (prefix match), so per-model coverage would just re-test the same
  // branch ten times. Each id is also asserted present in the registry with the
  // live-sourced flags from GET /api/v1/models (see the registry comment).
  const NEW_ROSTER_MODELS = [
    'openrouter/x-ai/grok-4.6',
    'openrouter/deepseek/deepseek-v4-pro',
    'openrouter/deepseek/deepseek-v4-flash',
    'openrouter/qwen/qwen3.8-max',
    'openrouter/mistralai/mistral-small-2603',
    'openrouter/moonshotai/kimi-k3',
    'openrouter/moonshotai/kimi-k2.7-code',
    'openrouter/z-ai/glm-5.2',
    'openrouter/z-ai/glm-4.7-flash',
  ];

  it.each(NEW_ROSTER_MODELS)('routes %s to the OpenRouter client', async (modelId) => {
    const service = new AgentModeService();
    expect((service as any).llmModels[modelId]).toBeDefined();
    const client = await service.getClientForModel(modelId);
    expect((client as any)._config?.baseURL).toBe('https://openrouter.ai/api/v1');
  });

  it('sends every registered OpenRouter model to the upstream API without the internal prefix', async () => {
    const service = new AgentModeService();
    const create = jest.fn().mockResolvedValue({ choices: [], usage: {} });
    const models = (service as any).llmModels;
    const openRouterModels = Object.keys(models).filter((modelId) => modelId.startsWith('openrouter/'));

    expect(openRouterModels.length).toBeGreaterThan(0);

    for (const modelId of openRouterModels) {
      create.mockClear();
      models[modelId].client = { chat: { completions: { create } } };

      await service.callLLM(modelId, [{ role: 'user', content: 'Hello' }]);

      expect(create).toHaveBeenCalledWith(expect.objectContaining({
        model: modelId.slice('openrouter/'.length),
      }));
    }
  });

  it('keeps non-OpenRouter model IDs unchanged in provider requests', async () => {
    const service = new AgentModeService();
    const create = jest.fn().mockResolvedValue({ choices: [], usage: {} });
    const models = (service as any).llmModels;
    models['gpt-5.4'].client = { chat: { completions: { create } } };

    await service.callLLM('gpt-5.4', [{ role: 'user', content: 'Hello' }]);

    expect(create).toHaveBeenCalledWith(expect.objectContaining({ model: 'gpt-5.4' }));
  });

  it('canary-routes an interactive GPT call through OpenRouter', async () => {
    process.env.OPENROUTER_GATEWAY_TASK_CLASSES = 'interactive_chat';
    const service = new AgentModeService();
    const create = jest.fn().mockResolvedValue({ choices: [], usage: {} });
    jest.spyOn(service, 'getOpenRouterClient').mockResolvedValue({
      chat: { completions: { create } },
    } as any);

    await service.callLLM(
      'gpt-5.4',
      [{ role: 'user', content: 'Hello' }],
      { taskClass: 'interactive_chat', temperature: 0.1 } as any,
    );

    const request = create.mock.calls[0][0];
    expect(request).toEqual(expect.objectContaining({
      model: 'openai/gpt-5.4',
      provider: { allow_fallbacks: true, require_parameters: true },
    }));
    expect(request).not.toHaveProperty('temperature');
  });

  it('has a verified gateway mapping for every selectable direct-provider model', () => {
    const service = new AgentModeService();
    const directModelIds = Object.entries((service as any).llmModels)
      .filter(([, config]: any) => !config.isLive)
      .map(([modelId]) => modelId)
      .filter((modelId) => !modelId.startsWith('openrouter/'));

    expect(directModelIds.length).toBeGreaterThan(0);
    for (const modelId of directModelIds) {
      expect(resolveOpenRouterUpstreamModelId(modelId)).toMatch(/^[^/\s]+\/[^/\s]+$/);
    }
  });

  it('canary-routes an interactive Gemini call through OpenRouter', async () => {
    process.env.OPENROUTER_GATEWAY_TASK_CLASSES = 'interactive_chat';
    const service = new AgentModeService();
    const create = jest.fn().mockResolvedValue({ choices: [], usage: {} });
    jest.spyOn(service, 'getOpenRouterClient').mockResolvedValue({
      chat: { completions: { create } },
    } as any);

    await service.callLLM(
      'gemini-3.7-flash',
      [{ role: 'user', content: 'Hello' }],
      { taskClass: 'interactive_chat', max_completion_tokens: 321 } as any,
    );

    const request = create.mock.calls[0][0];
    expect(request).toEqual(expect.objectContaining({
      model: 'google/gemini-3.7-flash',
      max_tokens: 321,
    }));
    expect(request).not.toHaveProperty('max_completion_tokens');
  });

  it('preserves provider-native token and temperature fields while the canary is disabled', async () => {
    const service = new AgentModeService();
    const create = jest.fn().mockResolvedValue({ choices: [], usage: {} });
    (service as any).llmModels['gpt-5.4'].client = { chat: { completions: { create } } };

    await service.callLLM(
      'gpt-5.4',
      [{ role: 'user', content: 'Hello' }],
      { max_completion_tokens: 321, temperature: 0.1 } as any,
    );

    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      model: 'gpt-5.4',
      max_completion_tokens: 321,
      temperature: 0.1,
    }));
  });

  it('preserves Claude conversation caching and stickiness through OpenRouter', async () => {
    process.env.OPENROUTER_GATEWAY_TASK_CLASSES = 'interactive_chat';
    const service = new AgentModeService();
    const create = jest.fn().mockResolvedValue({ choices: [], usage: {} });
    jest.spyOn(service, 'getOpenRouterClient').mockResolvedValue({
      chat: { completions: { create } },
    } as any);

    await service.callLLM(
      'anthropic.claude-sonnet-5',
      [{ role: 'user', content: 'Hello' }],
      {
        taskClass: 'interactive_chat',
        humanPaced: true,
        usageContext: { userId: 'user-1', sessionId: 'session-1', feature: 'agent_task' },
      } as any,
    );

    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      model: 'anthropic/claude-sonnet-5',
      session_id: 'session-1',
      cache_control: { type: 'ephemeral', ttl: '1h' },
    }));
  });

  it('does not add an AgentWeb retry loop on top of OpenRouter provider fallback', async () => {
    process.env.OPENROUTER_GATEWAY_TASK_CLASSES = 'interactive_chat';
    const service = new AgentModeService();
    const error = Object.assign(new Error('rate limited'), { status: 429 });
    const create = jest.fn().mockRejectedValue(error);
    jest.spyOn(service, 'getOpenRouterClient').mockResolvedValue({
      chat: { completions: { create } },
    } as any);

    await expect(service.callLLM(
      'gpt-5.5',
      [{ role: 'user', content: 'Hello' }],
      { taskClass: 'interactive_chat' } as any,
    )).rejects.toBe(error);

    expect(create).toHaveBeenCalledTimes(1);
  });

  // 2026-08-19: was adminOnly: true on every new-roster entry (gated as
  // unproven-in-our-stack). Harsha: "i'm fine to include open source /
  // open router stuff for all users not just isadmin" — removed from all
  // of them, matching the already-smoke-tested starter model.
  it('does NOT gate any new-roster entry adminOnly anymore — every OpenRouter model is opt-in to everyone', () => {
    const service = new AgentModeService();
    for (const modelId of NEW_ROSTER_MODELS) {
      expect((service as any).llmModels[modelId].adminOnly).toBeFalsy();
    }
    expect((service as any).llmModels['openrouter/openai/gpt-4o-mini'].adminOnly).toBeFalsy();
  });

  it('does not change existing prefix routing (bedrock/azure/vertex/gemini unaffected)', async () => {
    process.env.GEMINI_API_KEY = 'test-gemini-key';
    try {
      const service = new AgentModeService();
      expect((await service.getClientForModel('gemini-3.5-flash') as any)._config?.baseURL).toContain(
        'generativelanguage'
      );
    } finally {
      delete process.env.GEMINI_API_KEY;
    }
  });
});
