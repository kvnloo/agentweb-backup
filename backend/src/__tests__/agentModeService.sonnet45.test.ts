import { AgentModeService } from '../services/agentModeService';
import { getSecret } from '../utils/secretsManager';

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

// Mock Bedrock modules — uses ConverseCommand directly (no LangChain)
const mockBedrockSend = jest.fn();
let lastConverseInput: any = null;

jest.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: jest.fn().mockImplementation(() => ({
    send: mockBedrockSend,
  })),
  ConverseCommand: jest.fn().mockImplementation((input: any) => {
    lastConverseInput = input;
    return { input };
  }),
}));

describe('AgentModeService - Claude Sonnet 4.5 Support', () => {
  let agentModeService: AgentModeService;

  beforeEach(() => {
    agentModeService = new AgentModeService();
    jest.clearAllMocks();
    process.env.AWS_REGION = 'us-west-2';
    process.env.AWS_ACCESS_KEY_ID = 'test-key';
    process.env.AWS_SECRET_ACCESS_KEY = 'test-secret';
    // Bearer-token models (Opus 4.8) read the Bedrock API key from Secrets Manager.
    (getSecret as jest.Mock).mockResolvedValue('ABSK-test-bearer-token');
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

    it('should include Claude Opus 4.6 in the supported models for admins', async () => {
      const models = await agentModeService.getSupportedModels(true);
      expect(models).toContain('anthropic.claude-opus-4-6-v1');
    });

    it('should NOT include Claude Opus 4.6 in the supported models for non-admins', async () => {
      const models = await agentModeService.getSupportedModels(false);
      expect(models).not.toContain('anthropic.claude-opus-4-6-v1');
    });

    it('should NOT include Claude Opus 4.6 by default (non-admin)', async () => {
      const models = await agentModeService.getSupportedModels();
      expect(models).not.toContain('anthropic.claude-opus-4-6-v1');
    });

    it('should include Claude Opus 4.8 in the supported models for admins', async () => {
      const models = await agentModeService.getSupportedModels(true);
      expect(models).toContain('anthropic.claude-opus-4-8');
    });

    it('should include Claude Opus 4.8 in the supported models for non-admins', async () => {
      const models = await agentModeService.getSupportedModels(false);
      expect(models).toContain('anthropic.claude-opus-4-8');
    });

    it('should include Claude Opus 4.8 by default', async () => {
      const models = await agentModeService.getSupportedModels();
      expect(models).toContain('anthropic.claude-opus-4-8');
    });

    it('should have null client initially for Opus 4.8 (lazy-loaded)', () => {
      const llmModels = (agentModeService as any).llmModels;
      expect(llmModels['anthropic.claude-opus-4-8'].client).toBeNull();
    });

    /*
     * ENG-744 — the Claude 5 generation is offered alongside the existing entries.
     * AC #1 is the getSupportedModels() assertions; AC #5 (nothing re-routed) is
     * covered by the "default model unchanged" test further down.
     */
    describe('ENG-744 — Claude 5 generation', () => {
      const CLAUDE_5 = [
        'anthropic.claude-opus-5',
        'anthropic.claude-sonnet-5',
        'anthropic.claude-haiku-4-5-20251001-v1:0',
      ];

      it.each(CLAUDE_5)('offers %s to non-admins (AC #1 — added, not admin-gated)', async (id) => {
        const models = await agentModeService.getSupportedModels(false);
        expect(models).toContain(id);
      });

      it.each(CLAUDE_5)('offers %s to admins', async (id) => {
        const models = await agentModeService.getSupportedModels(true);
        expect(models).toContain(id);
      });

      it.each(CLAUDE_5)('lazy-loads the client for %s', (id) => {
        expect((agentModeService as any).llmModels[id].client).toBeNull();
      });

      /*
       * Verified against live Bedrock, not assumed: Opus 5 and Sonnet 5 both
       * return HTTP 400 "`temperature` is deprecated for this model", so sending
       * temperature would break every call. Haiku 4.5 accepts it.
       */
      it('marks Opus 5 and Sonnet 5 as rejecting temperature (live-verified 400)', () => {
        const llmModels = (agentModeService as any).llmModels;
        expect(llmModels['anthropic.claude-opus-5'].supportsTemperature).toBe(false);
        expect(llmModels['anthropic.claude-sonnet-5'].supportsTemperature).toBe(false);
      });

      it('keeps temperature enabled for Haiku 4.5, which still accepts it', () => {
        const llmModels = (agentModeService as any).llmModels;
        expect(llmModels['anthropic.claude-haiku-4-5-20251001-v1:0'].supportsTemperature).toBe(true);
      });

      it.each(CLAUDE_5)('marks %s as vision-capable', (id) => {
        expect((agentModeService as any).llmModels[id].supportsVision).toBe(true);
      });

      /*
       * SUPERSEDED by ENG-759 (approved by Harsha 2026-07-30: "opus 5 as default
       * is fine"). ENG-744's AC #5 was "merely ADDING the Claude 5 family must not
       * re-route the default" — that guard was correct for ENG-744 and is still
       * the intent here: the default only moves by an explicit, approved decision.
       * ENG-759 is that decision, so the expected value changes from 'gpt-5.5' to
       * Opus 5 while the guard itself is kept (it would still catch an accidental
       * re-route caused by a future catalog addition).
       */
      it('AC #5 — default model only moves by explicit decision (now Opus 5, ENG-759)', async () => {
        // `default_model` is a field initializer and
        // AZURE_OPENAI_DEPLOYMENT_AGENT_MODE takes precedence over the literal,
        // so any runner exporting a deployment override (backend/.env sets one)
        // silently defeated this guard — it asserted the environment rather than
        // the code. Establish the no-override state and construct AFTER clearing,
        // or the field is already resolved. Same reasoning as the ENG-759 suite
        // in agentModeService.defaultModelOpus5.test.ts.
        const envOverride = 'AZURE_OPENAI_DEPLOYMENT_AGENT_MODE';
        const savedOverride = process.env[envOverride];
        delete process.env[envOverride];
        try {
          expect(new AgentModeService().default_model).toBe('anthropic.claude-opus-5');
        } finally {
          if (savedOverride === undefined) {
            delete process.env[envOverride];
          } else {
            process.env[envOverride] = savedOverride;
          }
        }
      });

      it('AC #6 — leaves the live voice model untouched', () => {
        const live = (agentModeService as any).llmModels['gemini-3.1-flash-live-preview'];
        expect(live).toEqual({ client: null, supportsTemperature: false, isLive: true });
      });
    });

    /*
     * ENG-744 — gemini-3-pro-preview was shut down by Google on 2026-03-09 and
     * returns a hard 404 ("This model ... is no longer available") on a real
     * generateContent call, yet it stayed in the registry and was still offered
     * by GET /public/llm-models. Selecting it was a guaranteed user-facing
     * failure for ~4.5 months. llmPricing.ts:94 already carried a DEPRECATED
     * 2026-03-09 note — pricing knew; the registry never caught up.
     *
     * NOTE: the issue's AC #7 says withdrawn models are "reported rather than
     * silently removed". This removal is deliberate and explicitly authorized
     * (PM tick, recorded on ENG-744 and in the PR body) — i.e. reported, not
     * silent. Migration target is gemini-3.1-pro-preview.
     *
     * It also stands as the reason AC #3 is verified by invoking rather than by
     * listing: this model still appears in Google's ListModels while 404ing on
     * the actual call, so a discovery-endpoint check proves nothing.
     */
    describe('ENG-744 — withdrawn model removal', () => {
      it('no longer offers the shut-down gemini-3-pro-preview to anyone', async () => {
        for (const isAdmin of [true, false]) {
          const models = await agentModeService.getSupportedModels(isAdmin);
          expect(models).not.toContain('gemini-3-pro-preview');
        }
      });

      it('drops it from the registry entirely, not just from the served list', () => {
        expect((agentModeService as any).llmModels['gemini-3-pro-preview']).toBeUndefined();
      });

      it('keeps the still-live Gemini models it sat next to', async () => {
        const models = await agentModeService.getSupportedModels(false);
        for (const id of [
          'gemini-3-flash-preview',
          'gemini-3.1-pro-preview',
          'gemini-3.1-flash-lite',
          'gemini-3.5-flash',
        ]) {
          expect(models).toContain(id);
        }
      });
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

    it('should include gpt-5.4 in the supported models', async () => {
      const models = await agentModeService.getSupportedModels();
      expect(models).toContain('gpt-5.4');
    });

    it('should have temperature support enabled for gpt-5.4', () => {
      const llmModels = (agentModeService as any).llmModels;
      expect(llmModels['gpt-5.4'].supportsTemperature).toBe(true);
    });

    it('should have a non-null client for gpt-5.4 (Azure client created eagerly)', () => {
      const llmModels = (agentModeService as any).llmModels;
      expect(llmModels['gpt-5.4'].client).not.toBeNull();
    });

    it('should include gpt-5.4-nano in the supported models', async () => {
      const models = await agentModeService.getSupportedModels();
      expect(models).toContain('gpt-5.4-nano');
    });

    it('should have temperature support enabled for gpt-5.4-nano', () => {
      const llmModels = (agentModeService as any).llmModels;
      expect(llmModels['gpt-5.4-nano'].supportsTemperature).toBe(true);
    });

    it('should have a non-null client for gpt-5.4-nano (Azure client created eagerly)', () => {
      const llmModels = (agentModeService as any).llmModels;
      expect(llmModels['gpt-5.4-nano'].client).not.toBeNull();
    });

    it('should include gpt-5.5 in the supported models', async () => {
      const models = await agentModeService.getSupportedModels();
      expect(models).toContain('gpt-5.5');
    });

    it('should have temperature support disabled for gpt-5.5', () => {
      const llmModels = (agentModeService as any).llmModels;
      expect(llmModels['gpt-5.5'].supportsTemperature).toBe(false);
    });

    it('should have a non-null client for gpt-5.5 (Azure client created eagerly)', () => {
      const llmModels = (agentModeService as any).llmModels;
      expect(llmModels['gpt-5.5'].client).not.toBeNull();
    });

    it('should have maxTools: 128 for all Azure OpenAI gpt-5.x models', () => {
      const llmModels = (agentModeService as any).llmModels;
      expect(llmModels['gpt-5-chat-2'].maxTools).toBe(128);
      expect(llmModels['gpt-5.2-chat'].maxTools).toBe(128);
      expect(llmModels['gpt-5.4'].maxTools).toBe(128);
      expect(llmModels['gpt-5.4-nano'].maxTools).toBe(128);
      expect(llmModels['gpt-5.5'].maxTools).toBe(128);
    });

    it('should NOT set maxTools on Gemini or Bedrock models', () => {
      const llmModels = (agentModeService as any).llmModels;
      expect(llmModels['gemini-3.1-pro-preview'].maxTools).toBeUndefined();
      expect(llmModels['anthropic.claude-sonnet-4-6'].maxTools).toBeUndefined();
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

    it('should include Gemini 3.1 Flash Lite Preview in the supported models', async () => {
      const models = await agentModeService.getSupportedModels();
      expect(models).toContain('gemini-3.1-flash-lite');
    });

    it('should have temperature support enabled for Gemini 3.1 Flash Lite Preview', () => {
      const llmModels = (agentModeService as any).llmModels;
      expect(llmModels['gemini-3.1-flash-lite'].supportsTemperature).toBe(true);
    });

    it('should have null client initially for Gemini 3.1 Flash Lite Preview (lazy-loaded)', () => {
      const llmModels = (agentModeService as any).llmModels;
      expect(llmModels['gemini-3.1-flash-lite'].client).toBeNull();
    });

    it('should include Gemini 3.5 Flash in the supported models', async () => {
      const models = await agentModeService.getSupportedModels();
      expect(models).toContain('gemini-3.5-flash');
    });

    it('should have temperature support enabled for Gemini 3.5 Flash', () => {
      const llmModels = (agentModeService as any).llmModels;
      expect(llmModels['gemini-3.5-flash'].supportsTemperature).toBe(true);
    });

    it('should have null client initially for Gemini 3.5 Flash (lazy-loaded)', () => {
      const llmModels = (agentModeService as any).llmModels;
      expect(llmModels['gemini-3.5-flash'].client).toBeNull();
    });

    it('should NOT set maxTools on Gemini 3.5 Flash', () => {
      const llmModels = (agentModeService as any).llmModels;
      expect(llmModels['gemini-3.5-flash'].maxTools).toBeUndefined();
    });

    it('should return only anthropic non-opus models from getReportsModelOptions for non-admins', async () => {
      const reportsModels = await agentModeService.getReportsModelOptions(false);
      expect(reportsModels.length).toBeGreaterThan(0);
      reportsModels.forEach(model => {
        expect(model).toMatch(/^anthropic\./);
        expect(model).not.toContain('opus');
      });
    });

    it('should include opus in getReportsModelOptions for admins', async () => {
      const reportsModels = await agentModeService.getReportsModelOptions(true);
      expect(reportsModels).toContain('anthropic.claude-opus-4-6-v1');
    });

    it('should NOT include opus in getReportsModelOptions by default (non-admin)', async () => {
      const reportsModels = await agentModeService.getReportsModelOptions();
      expect(reportsModels).not.toContain('anthropic.claude-opus-4-6-v1');
    });

    it('should return only anthropic models from getReportsModelOptions', async () => {
      const reportsModels = await agentModeService.getReportsModelOptions(true);
      expect(reportsModels.length).toBeGreaterThan(0);
      reportsModels.forEach(model => {
        expect(model).toMatch(/^anthropic\./);
      });
      // Verify it excludes non-anthropic models
      const allModels = await agentModeService.getSupportedModels(true);
      const nonAnthropicModels = allModels.filter(m => !m.startsWith('anthropic.'));
      expect(nonAnthropicModels.length).toBeGreaterThan(0);
      nonAnthropicModels.forEach(model => {
        expect(reportsModels).not.toContain(model);
      });
    });
  });

  describe('getSupportedModels default model ordering', () => {
    it('should place the configured default model first in the list', async () => {
      const { settingsService } = require('../services/settingsService');
      const llmModels = (agentModeService as any).llmModels;
      const allModels = Object.keys(llmModels).filter((m: string) => !llmModels[m].adminOnly);
      // Configure a model that is NOT first in the natural object-key order
      const nonFirstModel = allModels[allModels.length - 1];
      (settingsService.getSetting as jest.Mock).mockResolvedValue({
        settingValue: nonFirstModel,
      });

      const models = await agentModeService.getSupportedModels();
      expect(models[0]).toBe(nonFirstModel);
      expect(models.length).toBe(allModels.length);
      // No duplicates
      expect(new Set(models).size).toBe(models.length);
    });

    it('should place the configured default model first in the list for admins (including opus)', async () => {
      const { settingsService } = require('../services/settingsService');
      const allModels = Object.keys((agentModeService as any).llmModels);
      const nonFirstModel = allModels[allModels.length - 1];
      (settingsService.getSetting as jest.Mock).mockResolvedValue({
        settingValue: nonFirstModel,
      });

      const models = await agentModeService.getSupportedModels(true);
      expect(models[0]).toBe(nonFirstModel);
      expect(models.length).toBe(allModels.length);
      expect(new Set(models).size).toBe(models.length);
    });

    it('should put hardcoded default first when no default model is configured in settings', async () => {
      const { settingsService } = require('../services/settingsService');
      (settingsService.getSetting as jest.Mock).mockResolvedValue(null);

      // Pin default_model to a known valid key — env var may point to a
      // placeholder not in llmModels, which would make the ordering untestable.
      const originalDefault = (agentModeService as any).default_model;
      const validDefault = Object.keys((agentModeService as any).llmModels)[0];
      (agentModeService as any).default_model = validDefault;
      try {
        const models = await agentModeService.getSupportedModels();
        expect(models[0]).toBe(validDefault);
      } finally {
        (agentModeService as any).default_model = originalDefault;
      }
    });

    it('should fall back to hardcoded default when configured default is not in the model list', async () => {
      const { settingsService } = require('../services/settingsService');
      (settingsService.getSetting as jest.Mock).mockResolvedValue({
        settingValue: 'nonexistent-model-xyz',
      });

      // Pin default_model to a known valid key — same reason as above.
      const originalDefault = (agentModeService as any).default_model;
      const validDefault = Object.keys((agentModeService as any).llmModels)[0];
      (agentModeService as any).default_model = validDefault;
      try {
        const models = await agentModeService.getSupportedModels();
        expect(models[0]).toBe(validDefault);
      } finally {
        (agentModeService as any).default_model = originalDefault;
      }
    });

    it('should keep original order when settings service throws', async () => {
      const { settingsService } = require('../services/settingsService');
      (settingsService.getSetting as jest.Mock).mockRejectedValue(new Error('DB error'));

      const llmModels = (agentModeService as any).llmModels;
      const models = await agentModeService.getSupportedModels();
      const naturalOrder = Object.keys(llmModels).filter((m: string) => !llmModels[m].adminOnly);
      // Falls back to env/hardcoded default which is likely first anyway
      expect(models.length).toBe(naturalOrder.length);
    });
  });

  describe('Bedrock client lazy-loading', () => {
    beforeEach(() => {
      // Mock ConverseCommand response format (Bedrock native, not LangChain)
      mockBedrockSend.mockResolvedValue({
        output: { message: { role: 'assistant', content: [{ text: 'test response' }] } },
        usage: { inputTokens: 10, outputTokens: 5 },
        stopReason: 'end_turn',
      });
    });

    it('should lazy-load Bedrock client for Sonnet 4.5 on first callLLM', async () => {
      const messages = [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'Hello' },
      ];

      await (agentModeService as any).callLLM(
        'anthropic.claude-sonnet-4-5-20250929-v1:0',
        messages
      );

      const llmModels = (agentModeService as any).llmModels;
      expect(llmModels['anthropic.claude-sonnet-4-5-20250929-v1:0'].client).not.toBeNull();
    });

    it('should lazy-load Bedrock client for Sonnet 4.6 on first callLLM', async () => {
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
    // ENG-737: gemini calls always resolve via getGeminiNativeClient (the only
    // transport — no compat fallback, no kill-switch) instead of caching on
    // llmModels[model].client — that cache was removed deliberately so nothing
    // stale can survive a settings change. getGeminiNativeClient is synchronous.

    it('should lazy-load the native Gemini client for gemini-3.1-pro-preview on first callLLM', async () => {
      const mockCreate = jest.fn().mockResolvedValue({
        choices: [{ message: { content: 'test response' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      });
      const mockGeminiClient = { chat: { completions: { create: mockCreate } } };

      jest.spyOn(agentModeService as any, 'getGeminiNativeClient').mockReturnValue(mockGeminiClient);

      const messages = [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'Hello' },
      ];

      await (agentModeService as any).callLLM('gemini-3.1-pro-preview', messages);

      expect((agentModeService as any).getGeminiNativeClient).toHaveBeenCalled();
      expect(mockCreate).toHaveBeenCalled();
    });

    it('should lazy-load the native Gemini client for gemini-3.1-flash-lite on first callLLM', async () => {
      const mockCreate = jest.fn().mockResolvedValue({
        choices: [{ message: { content: 'test response' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      });
      const mockGeminiClient = { chat: { completions: { create: mockCreate } } };

      jest.spyOn(agentModeService as any, 'getGeminiNativeClient').mockReturnValue(mockGeminiClient);

      const messages = [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'Hello' },
      ];

      await (agentModeService as any).callLLM('gemini-3.1-flash-lite', messages);

      expect((agentModeService as any).getGeminiNativeClient).toHaveBeenCalled();
      expect(mockCreate).toHaveBeenCalled();
    });

    it('should lazy-load the native Gemini client for gemini-3.5-flash on first callLLM', async () => {
      const mockCreate = jest.fn().mockResolvedValue({
        choices: [{ message: { content: 'test response' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      });
      const mockGeminiClient = { chat: { completions: { create: mockCreate } } };

      jest.spyOn(agentModeService as any, 'getGeminiNativeClient').mockReturnValue(mockGeminiClient);

      const messages = [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'Hello' },
      ];

      await (agentModeService as any).callLLM('gemini-3.5-flash', messages);

      expect((agentModeService as any).getGeminiNativeClient).toHaveBeenCalled();
      expect(mockCreate).toHaveBeenCalled();
    });
  });

  describe('Bedrock client lazy-loading (Opus 4.8)', () => {
    it('should lazy-load the Bedrock client for anthropic.claude-opus-4-8 on first callLLM', async () => {
      // Opus 4.8 runs on Bedrock (separate account, bearer-token auth) despite its
      // bare "claude-" id, so it must route to getBedrockClient, not Vertex.
      const mockCreate = jest.fn().mockResolvedValue({
        choices: [{ message: { role: 'assistant', content: 'Hi!', tool_calls: undefined }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 9, completion_tokens: 13, total_tokens: 22 },
      });
      const mockBedrockClient = { chat: { completions: { create: mockCreate } } };

      jest.spyOn(agentModeService as any, 'getBedrockClient').mockResolvedValue(mockBedrockClient);
      const vertexSpy = jest.spyOn(agentModeService as any, 'getVertexClient');

      const messages = [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'Hello' },
      ];

      await (agentModeService as any).callLLM('anthropic.claude-opus-4-8', messages);

      expect((agentModeService as any).getBedrockClient).toHaveBeenCalledWith('anthropic.claude-opus-4-8');
      expect(vertexSpy).not.toHaveBeenCalled();

      const llmModels = (agentModeService as any).llmModels;
      expect(llmModels['anthropic.claude-opus-4-8'].client).toBe(mockBedrockClient);
    });
  });

  describe('Legacy model id normalization (Opus 4.8 rename)', () => {
    // Sessions created before commit c86c8ec1 persisted the bare "claude-opus-4-8"
    // id (Vertex era). After the rename to "anthropic.claude-opus-4-8" (Bedrock),
    // those legacy ids must be transparently mapped so old sessions keep working
    // instead of throwing "Invalid model 'claude-opus-4-8'".
    it('should NOT throw "Invalid model" for the legacy claude-opus-4-8 id', async () => {
      const mockCreate = jest.fn().mockResolvedValue({
        choices: [{ message: { role: 'assistant', content: 'Hi!', tool_calls: undefined }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 9, completion_tokens: 13, total_tokens: 22 },
      });
      const mockBedrockClient = { chat: { completions: { create: mockCreate } } };
      jest.spyOn(agentModeService as any, 'getBedrockClient').mockResolvedValue(mockBedrockClient);

      const messages = [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'Hello' },
      ];

      await expect(
        (agentModeService as any).callLLM('claude-opus-4-8', messages)
      ).resolves.toBeDefined();
    });

    it('should route the legacy claude-opus-4-8 id to the Bedrock client, not Vertex', async () => {
      const mockCreate = jest.fn().mockResolvedValue({
        choices: [{ message: { role: 'assistant', content: 'Hi!', tool_calls: undefined }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 9, completion_tokens: 13, total_tokens: 22 },
      });
      const mockBedrockClient = { chat: { completions: { create: mockCreate } } };
      jest.spyOn(agentModeService as any, 'getBedrockClient').mockResolvedValue(mockBedrockClient);
      const vertexSpy = jest.spyOn(agentModeService as any, 'getVertexClient');

      const messages = [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'Hello' },
      ];

      await (agentModeService as any).callLLM('claude-opus-4-8', messages);

      // Must resolve to the canonical Bedrock id, never the Vertex client.
      expect((agentModeService as any).getBedrockClient).toHaveBeenCalledWith('anthropic.claude-opus-4-8');
      expect(vertexSpy).not.toHaveBeenCalled();
    });

    it('normalizeModelId maps the legacy id to the canonical Bedrock id', () => {
      expect((agentModeService as any).normalizeModelId('claude-opus-4-8')).toBe('anthropic.claude-opus-4-8');
    });

    it('normalizeModelId leaves canonical and unknown ids unchanged', () => {
      expect((agentModeService as any).normalizeModelId('anthropic.claude-opus-4-8')).toBe('anthropic.claude-opus-4-8');
      expect((agentModeService as any).normalizeModelId('gpt-5.5')).toBe('gpt-5.5');
      expect((agentModeService as any).normalizeModelId(undefined)).toBeUndefined();
    });
  });

  describe('Inference profile ARN mapping', () => {
    beforeEach(() => {
      mockBedrockSend.mockResolvedValue({
        output: { message: { role: 'assistant', content: [{ text: 'test response' }] } },
        usage: { inputTokens: 10, outputTokens: 5 },
        stopReason: 'end_turn',
      });
    });

    it('should map Sonnet 4.5 to its inference profile ARN', async () => {
      const { ConverseCommand } = require('@aws-sdk/client-bedrock-runtime');

      await (agentModeService as any).callLLM(
        'anthropic.claude-sonnet-4-5-20250929-v1:0',
        [{ role: 'system', content: 'Test' }, { role: 'user', content: 'Hello' }]
      );

      expect(ConverseCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          modelId: 'arn:aws:bedrock:us-west-2:992382574572:inference-profile/global.anthropic.claude-sonnet-4-5-20250929-v1:0',
        })
      );
    });

    it('should map Sonnet 4.6 to its inference profile ARN', async () => {
      const { ConverseCommand } = require('@aws-sdk/client-bedrock-runtime');

      await (agentModeService as any).callLLM(
        'anthropic.claude-sonnet-4-6',
        [{ role: 'system', content: 'Test' }, { role: 'user', content: 'Hello' }]
      );

      expect(ConverseCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          modelId: 'arn:aws:bedrock:us-west-2:992382574572:inference-profile/global.anthropic.claude-sonnet-4-6',
        })
      );
    });

    it('should map Opus 4.6 to its inference profile ARN', async () => {
      const { ConverseCommand } = require('@aws-sdk/client-bedrock-runtime');

      await (agentModeService as any).callLLM(
        'anthropic.claude-opus-4-6-v1',
        [{ role: 'system', content: 'Test' }, { role: 'user', content: 'Hello' }]
      );

      expect(ConverseCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          modelId: 'arn:aws:bedrock:us-west-2:992382574572:inference-profile/global.anthropic.claude-opus-4-6-v1',
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

  describe('callLLM maxTools truncation (Azure OpenAI 128-tool limit)', () => {
    it('should truncate tools to maxTools limit for gpt-5.4', async () => {
      const mockCreate = jest.fn().mockResolvedValue({
        choices: [{ message: { content: 'response', tool_calls: null } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      });
      const llmModels = (agentModeService as any).llmModels;
      llmModels['gpt-5.4'].client = { chat: { completions: { create: mockCreate } } };

      const tools = Array.from({ length: 143 }, (_, i) => ({
        type: 'function',
        function: { name: `tool_${i}`, description: `Tool ${i}`, parameters: { type: 'object', properties: {} } }
      }));

      await (agentModeService as any).callLLM('gpt-5.4', [{ role: 'user', content: 'test' }], { tools });

      const calledParams = mockCreate.mock.calls[0][0];
      expect(calledParams.tools).toHaveLength(128);
      expect(calledParams.tools[0].function.name).toBe('tool_0');
      expect(calledParams.tools[127].function.name).toBe('tool_127');
    });

    it('should NOT truncate tools when count is at or below maxTools', async () => {
      const mockCreate = jest.fn().mockResolvedValue({
        choices: [{ message: { content: 'response', tool_calls: null } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      });
      const llmModels = (agentModeService as any).llmModels;
      llmModels['gpt-5.4'].client = { chat: { completions: { create: mockCreate } } };

      const tools = Array.from({ length: 128 }, (_, i) => ({
        type: 'function',
        function: { name: `tool_${i}`, description: `Tool ${i}`, parameters: { type: 'object', properties: {} } }
      }));

      await (agentModeService as any).callLLM('gpt-5.4', [{ role: 'user', content: 'test' }], { tools });

      const calledParams = mockCreate.mock.calls[0][0];
      expect(calledParams.tools).toHaveLength(128);
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

  describe('getReportGenerationDefaultModel', () => {
    const { settingsService } = require('../services/settingsService');

    it('should return report generation model when configured', async () => {
      (settingsService.getSetting as jest.Mock).mockResolvedValue({
        settingValue: 'anthropic.claude-sonnet-4-6',
      });

      const model = await agentModeService.getReportGenerationDefaultModel();
      expect(model).toBe('anthropic.claude-sonnet-4-6');
      expect(settingsService.getSetting).toHaveBeenCalledWith('agent_mode_report_generation_default_model');
    });

    it('should fall back to general default model when not configured', async () => {
      (settingsService.getSetting as jest.Mock)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ settingValue: 'anthropic.claude-opus-4-6-v1' });

      const model = await agentModeService.getReportGenerationDefaultModel();
      expect(model).toBe('anthropic.claude-opus-4-6-v1');
    });

    it('should fall back to env/hardcoded default when neither setting is configured', async () => {
      (settingsService.getSetting as jest.Mock).mockResolvedValue(null);

      const model = await agentModeService.getReportGenerationDefaultModel();
      expect(model).toBe(agentModeService.default_model);
    });

    it('should fall back to general default when report generation model is unsupported', async () => {
      (settingsService.getSetting as jest.Mock)
        .mockResolvedValueOnce({ settingValue: 'nonexistent-model' })
        .mockResolvedValueOnce({ settingValue: 'anthropic.claude-sonnet-4-6' });

      const model = await agentModeService.getReportGenerationDefaultModel();
      expect(model).toBe('anthropic.claude-sonnet-4-6');
    });
  });

  describe('getImageGenerationDefaultModel', () => {
    const { settingsService } = require('../services/settingsService');

    it('should return image generation model when configured', async () => {
      (settingsService.getSetting as jest.Mock).mockResolvedValue({
        settingValue: 'anthropic.claude-sonnet-4-6',
      });

      const model = await agentModeService.getImageGenerationDefaultModel();
      expect(model).toBe('anthropic.claude-sonnet-4-6');
      expect(settingsService.getSetting).toHaveBeenCalledWith('agent_mode_image_generation_default_model');
    });

    it('should fall back to general default model when not configured', async () => {
      (settingsService.getSetting as jest.Mock)
        .mockResolvedValueOnce(null) // image generation setting
        .mockResolvedValueOnce({ settingValue: 'anthropic.claude-opus-4-6-v1' }); // general default

      const model = await agentModeService.getImageGenerationDefaultModel();
      expect(model).toBe('anthropic.claude-opus-4-6-v1');
    });

    it('should fall back to env/hardcoded default when neither setting is configured', async () => {
      (settingsService.getSetting as jest.Mock).mockResolvedValue(null);

      const model = await agentModeService.getImageGenerationDefaultModel();
      expect(model).toBe(agentModeService.default_model);
    });

    it('should fall back to general default when image generation model is unsupported', async () => {
      (settingsService.getSetting as jest.Mock)
        .mockResolvedValueOnce({ settingValue: 'nonexistent-model' }) // unsupported
        .mockResolvedValueOnce({ settingValue: 'anthropic.claude-sonnet-4-6' }); // general default

      const model = await agentModeService.getImageGenerationDefaultModel();
      expect(model).toBe('anthropic.claude-sonnet-4-6');
    });
  });

  describe('getVideoGenerationDefaultModel', () => {
    const { settingsService } = require('../services/settingsService');

    it('should return video generation model when configured', async () => {
      (settingsService.getSetting as jest.Mock).mockResolvedValue({
        settingValue: 'anthropic.claude-sonnet-4-6',
      });

      const model = await agentModeService.getVideoGenerationDefaultModel();
      expect(model).toBe('anthropic.claude-sonnet-4-6');
      expect(settingsService.getSetting).toHaveBeenCalledWith('agent_mode_video_generation_default_model');
    });

    it('should fall back to general default model when not configured', async () => {
      (settingsService.getSetting as jest.Mock)
        .mockResolvedValueOnce(null) // video generation setting
        .mockResolvedValueOnce({ settingValue: 'anthropic.claude-opus-4-6-v1' }); // general default

      const model = await agentModeService.getVideoGenerationDefaultModel();
      expect(model).toBe('anthropic.claude-opus-4-6-v1');
    });

    it('should fall back to env/hardcoded default when neither setting is configured', async () => {
      (settingsService.getSetting as jest.Mock).mockResolvedValue(null);

      const model = await agentModeService.getVideoGenerationDefaultModel();
      expect(model).toBe(agentModeService.default_model);
    });

    it('should fall back to general default when video generation model is unsupported', async () => {
      (settingsService.getSetting as jest.Mock)
        .mockResolvedValueOnce({ settingValue: 'nonexistent-model' }) // unsupported
        .mockResolvedValueOnce({ settingValue: 'anthropic.claude-sonnet-4-6' }); // general default

      const model = await agentModeService.getVideoGenerationDefaultModel();
      expect(model).toBe('anthropic.claude-sonnet-4-6');
    });
  });
});
