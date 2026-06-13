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
});
