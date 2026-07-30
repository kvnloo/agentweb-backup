/**
 * ENG-737 — Native `@google/genai` adapter for Gemini agent calls.
 *
 * Presents the SAME OpenAI-shaped `client.chat.completions.create(params)` surface
 * the Vertex and Bedrock adapters in agentModeService already present, so `callLLM`
 * and the agent loop are unchanged. The difference from the OpenAI-compat endpoint
 * (`generativelanguage.googleapis.com/v1beta/openai/`) is the leak fix: the native
 * SDK honors `thinkingConfig.includeThoughts=false` and tags thought parts with
 * `part.thought===true`, so gemini-3.5-flash chain-of-thought is filtered natively
 * instead of leaking into `message.content` on a truncated turn (the ENG-737 bug).
 * Thinking stays ON — only the *returned* thought parts are dropped.
 *
 * This module is deliberately dependency-light and its translation is pure/exported
 * so the request<->response mapping (the risky part of a provider-transport change)
 * can be characterization-tested without the SDK or the network.
 */

/** Minimal shape of the OpenAI chat-completions params the agent loop passes in. */
export interface OpenAIChatParams {
  model: string;
  messages: any[];
  tools?: any[] | null;
  tool_choice?: any;
  temperature?: number;
  max_completion_tokens?: number | null;
  response_format?: { type?: 'text' | 'json_object' } | null;
}

/** Per-request timeout matching the Vertex/Bedrock adapters (5 min). */
export const GEMINI_REQUEST_TIMEOUT_MS = 5 * 60 * 1000;

export interface GeminiRequestOptions {
  /** maxOutputTokens fallback when the caller does not specify one. */
  defaultMaxTokens: number;
  /** Request timeout in ms; defaults to GEMINI_REQUEST_TIMEOUT_MS. */
  requestTimeoutMs?: number;
}

/**
 * Strip JSON-Schema keywords the Gemini function-declaration schema rejects.
 * Gemini accepts an OpenAPI-3.0 subset; meta/compositional keywords like
 * `$schema`, `$ref`, `$defs`, and `additionalProperties` cause a 400. Applied
 * recursively; everything else (type/properties/items/required/enum/description/
 * anyOf/nullable) is preserved.
 */
export function sanitizeGeminiSchema(schema: any): any {
  if (Array.isArray(schema)) return schema.map(sanitizeGeminiSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const DROP = new Set([
    '$schema', '$id', '$ref', '$defs', 'definitions',
    'additionalProperties', 'unevaluatedProperties', 'patternProperties',
  ]);
  const out: any = {};
  for (const [key, value] of Object.entries(schema)) {
    if (DROP.has(key)) continue;
    out[key] = sanitizeGeminiSchema(value);
  }
  return out;
}

/** Convert one OpenAI message `content` value into an array of Gemini parts. */
function contentToParts(content: any): any[] {
  if (content == null) return [];
  if (typeof content === 'string') {
    return content ? [{ text: content }] : [];
  }
  if (!Array.isArray(content)) return [{ text: String(content) }];

  const parts: any[] = [];
  for (const item of content) {
    if (typeof item === 'string') {
      if (item) parts.push({ text: item });
    } else if (item && item.type === 'text') {
      if (item.text) parts.push({ text: item.text });
    } else if (item && item.type === 'image_url') {
      const url: string = item.image_url?.url || '';
      const m = url.match(/^data:([\w/+.-]+)(?:;[^;]*)*;base64,(.+)$/s);
      if (m) {
        parts.push({ inlineData: { mimeType: m[1].toLowerCase(), data: m[2] } });
      } else if (url) {
        parts.push({ fileData: { fileUri: url } });
      }
    } else if (item) {
      parts.push({ text: typeof item === 'object' ? JSON.stringify(item) : String(item) });
    }
  }
  return parts;
}

/** Parse a tool-result string into the object Gemini's functionResponse.response requires. */
function toFunctionResponseObject(content: any): any {
  const raw = typeof content === 'string' ? content : JSON.stringify(content ?? '');
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    return { result: parsed };
  } catch {
    return { result: raw };
  }
}

/**
 * Translate OpenAI chat-completions params into `@google/genai`
 * `models.generateContent` arguments. Pure.
 */
export function toGeminiRequest(
  params: OpenAIChatParams,
  opts: GeminiRequestOptions,
): { model: string; contents: any[]; config: any } {
  // Gemini matches function results to calls by NAME, not id, so pre-map every
  // assistant tool_call id -> function name to resolve later `tool` messages.
  const toolCallIdToName = new Map<string, string>();
  for (const msg of params.messages) {
    if (msg?.role === 'assistant' && Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        if (tc?.id && tc?.function?.name) toolCallIdToName.set(tc.id, tc.function.name);
      }
    }
  }

  const systemParts: string[] = [];
  const contents: any[] = [];

  const pushContent = (role: 'user' | 'model', parts: any[]) => {
    if (parts.length === 0) return;
    const prev = contents[contents.length - 1];
    // Gemini prefers alternating turns; merge consecutive same-role parts.
    if (prev && prev.role === role) {
      prev.parts.push(...parts);
    } else {
      contents.push({ role, parts });
    }
  };

  for (const msg of params.messages) {
    if (!msg) continue;
    if (msg.role === 'system') {
      const text = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
      if (text) systemParts.push(text);
    } else if (msg.role === 'user') {
      pushContent('user', contentToParts(msg.content));
    } else if (msg.role === 'assistant') {
      const parts = contentToParts(msg.content);
      if (Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
          let args: any = {};
          try { args = JSON.parse(tc.function?.arguments || '{}'); } catch { args = {}; }
          parts.push({ functionCall: { name: tc.function?.name, args } });
        }
      }
      pushContent('model', parts);
    } else if (msg.role === 'tool') {
      const name = toolCallIdToName.get(msg.tool_call_id) || msg.name || 'tool';
      pushContent('user', [{
        functionResponse: { name, response: toFunctionResponseObject(msg.content) },
      }]);
    }
  }

  // Gemini rejects an empty `contents`; a call whose only messages were `system`
  // (routed to systemInstruction) would otherwise 400. Fall back to a minimal user
  // turn, matching the Vertex adapter's '.' guard.
  if (contents.length === 0) {
    contents.push({ role: 'user', parts: [{ text: '.' }] });
  }

  const config: any = {
    // THE leak fix: keep thinking on but never return thought parts.
    thinkingConfig: { includeThoughts: false },
    maxOutputTokens: params.max_completion_tokens || opts.defaultMaxTokens,
    // Match the 5-min per-request budget of the Vertex/Bedrock adapters instead of
    // inheriting the SDK default (long research turns are exactly where this runs).
    httpOptions: { timeout: opts.requestTimeoutMs ?? GEMINI_REQUEST_TIMEOUT_MS },
  };
  if (systemParts.length > 0) config.systemInstruction = systemParts.join('\n');
  if (params.temperature !== undefined && params.temperature !== null) {
    config.temperature = params.temperature;
  }

  const hasTools = Array.isArray(params.tools) && params.tools.length > 0;
  if (hasTools) {
    config.tools = [{
      functionDeclarations: params.tools!.map((t: any) => ({
        name: t.function?.name,
        description: t.function?.description || t.function?.name,
        parameters: sanitizeGeminiSchema(t.function?.parameters) || { type: 'object', properties: {} },
      })),
    }];
  } else if (params.response_format?.type === 'json_object') {
    // Gemini rejects function-calling + JSON mode together, so only request the
    // JSON MIME type on non-tool calls (the structured-output helper paths).
    config.responseMimeType = 'application/json';
  }

  return { model: params.model, contents, config };
}

/**
 * Translate a `@google/genai` generateContent response into the OpenAI-shaped
 * response the agent loop reads (`choices[0].message`, `finish_reason`,
 * `stop_reason`, `usage`). Pure.
 */
export function fromGeminiResponse(resp: any): any {
  const candidate = resp?.candidates?.[0];
  const parts: any[] = candidate?.content?.parts || [];

  const textParts: string[] = [];
  const toolCalls: any[] = [];
  for (const part of parts) {
    if (!part) continue;
    // Defense in depth: includeThoughts=false should prevent these, but never
    // let a thought part reach the chat surface (the ENG-737 leak).
    if (part.thought === true) continue;
    if (part.functionCall) {
      toolCalls.push({
        id: `call_${part.functionCall.name || 'fn'}_${toolCalls.length}`,
        type: 'function',
        function: {
          name: part.functionCall.name,
          arguments: JSON.stringify(part.functionCall.args ?? {}),
        },
      });
    } else if (typeof part.text === 'string') {
      textParts.push(part.text);
    }
  }

  const geminiFinish: string = candidate?.finishReason || '';
  const hasToolCalls = toolCalls.length > 0;
  // A MAX_TOKENS stop with a tool call means the call was truncated mid-argument,
  // so its JSON is incomplete — do NOT surface it as a completed tool_calls turn.
  // Report finish_reason='length' with no tool_calls so the loop's max-tokens
  // continuation path asks the model to continue (matches Vertex/Bedrock, ENG-403).
  const truncatedToolCall = geminiFinish === 'MAX_TOKENS' && hasToolCalls;

  let finishReason: string;
  if (geminiFinish === 'MAX_TOKENS') finishReason = 'length';
  else if (hasToolCalls) finishReason = 'tool_calls';
  else finishReason = 'stop';

  const message: any = { role: 'assistant', content: textParts.join('') || null };
  if (hasToolCalls && !truncatedToolCall) message.tool_calls = toolCalls;

  const usage = resp?.usageMetadata || {};
  const promptTokens = usage.promptTokenCount || 0;
  // Thinking tokens are billed as output even when not returned, so fold
  // thoughtsTokenCount into completion_tokens for correct cost/quota accounting.
  const completionTokens = (usage.candidatesTokenCount || 0) + (usage.thoughtsTokenCount || 0);
  const cacheReadTokens = usage.cachedContentTokenCount || 0;

  return {
    id: `gemini-native-${candidate?.index ?? 0}`,
    object: 'chat.completion',
    model: resp?.modelVersion,
    choices: [{
      index: 0,
      message,
      finish_reason: finishReason,
      stop_reason: geminiFinish || undefined,
    }],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: usage.totalTokenCount || (promptTokens + completionTokens),
      cache_read_input_tokens: cacheReadTokens,
      cache_creation_input_tokens: 0,
    },
  };
}

/** A `@google/genai`-like client: only the one method this adapter calls. */
export interface GeminiNativeSdk {
  models: { generateContent: (args: { model: string; contents: any[]; config: any }) => Promise<any> };
}

export interface GeminiNativeClientDeps {
  /** Lazily resolve the SDK client (key fetch cached by the caller). */
  getClient: () => Promise<GeminiNativeSdk>;
  defaultMaxTokens: number;
}

/**
 * Build an OpenAI-compatible client wrapper (only `chat.completions.create`) that
 * routes through the native SDK. Drop-in for the compat OpenAI client in the
 * gemini branch of callLLM.
 */
export function createGeminiNativeClient(deps: GeminiNativeClientDeps): {
  chat: { completions: { create: (params: OpenAIChatParams) => Promise<any> } };
} {
  return {
    chat: {
      completions: {
        create: async (params: OpenAIChatParams) => {
          const client = await deps.getClient();
          const req = toGeminiRequest(params, { defaultMaxTokens: deps.defaultMaxTokens });
          const resp = await client.models.generateContent(req);
          return fromGeminiResponse(resp);
        },
      },
    },
  };
}
