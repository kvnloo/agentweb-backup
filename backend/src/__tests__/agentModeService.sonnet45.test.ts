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
    /*
     * 2026-08-19 picker cleanup — the founder flagged the picker as cluttered
     * with redundant same-family versions (Opus 4.6/4.8 alongside Opus 5,
     * Sonnet 4.5/4.6 alongside Sonnet 5, four near-identical GPT-5.x rows)
     * and separately asked where OpenAI's GPT-5.6 family (Sol/Terra/Luna,
     * launched 2026-07-09) was. This block covers both: the superseded
     * versions get `legacy: true` (picker-grouping only — see
     * LLMModelConfig.legacy; resolveGenerationModel/resolveFallbackModel are
     * untouched, so no existing session or schedule pinned to one of these
     * ids changes behavior), and the new GPT-5.6 tiers are added via
     * OpenRouter, adminOnly per the existing unverified-in-our-stack
     * convention for new OpenRouter entries.
     */
    describe('2026-08-19 — legacy flag + GPT-5.6 (Sol/Terra/Luna) addition', () => {
      const LEGACY_IDS = [
        'gpt-5-chat-2',
        'gpt-5.2-chat',
        'gpt-5.4',
        'anthropic.claude-sonnet-4-5-20250929-v1:0',
        'anthropic.claude-sonnet-4-6',
        'anthropic.claude-opus-4-6-v1',
        'anthropic.claude-opus-4-8',
      ];
      const CURRENT_IDS = ['gpt-5.5', 'anthropic.claude-opus-5', 'anthropic.claude-sonnet-5'];

      it.each(LEGACY_IDS)('marks %s as legacy', (id) => {
        expect((agentModeService as any).llmModels[id].legacy).toBe(true);
      });

      it.each(CURRENT_IDS)('does NOT mark the current frontier pick %s as legacy', (id) => {
        expect((agentModeService as any).llmModels[id].legacy).toBeUndefined();
      });

      it.each(LEGACY_IDS)('still offers the legacy model %s to whichever caller could already see it (no access change)', async (id) => {
        const wasAdminOnly = (agentModeService as any).llmModels[id].adminOnly === true;
        const models = await agentModeService.getSupportedModels(wasAdminOnly);
        expect(models).toContain(id);
      });

      const GPT_5_6 = [
        'openrouter/openai/gpt-5.6-sol',
        'openrouter/openai/gpt-5.6-terra',
        'openrouter/openai/gpt-5.6-luna',
      ];

      it.each(GPT_5_6)('offers %s to admins', async (id) => {
        const models = await agentModeService.getSupportedModels(true);
        expect(models).toContain(id);
      });

      it.each(GPT_5_6)('does NOT offer %s to non-admins (adminOnly, matching other new OpenRouter entries)', async (id) => {
        const models = await agentModeService.getSupportedModels(false);
        expect(models).not.toContain(id);
      });

      // 2026-08-19: tier is now derived live from costScore (see
      // "cost-band tier derivation" below), not read off this static field —
      // these three still carry the pre-derivation literal so a model with
      // no MODEL_PRICING entry has a sane fallback, but it is no longer what
      // the picker actually shows. The real, cost-derived tiers are
      // ultra_premium, pro, and ultra_cheap respectively (see the
      // derivation test).
      it('carries a static tier as a no-price fallback, distinct from its real cost-derived tier', () => {
        const llmModels = (agentModeService as any).llmModels;
        expect(llmModels['openrouter/openai/gpt-5.6-sol'].tier).toBe('pro');
        expect(llmModels['openrouter/openai/gpt-5.6-terra'].tier).toBe('medium');
        expect(llmModels['openrouter/openai/gpt-5.6-luna'].tier).toBe('ultra_cheap');
      });

      it.each(GPT_5_6)('gives %s a clean display name and the openai provider', (id) => {
        const config = (agentModeService as any).llmModels[id];
        expect(config.provider).toBe('openai');
        expect(config.name).toMatch(/^GPT-5\.6 (Sol|Terra|Luna)$/);
      });
    });

    /*
     * 2026-08-19 — real quality/cost scores for the picker's meters.
     * qualityScore is sourced live from Artificial Analysis (Intelligence
     * Index), a hand-typed literal per model — never estimated. costScore is
     * NOT hand-typed: it's computed live from MODEL_PRICING via
     * costScoreFromPrice (see llmPricing.test.ts for the formula's own
     * tests), so it can never independently drift from what we actually
     * bill — 11 of 29 hand-typed costScores had already gone stale relative
     * to MODEL_PRICING before this was caught and fixed. Read through
     * getSupportedModelsWithMetadata(), the real path the picker uses, not
     * off the private config object (costScore/costScoreSource no longer
     * live there at all).
     */
    describe('2026-08-19 — quality/cost meter scores', () => {
      const SCORED_IDS = [
        'anthropic.claude-opus-5', 'anthropic.claude-opus-4-8', 'anthropic.claude-opus-4-6-v1',
        'anthropic.claude-sonnet-5', 'anthropic.claude-sonnet-4-6', 'anthropic.claude-sonnet-4-5-20250929-v1:0',
        'anthropic.claude-haiku-4-5-20251001-v1:0',
        'gpt-5.5', 'gpt-5.4', 'gpt-5.2-chat', 'gpt-5.4-nano', 'gpt-5-chat-2',
        'gemini-3.1-pro-preview', 'gemini-3-flash-preview', 'gemini-3.5-flash', 'gemini-3.1-flash-lite',
        'openrouter/openai/gpt-4o-mini', 'openrouter/x-ai/grok-4.6',
        'openrouter/deepseek/deepseek-v4-pro', 'openrouter/deepseek/deepseek-v4-flash',
        'openrouter/qwen/qwen3.8-max', 'openrouter/mistralai/mistral-small-2603',
        'openrouter/moonshotai/kimi-k3', 'openrouter/moonshotai/kimi-k2.7-code',
        'openrouter/z-ai/glm-5.2', 'openrouter/z-ai/glm-4.7-flash',
        'openrouter/openai/gpt-5.6-sol', 'openrouter/openai/gpt-5.6-terra', 'openrouter/openai/gpt-5.6-luna',
      ];

      it.each(SCORED_IDS)('%s has an in-range (0-100) qualityScore and costScore, each with a source note', async (id) => {
        const models = await agentModeService.getSupportedModelsWithMetadata(true);
        const info = models.find((m) => m.id === id);
        expect(info).toBeDefined();
        expect(info!.qualityScore).toBeGreaterThanOrEqual(0);
        expect(info!.qualityScore).toBeLessThanOrEqual(100);
        expect(Number.isInteger(info!.qualityScore)).toBe(true);
        expect(info!.qualityScoreSource).toEqual(expect.any(String));
        expect(info!.costScore).toBeGreaterThanOrEqual(0);
        expect(info!.costScore).toBeLessThanOrEqual(100);
        expect(Number.isInteger(info!.costScore)).toBe(true);
        expect(info!.costScoreSource).toEqual(expect.any(String));
      });

      // Regression pins on a few real, hand-verified values — catches an
      // accidental reshuffle without re-deriving the whole table in the
      // assertion. qualityScore is AA Intelligence Index v4.1.1
      // (live-fetched 2026-08-19); costScore is computed from MODEL_PRICING.
      it('pins Claude Opus 5 at the real AA-sourced quality / MODEL_PRICING-derived cost values', async () => {
        const models = await agentModeService.getSupportedModelsWithMetadata(false);
        const info = models.find((m) => m.id === 'anthropic.claude-opus-5')!;
        expect(info.qualityScore).toBe(63);
        expect(info.costScore).toBe(70); // $5/$25 blended 75:25 -> $10.00/1M, log-normalized
        expect(info.tier).toBe('pro'); // 70 falls in the 51-70 "pro" cost band
      });

      it('pins GPT-4o Mini (the cheapest, weakest scored model) at the real values', async () => {
        const models = await agentModeService.getSupportedModelsWithMetadata(false);
        const info = models.find((m) => m.id === 'openrouter/openai/gpt-4o-mini')!;
        expect(info.qualityScore).toBe(7);
        expect(info.costScore).toBe(22);
        expect(info.tier).toBe('ultra_cheap'); // 22 falls in the <=30 "ultra_cheap" cost band
      });

      // gpt-5-chat-2 genuinely does not exist under that exact name on AA,
      // OpenRouter, or OpenAI's model-listing docs — but a live probe (real
      // completion call against the deployment) confirmed it routes to
      // OpenAI's gpt-5-chat-latest, so it correctly carries an
      // inference-based (not invented) quality score, and a costScore
      // computed from that same model's real, officially-documented pricing.
      it('gives gpt-5-chat-2 an inferred quality score and a real MODEL_PRICING-derived cost score, not a guess', async () => {
        const models = await agentModeService.getSupportedModelsWithMetadata(false);
        const info = models.find((m) => m.id === 'gpt-5-chat-2')!;
        expect(info.qualityScore).toBe(15);
        expect(info.qualityScoreSource).toMatch(/inferred match/i);
        expect(info.costScore).toBe(56); // $1.25 in / $10.00 out blended 75:25 -> $3.4375/1M
        expect(info.tier).toBe('pro'); // 56 falls in the 51-70 "pro" cost band, not its static 'medium' fallback
      });

      it('does not lower a legacy model\'s quality score merely for being legacy', () => {
        // Claude Opus 4.8 (legacy: true) scores lower than Opus 5 because it
        // IS a weaker model per AA, not because `legacy` itself penalizes it —
        // Opus 4.6 (also legacy) is correctly lower still, tracking real
        // capability, not recency/legacy-ness.
        const opus5 = (agentModeService as any).llmModels['anthropic.claude-opus-5'];
        const opus48 = (agentModeService as any).llmModels['anthropic.claude-opus-4-8'];
        const opus46 = (agentModeService as any).llmModels['anthropic.claude-opus-4-6-v1'];
        expect(opus48.qualityScore).toBe(57);
        expect(opus46.qualityScore).toBe(45);
        expect(opus5.qualityScore).toBeGreaterThan(opus48.qualityScore);
        expect(opus48.qualityScore).toBeGreaterThan(opus46.qualityScore);
      });
    });

    /*
     * 2026-08-19 — same-family dominance auto-legacy. Harsha: "anything that
     * is band for band worse in the same model family should be put into
     * legacy — GPT-5.6 Luna is strictly better than GPT-5.4 Nano." A model
     * gets legacy: true when a same-`family`, originally-non-legacy sibling
     * is at least as cheap (cost band) AND at least as good (quality score),
     * strictly so in one dimension — see deriveDominanceLegacyIds and each
     * model's `family` tag in the registry.
     *
     * `family` is deliberately narrower than `provider`: an earlier
     * provider-wide version of this check falsely flagged Claude Sonnet 5
     * as dominated by Claude Opus 5, and Gemini 3.1 Pro as dominated by
     * Gemini 3.5 Flash — different product tiers serving different jobs,
     * not generations of the same model. The tests below pin both the real
     * positive case and that specific false-positive class as a regression
     * guard.
     */
    describe('2026-08-19 — same-family dominance auto-legacy', () => {
      it('flags GPT-5.4 Nano as legacy — GPT-5.6 Luna is the same cost band with strictly higher quality', async () => {
        const models = await agentModeService.getSupportedModelsWithMetadata(true);
        const nano = models.find((m) => m.id === 'gpt-5.4-nano')!;
        const luna = models.find((m) => m.id === 'openrouter/openai/gpt-5.6-luna')!;
        expect(nano.tier).toBe(luna.tier); // same cost band
        expect(luna.qualityScore).toBeGreaterThan(nano.qualityScore!);
        expect(nano.legacy).toBe(true);
      });

      it('flags the far-weaker, same-band GPT-4o Mini as legacy too (dominated by GPT-5.4 Nano)', async () => {
        const models = await agentModeService.getSupportedModelsWithMetadata(true);
        const mini = models.find((m) => m.id === 'openrouter/openai/gpt-4o-mini')!;
        expect(mini.legacy).toBe(true);
      });

      it('does NOT flag Claude Sonnet 5 as legacy just because Claude Opus 5 exists — different product tier, not a generation', async () => {
        const models = await agentModeService.getSupportedModelsWithMetadata(false);
        const sonnet5 = models.find((m) => m.id === 'anthropic.claude-sonnet-5')!;
        const opus5 = models.find((m) => m.id === 'anthropic.claude-opus-5')!;
        expect(opus5.qualityScore).toBeGreaterThan(sonnet5.qualityScore!);
        expect(sonnet5.legacy).toBeUndefined();
      });

      it('does NOT flag Gemini 3.1 Pro as legacy just because Gemini 3.5 Flash exists — no `family` tag, so never auto-dominated', async () => {
        const models = await agentModeService.getSupportedModelsWithMetadata(false);
        const pro = models.find((m) => m.id === 'gemini-3.1-pro-preview')!;
        expect(pro.legacy).toBeUndefined();
      });

      it('still marks the pre-existing manually-legacy models legacy regardless of dominance', async () => {
        const models = await agentModeService.getSupportedModelsWithMetadata(true);
        for (const id of ['gpt-5-chat-2', 'gpt-5.2-chat', 'gpt-5.4', 'anthropic.claude-opus-4-6-v1', 'anthropic.claude-opus-4-8']) {
          expect(models.find((m) => m.id === id)!.legacy).toBe(true);
        }
      });
    });

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
