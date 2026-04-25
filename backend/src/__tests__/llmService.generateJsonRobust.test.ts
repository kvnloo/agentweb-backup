/**
 * Tests for `LLMService.generateJsonRobust` — the retry-once + strict-suffix
 * wrapper that replaces `generateJSONContent` in the onboarding pipeline.
 *
 * We swap the internal `chatModel.invoke` with a stub so no real Bedrock /
 * Azure call is made.
 */

import { LLMService } from '../utils/llmService';
import { JsonExtractError } from '../services/util/extractJson';

// Avoid constructing the real Azure / Bedrock chat model in tests.
function makeService(invokeImpl: jest.Mock): LLMService {
  process.env.AZURE_OPENAI_API_KEY = 'test';
  process.env.AZURE_OPENAI_ENDPOINT = 'https://example.openai.azure.com';
  const svc = new LLMService('gpt-4', 0.5, 1000);
  // Replace the internal chat model with a stub.
  (svc as any).chatModel = { invoke: invokeImpl };
  return svc;
}

describe('LLMService.generateJsonRobust', () => {
  it('returns parsed JSON on first valid response', async () => {
    const invoke = jest.fn().mockResolvedValueOnce({
      content: '{"a":1,"b":"two"}',
      usage_metadata: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    });
    const svc = makeService(invoke);
    const out = await svc.generateJsonRobust<{ a: number; b: string }>(
      'sys',
      'user',
    );
    expect(out).toEqual({ a: 1, b: 'two' });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('strips markdown fences and parses', async () => {
    const invoke = jest.fn().mockResolvedValueOnce({
      content: '```json\n{"x":42}\n```',
    });
    const svc = makeService(invoke);
    const out = await svc.generateJsonRobust<{ x: number }>('sys', 'user');
    expect(out).toEqual({ x: 42 });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('extracts JSON from a prose preamble without retry', async () => {
    const invoke = jest.fn().mockResolvedValueOnce({
      content: 'It looks like you want this: {"icps":[{"name":"P1"}]}',
    });
    const svc = makeService(invoke);
    const out = await svc.generateJsonRobust<{ icps: Array<{ name: string }> }>(
      'sys',
      'user',
    );
    expect(out).toEqual({ icps: [{ name: 'P1' }] });
    // No retry — balanced-brace extraction succeeded on first attempt.
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('retries once with strict suffix when the first response is unparseable', async () => {
    const invoke = jest
      .fn()
      .mockResolvedValueOnce({
        content: 'I cannot generate JSON for this request.',
      })
      .mockResolvedValueOnce({
        content: '{"ok":true}',
      });
    const svc = makeService(invoke);
    const out = await svc.generateJsonRobust<{ ok: boolean }>('sys', 'user');
    expect(out).toEqual({ ok: true });
    expect(invoke).toHaveBeenCalledTimes(2);
    // Retry should have been called with a stricter system prompt
    const secondCall = invoke.mock.calls[1][0];
    const systemContent = String(secondCall[0]?.content || '');
    expect(systemContent).toContain('valid JSON');
  });

  it('throws JsonExtractError with raw snippet when both attempts fail', async () => {
    const invoke = jest
      .fn()
      .mockResolvedValueOnce({ content: 'Sorry, I cannot do that.' })
      .mockResolvedValueOnce({ content: 'Still cannot do it. Final answer.' });
    const svc = makeService(invoke);

    let caught: unknown = null;
    try {
      await svc.generateJsonRobust('sys', 'user');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(JsonExtractError);
    const e = caught as JsonExtractError;
    expect(e.rawSnippet.length).toBeGreaterThan(0);
    expect(e.rawSnippet.length).toBeLessThanOrEqual(500);
    // Snippet should come from the retry response (the more recent breadcrumb).
    expect(e.rawSnippet).toContain('Still cannot');
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry on non-extraction errors (e.g. network)', async () => {
    const invoke = jest
      .fn()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const svc = makeService(invoke);

    await expect(
      svc.generateJsonRobust('sys', 'user'),
    ).rejects.toThrow('ECONNREFUSED');
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('invokes the usage callback on every call', async () => {
    const invoke = jest
      .fn()
      .mockResolvedValueOnce({
        content: 'prose only',
        usage_metadata: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      })
      .mockResolvedValueOnce({
        content: '{"ok":true}',
        usage_metadata: { input_tokens: 8, output_tokens: 3, total_tokens: 11 },
      });
    const svc = makeService(invoke);
    const usage = jest.fn();
    const out = await svc.generateJsonRobust<{ ok: boolean }>(
      'sys',
      'user',
      usage,
    );
    expect(out).toEqual({ ok: true });
    expect(usage).toHaveBeenCalledTimes(2);
    expect(usage.mock.calls[0][0].totalTokens).toBe(15);
    expect(usage.mock.calls[1][0].totalTokens).toBe(11);
  });
});
