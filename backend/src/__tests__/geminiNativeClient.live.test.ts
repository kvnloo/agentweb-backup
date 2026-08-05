/**
 * LIVE native-@google/genai adapter test for ENG-737.
 *
 * The pure translation tests (geminiNativeClient.test.ts) prove the mapping LOGIC
 * against mocked payloads. This test guards the one thing a mock can never catch:
 * that the REAL gemini-3.5-flash native envelope still lines up with the adapter —
 *   - thinkingConfig.includeThoughts=false actually suppresses returned thought
 *     parts, so `content` is clean prose (the ENG-737 leak fix), and
 *   - a real functionDeclaration round-trips to a functionCall the adapter surfaces
 *     as OpenAI tool_calls, and usageMetadata maps to a non-zero usage.
 *
 * It hits the real API, so it is SKIPPED unless GEMINI_API_KEY is set (it is not in
 * CI). Run it manually with:
 *   GEMINI_API_KEY=$(aws secretsmanager get-secret-value \
 *     --secret-id dev/AgentWeb/GeminiAPIKey --query SecretString --output text) \
 *     npx jest src/__tests__/geminiNativeClient.live.test.ts
 */

import { createGeminiNativeClient } from '../services/agentMode/core/geminiNativeClient';

// A manual mock at src/__mocks__/@google/genai.js is auto-applied to this node
// module (it only stubs generateContentStream). This test needs the REAL SDK.
jest.unmock('@google/genai');

const GEMINI_KEY = process.env.GEMINI_API_KEY?.trim();
const describeLive = GEMINI_KEY ? describe : describe.skip;
const MODEL = 'gemini-3.5-flash';

describeLive('ENG-737 live native gemini adapter', () => {
  jest.setTimeout(90_000);

  const makeClient = () =>
    createGeminiNativeClient({
      defaultMaxTokens: 4000,
      getClient: async () => {
        const { GoogleGenAI } = await import('@google/genai');
        return new GoogleGenAI({ apiKey: GEMINI_KEY! }) as any;
      },
    });

  it('returns clean prose with no leaked chain-of-thought, and real usage', async () => {
    const client = makeClient();
    const res: any = await client.chat.completions.create({
      model: MODEL,
      messages: [
        { role: 'system', content: 'You are a research agent. Reason step by step before answering.' },
        { role: 'user', content: 'In one sentence, what does a US state legislature do?' },
      ],
    });
    const content: string = res.choices[0].message.content || '';
    expect(content.length).toBeGreaterThan(0);
    // No returned thought part → the first line is never a bare `thought` marker.
    expect(/^\s*thought\s*$/im.test(content.split('\n', 1)[0])).toBe(false);
    expect(res.usage.prompt_tokens).toBeGreaterThan(0);
    expect(res.usage.completion_tokens).toBeGreaterThan(0);
  });

  it('round-trips a real tool call as OpenAI tool_calls', async () => {
    const client = makeClient();
    const res: any = await client.chat.completions.create({
      model: MODEL,
      messages: [
        { role: 'user', content: 'Search the web for the current status of the Washington State Legislature. Use the web_search tool.' },
      ],
      tools: [{
        type: 'function',
        function: {
          name: 'web_search',
          description: 'Search the web for information',
          parameters: { type: 'object', properties: { query: { type: 'string', description: 'the search query' } }, required: ['query'] },
        },
      }],
      tool_choice: 'auto',
    });
    const choice = res.choices[0];
    if (choice.message.tool_calls) {
      expect(choice.finish_reason).toBe('tool_calls');
      expect(choice.message.tool_calls[0].function.name).toBe('web_search');
      // arguments must be valid JSON the loop can JSON.parse
      expect(() => JSON.parse(choice.message.tool_calls[0].function.arguments)).not.toThrow();
    } else {
      // The model may answer directly; either way content must be clean.
      expect(typeof choice.message.content).toBe('string');
    }
  });

  it('completes a stateful multi-turn tool loop (thoughtSignature round-trip)', async () => {
    const client = makeClient();
    const tools = [{
      type: 'function',
      function: {
        name: 'get_weather',
        description: 'Get current weather for a city',
        parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
      },
    }];
    const messages: any[] = [
      { role: 'user', content: 'What is the weather in Seattle? Use get_weather, then answer in one sentence.' },
    ];
    const r1: any = await client.chat.completions.create({ model: MODEL, messages, tools, tool_choice: 'auto' });
    // The model should call the tool; gemini-3.5-flash attaches a thoughtSignature
    // the adapter must capture so turn 2 does not 400.
    if (!r1.choices[0].message.tool_calls) {
      return; // rare: model answered directly — nothing to round-trip
    }
    const tc = r1.choices[0].message.tool_calls[0];
    expect(tc.thought_signature).toBeTruthy();

    messages.push({ role: 'assistant', content: r1.choices[0].message.content || '', tool_calls: r1.choices[0].message.tool_calls });
    messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify({ tempF: 58, conditions: 'light rain' }) });

    // Turn 2 must NOT 400 (missing thought_signature) and must use the tool result.
    const r2: any = await client.chat.completions.create({ model: MODEL, messages, tools, tool_choice: 'auto' });
    expect(r2.choices[0].finish_reason).toBe('stop');
    expect(r2.choices[0].message.content).toMatch(/58|rain/i);
  });

  // NOTE: a live test attempting to force a real SAFETY-blocked candidate (max
  // strictness on all 4 harm categories against a graphic prompt) was tried and
  // removed — the real API still answered normally (finishReason=STOP, all
  // safetyRatings NEGLIGIBLE) even at BLOCK_LOW_AND_ABOVE. Forcing a genuine block
  // deterministically isn't practical without escalating prompt content, which
  // isn't the right way to get this proof. The SAFETY/promptFeedback-block
  // backfill is covered at the unit level (geminiNativeClient.test.ts) against
  // Gemini's documented real finishReason/promptFeedback shapes instead.

  it('round-trips a real tool call whose schema carries x-aliases/oneOf/const (no 400)', async () => {
    // Proves sanitizeGeminiSchema's output is actually ACCEPTED by the real API,
    // not just structurally plausible against the mocked unit tests. Mirrors the
    // real prod shape (search_tool_response's x-aliases) plus the oneOf/const/allOf
    // shape a dynamically-discovered MCP tool schema could carry.
    const client = makeClient();
    const res: any = await client.chat.completions.create({
      model: MODEL,
      messages: [
        { role: 'user', content: 'Use the lookup_record tool to look up record "abc123" in mode "fast".' },
      ],
      tools: [{
        type: 'function',
        function: {
          name: 'lookup_record',
          description: 'Look up a record by id',
          parameters: {
            type: 'object',
            properties: {
              record_id: {
                type: 'string',
                'x-aliases': ['id', 'recordId', 'key'],
                description: 'The record id',
              },
              mode: {
                oneOf: [{ const: 'fast' }, { const: 'slow' }],
                description: 'Lookup mode',
              },
            },
            required: ['record_id'],
          },
        },
      }],
      tool_choice: 'auto',
    });
    // No ApiError thrown = the sanitized schema was accepted. Either a tool call
    // or a direct answer is fine; the only failure mode this guards is a 400.
    const choice = res.choices[0];
    if (choice.message.tool_calls) {
      expect(choice.message.tool_calls[0].function.name).toBe('lookup_record');
    } else {
      expect(typeof choice.message.content).toBe('string');
    }
  });

  it('accepts a third-party MCP schema carrying keywords no denylist covered (ENG-845)', async () => {
    // `browser_drop` from `@playwright/mcp` 0.0.78 — the playwright MCP server is
    // registered in the prod `mcp_servers` setting and its tools are passed through
    // to the model exactly as `tools/list` returns them (prod pins 0.0.70, which
    // predates this tool, so this covers the next bump). Under the old denylist this
    // 400'd live with `Unknown name "propertyNames"`, which would kill the whole turn
    // with zero assistant output. The extra draft-2020 keywords alongside it
    // (`examples`, `exclusiveMinimum`, `uniqueItems`) each 400 the same way.
    const client = makeClient();
    const res: any = await client.chat.completions.create({
      model: MODEL,
      messages: [{ role: 'user', content: 'Use browser_drop to drop the text "hello" onto the target "e5".' }],
      tools: [{
        type: 'function',
        function: {
          name: 'browser_drop',
          description: 'Drop data onto an element',
          parameters: {
            $schema: 'https://json-schema.org/draft/2020-12/schema',
            type: 'object',
            properties: {
              target: { type: 'string', description: 'Target element reference' },
              data: {
                description: 'Data to drop, as a map of MIME type to string value.',
                type: 'object',
                propertyNames: { type: 'string' },
                additionalProperties: { type: 'string' },
              },
              paths: { type: 'array', items: { type: 'string' }, uniqueItems: true },
              retries: { type: 'number', exclusiveMinimum: 0, examples: [1, 2] },
            },
            required: ['target'],
            additionalProperties: false,
          },
        },
      }],
      tool_choice: 'auto',
    });
    // No ApiError thrown = the sanitized schema was accepted by the real API.
    const choice = res.choices[0];
    if (choice.message.tool_calls) {
      expect(choice.message.tool_calls[0].function.name).toBe('browser_drop');
    } else {
      expect(typeof choice.message.content).toBe('string');
    }
  });

  it('sanitizes NESTED sub-schemas, not just the top level (ENG-845)', async () => {
    // `anyOf` is the one composition keyword the genai `Schema` models, so it survives
    // the allowlist — which makes its members model-facing and means they must be
    // sanitized too. Confirmed against this API: an unknown keyword nested inside an
    // `anyOf` member 400s the whole request exactly as a top-level one does —
    //   Unknown name "contentEncoding" at '...properties[0].value.any_of[0]'
    // and two levels down, through a member's own `properties` —
    //   Unknown name "propertyNames" at '...any_of[0].properties[0].value'
    // Both paths are covered here so the recursion can't silently regress to a
    // top-level-only filter, which would reopen the zero-assistant-output class.
    const client = makeClient();
    const res: any = await client.chat.completions.create({
      model: MODEL,
      messages: [{ role: 'user', content: 'Call store_payload with the string payload "v1".' }],
      tools: [{
        type: 'function',
        function: {
          name: 'store_payload',
          description: 'Store a payload supplied either as a string or as a structured object',
          parameters: {
            type: 'object',
            properties: {
              payload: {
                description: 'Either an encoded string or a structured record.',
                anyOf: [
                  { type: 'string', contentEncoding: 'base64', pattern: '^v\\d+$' },
                  { type: 'object', properties: { id: { type: 'string', propertyNames: { type: 'string' } } } },
                ],
              },
            },
            required: ['payload'],
          },
        },
      }],
      tool_choice: 'auto',
    });
    const choice = res.choices[0];
    if (choice.message.tool_calls) {
      expect(choice.message.tool_calls[0].function.name).toBe('store_payload');
    } else {
      expect(typeof choice.message.content).toBe('string');
    }
  });
});
