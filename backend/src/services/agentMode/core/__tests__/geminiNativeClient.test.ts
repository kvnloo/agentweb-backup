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
    expect(out.choices[0].message.tool_calls).toEqual([
      { id: 'call_web_search_0', type: 'function', function: { name: 'web_search', arguments: '{"q":"wa"}' } },
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

  it('returns null content (not empty tool_calls) on an empty/safety candidate', () => {
    const resp = { candidates: [{ finishReason: 'SAFETY', content: { parts: [] } }] };
    const out = fromGeminiResponse(resp);
    expect(out.choices[0].message.content).toBeNull();
    expect(out.choices[0].message).not.toHaveProperty('tool_calls');
    expect(out.choices[0].finish_reason).toBe('stop');
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
