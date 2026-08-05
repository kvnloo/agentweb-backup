/**
 * ENG-893 — extended (1-hour) prompt-cache TTL on the Bedrock Converse path.
 *
 * Long, human-paced agent-mode sessions were paying ~77% of their bill in
 * cache-WRITE churn: every time the user took longer than the default 5-minute
 * prompt-cache TTL to reply, the whole 100k+ token prefix was re-written at
 * 1.25x the input rate instead of being read back at 0.1x.
 *
 * The Converse API accepts `cachePoint: { type: 'default', ttl: '1h' }`. These
 * tests pin (a) that we ask for it on the models we have verified honour it,
 * (b) that we do NOT ask for it on the rest, and (c) that cache writes bill at
 * the rate for the TTL Bedrock actually APPLIED.
 *
 * (b) and (c) are not the same guard. Bedrock does NOT reject an unsupported
 * `ttl` — probed live in us-west-2, models AWS documents as 5-minute-only
 * accept the field — so the allowlist cannot protect us from a crash. What
 * protects the ledger is (c): billing off `usage.cacheDetails` means asking for
 * 1h and being served 5m costs 1.25x, not 2x.
 */

import { AgentModeService } from '../services/agentModeService';
import { getModelPrice, MODEL_PRICING, cacheWriteCost } from '../utils/llmPricing';
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
      // Live-verified against the docs table, which is stale — see ENG-893.
      expect(bedrockCacheTtl('anthropic.claude-sonnet-4-6')).toBe('1h');
      expect(bedrockCacheTtl('anthropic.claude-opus-4-6-v1')).toBe('1h');
    });

    it('returns undefined for a Bedrock model we have not verified', () => {
      // Every model we currently SERVE is verified 1h-capable, so the negative
      // branch is reached only by a model we have not measured — an older id,
      // or the next one AWS ships. It must default to today's 5-minute
      // behaviour rather than opting itself in.
      expect(bedrockCacheTtl('anthropic.claude-3-7-sonnet-20250219-v1:0')).toBeUndefined();
      expect(bedrockCacheTtl('anthropic.claude-opus-4-20250514-v1:0')).toBeUndefined();
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

    it('omits ttl entirely on an unverified Bedrock model', async () => {
      const { ConverseCommand } = require('@aws-sdk/client-bedrock-runtime');

      // No SERVED model takes this branch today, so register a stand-in for the
      // next Bedrock model added: it must send the bare block until someone
      // measures it and adds it to the allowlist.
      const unverified = 'anthropic.claude-3-7-sonnet-20250219-v1:0';
      (agentModeService as any).llmModels[unverified] = { client: null, supportsTemperature: true };

      await (agentModeService as any).callLLM(unverified, CONVERSATION);

      const input = (ConverseCommand as jest.Mock).mock.calls[0][0];
      expect(input.system[input.system.length - 1]).toEqual({ cachePoint: { type: 'default' } });
      expect(lastBlockOfPivot(input)).toEqual({ cachePoint: { type: 'default' } });
    });

    it('never mixes TTLs within one request (Bedrock requires longer TTLs first)', async () => {
      const { ConverseCommand } = require('@aws-sdk/client-bedrock-runtime');

      const unverified = 'anthropic.claude-3-7-sonnet-20250219-v1:0';
      (agentModeService as any).llmModels[unverified] = { client: null, supportsTemperature: true };
      for (const model of ['anthropic.claude-opus-5', unverified]) {
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

  describe('the price book stays on the DEFAULT-TTL rate', () => {
    it('declares 1.25x for every Bedrock Anthropic model, extended-TTL or not', () => {
      // The 1-hour uplift is applied per RESPONSE (cacheWriteCost), never per
      // model. A model id can be used by one path that requests 1h and another
      // that does not — Sonnet 4.6 is exactly that, shared between agent-mode
      // and codingAgentService — so a per-model 2x rate would over-bill the
      // 5-minute callers by 60%.
      for (const [model, price] of Object.entries(MODEL_PRICING)) {
        if (!model.startsWith('anthropic.')) continue;
        expect(price.cacheWritePerM).toBeCloseTo(price.inPerM * 1.25, 10);
      }
    });

    it('still asks for the 1h TTL on every allowlisted model, and prices it', () => {
      expect(BEDROCK_EXTENDED_CACHE_TTL_MODELS.size).toBeGreaterThan(0);
      for (const model of BEDROCK_EXTENDED_CACHE_TTL_MODELS) {
        expect(bedrockCacheTtl(model)).toBe('1h');
        // …and it must still be a priced model, or the ledger books $0.
        expect(getModelPrice(model)).not.toBeNull();
      }
    });
  });

  describe('cacheWriteCost bills the TTL that was APPLIED, not the one requested', () => {
    // The reason this exists: Bedrock accepts `ttl: '1h'` on models AWS
    // documents as 5-minute-only, so "we asked for 1h" is not evidence we got
    // it. Billing off `usage.cacheDetails` makes a wrong allowlist entry cost
    // missed savings instead of a 60% over-charge.
    const opus5 = getModelPrice('anthropic.claude-opus-5')!;

    it('charges 2x for tokens Bedrock reported at the 1-hour TTL', () => {
      expect(cacheWriteCost(opus5, 1_000_000, { '1h': 1_000_000 })).toBeCloseTo(10_000_000, 6);
    });

    it('charges only 1.25x when Bedrock served a 5-minute cache instead', () => {
      // Same model, same tokens, same request — but a 5m write came back.
      expect(cacheWriteCost(opus5, 1_000_000, { '5m': 1_000_000 })).toBeCloseTo(6_250_000, 6);
    });

    it('bills a mixed-TTL response per bucket', () => {
      const cost = cacheWriteCost(opus5, 300_000, { '1h': 200_000, '5m': 100_000 });
      expect(cost).toBeCloseTo(200_000 * 10 + 100_000 * 6.25, 6);
    });

    it('falls back to the declared rate when no breakdown is present', () => {
      expect(cacheWriteCost(opus5, 1_000_000, undefined)).toBeCloseTo(
        1_000_000 * opus5.cacheWritePerM!,
        6
      );
    });

    it('bills tokens the breakdown does not account for at the declared rate', () => {
      // Never silently drop billable tokens because a bucket went missing.
      const cost = cacheWriteCost(opus5, 500_000, { '1h': 200_000 });
      expect(cost).toBeCloseTo(200_000 * 10 + 300_000 * opus5.cacheWritePerM!, 6);
    });

    it('bills an unknown future TTL tier at the declared rate, never at zero', () => {
      const cost = cacheWriteCost(opus5, 100_000, { '24h': 100_000 });
      expect(cost).toBeCloseTo(100_000 * opus5.cacheWritePerM!, 6);
      expect(cost).toBeGreaterThan(0);
    });

    it('ignores non-positive and non-finite bucket values', () => {
      const cost = cacheWriteCost(opus5, 0, { '1h': 0, '5m': Number.NaN });
      expect(cost).toBe(0);
    });

    it('bills the SAME model differently per path, which is the whole point', () => {
      // Sonnet 4.6 is requested with ttl:'1h' by agent-mode and with no ttl by
      // codingAgentService / rcaEnricher. One model id, two correct answers —
      // only reachable by pricing from the response.
      const sonnet46 = getModelPrice('anthropic.claude-sonnet-4-6')!;
      expect(cacheWriteCost(sonnet46, 100_000, { '1h': 100_000 })).toBeCloseTo(100_000 * 6, 6);
      expect(cacheWriteCost(sonnet46, 100_000, { '5m': 100_000 })).toBeCloseTo(100_000 * 3.75, 6);
    });
  });
});
