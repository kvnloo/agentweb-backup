// Mock LangChain modules before imports
const mockInvoke = jest.fn();

// Define the chain mock type
interface ChainMock {
  invoke: jest.Mock;
  pipe: jest.Mock;
}

// Create a chainable mock that supports nested pipe calls
const createChainMock = (): ChainMock => ({
  invoke: mockInvoke,
  pipe: jest.fn((): ChainMock => createChainMock())
});

const mockChain = createChainMock();

jest.mock('@langchain/openai', () => ({
  AzureChatOpenAI: jest.fn().mockImplementation(() => ({
    invoke: mockInvoke
  })),
  ChatOpenAI: jest.fn().mockImplementation(() => ({
    invoke: mockInvoke
  }))
}));

jest.mock('@langchain/aws', () => ({
  ChatBedrockConverse: jest.fn().mockImplementation(() => ({
    invoke: mockInvoke
  }))
}));

jest.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: jest.fn().mockImplementation(() => ({}))
}));

jest.mock('@langchain/core/prompts', () => ({
  ChatPromptTemplate: {
    fromMessages: jest.fn(() => ({
      pipe: jest.fn(() => mockChain)
    }))
  }
}));

jest.mock('@langchain/core/output_parsers', () => ({
  JsonOutputParser: jest.fn().mockImplementation(() => ({
    invoke: jest.fn().mockImplementation((input: any) => {
      const str = typeof input === 'string' ? input : JSON.stringify(input);
      try { return JSON.parse(str); } catch { return input; }
    })
  }))
}));

import { LLMService, createLLMService } from '../../utils/llmService';
import { AzureChatOpenAI, ChatOpenAI } from '@langchain/openai';
import { ChatBedrockConverse } from '@langchain/aws';

describe('llmService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.AZURE_OPENAI_ENDPOINT = 'https://test.openai.azure.com';
    process.env.AZURE_OPENAI_API_KEY = 'test-api-key';
    process.env.AZURE_OPENAI_DEPLOYMENT = 'gpt-4';
    process.env.AWS_ACCESS_KEY_ID = 'test-key';
    process.env.AWS_SECRET_ACCESS_KEY = 'test-secret';
    process.env.AWS_REGION = 'us-west-2';
  });

  afterEach(() => {
    delete process.env.AZURE_OPENAI_ENDPOINT;
    delete process.env.AZURE_OPENAI_API_KEY;
    delete process.env.AZURE_OPENAI_DEPLOYMENT;
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_SECRET_ACCESS_KEY;
    delete process.env.AWS_REGION;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_BASE_URL;
    delete process.env.OPENROUTER_MODEL_GPT_5_CHAT_2;
  });

  describe('LLMService constructor', () => {
    it('should create Azure OpenAI model for non-Claude models', () => {
      new LLMService('gpt-4');
      expect(AzureChatOpenAI).toHaveBeenCalled();
    });

    it('should create Bedrock model for Claude models', () => {
      new LLMService('claude-3-sonnet');
      expect(ChatBedrockConverse).toHaveBeenCalled();
    });

    it('should create Bedrock model for models containing "sonnet"', () => {
      new LLMService('anthropic.claude-sonnet');
      expect(ChatBedrockConverse).toHaveBeenCalled();
    });

    it('should create Bedrock model for models starting with "anthropic."', () => {
      new LLMService('anthropic.claude-v2');
      expect(ChatBedrockConverse).toHaveBeenCalled();
    });

    it('should create Bedrock model for anthropic. prefix without claude or sonnet in name', () => {
      new LLMService('anthropic.haiku-v1');
      expect(ChatBedrockConverse).toHaveBeenCalled();
    });

    it('should use default deployment from env when model not specified', () => {
      new LLMService();
      expect(AzureChatOpenAI).toHaveBeenCalled();
    });

    it('should route models through OpenRouter when OPENROUTER_API_KEY is configured', () => {
      process.env.OPENROUTER_API_KEY = 'sk-or-test';
      process.env.OPENROUTER_BASE_URL = 'https://openrouter.example/api/v1/';
      process.env.OPENROUTER_MODEL_GPT_5_CHAT_2 = 'openai/gpt-5.2';

      new LLMService('gpt-5-chat-2', 0.2, 1234);

      expect(ChatOpenAI).toHaveBeenCalledWith(
        expect.objectContaining({
          apiKey: 'sk-or-test',
          model: 'openai/gpt-5.2',
          temperature: 0.2,
          maxTokens: 1234,
          configuration: expect.objectContaining({
            baseURL: 'https://openrouter.example/api/v1',
            defaultHeaders: expect.objectContaining({ 'X-OpenRouter-Title': 'AgentWeb' }),
          }),
        })
      );
      expect(AzureChatOpenAI).not.toHaveBeenCalled();
      expect(ChatBedrockConverse).not.toHaveBeenCalled();
    });

    it('should throw error when Azure credentials are missing for non-Claude models', () => {
      delete process.env.AZURE_OPENAI_API_KEY;
      expect(() => new LLMService('gpt-4')).toThrow(
        'AZURE_OPENAI_API_KEY and AZURE_OPENAI_ENDPOINT must be set'
      );
    });

    it('should throw error when Azure endpoint is missing', () => {
      delete process.env.AZURE_OPENAI_ENDPOINT;
      expect(() => new LLMService('gpt-4')).toThrow(
        'AZURE_OPENAI_API_KEY and AZURE_OPENAI_ENDPOINT must be set'
      );
    });

    it('should map Sonnet 4.5 to its inference profile ARN', () => {
      new LLMService('anthropic.claude-sonnet-4-5-20250929-v1:0');
      expect(ChatBedrockConverse).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'arn:aws:bedrock:us-west-2:992382574572:inference-profile/global.anthropic.claude-sonnet-4-5-20250929-v1:0',
        })
      );
    });

    it('should map Sonnet 4.6 to its inference profile ARN', () => {
      new LLMService('anthropic.claude-sonnet-4-6');
      expect(ChatBedrockConverse).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'arn:aws:bedrock:us-west-2:992382574572:inference-profile/global.anthropic.claude-sonnet-4-6',
        })
      );
    });

    it('should map Opus 4.6 to its inference profile ARN', () => {
      new LLMService('anthropic.claude-opus-4-6-v1');
      expect(ChatBedrockConverse).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'arn:aws:bedrock:us-west-2:992382574572:inference-profile/global.anthropic.claude-opus-4-6-v1',
        })
      );
    });

    it('should handle specific Claude opus 4.6 model ID transformation', () => {
      new LLMService('anthropic.claude-opus-4-6-v1');
      expect(ChatBedrockConverse).toHaveBeenCalled();
    });

    it('should use default API version when env var not set', () => {
      delete process.env.AZURE_OPENAI_API_VERSION;
      // Should not throw - will use default version
      const service = new LLMService('gpt-4');
      expect(service).toBeInstanceOf(LLMService);
    });

    it('should create Bedrock model without explicit AWS credentials', () => {
      delete process.env.AWS_ACCESS_KEY_ID;
      // Should use default credentials from environment
      const service = new LLMService('claude-3-sonnet');
      expect(ChatBedrockConverse).toHaveBeenCalled();
      expect(service).toBeInstanceOf(LLMService);
    });

    it('should fall back to AWS_DEFAULT_REGION when AWS_REGION is not set', () => {
      delete process.env.AWS_REGION;
      process.env.AWS_DEFAULT_REGION = 'eu-west-1';
      new LLMService('claude-3-sonnet');
      expect(ChatBedrockConverse).toHaveBeenCalled();
    });

    it('should fall back to us-west-2 when neither AWS_REGION nor AWS_DEFAULT_REGION is set', () => {
      delete process.env.AWS_REGION;
      delete process.env.AWS_DEFAULT_REGION;
      new LLMService('claude-3-sonnet');
      expect(ChatBedrockConverse).toHaveBeenCalled();
    });

    it('should use empty string for AWS_SECRET_ACCESS_KEY when not set', () => {
      delete process.env.AWS_SECRET_ACCESS_KEY;
      // AWS_ACCESS_KEY_ID is set but SECRET_ACCESS_KEY is not
      new LLMService('claude-3-sonnet');
      expect(ChatBedrockConverse).toHaveBeenCalled();
    });

    it('should fall back to gpt-4 when no model specified and AZURE_OPENAI_DEPLOYMENT not set', () => {
      delete process.env.AZURE_OPENAI_DEPLOYMENT;
      const service = new LLMService();
      expect(AzureChatOpenAI).toHaveBeenCalled();
      expect(service).toBeInstanceOf(LLMService);
    });

    it('should pass maxTokens when provided', () => {
      new LLMService('gpt-4', 0.5, 2000);
      expect(AzureChatOpenAI).toHaveBeenCalled();
    });

    it('should pass maxTokens to Claude model when provided', () => {
      new LLMService('claude-3-sonnet', 0.5, 2000);
      expect(ChatBedrockConverse).toHaveBeenCalled();
    });
  });

  describe('generateContent', () => {
    let service: LLMService;

    beforeEach(() => {
      service = new LLMService('gpt-4');
    });

    it('should generate text content', async () => {
      mockInvoke.mockResolvedValue({ content: 'Generated text response' });

      const result = await service.generateContent('system prompt', 'user prompt');
      expect(result).toBe('Generated text response');
    });

    it('should generate JSON content when format is json', async () => {
      mockInvoke.mockResolvedValue({ key: 'value' });

      const result = await service.generateContent('system prompt', 'user prompt', 'json');
      expect(result).toBe('{"key":"value"}');
    });

    it('should return stringified JSON when result is already string', async () => {
      mockInvoke.mockResolvedValue('already a string');

      const result = await service.generateContent('system prompt', 'user prompt', 'json');
      expect(result).toBe('already a string');
    });

    it('should throw error on failure', async () => {
      mockInvoke.mockRejectedValue(new Error('Generation failed'));

      await expect(service.generateContent('system', 'user')).rejects.toThrow('Generation failed');
    });
  });

  describe('generateJSONContent', () => {
    let service: LLMService;

    beforeEach(() => {
      service = new LLMService('gpt-4');
    });

    it('should generate JSON content', async () => {
      mockInvoke.mockResolvedValue({ content: '{"data":"value"}' });

      const result = await service.generateJSONContent('system', 'user', 'json');
      expect(result).toEqual({ data: 'value' });
    });

    it('should parse XML content when format is xml', async () => {
      mockInvoke.mockResolvedValue({
        content: '<content>parsed content</content><title>Test Title</title>'
      });

      const result = await service.generateJSONContent<{ content: string; title: string }>(
        'system',
        'user',
        'xml'
      );
      expect(result.content).toBe('parsed content');
      expect(result.title).toBe('Test Title');
    });

    it('should parse XML with description and imagePrompt', async () => {
      mockInvoke.mockResolvedValue({
        content:
          '<content>text</content><description>desc</description><imagePrompt>prompt</imagePrompt>'
      });

      const result = await service.generateJSONContent<{
        content: string;
        description: string;
        imagePrompt: string;
      }>('system', 'user', 'xml');
      expect(result.description).toBe('desc');
      expect(result.imagePrompt).toBe('prompt');
    });

    it('should extract content directly from XML when parsing fails', async () => {
      mockInvoke.mockResolvedValue({
        content: 'some text <content>fallback content</content> more text'
      });

      const result = await service.generateJSONContent<{ content: string }>('system', 'user', 'xml');
      expect(result.content).toBe('fallback content');
    });

    it('should handle XML content tag without closing tag', async () => {
      mockInvoke.mockResolvedValue({
        content: '<content>content without closing tag'
      });

      const result = await service.generateJSONContent<{ content: string }>('system', 'user', 'xml');
      expect(result.content).toBe('content without closing tag');
    });

    it('should throw error when XML content cannot be extracted', async () => {
      mockInvoke.mockResolvedValue({
        content: 'no xml tags here'
      });

      await expect(service.generateJSONContent('system', 'user', 'xml')).rejects.toThrow(
        'Could not extract content from XML response'
      );
    });

    it('should call onUsage callback with token counts when provided', async () => {
      mockInvoke.mockResolvedValue({
        content: '{"data":"value"}',
        usage_metadata: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
      });
      const onUsage = jest.fn();

      await service.generateJSONContent('system', 'user', 'json', onUsage);

      expect(onUsage).toHaveBeenCalledWith({
        inputTokens: 10,
        outputTokens: 20,
        totalTokens: 30,
        model: 'gpt-4',
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      });
    });

    it('should compute totalTokens from input+output when usage_metadata.total_tokens absent', async () => {
      mockInvoke.mockResolvedValue({
        content: '{"data":"value"}',
        usage_metadata: { input_tokens: 5, output_tokens: 15 },
      });
      const onUsage = jest.fn();

      await service.generateJSONContent('system', 'user', 'json', onUsage);

      expect(onUsage).toHaveBeenCalledWith(expect.objectContaining({ totalTokens: 20 }));
    });

    it('should not call onUsage when not provided', async () => {
      mockInvoke.mockResolvedValue({ content: '{"data":"value"}' });

      // Should not throw
      await expect(service.generateJSONContent('system', 'user', 'json')).resolves.toBeDefined();
    });

    it('should throw error on generation failure', async () => {
      mockInvoke.mockRejectedValue(new Error('JSON generation failed'));

      await expect(service.generateJSONContent('system', 'user')).rejects.toThrow(
        'JSON generation failed'
      );
    });
  });

  describe('generateHTML', () => {
    let service: LLMService;

    beforeEach(() => {
      service = new LLMService('gpt-4');
    });

    it('should extract HTML from actual_html_content tags', async () => {
      mockInvoke.mockResolvedValue({
        content:
          '<actual_html_content><!DOCTYPE html><html><body>Test</body></html></actual_html_content>'
      });

      const result = await service.generateHTML('system', 'user');
      expect(result).toBe('<!DOCTYPE html><html><body>Test</body></html>');
    });

    it('should extract HTML starting from DOCTYPE when tags not found', async () => {
      mockInvoke.mockResolvedValue({
        content: 'Some preamble <!DOCTYPE html><html><body>Content</body></html>'
      });

      const result = await service.generateHTML('system', 'user');
      expect(result).toBe('<!DOCTYPE html><html><body>Content</body></html>');
    });

    it('should extract HTML starting from html tag when DOCTYPE not found', async () => {
      mockInvoke.mockResolvedValue({
        content: 'Some text <html><body>Content</body></html>'
      });

      const result = await service.generateHTML('system', 'user');
      expect(result).toBe('<html><body>Content</body></html>');
    });

    it('should return raw content when no HTML structure found', async () => {
      mockInvoke.mockResolvedValue({
        content: 'Plain text without HTML'
      });

      const result = await service.generateHTML('system', 'user');
      expect(result).toBe('Plain text without HTML');
    });

    it('should handle HTML without closing tag', async () => {
      mockInvoke.mockResolvedValue({
        content: '<!DOCTYPE html><html><body>Content'
      });

      const result = await service.generateHTML('system', 'user');
      expect(result).toBe('<!DOCTYPE html><html><body>Content');
    });

    it('should call onUsage callback with token counts when provided', async () => {
      mockInvoke.mockResolvedValue({
        content: '<actual_html_content><!DOCTYPE html><html></html></actual_html_content>',
        usage_metadata: { input_tokens: 100, output_tokens: 200, total_tokens: 300 },
      });
      const onUsage = jest.fn();

      await service.generateHTML('system', 'user', onUsage);

      expect(onUsage).toHaveBeenCalledWith({
        inputTokens: 100,
        outputTokens: 200,
        totalTokens: 300,
        model: 'gpt-4',
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      });
    });

    it('should default token counts to 0 when usage_metadata absent', async () => {
      mockInvoke.mockResolvedValue({
        content: '<actual_html_content><!DOCTYPE html><html></html></actual_html_content>',
      });
      const onUsage = jest.fn();

      await service.generateHTML('system', 'user', onUsage);

      expect(onUsage).toHaveBeenCalledWith({
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        model: 'gpt-4',
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      });
    });

    it('should throw error on generation failure', async () => {
      mockInvoke.mockRejectedValue(new Error('HTML generation failed'));

      await expect(service.generateHTML('system', 'user')).rejects.toThrow('HTML generation failed');
    });
  });

  describe('createLLMService helper', () => {
    it('should create LLMService instance with default settings', () => {
      const service = createLLMService();
      expect(service).toBeInstanceOf(LLMService);
    });

    it('should create LLMService instance with custom settings', () => {
      const service = createLLMService('gpt-4', 0.5, 1000);
      expect(service).toBeInstanceOf(LLMService);
    });

    it('should create LLMService for Claude model', () => {
      const service = createLLMService('claude-3-sonnet');
      expect(service).toBeInstanceOf(LLMService);
      expect(ChatBedrockConverse).toHaveBeenCalled();
    });
  });
});
