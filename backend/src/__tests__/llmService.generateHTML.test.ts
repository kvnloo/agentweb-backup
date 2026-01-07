// Mock environment variables for Claude model BEFORE importing
process.env.AWS_REGION = 'us-west-2';
process.env.AWS_ACCESS_KEY_ID = 'test-key';
process.env.AWS_SECRET_ACCESS_KEY = 'test-secret';

// Mock LangChain modules
const mockInvoke = jest.fn();
const mockChatModel = {
  invoke: mockInvoke
};

jest.mock('@langchain/openai', () => ({
  AzureChatOpenAI: jest.fn().mockImplementation(() => mockChatModel)
}));

jest.mock('@langchain/aws', () => ({
  ChatBedrockConverse: jest.fn().mockImplementation(() => mockChatModel)
}));

jest.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: jest.fn().mockImplementation(() => ({}))
}));

jest.mock('@langchain/core/prompts', () => ({
  ChatPromptTemplate: {
    fromMessages: jest.fn()
  }
}));

// Import after mocks are set up
import { LLMService, createLLMService } from '../utils/llmService';

describe('LLMService - generateHTML', () => {
  let llmService: LLMService;

  beforeEach(() => {
    jest.clearAllMocks();
    mockInvoke.mockClear();
    
    // Create a mock chain that returns a response
    const { ChatPromptTemplate } = require('@langchain/core/prompts');
    
    // The chain structure: prompt.pipe(chatModel) returns the chatModel
    ChatPromptTemplate.fromMessages.mockReturnValue({
      pipe: jest.fn().mockReturnValue(mockChatModel)
    });
    
    // Create LLMService instance with Claude model (doesn't require Azure credentials)
    llmService = createLLMService('anthropic.claude-sonnet-4-5-20250929-v1:0', 0.8, 4000);
  });

  describe('generateHTML', () => {
    it('should extract HTML from <actual_html_content> tags', async () => {
      const mockHtml = '<!DOCTYPE html><html><head><title>Test</title></head><body><h1>Hello</h1></body></html>';
      const mockResponse = `<actual_html_content>
${mockHtml}
</actual_html_content>`;

      mockInvoke.mockResolvedValue({
        content: mockResponse
      });

      const result = await llmService.generateHTML(
        'You are an expert web developer.',
        'Create an HTML page with a heading.'
      );

      expect(result).toBe(mockHtml);
    });

    it('should handle HTML with whitespace in tags', async () => {
      const mockHtml = '<html><body><p>Test</p></body></html>';
      const mockResponse = `<actual_html_content>
        ${mockHtml}
      </actual_html_content>`;

      mockInvoke.mockResolvedValue({
        content: mockResponse
      });

      const result = await llmService.generateHTML(
        'System prompt',
        'User prompt'
      );

      expect(result.trim()).toBe(mockHtml);
    });

    it('should extract HTML when tags are case-insensitive', async () => {
      const mockHtml = '<html><body><h1>Test</h1></body></html>';
      const mockResponse = `<ACTUAL_HTML_CONTENT>
${mockHtml}
</ACTUAL_HTML_CONTENT>`;

      mockInvoke.mockResolvedValue({
        content: mockResponse
      });

      const result = await llmService.generateHTML(
        'System prompt',
        'User prompt'
      );

      expect(result.trim()).toBe(mockHtml);
    });

    it('should fallback to extracting HTML from DOCTYPE if tags not found', async () => {
      const mockHtml = '<!DOCTYPE html><html><head><title>Test</title></head><body><h1>Hello</h1></body></html>';
      const mockResponse = `Some text before
${mockHtml}
Some text after`;

      mockInvoke.mockResolvedValue({
        content: mockResponse
      });

      const result = await llmService.generateHTML(
        'System prompt',
        'User prompt'
      );

      expect(result).toContain('<!DOCTYPE html>');
      expect(result).toContain('<html>');
    });

    it('should fallback to extracting HTML from <html> tag if DOCTYPE not found', async () => {
      const mockHtml = '<html><head><title>Test</title></head><body><h1>Hello</h1></body></html>';
      const mockResponse = `Some text before
${mockHtml}
Some text after`;

      mockInvoke.mockResolvedValue({
        content: mockResponse
      });

      const result = await llmService.generateHTML(
        'System prompt',
        'User prompt'
      );

      expect(result).toContain('<html>');
    });

    it('should extract complete HTML document when </html> tag is present', async () => {
      const mockHtml = '<html><head><title>Test</title></head><body><h1>Hello</h1></body></html>';
      const mockResponse = `Some text before
${mockHtml}
Some text after`;

      mockInvoke.mockResolvedValue({
        content: mockResponse
      });

      const result = await llmService.generateHTML(
        'System prompt',
        'User prompt'
      );

      expect(result).toBe(mockHtml);
      expect(result).not.toContain('Some text after');
    });

    it('should return raw response as fallback if no HTML structure found', async () => {
      const mockResponse = 'This is just plain text without HTML structure';

      mockInvoke.mockResolvedValue({
        content: mockResponse
      });

      const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation();

      const result = await llmService.generateHTML(
        'System prompt',
        'User prompt'
      );

      expect(result).toBe(mockResponse);
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        'LLMService: Could not extract HTML from response, returning raw content'
      );

      consoleWarnSpy.mockRestore();
    });

    it('should handle errors and throw them', async () => {
      const error = new Error('LLM API error');
      mockInvoke.mockRejectedValue(error);

      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();

      await expect(
        llmService.generateHTML('System prompt', 'User prompt')
      ).rejects.toThrow('LLM API error');

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        'LLMService: Error generating HTML:',
        error
      );

      consoleErrorSpy.mockRestore();
    });

    it('should include system prompt with HTML output format requirements', async () => {
      mockInvoke.mockResolvedValue({
        content: '<actual_html_content><html><body>Test</body></html></actual_html_content>'
      });

      await llmService.generateHTML(
        'You are a web developer.',
        'Create a page.'
      );

      const { ChatPromptTemplate } = require('@langchain/core/prompts');
      const callArgs = ChatPromptTemplate.fromMessages.mock.calls[0][0];
      
      expect(callArgs[0][1]).toContain('You are a web developer.');
      expect(callArgs[0][1]).toContain('<actual_html_content>');
      expect(callArgs[0][1]).toContain('</actual_html_content>');
    });
  });
});

