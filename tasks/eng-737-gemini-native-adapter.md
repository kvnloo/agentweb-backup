# ENG-737 — Native `@google/genai` adapter for Gemini agent calls

## Why (durable fix vs. the shipped heuristic)

The gemini-3.5-flash chain-of-thought leak (ENG-737) happens on the **OpenAI-compat
endpoint** (`generativelanguage.googleapis.com/v1beta/openai/`). When a thinking
turn is truncated (`finish_reason: 'length'`) mid-reasoning, the compat endpoint
flattens the partial *thought* into `message.content`, so raw chain-of-thought
renders in chat. The compat endpoint gives us **no** way to suppress thoughts:
- `extra_body.google.thinking_config.include_thoughts=false` → silently ignored.
- top-level `google.thinking_config` → HTTP 400.
- `reasoning_effort:'none'` → honored but *disables thinking* (rejected: dumbs the model).

The committed heuristic (`isReasoningLeak`) is a content-shape guard. It can only
ever be a best-effort belt because leak vs. legitimately-truncated content are
structurally indistinguishable on the compat endpoint — which is exactly why the
Greptile gate kept flip-flopping on it.

The **native `@google/genai` SDK** honors `thinkingConfig.includeThoughts=false`
and tags thought parts with `part.thought===true`, so we can filter reasoning
natively. Thinking stays **on** (model stays fully smart); only the *returned*
thought parts are dropped. This is a transport change, not a content heuristic.

## Scope (blast radius = one non-default model)

- Route **`gemini-*` agent calls only** through the native adapter. Opus (the
  default), Azure GPT, Bedrock, and Vertex Claude keep their existing paths
  untouched.
- Non-agent Gemini uses of the compat client (`describe_image`, shadow-metered
  direct completions) are **left alone** — out of scope.

## Design

`backend/src/services/agentMode/core/geminiNativeClient.ts` — a pure, unit-tested
translation layer plus a DI-friendly client factory that presents the **same
OpenAI-shaped `client.chat.completions.create(params)` surface** the Vertex and
Bedrock adapters already present. `callLLM` and the agent loop are unchanged.

- `toGeminiRequest(openaiParams, opts)` → `{ model, contents, config }`
  - system messages → `config.systemInstruction`
  - user/assistant text → `contents` (`role: 'user' | 'model'`)
  - assistant `tool_calls` → `functionCall` parts
  - `tool` results → `functionResponse` parts; **`tool_call_id` → function name**
    resolved from prior assistant `tool_calls` (Gemini matches by name, not id)
  - image_url blocks → `inlineData` / fileData parts
  - tools → `functionDeclarations` (schema sanitized)
  - `response_format:{type:'json_object'}` → `responseMimeType:'application/json'`
    (only when no tools — Gemini rejects function-calling + JSON mode together)
  - always `thinkingConfig.includeThoughts=false` (**the leak fix**)
- `fromGeminiResponse(resp)` → OpenAI-shaped `{ choices:[{ message, finish_reason,
  stop_reason }], usage }`
  - `part.thought===true` parts are dropped
  - `functionCall` parts → `tool_calls`
  - `MAX_TOKENS` → `finish_reason:'length'`; a truncated tool call is dropped and
    reported as `length` (matches Vertex/Bedrock, feeds ENG-403 continuation)
  - `usageMetadata` → `usage`; `completion_tokens = candidatesTokenCount +
    thoughtsTokenCount` (thoughts are billed as output), `cache_read_input_tokens
    = cachedContentTokenCount`

## Kill-switch

`gemini_native_adapter_enabled` in `AW-Settings` (TTL-cached ~60s so it flips in
prod without redeploy) + `GEMINI_NATIVE_ADAPTER` env override. When **off**, gemini
falls back to the compat client and the ENG-737 `isReasoningLeak` heuristic still
guards leaks — belt-and-suspenders. Default: **on**.

## Residual risk / canary

The one thing not provable pre-merge is behavioral equivalence across every
multi-turn edge case (stateful history + parallel tool calls). That's what the
flag + a short prod canary are for — normal for a provider-transport change.

## Tests

- Pure translation: single + parallel tool calls, tool-result id→name mapping,
  system prompt, json mode, image content, MAX_TOKENS truncation, thought
  filtering, usage/thoughts mapping.
- Response translation from mocked Gemini payloads.
- Key-gated live test: real gemini-3.5-flash + real tool call round-trip.
