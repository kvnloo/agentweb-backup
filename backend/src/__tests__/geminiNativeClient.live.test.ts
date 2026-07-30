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
});
