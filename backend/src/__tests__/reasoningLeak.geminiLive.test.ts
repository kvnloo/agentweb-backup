/**
 * LIVE Gemini envelope-contract test for the ENG-737 reasoning-leak guard.
 *
 * The pure detector (reasoningLeak.test.ts) and the mocked wiring
 * (agentModeService.reasoningLeak.test.ts) prove the LOGIC. This test guards the
 * one thing a mock can never catch: that the REAL gemini-3.5-flash response
 * envelope still exposes the exact fields `isReasoningLeak` reads —
 *   - `choices[0].finish_reason === 'length'` on a truncated turn, and
 *   - `choices[0].message.extra_content.google.thought_signature` on a thinking turn.
 * If a future Gemini / OpenAI-compat change moves or renames either field, the
 * guard would silently stop firing; this test fails loudly instead.
 *
 * It hits the real API, so it is SKIPPED unless GEMINI_API_KEY is set (it is not
 * in CI). Run it manually with:
 *   GEMINI_API_KEY=$(aws secretsmanager get-secret-value \
 *     --secret-id dev/AgentWeb/GeminiAPIKey --query SecretString --output text) \
 *     npx jest src/__tests__/reasoningLeak.geminiLive.test.ts
 *
 * Note: it does NOT try to force the actual thought-part leak — that is a rare,
 * non-deterministic degenerate state (in prod it followed 94K–190K-token
 * contexts). It asserts the field contract plus the critical safety property that
 * a LEGITIMATE truncated answer is never suppressed.
 */

import OpenAI from 'openai';
import { isReasoningLeak } from '../services/agentMode/core/reasoningLeak';

const GEMINI_KEY = process.env.GEMINI_API_KEY?.trim();
const describeLive = GEMINI_KEY ? describe : describe.skip;

const GEMINI_COMPAT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/';
const MODEL = 'gemini-3.5-flash';

describeLive('ENG-737 live gemini-3.5-flash envelope contract', () => {
  jest.setTimeout(60_000);

  let client: OpenAI;
  beforeAll(() => {
    client = new OpenAI({ apiKey: GEMINI_KEY!, baseURL: GEMINI_COMPAT_BASE_URL });
  });

  /** Force a truncated thinking turn: heavy-reasoning prompt with a tight token cap. */
  async function truncatedThinkingTurn(maxTokens: number): Promise<any> {
    const resp: any = await client.chat.completions.create({
      model: MODEL,
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: 'You are a research agent. Reason exhaustively, step by step, before answering.' },
        {
          role: 'user',
          content:
            'Find the exact 2027 legislative session convening date and full policy agenda for a ' +
            'specific obscure US state legislature, cross-checking many search queries and ' +
            'reconciling contradictions before answering.',
        },
      ],
    } as any);
    return resp;
  }

  it('a thinking turn carries a google thought_signature exactly where the guard reads it', async () => {
    const resp = await truncatedThinkingTurn(1200);
    const msg = resp.choices[0].message;
    // The guard's `hasThoughtSignature` reads this precise path.
    expect(msg?.extra_content?.google?.thought_signature).toBeTruthy();
  });

  it('a truncated turn reports finish_reason=length (the degenerate-loop gate) and never false-suppresses a legit answer', async () => {
    // Retry across a few caps until we observe a genuine length truncation carrying
    // a real-prose fragment (as opposed to an empty or filtered stop), then assert
    // the guard leaves that legitimate partial answer untouched.
    let sawLength = false;
    for (const cap of [1600, 2000, 2400]) {
      const resp = await truncatedThinkingTurn(cap);
      const choice = resp.choices[0];
      const content: string =
        typeof choice.message.content === 'string' ? choice.message.content : '';
      if (choice.finish_reason === 'length') {
        sawLength = true;
        // A real truncated answer fragment (no `thought` marker, no degenerate loop)
        // must NEVER be suppressed — this is the "don't blank real content" guarantee.
        if (content && !/^\s*thought\s*$/im.test(content.split('\n', 1)[0])) {
          expect(
            isReasoningLeak({
              finishReason: 'length',
              content,
              hasThoughtSignature: !!choice.message?.extra_content?.google?.thought_signature,
              model: MODEL,
            }),
          ).toBe(false);
        }
        break;
      }
    }
    // The provider must still expose 'length' as its truncation signal.
    expect(sawLength).toBe(true);
  });
});
