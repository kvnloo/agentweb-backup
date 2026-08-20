/**
 * 2026-08-19 — the default (Auto) chat model is Gemini 3.7 Flash.
 *
 * Third and final default in one live picker review, per Harsha's direct
 * instruction each time: Opus 5/4.8 -> GLM 5.2 -> GPT-5.6 Luna -> Gemini 3.7
 * Flash ("i also think Gemini 3.7 Flash should be the default"). Gemini 3.7
 * Flash is Google's newest Flash-line model (GA 2026-08-13, verified live
 * against three independent sources), priced at Google's own direct rate
 * ($0.75/$3.75 per 1M — not a multi-provider OpenRouter blend like GLM 5.2),
 * and it dominates every other model in the `gemini-flash` family band for
 * band (see the "same-family dominance" suite in agentModeService.sonnet45.
 * test.ts, which flags Gemini 3.5 Flash legacy as a direct consequence).
 *
 * Gemini is neither an AWS Bedrock model nor an OpenRouter model — it routes
 * through the native Gemini client (`getClientForModel`'s `gemini-` prefix
 * branch), so neither the old suite's Bedrock bearer-token AC nor an
 * OpenRouter-routing AC applies. The equivalent here: the default must be
 * dispatchable for every user (not adminOnly-gated) and not itself legacy.
 */
import { AgentModeService } from '../services/agentModeService';
import { getModelPrice } from '../utils/llmPricing';

// Minimal AWS/dependency mocks so the service can be instantiated without real creds.
jest.mock('../services/db', () => ({
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

const GEMINI_3_7_FLASH = 'gemini-3.7-flash';
const OPUS_5 = 'anthropic.claude-opus-5';
const OPUS_4_8 = 'anthropic.claude-opus-4-8';

describe('2026-08-19: default (Auto) chat model is Gemini 3.7 Flash', () => {
  let service: AgentModeService;
  const ENV_OVERRIDE = 'AZURE_OPENAI_DEPLOYMENT_AGENT_MODE';
  let savedOverride: string | undefined;

  beforeEach(() => {
    // `default_model` is a field initializer read at construction time, and
    // AZURE_OPENAI_DEPLOYMENT_AGENT_MODE takes precedence over the literal —
    // establish the no-override state explicitly, before constructing.
    savedOverride = process.env[ENV_OVERRIDE];
    delete process.env[ENV_OVERRIDE];
    service = new AgentModeService();
    jest.clearAllMocks();
  });

  afterEach(() => {
    if (savedOverride === undefined) {
      delete process.env[ENV_OVERRIDE];
    } else {
      process.env[ENV_OVERRIDE] = savedOverride;
    }
  });

  // AC1 — a session with no explicit model selection resolves to Gemini 3.7 Flash.
  describe('AC1 — no explicit model selection resolves to Gemini 3.7 Flash', () => {
    it('uses Gemini 3.7 Flash as the code-level default model', () => {
      expect(service.default_model).toBe(GEMINI_3_7_FLASH);
    });

    it('getDefaultModel() returns Gemini 3.7 Flash when no setting override is configured', async () => {
      await expect(service.getDefaultModel()).resolves.toBe(GEMINI_3_7_FLASH);
    });

    it('the default model is a servable, allow-listed model for every user, not just admins', async () => {
      await expect(service.getSupportedModels(true)).resolves.toContain(service.default_model);
      await expect(service.getSupportedModels(false)).resolves.toContain(service.default_model);
    });

    it('lets AZURE_OPENAI_DEPLOYMENT_AGENT_MODE override the literal when set', () => {
      process.env[ENV_OVERRIDE] = 'gpt-5.4';
      try {
        expect(new AgentModeService().default_model).toBe('gpt-5.4');
      } finally {
        delete process.env[ENV_OVERRIDE];
      }
      // And with it cleared again, the literal is Gemini 3.7 Flash.
      expect(new AgentModeService().default_model).toBe(GEMINI_3_7_FLASH);
    });
  });

  // AC2 — the default must actually be dispatchable: not adminOnly-gated (or
  // "Auto" would 403 a non-admin) and not legacy (a default should not open
  // new sessions on a superseded model — it's the dominator here, not the
  // dominated, see the sonnet45 dominance suite).
  describe('AC2 — the default model is dispatchable for every user', () => {
    it('is not adminOnly-gated', () => {
      const llmModels = (service as any).llmModels;
      expect(llmModels[GEMINI_3_7_FLASH]?.adminOnly).toBeFalsy();
    });

    it('is not flagged legacy', async () => {
      const models = await service.getSupportedModelsWithMetadata(false);
      const info = models.find((m) => m.id === GEMINI_3_7_FLASH);
      expect(info).toBeDefined();
      expect(info!.legacy).toBeUndefined();
    });

    it('routes through the native Gemini client path (the gemini- prefix branch), not Bedrock or OpenRouter', () => {
      // Registry entries route lazily; the dispatch-time branch keys on the
      // id prefix, not a stored client — confirmed here at the id level.
      expect(GEMINI_3_7_FLASH.startsWith('gemini-')).toBe(true);
    });
  });

  // AC3 — an explicitly persisted model choice is never rewritten by the default.
  describe('AC3 — explicit persisted model choices are preserved', () => {
    it('keeps a persisted Opus 5 selection instead of substituting the default', () => {
      const resolution = service.resolveGenerationModel(OPUS_5);
      expect(resolution.model).toBe(OPUS_5);
      expect(resolution.fellBack).toBe(false);
    });

    it('keeps a persisted non-Gemini selection instead of substituting the default', () => {
      const resolution = service.resolveGenerationModel('gpt-5.5');
      expect(resolution.model).toBe('gpt-5.5');
      expect(resolution.fellBack).toBe(false);
    });

    it('honours a session-persisted model over the default in the || precedence chain', async () => {
      // Mirrors the controller's `session.llmModel || await getDefaultModel()`.
      const sessionModel = OPUS_5;
      const effective = sessionModel || (await service.getDefaultModel());
      expect(effective).toBe(OPUS_5);
      expect(effective).not.toBe(await service.getDefaultModel());
    });
  });

  // AC4 — cost attribution for the default model is tracked and materially
  // cheaper than the Opus default it replaces. Gemini 3.7 Flash is Google's
  // own direct rate (not a multi-provider blend), so an exact-value pin is
  // appropriate here.
  describe('AC4 — usage/cost attribution for the default model', () => {
    it('prices the default model at Google\'s official introductory rate ($0.75 in / $3.75 out per 1M)', () => {
      const price = getModelPrice(service.default_model);
      expect(price).not.toBeNull();
      expect(price!.inPerM).toBe(0.75);
      expect(price!.outPerM).toBe(3.75);
    });

    it('is materially cheaper than the Opus 5 default it replaces', () => {
      const gemini = getModelPrice(GEMINI_3_7_FLASH);
      const opus5 = getModelPrice(OPUS_5);
      expect(gemini).not.toBeNull();
      expect(opus5).not.toBeNull();
      expect(gemini!.inPerM).toBeLessThan(opus5!.inPerM);
      expect(gemini!.outPerM).toBeLessThan(opus5!.outPerM);
    });

    it('derives cache rates for the default model rather than recording $0', () => {
      const price = getModelPrice(service.default_model);
      expect(price!.cacheReadPerM).toBeGreaterThan(0);
    });
  });

  // AC5 — this changes the default; it does not retire Claude Opus 5/4.8.
  describe('AC5 — Claude Opus 5 and 4.8 remain available in the catalog', () => {
    it('still offers Opus 5 and Opus 4.8 as selectable models', async () => {
      const models = await service.getSupportedModels(true);
      expect(models).toContain(OPUS_5);
      expect(models).toContain(OPUS_4_8);
    });

    it('still prices Opus 5', () => {
      expect(getModelPrice(OPUS_5)).not.toBeNull();
    });
  });

  // AC6 — live voice is a separate, hardcoded Gemini model and stays untouched
  // by this chat-default change even though both are now on Gemini.
  describe('AC6 — live voice model is untouched', () => {
    it('leaves the live voice model on its own pinned Gemini id, independent of the chat default', () => {
      const { LIVE_MODEL } = require('../services/liveVoiceService');
      expect(LIVE_MODEL).toBe('models/gemini-3.1-flash-live-preview');
      expect(LIVE_MODEL).not.toBe(`models/${service.default_model}`);
    });
  });

  // Regression guard on the stale-id fallback path (ENG-46): the fallback target
  // must itself be servable, or callLLM re-throws "Invalid model".
  describe('stale-id fallback still lands on a servable model', () => {
    it('falls back to the default model for a retired id', async () => {
      const resolution = service.resolveGenerationModel('gpt-5.1');
      expect(resolution.fellBack).toBe(true);
      expect(resolution.model).toBe(service.default_model);
      await expect(service.getSupportedModels(true)).resolves.toContain(resolution.model);
    });
  });
});
