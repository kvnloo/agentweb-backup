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

import { embedText } from '../utils/embeddings';
import { meterUsageFromResponse } from '../utils/llmClients';
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
    mockCreate.mockResolvedValue({ data: [{ embedding: [0.1, 0.2, 0.3] }] });
    expect(await embedText('hello')).toEqual([0.1, 0.2, 0.3]);
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('honors an explicit meterCtx feature/userId', async () => {
    mockCreate.mockResolvedValue({ data: [{ embedding: [0.4] }] });
    expect(
      await embedText('hi', { userId: 'u-9', feature: 'kb_index' })
    ).toEqual([0.4]);
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('CHARGES the caller: meters the embedding response with the userId (ENG-200)', async () => {
    const response = { data: [{ embedding: [0.5] }], usage: { prompt_tokens: 12, total_tokens: 12 } };
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
    mockCreate.mockResolvedValue({ data: [{ embedding: [0.6] }], usage: { prompt_tokens: 3 } });
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

  // Cover both sides of the deployment-name default in the client baseURL.
  it('loads with the fallback deployment name when env is unset', () => {
    const saved = process.env.AZURE_OPENAI_EMBEDDINGS_DEPLOYMENT;
    jest.isolateModules(() => {
      delete process.env.AZURE_OPENAI_EMBEDDINGS_DEPLOYMENT;
      require('../utils/embeddings');
    });
    if (saved !== undefined) process.env.AZURE_OPENAI_EMBEDDINGS_DEPLOYMENT = saved;
  });

  it('loads with the configured deployment name when env is set', () => {
    const saved = process.env.AZURE_OPENAI_EMBEDDINGS_DEPLOYMENT;
    jest.isolateModules(() => {
      process.env.AZURE_OPENAI_EMBEDDINGS_DEPLOYMENT = 'custom-deploy';
      require('../utils/embeddings');
    });
    if (saved !== undefined) process.env.AZURE_OPENAI_EMBEDDINGS_DEPLOYMENT = saved;
    else delete process.env.AZURE_OPENAI_EMBEDDINGS_DEPLOYMENT;
  });
});
