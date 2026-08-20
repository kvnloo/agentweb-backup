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
