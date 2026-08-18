/**
 * Characterization tests for the native @google/genai adapter (ENG-737).
 *
 * The risky part of a provider-transport change is the request<->response
 * translation for a stateful, tool-calling loop, so it lives in pure functions and
 * is pinned here: system prompt, single + parallel tool calls, tool-result id->name
 * mapping (Gemini matches by name, not id), image content, json mode, MAX_TOKENS
 * truncation, thought filtering (the leak fix), and usage/thoughts billing mapping.
 * No network and no real SDK — the client factory is exercised with a fake SDK.
 */

import {
  toGeminiRequest,
  fromGeminiResponse,
  sanitizeGeminiSchema,
  createGeminiNativeClient,
  type OpenAIChatParams,
} from '../geminiNativeClient';

const OPTS = { defaultMaxTokens: 32000 };

describe('toGeminiRequest', () => {
  it('routes system messages to systemInstruction and keeps user/assistant turns', () => {
    const params: OpenAIChatParams = {
      model: 'gemini-3.5-flash',
      messages: [
        { role: 'system', content: 'You are Emma.' },
        { role: 'system', content: 'Be concise.' },
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there' },
        { role: 'user', content: 'Bye' },
      ],
    };
    const req = toGeminiRequest(params, OPTS);
    expect(req.model).toBe('gemini-3.5-flash');
    expect(req.config.systemInstruction).toBe('You are Emma.\nBe concise.');
    expect(req.contents).toEqual([
      { role: 'user', parts: [{ text: 'Hello' }] },
      { role: 'model', parts: [{ text: 'Hi there' }] },
      { role: 'user', parts: [{ text: 'Bye' }] },
    ]);
  });

  it('sets a request timeout (default 5 min, override honored)', () => {
    const def = toGeminiRequest({ model: 'gemini-3.5-flash', messages: [{ role: 'user', content: 'hi' }] }, OPTS);
    expect(def.config.httpOptions).toEqual({ timeout: 5 * 60 * 1000 });

    const override = toGeminiRequest(
      { model: 'gemini-3.5-flash', messages: [{ role: 'user', content: 'hi' }] },
      { defaultMaxTokens: 32000, requestTimeoutMs: 1234 },
    );
    expect(override.config.httpOptions).toEqual({ timeout: 1234 });
  });

  it('guards an empty contents (system-only history) with a minimal user turn', () => {
    const req = toGeminiRequest(
      { model: 'gemini-3.5-flash', messages: [{ role: 'system', content: 'only system' }] },
      OPTS,
    );
    expect(req.config.systemInstruction).toBe('only system');
    expect(req.contents).toEqual([{ role: 'user', parts: [{ text: '.' }] }]);
  });

  it('always sets thinkingConfig.includeThoughts=false (the leak fix)', () => {
    const req = toGeminiRequest(
      { model: 'gemini-3.5-flash', messages: [{ role: 'user', content: 'hi' }] },
      OPTS,
    );
    expect(req.config.thinkingConfig).toEqual({ includeThoughts: false });
  });

  it('applies maxOutputTokens and temperature; falls back to defaultMaxTokens', () => {
    const withVals = toGeminiRequest(
      { model: 'gemini-3.5-flash', messages: [{ role: 'user', content: 'hi' }], max_completion_tokens: 100, temperature: 0.4 },
      OPTS,
    );
    expect(withVals.config.maxOutputTokens).toBe(100);
    expect(withVals.config.temperature).toBe(0.4);

    const noVals = toGeminiRequest(
      { model: 'gemini-3.5-flash', messages: [{ role: 'user', content: 'hi' }] },
      OPTS,
    );
    expect(noVals.config.maxOutputTokens).toBe(32000);
    expect(noVals.config).not.toHaveProperty('temperature');
  });

  it('translates a single assistant tool call to a functionCall part', () => {
    const params: OpenAIChatParams = {
      model: 'gemini-3.5-flash',
      messages: [
        { role: 'user', content: 'search' },
        {
          role: 'assistant',
          content: 'let me look',
          tool_calls: [{ id: 'call_1', type: 'function', thought_signature: 'SIG1', function: { name: 'web_search', arguments: '{"q":"wa legislature"}' } }],
        },
      ],
    };
    const req = toGeminiRequest(params, OPTS);
    // A signed tool call echoes its thoughtSignature (required by the thinking model).
    expect(req.contents[1]).toEqual({
      role: 'model',
      parts: [
        { text: 'let me look' },
        { functionCall: { name: 'web_search', args: { q: 'wa legislature' } }, thoughtSignature: 'SIG1' },
      ],
    });
  });

  it('maps a tool result back to its function NAME via tool_call_id (not id)', () => {
    const params: OpenAIChatParams = {
      model: 'gemini-3.5-flash',
      messages: [
        { role: 'user', content: 'search' },
        { role: 'assistant', content: '', tool_calls: [{ id: 'call_abc', type: 'function', thought_signature: 'S', function: { name: 'web_search', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'call_abc', content: '{"results":["a","b"]}' },
      ],
    };
    const req = toGeminiRequest(params, OPTS);
    const toolTurn = req.contents[req.contents.length - 1];
    expect(toolTurn.role).toBe('user');
    expect(toolTurn.parts[0]).toEqual({
      functionResponse: { name: 'web_search', response: { results: ['a', 'b'] } },
    });
  });

  it('wraps a non-object tool result in { result }', () => {
    const params: OpenAIChatParams = {
      model: 'gemini-3.5-flash',
      messages: [
        { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', thought_signature: 'S', function: { name: 'get_time', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'c1', content: 'plain text output' },
      ],
    };
    const req = toGeminiRequest(params, OPTS);
    const toolTurn = req.contents[req.contents.length - 1];
    expect(toolTurn.parts[0].functionResponse.response).toEqual({ result: 'plain text output' });
  });

  it('handles parallel tool calls and their results by name', () => {
    const params: OpenAIChatParams = {
      model: 'gemini-3.5-flash',
      messages: [
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            { id: 'c1', type: 'function', thought_signature: 'A', function: { name: 'search_a', arguments: '{"x":1}' } },
            { id: 'c2', type: 'function', thought_signature: 'B', function: { name: 'search_b', arguments: '{"y":2}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'c1', content: '{"ok":"a"}' },
        { role: 'tool', tool_call_id: 'c2', content: '{"ok":"b"}' },
      ],
    };
    const req = toGeminiRequest(params, OPTS);
    // assistant model turn carries BOTH functionCall parts, each with its signature
    expect(req.contents[0]).toEqual({
      role: 'model',
      parts: [
        { functionCall: { name: 'search_a', args: { x: 1 } }, thoughtSignature: 'A' },
        { functionCall: { name: 'search_b', args: { y: 2 } }, thoughtSignature: 'B' },
      ],
    });
    // both tool results merge into a single user turn, each keyed by name
    const toolTurn = req.contents[1];
    expect(toolTurn.role).toBe('user');
    expect(toolTurn.parts).toEqual([
      { functionResponse: { name: 'search_a', response: { ok: 'a' } } },
      { functionResponse: { name: 'search_b', response: { ok: 'b' } } },
    ]);
  });

  it('degrades an UNSIGNED (legacy/compat) tool call AND its result to text (no 400)', () => {
    const params: OpenAIChatParams = {
      model: 'gemini-3.5-flash',
      messages: [
        { role: 'user', content: 'weather?' },
        { role: 'assistant', content: '', tool_calls: [{ id: 'call_x', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Boston"}' } }] },
        { role: 'tool', tool_call_id: 'call_x', content: '{"tempF":41}' },
        { role: 'user', content: 'umbrella?' },
      ],
    };
    const req = toGeminiRequest(params, OPTS);
    // no functionCall / functionResponse parts anywhere — all degraded to text
    const allParts = req.contents.flatMap((c: any) => c.parts);
    expect(allParts.some((p: any) => 'functionCall' in p || 'functionResponse' in p)).toBe(false);
    const texts = allParts.map((p: any) => p.text);
    expect(texts).toContain('[Previously called get_weather({"city":"Boston"})]');
    expect(texts).toContain('[Result of get_weather: {"tempF":41}]');
  });

  // ENG-1054: Gemini signs only the FIRST functionCall part of a multi-call turn.
  // Treating `signed` per-call degraded 77 of 105 calls in the production session
  // into conversational text, which is what taught the model to reply with
  // transcribed tool output (and, once a payload was cut mid-JSON, with `}]`).
  // Verified live: unsigned parts alongside a signed sibling are ACCEPTED.
  it('keeps a MIXED-signature turn structural — only the first call is signed', () => {
    const params: OpenAIChatParams = {
      model: 'gemini-3.1-pro-preview',
      messages: [
        { role: 'user', content: 'pause both campaigns and list my knowledge bases' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            { id: 'c1', type: 'function', thought_signature: 'SIG1', function: { name: 'call_meta_marketing_api', arguments: '{"a":1}' } },
            { id: 'c2', type: 'function', function: { name: 'call_meta_marketing_api', arguments: '{"a":2}' } },
            { id: 'c3', type: 'function', function: { name: 'list_knowledge_base_files', arguments: '{}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'c1', content: '{"success":true}' },
        { role: 'tool', tool_call_id: 'c2', content: '{"success":true}' },
        { role: 'tool', tool_call_id: 'c3', content: '{"knowledge_bases":[]}' },
      ],
    };
    const req = toGeminiRequest(params, OPTS);
    const allParts = req.contents.flatMap((c: any) => c.parts);

    // All three calls stay structural; only the one Gemini signed carries a signature.
    const calls = allParts.filter((p: any) => 'functionCall' in p);
    expect(calls).toHaveLength(3);
    expect(calls[0].thoughtSignature).toBe('SIG1');
    expect(calls[1].thoughtSignature).toBeUndefined();
    expect(calls[2].thoughtSignature).toBeUndefined();

    // And all three results pair as functionResponse — none leak into the
    // conversation as `[Result of ...]` prose the model can transcribe back.
    expect(allParts.filter((p: any) => 'functionResponse' in p)).toHaveLength(3);
    expect(allParts.some((p: any) => typeof p.text === 'string' && p.text.startsWith('[Result of '))).toBe(false);
    expect(allParts.some((p: any) => typeof p.text === 'string' && p.text.startsWith('[Previously called '))).toBe(false);
  });

  it('translates tools to functionDeclarations with sanitized schemas', () => {
    const params: OpenAIChatParams = {
      model: 'gemini-3.5-flash',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{
        type: 'function',
        function: {
          name: 'web_search',
          description: 'search the web',
          parameters: { $schema: 'http://json-schema.org/draft-07/schema#', type: 'object', additionalProperties: false, properties: { q: { type: 'string' } }, required: ['q'] },
        },
      }],
    };
    const req = toGeminiRequest(params, OPTS);
    expect(req.config.tools).toEqual([{
      functionDeclarations: [{
        name: 'web_search',
        description: 'search the web',
        parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
      }],
    }]);
    // json mode must NOT be requested when tools are present
    expect(req.config).not.toHaveProperty('responseMimeType');
  });

  it('requests JSON mime type for json_object response_format only without tools', () => {
    const withoutTools = toGeminiRequest(
      { model: 'gemini-3.5-flash', messages: [{ role: 'user', content: 'hi' }], response_format: { type: 'json_object' } },
      OPTS,
    );
    expect(withoutTools.config.responseMimeType).toBe('application/json');

    const withTools = toGeminiRequest(
      {
        model: 'gemini-3.5-flash',
        messages: [{ role: 'user', content: 'hi' }],
        response_format: { type: 'json_object' },
        tools: [{ type: 'function', function: { name: 'f', parameters: { type: 'object' } } }],
      },
      OPTS,
    );
    expect(withTools.config).not.toHaveProperty('responseMimeType');
  });

  it('converts image_url content to inlineData / fileData parts', () => {
    const params: OpenAIChatParams = {
      model: 'gemini-3.5-flash',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'describe' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAB' } },
          { type: 'image_url', image_url: { url: 'https://example.com/a.png' } },
        ],
      }],
    };
    const req = toGeminiRequest(params, OPTS);
    expect(req.contents[0].parts).toEqual([
      { text: 'describe' },
      { inlineData: { mimeType: 'image/png', data: 'AAAB' } },
      { fileData: { fileUri: 'https://example.com/a.png' } },
    ]);
  });
});

describe('fromGeminiResponse', () => {
  it('joins text parts and drops thought parts (the leak fix)', () => {
    const resp = {
      candidates: [{
        index: 0,
        finishReason: 'STOP',
        content: {
          parts: [
            { thought: true, text: 'internal: I should search first...' },
            { text: 'The Washington State Legislature is ' },
            { text: 'currently in session.' },
          ],
        },
      }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 8, thoughtsTokenCount: 40, totalTokenCount: 58 },
    };
    const out = fromGeminiResponse(resp);
    expect(out.choices[0].message.content).toBe('The Washington State Legislature is currently in session.');
    expect(out.choices[0].message.content).not.toContain('internal:');
    expect(out.choices[0].finish_reason).toBe('stop');
  });

  it('folds thoughtsTokenCount into completion_tokens for billing', () => {
    const resp = {
      candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'hi' }] } }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 8, thoughtsTokenCount: 40, cachedContentTokenCount: 3, totalTokenCount: 58 },
    };
    const out = fromGeminiResponse(resp);
    expect(out.usage).toEqual({
      prompt_tokens: 10,
      completion_tokens: 48,
      total_tokens: 58,
      cache_read_input_tokens: 3,
      cache_creation_input_tokens: 0,
    });
  });

  it('surfaces functionCall parts as OpenAI tool_calls with finish_reason=tool_calls', () => {
    const resp = {
      candidates: [{
        finishReason: 'STOP',
        content: { parts: [{ functionCall: { name: 'web_search', args: { q: 'wa' } } }] },
      }],
    };
    const out = fromGeminiResponse(resp);
    expect(out.choices[0].finish_reason).toBe('tool_calls');
    // The id carries a random suffix so it stays unique across turns (ENG-1206),
    // so pin its shape rather than a literal value.
    expect(out.choices[0].message.tool_calls).toEqual([
      {
        id: expect.stringMatching(/^call_web_search_0_[0-9a-f]{8}$/),
        type: 'function',
        function: { name: 'web_search', arguments: '{"q":"wa"}' },
      },
    ]);
  });

  it('captures a functionCall thoughtSignature so it round-trips', () => {
    const resp = {
      candidates: [{
        finishReason: 'STOP',
        content: { parts: [{ functionCall: { name: 'web_search', args: { q: 'wa' } }, thoughtSignature: 'ErYCsig==' }] },
      }],
    };
    const out = fromGeminiResponse(resp);
    expect(out.choices[0].message.tool_calls[0].thought_signature).toBe('ErYCsig==');
  });

  it('maps MALFORMED_FUNCTION_CALL (budget spent thinking) to length, not an empty stop', () => {
    const resp = {
      candidates: [{ finishReason: 'MALFORMED_FUNCTION_CALL', content: { parts: [] } }],
      usageMetadata: { promptTokenCount: 42, candidatesTokenCount: 0, thoughtsTokenCount: 305, totalTokenCount: 410 },
    };
    const out = fromGeminiResponse(resp);
    // 'length' routes the loop into its bounded continuation path instead of
    // ending the turn on an empty answer (ENG-324/473/657 silent-zero class).
    expect(out.choices[0].finish_reason).toBe('length');
    expect(out.choices[0].message).not.toHaveProperty('tool_calls');
    // thinking tokens still billed as output
    expect(out.usage.completion_tokens).toBe(305);
  });

  it('reports MAX_TOKENS as finish_reason=length and content when no tool call', () => {
    const resp = {
      candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: 'partial answer that ran out' }] } }],
    };
    const out = fromGeminiResponse(resp);
    expect(out.choices[0].finish_reason).toBe('length');
    expect(out.choices[0].message.content).toBe('partial answer that ran out');
  });

  it('drops a truncated (MAX_TOKENS) tool call and reports length (ENG-403)', () => {
    const resp = {
      candidates: [{
        finishReason: 'MAX_TOKENS',
        content: { parts: [{ functionCall: { name: 'create_html_file', args: { content_draft: 'a huge' } } }] },
      }],
    };
    const out = fromGeminiResponse(resp);
    expect(out.choices[0].finish_reason).toBe('length');
    expect(out.choices[0].message.tool_calls).toBeUndefined();
  });

  it('backfills a neutral message (not a silent blank) on a SAFETY-blocked candidate', () => {
    // A null/empty content here would report finish_reason='stop' with nothing
    // to show — ending the whole agent turn on a silent blank reply (ENG-324/473/657).
    const resp = { candidates: [{ finishReason: 'SAFETY', content: { parts: [] } }] };
    const out = fromGeminiResponse(resp);
    expect(out.choices[0].message.content).toEqual(expect.stringContaining('SAFETY'));
    expect(out.choices[0].message).not.toHaveProperty('tool_calls');
    // 'content_filter' (not 'stop') — the SAME finish_reason Azure OpenAI already
    // reports for a blocked completion, which agentModeService.ts's termination
    // layer already has dedicated handling for, so this is recognized as a
    // content-filtered turn rather than an ordinary complete answer.
    expect(out.choices[0].finish_reason).toBe('content_filter');
  });

  it('backfills a neutral message on a prompt-level block (no candidates at all)', () => {
    const resp = { candidates: [], promptFeedback: { blockReason: 'PROHIBITED_CONTENT' } };
    const out = fromGeminiResponse(resp);
    expect(out.choices[0].message.content).toEqual(expect.stringContaining('PROHIBITED_CONTENT'));
    expect(out.choices[0].finish_reason).toBe('content_filter');
  });

  it('flags PARTIAL text cut short by a block finish, not a silent complete answer (Greptile P1)', () => {
    // The model started answering, then got cut off by a safety filter partway
    // through. Reporting this as an ordinary finish_reason='stop' would let the
    // agent loop's termination layer treat the partial fragment as a normal
    // complete answer instead of recognizing the content-filter condition.
    const resp = {
      candidates: [{
        finishReason: 'SAFETY',
        content: { parts: [{ text: 'Here is the beginning of the answer, but then' }] },
      }],
    };
    const out = fromGeminiResponse(resp);
    expect(out.choices[0].message.content).toContain('Here is the beginning of the answer, but then');
    expect(out.choices[0].message.content).toEqual(expect.stringContaining('SAFETY'));
    expect(out.choices[0].message.content).toEqual(expect.stringContaining('cut short'));
    expect(out.choices[0].finish_reason).toBe('content_filter');
  });
});

describe('sanitizeGeminiSchema', () => {
  it('strips unsupported keywords recursively but keeps the shape', () => {
    const input = {
      $schema: 'x',
      type: 'object',
      additionalProperties: false,
      properties: {
        nested: { type: 'object', additionalProperties: true, $defs: {}, properties: { a: { type: 'string', enum: ['x'] } } },
        list: { type: 'array', items: { $ref: '#/x', type: 'string' } },
      },
      required: ['nested'],
    };
    expect(sanitizeGeminiSchema(input)).toEqual({
      type: 'object',
      properties: {
        nested: { type: 'object', properties: { a: { type: 'string', enum: ['x'] } } },
        list: { type: 'array', items: { type: 'string' } },
      },
      required: ['nested'],
    });
  });

  it('strips x-* vendor-extension keywords (e.g. x-aliases) Gemini 400s on', () => {
    // Real prod shape from search_tool_response / read_tool_response: every
    // gemini-3.5-flash tool-calling turn 400'd in production until this was
    // stripped, because Gemini rejects unknown schema properties outright.
    const input = {
      type: 'object',
      properties: {
        s3_key: {
          type: 'string',
          'x-aliases': ['s3Key', 'key', 'file_key', 'storage_key', 'object_key'],
          description: 'The S3 key',
        },
      },
      required: ['s3_key'],
    };
    expect(sanitizeGeminiSchema(input)).toEqual({
      type: 'object',
      properties: {
        s3_key: { type: 'string', description: 'The S3 key' },
      },
      required: ['s3_key'],
    });
  });

  it('normalizes a union `type` array to a single Gemini type + nullable (ENG-826)', () => {
    // Real prod shape from emma/tools.ts (get_meta_ads_metrics.campaign_ids,
    // gmail send to/cc/bcc): a JSON-Schema union `type: ['array', 'string']`.
    // Gemini's function-declaration Schema.type is a SINGLE OpenAPI type — a
    // union array 400s the ENTIRE request the moment the tool is attached, so
    // every gemini-3.5-flash agent turn carrying such a tool failed with zero
    // assistant output (the ENG-826 silent-failure signature). 'array' is kept
    // when `items` is present so the element schema stays meaningful.
    const input = {
      type: 'object',
      properties: {
        campaign_ids: { type: ['array', 'string'], items: { type: 'string' }, minItems: 1 },
        note: { type: ['string', 'null'] },
      },
    };
    expect(sanitizeGeminiSchema(input)).toEqual({
      type: 'object',
      properties: {
        campaign_ids: { type: 'array', items: { type: 'string' }, minItems: 1 },
        note: { type: 'string', nullable: true },
      },
    });
  });

  it('drops array-only keywords when a union `type` resolves to a non-array type', () => {
    // A union with no `array` member resolves to a scalar and must not keep
    // array-only constraints (items/minItems/maxItems) — Gemini rejects those
    // on a non-array type.
    const input = { type: ['string', 'number'], items: { type: 'string' }, maxItems: 5 };
    expect(sanitizeGeminiSchema(input)).toEqual({ type: 'string' });
  });

  it('falls back to a scalar `string` for a degenerate union with no non-null member', () => {
    // The `nonNull[0] || 'string'` fallback (geminiNativeClient.ts): a `type: []`
    // (empty union) or `type: ['null']` (only null) has no resolvable member, so
    // it must default to a concrete Gemini type rather than leaving `type`
    // undefined/array — both of which Gemini rejects.
    expect(sanitizeGeminiSchema({ type: [] })).toEqual({ type: 'string' });
    expect(sanitizeGeminiSchema({ type: ['null'] })).toEqual({ type: 'string', nullable: true });
  });

  it('resolves an `object`/scalar union to `object` when the node carries `properties` (ENG-826)', () => {
    // A union that pairs `object` with a scalar and actually defines `properties`
    // (some MCP tools describe a payload this way) should collapse to `object` so
    // the nested shape stays meaningful — not to the scalar member. Array-only
    // keywords are irrelevant here and must not appear.
    const input = {
      type: ['object', 'string'],
      properties: { id: { type: 'string' } },
    };
    expect(sanitizeGeminiSchema(input)).toEqual({
      type: 'object',
      properties: { id: { type: 'string' } },
    });
  });

  it('does NOT force `object` for an object-union that lacks `properties`', () => {
    // Without sibling `properties`, `object` is not more faithful than the scalar,
    // so we fall to the first non-null member rather than inventing an empty object.
    expect(sanitizeGeminiSchema({ type: ['string', 'object'] })).toEqual({ type: 'string' });
  });

  it('drops oneOf/allOf/const (absent from the genai Schema type, e.g. dynamic MCP tool schemas)', () => {
    const input = {
      type: 'object',
      properties: {
        mode: { oneOf: [{ const: 'fast' }, { const: 'slow' }] },
        combined: { allOf: [{ type: 'string' }, { minLength: 1 }] },
      },
    };
    expect(sanitizeGeminiSchema(input)).toEqual({
      type: 'object',
      properties: {
        mode: {},
        combined: {},
      },
    });
  });

  it('drops `propertyNames` — the live @playwright/mcp browser_drop shape (ENG-845)', () => {
    // Verbatim `data` property of browser_drop from `@playwright/mcp` 0.0.78. The
    // playwright MCP server is registered in the prod `mcp_servers` setting; prod
    // currently resolves the pinned 0.0.70, which predates this tool, so this guards
    // the next version bump rather than a live break. Confirmed against the real API:
    // unsanitized, this schema 400s the ENTIRE request with
    //   Unknown name "propertyNames" at '...parameters.properties[1].value'
    // which is exactly the ENG-845 zero-assistant-output / null-token signature.
    const input = {
      type: 'object',
      properties: {
        data: {
          description: 'Data to drop, as a map of MIME type to string value.',
          type: 'object',
          propertyNames: { type: 'string' },
          additionalProperties: { type: 'string' },
        },
      },
      required: ['target'],
    };
    expect(sanitizeGeminiSchema(input)).toEqual({
      type: 'object',
      properties: {
        data: { description: 'Data to drop, as a map of MIME type to string value.', type: 'object' },
      },
      required: ['target'],
    });
  });

  it('drops every keyword outside the genai Schema field set, not just known-bad ones (ENG-845)', () => {
    // The sanitizer is an ALLOWLIST because Gemini rejects any unknown field
    // outright. Each keyword below was confirmed against the real API to 400 the
    // whole request; none of them was on the previous denylist. Third-party MCP tool
    // schemas are arbitrary input, so enumerating bad keywords can never be complete.
    const input = {
      type: 'object',
      properties: {
        a: { type: 'string', examples: ['x'], contentEncoding: 'base64', readOnly: true },
        b: { type: 'number', exclusiveMinimum: 0, exclusiveMaximum: 10, multipleOf: 2 },
        c: { type: 'array', items: { type: 'string' }, uniqueItems: true, contains: { type: 'string' } },
        d: { type: 'string', deprecated: true, not: { const: 'x' }, $comment: 'note' },
      },
    };
    expect(sanitizeGeminiSchema(input)).toEqual({
      type: 'object',
      properties: {
        a: { type: 'string' },
        b: { type: 'number' },
        c: { type: 'array', items: { type: 'string' } },
        d: { type: 'string' },
      },
    });
  });

  it('never filters property NAMES that collide with schema keywords (ENG-845)', () => {
    // `properties` maps NAMES to schemas, so the keyword filter must not be applied
    // to its keys. A tool with a parameter literally called `const`, `not` or
    // `additionalProperties` (legal, and present in real third-party MCP schemas)
    // would otherwise have that parameter silently deleted from its declaration —
    // the model then can never supply it.
    const input = {
      type: 'object',
      properties: {
        const: { type: 'string' },
        not: { type: 'string' },
        additionalProperties: { type: 'boolean' },
        'x-request-id': { type: 'string' },
      },
      required: ['const'],
    };
    expect(sanitizeGeminiSchema(input)).toEqual({
      type: 'object',
      properties: {
        const: { type: 'string' },
        not: { type: 'string' },
        additionalProperties: { type: 'boolean' },
        'x-request-id': { type: 'string' },
      },
      required: ['const'],
    });
  });

  it('collapses a draft-07 tuple `items` array to its first schema (ENG-845)', () => {
    // Gemini's `items` is a SINGLE Schema; a tuple array 400s with
    // `Unknown name "0" at '...value.items'`. Keep the first element so the
    // parameter stays usable rather than dropping `items` entirely.
    const input = { type: 'object', properties: { pair: { type: 'array', items: [{ type: 'string' }, { type: 'number' }] } } };
    expect(sanitizeGeminiSchema(input)).toEqual({
      type: 'object',
      properties: { pair: { type: 'array', items: { type: 'string' } } },
    });
  });

  it('recurses into `anyOf` members so a nested bad keyword is stripped too (ENG-845)', () => {
    // `anyOf` is the one composition keyword Gemini's `Schema` DOES model, so it
    // survives the allowlist — which means its MEMBERS are still model-facing and
    // must themselves be sanitized. A member carrying an unknown keyword would
    // otherwise 400 the whole request exactly as a top-level one does.
    const input = {
      type: 'object',
      properties: {
        payload: {
          anyOf: [
            { type: 'string', pattern: '^v\\d+$', contentEncoding: 'base64' },
            { type: 'object', properties: { id: { type: 'string', readOnly: true } }, additionalProperties: false },
          ],
        },
      },
    };
    expect(sanitizeGeminiSchema(input)).toEqual({
      type: 'object',
      properties: {
        payload: {
          anyOf: [
            { type: 'string', pattern: '^v\\d+$' },
            { type: 'object', properties: { id: { type: 'string' } } },
          ],
        },
      },
    });
  });

  it('always emits `items` for an array — Gemini 400s without it (ENG-845)', () => {
    // Confirmed against the real API: `{ type: 'array' }` alone fails the whole request
    // with `properties[a].items: missing field`. Three paths can strip it — a degenerate
    // tuple, a schema that never declared `items`, and depth/cycle truncation — so the
    // fallback is applied last, after the union collapse has settled the final type.
    expect(sanitizeGeminiSchema({ type: 'object', properties: { a: { type: 'array', items: [] } } }))
      .toEqual({ type: 'object', properties: { a: { type: 'array', items: { type: 'string' } } } });
    expect(sanitizeGeminiSchema({ type: 'object', properties: { a: { type: 'array', minItems: 1 } } }))
      .toEqual({ type: 'object', properties: { a: { type: 'array', minItems: 1, items: { type: 'string' } } } });
    // A union collapsing to `array` must get the fallback too.
    expect(sanitizeGeminiSchema({ type: 'object', properties: { a: { type: ['array', 'string'] } } }))
      .toEqual({ type: 'object', properties: { a: { type: 'array', items: { type: 'string' } } } });
    // A real `items` is never overwritten.
    expect(sanitizeGeminiSchema({ type: 'array', items: { type: 'number' } }))
      .toEqual({ type: 'array', items: { type: 'number' } });
  });

  it('salvages a real element type from prefixItems/contains before guessing (ENG-845)', () => {
    // An invented element type is a lie the model acts on — told an array-of-objects is
    // an array-of-strings it sends strings, execute() rejects them against the ORIGINAL
    // schema, and the user sees a tool error. `prefixItems` (the draft-2020 tuple form,
    // used by @playwright/mcp and friends) and `contains` both describe the element and
    // are dropped by the allowlist, so we read them off the input before falling back.
    expect(sanitizeGeminiSchema({
      type: 'array',
      prefixItems: [{ type: 'object', properties: { id: { type: 'string' } } }],
    })).toEqual({ type: 'array', items: { type: 'object', properties: { id: { type: 'string' } } } });

    expect(sanitizeGeminiSchema({ type: 'array', contains: { type: 'number' } }))
      .toEqual({ type: 'array', items: { type: 'number' } });

    // A donor that sanitizes to something Gemini still can't use falls through to the guess.
    expect(sanitizeGeminiSchema({ type: 'array', contains: { readOnly: true } }))
      .toEqual({ type: 'array', items: { type: 'string' } });
  });

  it('reports a degraded schema once, and stays silent on a clean one (ENG-845)', () => {
    // Silence is what made the original ENG-845 failure expensive to find, so every
    // degradation is surfaced — but aggregated, or a pathological schema would emit a
    // line per node.
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      sanitizeGeminiSchema({ type: 'object', properties: { a: { type: 'array', items: { type: 'number' } } } });
      expect(warn).not.toHaveBeenCalled();

      sanitizeGeminiSchema({
        type: 'object',
        properties: { a: { type: 'array' }, b: { type: 'array' }, c: { type: 'array', contains: { type: 'number' } } },
      });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        'Gemini schema sanitizer degraded a tool schema:',
        expect.objectContaining({ guessedArrayItems: 2, salvagedArrayItems: 1, truncatedNodes: 0 }),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('truncates a self-referencing schema instead of overflowing the stack (ENG-845)', () => {
    // A dereferenced $ref or a hand-built circular object would recurse forever and take
    // the worker down mid-turn — the very zero-assistant-output signature this fixes.
    const cyclic: any = { type: 'object', properties: { name: { type: 'string' } } };
    cyclic.properties.self = cyclic;
    expect(sanitizeGeminiSchema(cyclic)).toEqual({
      type: 'object',
      properties: { name: { type: 'string' }, self: { type: 'object' } },
    });

    // Mutual recursion (A -> B -> A) must terminate too.
    const a: any = { type: 'object', properties: {} };
    const b: any = { type: 'object', properties: { back: a } };
    a.properties.fwd = b;
    expect(sanitizeGeminiSchema(a)).toEqual({
      type: 'object',
      properties: { fwd: { type: 'object', properties: { back: { type: 'object' } } } },
    });
  });

  it('truncates a cycle reached through `items` or `anyOf`, not just `properties` (ENG-845)', () => {
    // Each schema-bearing key has its own truncation branch, so each needs its own
    // cycle. An array whose element type is itself, and a union with itself as a member,
    // are both reachable from a dereferenced $ref in a generated schema.
    const cyclicArray: any = { type: 'array' };
    cyclicArray.items = cyclicArray;
    // The truncated leaf is an array, so the items fallback applies — never a bare
    // `{ type: 'array' }`, which Gemini rejects outright.
    expect(sanitizeGeminiSchema(cyclicArray)).toEqual({
      type: 'array',
      items: { type: 'array', items: { type: 'string' } },
    });

    const cyclicUnion: any = { type: 'object', properties: { v: { type: 'string' } } };
    cyclicUnion.anyOf = [cyclicUnion];
    expect(sanitizeGeminiSchema(cyclicUnion)).toEqual({
      type: 'object',
      properties: { v: { type: 'string' } },
      anyOf: [{ type: 'object' }],
    });
  });

  it('expands a schema object SHARED between siblings in both branches (ENG-845)', () => {
    // Cycle detection tracks ANCESTRY, not every object ever seen — otherwise a shared
    // sub-schema (common in generated schemas) would be truncated in whichever branch
    // happened to be visited second.
    const shared = { type: 'string', description: 'shared' };
    expect(sanitizeGeminiSchema({ type: 'object', properties: { x: shared, y: shared } })).toEqual({
      type: 'object',
      properties: { x: { type: 'string', description: 'shared' }, y: { type: 'string', description: 'shared' } },
    });
  });

  it('caps nesting depth below the limit Gemini itself enforces (ENG-845)', () => {
    // Gemini rejects beyond `Message recursion depth exceeds maximum of 64`, counted in
    // protobuf messages — an object level costs two. Measured live: 30-deep objects fail,
    // 25 passes. We cap at 20 so a pathological schema truncates instead of 400ing.
    let deep: any = { type: 'string' };
    for (let i = 0; i < 300; i++) deep = { type: 'object', properties: { n: deep } };
    let node = sanitizeGeminiSchema(deep);
    let levels = 0;
    while (node?.properties?.n) { node = node.properties.n; levels++; }
    expect(levels).toBe(20);
    expect(node).toEqual({ type: 'object' });
  });

  it('passes `default`/`example` instance values through untouched', () => {
    // These hold literal INSTANCE data, not sub-schemas, so the keyword filter must
    // not be applied to their contents — Gemini accepts an arbitrary object there.
    const input = {
      type: 'object',
      properties: {
        cfg: { type: 'object', properties: { mode: { type: 'string' } }, default: { mode: 'fast', const: 1 } },
        tag: { type: 'string', example: 'beta' },
      },
    };
    expect(sanitizeGeminiSchema(input)).toEqual({
      type: 'object',
      properties: {
        cfg: { type: 'object', properties: { mode: { type: 'string' } }, default: { mode: 'fast', const: 1 } },
        tag: { type: 'string', example: 'beta' },
      },
    });
  });
});

describe('createGeminiNativeClient (end-to-end wiring)', () => {
  it('translates request, calls the SDK, and returns an OpenAI-shaped response', async () => {
    const calls: any[] = [];
    const fakeSdk = {
      models: {
        generateContent: async (args: any) => {
          calls.push(args);
          return {
            candidates: [{ finishReason: 'STOP', content: { parts: [{ thought: true, text: 'secret' }, { text: 'clean answer' }] } }],
            usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3, thoughtsTokenCount: 7, totalTokenCount: 15 },
          };
        },
      },
    };
    const client = createGeminiNativeClient({ getClient: async () => fakeSdk, defaultMaxTokens: 32000 });
    const res = await client.chat.completions.create({
      model: 'gemini-3.5-flash',
      messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'q' }],
    });

    // request was translated
    expect(calls).toHaveLength(1);
    expect(calls[0].config.thinkingConfig).toEqual({ includeThoughts: false });
    expect(calls[0].config.systemInstruction).toBe('sys');
    // response was translated + thought filtered
    expect(res.choices[0].message.content).toBe('clean answer');
    expect(res.usage.completion_tokens).toBe(10);
  });
});

/**
 * ENG-1206 — synthesised tool-call ids must be unique for the life of a session.
 *
 * Gemini returns no tool-call id, so the adapter mints one. It used to be
 * `call_{name}_{indexWithinThisResponse}`, and that index resets every turn — so
 * turn 2's first `get_leads` reused turn 1's id. `toolDispatch` stores an
 * offloaded tool response at `tool-responses/{sessionId}/{toolCall.id}.txt`, so
 * the collision silently overwrote the earlier page in S3 (prod session
 * d5898ffd, where page 2 destroyed page 1 and the follow-up read 404'd).
 */
describe('fromGeminiResponse — tool-call id uniqueness (ENG-1206)', () => {
  const respWith = (names: string[]) => ({
    candidates: [{
      finishReason: 'STOP',
      content: { parts: names.map((name) => ({ functionCall: { name, args: {} } })) },
    }],
  });
  const idsOf = (resp: any) =>
    fromGeminiResponse(resp).choices[0].message.tool_calls.map((tc: any) => tc.id);

  it('does not reuse an id across separate responses (the collision)', () => {
    const turn1 = idsOf(respWith(['get_leads']));
    const turn2 = idsOf(respWith(['get_leads']));
    expect(turn1[0]).not.toEqual(turn2[0]);
  });

  it('keeps ids distinct within a single response', () => {
    const ids = idsOf(respWith(['get_leads', 'get_leads', 'search_leads']));
    expect(new Set(ids).size).toBe(3);
  });

  it('stays unique across many turns of the identical call', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) seen.add(idsOf(respWith(['get_leads']))[0]);
    expect(seen.size).toBe(50);
  });

  it('still carries the tool name so ids stay debuggable', () => {
    expect(idsOf(respWith(['get_leads']))[0]).toMatch(/^call_get_leads_/);
  });

  it('is safe to use as an S3 object key', () => {
    // The id becomes a filename in `tool-responses/{sessionId}/{id}.txt`.
    for (const id of idsOf(respWith(['get_leads', 'perform_data_analysis']))) {
      expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it('round-trips: a tool result still maps back to its call name', () => {
    const out = fromGeminiResponse(respWith(['web_search']));
    const call = out.choices[0].message.tool_calls[0];
    const req = toGeminiRequest({
      messages: [
        { role: 'assistant', content: '', tool_calls: [{ ...call, thought_signature: 'SIG' }] },
        { role: 'tool', tool_call_id: call.id, content: '{"results":["a"]}' },
      ],
    } as OpenAIChatParams, OPTS);
    const fnResp = req.contents.flatMap((c: any) => c.parts).find((p: any) => p.functionResponse);
    expect(fnResp.functionResponse.name).toBe('web_search');
  });
});
