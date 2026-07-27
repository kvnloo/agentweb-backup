// @ts-nocheck
/**
 * AC2 (ENG-163): the support chatbot's knowledge base answers a docs question
 * sourced from Mintlify content. `fetch` is mocked (via the docsKnowledgeSource
 * boundary) so no network is touched, and the real loadKnowledgeBase wiring +
 * searchKnowledgeBase retrieval are exercised end-to-end.
 */

// Mock AWS SDK BEFORE importing chatbotService
jest.mock('aws-sdk', () => {
  const mockDocClient = {
    get: jest.fn(),
    put: jest.fn(),
    update: jest.fn(),
    query: jest.fn(),
    batchWrite: jest.fn(),
  };
  return {
    DynamoDB: { DocumentClient: jest.fn(() => mockDocClient) },
    S3: jest.fn(() => ({ putObject: jest.fn(), getObject: jest.fn(), deleteObject: jest.fn() })),
    SecretsManager: jest.fn(() => ({ getSecretValue: jest.fn() })),
    config: { update: jest.fn() },
  };
});

jest.mock('../db', () => ({
  taskDb: { getTaskById: jest.fn() },
}));

jest.mock('../../utils/secretsManager', () => ({
  getGCSPPrivateKey: jest.fn(() => Promise.resolve('mock-private-key')),
  getSecret: jest.fn(() => Promise.resolve('{}')),
}));

jest.mock('../../controllers/guide', () => ({ getGuide: jest.fn() }));
jest.mock('../../controllers/release', () => ({ getReleases: jest.fn() }));
jest.mock('../../controllers/docsController', () => ({ getUserReleaseNotes: jest.fn() }));

// Keep the real chunker; only mock the network boundary so we can feed canned
// Mintlify docs content.
jest.mock('../docsKnowledgeSource', () => {
  const actual = jest.requireActual('../docsKnowledgeSource');
  return { ...actual, fetchMintlifyDocsContent: jest.fn() };
});

// Force the retrieval path to use its deterministic keyword fallback (no live
// embeddings call) by making the embeddings client reject.
jest.mock('../../utils/llmClients', () => {
  const actual = jest.requireActual('../../utils/llmClients');
  return {
    ...actual,
    getAzureClient: jest.fn(() => ({
      embeddings: { create: jest.fn().mockRejectedValue(new Error('no embeddings in test')) },
    })),
  };
});

import { describe, it, expect, beforeEach } from '@jest/globals';
import { loadKnowledgeBase, searchKnowledgeBase } from '../chatbotService';
import { fetchMintlifyDocsContent } from '../docsKnowledgeSource';

const MINTLIFY_DOCS = [
  '# Integrations',
  'To connect HubSpot, open Settings then Integrations and click Connect HubSpot.',
  'Authorize AgentWeb in the HubSpot popup to finish linking your CRM.',
  '# Tasks',
  'Create a task from natural language on the Tasks page and click Run to execute it.',
].join('\n');

describe('support chatbot KB sourced from Mintlify (ENG-163)', () => {
  // beforeEach (not beforeAll): the base jest config sets clearMocks:true, which
  // resets mock call records before each test — so build the KB inside beforeEach
  // to keep the fetch-call record observable in the test body.
  beforeEach(async () => {
    (fetchMintlifyDocsContent as jest.Mock).mockResolvedValue(MINTLIFY_DOCS);
    await loadKnowledgeBase();
  });

  it('answers a docs question from Mintlify-sourced content', async () => {
    const results = await searchKnowledgeBase('How do I connect HubSpot?', 3);

    expect(fetchMintlifyDocsContent).toHaveBeenCalled();
    expect(results.length).toBeGreaterThan(0);

    const combined = results.map((c) => c.content).join(' ');
    expect(combined).toContain('connect HubSpot');
    // The answering chunk came from the docs source, not a controller endpoint.
    expect(results.some((c) => c.metadata.source === 'guide')).toBe(true);
  });
});
