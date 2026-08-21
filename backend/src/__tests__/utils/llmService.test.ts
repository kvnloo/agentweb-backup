import { LLMService, createLLMService } from '../../utils/llmService';

const withInvoke = (service: LLMService, invoke: jest.Mock): LLMService => {
  (service as any).chatModel = { invoke };
  return service;
};

describe('LLMService shared-gateway compatibility facade', () => {
  it('constructs without provider credentials or provider SDK clients', () => {
    delete process.env.AZURE_OPENAI_API_KEY;
    delete process.env.AZURE_OPENAI_ENDPOINT;
    expect(() => new LLMService('gpt-5.5')).not.toThrow();
    expect(() => new LLMService('anthropic.claude-sonnet-4-6')).not.toThrow();
  });

  it('createLLMService preserves the public factory contract', () => {
    expect(createLLMService()).toBeInstanceOf(LLMService);
    expect(createLLMService('gpt-5.5', 0.5, 1000)).toBeInstanceOf(LLMService);
    expect(createLLMService('anthropic.claude-sonnet-4-6')).toBeInstanceOf(LLMService);
  });

  describe('text and structured output', () => {
    it('returns text content', async () => {
      const invoke = jest.fn().mockResolvedValue({ content: 'Generated text response' });
      const service = withInvoke(new LLMService('gpt-5.5'), invoke);
      await expect(service.generateContent('system', 'user')).resolves.toBe('Generated text response');
    });

    it('extracts and stringifies JSON content', async () => {
      const invoke = jest.fn().mockResolvedValue({ content: '```json\n{"key":"value"}\n```' });
      const service = withInvoke(new LLMService('gpt-5.5'), invoke);
      await expect(service.generateContent('system', 'user', 'json')).resolves.toBe('{"key":"value"}');
    });

    it('parses JSON objects', async () => {
      const invoke = jest.fn().mockResolvedValue({ content: '{"data":"value"}' });
      const service = withInvoke(new LLMService('gpt-5.5'), invoke);
      await expect(service.generateJSONContent('system', 'user')).resolves.toEqual({ data: 'value' });
    });

    it('parses the supported XML fields', async () => {
      const invoke = jest.fn().mockResolvedValue({
        content: '<content>text</content><title>Title</title><description>desc</description><imagePrompt>prompt</imagePrompt>',
      });
      const service = withInvoke(new LLMService('gpt-5.5'), invoke);
      await expect(service.generateJSONContent('system', 'user', 'xml')).resolves.toEqual({
        content: 'text', title: 'Title', description: 'desc', imagePrompt: 'prompt',
      });
    });

    it('preserves the missing XML close-tag fallback', async () => {
      const invoke = jest.fn().mockResolvedValue({ content: '<content>partial content' });
      const service = withInvoke(new LLMService('gpt-5.5'), invoke);
      await expect(service.generateJSONContent('system', 'user', 'xml')).resolves.toEqual({
        content: 'partial content',
      });
    });

    it('rejects missing XML content', async () => {
      const service = withInvoke(
        new LLMService('gpt-5.5'),
        jest.fn().mockResolvedValue({ content: 'no xml tags' }),
      );
      await expect(service.generateJSONContent('system', 'user', 'xml')).rejects.toThrow(
        'Could not extract content from XML response',
      );
    });

    it('propagates transport failures', async () => {
      const service = withInvoke(
        new LLMService('gpt-5.5'),
        jest.fn().mockRejectedValue(new Error('Generation failed')),
      );
      await expect(service.generateContent('system', 'user')).rejects.toThrow('Generation failed');
    });
  });

  describe('HTML extraction', () => {
    it('extracts tagged HTML', async () => {
      const service = withInvoke(new LLMService('gpt-5.5'), jest.fn().mockResolvedValue({
        content: '<actual_html_content><!DOCTYPE html><html><body>Test</body></html></actual_html_content>',
      }));
      await expect(service.generateHTML('system', 'user')).resolves.toBe(
        '<!DOCTYPE html><html><body>Test</body></html>',
      );
    });

    it('extracts an unwrapped HTML document and trims preamble', async () => {
      const service = withInvoke(new LLMService('gpt-5.5'), jest.fn().mockResolvedValue({
        content: 'preamble <!DOCTYPE html><html><body>Content</body></html> trailing',
      }));
      await expect(service.generateHTML('system', 'user')).resolves.toBe(
        '<!DOCTYPE html><html><body>Content</body></html>',
      );
    });

    it('returns raw text when no HTML structure exists', async () => {
      const service = withInvoke(new LLMService('gpt-5.5'), jest.fn().mockResolvedValue({
        content: 'Plain text',
      }));
      await expect(service.generateHTML('system', 'user')).resolves.toBe('Plain text');
    });
  });

  it('preserves usage callbacks for legacy callers', async () => {
    const onUsage = jest.fn();
    const service = withInvoke(new LLMService('gpt-5.5'), jest.fn().mockResolvedValue({
      content: '{"ok":true}',
      usage_metadata: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
    }));
    await service.generateJSONContent('system', 'user', 'json', onUsage);
    expect(onUsage).toHaveBeenCalledWith({
      inputTokens: 10,
      outputTokens: 20,
      totalTokens: 30,
      model: 'gpt-5.5',
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  });
});
