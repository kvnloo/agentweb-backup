/**
 * ENG-1057: searchPlatformKnowledgeBase() is the single shared source behind
 * three separate consumers (AgentModeService.searchKnowledgeBase,
 * GrowthGeniusService.searchKnowledgeBase, chatbotService's own platform-KB
 * fallback in generateChatResponse). It pushed raw, uncapped Vertex content
 * into its results — a single oversized result crashed the backend with an
 * uncaught ERR_STRING_TOO_LONG on 2026-08-10, taking down 100% of traffic on
 * this single-instance environment for ~1.5-2 min. Capping here, at the
 * source, protects all consumers uniformly instead of relying on each one to
 * remember to truncate independently.
 */

const searchMock = jest.fn();

jest.mock('aws-sdk', () => ({
  DynamoDB: {
    DocumentClient: jest.fn(() => ({
      query: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({ Items: [] }) })),
      get: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({ Item: null }) })),
      put: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({}) })),
      update: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({}) })),
    })),
  },
  S3: jest.fn(() => ({
    upload: jest.fn().mockReturnThis(),
    promise: jest.fn(),
  })),
  config: { update: jest.fn() },
}));
jest.mock('openai', () => jest.fn(() => ({})));
jest.mock('@google-cloud/discoveryengine', () => ({
  EngineServiceClient: jest.fn(),
  SearchServiceClient: jest.fn(() => ({ search: searchMock })),
  protos: {
    google: {
      cloud: {
        discoveryengine: {
          v1: {
            SearchRequest: {
              QueryExpansionSpec: { Condition: { AUTO: 1 } },
              SpellCorrectionSpec: { Mode: { AUTO: 1 } },
            },
          },
        },
      },
    },
  },
}));
jest.mock('@google-cloud/storage', () => ({ Storage: jest.fn() }));
jest.mock('../controllers/guide', () => ({ getGuide: jest.fn() }));
jest.mock('../controllers/release', () => ({ getReleases: jest.fn() }));
jest.mock('../controllers/docsController', () => ({ getUserReleaseNotes: jest.fn() }));
jest.mock('../services/db', () => ({ taskDb: { getTaskById: jest.fn() } }));
jest.mock('../utils/secretsManager', () => ({
  getGCSPPrivateKey: jest.fn().mockResolvedValue('fake-key'),
  getSecret: jest.fn().mockResolvedValue('fake-key'),
}));

jest.mock('../utils/embeddings', () => ({ embedText: jest.fn() }));
jest.mock('../services/docsKnowledgeSource', () => ({
  fetchMintlifyDocsContent: jest.fn().mockResolvedValue('docs'),
  chunkDocsContent: jest.fn(() => [
    { id: 'keyword', content: 'billing support' },
    { id: 'semantic', content: 'payments' },
  ]),
}));

jest.mock('../services/funding/runFunding', () => ({
  currentRunFunding: jest.fn(() => ({ ownerUserId: 'run-owner' })),
}));

import { embedText } from '../utils/embeddings';
import { loadKnowledgeBase, searchKnowledgeBase, searchPlatformKnowledgeBase } from '../services/chatbotService';

function vertexResult(content: string) {
  return {
    document: {
      derivedStructData: {
        fields: {
          extractive_segments: {
            listValue: {
              values: [{ structValue: { fields: { content: { stringValue: content } } } }],
            },
          },
        },
      },
    },
  };
}

describe('searchPlatformKnowledgeBase — content length capping', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // clearAllMocks() clears call history but not a mock's queued/default
    // implementation — without this, the never-resolving implementation set by
    // the timeout-guard test below would survive as searchMock's default for
    // every later test, which would then hang on it instead of failing fast.
    searchMock.mockReset();
  });

  it('truncates a public-KB result over 5000 chars with a truncation marker', async () => {
    const longContent = 'x'.repeat(6000);
    searchMock
      .mockImplementationOnce(async () => [[vertexResult(longContent)]]) // public
      .mockImplementationOnce(async () => [[]]); // private

    const results = await searchPlatformKnowledgeBase('test query', 5, 'user-123');

    expect(results).toHaveLength(1);
    expect(results[0].content).toBe('x'.repeat(5000) + '\n\n[Content truncated]');
    expect(results[0].content.length).toBeLessThan(longContent.length);
  });

  it('excludes a segment with empty content instead of crashing the truncation check (malformed Vertex response)', async () => {
    const malformedSegment = {
      document: {
        derivedStructData: {
          fields: {
            extractive_segments: {
              listValue: {
                values: [{ structValue: { fields: { content: { stringValue: '' } } } }],
              },
            },
          },
        },
      },
    };
    searchMock
      .mockImplementationOnce(async () => [[malformedSegment, vertexResult('valid content')]])
      .mockImplementationOnce(async () => [[]]);

    const results = await searchPlatformKnowledgeBase('test query', 5, 'user-123');

    expect(results).toHaveLength(1);
    expect(results[0].content).toBe('valid content');
  });

  it('does not truncate content at exactly 5000 chars', async () => {
    const boundaryContent = 'x'.repeat(5000);
    searchMock
      .mockImplementationOnce(async () => [[vertexResult(boundaryContent)]])
      .mockImplementationOnce(async () => [[]]);

    const results = await searchPlatformKnowledgeBase('test query', 5, 'user-123');

    expect(results[0].content).toBe(boundaryContent);
    expect(results[0].content).not.toContain('[Content truncated]');
  });

  it('does not truncate content under 5000 chars', async () => {
    searchMock
      .mockImplementationOnce(async () => [[vertexResult('short content')]])
      .mockImplementationOnce(async () => [[]]);

    const results = await searchPlatformKnowledgeBase('test query', 5, 'user-123');

    expect(results[0].content).toBe('short content');
  });

  it('truncates only the oversized result when multiple public-KB results have mixed lengths', async () => {
    const longContent = 'y'.repeat(7000);
    searchMock
      .mockImplementationOnce(async () => [[vertexResult('short content'), vertexResult(longContent)]])
      .mockImplementationOnce(async () => [[]]);

    const results = await searchPlatformKnowledgeBase('test query', 5, 'user-123');

    expect(results).toHaveLength(2);
    expect(results[0].content).toBe('short content');
    expect(results[1].content).toBe('y'.repeat(5000) + '\n\n[Content truncated]');
  });
});

describe('searchPlatformKnowledgeBase — ENG-1222 timeout guard', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // clearAllMocks() clears call history but not a mock's queued/default
    // implementation — without this, the never-resolving implementation set by
    // the timeout-guard test below would survive as searchMock's default for
    // every later test, which would then hang on it instead of failing fast.
    searchMock.mockReset();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // A live Vertex AI Discovery Engine call was directly observed hanging for
  // several minutes with no error and no result — with no timeout, that stalls
  // the entire chat turn (every chatbotService.ts message goes through this,
  // not just skill sessions). It must reject instead of hanging forever.
  it('rejects with a timeout error instead of hanging indefinitely when Vertex never responds', async () => {
    jest.useFakeTimers();
    searchMock.mockImplementation(() => new Promise(() => {})); // never resolves

    const resultPromise = searchPlatformKnowledgeBase('test query', 5, 'user-123');
    const assertion = expect(resultPromise).rejects.toThrow(/timed out/i);

    await jest.advanceTimersByTimeAsync(10_000);
    await assertion;
  });

  it('still returns real results normally when Vertex responds well within the timeout', async () => {
    searchMock
      .mockImplementationOnce(async () => [[vertexResult('fast result')]])
      .mockImplementationOnce(async () => [[]]);

    const results = await searchPlatformKnowledgeBase('test query', 5, 'user-123');

    expect(results).toHaveLength(1);
    expect(results[0].content).toBe('fast result');
  });
});


describe('knowledge-base embeddings through the shared helper', () => {
  beforeEach(async () => {
    (embedText as jest.Mock).mockReset();
    await loadKnowledgeBase();
  });

  it('embeds both the query and chunks, ranking by semantic similarity', async () => {
    (embedText as jest.Mock)
      .mockResolvedValueOnce([1, 0])
      .mockResolvedValueOnce([0, 1])
      .mockResolvedValueOnce([1, 0]);
    expect((await searchKnowledgeBase('billing', 1)).map(chunk => chunk.id)).toEqual(['semantic']);
    expect(embedText).toHaveBeenNthCalledWith(1, 'billing', { userId: 'run-owner', feature: 'embeddings' });
    expect(embedText).toHaveBeenNthCalledWith(2, 'billing support', { userId: 'run-owner', feature: 'embeddings' });
    expect(embedText).toHaveBeenNthCalledWith(3, 'payments', { userId: 'run-owner', feature: 'embeddings' });
  });

  it('falls back to keywords when the query cannot be embedded', async () => {
    (embedText as jest.Mock).mockResolvedValue(null);
    expect((await searchKnowledgeBase('billing', 1)).map(chunk => chunk.id)).toEqual(['keyword']);
    expect(embedText).toHaveBeenCalledTimes(1);
  });

  it('falls back to keywords when any chunk cannot be embedded', async () => {
    (embedText as jest.Mock).mockResolvedValueOnce([1, 0]).mockResolvedValue(null);
    expect((await searchKnowledgeBase('billing', 1)).map(chunk => chunk.id)).toEqual(['keyword']);
  });
});
