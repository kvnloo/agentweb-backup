/**
 * Tests for the embeddings util used by relevance-based memory retrieval.
 */

const mockCreate = jest.fn();
jest.mock('openai', () =>
  jest.fn().mockImplementation(() => ({
    // embedText now goes through the metered llmClients factory, which wraps
    // chat.completions.create and embeddings.create at construction time.
    chat: { completions: { create: jest.fn() } },
    embeddings: { create: mockCreate },
  }))
);

// Shadow metering is fire-and-forget; mock it so tests never touch the recorder.
jest.mock('../services/usageRecorderService', () => ({
  recordUsage: jest.fn().mockResolvedValue(undefined),
}));

import { embedText } from '../utils/embeddings';

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
