/**
 * ENG-893 — extended (1-hour) prompt-cache TTL on the Bedrock Converse path.
 *
 * Long, human-paced agent-mode sessions were paying ~77% of their bill in
 * cache-WRITE churn: every time the user took longer than the default 5-minute
 * prompt-cache TTL to reply, the whole 100k+ token prefix was re-written at
 * 1.25x the input rate instead of being read back at 0.1x.
 *
 * The Converse API accepts `cachePoint: { type: 'default', ttl: '1h' }` on the
 * models whose Bedrock model card lists "5 minutes, 1 hour" under Supported TTL.
 * These tests pin (a) that we ask for it on those models, (b) that we do NOT ask
 * for it on models that only support 5m (Bedrock rejects an unsupported ttl),
 * and (c) that the price book charges those models' cache writes at the 2x
 * extended-TTL rate rather than the 1.25x default-TTL rate.
 */

import { AgentModeService } from '../services/agentModeService';
import { getModelPrice, MODEL_PRICING } from '../utils/llmPricing';
import {
  BEDROCK_EXTENDED_CACHE_TTL_MODELS,
  bedrockCacheTtl,
} from '../utils/bedrockInferenceProfiles';

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
      get: jest.fn(), put: jest.fn(), update: jest.fn(), delete: jest.fn(),
      scan: jest.fn(), query: jest.fn(),
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
jest.mock('../utils/secretsManager', () => ({
  getSecret: jest.fn().mockResolvedValue('test-bedrock-bearer-token'),
}));

const mockBedrockSend = jest.fn();
jest.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: jest.fn().mockImplementation(() => ({
    send: mockBedrockSend,
  })),
  ConverseCommand: jest.fn().mockImplementation((input: any) => ({ input })),
}));

/** A 4-message conversation, so the wrapper emits BOTH cache points. */
const CONVERSATION = [
  { role: 'system', content: 'System prompt here' },
  { role: 'user', content: 'First message' },
  { role: 'assistant', content: 'First response' },
  { role: 'user', content: 'Second message' },
];

function lastBlockOfPivot(input: any): any {
  const pivot = input.messages[input.messages.length - 2];
  return pivot.content[pivot.content.length - 1];
}

describe('ENG-893 — Bedrock prompt-cache TTL', () => {
  describe('bedrockCacheTtl', () => {
    it('returns 1h for models whose Bedrock model card lists a 1-hour TTL', () => {
      expect(bedrockCacheTtl('anthropic.claude-opus-5')).toBe('1h');
      expect(bedrockCacheTtl('anthropic.claude-sonnet-5')).toBe('1h');
      expect(bedrockCacheTtl('anthropic.claude-opus-4-8')).toBe('1h');
    });

    it('returns undefined for 5-minute-only models, so no ttl field is sent', () => {
      // Bedrock rejects `ttl` on a model that does not support it, so the
      // omission here is load-bearing, not cosmetic.
      expect(bedrockCacheTtl('anthropic.claude-sonnet-4-6')).toBeUndefined();
      expect(bedrockCacheTtl('anthropic.claude-opus-4-6-v1')).toBeUndefined();
    });

    it('returns undefined for non-Bedrock and unknown model ids', () => {
      expect(bedrockCacheTtl('gpt-5-chat-2')).toBeUndefined();
      expect(bedrockCacheTtl('gemini-3.1-pro-preview')).toBeUndefined();
      expect(bedrockCacheTtl('')).toBeUndefined();
      // Prototype members must not resolve as if they were mapped model ids.
      expect(bedrockCacheTtl('constructor')).toBeUndefined();
    });
  });

  describe('cachePoint markers on the Converse request', () => {
    let agentModeService: AgentModeService;

    beforeEach(() => {
      agentModeService = new AgentModeService();
      jest.clearAllMocks();
      process.env.AWS_REGION = 'us-west-2';
      process.env.AWS_ACCESS_KEY_ID = 'test-key';
      process.env.AWS_SECRET_ACCESS_KEY = 'test-secret';

      mockBedrockSend.mockResolvedValue({
        output: { message: { role: 'assistant', content: [{ text: 'response' }] } },
        usage: {
          inputTokens: 100,
          outputTokens: 20,
          cacheReadInputTokens: 80,
          cacheWriteInputTokens: 0,
        },
        stopReason: 'end_turn',
      });
    });

    afterEach(() => {
      delete process.env.AWS_REGION;
      delete process.env.AWS_ACCESS_KEY_ID;
      delete process.env.AWS_SECRET_ACCESS_KEY;
    });

    it('asks for the 1h TTL on the system cache point for an extended-TTL model', async () => {
      const { ConverseCommand } = require('@aws-sdk/client-bedrock-runtime');

      await (agentModeService as any).callLLM('anthropic.claude-opus-5', CONVERSATION);

      const input = (ConverseCommand as jest.Mock).mock.calls[0][0];
      expect(input.system).toEqual([
        { text: 'System prompt here' },
        { cachePoint: { type: 'default', ttl: '1h' } },
      ]);
    });

    it('asks for the 1h TTL on the conversation-prefix cache point too', async () => {
      const { ConverseCommand } = require('@aws-sdk/client-bedrock-runtime');

      await (agentModeService as any).callLLM('anthropic.claude-opus-5', CONVERSATION);

      const input = (ConverseCommand as jest.Mock).mock.calls[0][0];
      // The history — not the ~14k-token system prompt — is the bulk of the
      // 80k-185k re-caches, so the message checkpoint is the one that matters.
      expect(lastBlockOfPivot(input)).toEqual({ cachePoint: { type: 'default', ttl: '1h' } });
    });

    it('emits two independent cachePoint objects (no shared reference)', async () => {
      const { ConverseCommand } = require('@aws-sdk/client-bedrock-runtime');

      await (agentModeService as any).callLLM('anthropic.claude-opus-5', CONVERSATION);

      const input = (ConverseCommand as jest.Mock).mock.calls[0][0];
      const systemPoint = input.system[input.system.length - 1];
      expect(systemPoint).not.toBe(lastBlockOfPivot(input));
    });

    it('omits ttl entirely on a 5-minute-only model', async () => {
      const { ConverseCommand } = require('@aws-sdk/client-bedrock-runtime');

      await (agentModeService as any).callLLM('anthropic.claude-sonnet-4-6', CONVERSATION);

      const input = (ConverseCommand as jest.Mock).mock.calls[0][0];
      expect(input.system[input.system.length - 1]).toEqual({ cachePoint: { type: 'default' } });
      expect(lastBlockOfPivot(input)).toEqual({ cachePoint: { type: 'default' } });
    });

    it('never mixes TTLs within one request (Bedrock requires longer TTLs first)', async () => {
      const { ConverseCommand } = require('@aws-sdk/client-bedrock-runtime');

      for (const model of ['anthropic.claude-opus-5', 'anthropic.claude-sonnet-4-6']) {
        (ConverseCommand as jest.Mock).mockClear();
        await (agentModeService as any).callLLM(model, CONVERSATION);
        const input = (ConverseCommand as jest.Mock).mock.calls[0][0];
        const ttls = [...input.system, ...input.messages.flatMap((m: any) => m.content)]
          .filter((b: any) => b?.cachePoint)
          .map((b: any) => b.cachePoint.ttl);
        expect(ttls.length).toBeGreaterThan(1);
        expect(new Set(ttls).size).toBe(1);
      }
    });
  });

  describe('cache-write pricing follows the requested TTL', () => {
    it('charges extended-TTL models 2x input for cache writes, not 1.25x', () => {
      for (const model of BEDROCK_EXTENDED_CACHE_TTL_MODELS) {
        const price = getModelPrice(model);
        expect(price).not.toBeNull();
        expect(price!.cacheWritePerM).toBeCloseTo(price!.inPerM * 2, 10);
      }
    });

    it('leaves default-TTL Bedrock models on the 1.25x cache-write rate', () => {
      const price = getModelPrice('anthropic.claude-sonnet-4-6');
      expect(price!.cacheWritePerM).toBeCloseTo(price!.inPerM * 1.25, 10);
    });

    it('keeps the price book and the TTL allowlist from drifting apart', () => {
      // Every model we ask for a 1h TTL must be priced at the 1h write rate,
      // and nothing else may be — this is the guard that stops the two lists
      // from silently diverging when a new Bedrock model is added.
      for (const [model, price] of Object.entries(MODEL_PRICING)) {
        if (!model.startsWith('anthropic.')) continue;
        const expectedMultiplier = BEDROCK_EXTENDED_CACHE_TTL_MODELS.has(model) ? 2 : 1.25;
        expect(price.cacheWritePerM).toBeCloseTo(price.inPerM * expectedMultiplier, 10);
      }
    });
  });
});
