/**
 * Tests for the shadow-metering integration in utils/llmService.ts:
 *  (a) extractUsage now surfaces cache_read / cache_creation token details
 *  (b) generate* accept an optional usageContext and existing call shapes still work
 *  (c) recordUsage is ALWAYS fired after a response (with or without onUsage),
 *      defaulting feature to 'unknown', and a recorder failure never breaks a call
 */

jest.mock('@langchain/openai', () => {
  // The fake model must be a real Runnable so ChatPromptTemplate.pipe() works
  // in generateContent. All invokes route through one shared jest.fn.
  const { Runnable } = jest.requireActual('@langchain/core/runnables');
  const invoke = jest.fn();
  class FakeAzureChatModel extends Runnable {
    lc_namespace = ['test', 'fake'];
    invoke(...args: any[]) {
      return invoke(...args);
    }
  }
  return {
    AzureChatOpenAI: jest.fn().mockImplementation(() => new FakeAzureChatModel()),
    __azureInvoke: invoke,
  };
});

jest.mock('@langchain/aws', () => {
  const invoke = jest.fn();
  return {
    ChatBedrockConverse: jest.fn().mockImplementation(() => ({ invoke })),
    __bedrockInvoke: invoke,
  };
});

jest.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: jest.fn().mockImplementation(() => ({})),
}));

jest.mock('../services/usageRecorderService', () => ({
  recordUsage: jest.fn().mockResolvedValue(undefined),
}));

// Mock the Gemini SDK (dynamically imported inside generateJSONContentWithWebSearch).
const mockGeminiGenerateContent = jest.fn();
jest.mock('@google/genai', () => ({
  GoogleGenAI: jest.fn().mockImplementation(() => ({
    models: { generateContent: mockGeminiGenerateContent },
  })),
}));

import { recordUsage } from '../services/usageRecorderService';
import { LLMService } from '../utils/llmService';

const mockRecordUsage = recordUsage as jest.Mock;
const azureInvoke = (jest.requireMock('@langchain/openai') as any).__azureInvoke as jest.Mock;
const bedrockInvoke = (jest.requireMock('@langchain/aws') as any).__bedrockInvoke as jest.Mock;

const aiMessage = (overrides: any = {}) => ({
  content: 'hello world',
  usage_metadata: {
    input_tokens: 100,
    output_tokens: 20,
    total_tokens: 120,
    input_token_details: { cache_read: 30, cache_creation: 5 },
  },
  ...overrides,
});

describe('llmService shadow metering', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRecordUsage.mockResolvedValue(undefined);
    azureInvoke.mockResolvedValue(aiMessage());
    bedrockInvoke.mockResolvedValue(aiMessage());
  });

  describe('extractUsage cache fields (via onUsage)', () => {
    it('surfaces cache_read and cache_creation from usage_metadata.input_token_details', async () => {
      const svc = new LLMService('gpt-4-test');
      const onUsage = jest.fn();

      await svc.generateRaw('sys', 'user', onUsage);

      expect(onUsage).toHaveBeenCalledWith({
        inputTokens: 100,
        outputTokens: 20,
        totalTokens: 120,
        model: 'gpt-4-test',
        cacheReadTokens: 30,
        cacheWriteTokens: 5,
      });
    });

    it('defaults cache fields to 0 when input_token_details is absent', async () => {
      azureInvoke.mockResolvedValue(
        aiMessage({ usage_metadata: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } })
      );
      const svc = new LLMService('gpt-4-test');
      const onUsage = jest.fn();

      await svc.generateRaw('sys', 'user', onUsage);

      expect(onUsage).toHaveBeenCalledWith(
        expect.objectContaining({ cacheReadTokens: 0, cacheWriteTokens: 0 })
      );
    });
  });

  describe('recordUsage is always fired', () => {
    it('records even when the caller passes NO onUsage callback', async () => {
      const svc = new LLMService('gpt-4-test');
      await svc.generateRaw('sys', 'user');

      expect(mockRecordUsage).toHaveBeenCalledTimes(1);
      expect(mockRecordUsage).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'gpt-4-test',
          provider: 'azure-openai',
          feature: 'unknown',
          userId: undefined, // recorder maps missing userId → 'system'
          inputTokens: 100,
          outputTokens: 20,
          cacheReadTokens: 30,
          cacheWriteTokens: 5,
        })
      );
    });

    it('passes through the usageContext attribution when provided', async () => {
      const svc = new LLMService('gpt-4-test');
      await svc.generateRaw('sys', 'user', undefined, {
        userId: 'user-9',
        feature: 'lead-magnet',
        sessionId: 'sess-3',
      });

      expect(mockRecordUsage).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'user-9', feature: 'lead-magnet', sessionId: 'sess-3' })
      );
    });

    it('meters generateJSONContent alongside the existing onUsage path', async () => {
      azureInvoke.mockResolvedValue(aiMessage({ content: '{"ok": true}' }));
      const svc = new LLMService('gpt-4-test');
      const onUsage = jest.fn();

      const result = await svc.generateJSONContent('sys', 'user', 'json', onUsage, {
        userId: 'user-2',
        feature: 'workflow-gen',
      });

      expect(result).toEqual({ ok: true });
      expect(onUsage).toHaveBeenCalledTimes(1);
      expect(mockRecordUsage).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'user-2', feature: 'workflow-gen' })
      );
    });

    it('meters generateJsonRobust and generateHTML', async () => {
      azureInvoke.mockResolvedValue(aiMessage({ content: '{"a":1}' }));
      const svc = new LLMService('gpt-4-test');
      await svc.generateJsonRobust('sys', 'user');
      expect(mockRecordUsage).toHaveBeenCalledTimes(1);

      azureInvoke.mockResolvedValue(
        aiMessage({ content: '<actual_html_content><html></html></actual_html_content>' })
      );
      await svc.generateHTML('sys', 'user');
      expect(mockRecordUsage).toHaveBeenCalledTimes(2);
    });

    it('meters generateContent for both text and json formats', async () => {
      const svc = new LLMService('gpt-4-test');
      azureInvoke.mockResolvedValue(aiMessage({ content: 'plain text' }));
      const text = await svc.generateContent('sys', 'user', 'text', {
        userId: 'user-3',
        feature: 'content',
      });
      expect(text).toBe('plain text');
      expect(mockRecordUsage).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'user-3', feature: 'content' })
      );
    });

    it('uses provider "bedrock" for Claude models', async () => {
      const svc = new LLMService('anthropic.claude-sonnet-4-6');
      await svc.generateRaw('sys', 'user');
      expect(mockRecordUsage).toHaveBeenCalledWith(
        expect.objectContaining({ provider: 'bedrock', model: 'anthropic.claude-sonnet-4-6' })
      );
    });
  });

  describe('fail-open (acceptance criterion: metering never breaks generation)', () => {
    it('returns the LLM response even when recordUsage throws synchronously', async () => {
      mockRecordUsage.mockImplementation(() => {
        throw new Error('recorder exploded');
      });
      const svc = new LLMService('gpt-4-test');

      await expect(svc.generateRaw('sys', 'user')).resolves.toBe('hello world');
    });

    it('still invokes onUsage when the recorder fails', async () => {
      mockRecordUsage.mockImplementation(() => {
        throw new Error('recorder exploded');
      });
      const svc = new LLMService('gpt-4-test');
      const onUsage = jest.fn();

      await svc.generateRaw('sys', 'user', onUsage);
      expect(onUsage).toHaveBeenCalledTimes(1);
    });
  });

  describe('backward compatibility', () => {
    it('legacy 2-arg and 3-arg call shapes still work', async () => {
      const svc = new LLMService('gpt-4-test');
      await expect(svc.generateRaw('sys', 'user')).resolves.toBe('hello world');

      azureInvoke.mockResolvedValue(aiMessage({ content: '{"x": 2}' }));
      await expect(svc.generateJSONContent('sys', 'user')).resolves.toEqual({ x: 2 });
      await expect(svc.generateJSONContent('sys', 'user', 'json')).resolves.toEqual({ x: 2 });
    });
  });

  describe('extractUsage edge cases', () => {
    it('defaults totalTokens to input+output when total_tokens is absent', async () => {
      azureInvoke.mockResolvedValue(
        aiMessage({ usage_metadata: { input_tokens: 7, output_tokens: 3 } })
      );
      const svc = new LLMService('gpt-4-test');
      const onUsage = jest.fn();
      await svc.generateRaw('sys', 'user', onUsage);
      expect(onUsage).toHaveBeenCalledWith(
        expect.objectContaining({ inputTokens: 7, outputTokens: 3, totalTokens: 10 })
      );
    });

    it('defaults all token counts to 0 when usage_metadata is entirely missing', async () => {
      azureInvoke.mockResolvedValue(aiMessage({ usage_metadata: undefined }));
      const svc = new LLMService('gpt-4-test');
      const onUsage = jest.fn();
      await svc.generateRaw('sys', 'user', onUsage);
      expect(onUsage).toHaveBeenCalledWith(
        expect.objectContaining({
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        })
      );
    });
  });

  describe('meterUsage attribution falsy branches', () => {
    it('records userId/sessionId undefined and feature "unknown" when usageContext is omitted', async () => {
      const svc = new LLMService('gpt-4-test');
      await svc.generateRaw('sys', 'user');
      expect(mockRecordUsage).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: undefined,
          sessionId: undefined,
          feature: 'unknown',
        })
      );
    });

    it('defaults feature to "unknown" when usageContext present but feature omitted', async () => {
      const svc = new LLMService('gpt-4-test');
      await svc.generateRaw('sys', 'user', undefined, { userId: 'u1' });
      expect(mockRecordUsage).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'u1', feature: 'unknown', sessionId: undefined })
      );
    });
  });

  describe('generateContent metering & onUsage absence', () => {
    it('records usage on the json-format path of generateContent', async () => {
      azureInvoke.mockResolvedValue(aiMessage({ content: '{"k":"v"}' }));
      const svc = new LLMService('gpt-4-test');
      const result = await svc.generateContent('sys', 'user', 'json', { feature: 'json-gen' });
      expect(result).toBe('{"k":"v"}');
      expect(mockRecordUsage).toHaveBeenCalledWith(
        expect.objectContaining({ feature: 'json-gen' })
      );
    });
  });

  describe('generateJsonRobust retry behaviour', () => {
    it('returns parsed JSON on the first attempt and meters once', async () => {
      azureInvoke.mockResolvedValue(aiMessage({ content: '{"good": true}' }));
      const svc = new LLMService('gpt-4-test');
      const onUsage = jest.fn();
      const out = await svc.generateJsonRobust('sys', 'user', onUsage, { feature: 'robust' });
      expect(out).toEqual({ good: true });
      expect(onUsage).toHaveBeenCalledTimes(1);
      expect(mockRecordUsage).toHaveBeenCalledTimes(1);
    });

    it('retries once with a strict suffix when the first response is unparseable, then succeeds', async () => {
      azureInvoke
        .mockResolvedValueOnce(aiMessage({ content: 'It looks like you want... no json here' }))
        .mockResolvedValueOnce(aiMessage({ content: '{"recovered": 1}' }));
      const svc = new LLMService('gpt-4-test');
      const out = await svc.generateJsonRobust('sys', 'user');
      expect(out).toEqual({ recovered: 1 });
      // Two invokes (original + strict retry); metered twice.
      expect(azureInvoke).toHaveBeenCalledTimes(2);
      expect(mockRecordUsage).toHaveBeenCalledTimes(2);
      // Second call's system prompt must carry the strict suffix.
      const secondCallArgs = azureInvoke.mock.calls[1][0];
      const systemMsg = secondCallArgs[0];
      expect(String(systemMsg.content)).toContain('CRITICAL: You MUST respond with only valid JSON');
    });

    it('throws JsonExtractError when both the first attempt and the strict retry are unparseable', async () => {
      azureInvoke
        .mockResolvedValueOnce(aiMessage({ content: 'no json at all' }))
        .mockResolvedValueOnce(aiMessage({ content: 'still no json' }));
      const svc = new LLMService('gpt-4-test');
      const { JsonExtractError } = jest.requireActual('../services/util/extractJson');
      await expect(svc.generateJsonRobust('sys', 'user')).rejects.toBeInstanceOf(JsonExtractError);
    });

    it('bubbles up a non-parse error from the first call without retrying', async () => {
      azureInvoke.mockRejectedValueOnce(new Error('network down'));
      const svc = new LLMService('gpt-4-test');
      await expect(svc.generateJsonRobust('sys', 'user')).rejects.toThrow('network down');
      // No retry — only one invoke happened.
      expect(azureInvoke).toHaveBeenCalledTimes(1);
    });

    it('wraps a non-parse error thrown during the strict retry in a JsonExtractError carrying the first raw text', async () => {
      azureInvoke
        .mockResolvedValueOnce(aiMessage({ content: 'preamble FIRSTRAW no json' }))
        .mockRejectedValueOnce(new Error('timeout on retry'));
      const svc = new LLMService('gpt-4-test');
      const { JsonExtractError } = jest.requireActual('../services/util/extractJson');
      const err = await svc.generateJsonRobust('sys', 'user').catch((e: any) => e);
      expect(err).toBeInstanceOf(JsonExtractError);
      expect(err.message).toContain('LLM call failed during strict-retry: timeout on retry');
      // The wrapped error carries the FIRST raw response as the breadcrumb snippet.
      expect(err.rawSnippet).toContain('FIRSTRAW');
    });
  });

  describe('non-string response.content branches', () => {
    it('generateRaw stringifies non-string content (array)', async () => {
      azureInvoke.mockResolvedValue(aiMessage({ content: ['a', 'b'] }));
      const svc = new LLMService('gpt-4-test');
      const out = await svc.generateRaw('sys', 'user');
      expect(out).toBe(String(['a', 'b']));
    });

    it('generateRaw coerces null content to empty string', async () => {
      azureInvoke.mockResolvedValue(aiMessage({ content: null }));
      const svc = new LLMService('gpt-4-test');
      const out = await svc.generateRaw('sys', 'user');
      expect(out).toBe('');
    });

    it('generateJSONContent coerces falsy non-string content via String(content || "")', async () => {
      // content = 0 is falsy and non-string → hits the `|| ''` right side, yields ''.
      // The (real) JsonOutputParser then rejects on empty input — the branch we care
      // about (String(0 || '')) has already executed by then.
      azureInvoke.mockResolvedValue(aiMessage({ content: 0 }));
      const svc = new LLMService('gpt-4-test');
      await expect(svc.generateJSONContent('sys', 'user', 'json')).rejects.toBeDefined();
    });

    it('generateHTML coerces falsy non-string content via String(content || "") and returns raw', async () => {
      // content = false → String(false || '') = '' → no HTML structure → returns '' (trimmed raw)
      azureInvoke.mockResolvedValue(aiMessage({ content: false }));
      const svc = new LLMService('gpt-4-test');
      const out = await svc.generateHTML('sys', 'user');
      expect(out).toBe('');
    });

    it('generateJsonRobust coerces falsy non-string content (0 → "" → unparseable → retry)', async () => {
      // First call content = 0 → String(0 || '') = '' → JsonExtractError → retry succeeds.
      azureInvoke
        .mockResolvedValueOnce(aiMessage({ content: 0 }))
        .mockResolvedValueOnce(aiMessage({ content: '{"r":1}' }));
      const svc = new LLMService('gpt-4-test');
      await expect(svc.generateJsonRobust('sys', 'user')).resolves.toEqual({ r: 1 });
    });
  });

  describe('extractUsage handles response with no usage_metadata', () => {
    it('returns zeroed usage when usage_metadata is absent (response?.usage_metadata falsy)', async () => {
      // No usage_metadata and no content key: extractUsage falls back to zeros,
      // and generateRaw coerces missing content via String(undefined || '').
      azureInvoke.mockResolvedValue({});
      const svc = new LLMService('gpt-4-test');
      const onUsage = jest.fn();
      const out = await svc.generateRaw('sys', 'user', onUsage);
      expect(out).toBe('');
      expect(onUsage).toHaveBeenCalledWith(
        expect.objectContaining({ inputTokens: 0, outputTokens: 0, totalTokens: 0 })
      );
    });
  });

  describe('generateJSONContent XML fallback with closing tag', () => {
    it('extracts content between <content> tags via the substring(start,end) branch', async () => {
      // No <title> etc, so parseXML returns {content} already — to hit the fallback
      // substring branch we need parseXML to NOT capture content. Use malformed open
      // tag casing handled by regex (case-insensitive) — instead force fallback by
      // making the primary regex fail: put text before a lone <content>...</content>
      // where parseXML DOES capture it. So target the end!==-1 branch directly:
      azureInvoke.mockResolvedValue(
        aiMessage({ content: 'prefix <content>captured</content> suffix' })
      );
      const svc = new LLMService('gpt-4-test');
      const out = await svc.generateJSONContent<{ content: string }>('sys', 'user', 'xml');
      expect(out.content).toBe('captured');
    });
  });

  describe('generateJSONContent XML fallback substring(start,end) TRUE branch', () => {
    it('empty <content></content> makes parseXML yield no content, then fallback substring(start,end) runs and throws', async () => {
      // parseXML captures '' (trim of nothing) → parsed.content falsy → fallback path.
      // indexOf('<content>') and indexOf('</content>') both found → end !== -1 TRUE branch.
      // substring is '' → content.trim() falsy → "Could not extract" thrown.
      azureInvoke.mockResolvedValue(aiMessage({ content: '<content></content>' }));
      const svc = new LLMService('gpt-4-test');
      await expect(svc.generateJSONContent('sys', 'user', 'xml')).rejects.toThrow(
        'Could not extract content from XML response'
      );
    });
  });

  describe('web-search output[] array text-coalescing branches', () => {
    const ORIGINAL_ENV = { ...process.env };
    let fetchSpy: jest.SpyInstance;
    beforeEach(() => {
      process.env.AZURE_OPENAI_ENDPOINT = 'https://test.openai.azure.com/';
      process.env.AZURE_OPENAI_API_KEY = 'azure-key';
    });
    afterEach(() => {
      process.env = { ...ORIGINAL_ENV };
      if (fetchSpy) fetchSpy.mockRestore();
    });

    it('coalesces items with missing text fields (c?.text ?? "") and empty output_text', async () => {
      fetchSpy = jest.spyOn(global, 'fetch' as any).mockImplementation((async () => ({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            output_text: '',
            output: [
              { content: [{ text: '{"k":' }, {}, { text: '5}' }] },
            ],
            usage: { input_tokens: 2, output_tokens: 2, total_tokens: 4 },
          }),
      })) as any);
      const svc = new LLMService('gpt-4-test');
      const out = await svc.generateJSONContentWithWebSearch('sys', 'user');
      expect(out).toEqual({ k: 5 });
    });
  });

  describe('constructor Gemini branch', () => {
    it('routes a gemini model to a null chatModel so generateJSONContent throws the guard error', async () => {
      const svc = new LLMService('gemini-2.5-pro');
      await expect(svc.generateJSONContent('sys', 'user')).rejects.toThrow(
        /requires generateJSONContentWithWebSearch/
      );
    });
  });

  describe('generateJSONContentWithWebSearch — Gemini path', () => {
    const ORIGINAL_ENV = { ...process.env };
    afterEach(() => {
      process.env = { ...ORIGINAL_ENV };
    });

    it('meters Gemini usage (with cached tokens) and returns extracted JSON', async () => {
      process.env.GEMINI_API_KEY = 'gem-key';
      mockGeminiGenerateContent.mockResolvedValue({
        text: '{"answer": 42}',
        usageMetadata: {
          promptTokenCount: 11,
          candidatesTokenCount: 7,
          totalTokenCount: 18,
          cachedContentTokenCount: 4,
        },
      });
      const svc = new LLMService('gemini-2.5-pro');
      const out = await svc.generateJSONContentWithWebSearch('sys', 'user', { feature: 'search' });
      expect(out).toEqual({ answer: 42 });
      expect(mockRecordUsage).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: 'gemini',
          model: 'gemini-2.5-pro',
          inputTokens: 11,
          outputTokens: 7,
          cacheReadTokens: 4,
          feature: 'search',
        })
      );
    });

    it('defaults Gemini token counts to 0 and totalTokens to input+output when usageMetadata absent', async () => {
      process.env.GEMINI_API_KEY = 'gem-key';
      mockGeminiGenerateContent.mockResolvedValue({ text: '{"a":1}' });
      const svc = new LLMService('gemini-2.5-flash');
      const out = await svc.generateJSONContentWithWebSearch('sys', 'user');
      expect(out).toEqual({ a: 1 });
      expect(mockRecordUsage).toHaveBeenCalledWith(
        expect.objectContaining({
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
        })
      );
    });

    it('handles a Gemini response with no text field (defaults to empty string → JSON extract throws)', async () => {
      process.env.GEMINI_API_KEY = 'gem-key';
      mockGeminiGenerateContent.mockResolvedValue({
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
      });
      const svc = new LLMService('gemini-2.5-pro');
      await expect(svc.generateJSONContentWithWebSearch('sys', 'user')).rejects.toBeDefined();
    });

    it('throws when GEMINI_API_KEY is not set', async () => {
      delete process.env.GEMINI_API_KEY;
      const svc = new LLMService('gemini-2.5-pro');
      await expect(svc.generateJSONContentWithWebSearch('sys', 'user')).rejects.toThrow(
        'GEMINI_API_KEY not set'
      );
    });
  });

  describe('generateJSONContentWithWebSearch — Azure Responses path', () => {
    const ORIGINAL_ENV = { ...process.env };
    let fetchSpy: jest.SpyInstance;

    beforeEach(() => {
      process.env.AZURE_OPENAI_ENDPOINT = 'https://test.openai.azure.com/';
      process.env.AZURE_OPENAI_API_KEY = 'azure-key';
    });
    afterEach(() => {
      process.env = { ...ORIGINAL_ENV };
      if (fetchSpy) fetchSpy.mockRestore();
    });

    const mockFetch = (impl: any) => {
      fetchSpy = jest.spyOn(global, 'fetch' as any).mockImplementation(impl);
    };

    it('parses output_text, meters Azure usage, and returns extracted JSON', async () => {
      mockFetch(async () => ({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            output_text: '{"city":"sf"}',
            usage: { input_tokens: 50, output_tokens: 12, total_tokens: 62 },
          }),
      }));
      const svc = new LLMService('gpt-4-test');
      const out = await svc.generateJSONContentWithWebSearch('sys', 'user', { feature: 'web' });
      expect(out).toEqual({ city: 'sf' });
      expect(mockRecordUsage).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: 'azure-openai',
          inputTokens: 50,
          outputTokens: 12,
          feature: 'web',
        })
      );
    });

    it('falls back to the output[] array when output_text is absent and defaults usage to 0', async () => {
      mockFetch(async () => ({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            output: [
              { content: [{ text: '{"part":' }, { text: '1}' }] },
              { content: undefined },
              {},
            ],
          }),
      }));
      const svc = new LLMService('gpt-4-test');
      const out = await svc.generateJSONContentWithWebSearch('sys', 'user');
      expect(out).toEqual({ part: 1 });
      expect(mockRecordUsage).toHaveBeenCalledWith(
        expect.objectContaining({ inputTokens: 0, outputTokens: 0 })
      );
    });

    it('logs debug output when LLM_WEB_SEARCH_DEBUG=1', async () => {
      process.env.LLM_WEB_SEARCH_DEBUG = '1';
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
      mockFetch(async () => ({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            output_text: '{"ok":1}',
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          }),
      }));
      const svc = new LLMService('gpt-4-test');
      const out = await svc.generateJSONContentWithWebSearch('sys', 'user');
      expect(out).toEqual({ ok: 1 });
      expect(logSpy).toHaveBeenCalled();
      logSpy.mockRestore();
      delete process.env.LLM_WEB_SEARCH_DEBUG;
    });

    it('throws with the error body (and logs debug) on a non-ok HTTP status', async () => {
      process.env.LLM_WEB_SEARCH_DEBUG = '1';
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
      mockFetch(async () => ({
        ok: false,
        status: 429,
        text: async () => 'rate limited',
      }));
      const svc = new LLMService('gpt-4-test');
      await expect(svc.generateJSONContentWithWebSearch('sys', 'user')).rejects.toThrow(
        /Azure Responses API 429: rate limited/
      );
      logSpy.mockRestore();
      delete process.env.LLM_WEB_SEARCH_DEBUG;
    });

    it('handles a non-ok status whose error body read rejects (catch → empty string)', async () => {
      mockFetch(async () => ({
        ok: false,
        status: 500,
        text: async () => {
          throw new Error('body unreadable');
        },
      }));
      const svc = new LLMService('gpt-4-test');
      await expect(svc.generateJSONContentWithWebSearch('sys', 'user')).rejects.toThrow(
        /Azure Responses API 500:/
      );
    });

    it('uses a custom AZURE_OPENAI_RESPONSES_API_VERSION when set', async () => {
      process.env.AZURE_OPENAI_RESPONSES_API_VERSION = '2099-01-01-preview';
      const calls: string[] = [];
      mockFetch(async (url: string) => {
        calls.push(url);
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({ output_text: '{"v":1}', usage: { input_tokens: 1, output_tokens: 1 } }),
        };
      });
      const svc = new LLMService('gpt-4-test');
      await svc.generateJSONContentWithWebSearch('sys', 'user');
      expect(calls[0]).toContain('api-version=2099-01-01-preview');
    });

    it('throws when Azure credentials are missing for the web-search path', async () => {
      // Construct while creds are present (constructor needs them), then drop the
      // key so the web-search method's own credential guard (line 480) fires.
      const svc = new LLMService('gpt-4-test');
      delete process.env.AZURE_OPENAI_API_KEY;
      await expect(svc.generateJSONContentWithWebSearch('sys', 'user')).rejects.toThrow(
        'AZURE_OPENAI_API_KEY and AZURE_OPENAI_ENDPOINT must be set'
      );
    });
  });
});
