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

    it('exposes exactly the pre-consolidation entries — no additions, no losses', () => {
      expect({ ...BEDROCK_INFERENCE_PROFILE_MAP }).toEqual(PRE_CONSOLIDATION_AGENT_MODE_MAP);
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
