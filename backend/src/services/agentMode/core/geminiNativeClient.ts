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
 * Every field the `@google/genai` `Schema` type models — i.e. the complete set of
 * keywords a Gemini function declaration accepts. Kept in sync with `Schema` in
 * `@google/genai/dist/genai.d.ts`.
 */
/**
 * Deepest sub-schema nesting we will emit. Two independent ceilings meet here:
 *
 *  - ours: unbounded recursion on a circular schema overflows the stack and kills the
 *    worker mid-turn, reproducing the zero-assistant-output signature this whole
 *    ticket is about;
 *  - Gemini's: the request 400s with `Message recursion depth exceeds maximum of 64`.
 *    That budget is in PROTOBUF messages, not schema levels, and an object level costs
 *    two of them (Schema -> properties entry -> Schema) where an array level costs one.
 *    Measured against the live API: a 40-deep array chain is accepted, a 30-deep OBJECT
 *    chain is not, and 25 is.
 *
 * 20 sits under the tighter (object) ceiling with margin, and is still far beyond any
 * real tool schema — the deepest in this repo is single digits — so it only ever fires
 * on a pathological or circular third-party MCP schema.
 */
const MAX_SCHEMA_DEPTH = 20;

/** Degradations accumulated while sanitizing one tool schema, reported once at the end. */
interface SanitizeReport {
  /** Nodes flattened to a leaf by the cycle guard or the depth cap. */
  truncated: number;
  /** Arrays whose element type was recovered from `prefixItems`/`contains`. */
  salvagedItems: number;
  /** Arrays whose element type had to be invented as `string`. */
  blindItems: number;
}

export const GEMINI_SCHEMA_KEYWORDS = new Set([
  'anyOf', 'default', 'description', 'enum', 'example', 'format', 'items',
  'maxItems', 'maxLength', 'maxProperties', 'maximum', 'minItems', 'minLength',
  'minProperties', 'minimum', 'nullable', 'pattern', 'properties',
  'propertyOrdering', 'required', 'title', 'type',
]);

/**
 * Reduce a JSON Schema to the OpenAPI-3.0 subset a Gemini function declaration
 * accepts. Gemini's validator rejects ANY unknown field outright — the whole
 * request 400s the moment one offending tool is attached, so the agent turn dies
 * before the first token with zero assistant output and null tokens/cost.
 *
 * ENG-845: this is an ALLOWLIST of the keywords `@google/genai`'s `Schema` models,
 * not a denylist of known-bad ones. The denylist form regressed three times — it
 * grew `x-*` (ENG-737: `x-aliases` on search_tool_response et al broke 100% of
 * gemini tool turns), then `oneOf`/`allOf`/`const`, then union `type` arrays
 * (ENG-826, the defect that actually killed the LinkedIn Post Factory runs) — and
 * each time the gap only surfaced as a production outage, because the schemas that
 * carry the missing keyword are third-party: `mcpClientService` registers whatever
 * `tools/list` returns as `tool.inputSchema`, verbatim, as the function parameters.
 * No enumeration of bad keywords can stay complete against that; only an allowlist
 * closes the class.
 *
 * The concrete headroom this buys is a version bump away rather than live today:
 * prod runs the pinned `@playwright/mcp` 0.0.70, whose 21 tools carry only
 * `$schema`/`additionalProperties` (both already denied). 0.0.78 adds `browser_drop`,
 * whose `data` property carries `propertyNames` — verified against the real API to
 * 400 the ENTIRE request under the old denylist and to be accepted under this
 * allowlist. The `github` stdio server in `mcp_config.ts` is the same shape of
 * exposure once a user configures its secret. Keywords verified to 400 the request:
 * `propertyNames`, `examples`, `exclusiveMinimum`/`exclusiveMaximum`, `multipleOf`,
 * `uniqueItems`, `readOnly`, `deprecated`, `contentEncoding`, `not`.
 *
 * The filter is POSITION-AWARE: `properties` maps parameter NAMES to sub-schemas, so
 * its keys must never be keyword-filtered (a parameter legitimately named `const` or
 * `additionalProperties` would otherwise be deleted from the declaration, leaving the
 * model unable to supply it). Only `properties` values, `items` and `anyOf` hold
 * sub-schemas and are recursed into; `default`/`example` hold literal instance data
 * and pass through untouched.
 *
 * ENG-826: a JSON-Schema union `type` array (e.g. `type: ['array', 'string']`, as
 * used by emma/tools.ts — get_meta_ads_metrics campaign_ids, gmail send to/cc/bcc)
 * is collapsed to the SINGLE OpenAPI type Gemini's `Schema.type` allows: `array` is
 * kept when present (so `items` stays meaningful and the model can pass a list),
 * else `object` when the node actually carries `properties`, else the first non-`null`
 * member; a `null` member becomes `nullable: true`. Array-only keywords are dropped
 * when the resolved type is not `array`. Claude/Bedrock accept the union, which is
 * why only gemini-3.5-flash runs failed.
 */
export function sanitizeGeminiSchema(schema: any, depth = 0, ancestors?: Set<any>, report?: SanitizeReport): any {
  // NOTE: the explicit arrow matters — `map(sanitizeGeminiSchema)` would pass the
  // array INDEX as `depth`, silently truncating every member past the limit.
  if (Array.isArray(schema)) return schema.map((entry) => sanitizeGeminiSchema(entry, depth, ancestors, report));
  if (!schema || typeof schema !== 'object') return schema;

  // Degradations are collected across the whole traversal and reported ONCE by the
  // outermost call, so a pathological schema logs a single summary rather than a line
  // per node. Silence is what made the original ENG-845 failure so expensive to find.
  const notes: SanitizeReport = report ?? { truncated: 0, blindItems: 0, salvagedItems: 0 };

  // A schema reachable from itself recurses forever, as does a pathologically deep
  // one; either would take down the worker with a stack overflow rather than a 400.
  // JSON `$ref` can't produce this (it is stripped before we recurse), but a
  // dereferenced or hand-built circular object can. Both cases TRUNCATE to a leaf:
  // the node keeps its own keywords and loses only its children, which stays a valid
  // schema instead of dropping the parameter outright.
  const path = ancestors ?? new Set<any>();
  const truncate = path.has(schema) || depth >= MAX_SCHEMA_DEPTH;
  if (!truncate) path.add(schema);
  else notes.truncated++;

  const out: any = {};
  for (const [key, value] of Object.entries(schema)) {
    if (!GEMINI_SCHEMA_KEYWORDS.has(key)) continue;
    if (key === 'properties') {
      // Keys here are parameter names, not keywords — recurse into the values only.
      if (truncate || !value || typeof value !== 'object' || Array.isArray(value)) continue;
      const properties: any = {};
      for (const [name, sub] of Object.entries(value)) properties[name] = sanitizeGeminiSchema(sub, depth + 1, path, notes);
      out.properties = properties;
    } else if (key === 'items') {
      // Gemini's `items` is a single Schema; a draft-07 tuple array 400s with
      // `Unknown name "0" at ...items`. Keep the first element so the parameter
      // stays usable instead of dropping the element schema outright.
      if (truncate) continue;
      out.items = sanitizeGeminiSchema(Array.isArray(value) ? value[0] : value, depth + 1, path, notes);
    } else if (key === 'anyOf') {
      if (truncate) continue;
      out.anyOf = sanitizeGeminiSchema(value, depth + 1, path, notes);
    } else {
      out[key] = value;
    }
  }
  // Leave the path as we found it so a schema object legitimately SHARED between two
  // sibling branches is still expanded in both — only true ancestry counts as a cycle.
  if (!truncate) path.delete(schema);
  if (Array.isArray(out.type)) {
    const members = out.type.filter((t: any) => typeof t === 'string');
    const nonNull = members.filter((t: string) => t !== 'null');
    // Prefer a type consistent with this node's sibling constraints so the
    // collapsed schema stays faithful, not just valid: `array` when present (so
    // `items` stays meaningful), else `object` when the node actually carries
    // `properties`, else the first non-null member; `string` only as a last resort
    // for a degenerate union (`[]` / `['null']`).
    const resolved = nonNull.includes('array')
      ? 'array'
      : (nonNull.includes('object') && out.properties !== undefined)
        ? 'object'
        : (nonNull[0] || 'string');
    out.type = resolved;
    if (members.length !== nonNull.length) out.nullable = true;
    if (resolved !== 'array') {
      delete out.items;
      delete out.minItems;
      delete out.maxItems;
    }
  }
  // Gemini REQUIRES `items` on an array — `{ type: 'array' }` alone 400s the whole
  // request with `properties[x].items: missing field`. Several paths can strip it: a
  // degenerate tuple (`items: []`), a schema that declared `array` without `items` at
  // all, and depth/cycle truncation above.
  //
  // Guessing `string` is the LAST resort, because an invented element type is a lie the
  // model acts on: told an array-of-objects is an array-of-strings, it sends strings,
  // execute() rejects them against the ORIGINAL schema, and the user sees a tool error.
  // So first salvage a real element type from the draft-2020 keywords the allowlist
  // drops before we ever reach here — `prefixItems` (the modern tuple form, which
  // `@playwright/mcp` and other draft-2020 schemas use instead of tuple `items`) and
  // `contains`. Both describe the element and are strictly better than a guess.
  if (out.type === 'array' && !isUsableItems(out.items)) {
    const donor = Array.isArray((schema as any).prefixItems)
      ? (schema as any).prefixItems[0]
      : (schema as any).contains;
    if (donor && typeof donor === 'object' && !Array.isArray(donor)) {
      const salvaged = sanitizeGeminiSchema(donor, depth + 1, path, notes);
      if (isUsableItems(salvaged)) {
        out.items = salvaged;
        notes.salvagedItems++;
      }
    }
    if (!isUsableItems(out.items)) {
      out.items = { type: 'string' };
      notes.blindItems++;
    }
  }

  // Outermost call reports once. These are all cases where the request now SUCCEEDS
  // where it previously 400'd or crashed — but with a schema less precise than the tool
  // author wrote, so it must not pass silently.
  if (depth === 0 && !report && (notes.truncated || notes.blindItems || notes.salvagedItems)) {
    console.warn('Gemini schema sanitizer degraded a tool schema:', {
      truncatedNodes: notes.truncated,        // cycle or depth cap hit
      salvagedArrayItems: notes.salvagedItems, // element type recovered from prefixItems/contains
      guessedArrayItems: notes.blindItems,     // element type invented as `string`
      maxDepth: MAX_SCHEMA_DEPTH,
    });
  }
  return out;
}

/** Gemini needs a typed sub-schema here; an empty or non-object `items` still 400s. */
function isUsableItems(items: any): boolean {
  return !!items && typeof items === 'object' && !Array.isArray(items) && typeof items.type === 'string';
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

/**
 * Placeholder text emitted for an UNSIGNED assistant tool_call (see toGeminiRequest).
 * Kept as a named builder so `isHistoryDegradationEcho` below can never drift from
 * the string this actually produces.
 */
function degradedToolCallText(name: string | undefined, args: string | undefined): string {
  return `[Previously called ${name}(${args || '{}'})]`;
}

/** Matches ONE whole line of degraded history (a tool call or its paired result). */
const DEGRADED_HISTORY_LINE = /^\[(?:Previously called |Result of ).*\]$/;

/**
 * ENG-946: is this model output nothing but the degraded history we fed it?
 *
 * When the agent loop falls back mid-run from Bedrock Claude to native Gemini, every
 * prior Claude tool_call is unsigned, so the whole tool history is degraded into
 * `[Previously called ...]` MODEL-role text (and `[Result of ...]` user-role text).
 * Production scheduled runs showed Gemini then *parroting* that placeholder back as
 * its entire final turn — a non-empty string, so the loop shipped it as the answer
 * and the empty-synthesis nudge never fired. Such a turn carries no information:
 * callers must treat it as no output.
 *
 * Deliberately strict — every non-blank line must be a placeholder. A real answer
 * that merely quotes one line still counts as real output.
 */
export function isHistoryDegradationEcho(text: string): boolean {
  if (typeof text !== 'string') return false;
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return false;
  return lines.every((line) => DEGRADED_HISTORY_LINE.test(line));
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
  // assistant tool_call id -> {name, signed}. `signed` = the call carries a Gemini
  // thoughtSignature: gemini-3.5-flash (a thinking model) REQUIRES that signature to
  // be echoed back on the functionCall part, or the next turn 400s
  // ("Function call is missing a thought_signature"). Unsigned calls — from the
  // compat path or a pre-fix session — are degraded to text so no unsigned
  // functionCall part is ever sent (and their results are degraded to text too, to
  // keep functionResponse paired with a functionCall).
  const toolCallInfo = new Map<string, { name: string; signed: boolean }>();
  for (const msg of params.messages) {
    if (msg?.role === 'assistant' && Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        if (tc?.id && tc?.function?.name) {
          toolCallInfo.set(tc.id, { name: tc.function.name, signed: !!tc.thought_signature });
        }
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
          if (tc.thought_signature) {
            // Echo the thoughtSignature back — required for a thinking-model tool turn.
            parts.push({ functionCall: { name: tc.function?.name, args }, thoughtSignature: tc.thought_signature });
          } else {
            // No signature (legacy/compat history) → degrade to text; an unsigned
            // functionCall part would 400 the whole request.
            parts.push({ text: degradedToolCallText(tc.function?.name, tc.function?.arguments) });
          }
        }
      }
      pushContent('model', parts);
    } else if (msg.role === 'tool') {
      const info = toolCallInfo.get(msg.tool_call_id);
      const name = info?.name || msg.name || 'tool';
      if (info && !info.signed) {
        // Its call was degraded to text above, so pair the result as text too
        // (a functionResponse with no matching functionCall part would 400).
        const resultText = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content ?? '');
        pushContent('user', [{ text: `[Result of ${name}: ${resultText}]` }]);
      } else {
        pushContent('user', [{
          functionResponse: { name, response: toFunctionResponseObject(msg.content) },
        }]);
      }
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
      const toolCall: any = {
        id: `call_${part.functionCall.name || 'fn'}_${toolCalls.length}`,
        type: 'function',
        function: {
          name: part.functionCall.name,
          arguments: JSON.stringify(part.functionCall.args ?? {}),
        },
      };
      // Preserve the thoughtSignature so it round-trips back on the next turn —
      // gemini-3.5-flash 400s a functionCall history that drops it.
      if (part.thoughtSignature) toolCall.thought_signature = part.thoughtSignature;
      toolCalls.push(toolCall);
    } else if (typeof part.text === 'string') {
      textParts.push(part.text);
    }
  }

  const geminiFinish: string = candidate?.finishReason || '';
  // Gemini stops that mean "cut off mid-work, ask me to continue" rather than a
  // real end-of-turn. MAX_TOKENS is the output-token limit. MALFORMED_FUNCTION_CALL
  // is observed on long gemini-3.5-flash turns that spend the whole budget thinking
  // (thoughtsTokenCount high, includeThoughts=false so nothing leaks) and dead-end
  // with empty text — mapping it to 'stop' would end the turn on an EMPTY answer
  // (the ENG-324/473/657 silent-zero class), so route it to the loop's bounded
  // max-tokens continuation instead.
  const CONTINUATION_FINISHES = new Set(['MAX_TOKENS', 'MALFORMED_FUNCTION_CALL']);
  const isContinuation = CONTINUATION_FINISHES.has(geminiFinish);
  const hasToolCalls = toolCalls.length > 0;
  // A continuation stop with a tool call means the call was truncated mid-argument,
  // so its JSON is incomplete — do NOT surface it as a completed tool_calls turn.
  // Report finish_reason='length' with no tool_calls so the loop's max-tokens
  // continuation path asks the model to continue (matches Vertex/Bedrock, ENG-403).
  const truncatedToolCall = isContinuation && hasToolCalls;

  // Gemini's block/filter finishes — content generated up to the point of the
  // block is NOT a complete answer, even when non-empty (e.g. the model started
  // answering, then got cut off by a safety filter partway through).
  const BLOCK_FINISHES = new Set([
    'SAFETY', 'RECITATION', 'LANGUAGE', 'OTHER', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'IMAGE_SAFETY',
  ]);
  const blockReason = resp?.promptFeedback?.blockReason || (BLOCK_FINISHES.has(geminiFinish) ? geminiFinish : undefined);
  const isBlocked = !!blockReason && !isContinuation;

  let finishReason: string;
  if (isContinuation) finishReason = 'length';
  // 'content_filter' is the SAME finish_reason Azure OpenAI already reports for a
  // blocked completion, and agentModeService.ts already has dedicated handling for
  // it (line ~3481) — reusing it here (instead of an ordinary 'stop') lets the
  // agent loop's termination layer recognize this is a content-filtered turn, not
  // a normal complete answer, even though any partial text is still surfaced with
  // the notice below.
  else if (isBlocked) finishReason = 'content_filter';
  else if (hasToolCalls) finishReason = 'tool_calls';
  else finishReason = 'stop';

  const hasText = textParts.length > 0;
  let content: string | null = textParts.join('') || null;
  if (isBlocked) {
    // A block finish means whatever text made it out (if any) is a PARTIAL
    // answer cut off mid-generation, not a complete response. And if there's no
    // text at all (or candidates are empty entirely — resp.promptFeedback.
    // blockReason — the turn can be fully blocked before any candidate exists),
    // leaving content null would end the whole agent turn on a silent blank
    // reply (the ENG-324/473/657 class). The loop's own backfill only covers the
    // reasoning-leak suppression path, not this, so both cases are handled here.
    const notice = `[Response cut short by Gemini content filtering (${blockReason})]`;
    content = hasText ? `${content}\n\n${notice}` : `I wasn't able to generate a response for this turn (Gemini: ${blockReason}). Please try rephrasing your request.`;
  } else if (!hasText && !hasToolCalls && !isContinuation) {
    // Empty/unclassified stop with nothing to show (no block reason identified) —
    // same silent-blank-reply risk as above, handled generically.
    content = `I wasn't able to generate a response for this turn (Gemini: ${geminiFinish || 'unknown'}). Please try rephrasing your request.`;
  }
  const message: any = { role: 'assistant', content };
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
