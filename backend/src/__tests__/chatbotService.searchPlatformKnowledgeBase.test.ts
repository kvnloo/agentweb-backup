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

import { searchPlatformKnowledgeBase } from '../services/chatbotService';

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
