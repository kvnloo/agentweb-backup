/**
 * ENG-759 — the default chat model is Claude Opus 5.
 *
 * These assertions are derived from the human-written acceptance criteria on
 * ENG-759 and are deliberately expressed against `default_model` rather than a
 * hardcoded string in most places, so they pin the INVARIANT ("whatever the
 * default is, it must be bearer-routed and priced correctly") and not just the
 * literal.
 *
 * Why the invariant matters more than the literal: Opus 5 returns
 * AccessDeniedException on our default AWS account (992382574572) and is only
 * reachable through the bearer-token account (231030591963). A default that is
 * NOT in BEDROCK_BEARER_TOKEN_MODELS breaks every user's chat at once. Haiku 4.5
 * is the exact opposite and must never be given bearer auth.
 */
import { AgentModeService } from '../services/agentModeService';
import {
  BEDROCK_BEARER_TOKEN_MODELS,
  BEDROCK_INFERENCE_PROFILE_MAP,
  resolveBedrockModelId,
} from '../utils/bedrockInferenceProfiles';
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

const OPUS_5 = 'anthropic.claude-opus-5';
const OPUS_4_8 = 'anthropic.claude-opus-4-8';
const HAIKU_4_5 = 'anthropic.claude-haiku-4-5-20251001-v1:0';

describe('ENG-759: default chat model is Claude Opus 5', () => {
  let service: AgentModeService;
  const ENV_OVERRIDE = 'AZURE_OPENAI_DEPLOYMENT_AGENT_MODE';
  let savedOverride: string | undefined;

  beforeEach(() => {
    // `default_model` is a field initializer read at construction time, and
    // AZURE_OPENAI_DEPLOYMENT_AGENT_MODE takes precedence over the literal. A
    // runner with that variable set (some cloud-dev boxes export it) would fail
    // these assertions despite correct application behaviour, so establish the
    // no-override state explicitly rather than assuming it — and delete it
    // BEFORE constructing, or the field is already resolved.
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

  // AC1 — a session with no explicit model selection resolves to Opus 5.
  // settingsService is auto-mocked, so getSetting() resolves undefined: this is
  // exactly the "no configured override" path.
  describe('AC1 — no explicit model selection resolves to Opus 5', () => {
    it('uses Opus 5 as the code-level default model', () => {
      expect(service.default_model).toBe(OPUS_5);
    });

    it('getDefaultModel() returns Opus 5 when no setting override is configured', async () => {
      await expect(service.getDefaultModel()).resolves.toBe(OPUS_5);
    });

    it('the default model is a servable, allow-listed model', async () => {
      await expect(service.getSupportedModels(true)).resolves.toContain(service.default_model);
    });

    // The precedence the assertions above depend on, asserted rather than
    // assumed: env override wins over the literal. Documents why the suite
    // clears the variable, and keeps that reasoning honest if it ever changes.
    it('lets AZURE_OPENAI_DEPLOYMENT_AGENT_MODE override the literal when set', () => {
      process.env[ENV_OVERRIDE] = 'gpt-5.4';
      try {
        expect(new AgentModeService().default_model).toBe('gpt-5.4');
      } finally {
        delete process.env[ENV_OVERRIDE];
      }
      // And with it cleared again, the literal is Opus 5.
      expect(new AgentModeService().default_model).toBe(OPUS_5);
    });
  });

  // AC2 — the bearer-token routing Opus 4.8 relies on must cover the new default.
  // This is the break-everything criterion.
  describe('AC2 — the default model is routed through the bearer-token account', () => {
    it('routes the default model through the bearer-token credential', () => {
      expect(BEDROCK_BEARER_TOKEN_MODELS.has(service.default_model)).toBe(true);
    });

    it('resolves the default model to its cross-account inference profile id', () => {
      expect(resolveBedrockModelId(service.default_model)).toBe('us.anthropic.claude-opus-5');
    });

    it('resolves the default model to a bare profile id, not a default-account ARN', () => {
      // A default-account ARN here would mean SigV4 routing -> AccessDeniedException.
      expect(resolveBedrockModelId(service.default_model)).not.toMatch(/^arn:aws:bedrock:/);
    });

    it('keeps Haiku 4.5 OUT of bearer auth (it lives on the default account)', () => {
      expect(BEDROCK_BEARER_TOKEN_MODELS.has(HAIKU_4_5)).toBe(false);
      expect(resolveBedrockModelId(HAIKU_4_5)).toMatch(
        /^arn:aws:bedrock:us-west-2:992382574572:inference-profile\//
      );
    });
  });

  // AC3 — an explicitly persisted model choice is never rewritten by the default.
  describe('AC3 — explicit persisted model choices are preserved', () => {
    it('keeps a persisted Opus 4.8 selection instead of substituting the default', () => {
      const resolution = service.resolveGenerationModel(OPUS_4_8);
      expect(resolution.model).toBe(OPUS_4_8);
      expect(resolution.fellBack).toBe(false);
    });

    it('keeps a persisted non-Claude selection instead of substituting the default', () => {
      const resolution = service.resolveGenerationModel('gpt-5.5');
      expect(resolution.model).toBe('gpt-5.5');
      expect(resolution.fellBack).toBe(false);
    });

    it('honours a session-persisted model over the default in the || precedence chain', async () => {
      // Mirrors the controller's `session.llmModel || await getDefaultModel()`.
      const sessionModel = OPUS_4_8;
      const effective = sessionModel || (await service.getDefaultModel());
      expect(effective).toBe(OPUS_4_8);
      expect(effective).not.toBe(await service.getDefaultModel());
    });
  });

  // AC4 — cost attribution records the new default at $5/$25.
  describe('AC4 — usage/cost attribution for the default model', () => {
    it('prices the default model at $5 in / $25 out per 1M tokens', () => {
      const price = getModelPrice(service.default_model);
      expect(price).not.toBeNull();
      expect(price!.inPerM).toBe(5);
      expect(price!.outPerM).toBe(25);
    });

    it('prices Opus 5 identically to the Opus 4.8 it replaces (no cost change)', () => {
      const opus5 = getModelPrice(OPUS_5);
      const opus48 = getModelPrice(OPUS_4_8);
      expect(opus5).not.toBeNull();
      expect(opus48).not.toBeNull();
      expect(opus5!.inPerM).toBe(opus48!.inPerM);
      expect(opus5!.outPerM).toBe(opus48!.outPerM);
    });

    it('derives cache rates for the default model rather than recording $0', () => {
      const price = getModelPrice(service.default_model);
      expect(price!.cacheReadPerM).toBeCloseTo(0.5, 6);
      expect(price!.cacheWritePerM).toBeCloseTo(6.25, 6);
    });
  });

  // AC5 — this changes the default; it does not retire Opus 4.8.
  describe('AC5 — Opus 4.8 remains available in the catalog', () => {
    it('still offers Opus 4.8 as a selectable model', async () => {
      await expect(service.getSupportedModels(true)).resolves.toContain(OPUS_4_8);
    });

    it('still maps and bearer-routes Opus 4.8', () => {
      expect(BEDROCK_INFERENCE_PROFILE_MAP[OPUS_4_8]).toBe('us.anthropic.claude-opus-4-8');
      expect(BEDROCK_BEARER_TOKEN_MODELS.has(OPUS_4_8)).toBe(true);
    });

    it('still prices Opus 4.8', () => {
      expect(getModelPrice(OPUS_4_8)).not.toBeNull();
    });
  });

  // AC6 — live voice is a separate, hardcoded Gemini model and stays untouched.
  describe('AC6 — live voice model is untouched', () => {
    it('leaves the live voice model on Gemini, independent of the chat default', () => {
      // Required lazily: liveVoiceService is only needed for this constant.
      const { LIVE_MODEL } = require('../services/liveVoiceService');
      expect(LIVE_MODEL).toBe('models/gemini-3.1-flash-live-preview');
      expect(LIVE_MODEL).not.toContain('opus');
      expect(LIVE_MODEL).not.toBe(service.default_model);
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
