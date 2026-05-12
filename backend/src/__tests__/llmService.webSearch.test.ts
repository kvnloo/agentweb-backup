/**
 * Bug regression: `generateJSONContentWithWebSearch` used to reach into
 * `chatModel.client`, but @langchain/openai v1.x no longer exposes the
 * underlying openai client through that property, so the v3 web-tier
 * extraction failed on every call and the toast claimed leads were
 * "enriched" with zero fields actually written. The fix bypasses LangChain
 * and calls Azure's Responses endpoint via raw HTTP.
 *
 * Tests stub global `fetch` so no real network call happens.
 */

import { LLMService } from '../utils/llmService';

function makeService(): LLMService {
  process.env.AZURE_OPENAI_API_KEY = 'test-key-xyz';
  process.env.AZURE_OPENAI_ENDPOINT = 'https://example.openai.azure.com';
  process.env.AZURE_OPENAI_RESPONSES_API_VERSION = '2025-03-01-preview';
  return new LLMService('gpt-5-chat-2', 0);
}

describe('LLMService.generateJSONContentWithWebSearch — Azure path', () => {
  const originalFetch = global.fetch;
  afterEach(() => { global.fetch = originalFetch; });

  it('POSTs to the Azure /openai/responses endpoint with web_search tool and parses output_text', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => '{"output_text":"{\\"company\\":\\"Acme\\",\\"funding\\":\\"$10M\\"}"}',
    });
    (global as any).fetch = fetchMock;

    const svc = makeService();
    const out = await svc.generateJSONContentWithWebSearch<{ company: string; funding: string }>(
      'sys-prompt', 'user-prompt',
    );

    expect(out).toEqual({ company: 'Acme', funding: '$10M' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      'https://example.openai.azure.com/openai/responses?api-version=2025-03-01-preview',
    );
    expect(init.method).toBe('POST');
    expect(init.headers['api-key']).toBe('test-key-xyz');
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({
      model: 'gpt-5-chat-2',
      instructions: 'sys-prompt',
      input: 'user-prompt',
      tools: [{ type: 'web_search' }],
    });
  });

  it('falls back to the output[].content[].text shape when output_text is absent', async () => {
    (global as any).fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({
        output: [
          { content: [{ text: '{"x":' }, { text: '"ok"}' }] },
        ],
      }),
    });

    const svc = makeService();
    const out = await svc.generateJSONContentWithWebSearch<{ x: string }>('s', 'u');
    expect(out).toEqual({ x: 'ok' });
  });

  it('surfaces a useful error on non-2xx response', async () => {
    (global as any).fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => '{"error":{"message":"bad api version"}}',
    });

    const svc = makeService();
    await expect(svc.generateJSONContentWithWebSearch('s', 'u')).rejects.toThrow(
      /Azure Responses API 400.*bad api version/,
    );
  });

  it('throws when AZURE_OPENAI_ENDPOINT / API_KEY are unset', async () => {
    const svc = makeService();
    delete process.env.AZURE_OPENAI_API_KEY;
    await expect(svc.generateJSONContentWithWebSearch('s', 'u')).rejects.toThrow(
      /AZURE_OPENAI_API_KEY and AZURE_OPENAI_ENDPOINT must be set/,
    );
  });

  it('strips a trailing slash from AZURE_OPENAI_ENDPOINT', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => '{"output_text":"{\\"ok\\":1}"}',
    });
    (global as any).fetch = fetchMock;
    process.env.AZURE_OPENAI_ENDPOINT = 'https://example.openai.azure.com/';

    const svc = makeService();
    await svc.generateJSONContentWithWebSearch('s', 'u');
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toBe(
      'https://example.openai.azure.com/openai/responses?api-version=2025-03-01-preview',
    );
  });
});
