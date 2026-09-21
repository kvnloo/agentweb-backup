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
       * SUPERSEDED again 2026-09-02 (Harsha, in-session approval: Gemini 3.8
       * Flash landed in the same family/tier as Gemini 3.7 Flash and beat it
       * on quality, dominance correctly flagged 3.7 legacy, and leaving the
       * pinned default on a legacy model contradicted its own AC2 — see the
       * comment above the default_model field and
       * agentModeService.defaultModelGemini38Flash.test.ts). ENG-744's AC #5
       * was "merely ADDING the Claude 5 family must not re-route the default"
       * — that guard is still the intent here: the default only moves by an
       * explicit, approved decision. This is that decision, so the expected
       * value changes to Gemini 3.8 Flash while the guard itself is kept (it
       * would still catch an accidental re-route caused by a future catalog
       * addition).
       */
      it('AC #5 — default model only moves by explicit decision (now Gemini 3.8 Flash, 2026-09-02)', async () => {
        // `default_model` is a field initializer and
        // AZURE_OPENAI_DEPLOYMENT_AGENT_MODE takes precedence over the literal,
        // so any runner exporting a deployment override (backend/.env sets one)
        // silently defeated this guard — it asserted the environment rather than
        // the code. Establish the no-override state and construct AFTER clearing,
        // or the field is already resolved. Same reasoning as the suite in
        // agentModeService.defaultModelGemini38Flash.test.ts.
        const envOverride = 'AZURE_OPENAI_DEPLOYMENT_AGENT_MODE';
        const savedOverride = process.env[envOverride];
        delete process.env[envOverride];
        try {
          expect(new AgentModeService().default_model).toBe('gemini-3.8-flash');
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
     * OpenRouter. Originally adminOnly per the existing unverified-in-our-
     * stack convention for new OpenRouter entries; opened to all users
     * 2026-08-19 (Harsha: "i'm fine to include open source / open router
     * stuff for all users not just isadmin") — see the "opened to everyone"
     * describe block below.
     */
    describe('2026-08-19 — legacy flag + GPT-5.6 (Sol/Terra/Luna) addition', () => {
      const LEGACY_IDS = [
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

      // 2026-08-19: Harsha opened every OpenRouter entry (including this
      // GPT-5.6 family) to all users, not just admins — see the dedicated
      // "opened to everyone" block below for the full OpenRouter list.
      it.each(GPT_5_6)('also offers %s to non-admins', async (id) => {
        const models = await agentModeService.getSupportedModels(false);
        expect(models).toContain(id);
      });

      // 2026-08-19: tier is now derived live from costScore (see
      // "cost-band tier derivation" below), not read off this static field —
      // these three still carry the pre-derivation literal so a model with
      // no MODEL_PRICING entry has a sane fallback, but it is no longer what
      // the picker actually shows. With ENG-1784's bands (Frontier ≥64,
      // Pro 58–63, Medium 53–57, Cheap 31–52) the real, cost-derived tiers
      // are ultra_premium (Sol, 71), pro (Terra, 62) and cheap (Luna, 50)
      // respectively — see the ENG-1784 block for the pinned outcomes.
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
     * 2026-08-19 — every OpenRouter entry opened to everyone. Harsha: "i'm
     * fine to include open source / open router stuff for all users not
     * just isadmin." Was `adminOnly: true` on each (gated as
     * unproven-in-our-stack); removed. Does NOT touch adminOnly gates
     * elsewhere in the registry that exist for unrelated reasons (e.g.
     * anthropic.claude-opus-4-6-v1, still Bedrock-Claude-tier-gated).
     */
    describe('2026-08-19 — OpenRouter models opened to everyone (no longer adminOnly)', () => {
      const OPENROUTER_IDS = [
        'openrouter/x-ai/grok-4.6',
        'openrouter/deepseek/deepseek-v4-pro',
        'openrouter/deepseek/deepseek-v4-flash',
        'openrouter/qwen/qwen3.8-max',
        'openrouter/mistralai/mistral-small-2603',
        'openrouter/moonshotai/kimi-k3',
        'openrouter/moonshotai/kimi-k2.7-code',
        'openrouter/z-ai/glm-5.2',
        'openrouter/z-ai/glm-4.7-flash',
        'openrouter/openai/gpt-5.6-sol',
        'openrouter/openai/gpt-5.6-terra',
        'openrouter/openai/gpt-5.6-luna',
        'openrouter/openai/gpt-6-astra', // ENG-1769
      ];

      it.each(OPENROUTER_IDS)('%s carries no adminOnly flag', (id) => {
        expect((agentModeService as any).llmModels[id].adminOnly).toBeUndefined();
      });

      it.each(OPENROUTER_IDS)('%s is offered to a non-admin caller', async (id) => {
        const models = await agentModeService.getSupportedModels(false);
        expect(models).toContain(id);
      });

      it('does NOT touch an adminOnly gate that exists for a non-OpenRouter reason', () => {
        expect((agentModeService as any).llmModels['anthropic.claude-opus-4-6-v1'].adminOnly).toBe(true);
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
      // ENG-1786: human-supplied AA v4.2 research, canonical/default variants,
      // snapshot 2026-09-05. These are benchmark variants, not runtime effort settings.
      const AA_V42: [string, number, string][] = [
        ['openrouter/anthropic/claude-fable-5.1', 57, 'Claude Fable 5.1, Adaptive Reasoning, Max Effort'],
        ['openrouter/openai/gpt-6-astra', 55, 'GPT-6 Astra, max'],
        ['anthropic.claude-opus-5', 54, 'Claude Opus 5, Adaptive Reasoning, Max Effort'],
        ['openrouter/openai/gpt-5.6-sol', 51, 'GPT-5.6 Sol, max'],
        ['openrouter/x-ai/grok-4.6', 51, 'Grok 4.6, high'],
        ['openrouter/moonshotai/kimi-k3', 50, 'Kimi K3, max'],
        ['openrouter/openai/gpt-5.6-terra', 47, 'GPT-5.6 Terra, max'],
        ['openrouter/qwen/qwen3.8-max', 47, 'Qwen3.8 Max, reasoning'],
        ['gemini-3.8-flash', 47, 'Gemini 3.8 Flash, high'],
        ['gpt-5.5', 46, 'GPT-5.5, xhigh'],
        ['anthropic.claude-opus-4-8', 46, 'Claude Opus 4.8, Adaptive Reasoning, Max Effort (AA estimate)'],
        ['anthropic.claude-sonnet-5', 45, 'Claude Sonnet 5, Adaptive Reasoning, Max Effort'],
        ['gemini-3.7-flash', 45, 'Gemini 3.7 Flash, high'],
        ['gpt-5.4', 43, 'GPT-5.4, xhigh'],
        ['openrouter/openai/gpt-5.6-luna', 43, 'GPT-5.6 Luna, max'],
        ['openrouter/z-ai/glm-5.2', 43, 'GLM 5.2, max'],
        ['openrouter/deepseek/deepseek-v4-pro', 42, 'DeepSeek V4 Pro 0813, Reasoning, Max Effort'],
        ['openrouter/qwen/qwen3.8-27b', 41, 'Qwen3.8 27B, xhigh'],
        ['openrouter/deepseek/deepseek-v4-flash', 41, 'DeepSeek V4 Flash 0731, Reasoning, Max Effort'],
        ['gemini-3.5-flash', 40, 'Gemini 3.5 Flash, high'],
        ['anthropic.claude-sonnet-4-6', 38, 'Claude Sonnet 4.6, Adaptive Reasoning, Max Effort'],
        ['gemini-3.1-pro-preview', 37, 'Gemini 3.1 Pro Preview, reasoning'],
        ['openrouter/moonshotai/kimi-k2.7-code', 34, 'Kimi K2.7 Code, reasoning'],
        ['gpt-5.4-nano', 31, 'GPT-5.4 Nano, xhigh (AA estimate)'],
        ['anthropic.claude-opus-4-6-v1', 31, 'Claude Opus 4.6, Non-reasoning, High Effort'],
        ['anthropic.claude-sonnet-4-5-20250929-v1:0', 23, 'Claude Sonnet 4.5, Non-reasoning'],
        ['gemini-3-flash-preview', 21, 'Gemini 3 Flash Preview, Non-reasoning (AA estimate)'],
        ['gemini-3.1-flash-lite', 19, 'Gemini 3.1 Flash Lite, reasoning'],
        ['anthropic.claude-haiku-4-5-20251001-v1:0', 17, 'Claude Haiku 4.5, Non-reasoning'],
        ['openrouter/z-ai/glm-4.7-flash', 17, 'GLM 4.7 Flash, reasoning'],
        ['openrouter/mistralai/mistral-small-2603', 13, 'Mistral Small 4, reasoning'],
        ['openrouter/openai/gpt-4o-mini', 1, 'GPT-4o Mini, non-reasoning (AA estimate)'],
      ];
      const SCORED_IDS = AA_V42.map(([id]) => id);

      it.each(AA_V42)('ENG-1786: %s reports its v4.2 score and canonical variant', async (id, score, variant) => {
        const models = await agentModeService.getSupportedModelsWithMetadata(true);
        const info = models.find((model) => model.id === id)!;
        expect(info.qualityScore).toBe(score);
        expect(info.qualityScoreSource).toBe(`Artificial Analysis Intelligence Index v4.2, snapshot 2026-09-05, ${variant}`);
      });

      it('ENG-1786: every scored registry row names an index version and uses the v4.2 snapshot', () => {
        const registry = (agentModeService as any).llmModels;
        const scoredIds = Object.keys(registry).filter((id) => typeof registry[id].qualityScore === 'number');
        expect(scoredIds.sort()).toEqual([...SCORED_IDS].sort());
        for (const id of scoredIds) {
          expect(registry[id].qualityScoreSource).toMatch(/Intelligence Index v\d+\.\d+(?:\.\d+)?\b/);
          expect(registry[id].qualityScoreSource).toMatch(/^Artificial Analysis Intelligence Index v4\.2, snapshot 2026-09-05, .+/);
        }
      });

      it('ENG-1786: Fable (57) > Astra (55) > Sol (51), with Astra directly below Fable', async () => {
        const models = await agentModeService.getSupportedModelsWithMetadata(true);
        const quality = (id: string) => models.find((model) => model.id === id)!.qualityScore!;
        const fable = quality('openrouter/anthropic/claude-fable-5.1');
        const astra = quality('openrouter/openai/gpt-6-astra');
        const sol = quality('openrouter/openai/gpt-5.6-sol');
        expect([fable, astra, sol]).toEqual([57, 55, 51]);
        expect(fable).toBeGreaterThan(astra);
        expect(astra).toBeGreaterThan(sol);
        expect(models.filter((model) => model.qualityScore! > astra).map((model) => model.id))
          .toEqual(['openrouter/anthropic/claude-fable-5.1']);
      });

      it.each<[string | undefined, string[]]>([
        ['gpt5-chat', ['gpt-5.5']],
        ['gpt5-nano', ['gpt-5.4-nano', 'openrouter/openai/gpt-4o-mini']],
        ['gemini-flash', ['gemini-3.5-flash', 'gemini-3.7-flash']],
        ['claude-opus', []],
        ['claude-sonnet', []],
        ['claude-fable', []],
        [undefined, []],
      ])('ENG-1786: %s keeps its baseline dominance-only legacy rows', async (family, expected) => {
        // Baseline includes ENG-1784 bands and ENG-1781 Luna pricing.
        // Static legacy rows remain covered by the existing legacy tests.
        const registry = (agentModeService as any).llmModels;
        const models = await agentModeService.getSupportedModelsWithMetadata(true);
        const dominated = models.filter((model) =>
          registry[model.id].family === family && !registry[model.id].legacy && model.legacy,
        ).map((model) => model.id);
        expect(dominated.sort()).toEqual([...expected].sort());
      });

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
      // assertion. qualityScore is AA Intelligence Index v4.2
      // (snapshot 2026-09-05); costScore is computed from MODEL_PRICING.
      it('pins Claude Opus 5 at the real AA-sourced quality / MODEL_PRICING-derived cost values', async () => {
        const models = await agentModeService.getSupportedModelsWithMetadata(false);
        const info = models.find((m) => m.id === 'anthropic.claude-opus-5')!;
        expect(info.qualityScore).toBe(54);
        expect(info.costScore).toBe(70); // $5/$25 blended 75:25 -> $10.00/1M, log-normalized
        // 70 was the top of the old 64–70 "pro" band; ENG-1784 (2026-09-05)
        // re-cut Flagship to ≥64 precisely so Opus 5 sits with GPT-5.6 Sol.
        expect(info.tier).toBe('ultra_premium');
      });

      it('pins GPT-4o Mini (the cheapest, weakest scored model) at the real values', async () => {
        const models = await agentModeService.getSupportedModelsWithMetadata(false);
        const info = models.find((m) => m.id === 'openrouter/openai/gpt-4o-mini')!;
        expect(info.qualityScore).toBe(1);
        expect(info.costScore).toBe(22);
        expect(info.tier).toBe('ultra_cheap'); // 22 falls in the <=30 "ultra_cheap" cost band
      });

      it('does not lower a legacy model\'s quality score merely for being legacy', () => {
        // Claude Opus 4.8 (legacy: true) scores lower than Opus 5 because it
        // IS a weaker model per AA, not because `legacy` itself penalizes it —
        // Opus 4.6 (also legacy) is correctly lower still, tracking real
        // capability, not recency/legacy-ness.
        const opus5 = (agentModeService as any).llmModels['anthropic.claude-opus-5'];
        const opus48 = (agentModeService as any).llmModels['anthropic.claude-opus-4-8'];
        const opus46 = (agentModeService as any).llmModels['anthropic.claude-opus-4-6-v1'];
        expect(opus48.qualityScore).toBe(46);
        expect(opus46.qualityScore).toBe(31);
        expect(opus5.qualityScore).toBeGreaterThan(opus48.qualityScore);
        expect(opus48.qualityScore).toBeGreaterThan(opus46.qualityScore);
      });
    });

    /*
     * ENG-1784 (2026-09-05) — Harsha re-cut the picker's cost bands: "low
     * should have everything 52 and below (very low is fine as it is now),
     * then medium should be 57-53, then pro should be 63-58, frontier is
     * everything above" — and, from the same conversation, "so Sol and Opus 5
     * can be on the same tier". Live cost scores that day: Fable 5.1 / Astra
     * 79, Sol 71, GPT-5.5 71 (legacy), Opus 5 / Opus 4.8 70, Sonnet 5 63,
     * Terra 62, Kimi K3 61, Grok 4.6 / Qwen3.8 Max 54, Luna 50, Haiku 4.5 49,
     * GPT-5.4 Nano 29. Only models whose prices are not known to be stale are
     * pinned below (Terra/Luna are being re-priced under ENG-1781).
     */
    describe('ENG-1784 — cost bands re-cut: Frontier ≥64, Pro 58–63, Medium 53–57, Cheap 31–52', () => {
      const tierOf = async (id: string) => {
        const models = await agentModeService.getSupportedModelsWithMetadata(true);
        return models.find((m) => m.id === id)!.tier;
      };

      it('puts GPT-5.6 Sol and Claude Opus 5 in the same tier — the Flagship/frontier band (AC2)', async () => {
        const sol = await tierOf('openrouter/openai/gpt-5.6-sol');
        expect(sol).toBe('ultra_premium');
        expect(await tierOf('anthropic.claude-opus-5')).toBe(sol);
      });

      it('keeps GPT-6 Astra and Claude Fable 5.1 in the Flagship band (AC3)', async () => {
        expect(await tierOf('openrouter/openai/gpt-6-astra')).toBe('ultra_premium');
        expect(await tierOf('openrouter/anthropic/claude-fable-5.1')).toBe('ultra_premium');
      });

      it('places the band edges where Harsha drew them: Sonnet 5 (63) pro, Haiku 4.5 (49) cheap, GPT-5.4 Nano (29) very cheap', async () => {
        expect(await tierOf('anthropic.claude-sonnet-5')).toBe('pro');
        expect(await tierOf('anthropic.claude-haiku-4-5-20251001-v1:0')).toBe('cheap');
        expect(await tierOf('gpt-5.4-nano')).toBe('ultra_cheap');
      });

      // Dominance is band-rank based; re-cutting the bands must not rescue
      // GPT-5.5 (Terra is still a cheaper band and at least as good) and must
      // not touch Sol (no family).
      it('leaves dominance outcomes unchanged: GPT-5.5 still legacy, Sol still not (AC4)', async () => {
        const models = await agentModeService.getSupportedModelsWithMetadata(true);
        expect(models.find((m) => m.id === 'gpt-5.5')!.legacy).toBe(true);
        expect(models.find((m) => m.id === 'openrouter/openai/gpt-5.6-sol')!.legacy).toBeUndefined();
      });
    });

    /*
     * ENG-1789 (2026-09-06) — Harsha, after ENG-1786 re-snapshotted quality
     * scores to AA v4.2: "fable + astra are flagship, opus + 5.6 sol are pro,
     * sonnet + 5.6 terra are mid, haiku + 5.6 luna are low." A quality-driven
     * grouping, independent of the cost-driven `tier` field above — see
     * `qualityTier` / `tierFromQualityScore` / `QUALITY_SCORE_BANDS`. Live
     * v4.2 scores that day: Fable 5.1 57, Astra 55, Opus 5 54, Sol 51,
     * Terra 47, Sonnet 5 45, Luna 43, Haiku 4.5 17. Ties resolve to the
     * higher band (Harsha, 2026-09-06): e.g. Grok 4.6 also scores 51 and
     * also lands in 'pro', same as Sol.
     */
    describe('ENG-1789 — quality bands: Flagship >=55, Pro >=51, Medium >=45, Cheap >=17', () => {
      const qualityTierOf = async (id: string) => {
        const models = await agentModeService.getSupportedModelsWithMetadata(true);
        return models.find((m) => m.id === id)!.qualityTier;
      };

      it('puts Claude Fable 5.1 and GPT-6 Astra in the Flagship quality tier', async () => {
        expect(await qualityTierOf('openrouter/anthropic/claude-fable-5.1')).toBe('ultra_premium');
        expect(await qualityTierOf('openrouter/openai/gpt-6-astra')).toBe('ultra_premium');
      });

      it('puts Claude Opus 5 and GPT-5.6 Sol in the Pro quality tier', async () => {
        expect(await qualityTierOf('anthropic.claude-opus-5')).toBe('pro');
        expect(await qualityTierOf('openrouter/openai/gpt-5.6-sol')).toBe('pro');
      });

      it('puts Claude Sonnet 5 and GPT-5.6 Terra in the Medium quality tier', async () => {
        expect(await qualityTierOf('anthropic.claude-sonnet-5')).toBe('medium');
        expect(await qualityTierOf('openrouter/openai/gpt-5.6-terra')).toBe('medium');
      });

      it('puts Claude Haiku 4.5 and GPT-5.6 Luna in the Cheap quality tier', async () => {
        expect(await qualityTierOf('anthropic.claude-haiku-4-5-20251001-v1:0')).toBe('cheap');
        expect(await qualityTierOf('openrouter/openai/gpt-5.6-luna')).toBe('cheap');
      });

      // The quality axis is independent of the cost axis: Opus 5/Sol are
      // Flagship on cost (ENG-1784, tier: ultra_premium) but only Pro on
      // quality (qualityTier: pro) — both fields are real and neither
      // overrides the other.
      it('keeps qualityTier independent of the cost-derived tier for Opus 5 and Sol', async () => {
        const models = await agentModeService.getSupportedModelsWithMetadata(true);
        const opus5 = models.find((m) => m.id === 'anthropic.claude-opus-5')!;
        const sol = models.find((m) => m.id === 'openrouter/openai/gpt-5.6-sol')!;
        expect(opus5.tier).toBe('ultra_premium');
        expect(opus5.qualityTier).toBe('pro');
        expect(sol.tier).toBe('ultra_premium');
        expect(sol.qualityTier).toBe('pro');
      });
    });

    /*
     * ENG-1769 (2026-09-05) — GPT-6 Astra, OpenAI's frontier release of
     * 2026-09-03, routed through OpenRouter and BYOK-served by our own Azure
     * resource (agentweb-openrouter-byok, deployment `gpt-6-astra`; live-
     * confirmed provider=Azure / is_byok=true before these tests were written).
     * Harsha: "is it possible to launch astra on agentweb now? ... go ahead".
     * These assert the acceptance contract on the Linear issue, not the
     * implementation: selectable by everyone, priced at Azure's rate (see
     * llmPricing.test.ts), and NOT entangled with GPT-5.6 Sol's legacy state.
     */
    describe('ENG-1769 — GPT-6 Astra via Azure BYOK', () => {
      const ASTRA = 'openrouter/openai/gpt-6-astra';

      it('is registered with a clean name, the openai provider, and no access gate', () => {
        const config = (agentModeService as any).llmModels[ASTRA];
        expect(config).toBeDefined();
        expect(config.name).toBe('GPT-6 Astra');
        expect(config.provider).toBe('openai');
        expect(config.adminOnly).toBeUndefined();
        expect(config.internalOnly).toBeUndefined();
        expect(config.legacy).toBeUndefined();
      });

      it('is a reasoning model: temperature unsupported, image input supported (live image call via the describe_image base64 data-URL shape, 2026-09-05)', () => {
        const config = (agentModeService as any).llmModels[ASTRA];
        expect(config.supportsTemperature).toBe(false);
        expect(config.supportsVision).toBe(true);
      });

      it('carries a sourced Artificial Analysis quality score', () => {
        const config = (agentModeService as any).llmModels[ASTRA];
        expect(config.qualityScore).toBe(55);
        expect(config.qualityScoreSource).toMatch(/Artificial Analysis/);
      });

      it('is offered to a non-admin caller (AC1)', async () => {
        const models = await agentModeService.getSupportedModels(false);
        expect(models).toContain(ASTRA);
      });

      it('lands in the ultra_premium cost band, above GPT-5.6 Sol, from the $10/$50 Azure rate (AC2)', async () => {
        const models = await agentModeService.getSupportedModelsWithMetadata(true);
        const astra = models.find((m) => m.id === ASTRA)!;
        const sol = models.find((m) => m.id === 'openrouter/openai/gpt-5.6-sol')!;
        expect(astra.tier).toBe('ultra_premium');
        expect(astra.costScore!).toBeGreaterThan(sol.costScore!);
      });

      // Astra is stronger than Sol on v4.2 (55 vs 51), but these distinct
      // product lines must not auto-retire each other.
      // Enforced structurally — Astra carries no `family` (same treatment as
      // Sol itself and Kimi K3), so the dominance rule never compares them.
      it('does not flip GPT-5.6 Sol to legacy, and is not legacy itself (AC3)', async () => {
        const config = (agentModeService as any).llmModels[ASTRA];
        expect(config.family).toBeUndefined();
        const models = await agentModeService.getSupportedModelsWithMetadata(true);
        expect(models.find((m) => m.id === ASTRA)!.legacy).toBeUndefined();
        expect(models.find((m) => m.id === 'openrouter/openai/gpt-5.6-sol')!.legacy).toBeUndefined();
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
      // 2026-09-05 (ENG-1781): re-flipped back. The Azure BYOK price used
      // above ($1.00/$6.00) was itself stale — Azure cut Luna 80% on
      // 2026-07-30 and the pricing table was never updated. At the
      // corrected Azure rate ($0.20/$1.20) Luna's cost score drops to 29,
      // landing back in the same 'ultra_cheap' band as Nano (29) — this is
      // Harsha's original 2026-08-19 intent restored on real numbers: Luna
      // is genuinely real GPT-5.6 reasoning at Nano's price, so Nano is
      // correctly dominated again.
      it('flags GPT-5.4 Nano as legacy — GPT-5.6 Luna is same cost band at the corrected Azure BYOK rate and strictly higher quality', async () => {
        const models = await agentModeService.getSupportedModelsWithMetadata(true);
        const nano = models.find((m) => m.id === 'gpt-5.4-nano')!;
        const luna = models.find((m) => m.id === 'openrouter/openai/gpt-5.6-luna')!;
        expect(nano.tier).toBe(luna.tier);
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

      // Gemini 3.1 Flash Lite is deliberately kept out of the `gemini-flash`
      // family (3.5/3.7 Flash) — it's a distinct "lightest/fastest"
      // positioning, same reasoning as gpt5-chat vs gpt5-nano — so it must
      // never be auto-dominated no matter what lands in the same cost band.
      it('does NOT flag Gemini 3.1 Flash Lite as legacy — no `family` tag, so never auto-dominated', async () => {
        const models = await agentModeService.getSupportedModelsWithMetadata(false);
        const flashLite = models.find((m) => m.id === 'gemini-3.1-flash-lite')!;
        expect(flashLite.legacy).toBeUndefined();
      });

      it('still marks the pre-existing manually-legacy models legacy regardless of dominance', async () => {
        const models = await agentModeService.getSupportedModelsWithMetadata(true);
        for (const id of ['gpt-5.4', 'anthropic.claude-opus-4-6-v1', 'anthropic.claude-opus-4-8']) {
          expect(models.find((m) => m.id === id)!.legacy).toBe(true);
        }
      });

      // Harsha: "the preview gemini models should be moved to legacy asap."
      // Static legacy: true — "preview" status isn't a cost/quality-dominance
      // fact, so this couldn't be (and isn't) derived automatically.
      it('marks both Gemini preview models legacy', async () => {
        const models = await agentModeService.getSupportedModelsWithMetadata(false);
        for (const id of ['gemini-3-flash-preview', 'gemini-3.1-pro-preview']) {
          expect(models.find((m) => m.id === id)!.legacy).toBe(true);
        }
      });

      it('does NOT mark the non-preview, non-dominated Gemini models legacy', async () => {
        const models = await agentModeService.getSupportedModelsWithMetadata(false);
        // gemini-3.5-flash and gemini-3.7-flash are deliberately excluded here
        // — 3.5 is legacy (dominated by 3.7), and 3.7 is now ALSO legacy
        // (same `gemini-flash` family, same 'cheap' tier, but Gemini 3.8
        // Flash beats it on quality: 59 vs 56 — see below).
        for (const id of ['gemini-3.1-flash-lite']) {
          expect(models.find((m) => m.id === id)!.legacy).toBeUndefined();
        }
      });

      // Harsha caught this live: GPT-5.6 Terra showed as legacy and that
      // looked wrong. Root cause — GPT-5.6 Sol ("Frontier coding and
      // agentic work") was wrongly placed in the same `family` as Terra
      // ("Balanced general-purpose model"). Sol's OpenRouter price is
      // currently on a promotional discount that happens to land it in the
      // same cost band as Terra, so dominance concluded Terra was
      // redundant — an artifact of a volatile promo price coinciding with
      // a genuinely different product positioning, not a real supersession.
      // Fix: Sol carries no `family` at all (same treatment as Kimi K3,
      // which is likewise excluded from a family with its coding-specialized
      // sibling Kimi K2.7-Code) — it can neither dominate nor be dominated.
      it('does NOT flag GPT-5.6 Terra as legacy because of GPT-5.6 Sol — different positioning, not a generation', async () => {
        const models = await agentModeService.getSupportedModelsWithMetadata(true);
        const terra = models.find((m) => m.id === 'openrouter/openai/gpt-5.6-terra')!;
        expect(terra.legacy).toBeUndefined();
      });

      it('GPT-5.6 Sol itself is never auto-flagged legacy (carries no family)', async () => {
        const models = await agentModeService.getSupportedModelsWithMetadata(true);
        const sol = models.find((m) => m.id === 'openrouter/openai/gpt-5.6-sol')!;
        expect(sol.legacy).toBeUndefined();
      });

      it('GPT-5.5 is still correctly legacy — GPT-5.6 Terra alone (same "balanced" family) is cheaper AND better', async () => {
        const models = await agentModeService.getSupportedModelsWithMetadata(true);
        const gpt55 = models.find((m) => m.id === 'gpt-5.5')!;
        const terra = models.find((m) => m.id === 'openrouter/openai/gpt-5.6-terra')!;
        expect(terra.qualityScore).toBeGreaterThanOrEqual(gpt55.qualityScore!);
        expect(terra.costScore!).toBeLessThanOrEqual(gpt55.costScore!);
        expect(gpt55.legacy).toBe(true);
      });

      // Harsha: "did you add Gemini 3.7 Flash, and then make legacy what it
      // beats band for band?" — Gemini 3.5 Flash is exactly that case: same
      // `gemini-flash` family, Gemini 3.7 Flash is both cheaper (cost tier
      // 'cheap' vs 3.5's 'medium') and higher quality (56 vs 52).
      it('flags Gemini 3.5 Flash as legacy — Gemini 3.7 Flash beats it band for band', async () => {
        const models = await agentModeService.getSupportedModelsWithMetadata(true);
        const flash35 = models.find((m) => m.id === 'gemini-3.5-flash')!;
        const flash37 = models.find((m) => m.id === 'gemini-3.7-flash')!;
        expect(flash37.qualityScore).toBeGreaterThan(flash35.qualityScore!);
        expect(flash37.tier).not.toBe(flash35.tier);
        expect(flash35.legacy).toBe(true);
      });

      // Gemini 3.8 Flash (added 2026-09-02): same `gemini-flash` family, same
      // 'cheap' tier as 3.7, higher quality (59 vs 56) — dominance flips 3.7
      // from "the dominator" to "the dominated", same class of transition
      // 3.5 Flash went through when 3.7 landed (see above).
      it('flags Gemini 3.7 Flash as legacy — Gemini 3.8 Flash beats it on quality in the same tier', async () => {
        const models = await agentModeService.getSupportedModelsWithMetadata(true);
        const flash37 = models.find((m) => m.id === 'gemini-3.7-flash')!;
        const flash38 = models.find((m) => m.id === 'gemini-3.8-flash')!;
        expect(flash38.qualityScore).toBeGreaterThan(flash37.qualityScore!);
        expect(flash38.tier).toBe(flash37.tier);
        expect(flash37.legacy).toBe(true);
      });

      it('Gemini 3.8 Flash itself is never auto-flagged legacy — it is the dominator, not the dominated', async () => {
        const models = await agentModeService.getSupportedModelsWithMetadata(true);
        const flash38 = models.find((m) => m.id === 'gemini-3.8-flash')!;
        expect(flash38.legacy).toBeUndefined();
      });

      // Gemini 3.1 Flash Lite is a distinct "lightest/fastest" positioning
      // (same reasoning as gpt5-chat vs gpt5-nano), so it deliberately does
      // NOT share a family with Flash/Flash Lite — it must not get swept into
      // legacy just because it happens to share Gemini 3.7 Flash's cost band.
      it('does NOT flag Gemini 3.1 Flash Lite as legacy from Gemini 3.7 Flash — different positioning, no shared family', async () => {
        const models = await agentModeService.getSupportedModelsWithMetadata(true);
        const flashLite = models.find((m) => m.id === 'gemini-3.1-flash-lite')!;
        expect(flashLite.legacy).toBeUndefined();
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

    it('does not advertise unsupported temperature for gpt-5.4 through OpenRouter', () => {
      const llmModels = (agentModeService as any).llmModels;
      expect(llmModels['gpt-5.4'].supportsTemperature).toBe(false);
    });

    it('does not construct an Azure client for gpt-5.4 at startup', () => {
      const llmModels = (agentModeService as any).llmModels;
      expect(llmModels['gpt-5.4'].client).toBeNull();
    });

    it('should include gpt-5.4-nano in the supported models', async () => {
      const models = await agentModeService.getSupportedModels();
      expect(models).toContain('gpt-5.4-nano');
    });

    it('does not advertise unsupported temperature for gpt-5.4-nano through OpenRouter', () => {
      const llmModels = (agentModeService as any).llmModels;
      expect(llmModels['gpt-5.4-nano'].supportsTemperature).toBe(false);
    });

    it('does not construct an Azure client for gpt-5.4-nano at startup', () => {
      const llmModels = (agentModeService as any).llmModels;
      expect(llmModels['gpt-5.4-nano'].client).toBeNull();
    });

    it('should include gpt-5.5 in the supported models', async () => {
      const models = await agentModeService.getSupportedModels();
      expect(models).toContain('gpt-5.5');
    });

    it('should have temperature support disabled for gpt-5.5', () => {
      const llmModels = (agentModeService as any).llmModels;
      expect(llmModels['gpt-5.5'].supportsTemperature).toBe(false);
    });

    it('does not construct an Azure client for gpt-5.5 at startup', () => {
      const llmModels = (agentModeService as any).llmModels;
      expect(llmModels['gpt-5.5'].client).toBeNull();
    });

    it('should have maxTools: 128 for all Azure OpenAI gpt-5.x models', () => {
      const llmModels = (agentModeService as any).llmModels;
      expect(llmModels['gpt-5.4'].maxTools).toBe(128);
      expect(llmModels['gpt-5.4-nano'].maxTools).toBe(128);
      expect(llmModels['gpt-5.5'].maxTools).toBe(128);
    });

    it('should enforce Google\'s 128-function limit on Gemini but not Bedrock models', () => {
      const llmModels = (agentModeService as any).llmModels;
      expect(llmModels['gemini-3.1-pro-preview'].maxTools).toBe(128);
      expect(llmModels['gemini-3.1-flash-lite'].maxTools).toBe(128);
      expect(llmModels['gemini-3.5-flash'].maxTools).toBe(128);
      expect(llmModels['gemini-3.7-flash'].maxTools).toBe(128);
      expect(llmModels['gemini-3-flash-preview'].maxTools).toBe(128);
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

    it('should set maxTools on Gemini 3.5 Flash', () => {
      const llmModels = (agentModeService as any).llmModels;
      expect(llmModels['gemini-3.5-flash'].maxTools).toBe(128);
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
      const allModels = Object.keys(llmModels).filter((m: string) =>
        !llmModels[m].adminOnly && !llmModels[m].internalOnly);
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
      const llmModels = (agentModeService as any).llmModels;
      const allModels = Object.keys(llmModels).filter((m: string) => !llmModels[m].internalOnly);
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
      const naturalOrder = Object.keys(llmModels).filter((m: string) =>
        !llmModels[m].adminOnly && !llmModels[m].internalOnly);
      // Falls back to env/hardcoded default which is likely first anyway
      expect(models.length).toBe(naturalOrder.length);
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

  describe('callLLM maxTools truncation (provider 128-tool limits)', () => {
    it('should truncate tools to maxTools limit for gpt-5.4', async () => {
      const mockCreate = jest.fn().mockResolvedValue({
        choices: [{ message: { content: 'response', tool_calls: null } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      });
      jest.spyOn(agentModeService as any, 'getOpenRouterClient').mockResolvedValue({
        chat: { completions: { create: mockCreate } },
      });

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
      jest.spyOn(agentModeService as any, 'getOpenRouterClient').mockResolvedValue({
        chat: { completions: { create: mockCreate } },
      });

      const tools = Array.from({ length: 128 }, (_, i) => ({
        type: 'function',
        function: { name: `tool_${i}`, description: `Tool ${i}`, parameters: { type: 'object', properties: {} } }
      }));

      await (agentModeService as any).callLLM('gpt-5.4', [{ role: 'user', content: 'test' }], { tools });

      const calledParams = mockCreate.mock.calls[0][0];
      expect(calledParams.tools).toHaveLength(128);
    });

    it('should truncate Gemini tools to Google\'s 128-function limit', async () => {
      const mockCreate = jest.fn().mockResolvedValue({
        choices: [{ message: { content: 'response', tool_calls: null } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      });
      jest.spyOn(agentModeService as any, 'getOpenRouterClient').mockResolvedValue({
        chat: { completions: { create: mockCreate } },
      });
      const tools = Array.from({ length: 207 }, (_, i) => ({
        type: 'function',
        function: { name: `tool_${i}`, description: `Tool ${i}`, parameters: { type: 'object', properties: {} } }
      }));

      await (agentModeService as any).callLLM(
        'gemini-3.1-flash-lite',
        [{ role: 'user', content: 'test' }],
        { tools },
      );

      expect(mockCreate.mock.calls[0][0].tools).toHaveLength(128);
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
