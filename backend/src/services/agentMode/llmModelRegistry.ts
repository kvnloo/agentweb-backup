/**
 * ENG-1831: the LLM model registry — capability metadata for every model
 * callLLM can serve — moved out of agentModeService.ts so it can be read,
 * tested and guarded (see openRouterRequestParams.registryGuard.test.ts)
 * without importing the service, which drags in most of the backend.
 *
 * Adding a model: add one entry here, a price in utils/llmPricing.ts, then run
 * `npm run refresh:openrouter-params` so the OpenRouter guard covers it.
 */
import type OpenAI from 'openai';
import type { GatewayReasoningConfig } from '../../utils/openRouterGatewayContract';

/** Usage/cost tiers surfaced in the model picker, ordered most- to least-expensive. */
export type ModelTier = 'ultra_premium' | 'pro' | 'medium' | 'cheap' | 'ultra_cheap';

/** Underlying lab a model is from, for picking the right provider icon in the picker. */
export type ModelProvider =
  | 'anthropic' | 'openai' | 'google' | 'xai' | 'deepseek' | 'qwen' | 'mistral' | 'moonshot' | 'zai' | 'other';

// Type for LLM model configuration
export interface LLMModelConfig extends GatewayReasoningConfig {
  client: OpenAI | null; // null for lazy-loaded clients (e.g., Gemini)
  supportsTemperature: boolean;
  /**
   * False when the model's OpenRouter entry omits `tool_choice` from
   * `supported_parameters`. Optional and defaulting to TRUE: every other model in
   * this registry accepts it, so only the exceptions carry the flag.
   *
   * This is the same class of defect as `supportsTemperature`, one parameter
   * over, and it fails LOUDER: an unsupported `tool_choice` makes OpenRouter's
   * provider router find no endpoint at all and return
   * `404 No endpoints found that can handle the requested parameters`, so every
   * agent-mode turn on that model 500s. Mirror the model page rather than
   * assuming parity with a sibling — Claude Fable 5.1 omits `tool_choice` while
   * Claude Fable 5 and both `:batch` variants support it.
   */
  supportsToolChoice?: boolean;
  /**
   * False when no OpenRouter endpoint for the model lists `tools` (ENG-1831:
   * the Perplexity Sonar research models). Defaults to TRUE. callLLM refuses a
   * request carrying tools for such a model rather than letting OpenRouter 404.
   */
  supportsTools?: boolean;
  /** True for Gemini Live models — uses persistent WebSocket, not HTTP generate */
  isLive?: boolean;
  /**
   * True if the model can be used as the describe_image vision model — i.e. it is
   * multimodal AND reachable/provisioned in this deployment. Verified empirically
   * (see getVisionModelOptions). Models that are text/voice-only, return 404 from
   * their provider, or aren't provisioned on the account are intentionally omitted.
   */
  supportsVision?: boolean;
  /** Maximum number of tools this model/deployment accepts (e.g. Azure OpenAI gpt-5.x limits to 128) */
  maxTools?: number;
  /** True to restrict model to admin users only */
  adminOnly?: boolean;
  /** Internal workload model: callable by services but never selectable in the customer picker. */
  internalOnly?: boolean;
  /**
   * Usage/cost tier for the model picker UI. Only used as a fallback when
   * getModelPrice() has no entry for this model — otherwise the picker's
   * tier grouping is derived live from the computed cost score (see
   * TIER_COST_SCORE_BANDS). Unset defaults to 'medium'.
   */
  tier?: ModelTier;
  /** Short, user-facing one-line description shown next to the model name in the picker. */
  description?: string;
  /** Clean, user-facing display name for the picker — e.g. "Grok 4.6", not the raw id. */
  name?: string;
  /** Underlying lab, for picking the right provider icon in the picker. Unset defaults to 'other'. */
  provider?: ModelProvider;
  /**
   * True for a superseded version of a model family still kept selectable for
   * session/schedule continuity (see LEGACY_MODEL_ALIASES and resolveGenerationModel —
   * this flag only affects picker visibility grouping, never generation). The picker
   * UI tucks these behind a "Show more" row instead of hiding them from new selection
   * entirely (that's what adminOnly is for).
   *
   * Hand-set here for models superseded for reasons other than pure
   * dominance (e.g. a straight version retirement). getSupportedModelsWithMetadata
   * ALSO computes legacy live for any model that a same-`family` model
   * strictly dominates (see deriveDominanceLegacyIds) — this field and that
   * computation combine with OR, never override each other.
   */
  legacy?: boolean;
  /**
   * Groups models that are genuinely the same product line across
   * generations (e.g. every "GPT-5.x balanced chat" deployment, or every
   * Claude Opus release) for automatic same-family dominance detection.
   * Deliberately narrow and hand-assigned — NOT "same provider": Claude
   * Opus and Claude Sonnet, or Gemini Pro and Gemini Flash, are different
   * product tiers serving different jobs, not generations of the same
   * model, so they must never share a family or a stronger sibling tier
   * would wrongly hide a still-useful different-tier model. Omitted families
   * are inferred conservatively from the model product line.
   */
  family?: string;
  /**
   * Benchmark-derived quality score, 0-100, higher = stronger. Omitted
   * entirely when there is insufficient benchmark evidence for this model —
   * never estimated or invented. Does NOT get lowered merely because a
   * model is `legacy`; legacy affects picker visibility grouping only, not
   * how good the model actually is.
   */
  qualityScore?: number;
  /** Methodology/source note for qualityScore — benchmark name, source
   *  version, and evaluation date (e.g. "Artificial Analysis Intelligence
   *  Index v4.3.2, snapshot 2026-09-22, max"). Surfaced in the picker's quality tooltip. */
  qualityScoreSource?: string;
  // No costScore/costScoreSource field here (unlike qualityScore) — cost is
  // fully derivable from MODEL_PRICING (see getSupportedModelsWithMetadata),
  // so it is computed live rather than duplicated as a second hand-typed
  // number that can drift from what we actually bill.
}

export const LLM_MODEL_REGISTRY: Readonly<Record<string, Readonly<LLMModelConfig>>> = {
  "openrouter/anthropic/claude-haiku-5.5": {"client":null,"name":"Claude Haiku 5.5","description":"Auto-added from OpenRouter; benchmark score shown when available.","adminOnly":true,"provider":"anthropic","family":"claude-haiku","supportsTemperature":false,"supportsTools":true,"supportsToolChoice":true,"qualityScore":43.4,"qualityScoreSource":"Artificial Analysis Intelligence Index, API v2, snapshot 2026-10-08, claude-haiku-5-5 (https://artificialanalysis.ai/)"},

  // Model-upgrade audit 2026-11-15: description + supportedReasoningEfforts from the OpenRouter record
  // (reasoning.supported_efforts, mandatory, default high). Still adminOnly (customer exposure is an ENG-1606
  // roster decision) and no supportsVision until a live describe_image smoke passes.
  "openrouter/anthropic/claude-sonnet-5.5": {"client":null,"name":"Claude Sonnet 5.5","description":"Anthropic's Sonnet-class model for everyday work","supportedReasoningEfforts":["max","xhigh","high","medium","low"],"adminOnly":true,"provider":"anthropic","family":"claude-sonnet","supportsTemperature":false,"supportsTools":true,"supportsToolChoice":true,"qualityScore":56,"qualityScoreSource":"Artificial Analysis Intelligence Index, API v2, snapshot 2026-10-07, claude-sonnet-5-5 (https://artificialanalysis.ai/)"},
  "openrouter/deepseek/deepseek-v4-pro-0813": {"client":null,"name":"DeepSeek V4 Pro 0813","description":"Auto-added from OpenRouter; benchmark score shown when available.","adminOnly":true,"provider":"deepseek","family":"deepseek-pro","supportsTemperature":true,"supportsTools":true,"supportsToolChoice":true,"qualityScore":36,"qualityScoreSource":"Artificial Analysis Intelligence Index v4.3.2, snapshot 2026-10-07, DeepSeek V4 Pro 0813 (Max), Reasoning (https://artificialanalysis.ai/models/deepseek-v4-pro)"},
  "openrouter/deepseek/deepseek-v4.1-flash": {"client":null,"name":"DeepSeek V4.1 Flash","description":"Auto-added from OpenRouter; benchmark score shown when available.","adminOnly":true,"provider":"deepseek","family":"deepseek-flash","supportsTemperature":true,"supportsTools":true,"supportsToolChoice":true,"qualityScore":39.5,"qualityScoreSource":"Artificial Analysis Intelligence Index, API v2, snapshot 2026-10-07, deepseek-v4-1-flash (https://artificialanalysis.ai/)"},
  "openrouter/google/gemini-3.5-flash-lite": {"client":null,"name":"Gemini 3.5 Flash Lite","description":"Auto-added from OpenRouter; benchmark score shown when available.","adminOnly":true,"provider":"google","family":"gemini-flash-lite","supportsTemperature":true,"supportsTools":true,"supportsToolChoice":true,"maxTools":128,"qualityScore":22.2,"qualityScoreSource":"Artificial Analysis Intelligence Index, API v2, snapshot 2026-10-07, gemini-3-5-flash-lite (https://artificialanalysis.ai/)"},
  "openrouter/openai/gpt-6.1-sol": {"client":null,"name":"GPT-6.1 Sol","description":"Auto-added from OpenRouter; benchmark score shown when available.","adminOnly":true,"provider":"openai","family":"gpt-sol","supportsTemperature":false,"supportsTools":true,"supportsToolChoice":true,"maxTools":128,"qualityScore":51.8,"qualityScoreSource":"Artificial Analysis Intelligence Index, API v2, snapshot 2026-10-07, gpt-6-1-sol (https://artificialanalysis.ai/)"},
  "openrouter/z-ai/glm-5.3": {"client":null,"name":"GLM 5.3","description":"Auto-added from OpenRouter; benchmark score shown when available.","adminOnly":true,"provider":"zai","family":"glm","supportsTemperature":true,"supportsTools":true,"supportsToolChoice":true,"qualityScore":44.8,"qualityScoreSource":"Artificial Analysis Intelligence Index, API v2, snapshot 2026-10-07, glm-5-3 (https://artificialanalysis.ai/)"},
  "openrouter/z-ai/glm-5.3-flash": {"client":null,"name":"GLM 5.3 Flash","description":"Auto-added from OpenRouter; benchmark score shown when available.","adminOnly":true,"provider":"zai","family":"glm-flash","supportsTemperature":true,"supportsTools":true,"supportsToolChoice":true,"qualityScore":41.8,"qualityScoreSource":"Artificial Analysis Intelligence Index, API v2, snapshot 2026-10-07, glm-5-3-flash (https://artificialanalysis.ai/)"},

  // 2026-09-22: every quality score re-snapshotted to AA Intelligence Index
  // v4.3.2 (read live off each model's artificialanalysis.ai page), replacing
  // the ENG-1786 v4.2 / 2026-09-05 snapshot. v4.3.2 scores run ~5-8 points
  // lower across the board, so QUALITY_SCORE_BANDS was re-cut to match. Sources name the canonical
  // AA page variant; benchmark effort need not match the provider runtime default.
  // Logical model metadata only. `callLLM` resolves every text/tool request
  // through OpenRouter; no provider client is constructed from this registry.
  // supportsVision flags below were verified empirically against the describe_image
  // path (probe against a real image). All GPT-5 deployments handle vision.
  // gpt-5-chat-2 and gpt-5.2-chat REMOVED 2026-08-19 as part of migrating off
  // the Rui-owned Azure resource (ai-ruiwangwarm...) onto agentweb-openrouter-byok:
  // gpt-5-chat-2 is no longer in Azure's deployable model catalog at all;
  // gpt-5.2-chat's Azure inference cutoff was 2026-06-29 (fully deprecated,
  // no working deployment possible on any resource). Both were already
  // legacy:true and the two lowest-quality entries in the gpt5-chat family.
  // Safe to remove ONLY because LEGACY_MODEL_ALIASES now redirects both ids
  // to gpt-5.5 (see below) — a paused schedule/session still holding the old
  // id resolves forward instead of throwing "Invalid model". Do not delete a
  // registry entry without an alias first; that was exactly the caution the
  // prior version of this comment existed to enforce.
  'gpt-5.4': { name: 'GPT-5.4', family: 'gpt5-chat', provider: 'openai', tier: 'medium', description: 'Balanced general-purpose model', client: null, supportsTemperature: false, maxTools: 128, supportsVision: true, legacy: true , qualityScore: 39, qualityScoreSource: 'Artificial Analysis Intelligence Index v4.3.2, snapshot 2026-09-22, GPT-5.4, xhigh' },
  'gpt-5.4-nano': {"name":"GPT-5.4 Nano","family":"gpt5-nano","provider":"openai","tier":"ultra_cheap","description":"Lightweight, high-throughput model","client":null,"supportsTemperature":false,"maxTools":128,"supportsVision":true,"qualityScore":20.7,"qualityScoreSource":"Artificial Analysis Intelligence Index, API v2, snapshot 2026-10-07, gpt-5-4-nano (https://artificialanalysis.ai/)"},
  'gpt-5.5': {"name":"GPT-5.5","family":"gpt5-chat","provider":"openai","tier":"medium","description":"Balanced general-purpose model","client":null,"supportsTemperature":false,"maxTools":128,"supportsVision":true,"qualityScore":38.4,"qualityScoreSource":"Artificial Analysis Intelligence Index, API v2, snapshot 2026-10-07, gpt-5-5 (https://artificialanalysis.ai/)"},
  // List gemini models - client will be lazy-loaded
  // gemini-3-pro-preview REMOVED (ENG-744): Google shut it down 2026-03-09 and it
  // returns a hard 404 on a real call, but it stayed selectable here for ~4.5 months,
  // so picking it was a guaranteed failure. llmPricing.ts already carried the
  // DEPRECATED 2026-03-09 note; only the registry had not caught up. Migrate to
  // gemini-3.1-pro-preview (below), which is the newest Gemini Pro that exists.
  // Its price entry is intentionally left in place — a rate for a removed model is
  // harmless, a missing rate for a live one is not.
  // 2026-08-19: Harsha — "the preview gemini models should be moved to
  // legacy asap." Static legacy: true (not dominance-derived — "preview"
  // status isn't something a cost/quality comparison would ever catch on
  // its own; this is a policy call that preview builds shouldn't be a
  // default-visible pick regardless of how they benchmark).
  // resolveGenerationModel/resolveFallbackModel are untouched — an
  // existing session or schedule pinned to either id is unaffected.
  // Google accepts at most 128 function declarations per request. This limit
  // applies whether Gemini is reached directly or through OpenRouter: the
  // gateway can fail over transports, but it cannot make an invalid upstream
  // request valid. Fresh Emma sidebar sessions expose the legacy full tool
  // catalog, so omitting this cap made Gemini fail deterministically with 400.
  'gemini-3-flash-preview': {"name":"Gemini 3 Flash (Preview)","provider":"google","tier":"cheap","description":"Fast, inexpensive Google model","client":null,"supportsTemperature":true,"maxTools":128,"supportsVision":true,"legacy":true,"qualityScore":17.9,"qualityScoreSource":"Artificial Analysis Intelligence Index, API v2, snapshot 2026-10-07, gemini-3-flash (https://artificialanalysis.ai/)","family":"gemini-flash-preview"},
  'gemini-3.1-pro-preview': {"name":"Gemini 3.1 Pro (Preview)","provider":"google","tier":"medium","description":"Google's capable general-purpose model","client":null,"supportsTemperature":true,"maxTools":128,"supportsVision":true,"legacy":true,"qualityScore":29.7,"qualityScoreSource":"Artificial Analysis Intelligence Index, API v2, snapshot 2026-10-07, gemini-3-1-pro-preview (https://artificialanalysis.ai/)","family":"gemini-pro-preview"},
  'gemini-3.1-flash-lite': {"name":"Gemini 3.1 Flash Lite","provider":"google","tier":"ultra_cheap","description":"Google's lightest, fastest model","client":null,"supportsTemperature":true,"maxTools":128,"supportsVision":true,"qualityScore":15.6,"qualityScoreSource":"Artificial Analysis Intelligence Index, API v2, snapshot 2026-10-07, gemini-3-1-flash-lite-preview (https://artificialanalysis.ai/)","family":"gemini-flash-lite"},
  'gemini-3.5-flash': {"name":"Gemini 3.5 Flash","family":"gemini-flash","provider":"google","tier":"cheap","description":"Fast, inexpensive Google model","client":null,"supportsTemperature":true,"maxTools":128,"supportsVision":true,"qualityScore":32.6,"qualityScoreSource":"Artificial Analysis Intelligence Index, API v2, snapshot 2026-10-07, gemini-3-5-flash (https://artificialanalysis.ai/)"},
  // 2026-08-19: Gemini 3.7 Flash (GA, released 2026-08-13) added — verified
  // live against three independent sources (ai.google.dev/deepmind.google/
  // blog.google, OpenRouter, Artificial Analysis), no Gemini 3.7 Pro or
  // Flash-Lite exists. Google shipped 3.6 Flash first, then 3.7 Flash on top
  // of it — 3.6 is deliberately skipped (never added to this registry) since
  // 3.7 supersedes it outright. `family: 'gemini-flash'` (shared with 3.5
  // Flash, NOT 3.1 Flash Lite — Lite is a distinct "lightest/fastest"
  // positioning, same reasoning as gpt5-chat vs gpt5-nano) lets the
  // dominance rule do its job: 3.7 Flash is both cheaper (cost tier 'cheap'
  // vs 3.5's 'medium') and higher quality (56 vs 52) than 3.5 Flash, so 3.5
  // Flash is now correctly auto-flagged legacy.
  // ENG-1713: gemini-3.6-flash (band predecessor, not itself in this registry),
  // 3.7, and 3.8 all deprecate temperature/top_p/top_k per Google's migration
  // guide (ai.google.dev/gemini-api/docs/latest-model — "Remove deprecated
  // sampling parameters" — confirmed live 2026-09-03 for both ids). Google
  // currently ignores the param on these models (soft no-op) but states a
  // future generation will hard-400 on it, so this is set ahead of that.
  'gemini-3.7-flash': {"name":"Gemini 3.7 Flash","family":"gemini-flash","provider":"google","tier":"cheap","description":"Fast, inexpensive Google model","client":null,"supportsTemperature":false,"maxTools":128,"supportsVision":true,"qualityScore":39.1,"qualityScoreSource":"Artificial Analysis Intelligence Index, API v2, snapshot 2026-10-07, gemini-3-7-flash (https://artificialanalysis.ai/)"},
  'gemini-3.8-flash': {"name":"Gemini 3.8 Flash","family":"gemini-flash","provider":"google","tier":"cheap","description":"Fast, inexpensive Google model","client":null,"supportsTemperature":false,"maxTools":128,"supportsVision":true,"qualityScore":40.9,"qualityScoreSource":"Artificial Analysis Intelligence Index, API v2, snapshot 2026-10-07, gemini-3-8-flash (https://artificialanalysis.ai/)"},
  // Gemini Live voice model — uses persistent WebSocket via liveVoiceService (no vision)
  'gemini-3.1-flash-live-preview': {"client":null,"supportsTemperature":false,"isLive":true,"family":"gemini-flash-live-preview"},
  // ENG-9: OpenRouter models — id is `openrouter/<upstream-provider>/<upstream-model>`,
  // the suffix after the prefix passed straight through as OpenRouter's own model
  // string, so a new upstream model is one registry line, not new routing code.
  //
  // Flags below are sourced from a live GET /api/v1/models[/…/endpoints] snapshot
  // (2026-08-17), not guessed:
  // - supportsTemperature: mirrors each model's `supported_parameters` value.
  // - maxTools: deliberately OMITTED for every OpenRouter entry, including this
  //   one — unlike Azure's documented 128-tool cap, OpenRouter's models AND
  //   endpoints APIs expose no numeric tool-call limit for any model (checked
  //   both), so setting a number here would be a guess, not evidence. (The
  //   128 previously on this line was exactly that guess, copied from the Azure
  //   convention without verification — removed.)
  // - supportsVision: deliberately OMITTED even where `architecture.modality`
  //   reports image/video input — this codebase's own convention for the flag
  //   (see LLMModelConfig.supportsVision above) requires empirical verification
  //   against the real describe_image path, which none of these have had yet.
  //   Metadata-only vision support is not the bar this flag uses elsewhere.
  // - adminOnly: OMITTED for every OpenRouter entry below (2026-08-19: was
  //   `true` on each, gated as unproven-in-our-stack — Harsha: "i'm fine to
  //   include open source / open router stuff for all users not just
  //   isadmin". Client construction is the same lazy-loaded OpenRouter path
  //   already used successfully by gpt-4o-mini above.) No model is gated by
  //   name or family (Opus 4.6 was the last such gate, removed in ENG-2028).
  //   The only adminOnly entries are those auto-added by modelCatalogRefresh,
  //   which stay adminOnly until a human reviews them.
  'openrouter/openai/gpt-4o-mini': {"name":"GPT-4o Mini","family":"gpt5-nano","provider":"openai","tier":"ultra_cheap","description":"Legacy lightweight model","client":null,"supportsTemperature":true,"qualityScore":6.7,"qualityScoreSource":"Artificial Analysis Intelligence Index, API v2, snapshot 2026-10-07, gpt-4o-mini (https://artificialanalysis.ai/)"},
  // Workload-specific research agent. It is intentionally callable only from
  // DeepResearchService, not exposed as a general chat-picker model.
  // ENG-1831: no OpenRouter endpoint for either Sonar model lists `tools` (or `tool_choice`).
  'openrouter/perplexity/sonar-deep-research': {"client":null,"supportsTemperature":true,"supportsTools":false,"internalOnly":true,"family":"sonar-deep-research"},
  'openrouter/perplexity/sonar-pro-search': {"client":null,"supportsTemperature":true,"supportsTools":false,"internalOnly":true,"family":"sonar-pro-search"},
  // 2026-08-17 (fourth pass — quality cleanup, not additive): six entries added
  // in the third pass are REMOVED here on Artificial-Analysis benchmark evidence
  // (cited in the ENG-9 PR, not repeated per-line here): grok-4.3 (AA-flagged
  // deprecated, score collapsed 53→38, now below GLM-5.2/DeepSeek-V4-Pro/
  // Kimi-K2.6 at a similar price), mistral-large-2512 (AA Index 16, weakest
  // score checked), llama-4-maverick (AA Index 14, a year old, Meta has since
  // moved to proprietary Muse Spark/Code), llama-4-scout (lowest cheap-tier
  // score; Meta shipped Llama 5 in April 2026, making this a full generation
  // behind), llama-3.1-8b-instruct (older sibling of the same superseded
  // family), qwen3.7-flash (no coding-benchmark coverage — it's vision-language,
  // not a coding model — and its pricing tiers up sharply past 32K-token
  // prompts). qwen3.8-max (now its -0902 snapshot, see below) is KEPT despite losing head-to-head to grok-4.6 at
  // the same $2/$6 price — it's Alibaba's only current non-deprecated entrant
  // (Qwen3.7 Max is independently confirmed deprecated too), so it stays for
  // lab/family redundancy, not because it's the top pick in its tier.
  // kimi-k2.6 is SWAPPED for kimi-k2.7-code (live-verified pricing/flags, not
  // reused from the third pass).
  //
  // Net result: Meta/Llama has ZERO entrants after this cleanup. OpenRouter's
  // catalog has no meta-llama/llama-5* listed as of this snapshot (checked
  // live) — this is a real, currently-unfillable gap, not an oversight.
  // ENG-199/ENG-1685: Claude Fable 5.1 (Anthropic, released 2026-09-01) —
  // routed through OpenRouter, same convention as every other OpenRouter
  // entry in this block (id = openrouter/<upstream-provider>/<upstream-model>,
  // one registry line, no new routing code). This is ENG-199's actual wire-in:
  // llmPricing.ts had a Fable 5 pricing stub staged since ENG-200 for exactly
  // this moment, but Fable 5 itself was NEVER added to this llmModels
  // registry — so there is no existing Fable entry to compare against yet.
  // Going straight to 5.1 (the current model; Fable 5 is already superseded
  // as of 2026-09-01) rather than also backfilling the now-superseded 5.
  // AA Intelligence Index v4.2 (2026-09-05): 57, Adaptive Reasoning,
  // Max Effort — #1, 3pts above Claude Opus 5 (54). Quality and cost plug into the
  // EXISTING dominance rule (getSupportedModelsWithMetadata) automatically —
  // no dominance action needed today since there's no sibling family member,
  // but the very next same-family add (e.g. a future Fable 5.2) will
  // auto-flag whichever one loses on both cost and quality, same as every
  // other family in this registry.
  // supportsVision/supportsTemperature per OpenRouter's live model page
  // (architecture.modality includes image+file input; reasoning-capable).
  // ENG-199's cost-control blocker (ENG-200) is closed — org/per-user LLM
  // cost caps already exist and apply automatically to every model priced
  // in llmPricing.ts, this one included.
  'openrouter/anthropic/claude-fable-5.1': {"name":"Claude Fable 5.1","family":"claude-fable","provider":"anthropic","tier":"ultra_premium","description":"Anthropic's top-ranked model for coding & agentic work","client":null,"supportsTemperature":false,"supportsToolChoice":false,"supportsVision":true,"qualityScore":53.4,"qualityScoreSource":"Artificial Analysis Intelligence Index, API v2, snapshot 2026-10-07, claude-fable-5-1 (https://artificialanalysis.ai/)"},
  // Claude Opus 5.5 (Anthropic, released 2026-09-22) — first of the 5.5 family;
  // Sonnet 5.5 / Haiku 5.5 shipped later and are wired as adminOnly OpenRouter
  // entries at the top of this registry. Same OpenRouter convention
  // as Fable 5.1 above (id = openrouter/<upstream-provider>/<upstream-model>,
  // no new routing code). Unlike Fable 5.1, every OpenRouter endpoint for this
  // model lists `tool_choice`, so no supportsToolChoice override is needed.
  // supportsReasoningEfforts from the live OpenRouter model record
  // (reasoning.mandatory, supported [max, xhigh, high, medium, low],
  // default high) — documents capability only; no reasoningEffort default is
  // set, so callLLM sends no `reasoning` param (same posture as GPT-6 Astra).
  // supportsVision per OpenRouter architecture.modality (text+image+file
  // input) — verified LIVE 2026-09-22 on the exact describe_image shape (a
  // base64 data-URI JPEG through OpenRouter): correct scene description, so
  // the flag meets this file's empirical bar, not just metadata.
  // qualityScore: AA v4.3.2, 58, #1 of 206. Consequence,
  // verified 2026-09-22: at 58 vs Opus 5's 54 in the same cost band, the
  // existing dominance rule correctly flags Opus 5 legacy (Show more) — a
  // genuine supersede, not a promo-price accident like the Terra case.
  'openrouter/anthropic/claude-opus-5.5': {"supportedReasoningEfforts":["max","xhigh","high","medium","low"],"name":"Claude Opus 5.5","family":"claude-opus","provider":"anthropic","tier":"ultra_premium","description":"Anthropic's flagship model for coding & agentic work","client":null,"supportsTemperature":false,"supportsVision":true,"qualityScore":57.6,"qualityScoreSource":"Artificial Analysis Intelligence Index, API v2, snapshot 2026-10-07, claude-opus-5-5 (https://artificialanalysis.ai/)"},
  // 2026-09-22: GPT-6 Sol / GPT-6 Luna (OpenAI, released 2026-09-22) and
  // Grok 4.7 (SpaceXAI). Scores are AA Intelligence Index v4.3.2 (newer than
  // the v4.2 snapshot most rows use — same caveat as Opus 5.5). Deliberately
  // NO `family` on any of them: the obvious siblings (GPT-5.6 Luna in
  // gpt5-nano, Grok 4.6) carry v4.2 scores, and dominance across index
  // versions is not a like-for-like comparison. supportsVision verified live
  // with a base64 data-URI JPEG (the describe_image shape) the same day.
  // Sol/Luna: no OpenRouter endpoint lists `temperature`. Routing: OpenRouter
  // prefers our BYOK Bedrock key automatically; the Bedrock Marketplace
  // subscription for both was still "being set up" at add time, so calls fell
  // back to OpenAI direct (OpenRouter credits) until it completes.
  'openrouter/openai/gpt-6-sol': {"supportedReasoningEfforts":["max","xhigh","high","medium","low","none"],"name":"GPT-6 Sol","provider":"openai","tier":"pro","description":"Strong reasoning at half the price of GPT-5.6 Sol","client":null,"supportsTemperature":false,"supportsVision":true,"qualityScore":47.6,"qualityScoreSource":"Artificial Analysis Intelligence Index, API v2, snapshot 2026-10-07, gpt-6-sol (https://artificialanalysis.ai/)","family":"gpt-sol"},
  'openrouter/openai/gpt-6-luna': {"supportedReasoningEfforts":["max","xhigh","high","medium","low","none"],"name":"GPT-6 Luna","provider":"openai","tier":"ultra_cheap","description":"Fast and very inexpensive GPT-6 reasoning","client":null,"supportsTemperature":false,"supportsVision":true,"qualityScore":38.1,"qualityScoreSource":"Artificial Analysis Intelligence Index, API v2, snapshot 2026-10-07, gpt-6-luna (https://artificialanalysis.ai/)","family":"gpt5-nano"},
  // Grok 4.7: served only by xAI on OpenRouter (no Bedrock/Azure endpoint), so
  // it runs on OpenRouter credits until an xAI BYOK key is attached.
  'openrouter/x-ai/grok-4.7': {"supportedReasoningEfforts":["xhigh","high","medium","low"],"name":"Grok 4.7","family":"grok","provider":"xai","tier":"pro","description":"SpaceXAI's latest, strong at agentic coding","client":null,"supportsTemperature":true,"supportsVision":true,"qualityScore":46.4,"qualityScoreSource":"Artificial Analysis Intelligence Index, API v2, snapshot 2026-10-07, grok-4-7 (https://artificialanalysis.ai/)"},
  'openrouter/x-ai/grok-4.6': {"name":"Grok 4.6","family":"grok","provider":"xai","tier":"pro","description":"Near-Opus quality, fastest of the top tier","client":null,"supportsTemperature":true,"qualityScore":44.3,"qualityScoreSource":"Artificial Analysis Intelligence Index, API v2, snapshot 2026-10-07, grok-4-6 (https://artificialanalysis.ai/)"},
  'openrouter/deepseek/deepseek-v4-pro': {"name":"DeepSeek V4 Pro","provider":"deepseek","tier":"medium","description":"Strong coding performance at low cost","client":null,"supportsTemperature":true,"qualityScore":30.4,"qualityScoreSource":"Artificial Analysis Intelligence Index, API v2, snapshot 2026-10-07, deepseek-v4-pro-0424 (https://artificialanalysis.ai/)","family":"deepseek-pro"},
  // ENG-1786 research uses AA's canonical DeepSeek V4 Flash 0731,
  // Reasoning, Max Effort variant. The prior 2026-08-19 source used 0423;
  // this benchmark snapshot does not change the OpenRouter id or pricing.
  'openrouter/deepseek/deepseek-v4-flash': {"name":"DeepSeek V4 Flash","provider":"deepseek","tier":"ultra_cheap","description":"Maximum efficiency for high-volume work","client":null,"supportsTemperature":true,"qualityScore":34.3,"qualityScoreSource":"Artificial Analysis Intelligence Index, API v2, snapshot 2026-10-07, deepseek-v4-flash (https://artificialanalysis.ai/)","family":"deepseek-flash"},
  // Renamed 2026-10-09: OpenRouter dropped the bare `qwen/qwen3.8-max` id from its catalog and now
  // lists only the snapshot `qwen/qwen3.8-max-0902` (canonical qwen/qwen3.8-max-20260902), same
  // $2/$6 price. The old id lives on as a LEGACY_MODEL_ALIASES entry so existing pins keep working.
  'openrouter/qwen/qwen3.8-max-0902': {"name":"Qwen3.8 Max","provider":"qwen","tier":"pro","description":"Alibaba's flagship model","client":null,"supportsTemperature":true,"qualityScore":40,"qualityScoreSource":"Artificial Analysis Intelligence Index v4.3.2, snapshot 2026-09-22, Qwen3.8 Max, reasoning","family":"qwen-max"},
  // 2026-08-26 (ENG-1604): added after live cost+quality research — AA
  // Intelligence Index 52 (v4.1.1, measured, not estimated), #1 of 138
  // models in its size class, roughly matching DeepSeek V4 Pro's quality
  // (53) at about half the input price. Skipped sibling candidates:
  // qwen3-coder-next (AA 21, coding-only, deferred by Harsha this pass),
  // qwen3-max/qwen3-max-thinking/qwen3-vl-235b (AA "estimated", not
  // measured, or AA-flagged deprecated).
  'openrouter/qwen/qwen3.8-27b': {"name":"Qwen3.8 27B","provider":"qwen","tier":"medium","description":"Alibaba's efficient open-weight model, leading in its size class","client":null,"supportsTemperature":true,"qualityScore":34,"qualityScoreSource":"Artificial Analysis Intelligence Index v4.3.2, snapshot 2026-09-22, Qwen3.8 27B, xhigh","family":"qwen-27b"},
  'openrouter/mistralai/mistral-small-2603': {"name":"Mistral Small","provider":"mistral","tier":"cheap","description":"Fast and inexpensive","client":null,"supportsTemperature":true,"qualityScore":11,"qualityScoreSource":"Artificial Analysis Intelligence Index v4.3.2, snapshot 2026-09-22, Mistral Small 4, reasoning","family":"mistral-small"},
  'openrouter/moonshotai/kimi-k3': {"name":"Kimi K3","provider":"moonshot","tier":"ultra_premium","description":"Frontier-scale reasoning, near the top of the field","client":null,"supportsTemperature":true,"qualityScore":44,"qualityScoreSource":"Artificial Analysis Intelligence Index v4.3.2, snapshot 2026-09-22, Kimi K3, max","family":"kimi-k"},
  'openrouter/moonshotai/kimi-k2.7-code': {"name":"Kimi K2.7 Code","provider":"moonshot","tier":"medium","description":"Coding-focused, efficient","client":null,"supportsTemperature":true,"qualityScore":26,"qualityScoreSource":"Artificial Analysis Intelligence Index v4.3.2, snapshot 2026-09-22, Kimi K2.7 Code, reasoning","family":"kimi-k-code"},
  'openrouter/z-ai/glm-5.2': {"name":"GLM 5.2","provider":"zai","tier":"medium","description":"Capable open-weight model, strong value","client":null,"supportsTemperature":true,"qualityScore":33.7,"qualityScoreSource":"Artificial Analysis Intelligence Index, API v2, snapshot 2026-10-07, glm-5-2 (https://artificialanalysis.ai/)","family":"glm"},
  'openrouter/z-ai/glm-4.7-flash': {"name":"GLM 4.7 Flash","provider":"zai","tier":"ultra_cheap","description":"Maximum efficiency for high-volume work","client":null,"supportsTemperature":true,"qualityScore":14.9,"qualityScoreSource":"Artificial Analysis Intelligence Index, API v2, snapshot 2026-10-07, glm-4-7-flash (https://artificialanalysis.ai/)","family":"glm-flash"},
  // 2026-08-19: OpenAI's GPT-5.6 three-tier family (Sol/Terra/Luna, launched
  // 2026-07-09), added via OpenRouter — live-confirmed slugs and pricing at
  // openrouter.ai/openai/gpt-5.6-{sol,terra,luna}. adminOnly per the
  // existing convention for unverified-in-our-stack OpenRouter entries.
  // Sol: AA Coding Agent Index leader (80) but behind Opus 5 on 9/12
  // tracked benchmarks including SWE-bench Pro and ARC-AGI-3 — pro tier,
  // not ultra_premium. Terra: GPT-5.5-competitive quality at ~half cost —
  // replaces gpt-5.5 as the default GPT-5.x picker row. Luna: cheap/fast,
  // ~24 benchmark points per API dollar at launch pricing — ultra_cheap.
  // 2026-08-19: NOT in the 'gpt5-chat' family (unlike Terra/5.5/5.4/etc) —
  // its own description marks it as a distinct specialized/premium
  // positioning ("Frontier coding and agentic work"), not a generation of
  // the "Balanced general-purpose model" line the rest of that family
  // shares verbatim in their description text. Lumping it in wrongly
  // flagged GPT-5.6 Terra as legacy: Sol's OpenRouter price is currently
  // on a promotional discount that happens to land it in the same cost
  // band as Terra, so same-family dominance concluded Terra was
  // redundant — a coincidence of a volatile promo price, not a real
  // "Terra is superseded" fact. Same principle as keeping Kimi K3 out of
  // a family with Kimi K2.7-Code (a coding-specialized sibling).
  'openrouter/openai/gpt-5.6-sol': {"name":"GPT-5.6 Sol","provider":"openai","tier":"pro","description":"Frontier coding and agentic work","client":null,"supportsTemperature":false,"qualityScore":47,"qualityScoreSource":"Artificial Analysis Intelligence Index v4.3.2, snapshot 2026-09-22, GPT-5.6 Sol, max","family":"gpt-sol"},
  'openrouter/openai/gpt-5.6-terra': {"name":"GPT-5.6 Terra","family":"gpt5-chat","provider":"openai","tier":"medium","description":"Balanced general-purpose model","client":null,"supportsTemperature":false,"qualityScore":42.1,"qualityScoreSource":"Artificial Analysis Intelligence Index, API v2, snapshot 2026-10-07, gpt-5-6-terra (https://artificialanalysis.ai/)"},
  'openrouter/openai/gpt-5.6-luna': {"name":"GPT-5.6 Luna","family":"gpt5-nano","provider":"openai","tier":"ultra_cheap","description":"Fast and inexpensive, still real GPT-5.6 reasoning","client":null,"supportsTemperature":false,"qualityScore":37.3,"qualityScoreSource":"Artificial Analysis Intelligence Index, API v2, snapshot 2026-10-07, gpt-5-6-luna (https://artificialanalysis.ai/)"},
  // ENG-1769 (2026-09-05): GPT-6 Astra — OpenAI's frontier release of
  // 2026-09-03, added the day Harsha asked ("is it possible to launch astra
  // on agentweb now? ... go ahead"). Same one-line OpenRouter convention as
  // the GPT-5.6 trio above and Fable 5.1 (ENG-199): id =
  // openrouter/<upstream-provider>/<upstream-model>, no new routing code.
  // Transport: OpenRouter BYOK → our own Azure resource
  // (agentweb-openrouter-byok, westus3, deployment `gpt-6-astra` version
  // 2026-09-03, GlobalStandard, created 2026-09-05). Live-confirmed the same
  // day: response provider "Azure", usage.is_byok true, and an exact
  // upstream inference cost. AgentMode meters that upstream value for BYOK
  // calls so OpenRouter's long-context pricing overrides remain accurate.
  // Quality: AA Intelligence Index v4.2 (2026-09-05), max effort: Astra 55,
  // below Fable 5.1 (57), above Sol (51). Canonical benchmark variants only.
  // Deliberately NO `family`: Astra and Sol are distinct product lines;
  // sharing a family could auto-retire one after a price move, like the
  // Terra false-positive documented above. Same treatment as Sol and Kimi K3.
  // supportsVision: verified EMPIRICALLY 2026-09-05 against the exact shape
  // describeImage sends (a `data:image/png;base64,…` image_url, ~8 KB PNG)
  // through this OpenRouter→Azure BYOK path: correct answer, and the same
  // image via an https URL also correct — the bar LLMModelConfig.supportsVision
  // sets, not just OpenRouter's architecture metadata (which also lists
  // file+image+text). Curiosity recorded, not a blocker: a 64x64 two-color
  // synthetic PNG was misread by Astra ("can't see the image" / wrong
  // colors) while GPT-5.5 and Sol read it correctly on the same path — real
  // images are what describe_image sends. supportsTemperature false: a
  // reasoning model — `temperature` is not in its supported_parameters
  // (Azure's reasoning-models doc says the same).
  // maxTools 128: the upstream is Azure OpenAI (live-confirmed above), and
  // Azure's 128-tool cap is a recorded production failure in this repo, not a
  // doc claim — ce154d09c / dev.md 2026-04-26: gpt-5.4 returned HTTP 400
  // "Invalid 'tools': array too long. Expected an array with maximum length
  // 128, but got an array with length 143" once skills pushed the registry
  // past 128, which is what introduced maxTools + callLLM's truncation. The
  // OpenRouter block header omits maxTools because OpenRouter's APIs expose
  // no limit for ARBITRARY upstreams; that rationale does not apply when the
  // upstream is known to be Azure. (The GPT-5.6 trio above omit it and have
  // run since 2026-08-19 — the same gap, not evidence of a higher cap.)
  // `tier` is the no-price fallback only; the picker derives ultra_premium
  // live from MODEL_PRICING.
  // ENG-1788: OpenRouter reasoning.supported_efforts, verified in the issue 2026-09-05.
  'openrouter/openai/gpt-6-astra': {"supportedReasoningEfforts":["max","xhigh","high","medium","low"],"name":"GPT-6 Astra","provider":"openai","tier":"ultra_premium","description":"OpenAI's frontier model for coding and agentic work","client":null,"supportsTemperature":false,"supportsVision":true,"maxTools":128,"qualityScore":52.7,"qualityScoreSource":"Artificial Analysis Intelligence Index, API v2, snapshot 2026-10-07, gpt-6-astra (https://artificialanalysis.ai/)","family":"gpt-astra"},
  // List Claude models via AWS Bedrock - client will be lazy-loaded
  // 2026-08-19: all four below are `legacy` (picker-grouping only, see
  // LLMModelConfig.legacy) — each superseded by Sonnet 5 / Opus 5. Still
  // referenced by live TaskSchedules/ChatSessions (opus-4-8 and sonnet-4-6
  // have active schedules touching them the same day this was written), so
  // NOT deleted and NOT adminOnly — customers can still select them via
  // "Show more", they're just no longer the default row per tier.
  'anthropic.claude-sonnet-4-5-20250929-v1:0': { name: 'Claude Sonnet 4.5', family: 'claude-sonnet', provider: 'anthropic', tier: 'medium', description: 'Previous-generation Sonnet', client: null, supportsTemperature: true, supportsVision: true, legacy: true , qualityScore: 19, qualityScoreSource: 'Artificial Analysis Intelligence Index v4.3.2, snapshot 2026-09-22, Claude Sonnet 4.5, Non-reasoning' },
  'anthropic.claude-sonnet-4-6': {"name":"Claude Sonnet 4.6","family":"claude-sonnet","provider":"anthropic","tier":"medium","description":"Previous-generation Sonnet","client":null,"supportsTemperature":true,"supportsVision":true,"legacy":true,"qualityScore":24.7,"qualityScoreSource":"Artificial Analysis Intelligence Index, API v2, snapshot 2026-10-07, claude-sonnet-4-6 (https://artificialanalysis.ai/)"},
  'anthropic.claude-opus-4-6-v1': {"name":"Claude Opus 4.6","family":"claude-opus","provider":"anthropic","tier":"pro","description":"Previous-generation Opus","client":null,"supportsTemperature":true,"supportsVision":true,"legacy":true,"qualityScore":26.4,"qualityScoreSource":"Artificial Analysis Intelligence Index, API v2, snapshot 2026-10-07, claude-opus-4-6 (https://artificialanalysis.ai/)"},
  // Claude Opus 4.8 via AWS Bedrock (cross-account, bearer-token auth) — available to all users
  // temperature is deprecated for this model
  'anthropic.claude-opus-4-8': {"name":"Claude Opus 4.8","family":"claude-opus","provider":"anthropic","tier":"pro","description":"Previous-generation Opus","client":null,"supportsTemperature":false,"supportsVision":true,"legacy":true,"qualityScore":41.8,"qualityScoreSource":"Artificial Analysis Intelligence Index, API v2, snapshot 2026-10-07, claude-opus-4-8 (https://artificialanalysis.ai/)"},
  // ENG-744 — Claude 5 generation. Opus 5 and Sonnet 5 use the same
  // cross-account bearer-token path as Opus 4.8; Haiku 4.5 is on the default
  // account. Account routing lives in utils/bedrockInferenceProfiles.ts.
  // Opus 5 / Sonnet 5 reject `temperature` with a 400 ("`temperature` is
  // deprecated for this model") — verified against live Bedrock, not assumed.
  'anthropic.claude-opus-5': {"name":"Claude Opus 5","family":"claude-opus","provider":"anthropic","tier":"pro","description":"For complex tasks","client":null,"supportsTemperature":false,"supportsVision":true,"qualityScore":50.8,"qualityScoreSource":"Artificial Analysis Intelligence Index, API v2, snapshot 2026-10-07, claude-opus-5 (https://artificialanalysis.ai/)"},
  'anthropic.claude-sonnet-5': {"name":"Claude Sonnet 5","family":"claude-sonnet","provider":"anthropic","tier":"medium","description":"Most efficient for everyday tasks","client":null,"supportsTemperature":false,"supportsVision":true,"qualityScore":38.2,"qualityScoreSource":"Artificial Analysis Intelligence Index, API v2, snapshot 2026-10-07, claude-sonnet-5 (https://artificialanalysis.ai/)"},
  // Haiku 4.5 still accepts temperature (also live-verified).
  'anthropic.claude-haiku-4-5-20251001-v1:0': {"name":"Claude Haiku 4.5","provider":"anthropic","tier":"cheap","description":"Fastest for quick answers","client":null,"supportsTemperature":true,"supportsVision":true,"qualityScore":15,"qualityScoreSource":"Artificial Analysis Intelligence Index v4.3.2, snapshot 2026-09-22, Claude Haiku 4.5, Non-reasoning","family":"claude-haiku"},
};

// Legacy model ids persisted by sessions/schedules created before a model was
// renamed or fully retired. Maps the old id to its current registry key so old
// sessions/schedules keep working instead of throwing "Invalid model". Opus 4.8
// was renamed from the bare Vertex id "claude-opus-4-8" to the Bedrock id
// "anthropic.claude-opus-4-8" in commit c86c8ec1. gpt-5-chat-2 and gpt-5.2-chat
// were removed from the registry 2026-08-19 (Azure deployment retired/deprecated
// during the migration off the Rui-owned Azure resource — see the registry
// comment above the gpt-5.4 entry) and redirected to gpt-5.5, the current
// non-legacy top of the same gpt5-chat family.
export const LEGACY_MODEL_ALIASES: Record<string, string> = {
  'claude-opus-4-8': 'anthropic.claude-opus-4-8',
  'gpt-5-chat-2': 'gpt-5.5',
  'gpt-5.2-chat': 'gpt-5.5',
  'gemini-2.5-flash': 'gemini-3.1-flash-lite',
  // ENG-2178: schedules created before the OpenRouter migration pin the bare
  // "gpt-4o-mini" id; the same model is now served via OpenRouter.
  'gpt-4o-mini': 'openrouter/openai/gpt-4o-mini',
  // OpenRouter retired the bare `qwen/qwen3.8-max` catalog id in favour of the
  // dated snapshot `qwen/qwen3.8-max-0902` (same price). Compare's served-model
  // check rightly refuses the snapshot slug for the bare id, so pins move forward.
  // Mirrored in the portal's LEGACY_MODEL_ALIAS_IDS (src/lib/modelUnavailable.ts).
  'openrouter/qwen/qwen3.8-max': 'openrouter/qwen/qwen3.8-max-0902',
};

/**
 * A per-instance copy of the registry. AgentModeService instances (and the
 * tests that swap a model's client or add an entry on one instance) must not
 * share mutable entries.
 */
export function createLlmModelRegistry(): Record<string, LLMModelConfig> {
  return Object.fromEntries(
    Object.entries(LLM_MODEL_REGISTRY).map(([modelId, config]) => [modelId, { ...config }]),
  );
}
