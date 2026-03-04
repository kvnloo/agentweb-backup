import { AgentModeService } from '../services/agentModeService';

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

// Mock Bedrock modules
const mockBedrockInvoke = jest.fn();
jest.mock('@langchain/aws', () => ({
  ChatBedrockConverse: jest.fn().mockImplementation(() => ({
    invoke: mockBedrockInvoke,
  })),
}));

jest.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: jest.fn().mockImplementation(() => ({})),
}));

jest.mock('@langchain/core/messages', () => ({
  HumanMessage: jest.fn().mockImplementation((content: string) => ({ role: 'user', content })),
  AIMessage: jest.fn().mockImplementation((content: string | object) => ({ role: 'assistant', ...(typeof content === 'string' ? { content } : content) })),
  SystemMessage: jest.fn().mockImplementation((content: string) => ({ role: 'system', content })),
  ToolMessage: jest.fn().mockImplementation((content: string) => ({ role: 'tool', content })),
}));

describe('AgentModeService - Claude Sonnet 4.5 Support', () => {
  let agentModeService: AgentModeService;

  beforeEach(() => {
    agentModeService = new AgentModeService();
    jest.clearAllMocks();
    process.env.AWS_REGION = 'us-west-2';
    process.env.AWS_ACCESS_KEY_ID = 'test-key';
    process.env.AWS_SECRET_ACCESS_KEY = 'test-secret';
  });

  afterEach(() => {
    delete process.env.AWS_REGION;
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_SECRET_ACCESS_KEY;
  });

  describe('Model registry', () => {
    it('should include Claude Sonnet 4.5 in the supported models', async () => {
      const models = await agentModeService.getSupportedModels();
      expect(models).toContain('anthropic.claude-sonnet-4-5-20250929-v1:0');
    });

    it('should include Claude Sonnet 4.6 in the supported models', async () => {
      const models = await agentModeService.getSupportedModels();
      expect(models).toContain('anthropic.claude-sonnet-4-6');
    });

    it('should include Claude Opus 4.6 in the supported models', async () => {
      const models = await agentModeService.getSupportedModels();
      expect(models).toContain('anthropic.claude-opus-4-6-v1');
    });

    it('should have temperature support enabled for Sonnet 4.5', async () => {
      const llmModels = (agentModeService as any).llmModels;
      expect(llmModels['anthropic.claude-sonnet-4-5-20250929-v1:0'].supportsTemperature).toBe(true);
    });

    it('should have null client initially for Sonnet 4.5 (lazy-loaded)', () => {
      const llmModels = (agentModeService as any).llmModels;
      expect(llmModels['anthropic.claude-sonnet-4-5-20250929-v1:0'].client).toBeNull();
    });

    it('should have null client initially for Sonnet 4.6 (lazy-loaded)', () => {
      const llmModels = (agentModeService as any).llmModels;
      expect(llmModels['anthropic.claude-sonnet-4-6'].client).toBeNull();
    });

    it('should have null client initially for Opus 4.6 (lazy-loaded)', () => {
      const llmModels = (agentModeService as any).llmModels;
      expect(llmModels['anthropic.claude-opus-4-6-v1'].client).toBeNull();
    });

    it('should include Gemini 3.1 Pro Preview in the supported models', async () => {
      const models = await agentModeService.getSupportedModels();
      expect(models).toContain('gemini-3.1-pro-preview');
    });

    it('should have temperature support enabled for Gemini 3.1 Pro Preview', () => {
      const llmModels = (agentModeService as any).llmModels;
      expect(llmModels['gemini-3.1-pro-preview'].supportsTemperature).toBe(true);
    });

    it('should have null client initially for Gemini 3.1 Pro Preview (lazy-loaded)', () => {
      const llmModels = (agentModeService as any).llmModels;
      expect(llmModels['gemini-3.1-pro-preview'].client).toBeNull();
    });

    it('should return only anthropic models from getReportsModelOptions', async () => {
      const reportsModels = await agentModeService.getReportsModelOptions();
      expect(reportsModels.length).toBeGreaterThan(0);
      reportsModels.forEach(model => {
        expect(model).toMatch(/^anthropic\./);
      });
      // Verify it excludes non-anthropic models
      const allModels = await agentModeService.getSupportedModels();
      const nonAnthropicModels = allModels.filter(m => !m.startsWith('anthropic.'));
      expect(nonAnthropicModels.length).toBeGreaterThan(0);
      nonAnthropicModels.forEach(model => {
        expect(reportsModels).not.toContain(model);
      });
    });
  });

  describe('Bedrock client lazy-loading', () => {
    it('should lazy-load Bedrock client for Sonnet 4.5 on first callLLM', async () => {
      // Mock the Bedrock invoke to return a valid response
      mockBedrockInvoke.mockResolvedValue({
        content: 'test response',
        response_metadata: {
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      });

      const messages = [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'Hello' },
      ];

      await (agentModeService as any).callLLM(
        'anthropic.claude-sonnet-4-5-20250929-v1:0',
        messages
      );

      // After calling, the client should be cached (no longer null)
      const llmModels = (agentModeService as any).llmModels;
      expect(llmModels['anthropic.claude-sonnet-4-5-20250929-v1:0'].client).not.toBeNull();
    });

    it('should lazy-load Bedrock client for Sonnet 4.6 on first callLLM', async () => {
      mockBedrockInvoke.mockResolvedValue({
        content: 'test response',
        response_metadata: {
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      });

      const messages = [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'Hello' },
      ];

      await (agentModeService as any).callLLM(
        'anthropic.claude-sonnet-4-6',
        messages
      );

      const llmModels = (agentModeService as any).llmModels;
      expect(llmModels['anthropic.claude-sonnet-4-6'].client).not.toBeNull();
    });

    it('should lazy-load Bedrock client for Opus 4.6 on first callLLM', async () => {
      mockBedrockInvoke.mockResolvedValue({
        content: 'test response',
        response_metadata: {
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      });

      const messages = [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'Hello' },
      ];

      await (agentModeService as any).callLLM(
        'anthropic.claude-opus-4-6-v1',
        messages
      );

      const llmModels = (agentModeService as any).llmModels;
      expect(llmModels['anthropic.claude-opus-4-6-v1'].client).not.toBeNull();
    });
  });

  describe('Gemini client lazy-loading', () => {
    it('should lazy-load Gemini client for gemini-3.1-pro-preview on first callLLM', async () => {
      const mockCreate = jest.fn().mockResolvedValue({
        choices: [{ message: { content: 'test response' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      });
      const mockGeminiClient = { chat: { completions: { create: mockCreate } } };

      // Spy on getGeminiClient to return our mock
      jest.spyOn(agentModeService as any, 'getGeminiClient').mockResolvedValue(mockGeminiClient);

      const messages = [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'Hello' },
      ];

      await (agentModeService as any).callLLM('gemini-3.1-pro-preview', messages);

      // getGeminiClient should have been called
      expect((agentModeService as any).getGeminiClient).toHaveBeenCalled();

      // After calling, the client should be cached (no longer null)
      const llmModels = (agentModeService as any).llmModels;
      expect(llmModels['gemini-3.1-pro-preview'].client).toBe(mockGeminiClient);
    });
  });

  describe('Inference profile ARN mapping', () => {
    it('should map Sonnet 4.5 to its inference profile ARN', async () => {
      const { ChatBedrockConverse } = require('@langchain/aws');

      mockBedrockInvoke.mockResolvedValue({
        content: 'test response',
        response_metadata: {
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      });

      const messages = [
        { role: 'system', content: 'Test' },
        { role: 'user', content: 'Hello' },
      ];

      await (agentModeService as any).callLLM(
        'anthropic.claude-sonnet-4-5-20250929-v1:0',
        messages
      );

      // The ChatBedrockConverse constructor should have been called with the inference profile ARN
      expect(ChatBedrockConverse).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'arn:aws:bedrock:us-west-2:992382574572:inference-profile/global.anthropic.claude-sonnet-4-5-20250929-v1:0',
        })
      );
    });

    it('should map Sonnet 4.6 to its inference profile ARN', async () => {
      const { ChatBedrockConverse } = require('@langchain/aws');

      mockBedrockInvoke.mockResolvedValue({
        content: 'test response',
        response_metadata: {
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      });

      const messages = [
        { role: 'system', content: 'Test' },
        { role: 'user', content: 'Hello' },
      ];

      await (agentModeService as any).callLLM(
        'anthropic.claude-sonnet-4-6',
        messages
      );

      expect(ChatBedrockConverse).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'arn:aws:bedrock:us-west-2:992382574572:inference-profile/global.anthropic.claude-sonnet-4-6',
        })
      );
    });

    it('should map Opus 4.6 to its inference profile ARN', async () => {
      const { ChatBedrockConverse } = require('@langchain/aws');

      mockBedrockInvoke.mockResolvedValue({
        content: 'test response',
        response_metadata: {
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      });

      const messages = [
        { role: 'system', content: 'Test' },
        { role: 'user', content: 'Hello' },
      ];

      await (agentModeService as any).callLLM(
        'anthropic.claude-opus-4-6-v1',
        messages
      );

      expect(ChatBedrockConverse).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'arn:aws:bedrock:us-west-2:992382574572:inference-profile/global.anthropic.claude-opus-4-6-v1',
        })
      );
    });
  });

  describe('callLLM rejects unknown models', () => {
    it('should throw error for unsupported model', async () => {
      await expect(
        (agentModeService as any).callLLM('nonexistent-model', [
          { role: 'user', content: 'Hello' },
        ])
      ).rejects.toThrow();
    });
  });

  describe('getScheduledChatsDefaultModel', () => {
    const { settingsService } = require('../services/settingsService');

    it('should return scheduled chats model when configured', async () => {
      (settingsService.getSetting as jest.Mock).mockResolvedValue({
        settingValue: 'anthropic.claude-sonnet-4-6',
      });

      const model = await agentModeService.getScheduledChatsDefaultModel();
      expect(model).toBe('anthropic.claude-sonnet-4-6');
      expect(settingsService.getSetting).toHaveBeenCalledWith('agent_mode_scheduled_chats_default_model');
    });

    it('should fall back to general default model when not configured', async () => {
      // First call (scheduled chats setting) returns null, second call (default model setting) returns a value
      (settingsService.getSetting as jest.Mock)
        .mockResolvedValueOnce(null) // scheduled chats setting
        .mockResolvedValueOnce({ settingValue: 'anthropic.claude-opus-4-6-v1' }); // general default

      const model = await agentModeService.getScheduledChatsDefaultModel();
      expect(model).toBe('anthropic.claude-opus-4-6-v1');
    });

    it('should fall back to env/hardcoded default when neither setting is configured', async () => {
      (settingsService.getSetting as jest.Mock).mockResolvedValue(null);

      const model = await agentModeService.getScheduledChatsDefaultModel();
      // Falls through to this.default_model (env var or hardcoded)
      expect(model).toBe(agentModeService.default_model);
    });

    it('should fall back to general default when scheduled chats model is unsupported', async () => {
      (settingsService.getSetting as jest.Mock)
        .mockResolvedValueOnce({ settingValue: 'nonexistent-model' }) // unsupported scheduled chats model
        .mockResolvedValueOnce({ settingValue: 'anthropic.claude-sonnet-4-6' }); // general default

      const model = await agentModeService.getScheduledChatsDefaultModel();
      expect(model).toBe('anthropic.claude-sonnet-4-6');
    });
  });
});
