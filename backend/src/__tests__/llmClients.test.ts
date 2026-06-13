/**
 * Tests for the metered LLM client factory (utils/llmClients.ts).
 *
 * Core guarantees under test:
 *  - the SDK response is returned UNMODIFIED (same object identity)
 *  - usage is normalized per provider shape and recordUsage fires
 *  - metering failures never propagate to the caller
 *  - streaming without capturable usage records a "streaming-no-usage" note
 */

jest.mock('openai', () => {
  const MockOpenAI = jest.fn().mockImplementation(() => ({
    chat: { completions: { create: jest.fn() } },
    embeddings: { create: jest.fn() },
  }));
  return { __esModule: true, default: MockOpenAI };
});

jest.mock('@aws-sdk/client-bedrock-runtime', () => {
  class ConverseCommand {
    input: any;
    constructor(input: any) {
      this.input = input;
    }
  }
  class ConverseStreamCommand {
    input: any;
    constructor(input: any) {
      this.input = input;
    }
  }
  const BedrockRuntimeClient = jest.fn().mockImplementation(() => ({
    send: jest.fn(),
  }));
  return { BedrockRuntimeClient, ConverseCommand, ConverseStreamCommand };
});

jest.mock('@google/genai', () => {
  const GoogleGenAI = jest.fn().mockImplementation(() => ({
    models: {
      generateContent: jest.fn(),
      generateContentStream: jest.fn(),
    },
  }));
  return { GoogleGenAI };
});

jest.mock('../services/usageRecorderService', () => ({
  recordUsage: jest.fn().mockResolvedValue(undefined),
}));

import { recordUsage } from '../services/usageRecorderService';
import {
  getOpenAIClient,
  getAzureClient,
  getBedrockClient,
  getGeminiClient,
  normalizeOpenAIUsage,
  normalizeBedrockUsage,
  normalizeGeminiUsage,
  normalizeEmbeddingsUsage,
  bedrockModelIdFromArn,
} from '../utils/llmClients';

const mockRecordUsage = recordUsage as jest.Mock;

const meterCtx = { userId: 'user-1', feature: 'chat', sessionId: 'sess-1' };

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('llmClients normalizers', () => {
  it('normalizes OpenAI chat usage including cached prompt tokens', () => {
    expect(
      normalizeOpenAIUsage({
        prompt_tokens: 100,
        completion_tokens: 25,
        prompt_tokens_details: { cached_tokens: 40 },
        completion_tokens_details: { reasoning_tokens: 5 },
      })
    ).toEqual({ inputTokens: 100, outputTokens: 25, cacheReadTokens: 40 });
  });

  it('normalizes Bedrock converse usage including cache fields', () => {
    expect(
      normalizeBedrockUsage({
        inputTokens: 11,
        outputTokens: 22,
        cacheReadInputTokens: 3,
        cacheWriteInputTokens: 4,
      })
    ).toEqual({ inputTokens: 11, outputTokens: 22, cacheReadTokens: 3, cacheWriteTokens: 4 });
  });

  it('normalizes Gemini usageMetadata', () => {
    expect(
      normalizeGeminiUsage({
        promptTokenCount: 9,
        candidatesTokenCount: 18,
        cachedContentTokenCount: 2,
      })
    ).toEqual({ inputTokens: 9, outputTokens: 18, cacheReadTokens: 2 });
  });

  it('normalizes embeddings usage with outputTokens 0', () => {
    expect(normalizeEmbeddingsUsage({ prompt_tokens: 50, total_tokens: 50 })).toEqual({
      inputTokens: 50,
      outputTokens: 0,
    });
  });

  it('handles missing usage fields without throwing', () => {
    expect(normalizeOpenAIUsage(undefined)).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
    });
    expect(normalizeBedrockUsage(null)).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  });

  it('coerces falsy/zero OpenAI usage fields and a missing cache-details object to 0', () => {
    // present-but-falsy numeric fields (the `|| 0` falsy side) + cached_tokens
    // resolved through prompt_tokens_details that exists but lacks cached_tokens
    expect(
      normalizeOpenAIUsage({
        prompt_tokens: 0,
        completion_tokens: 0,
        prompt_tokens_details: {},
      })
    ).toEqual({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 });
    // prompt_tokens_details entirely absent -> optional-chain short-circuits to undefined -> 0
    expect(normalizeOpenAIUsage({ prompt_tokens: 5, completion_tokens: 3 })).toEqual({
      inputTokens: 5,
      outputTokens: 3,
      cacheReadTokens: 0,
    });
  });

  it('coerces a missing/undefined embeddings usage to 0 input tokens', () => {
    expect(normalizeEmbeddingsUsage(undefined)).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(normalizeEmbeddingsUsage({ prompt_tokens: 0 })).toEqual({
      inputTokens: 0,
      outputTokens: 0,
    });
  });

  it('coerces falsy/zero Bedrock usage fields to 0', () => {
    expect(
      normalizeBedrockUsage({
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheWriteInputTokens: 0,
      })
    ).toEqual({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
  });

  it('coerces missing/zero Gemini usageMetadata fields to 0', () => {
    expect(normalizeGeminiUsage(undefined)).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
    });
    expect(
      normalizeGeminiUsage({
        promptTokenCount: 0,
        candidatesTokenCount: 0,
        cachedContentTokenCount: 0,
      })
    ).toEqual({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 });
  });

  it('strips Bedrock inference-profile ARNs down to the bare model id', () => {
    expect(
      bedrockModelIdFromArn(
        'arn:aws:bedrock:us-west-2:992382574572:inference-profile/global.anthropic.claude-sonnet-4-6'
      )
    ).toBe('anthropic.claude-sonnet-4-6');
    expect(bedrockModelIdFromArn('anthropic.claude-opus-4-8')).toBe('anthropic.claude-opus-4-8');
    expect(bedrockModelIdFromArn(undefined)).toBe('unknown');
  });
});

describe('getOpenAIClient / getAzureClient', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRecordUsage.mockResolvedValue(undefined);
  });

  it('returns the SDK response UNMODIFIED and records normalized usage', async () => {
    const client: any = getOpenAIClient(meterCtx, { apiKey: 'k' });
    const sdkResponse = {
      id: 'cmpl-1',
      model: 'gpt-5-chat-2',
      usage: { prompt_tokens: 100, completion_tokens: 30 },
      choices: [{ message: { content: 'hi' } }],
    };
    const result = await wrapAndCall(client, sdkResponse);
    expect(result).toBe(sdkResponse); // identity — unmodified

    await flush();
    expect(mockRecordUsage).toHaveBeenCalledTimes(1);
    expect(mockRecordUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        provider: 'openai',
        feature: 'chat',
        model: 'gpt-5-chat-2',
        inputTokens: 100,
        outputTokens: 30,
        sessionId: 'sess-1',
      })
    );
  });

  it('records streaming calls with a streaming-no-usage note and returns the stream untouched', async () => {
    const client: any = getOpenAIClient(meterCtx, { apiKey: 'k' });
    const fakeStream = { [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }) };
    setUnderlyingResolution(client, fakeStream);

    const result = client.chat.completions.create({ model: 'gpt-5-chat-2', stream: true });
    expect(await result).toBe(fakeStream);

    await flush();
    expect(mockRecordUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        feature: 'chat:streaming-no-usage',
        inputTokens: 0,
        outputTokens: 0,
        model: 'gpt-5-chat-2',
      })
    );
  });

  it('propagates LLM errors unchanged and stays silent on metering', async () => {
    const client: any = getOpenAIClient(meterCtx, { apiKey: 'k' });
    setUnderlyingRejection(client, new Error('rate limited'));

    await expect(client.chat.completions.create({ model: 'gpt-5-chat-2' })).rejects.toThrow(
      'rate limited'
    );
    await flush();
    expect(mockRecordUsage).not.toHaveBeenCalled();
  });

  it('wraps chat even when the client exposes no embeddings surface', async () => {
    // Some SDK shapes / test doubles only implement chat.completions. Wrapping
    // must not throw on the missing embeddings surface, and chat stays metered.
    const OpenAICtor = jest.requireMock('openai').default as jest.Mock;
    const chatCreate = jest
      .fn()
      .mockResolvedValue({ model: 'gpt-5-chat-2', usage: { prompt_tokens: 3, completion_tokens: 2 } });
    OpenAICtor.mockImplementationOnce(() => ({ chat: { completions: { create: chatCreate } } }));

    const client: any = getAzureClient(meterCtx, 'gpt-5-chat-2');
    expect(client.embeddings).toBeUndefined();

    await client.chat.completions.create({ model: 'gpt-5-chat-2' });
    await flush();
    expect(mockRecordUsage).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'azure-openai', inputTokens: 3, outputTokens: 2 })
    );
  });

  it('never lets a recordUsage failure break the LLM call', async () => {
    mockRecordUsage.mockImplementation(() => {
      throw new Error('recorder exploded');
    });
    const client: any = getOpenAIClient(meterCtx, { apiKey: 'k' });
    const sdkResponse = { model: 'gpt-5-chat-2', usage: { prompt_tokens: 1, completion_tokens: 1 } };
    setUnderlyingResolution(client, sdkResponse);

    const result = await client.chat.completions.create({ model: 'gpt-5-chat-2' });
    expect(result).toBe(sdkResponse);
    await flush();
  });

  it('records embeddings usage with outputTokens 0', async () => {
    const client: any = getAzureClient(meterCtx, 'text-embedding-3-large');
    const sdkResponse = {
      model: 'text-embedding-3-large',
      usage: { prompt_tokens: 77, total_tokens: 77 },
      data: [{ embedding: [0.1] }],
    };
    setUnderlyingEmbeddingResolution(client, sdkResponse);

    const result = await client.embeddings.create({ model: 'text-embedding-3-large', input: 'x' });
    expect(result).toBe(sdkResponse);

    await flush();
    expect(mockRecordUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'azure-openai',
        model: 'text-embedding-3-large',
        inputTokens: 77,
        outputTokens: 0,
      })
    );
  });

  it('returns the client untouched when it exposes no chat.completions.create surface', () => {
    // Hits the early guard at the top of wrapOpenAICompatible: a client/mock that
    // lacks the chat surface is returned as-is, never wrapped.
    const OpenAICtor = jest.requireMock('openai').default as jest.Mock;
    const bare = { somethingElse: true };
    OpenAICtor.mockImplementationOnce(() => bare);
    const client: any = getOpenAIClient(meterCtx, { apiKey: 'k' });
    expect(client).toBe(bare);
    expect(client.chat).toBeUndefined();
  });

  it('does not record when a non-streaming chat response carries no usage', async () => {
    // Exercises the `resp?.usage` falsy side: a resolved response without a usage
    // object must not fire recordUsage.
    const client: any = getOpenAIClient(meterCtx, { apiKey: 'k' });
    const sdkResponse = { model: 'gpt-5-chat-2', choices: [{ message: { content: 'hi' } }] };
    setUnderlyingResolution(client, sdkResponse);

    const result = await client.chat.completions.create({ model: 'gpt-5-chat-2' });
    expect(result).toBe(sdkResponse);
    await flush();
    expect(mockRecordUsage).not.toHaveBeenCalled();
  });

  it('falls back to params.model when the chat response omits model', async () => {
    // Exercises `resp?.model || params?.model`: response has no model, so the
    // requested params.model is used for attribution.
    const client: any = getOpenAIClient(meterCtx, { apiKey: 'k' });
    const sdkResponse = { usage: { prompt_tokens: 7, completion_tokens: 2 } };
    setUnderlyingResolution(client, sdkResponse);

    await client.chat.completions.create({ model: 'gpt-5-chat-2' });
    await flush();
    expect(mockRecordUsage).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'gpt-5-chat-2', inputTokens: 7, outputTokens: 2 })
    );
  });

  it('streaming chat call without params.model still records with note (model undefined -> unknown)', async () => {
    // Exercises params?.model falsy side on the streaming branch and the
    // `model || "unknown"` fallback inside fireRecord.
    const client: any = getOpenAIClient(meterCtx, { apiKey: 'k' });
    const fakeStream = { [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true }) }) };
    setUnderlyingResolution(client, fakeStream);

    await client.chat.completions.create({ stream: true });
    await flush();
    expect(mockRecordUsage).toHaveBeenCalledWith(
      expect.objectContaining({ feature: 'chat:streaming-no-usage', model: 'unknown' })
    );
  });

  it('does not record when an embeddings response carries no usage', async () => {
    // Exercises the embeddings `resp?.usage` falsy side.
    const client: any = getAzureClient(meterCtx, 'text-embedding-3-large');
    const sdkResponse = { model: 'text-embedding-3-large', data: [{ embedding: [0.1] }] };
    setUnderlyingEmbeddingResolution(client, sdkResponse);

    const result = await client.embeddings.create({ model: 'text-embedding-3-large', input: 'x' });
    expect(result).toBe(sdkResponse);
    await flush();
    expect(mockRecordUsage).not.toHaveBeenCalled();
  });

  it('falls back to params.model when the embeddings response omits model', async () => {
    // Exercises embeddings `resp?.model || params?.model`.
    const client: any = getAzureClient(meterCtx, 'text-embedding-3-large');
    const sdkResponse = { usage: { prompt_tokens: 12, total_tokens: 12 } };
    setUnderlyingEmbeddingResolution(client, sdkResponse);

    await client.embeddings.create({ model: 'text-embedding-3-large', input: 'x' });
    await flush();
    expect(mockRecordUsage).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'text-embedding-3-large', inputTokens: 12, outputTokens: 0 })
    );
  });

  it('chat with no params AND a model-less response records model unknown (params?.model RHS short-circuit)', async () => {
    // Exercises `resp?.model || params?.model` where resp.model is falsy and
    // params is undefined, so the whole expression resolves undefined -> unknown.
    const client: any = getOpenAIClient(meterCtx, { apiKey: 'k' });
    setUnderlyingResolution(client, { usage: { prompt_tokens: 6, completion_tokens: 1 } });
    await client.chat.completions.create();
    await flush();
    expect(mockRecordUsage).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'unknown', inputTokens: 6, outputTokens: 1 })
    );
  });

  it('embeddings with no params AND a model-less response records model unknown', async () => {
    // Exercises embeddings `resp?.model || params?.model` with both falsy.
    const client: any = getAzureClient(meterCtx, 'text-embedding-3-large');
    setUnderlyingEmbeddingResolution(client, { usage: { prompt_tokens: 8, total_tokens: 8 } });
    await client.embeddings.create();
    await flush();
    expect(mockRecordUsage).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'unknown', inputTokens: 8, outputTokens: 0 })
    );
  });

  it('returns the client untouched when chat exists but completions surface is missing', () => {
    // Exercises the `client?.chat?.completions?.create` chain short-circuiting at
    // an intermediate node (chat present, completions absent).
    const OpenAICtor = jest.requireMock('openai').default as jest.Mock;
    const bare = { chat: {} };
    OpenAICtor.mockImplementationOnce(() => bare);
    const client: any = getOpenAIClient(meterCtx, { apiKey: 'k' });
    expect(client).toBe(bare);
  });

  it('wraps chat but returns early when embeddings exists without a create fn', async () => {
    // Exercises the `client?.embeddings?.create` chain short-circuiting at the
    // create node (embeddings object present, create absent). Chat still wraps.
    const OpenAICtor = jest.requireMock('openai').default as jest.Mock;
    const chatCreate = jest
      .fn()
      .mockResolvedValue({ model: 'gpt-5-chat-2', usage: { prompt_tokens: 1, completion_tokens: 1 } });
    OpenAICtor.mockImplementationOnce(() => ({
      chat: { completions: { create: chatCreate } },
      embeddings: {},
    }));
    const client: any = getOpenAIClient(meterCtx, { apiKey: 'k' });
    await client.chat.completions.create({ model: 'gpt-5-chat-2' });
    await flush();
    expect(mockRecordUsage).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'openai', inputTokens: 1 })
    );
  });

  it('non-streaming chat called with no params object tolerates params?.stream short-circuit', async () => {
    // Exercises `params?.stream` short-circuit (params undefined) — falls to the
    // non-stream branch — plus `resp?.model || params?.model` with params nullish,
    // so model resolves from the response.
    const client: any = getOpenAIClient(meterCtx, { apiKey: 'k' });
    setUnderlyingResolution(client, {
      model: 'gpt-5-chat-2',
      usage: { prompt_tokens: 4, completion_tokens: 2 },
    });
    await client.chat.completions.create();
    await flush();
    expect(mockRecordUsage).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'gpt-5-chat-2', inputTokens: 4, outputTokens: 2 })
    );
  });

  it('tolerates a null chat response (resp?.usage short-circuit)', async () => {
    // Exercises `resp?.usage` with resp nullish.
    const client: any = getOpenAIClient(meterCtx, { apiKey: 'k' });
    setUnderlyingResolution(client, null);
    const result = await client.chat.completions.create({ model: 'gpt-5-chat-2' });
    expect(result).toBeNull();
    await flush();
    expect(mockRecordUsage).not.toHaveBeenCalled();
  });

  it('tolerates a null embeddings response (resp?.usage short-circuit)', async () => {
    // Exercises the embeddings `resp?.usage` with resp nullish.
    const client: any = getAzureClient(meterCtx, 'text-embedding-3-large');
    setUnderlyingEmbeddingResolution(client, null);
    const result = await client.embeddings.create({ model: 'text-embedding-3-large', input: 'x' });
    expect(result).toBeNull();
    await flush();
    expect(mockRecordUsage).not.toHaveBeenCalled();
  });

  it('embeddings called with no params object resolves model from the response', async () => {
    // Exercises embeddings `resp?.model || params?.model` with params nullish.
    const client: any = getAzureClient(meterCtx, 'text-embedding-3-large');
    setUnderlyingEmbeddingResolution(client, {
      model: 'text-embedding-3-large',
      usage: { prompt_tokens: 9, total_tokens: 9 },
    });
    await client.embeddings.create();
    await flush();
    expect(mockRecordUsage).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'text-embedding-3-large', inputTokens: 9, outputTokens: 0 })
    );
  });

  it('constructs OpenAI with the default apiKey when no options are passed', () => {
    // Exercises the `options ?? { apiKey: process.env.OPENAI_API_KEY }` default side.
    const OpenAICtor = jest.requireMock('openai').default as jest.Mock;
    const prevKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'env-openai-key';
    OpenAICtor.mockClear();
    getOpenAIClient(meterCtx);
    expect(OpenAICtor).toHaveBeenCalledWith({ apiKey: 'env-openai-key' });
    process.env.OPENAI_API_KEY = prevKey;
  });

  it('uses env deployment + default api-version when none are provided', () => {
    // Exercises `deployment || process.env.AZURE_OPENAI_DEPLOYMENT || "gpt-4"`
    // (env side) and `apiVersion ?? ... ?? "2024-08-01-preview"` (default side).
    const OpenAICtor = jest.requireMock('openai').default as jest.Mock;
    const prevDep = process.env.AZURE_OPENAI_DEPLOYMENT;
    const prevVer = process.env.AZURE_OPENAI_API_VERSION;
    const prevEp = process.env.AZURE_OPENAI_ENDPOINT;
    process.env.AZURE_OPENAI_DEPLOYMENT = 'env-deployment';
    delete process.env.AZURE_OPENAI_API_VERSION;
    process.env.AZURE_OPENAI_ENDPOINT = 'https://standard.example.com';
    OpenAICtor.mockClear();
    getAzureClient(meterCtx);
    expect(OpenAICtor).toHaveBeenCalledWith(
      expect.objectContaining({
        baseURL: 'https://standard.example.com/openai/deployments/env-deployment',
        defaultQuery: { 'api-version': '2024-08-01-preview' },
      })
    );
    process.env.AZURE_OPENAI_DEPLOYMENT = prevDep;
    process.env.AZURE_OPENAI_API_VERSION = prevVer;
    process.env.AZURE_OPENAI_ENDPOINT = prevEp;
  });

  it('falls back to the literal "gpt-4" deployment when neither arg nor env is set', () => {
    // Exercises the final `|| "gpt-4"` literal fallback in getAzureClient.
    const OpenAICtor = jest.requireMock('openai').default as jest.Mock;
    const prevDep = process.env.AZURE_OPENAI_DEPLOYMENT;
    const prevEp = process.env.AZURE_OPENAI_ENDPOINT;
    delete process.env.AZURE_OPENAI_DEPLOYMENT;
    process.env.AZURE_OPENAI_ENDPOINT = 'https://standard.example.com';
    OpenAICtor.mockClear();
    getAzureClient(meterCtx);
    expect(OpenAICtor).toHaveBeenCalledWith(
      expect.objectContaining({
        baseURL: 'https://standard.example.com/openai/deployments/gpt-4',
      })
    );
    process.env.AZURE_OPENAI_DEPLOYMENT = prevDep;
    process.env.AZURE_OPENAI_ENDPOINT = prevEp;
  });

  it('applies AzureClientOverrides for bespoke deployments (endpoint/key/api-version)', () => {
    const OpenAICtor = jest.requireMock('openai').default as jest.Mock;
    const prevEndpoint = process.env.AZURE_OPENAI_ENDPOINT;
    const prevVersion = process.env.AZURE_OPENAI_API_VERSION;
    process.env.AZURE_OPENAI_ENDPOINT = 'https://standard.example.com';
    process.env.AZURE_OPENAI_API_VERSION = '2024-08-01-preview';

    // Default: standard endpoint + api-version from env.
    OpenAICtor.mockClear();
    getAzureClient(meterCtx, 'gpt-5-chat-2');
    expect(OpenAICtor).toHaveBeenCalledWith(
      expect.objectContaining({
        baseURL: 'https://standard.example.com/openai/deployments/gpt-5-chat-2',
        defaultQuery: { 'api-version': '2024-08-01-preview' },
      })
    );

    // Override: a separate endpoint/key/api-version (e.g. the embeddings
    // deployment) wins over env, so migrating a bespoke `new OpenAI({...})` to
    // the factory constructs the identical client.
    OpenAICtor.mockClear();
    getAzureClient(meterCtx, 'text-embedding-3-large', {
      endpoint: 'https://embeddings.example.com',
      apiKey: 'embed-key',
      apiVersion: '2025-01-01-preview',
    });
    expect(OpenAICtor).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'embed-key',
        baseURL: 'https://embeddings.example.com/openai/deployments/text-embedding-3-large',
        defaultQuery: { 'api-version': '2025-01-01-preview' },
      })
    );

    process.env.AZURE_OPENAI_ENDPOINT = prevEndpoint;
    process.env.AZURE_OPENAI_API_VERSION = prevVersion;
  });
});

describe('getBedrockClient', () => {
  const bedrock = jest.requireMock('@aws-sdk/client-bedrock-runtime');

  beforeEach(() => {
    jest.clearAllMocks();
    mockRecordUsage.mockResolvedValue(undefined);
  });

  it('records Converse usage (with cache fields) and returns the response unmodified', async () => {
    const client: any = await getBedrockClient(meterCtx);
    const sdkResponse = {
      output: { message: { content: [{ text: 'hi' }] } },
      usage: { inputTokens: 500, outputTokens: 60, cacheReadInputTokens: 90, cacheWriteInputTokens: 10 },
    };
    getUnderlyingSend(client).mockResolvedValue(sdkResponse);

    const command = new bedrock.ConverseCommand({
      modelId:
        'arn:aws:bedrock:us-west-2:992382574572:inference-profile/global.anthropic.claude-sonnet-4-6',
    });
    const result = await client.send(command);
    expect(result).toBe(sdkResponse);

    await flush();
    expect(mockRecordUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'bedrock',
        model: 'anthropic.claude-sonnet-4-6',
        inputTokens: 500,
        outputTokens: 60,
        cacheReadTokens: 90,
        cacheWriteTokens: 10,
      })
    );
  });

  it('captures usage from the final ConverseStream metadata event, yielding every chunk unchanged', async () => {
    const client: any = await getBedrockClient(meterCtx);
    const events = [
      { contentBlockDelta: { delta: { text: 'a' } } },
      { contentBlockDelta: { delta: { text: 'b' } } },
      { metadata: { usage: { inputTokens: 10, outputTokens: 2 } } },
    ];
    async function* fakeStream() {
      for (const e of events) yield e;
    }
    getUnderlyingSend(client).mockResolvedValue({ stream: fakeStream() });

    const command = new bedrock.ConverseStreamCommand({ modelId: 'anthropic.claude-opus-4-8' });
    const response = await client.send(command);

    const seen: any[] = [];
    for await (const e of response.stream) seen.push(e);
    expect(seen).toEqual(events);

    await flush();
    expect(mockRecordUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'bedrock',
        model: 'anthropic.claude-opus-4-8',
        inputTokens: 10,
        outputTokens: 2,
      })
    );
  });

  it('records streaming-no-usage when a stream ends without a metadata event', async () => {
    const client: any = await getBedrockClient(meterCtx);
    async function* fakeStream() {
      yield { contentBlockDelta: { delta: { text: 'a' } } };
    }
    getUnderlyingSend(client).mockResolvedValue({ stream: fakeStream() });

    const command = new bedrock.ConverseStreamCommand({ modelId: 'anthropic.claude-opus-4-8' });
    const response = await client.send(command);
    for await (const _ of response.stream) {
      /* drain */
    }

    await flush();
    expect(mockRecordUsage).toHaveBeenCalledWith(
      expect.objectContaining({ feature: 'chat:streaming-no-usage' })
    );
  });

  it('records streaming-no-usage when a ConverseStream response has no iterable stream', async () => {
    const client: any = await getBedrockClient(meterCtx);
    // No stream property at all -> the non-iterable branch fires immediately.
    getUnderlyingSend(client).mockResolvedValue({});

    const command = new bedrock.ConverseStreamCommand({ modelId: 'anthropic.claude-opus-4-8' });
    await client.send(command);

    await flush();
    expect(mockRecordUsage).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'bedrock', feature: 'chat:streaming-no-usage' })
    );
  });

  it('propagates send errors unchanged', async () => {
    const client: any = await getBedrockClient(meterCtx);
    getUnderlyingSend(client).mockRejectedValue(new Error('throttled'));
    const command = new bedrock.ConverseCommand({ modelId: 'anthropic.claude-sonnet-4-6' });
    await expect(client.send(command)).rejects.toThrow('throttled');
    expect(mockRecordUsage).not.toHaveBeenCalled();
  });

  it('does not record when a ConverseCommand response carries no usage', async () => {
    // Exercises the `response?.usage` falsy side on the Converse branch.
    const client: any = await getBedrockClient(meterCtx);
    const sdkResponse = { output: { message: { content: [{ text: 'hi' }] } } };
    getUnderlyingSend(client).mockResolvedValue(sdkResponse);

    const command = new bedrock.ConverseCommand({ modelId: 'anthropic.claude-sonnet-4-6' });
    const result = await client.send(command);
    expect(result).toBe(sdkResponse);
    await flush();
    expect(mockRecordUsage).not.toHaveBeenCalled();
  });

  it('ignores commands that are neither Converse nor ConverseStream', async () => {
    // Exercises both `if`/`else if` falsy paths of the command dispatch: an
    // unrelated command name records nothing.
    const client: any = await getBedrockClient(meterCtx);
    class SomeOtherCommand {
      input: any;
      constructor(input: any) {
        this.input = input;
      }
    }
    getUnderlyingSend(client).mockResolvedValue({ usage: { inputTokens: 9 } });

    const command = new SomeOtherCommand({ modelId: 'anthropic.claude-sonnet-4-6' });
    await client.send(command);
    await flush();
    expect(mockRecordUsage).not.toHaveBeenCalled();
  });

  it('ConverseStream metadata events without usage do not overwrite null usage', async () => {
    // Exercises the `event?.metadata?.usage` falsy side inside meterBedrockStream:
    // a metadata event lacking a usage object leaves captured usage null, so the
    // finally block records streaming-no-usage.
    const client: any = await getBedrockClient(meterCtx);
    async function* fakeStream() {
      yield { metadata: { somethingElse: true } };
      yield { contentBlockDelta: { delta: { text: 'a' } } };
    }
    getUnderlyingSend(client).mockResolvedValue({ stream: fakeStream() });

    const command = new bedrock.ConverseStreamCommand({ modelId: 'anthropic.claude-opus-4-8' });
    const response = await client.send(command);
    for await (const _ of response.stream) {
      /* drain */
    }
    await flush();
    expect(mockRecordUsage).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'bedrock', feature: 'chat:streaming-no-usage' })
    );
  });

  it('records streaming-no-usage when a ConverseStream response has a non-iterable stream', async () => {
    // Exercises the `typeof response.stream[Symbol.asyncIterator] === "function"`
    // false side: stream is present but not an async iterable.
    const client: any = await getBedrockClient(meterCtx);
    getUnderlyingSend(client).mockResolvedValue({ stream: { not: 'iterable' } });

    const command = new bedrock.ConverseStreamCommand({ modelId: 'anthropic.claude-opus-4-8' });
    await client.send(command);
    await flush();
    expect(mockRecordUsage).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'bedrock', feature: 'chat:streaming-no-usage' })
    );
  });

  it('honors an explicit config (skips the default region/credentials block)', async () => {
    // Exercises the `config ?? {...}` left side: when a config is passed it wins
    // and the default region/credentials object is never built.
    const { BedrockRuntimeClient } = jest.requireMock('@aws-sdk/client-bedrock-runtime');
    (BedrockRuntimeClient as jest.Mock).mockClear();
    const explicit = { region: 'eu-central-1' } as any;
    await getBedrockClient(meterCtx, explicit);
    expect(BedrockRuntimeClient).toHaveBeenCalledWith(explicit);
  });

  it('builds default config with explicit credentials when AWS_ACCESS_KEY_ID is set', async () => {
    // Exercises the credentials-present side of the ternary plus the
    // `AWS_SECRET_ACCESS_KEY || ""` and region `||` fallbacks.
    const { BedrockRuntimeClient } = jest.requireMock('@aws-sdk/client-bedrock-runtime');
    const prevKey = process.env.AWS_ACCESS_KEY_ID;
    const prevSecret = process.env.AWS_SECRET_ACCESS_KEY;
    const prevRegion = process.env.AWS_REGION;
    const prevDefaultRegion = process.env.AWS_DEFAULT_REGION;
    process.env.AWS_ACCESS_KEY_ID = 'AKIATEST';
    delete process.env.AWS_SECRET_ACCESS_KEY;
    process.env.AWS_REGION = 'ap-south-1';
    delete process.env.AWS_DEFAULT_REGION;

    (BedrockRuntimeClient as jest.Mock).mockClear();
    await getBedrockClient(meterCtx);
    expect(BedrockRuntimeClient).toHaveBeenCalledWith(
      expect.objectContaining({
        region: 'ap-south-1',
        credentials: { accessKeyId: 'AKIATEST', secretAccessKey: '' },
      })
    );

    process.env.AWS_ACCESS_KEY_ID = prevKey;
    process.env.AWS_SECRET_ACCESS_KEY = prevSecret;
    process.env.AWS_REGION = prevRegion;
    process.env.AWS_DEFAULT_REGION = prevDefaultRegion;
  });

  it('tolerates a command with no constructor and no input (optional-chain short-circuits)', async () => {
    // Exercises `command?.constructor?.name` and `command?.input?.modelId`
    // short-circuit sides: a prototype-less object has no constructor, so
    // commandName is undefined and neither dispatch branch fires.
    const client: any = await getBedrockClient(meterCtx);
    getUnderlyingSend(client).mockResolvedValue({ usage: { inputTokens: 1 } });
    const command = Object.create(null); // no constructor, no input
    await client.send(command);
    await flush();
    expect(mockRecordUsage).not.toHaveBeenCalled();
  });

  it('tolerates a null command (command?.constructor / command?.input short-circuits)', async () => {
    // Exercises the `command?.` short-circuits where command itself is nullish:
    // commandName + modelId both resolve via the nullish path, no branch fires.
    const client: any = await getBedrockClient(meterCtx);
    getUnderlyingSend(client).mockResolvedValue({ usage: { inputTokens: 1 } });
    const result = await client.send(null);
    expect(result).toEqual({ usage: { inputTokens: 1 } });
    await flush();
    expect(mockRecordUsage).not.toHaveBeenCalled();
  });

  it('falls back to the literal us-west-2 region when no region env is set', async () => {
    // Exercises the final `|| "us-west-2"` literal in the default-config region chain.
    const { BedrockRuntimeClient } = jest.requireMock('@aws-sdk/client-bedrock-runtime');
    const prevKey = process.env.AWS_ACCESS_KEY_ID;
    const prevRegion = process.env.AWS_REGION;
    const prevDefaultRegion = process.env.AWS_DEFAULT_REGION;
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_REGION;
    delete process.env.AWS_DEFAULT_REGION;

    (BedrockRuntimeClient as jest.Mock).mockClear();
    await getBedrockClient(meterCtx);
    expect((BedrockRuntimeClient as jest.Mock).mock.calls[0][0].region).toBe('us-west-2');

    process.env.AWS_ACCESS_KEY_ID = prevKey;
    process.env.AWS_REGION = prevRegion;
    process.env.AWS_DEFAULT_REGION = prevDefaultRegion;
  });

  it('tolerates a null response on a ConverseCommand (response?.usage short-circuit)', async () => {
    // Exercises `response?.usage` with response nullish.
    const client: any = await getBedrockClient(meterCtx);
    getUnderlyingSend(client).mockResolvedValue(null);
    const command = new bedrock.ConverseCommand({ modelId: 'anthropic.claude-sonnet-4-6' });
    const result = await client.send(command);
    expect(result).toBeNull();
    await flush();
    expect(mockRecordUsage).not.toHaveBeenCalled();
  });

  it('tolerates a null response on a ConverseStreamCommand (response?.stream short-circuit -> no-usage note)', async () => {
    // Exercises `response?.stream` with response nullish: falls into the else,
    // recording streaming-no-usage.
    const client: any = await getBedrockClient(meterCtx);
    getUnderlyingSend(client).mockResolvedValue(null);
    const command = new bedrock.ConverseStreamCommand({ modelId: 'anthropic.claude-opus-4-8' });
    const result = await client.send(command);
    expect(result).toBeNull();
    await flush();
    expect(mockRecordUsage).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'bedrock', feature: 'chat:streaming-no-usage' })
    );
  });

  it('tolerates a null chunk inside a ConverseStream metadata scan (event?.metadata short-circuit)', async () => {
    // Exercises `event?.metadata?.usage` with a nullish yielded event.
    const client: any = await getBedrockClient(meterCtx);
    async function* fakeStream() {
      yield null;
      yield { contentBlockDelta: { delta: { text: 'a' } } };
    }
    getUnderlyingSend(client).mockResolvedValue({ stream: fakeStream() });
    const command = new bedrock.ConverseStreamCommand({ modelId: 'anthropic.claude-opus-4-8' });
    const response = await client.send(command);
    for await (const _ of response.stream) {
      /* drain */
    }
    await flush();
    expect(mockRecordUsage).toHaveBeenCalledWith(
      expect.objectContaining({ feature: 'chat:streaming-no-usage' })
    );
  });

  it('builds default config without credentials and falls back through region envs', async () => {
    // Exercises the no-credentials side of the ternary plus the
    // AWS_REGION -> AWS_DEFAULT_REGION -> "us-west-2" `||` chain.
    const { BedrockRuntimeClient } = jest.requireMock('@aws-sdk/client-bedrock-runtime');
    const prevKey = process.env.AWS_ACCESS_KEY_ID;
    const prevRegion = process.env.AWS_REGION;
    const prevDefaultRegion = process.env.AWS_DEFAULT_REGION;
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_REGION;
    process.env.AWS_DEFAULT_REGION = 'us-east-2';

    (BedrockRuntimeClient as jest.Mock).mockClear();
    await getBedrockClient(meterCtx);
    const callArg = (BedrockRuntimeClient as jest.Mock).mock.calls[0][0];
    expect(callArg.region).toBe('us-east-2');
    expect(callArg.credentials).toBeUndefined();

    process.env.AWS_ACCESS_KEY_ID = prevKey;
    process.env.AWS_REGION = prevRegion;
    process.env.AWS_DEFAULT_REGION = prevDefaultRegion;
  });
});

describe('getGeminiClient', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRecordUsage.mockResolvedValue(undefined);
    process.env.GEMINI_API_KEY = 'test-gemini-key';
  });

  it('records generateContent usageMetadata and returns the response unmodified', async () => {
    const client: any = await getGeminiClient(meterCtx);
    const sdkResponse = {
      text: 'hello',
      usageMetadata: { promptTokenCount: 40, candidatesTokenCount: 8, cachedContentTokenCount: 4 },
    };
    getUnderlyingGeminiGenerate(client).mockResolvedValue(sdkResponse);

    const result = await client.models.generateContent({ model: 'gemini-3.5-flash', contents: 'x' });
    expect(result).toBe(sdkResponse);

    await flush();
    expect(mockRecordUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'gemini',
        model: 'gemini-3.5-flash',
        inputTokens: 40,
        outputTokens: 8,
        cacheReadTokens: 4,
      })
    );
  });

  it('captures usage from the final stream chunk, yielding chunks unchanged', async () => {
    const client: any = await getGeminiClient(meterCtx);
    const chunks = [
      { text: 'a' },
      { text: 'b', usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 } },
    ];
    async function* fakeStream() {
      for (const c of chunks) yield c;
    }
    getUnderlyingGeminiStream(client).mockResolvedValue(fakeStream());

    const stream = await client.models.generateContentStream({ model: 'gemini-3.5-flash' });
    const seen: any[] = [];
    for await (const c of stream) seen.push(c);
    expect(seen).toEqual(chunks);

    await flush();
    expect(mockRecordUsage).toHaveBeenCalledWith(
      expect.objectContaining({ inputTokens: 5, outputTokens: 2, model: 'gemini-3.5-flash' })
    );
  });

  it('records streaming-no-usage when a Gemini stream yields no usageMetadata', async () => {
    const client: any = await getGeminiClient(meterCtx);
    async function* fakeStream() {
      yield { text: 'a' };
      yield { text: 'b' };
    }
    getUnderlyingGeminiStream(client).mockResolvedValue(fakeStream());

    const stream = await client.models.generateContentStream({ model: 'gemini-3.5-flash' });
    for await (const _ of stream) {
      /* drain */
    }

    await flush();
    expect(mockRecordUsage).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'gemini', feature: 'chat:streaming-no-usage' })
    );
  });

  it('throws when no API key is available', async () => {
    delete process.env.GEMINI_API_KEY;
    await expect(getGeminiClient(meterCtx)).rejects.toThrow('GEMINI_API_KEY not set');
  });

  it('uses an explicitly passed apiKey over the environment variable', async () => {
    // Exercises the `apiKey ?? process.env.GEMINI_API_KEY ?? ""` left side.
    const { GoogleGenAI } = jest.requireMock('@google/genai');
    (GoogleGenAI as jest.Mock).mockClear();
    await getGeminiClient(meterCtx, 'explicit-key');
    expect(GoogleGenAI).toHaveBeenCalledWith({ apiKey: 'explicit-key' });
  });

  it('does not record when generateContent returns no usageMetadata', async () => {
    // Exercises the `response?.usageMetadata` falsy side.
    const client: any = await getGeminiClient(meterCtx);
    const sdkResponse = { text: 'hello' };
    getUnderlyingGeminiGenerate(client).mockResolvedValue(sdkResponse);

    const result = await client.models.generateContent({ model: 'gemini-3.5-flash' });
    expect(result).toBe(sdkResponse);
    await flush();
    expect(mockRecordUsage).not.toHaveBeenCalled();
  });

  it('records generateContent with model undefined -> unknown when params omit model', async () => {
    // Exercises params?.model falsy side feeding fireRecord's `model || "unknown"`.
    const client: any = await getGeminiClient(meterCtx);
    getUnderlyingGeminiGenerate(client).mockResolvedValue({
      usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1 },
    });

    await client.models.generateContent({ contents: 'x' });
    await flush();
    expect(mockRecordUsage).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'gemini', model: 'unknown', inputTokens: 3 })
    );
  });

  it('returns a non-iterable stream unwrapped (no metering wrapper applied)', async () => {
    // Exercises the `stream && typeof stream[Symbol.asyncIterator] === "function"`
    // false side at line ~353-359: a non-iterable resolved value is returned as-is
    // and nothing is recorded.
    const client: any = await getGeminiClient(meterCtx);
    const notAStream = { foo: 'bar' };
    getUnderlyingGeminiStream(client).mockResolvedValue(notAStream);

    const stream = await client.models.generateContentStream({ model: 'gemini-3.5-flash' });
    expect(stream).toBe(notAStream);
    await flush();
    expect(mockRecordUsage).not.toHaveBeenCalled();
  });

  it('skips wrapping when the client lacks generateContent / generateContentStream functions', async () => {
    // Exercises the `typeof client.models?.generateContent === "function"` and the
    // matching generateContentStream guard false sides: a client whose models
    // surface lacks those functions is returned without wrapping and never throws.
    const { GoogleGenAI } = jest.requireMock('@google/genai');
    (GoogleGenAI as jest.Mock).mockImplementationOnce(() => ({ models: {} }));
    const client: any = await getGeminiClient(meterCtx);
    expect(client.models.generateContent).toBeUndefined();
    expect(client.models.generateContentStream).toBeUndefined();
  });

  it('skips both wraps when the client has no models surface (models?. short-circuit)', async () => {
    // Exercises `client.models?.generateContent` / `client.models?.generateContentStream`
    // optional-chain short-circuit sides: client.models is undefined entirely.
    const { GoogleGenAI } = jest.requireMock('@google/genai');
    (GoogleGenAI as jest.Mock).mockImplementationOnce(() => ({}));
    const client: any = await getGeminiClient(meterCtx);
    expect(client.models).toBeUndefined();
  });

  it('records generateContent with no params object (params?.model short-circuit -> unknown)', async () => {
    // Exercises `params?.model` short-circuit when params is undefined, plus the
    // usageMetadata-present path with no model.
    const client: any = await getGeminiClient(meterCtx);
    getUnderlyingGeminiGenerate(client).mockResolvedValue({
      usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1 },
    });
    await client.models.generateContent();
    await flush();
    expect(mockRecordUsage).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'gemini', model: 'unknown', inputTokens: 2 })
    );
  });

  it('tolerates a null response from generateContent (response?.usageMetadata short-circuit)', async () => {
    // Exercises `response?.usageMetadata` with response nullish.
    const client: any = await getGeminiClient(meterCtx);
    getUnderlyingGeminiGenerate(client).mockResolvedValue(null);
    const result = await client.models.generateContent({ model: 'gemini-3.5-flash' });
    expect(result).toBeNull();
    await flush();
    expect(mockRecordUsage).not.toHaveBeenCalled();
  });

  it('tolerates a null chunk inside a Gemini stream (chunk?.usageMetadata short-circuit)', async () => {
    // Exercises `chunk?.usageMetadata` with a nullish yielded chunk.
    const client: any = await getGeminiClient(meterCtx);
    async function* fakeStream() {
      yield null;
      yield { text: 'a' };
    }
    getUnderlyingGeminiStream(client).mockResolvedValue(fakeStream());
    const stream = await client.models.generateContentStream({ model: 'gemini-3.5-flash' });
    for await (const _ of stream) {
      /* drain */
    }
    await flush();
    expect(mockRecordUsage).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'gemini', feature: 'chat:streaming-no-usage' })
    );
  });

  it('meters a stream when generateContentStream is called with no params (params?.model short-circuit)', async () => {
    // Exercises `params?.model` short-circuit in the generateContentStream wrapper:
    // an iterable stream is still wrapped; the captured usage records model unknown.
    const client: any = await getGeminiClient(meterCtx);
    async function* fakeStream() {
      yield { usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 1 } };
    }
    getUnderlyingGeminiStream(client).mockResolvedValue(fakeStream());
    const stream = await client.models.generateContentStream();
    for await (const _ of stream) {
      /* drain */
    }
    await flush();
    expect(mockRecordUsage).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'gemini', model: 'unknown', inputTokens: 4 })
    );
  });
});

// ── helpers to reach the original (pre-wrap) mocks bound inside the wrappers ──
//
// wrapOpenAICompatible binds the ORIGINAL jest.fn at wrap time, then replaces
// `create`. The original mock function instance is shared via the constructor
// mock implementation closure, so we can recover it from mock.results.

function getConstructedOpenAIInstance(client: any): any {
  return client; // the factory mutates and returns the same instance
}

function setUnderlyingResolution(client: any, value: any): void {
  // The wrapper closed over a bound copy of the original jest.fn; configuring
  // the jest.fn still controls the bound copy.
  const orig = getOriginalChatCreate(client);
  orig.mockResolvedValue(value);
}

function setUnderlyingRejection(client: any, err: Error): void {
  getOriginalChatCreate(client).mockRejectedValue(err);
}

function setUnderlyingEmbeddingResolution(client: any, value: any): void {
  getOriginalEmbedCreate(client).mockResolvedValue(value);
}

const originalCreates = new WeakMap<any, { chat: jest.Mock; embed: jest.Mock }>();

// Re-implement the constructor mock so the per-instance original fns stay
// reachable after the factory replaces `.create` with the metering wrapper
// (the wrapper bound the original at wrap time, so configuring the original
// jest.fn still controls what the wrapper's underlying call resolves to).
beforeAll(() => {
  const MockOpenAI = jest.requireMock('openai').default as jest.Mock;
  MockOpenAI.mockImplementation(() => {
    const chatCreate = jest.fn();
    const embedCreate = jest.fn();
    const instance = {
      chat: { completions: { create: chatCreate } },
      embeddings: { create: embedCreate },
    };
    originalCreates.set(instance, { chat: chatCreate, embed: embedCreate });
    return instance;
  });
});

function getOriginalChatCreate(client: any): jest.Mock {
  const originals = originalCreates.get(getConstructedOpenAIInstance(client));
  if (!originals) throw new Error('test helper: original create not found');
  return originals.chat;
}

function getOriginalEmbedCreate(client: any): jest.Mock {
  const originals = originalCreates.get(getConstructedOpenAIInstance(client));
  if (!originals) throw new Error('test helper: original embeddings create not found');
  return originals.embed;
}

const bedrockSends = new WeakMap<any, jest.Mock>();
beforeAll(() => {
  const { BedrockRuntimeClient } = jest.requireMock('@aws-sdk/client-bedrock-runtime');
  (BedrockRuntimeClient as jest.Mock).mockImplementation(() => {
    const send = jest.fn();
    const instance = { send };
    bedrockSends.set(instance, send);
    return instance;
  });
});

function getUnderlyingSend(client: any): jest.Mock {
  const send = bedrockSends.get(client);
  if (!send) throw new Error('test helper: original send not found');
  return send;
}

const geminiFns = new WeakMap<any, { generate: jest.Mock; stream: jest.Mock }>();
beforeAll(() => {
  const { GoogleGenAI } = jest.requireMock('@google/genai');
  (GoogleGenAI as jest.Mock).mockImplementation(() => {
    const generate = jest.fn();
    const stream = jest.fn();
    const instance = { models: { generateContent: generate, generateContentStream: stream } };
    geminiFns.set(instance, { generate, stream });
    return instance;
  });
});

function getUnderlyingGeminiGenerate(client: any): jest.Mock {
  const fns = geminiFns.get(client);
  if (!fns) throw new Error('test helper: original gemini generate not found');
  return fns.generate;
}

function getUnderlyingGeminiStream(client: any): jest.Mock {
  const fns = geminiFns.get(client);
  if (!fns) throw new Error('test helper: original gemini stream not found');
  return fns.stream;
}

async function wrapAndCall(client: any, sdkResponse: any): Promise<any> {
  setUnderlyingResolution(client, sdkResponse);
  return client.chat.completions.create({ model: sdkResponse.model });
}
