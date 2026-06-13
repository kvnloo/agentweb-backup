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

  it('propagates send errors unchanged', async () => {
    const client: any = await getBedrockClient(meterCtx);
    getUnderlyingSend(client).mockRejectedValue(new Error('throttled'));
    const command = new bedrock.ConverseCommand({ modelId: 'anthropic.claude-sonnet-4-6' });
    await expect(client.send(command)).rejects.toThrow('throttled');
    expect(mockRecordUsage).not.toHaveBeenCalled();
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

  it('throws when no API key is available', async () => {
    delete process.env.GEMINI_API_KEY;
    await expect(getGeminiClient(meterCtx)).rejects.toThrow('GEMINI_API_KEY not set');
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
