import { AgentModeService } from '../services/agentModeService';
import { getSecret } from '../utils/secretsManager';
import { recordUsage } from '../services/usageRecorderService';

// Mock the dependencies
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
jest.mock('../services/usageRecorderService', () => ({
  recordUsage: jest.fn(),
}));

// OpenRouter model ids are provider-prefixed slugs (e.g. "anthropic/claude-opus-4.8").
// They are the ONLY registry keys containing "/", which is the routing discriminator.
const OPENROUTER_MODELS = [
  'anthropic/claude-opus-4.8',
  'anthropic/claude-sonnet-4.6',
  'openai/gpt-5.5',
  'google/gemini-3.5-flash',
  'google/gemini-3.1-pro-preview',
];

describe('AgentModeService - OpenRouter gateway (ENG-9)', () => {
  let agentModeService: AgentModeService;

  beforeEach(() => {
    agentModeService = new AgentModeService();
    jest.clearAllMocks();
    delete process.env.OPENROUTER_API_KEY;
  });

  afterEach(() => {
    delete process.env.OPENROUTER_API_KEY;
  });

  describe('Model registry', () => {
    it('should include all OpenRouter slugs in the supported models for admins', async () => {
      const models = await agentModeService.getSupportedModels(true);
      for (const slug of OPENROUTER_MODELS) {
        expect(models).toContain(slug);
      }
    });

    it('should NOT include OpenRouter slugs for non-admins (staged rollout: $0 credits would 402)', async () => {
      const models = await agentModeService.getSupportedModels(false);
      for (const slug of OPENROUTER_MODELS) {
        expect(models).not.toContain(slug);
      }
    });

    it('should have null client initially for all OpenRouter models (lazy-loaded)', () => {
      const llmModels = (agentModeService as any).llmModels;
      for (const slug of OPENROUTER_MODELS) {
        expect(llmModels[slug]).toBeDefined();
        expect(llmModels[slug].client).toBeNull();
      }
    });

    it('should mirror temperature support of the direct-provider counterparts', () => {
      const llmModels = (agentModeService as any).llmModels;
      // Opus 4.8: temperature deprecated (matches anthropic.claude-opus-4-8)
      expect(llmModels['anthropic/claude-opus-4.8'].supportsTemperature).toBe(false);
      // gpt-5.5: no temperature (matches Azure gpt-5.5)
      expect(llmModels['openai/gpt-5.5'].supportsTemperature).toBe(false);
      expect(llmModels['anthropic/claude-sonnet-4.6'].supportsTemperature).toBe(true);
      expect(llmModels['google/gemini-3.5-flash'].supportsTemperature).toBe(true);
      expect(llmModels['google/gemini-3.1-pro-preview'].supportsTemperature).toBe(true);
    });

    it('should cap gpt-5.5 via OpenRouter at 128 tools (OpenAI chat-completions limit)', () => {
      const llmModels = (agentModeService as any).llmModels;
      expect(llmModels['openai/gpt-5.5'].maxTools).toBe(128);
    });

    it('should NOT flag OpenRouter models as vision-capable until verified empirically', () => {
      const llmModels = (agentModeService as any).llmModels;
      for (const slug of OPENROUTER_MODELS) {
        expect(llmModels[slug].supportsVision).toBeUndefined();
      }
    });

    it('should NOT leak OpenRouter anthropic slugs into getReportsModelOptions (anthropic.-prefix only)', async () => {
      const reportsModels = await agentModeService.getReportsModelOptions(true);
      expect(reportsModels).not.toContain('anthropic/claude-opus-4.8');
      expect(reportsModels).not.toContain('anthropic/claude-sonnet-4.6');
    });
  });

  describe('getOpenRouterClient key sourcing', () => {
    it('should use OPENROUTER_API_KEY from env when present', async () => {
      process.env.OPENROUTER_API_KEY = 'sk-or-env-test-key';

      const client = await (agentModeService as any).getOpenRouterClient();

      expect(client.apiKey).toBe('sk-or-env-test-key');
      expect(String(client.baseURL)).toBe('https://openrouter.ai/api/v1');
      expect(getSecret).not.toHaveBeenCalled();
    });

    it('should fall back to Secrets Manager (dev/AgentWeb/OpenRouter) when env is unset', async () => {
      (getSecret as jest.Mock).mockResolvedValue('sk-or-secret-test-key');

      const client = await (agentModeService as any).getOpenRouterClient();

      expect(getSecret).toHaveBeenCalledWith('dev/AgentWeb/OpenRouter');
      expect(client.apiKey).toBe('sk-or-secret-test-key');
    });

    it('should throw a clear error when no key exists in env or secrets', async () => {
      (getSecret as jest.Mock).mockResolvedValue('');

      await expect(
        (agentModeService as any).getOpenRouterClient()
      ).rejects.toThrow(/OpenRouter API key/i);
    });

    it('should reset the init promise on failure so a later call can retry', async () => {
      (getSecret as jest.Mock).mockRejectedValueOnce(new Error('secrets down'));
      await expect((agentModeService as any).getOpenRouterClient()).rejects.toThrow('secrets down');

      (getSecret as jest.Mock).mockResolvedValue('sk-or-recovered-key');
      const client = await (agentModeService as any).getOpenRouterClient();
      expect(client.apiKey).toBe('sk-or-recovered-key');
    });

    it('should cache the client as a singleton across calls', async () => {
      process.env.OPENROUTER_API_KEY = 'sk-or-env-test-key';

      const first = await (agentModeService as any).getOpenRouterClient();
      const second = await (agentModeService as any).getOpenRouterClient();

      expect(second).toBe(first);
    });
  });

  describe('getClientForModel routing', () => {
    it('should route slugs containing "/" to the OpenRouter client', async () => {
      const mockClient = { chat: { completions: { create: jest.fn() } } };
      const openRouterSpy = jest
        .spyOn(agentModeService as any, 'getOpenRouterClient')
        .mockResolvedValue(mockClient);
      const bedrockSpy = jest.spyOn(agentModeService as any, 'getBedrockClient');
      const vertexSpy = jest.spyOn(agentModeService as any, 'getVertexClient');
      const geminiSpy = jest.spyOn(agentModeService as any, 'getGeminiClient');

      const client = await agentModeService.getClientForModel('anthropic/claude-opus-4.8');

      expect(client).toBe(mockClient);
      expect(openRouterSpy).toHaveBeenCalled();
      expect(bedrockSpy).not.toHaveBeenCalled();
      expect(vertexSpy).not.toHaveBeenCalled();
      expect(geminiSpy).not.toHaveBeenCalled();
    });

    it('should keep existing dispatch untouched (behavior-preserving)', async () => {
      const bedrockSpy = jest
        .spyOn(agentModeService as any, 'getBedrockClient')
        .mockResolvedValue({ tag: 'bedrock' });
      const geminiSpy = jest
        .spyOn(agentModeService as any, 'getGeminiClient')
        .mockResolvedValue({ tag: 'gemini' });
      const openRouterSpy = jest.spyOn(agentModeService as any, 'getOpenRouterClient');

      await agentModeService.getClientForModel('anthropic.claude-opus-4-8');
      expect(bedrockSpy).toHaveBeenCalledWith('anthropic.claude-opus-4-8');

      await agentModeService.getClientForModel('gemini-3.5-flash');
      expect(geminiSpy).toHaveBeenCalled();

      expect(openRouterSpy).not.toHaveBeenCalled();
    });
  });

  describe('callLLM via OpenRouter', () => {
    const openRouterResponse = {
      choices: [{ message: { role: 'assistant', content: 'Hi from OpenRouter!' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
    };

    it('should lazy-load and cache the OpenRouter client on first callLLM', async () => {
      const mockCreate = jest.fn().mockResolvedValue(openRouterResponse);
      const mockClient = { chat: { completions: { create: mockCreate } } };
      jest.spyOn(agentModeService as any, 'getOpenRouterClient').mockResolvedValue(mockClient);

      const messages = [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'Hello' },
      ];

      const res = await (agentModeService as any).callLLM('anthropic/claude-opus-4.8', messages);

      expect(res).toBe(openRouterResponse);
      expect((agentModeService as any).getOpenRouterClient).toHaveBeenCalled();
      const llmModels = (agentModeService as any).llmModels;
      expect(llmModels['anthropic/claude-opus-4.8'].client).toBe(mockClient);
      // The slug passes through unmapped — OpenRouter receives its own model id.
      expect(mockCreate.mock.calls[0][0].model).toBe('anthropic/claude-opus-4.8');
    });

    it('should record usage with provider "openrouter"', async () => {
      const mockCreate = jest.fn().mockResolvedValue(openRouterResponse);
      jest
        .spyOn(agentModeService as any, 'getOpenRouterClient')
        .mockResolvedValue({ chat: { completions: { create: mockCreate } } });

      await (agentModeService as any).callLLM('google/gemini-3.5-flash', [
        { role: 'user', content: 'Hello' },
      ]);

      expect(recordUsage).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'google/gemini-3.5-flash',
          provider: 'openrouter',
          inputTokens: 11,
          outputTokens: 7,
        })
      );
    });

    it('should NOT pass temperature for OpenRouter models with supportsTemperature: false', async () => {
      const mockCreate = jest.fn().mockResolvedValue(openRouterResponse);
      jest
        .spyOn(agentModeService as any, 'getOpenRouterClient')
        .mockResolvedValue({ chat: { completions: { create: mockCreate } } });

      await (agentModeService as any).callLLM(
        'openai/gpt-5.5',
        [{ role: 'user', content: 'Hello' }],
        { temperature: 0.4 }
      );

      expect(mockCreate.mock.calls[0][0].temperature).toBeUndefined();
    });

    it('should still throw for unknown models (behavior-preserving)', async () => {
      await expect(
        (agentModeService as any).callLLM('nonexistent/model-xyz-unregistered', [
          { role: 'user', content: 'Hello' },
        ])
      ).rejects.toThrow(/Invalid model/);
    });

    it('should leave OpenRouter slugs unchanged through normalizeModelId', () => {
      for (const slug of OPENROUTER_MODELS) {
        expect((agentModeService as any).normalizeModelId(slug)).toBe(slug);
      }
    });
  });

  describe('estimateCost pricing for OpenRouter models', () => {
    it('should price OpenRouter models per their live per-1M rates', () => {
      const cost = (svc: any, model: string) => svc.estimateCost(model, 1_000_000, 1_000_000);
      const svc: any = agentModeService;
      expect(cost(svc, 'anthropic/claude-opus-4.8')).toBeCloseTo(5 + 25);
      expect(cost(svc, 'anthropic/claude-sonnet-4.6')).toBeCloseTo(3 + 15);
      expect(cost(svc, 'openai/gpt-5.5')).toBeCloseTo(5 + 30);
      expect(cost(svc, 'google/gemini-3.5-flash')).toBeCloseTo(1.5 + 9);
      expect(cost(svc, 'google/gemini-3.1-pro-preview')).toBeCloseTo(2 + 12);
    });
  });
});
