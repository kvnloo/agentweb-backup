/**
 * llmClients — the single factory for metered LLM provider clients (Ship 1: shadow).
 *
 * Every client returned here is the real SDK client with its inference entry
 * points wrapped so that completed responses flow through a per-provider usage
 * normalizer and `recordUsage` is fired (fire-and-forget, never awaited inline).
 *
 * Guarantees:
 *  - The SDK response is returned UNMODIFIED (same object) — metering only
 *    observes it. (Exception: provider stream iterables are re-wrapped with a
 *    transparent passthrough so the final usage event can be captured; every
 *    chunk is yielded unchanged.)
 *  - No awaited latency is added to the hot path: usage is read off the already
 *    resolved response and recordUsage is fired without await.
 *  - Metering errors are swallowed — they can never fail an LLM call.
 *  - Streaming calls where usage is not capturable record outputTokens 0 with a
 *    ":streaming-no-usage" note appended to the feature.
 *
 * The sdkConstructionGuard unit test enforces that new direct SDK constructions
 * (`new OpenAI(`, `new BedrockRuntimeClient(`, `new GoogleGenAI(`, ...) appear
 * only in this file and the seeded legacy allowlist.
 */

import OpenAI from "openai";
// Type-only import (erased at runtime). The Bedrock SDK is lazy-imported inside
// getBedrockClient — a static import breaks test suites that mock node 'crypto'
// (@smithy/uuid binds crypto.randomUUID at module load) and matches the
// existing lazy-load pattern in agentModeService.
import type {
  BedrockRuntimeClient,
  BedrockRuntimeClientConfig,
} from "@aws-sdk/client-bedrock-runtime";
import { recordUsage, meterUserUsage } from "../services/usageRecorderService";

export interface MeterContext {
  userId?: string;
  billingUserId?: string;
  onBehalfOf?: string;
  feature: string;
  sessionId?: string;
  taskId?: string;
}

export interface NormalizedUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** ENG-893: cache-write tokens split by the TTL the provider actually applied. */
  cacheWriteByTtl?: Record<string, number>;
}

// ── Per-provider usage normalizers ────────────────────────────────────────────

/** OpenAI / Azure OpenAI chat completions: usage{prompt_tokens, completion_tokens, prompt_tokens_details.cached_tokens}. */
export function normalizeOpenAIUsage(usage: any): NormalizedUsage {
  return {
    inputTokens: usage?.prompt_tokens || 0,
    outputTokens: usage?.completion_tokens || 0,
    cacheReadTokens: usage?.prompt_tokens_details?.cached_tokens || 0,
  };
}

/** OpenAI embeddings: usage{prompt_tokens, total_tokens} — no completion side. */
export function normalizeEmbeddingsUsage(usage: any): NormalizedUsage {
  return {
    inputTokens: usage?.prompt_tokens || 0,
    outputTokens: 0,
  };
}

/** Bedrock Converse: usage{inputTokens, outputTokens, cacheReadInputTokens, cacheWriteInputTokens}. */
export function normalizeBedrockUsage(usage: any): NormalizedUsage {
  return {
    inputTokens: usage?.inputTokens || 0,
    outputTokens: usage?.outputTokens || 0,
    cacheReadTokens: usage?.cacheReadInputTokens || 0,
    cacheWriteTokens: usage?.cacheWriteInputTokens || 0,
    cacheWriteByTtl: normalizeCacheDetails(usage?.cacheDetails),
  };
}

/**
 * Bedrock's `usage.cacheDetails` -> `{ '1h': 84210 }`. ENG-893: the ledger bills
 * cache writes at the rate for the TTL that was APPLIED, which is not necessarily
 * the one we requested, so this breakdown has to survive normalization.
 */
export function normalizeCacheDetails(cacheDetails: any): Record<string, number> | undefined {
  if (!Array.isArray(cacheDetails) || cacheDetails.length === 0) return undefined;
  const byTtl: Record<string, number> = {};
  for (const detail of cacheDetails) {
    const ttl = typeof detail?.ttl === 'string' ? detail.ttl : undefined;
    const tokens = Number(detail?.inputTokens) || 0;
    if (ttl && tokens > 0) byTtl[ttl] = (byTtl[ttl] || 0) + tokens;
  }
  return Object.keys(byTtl).length > 0 ? byTtl : undefined;
}

/** Gemini: usageMetadata{promptTokenCount, candidatesTokenCount, cachedContentTokenCount}. */
export function normalizeGeminiUsage(usageMetadata: any): NormalizedUsage {
  return {
    inputTokens: usageMetadata?.promptTokenCount || 0,
    outputTokens: usageMetadata?.candidatesTokenCount || 0,
    cacheReadTokens: usageMetadata?.cachedContentTokenCount || 0,
  };
}

/**
 * Anthropic Messages API (native SDK, AnthropicBedrock, and Vertex bearer clients —
 * `client.messages.create`): usage{input_tokens, output_tokens, cache_read_input_tokens,
 * cache_creation_input_tokens}. Note this is a DIFFERENT shape from Bedrock Converse
 * (which uses inputTokens/cacheReadInputTokens) and from OpenAI (prompt_tokens).
 */
export function normalizeAnthropicUsage(usage: any): NormalizedUsage {
  return {
    inputTokens: usage?.input_tokens || 0,
    outputTokens: usage?.output_tokens || 0,
    cacheReadTokens: usage?.cache_read_input_tokens || 0,
    cacheWriteTokens: usage?.cache_creation_input_tokens || 0,
    cacheWriteByTtl: normalizeAnthropicCacheCreation(usage?.cache_creation),
  };
}

/**
 * Anthropic Messages API `usage.cache_creation`
 * ({ ephemeral_5m_input_tokens, ephemeral_1h_input_tokens }) -> `{ '5m': n }`.
 *
 * ENG-893: the Messages-shape counterpart of Bedrock Converse's `cacheDetails`.
 * Both must normalize, because a single model id is used by paths with
 * different TTLs — agent-mode asks Sonnet 4.6 for 1h while codingAgentService
 * uses the same id with no ttl — so cost has to follow the response.
 */
export function normalizeAnthropicCacheCreation(
  cacheCreation: any
): Record<string, number> | undefined {
  if (!cacheCreation || typeof cacheCreation !== 'object') return undefined;
  const byTtl: Record<string, number> = {};
  const fiveMin = Number(cacheCreation.ephemeral_5m_input_tokens) || 0;
  const oneHour = Number(cacheCreation.ephemeral_1h_input_tokens) || 0;
  if (fiveMin > 0) byTtl['5m'] = fiveMin;
  if (oneHour > 0) byTtl['1h'] = oneHour;
  return Object.keys(byTtl).length > 0 ? byTtl : undefined;
}

/**
 * Detect the provider usage shape of a raw completion response and normalize it.
 * Returns null when no usage is present (caller decides what to do).
 *
 * Keying off the RESPONSE SHAPE (not a caller-supplied provider label) is deliberate:
 * some call sites label a request `provider:'bedrock'` yet receive an OpenAI-compatible
 * shim response (e.g. crm enrichment via getClientForModel), so only the shape is a
 * reliable signal for extraction. Ordering matters — Gemini nests usage under
 * `usageMetadata`; the three `usage.*` shapes are disambiguated by their field names:
 *   OpenAI/Azure  -> prompt_tokens / completion_tokens (embeddings omit completion)
 *   Anthropic     -> input_tokens / output_tokens (snake_case)
 *   Bedrock Conv. -> inputTokens / outputTokens (camelCase)
 */
export function normalizeUsageFromResponse(response: any): NormalizedUsage | null {
  if (!response || typeof response !== "object") return null;

  const gm = (response as any).usageMetadata;
  if (
    gm &&
    typeof gm === "object" &&
    (gm.promptTokenCount != null ||
      gm.candidatesTokenCount != null ||
      gm.cachedContentTokenCount != null)
  ) {
    return normalizeGeminiUsage(gm);
  }

  const u = (response as any).usage;
  if (u && typeof u === "object") {
    if (u.prompt_tokens != null || u.completion_tokens != null) {
      return normalizeOpenAIUsage(u);
    }
    if (u.input_tokens != null || u.output_tokens != null) {
      return normalizeAnthropicUsage(u);
    }
    if (u.inputTokens != null || u.outputTokens != null) {
      return normalizeBedrockUsage(u);
    }
  }

  return null;
}

export interface MeterFromResponseContext {
  userId?: string;
  billingUserId?: string;
  onBehalfOf?: string;
  model: string;
  provider: string;
  feature: string;
  sessionId?: string;
  taskId?: string;
}

/**
 * How a metered call is accounted:
 *   - 'meter' (default) -> burn visibility AND the enforced per-user cap deduction.
 *   - 'burn'            -> burn visibility ONLY (platform absorbs the cost; still
 *                          attributed to the user, but never charges the cap).
 *
 * 'meter' is a SUPERSET of 'burn' — it always records the burn and then also deducts.
 * So flipping a site from { mode: 'burn' } to the default (or { mode: 'meter' }) ADDS
 * the deduction on top of the burn; it never loses the visibility.
 */
export type MeterMode = "burn" | "meter";

/**
 * ONE-LINER metering hook for any direct-provider (non-factory) token-based LLM call.
 * Extracts token usage from the raw provider `response` (any of OpenAI/Azure, Anthropic
 * Messages, Bedrock Converse, or Gemini shapes) and meters it:
 *   - default / { mode: 'meter' } -> shadow analytics (burn) + the per-user cap deduction
 *   - { mode: 'burn' }            -> burn only; used for deep research, email drafts,
 *                                    session titles, background automation, etc.
 *
 * Deduction only happens when a real ctx.userId is present — with no user, 'meter'
 * degrades to a bare burn record under "system", so a site can never deduct against nobody.
 *
 * Fire-and-forget + fail-open: it never throws into, awaits, or slows the caller. When the
 * response carries no usage, the call is still recorded (with zero tokens) so call volume
 * stays visible — matching the metered-factory clients' behavior. NOT for image/video,
 * which are per-generation priced (use recordUsage with costUsdOverride for those).
 */
export function meterUsageFromResponse(
  ctx: MeterFromResponseContext,
  response: any,
  opts?: { mode?: MeterMode }
): void {
  try {
    const usage =
      normalizeUsageFromResponse(response) ?? { inputTokens: 0, outputTokens: 0 };
    const meterCtx = {
      userId: ctx.userId,
      billingUserId: ctx.billingUserId,
      onBehalfOf: ctx.onBehalfOf,
      model: ctx.model,
      provider: ctx.provider,
      feature: ctx.feature,
      sessionId: ctx.sessionId,
      taskId: ctx.taskId,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      cacheWriteByTtl: usage.cacheWriteByTtl,
    };
    if (opts?.mode === "burn") {
      void recordUsage(meterCtx);
    } else {
      meterUserUsage(meterCtx);
    }
  } catch {
    // Metering must never break or slow an LLM call.
  }
}

// ── Internal: fire recordUsage without ever throwing or awaiting ──────────────

function fireRecord(
  provider: string,
  model: string | undefined,
  ctx: MeterContext,
  usage: NormalizedUsage,
  note?: string
): void {
  try {
    void recordUsage({
      userId: ctx.userId,
      billingUserId: ctx.billingUserId,
      onBehalfOf: ctx.onBehalfOf,
      model: model || "unknown",
      provider,
      feature: note ? `${ctx.feature}:${note}` : ctx.feature,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      cacheWriteByTtl: usage.cacheWriteByTtl,
      sessionId: ctx.sessionId,
      taskId: ctx.taskId,
    });
  } catch {
    // Metering must never break an LLM call.
  }
}

// ── OpenAI-compatible wrapping (OpenAI direct + Azure OpenAI) ─────────────────

function wrapOpenAICompatible(client: OpenAI, provider: string, ctx: MeterContext): OpenAI {
  // chat.completions.create — guard in case a client/mock lacks the surface.
  if (!client?.chat?.completions?.create) return client;
  const origChatCreate = client.chat.completions.create.bind(client.chat.completions);
  (client.chat.completions as any).create = (params: any, ...rest: any[]) => {
    const result = (origChatCreate as any)(params, ...rest);
    try {
      if (params?.stream) {
        // Stream object can't be observed without consuming it — record the call
        // with zero tokens and a note so call volume stays visible.
        fireRecord(provider, params?.model, ctx, { inputTokens: 0, outputTokens: 0 }, "streaming-no-usage");
      } else {
        Promise.resolve(result)
          .then((resp: any) => {
            if (resp?.usage) {
              fireRecord(provider, resp?.model || params?.model, ctx, normalizeOpenAIUsage(resp.usage));
            }
          })
          .catch(() => {
            /* caller sees the original rejection; metering stays silent */
          });
      }
    } catch {
      /* never break the call */
    }
    return result;
  };

  // embeddings.create — optional surface; skip if the client/mock omits it.
  if (!client?.embeddings?.create) return client;
  const origEmbedCreate = client.embeddings.create.bind(client.embeddings);
  (client.embeddings as any).create = (params: any, ...rest: any[]) => {
    const result = (origEmbedCreate as any)(params, ...rest);
    try {
      Promise.resolve(result)
        .then((resp: any) => {
          if (resp?.usage) {
            fireRecord(provider, resp?.model || params?.model, ctx, normalizeEmbeddingsUsage(resp.usage));
          }
        })
        .catch(() => {});
    } catch {
      /* never break the call */
    }
    return result;
  };

  return client;
}

/**
 * Metered OpenAI direct client. Pass `opts.metered = false` to get the raw client
 * when the caller meters the response itself (meterUsageFromResponse) — otherwise
 * the factory's auto-record plus an explicit meter would double-count (ENG-200).
 */
export function getOpenAIClient(
  meterCtx: MeterContext,
  options?: ConstructorParameters<typeof OpenAI>[0],
  opts?: { metered?: boolean }
): OpenAI {
  const client = new OpenAI(options ?? { apiKey: process.env.OPENAI_API_KEY });
  if (opts?.metered === false) return client;
  return wrapOpenAICompatible(client, "openai", meterCtx);
}

/**
 * Metered Azure OpenAI client for a deployment (same construction pattern the
 * chatbot uses: deployment-scoped baseURL + api-key header).
 */
/**
 * Overrides for Azure deployments that don't use the standard
 * AZURE_OPENAI_ENDPOINT / AZURE_OPENAI_API_KEY / AZURE_OPENAI_API_VERSION trio
 * (e.g. the embeddings deployment has its own endpoint + key, and some services
 * pin a different api-version). Pass the call site's exact values so migrating
 * an existing bespoke `new OpenAI({...})` to the factory is behavior-neutral.
 */
export interface AzureClientOverrides {
  endpoint?: string;
  apiKey?: string;
  apiVersion?: string;
  /**
   * When false, return the raw (UN-metered) client — the caller meters the call
   * itself via meterUsageFromResponse. Use this to avoid DOUBLE-recording: the
   * factory's auto-record plus an explicit meterUsageFromResponse on the same
   * response would count the burn twice (ENG-200). Defaults to true (auto-meter).
   */
  metered?: boolean;
}

export function getAzureClient(
  meterCtx: MeterContext,
  deployment?: string,
  overrides?: AzureClientOverrides
): OpenAI {
  const dep = deployment || process.env.AZURE_OPENAI_DEPLOYMENT || "gpt-4";
  const endpoint = overrides?.endpoint ?? process.env.AZURE_OPENAI_ENDPOINT;
  const apiKey = overrides?.apiKey ?? process.env.AZURE_OPENAI_API_KEY;
  const apiVersion =
    overrides?.apiVersion ?? process.env.AZURE_OPENAI_API_VERSION ?? "2024-08-01-preview";
  const client = new OpenAI({
    apiKey,
    baseURL: `${endpoint}/openai/deployments/${dep}`,
    defaultQuery: { "api-version": apiVersion },
    defaultHeaders: { "api-key": apiKey },
  });
  // metered:false → caller meters explicitly (meterUsageFromResponse); returning
  // the wrapped client too would double-record the same response.
  if (overrides?.metered === false) return client;
  return wrapOpenAICompatible(client, "azure-openai", meterCtx);
}

// ── Bedrock wrapping ──────────────────────────────────────────────────────────

/** Strip an inference-profile ARN down to the bare model id for pricing lookups. */
export function bedrockModelIdFromArn(modelId: string | undefined): string {
  if (!modelId) return "unknown";
  const profileMatch = modelId.match(/inference-profile\/(?:global\.)?(.+)$/);
  if (profileMatch) return profileMatch[1];
  return modelId.replace(/^global\./, "");
}

/** Transparent passthrough over a Bedrock Converse stream that captures the final usage event. */
async function* meterBedrockStream(
  stream: AsyncIterable<any>,
  model: string,
  ctx: MeterContext
): AsyncGenerator<any> {
  let usage: any = null;
  try {
    for await (const event of stream) {
      if (event?.metadata?.usage) usage = event.metadata.usage;
      yield event;
    }
  } finally {
    try {
      if (usage) {
        fireRecord("bedrock", model, ctx, normalizeBedrockUsage(usage));
      } else {
        fireRecord("bedrock", model, ctx, { inputTokens: 0, outputTokens: 0 }, "streaming-no-usage");
      }
    } catch {
      /* never break the stream consumer */
    }
  }
}

/** Metered Bedrock runtime client. ConverseCommand + ConverseStreamCommand usage is recorded. */
export async function getBedrockClient(
  meterCtx: MeterContext,
  config?: BedrockRuntimeClientConfig
): Promise<BedrockRuntimeClient> {
  const { BedrockRuntimeClient } = await import("@aws-sdk/client-bedrock-runtime");
  const client = new BedrockRuntimeClient(
    config ?? {
      region: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-west-2",
      ...(process.env.AWS_ACCESS_KEY_ID
        ? {
            credentials: {
              accessKeyId: process.env.AWS_ACCESS_KEY_ID,
              secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "",
            },
          }
        : {}),
    }
  );

  const origSend = client.send.bind(client);
  (client as any).send = async (command: any, ...rest: any[]) => {
    const response = await (origSend as any)(command, ...rest);
    try {
      const commandName = command?.constructor?.name;
      const model = bedrockModelIdFromArn(command?.input?.modelId);
      if (commandName === "ConverseCommand") {
        if (response?.usage) {
          fireRecord("bedrock", model, meterCtx, normalizeBedrockUsage(response.usage));
        }
      } else if (commandName === "ConverseStreamCommand") {
        if (response?.stream && typeof response.stream[Symbol.asyncIterator] === "function") {
          response.stream = meterBedrockStream(response.stream, model, meterCtx);
        } else {
          fireRecord("bedrock", model, meterCtx, { inputTokens: 0, outputTokens: 0 }, "streaming-no-usage");
        }
      }
    } catch {
      /* metering must never break the call */
    }
    return response;
  };

  return client;
}

// ── Gemini wrapping ───────────────────────────────────────────────────────────

/** Transparent passthrough over a Gemini content stream capturing the last usageMetadata. */
async function* meterGeminiStream(
  stream: AsyncIterable<any>,
  model: string | undefined,
  ctx: MeterContext
): AsyncGenerator<any> {
  let usageMetadata: any = null;
  try {
    for await (const chunk of stream) {
      if (chunk?.usageMetadata) usageMetadata = chunk.usageMetadata;
      yield chunk;
    }
  } finally {
    try {
      if (usageMetadata) {
        fireRecord("gemini", model, ctx, normalizeGeminiUsage(usageMetadata));
      } else {
        fireRecord("gemini", model, ctx, { inputTokens: 0, outputTokens: 0 }, "streaming-no-usage");
      }
    } catch {
      /* never break the stream consumer */
    }
  }
}

/**
 * Metered Gemini client (lazy-imports @google/genai like all existing call sites).
 * models.generateContent and models.generateContentStream are wrapped.
 *
 * Pass `opts.metered = false` to get the raw client when the caller meters the
 * response itself via meterUsageFromResponse — needed to both CHARGE (not just
 * record) and avoid double-recording, since the wrapper here is record-only.
 */
export async function getGeminiClient(
  meterCtx: MeterContext,
  apiKey?: string,
  opts?: { metered?: boolean }
): Promise<any> {
  const { GoogleGenAI } = await import("@google/genai");
  const key = (apiKey ?? process.env.GEMINI_API_KEY ?? "").trim();
  if (!key) throw new Error("GEMINI_API_KEY not set");
  const client: any = new GoogleGenAI({ apiKey: key });

  if (opts?.metered === false) return client;

  if (typeof client.models?.generateContent === "function") {
    const origGenerate = client.models.generateContent.bind(client.models);
    client.models.generateContent = async (params: any, ...rest: any[]) => {
      const response = await origGenerate(params, ...rest);
      try {
        if (response?.usageMetadata) {
          fireRecord("gemini", params?.model, meterCtx, normalizeGeminiUsage(response.usageMetadata));
        }
      } catch {
        /* metering must never break the call */
      }
      return response;
    };
  }

  if (typeof client.models?.generateContentStream === "function") {
    const origGenerateStream = client.models.generateContentStream.bind(client.models);
    client.models.generateContentStream = async (params: any, ...rest: any[]) => {
      const stream = await origGenerateStream(params, ...rest);
      try {
        if (stream && typeof stream[Symbol.asyncIterator] === "function") {
          return meterGeminiStream(stream, params?.model, meterCtx);
        }
      } catch {
        /* fall through to unmetered stream */
      }
      return stream;
    };
  }

  return client;
}
