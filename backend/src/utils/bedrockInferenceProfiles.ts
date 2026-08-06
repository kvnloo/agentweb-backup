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

/** Prompt-cache time-to-live accepted by the Converse API's `cachePoint` block. */
export type BedrockCacheTtl = '5m' | '1h';

/**
 * Bedrock models whose model card lists "5 minutes, 1 hour" under Supported TTL
 * — i.e. the ones that accept `cachePoint: { type: 'default', ttl: '1h' }`.
 *
 * ENG-893: agent-mode sessions are human-paced. Every user pause longer than the
 * default 5-minute TTL expired the cache and re-wrote the entire 100k+ token
 * prefix at 1.25x the input rate; in the session that surfaced this, 31 of 103
 * turns paid an 80k-185k full re-cache and cache writes were 77% of the bill.
 * The 1-hour TTL converts those misses into 0.1x cache reads.
 *
 * This is an ALLOWLIST on purpose, but NOT because Bedrock rejects an
 * unsupported `ttl` — it does not. Probed live in us-west-2 on 2026-08-04:
 * Sonnet 4.6 and Opus 4.6, which the AWS prompt-caching table lists as
 * "5 minutes" only, both ACCEPT `ttl: '1h'` and echo
 * `cacheDetails: [{ ttl: '1h', ... }]`. So a wrong entry here fails SILENTLY
 * (billed at the 2x write rate below while possibly only getting 5m of cache),
 * not loudly. Unlisted models send the bare `{ type: 'default' }` block.
 *
 * Sonnet 4.6 is omitted despite accepting the field only because AWS documents
 * it as 5m-only; a same-session probe showed its 1h cache surviving an 8m45s
 * idle gap, so adding it (with the matching 2x price) is a live follow-up
 * worth taking — see ENG-893 for the measurement.
 *
 * Cache writes at the 1-hour TTL are billed at 2x the input rate rather than
 * 1.25x, so every id here MUST be priced accordingly in `llmPricing.ts`. The
 * drift guard lives in `__tests__/agentModeService.promptCacheTtl.test.ts`.
 */
export const BEDROCK_EXTENDED_CACHE_TTL_MODELS: ReadonlySet<string> = new Set([
  'anthropic.claude-opus-5',
  'anthropic.claude-sonnet-5',
  'anthropic.claude-opus-4-8',
  'anthropic.claude-sonnet-4-5-20250929-v1:0',
  'anthropic.claude-haiku-4-5-20251001-v1:0',
  // AWS's prompt-caching table lists the 4.6 models as 5-minute-only, but that
  // is stale. Measured in us-west-2 with a write/read pair either side of an
  // idle gap: Sonnet 4.6 read back 88,624 tokens after 8m45s (2026-08-04) and
  // again after 11m43s (2026-08-05); Opus 4.6 read back 85,424 after 11m43s.
  // In every run the default-TTL control expired and re-cached in full, so the
  // 1h request is what kept the cache alive. Kept honest by cacheWriteCost,
  // which bills whatever TTL comes back — so if AWS ever does enforce 5m here,
  // we pay 1.25x, not 2x.
  'anthropic.claude-sonnet-4-6',
  'anthropic.claude-opus-4-6-v1',
]);

/**
 * The `ttl` to put on a Converse `cachePoint` for this model, or `undefined`
 * when the field must be omitted (5-minute-only or non-Bedrock models).
 */
export function bedrockCacheTtl(modelId: string): BedrockCacheTtl | undefined {
  return BEDROCK_EXTENDED_CACHE_TTL_MODELS.has(modelId) ? '1h' : undefined;
}

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
