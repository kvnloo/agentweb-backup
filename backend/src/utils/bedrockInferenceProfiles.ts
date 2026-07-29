/**
 * Bedrock model-id -> inference-profile mapping. SINGLE SOURCE OF TRUTH.
 *
 * Newer Claude models on Bedrock cannot be invoked by bare model id — they must
 * be addressed through a cross-region inference profile. This mapping used to
 * be duplicated across four files (agentModeService, codingAgentService,
 * llmService, and rcaEnricher's hardcoded constant), hand-synced via a
 * checklist in CLAUDE.md. It drifted: two copies were missing
 * `anthropic.claude-opus-4-8`, so anything routed through them sent a bare
 * model id to Bedrock.
 *
 * Adding a new Claude model is now a one-line change HERE and nowhere else.
 * `src/__tests__/sdkConstructionGuard.test.ts` fails the build if a second copy
 * of these literals reappears in the source tree.
 */

/**
 * App model id -> the id Bedrock actually needs.
 *
 * Values are either a full cross-region inference-profile ARN (default account
 * 992382574572) or a bare profile id for the separate bearer-token account.
 * ARN format: `arn:aws:bedrock:us-west-2:992382574572:inference-profile/{profile_id}`
 */
export const BEDROCK_INFERENCE_PROFILE_MAP: Readonly<Record<string, string>> = Object.freeze({
  'anthropic.claude-sonnet-4-5-20250929-v1:0':
    'arn:aws:bedrock:us-west-2:992382574572:inference-profile/global.anthropic.claude-sonnet-4-5-20250929-v1:0',
  'anthropic.claude-sonnet-4-6':
    'arn:aws:bedrock:us-west-2:992382574572:inference-profile/global.anthropic.claude-sonnet-4-6',
  'anthropic.claude-opus-4-6-v1':
    'arn:aws:bedrock:us-west-2:992382574572:inference-profile/global.anthropic.claude-opus-4-6-v1',
  // Opus 4.8 is served from a different AWS account (231030591963), reached via
  // the invoke endpoint with a bearer token — hence a bare profile id, not an
  // ARN in our account. See BEDROCK_BEARER_TOKEN_MODELS below.
  'anthropic.claude-opus-4-8': 'us.anthropic.claude-opus-4-8',
  // ENG-744 — Claude 5 generation. Enablement verified against live Bedrock in
  // us-west-2 before adding (a listed ACTIVE profile is NOT proof of access).
  // Opus 5 and Sonnet 5 are AccessDenied on the default account and reachable
  // only from the bearer-token account, same as Opus 4.8 — bare profile id.
  'anthropic.claude-opus-5': 'us.anthropic.claude-opus-5',
  'anthropic.claude-sonnet-5': 'us.anthropic.claude-sonnet-5',
  // Haiku 4.5 IS served on the default account, so it takes a normal
  // cross-region ARN and must stay OUT of BEDROCK_BEARER_TOKEN_MODELS.
  'anthropic.claude-haiku-4-5-20251001-v1:0':
    'arn:aws:bedrock:us-west-2:992382574572:inference-profile/global.anthropic.claude-haiku-4-5-20251001-v1:0',
});

/**
 * Models served from the separate AWS account (231030591963) that the app's
 * default IAM credentials (992382574572) cannot reach. These authenticate with
 * a long-term Bedrock API key (bearer token) instead of SigV4.
 *
 * CAUTION: a caller that only pins SigV4 — e.g. `utils/llmService.ts` — has no
 * bearer path and will get a cross-account 403 for these models. Resolving the
 * profile id is necessary but NOT sufficient to reach them.
 */
export const BEDROCK_BEARER_TOKEN_MODELS: ReadonlySet<string> = new Set([
  'anthropic.claude-opus-4-8',
  // ENG-744: verified 2026-07-29 — the default account returns
  // "anthropic.claude-opus-5 is not available for this account" for both of
  // these, while the bearer account returns 200. Haiku 4.5 is deliberately
  // absent: it works on the default account and does not need bearer auth.
  'anthropic.claude-opus-5',
  'anthropic.claude-sonnet-5',
]);

/**
 * Resolve an app model id to the id Bedrock expects.
 *
 * Unmapped ids (Vertex `claude-*` ids, Azure deployments, already-resolved
 * ARNs) pass through unchanged. That also makes this idempotent — no mapped
 * value is itself a mapped key, so `resolve(resolve(x)) === resolve(x)` — which
 * is what keeps it safe to call at more than one layer of a call path.
 */
export function resolveBedrockModelId(modelId: string): string {
  // hasOwnProperty guard: a bare lookup would return Object.prototype members
  // for ids like "toString" or "constructor".
  return Object.prototype.hasOwnProperty.call(BEDROCK_INFERENCE_PROFILE_MAP, modelId)
    ? BEDROCK_INFERENCE_PROFILE_MAP[modelId]
    : modelId;
}
