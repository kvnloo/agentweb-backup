/**
 * ENG-683 — Bedrock inference-profile map: single source of truth.
 *
 * These assertions pin the BEHAVIOR that was previously spread across four
 * hand-synced copies (agentModeService, codingAgentService, llmService,
 * rcaEnricher) — one of which had already drifted. Every ARN below is the
 * byte-identical string those copies resolved to on main @ 211045f2e, so a
 * failure here means the consolidation changed what model a caller reaches.
 */

import {
  BEDROCK_INFERENCE_PROFILE_MAP,
  BEDROCK_BEARER_TOKEN_MODELS,
  resolveBedrockModelId,
} from '../../utils/bedrockInferenceProfiles';

/**
 * Frozen snapshot of the mapping as it existed in agentModeService.ts:1580-1586
 * on main @ 211045f2e — the canonical copy, transcribed by hand from that file.
 * AC #2 ("no behavior change for currently-mapped models") is exactly this table.
 */
const PRE_CONSOLIDATION_AGENT_MODE_MAP: Record<string, string> = {
  'anthropic.claude-sonnet-4-5-20250929-v1:0':
    'arn:aws:bedrock:us-west-2:992382574572:inference-profile/global.anthropic.claude-sonnet-4-5-20250929-v1:0',
  'anthropic.claude-sonnet-4-6':
    'arn:aws:bedrock:us-west-2:992382574572:inference-profile/global.anthropic.claude-sonnet-4-6',
  'anthropic.claude-opus-4-6-v1':
    'arn:aws:bedrock:us-west-2:992382574572:inference-profile/global.anthropic.claude-opus-4-6-v1',
  'anthropic.claude-opus-4-8': 'us.anthropic.claude-opus-4-8',
};

describe('bedrockInferenceProfiles', () => {
  describe('AC #2 — no behavior change for currently-mapped models', () => {
    it.each(Object.entries(PRE_CONSOLIDATION_AGENT_MODE_MAP))(
      'resolves %s to the byte-identical ARN it resolved to before consolidation',
      (modelId, expectedArn) => {
        expect(resolveBedrockModelId(modelId)).toBe(expectedArn);
      }
    );

    it('preserves every pre-consolidation entry byte-for-byte — no losses, no rewrites', () => {
      for (const [modelId, expectedArn] of Object.entries(PRE_CONSOLIDATION_AGENT_MODE_MAP)) {
        expect(BEDROCK_INFERENCE_PROFILE_MAP[modelId]).toBe(expectedArn);
      }
    });

    /*
     * The original ENG-683 assertion was `toEqual(PRE_CONSOLIDATION_...)` — "no
     * additions, no losses" — which proved the consolidation invented nothing.
     * Adding a model is now the intended way to grow the map, so the additions
     * half is re-expressed as an exact key-set pin: a new entry still has to be
     * declared here deliberately, and an accidental one still fails the build.
     */
    it('exposes exactly the expected model set — a new entry must be added deliberately', () => {
      expect(Object.keys(BEDROCK_INFERENCE_PROFILE_MAP).sort()).toEqual(
        [
          'anthropic.claude-sonnet-4-5-20250929-v1:0',
          'anthropic.claude-sonnet-4-6',
          'anthropic.claude-opus-4-6-v1',
          'anthropic.claude-opus-4-8',
          // ENG-744 — the Claude 5 generation
          'anthropic.claude-opus-5',
          'anthropic.claude-sonnet-5',
          'anthropic.claude-haiku-4-5-20251001-v1:0',
        ].sort()
      );
    });
  });

  /*
   * ENG-744 — Claude 5 generation.
   *
   * Enablement was verified against live Bedrock in us-west-2 before these were
   * added (see the PR body). The account split is the load-bearing detail:
   *   - Opus 5 / Sonnet 5 are AccessDenied on the default account (992382574572)
   *     and only invocable through the bearer-token account (231030591963), so
   *     they take a bare profile id AND must be in BEDROCK_BEARER_TOKEN_MODELS.
   *   - Haiku 4.5 IS served on the default account, so it takes a normal
   *     cross-region ARN and must NOT be routed through bearer auth.
   * Getting either half wrong is a 403 at runtime, not a test failure, which is
   * exactly why both halves are pinned here.
   */
  describe('ENG-744 — Claude 5 generation', () => {
    it.each([
      ['anthropic.claude-opus-5', 'us.anthropic.claude-opus-5'],
      ['anthropic.claude-sonnet-5', 'us.anthropic.claude-sonnet-5'],
    ])('routes %s to the bearer-account profile id %s', (modelId, expected) => {
      expect(resolveBedrockModelId(modelId)).toBe(expected);
    });

    it.each(['anthropic.claude-opus-5', 'anthropic.claude-sonnet-5'])(
      'marks %s as bearer-token served (default-account creds get AccessDenied)',
      (modelId) => {
        expect(BEDROCK_BEARER_TOKEN_MODELS.has(modelId)).toBe(true);
      }
    );

    it('routes haiku-4-5 to a default-account cross-region ARN', () => {
      expect(resolveBedrockModelId('anthropic.claude-haiku-4-5-20251001-v1:0')).toBe(
        'arn:aws:bedrock:us-west-2:992382574572:inference-profile/global.anthropic.claude-haiku-4-5-20251001-v1:0'
      );
    });

    it('does NOT route haiku-4-5 through bearer auth — it lives on the default account', () => {
      expect(BEDROCK_BEARER_TOKEN_MODELS.has('anthropic.claude-haiku-4-5-20251001-v1:0')).toBe(
        false
      );
    });
  });

  describe('AC #3 — opus-4-8 is present (the entry llmService had drifted away from)', () => {
    it('maps anthropic.claude-opus-4-8 to us.anthropic.claude-opus-4-8', () => {
      expect(resolveBedrockModelId('anthropic.claude-opus-4-8')).toBe(
        'us.anthropic.claude-opus-4-8'
      );
    });
  });

  describe('AC #5 — unknown model ids pass through unchanged', () => {
    it.each([
      'gpt-5.2-chat',
      'claude-sonnet-4-6', // bare id — a Vertex model, must NOT be rewritten
      'nonexistent-model',
      '',
    ])('passes %p through untouched', (modelId) => {
      expect(resolveBedrockModelId(modelId)).toBe(modelId);
    });

    it('does not resolve inherited Object.prototype keys', () => {
      // A plain-object map would happily return Object.prototype.toString here.
      expect(resolveBedrockModelId('toString')).toBe('toString');
      expect(resolveBedrockModelId('constructor')).toBe('constructor');
    });
  });

  describe('idempotency — the invariant that makes double-resolution safe', () => {
    /*
     * The resolver is called at more than one layer (service entry points and,
     * for the bearer path, again when building the invoke URL). Calling it twice
     * must be a no-op, which holds only while no map VALUE is also a map KEY.
     */
    it.each([
      ...Object.keys(PRE_CONSOLIDATION_AGENT_MODE_MAP),
      ...Object.values(PRE_CONSOLIDATION_AGENT_MODE_MAP),
      'gpt-5.2-chat',
    ])('resolve(resolve(%s)) === resolve(%s)', (modelId) => {
      const once = resolveBedrockModelId(modelId);
      expect(resolveBedrockModelId(once)).toBe(once);
    });

    it('no mapped value is itself a mapped key', () => {
      const keys = new Set(Object.keys(BEDROCK_INFERENCE_PROFILE_MAP));
      const collisions = Object.values(BEDROCK_INFERENCE_PROFILE_MAP).filter((v) => keys.has(v));
      expect(collisions).toEqual([]);
    });
  });

  describe('bearer-token account membership', () => {
    it('lists opus-4-8 as the model served from the separate AWS account', () => {
      expect(BEDROCK_BEARER_TOKEN_MODELS.has('anthropic.claude-opus-4-8')).toBe(true);
    });

    it('does not route default-account models through bearer auth', () => {
      for (const modelId of ['anthropic.claude-sonnet-4-6', 'anthropic.claude-opus-4-6-v1']) {
        expect(BEDROCK_BEARER_TOKEN_MODELS.has(modelId)).toBe(false);
      }
    });

    it('every bearer-token model has a profile mapping (or it would 404 the invoke URL)', () => {
      for (const modelId of BEDROCK_BEARER_TOKEN_MODELS) {
        expect(resolveBedrockModelId(modelId)).not.toBe(modelId);
      }
    });
  });

  describe('immutability — a consumer cannot mutate the shared map', () => {
    it('is frozen', () => {
      expect(Object.isFrozen(BEDROCK_INFERENCE_PROFILE_MAP)).toBe(true);
    });
  });
});
