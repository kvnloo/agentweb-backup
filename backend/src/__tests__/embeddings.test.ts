/**
 * Tests for the embeddings util used by relevance-based memory retrieval.
 */

const mockCreate = jest.fn();
jest.mock('openai', () =>
  jest.fn().mockImplementation(() => ({
    // embedText requests an UN-metered client (metered:false) and meters the
    // response itself via meterUsageFromResponse, so the SDK client is raw here.
    chat: { completions: { create: jest.fn() } },
    embeddings: { create: mockCreate },
  }))
);

// Keep the real getOpenAIClient (returns the mocked SDK client) but spy on the
// explicit meter so we can assert embedText charges the user.
jest.mock('../utils/llmClients', () => ({
  ...jest.requireActual('../utils/llmClients'),
  meterUsageFromResponse: jest.fn(),
}));

// Shadow metering is fire-and-forget; mock it so tests never touch the recorder.
jest.mock('../services/usageRecorderService', () => ({
  recordUsage: jest.fn().mockResolvedValue(undefined),
  meterUserUsage: jest.fn(),
}));

jest.mock('../utils/secretsManager', () => ({ getSecret: jest.fn().mockResolvedValue('secret-router-key') }));

import OpenAI from 'openai';
import { getSecret } from '../utils/secretsManager';
import { getModelPrice } from '../utils/llmPricing';
import { embedText } from '../utils/embeddings';
import { meterUsageFromResponse } from '../utils/llmClients';
const vector = Array(3072).fill(0.1);
const mockMeter = meterUsageFromResponse as jest.Mock;

describe('embedText', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns null for empty / whitespace input without calling the API', async () => {
    expect(await embedText('')).toBeNull();
    expect(await embedText('   ')).toBeNull();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('returns the embedding vector on success', async () => {
    mockCreate.mockResolvedValue({ data: [{ embedding: vector }] });
    expect(await embedText('hello')).toEqual(vector);
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('honors an explicit meterCtx feature/userId', async () => {
    mockCreate.mockResolvedValue({ data: [{ embedding: vector }] });
    expect(
      await embedText('hi', { userId: 'u-9', feature: 'kb_index' })
    ).toEqual(vector);
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('CHARGES the caller: meters the embedding response with the userId (ENG-200)', async () => {
    const response = { data: [{ embedding: vector }], usage: { prompt_tokens: 12, total_tokens: 12 } };
    mockCreate.mockResolvedValue(response);
    await embedText('index me', { userId: 'u-42', feature: 'kb_index' });
    // meterUsageFromResponse records AND deducts (userId present) — not shadow-only.
    expect(mockMeter).toHaveBeenCalledTimes(1);
    expect(mockMeter).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u-42', feature: 'kb_index' }),
      response
    );
  });

  it('absorbs (no charge) when no userId is attributable — still records under system', async () => {
    mockCreate.mockResolvedValue({ data: [{ embedding: vector }], usage: { prompt_tokens: 3 } });
    await embedText('platform text'); // no meterCtx → no userId
    expect(mockMeter).toHaveBeenCalledWith(
      expect.objectContaining({ userId: undefined }),
      expect.anything()
    );
  });

  it('returns null (does not throw) when the API call fails', async () => {
    mockCreate.mockRejectedValue(new Error('network down'));
    expect(await embedText('hello')).toBeNull();
  });

  it('keeps the required model and 3072-dimensional vector contract', async () => {
    mockCreate.mockResolvedValue({ data: [{ embedding: vector }] });
    await embedText('hello');
    expect(getModelPrice('openai/text-embedding-3-large')).toEqual(getModelPrice('text-embedding-3-large'));
    expect(mockCreate).toHaveBeenCalledWith({
      model: 'openai/text-embedding-3-large', input: 'hello', dimensions: 3072,
    });
    expect(mockMeter).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'openrouter', model: 'openai/text-embedding-3-large' }),
      expect.anything(),
    );
  });

  it('uses the existing OpenRouter environment key', async () => {
    const saved = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = 'env-router-key';
    try {
      mockCreate.mockResolvedValue({ data: [{ embedding: vector }] });
      await embedText('hello');
      expect(OpenAI).toHaveBeenCalledWith({
        apiKey: 'env-router-key', baseURL: 'https://openrouter.ai/api/v1',
      });
      expect(getSecret).not.toHaveBeenCalled();
    } finally {
      if (saved === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = saved;
    }
  });

  it.each(['production', 'development'])('uses the existing %s OpenRouter secret', async (environment) => {
    const saved = process.env.OPENROUTER_API_KEY;
    const savedEnv = process.env.NODE_ENV;
    delete process.env.OPENROUTER_API_KEY;
    process.env.NODE_ENV = environment;
    try {
      mockCreate.mockResolvedValue({ data: [{ embedding: vector }] });
      await embedText('hello');
      expect(getSecret).toHaveBeenCalledWith(`${environment === 'production' ? 'prod' : 'dev'}/AgentWeb/OpenRouter`);
      expect(OpenAI).toHaveBeenCalledWith({
        apiKey: 'secret-router-key', baseURL: 'https://openrouter.ai/api/v1',
      });
    } finally {
      if (saved === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = saved;
      process.env.NODE_ENV = savedEnv;
    }
  });

  it.each([undefined, {}, { data: [] }, { data: [null] },
    { data: [{ embedding: 'invalid' }] }, { data: [{ embedding: [0.1] }] },
    { data: [{ embedding: [...vector.slice(1), '0.1'] }] },
    { data: [{ embedding: [...vector.slice(1), Infinity] }] },
  ])('rejects malformed or incompatible vectors: %p', async (response) => {
    mockCreate.mockResolvedValue(response);
    expect(await embedText('hello')).toBeNull();
  });
});
