/**
 * Emma chatbot cost accounting (calculateCost).
 *
 * calculateCost feeds `estimated_cost` on each message's usage, which flows into
 * incrementUserTokenUsage() — i.e. the user's real per-month cost accounting.
 * It previously carried a hardcoded per-1K table whose gpt-4o prompt rate was
 * 10x the published list price ($25/1M vs the real $2.50/1M), silently
 * overcharging chatbot cost. It must instead price from the single source of
 * truth (llmPricing via computeCostMicroUsd), so it stays consistent with the
 * shadow usage book and ENG-207 normalization.
 */

// ── module-load mocks so importing chatbotService doesn't hit real deps ───────
jest.mock('aws-sdk', () => ({
  DynamoDB: {
    DocumentClient: jest.fn(() => ({
      query: jest.fn(() => ({ promise: jest.fn() })),
      get: jest.fn(() => ({ promise: jest.fn() })),
      put: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({}) })),
      update: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({}) })),
      batchWrite: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({}) })),
    })),
  },
  S3: jest.fn(() => ({
    upload: jest.fn().mockReturnThis(),
    promise: jest.fn().mockResolvedValue({ Location: 'https://s3.example.com/file.jpg' }),
  })),
  config: { update: jest.fn() },
}));
jest.mock('../services/agentModeService', () => ({
  AgentModeService: jest.fn().mockImplementation(() => ({})),
  agentModeService: {},
}));
jest.mock('openai', () => jest.fn().mockImplementation(() => ({
  chat: { completions: { create: jest.fn() } },
})));
jest.mock('@google-cloud/discoveryengine', () => ({
  EngineServiceClient: jest.fn(),
  SearchServiceClient: jest.fn(),
}));
jest.mock('@google-cloud/storage', () => ({ Storage: jest.fn() }));
jest.mock('../controllers/guide', () => ({ getGuide: jest.fn() }));
jest.mock('../controllers/release', () => ({ getReleases: jest.fn() }));
jest.mock('../controllers/api', () => ({ getApiDocs: jest.fn() }));
jest.mock('../controllers/user-guide', () => ({ getUserGuide: jest.fn() }));
jest.mock('../controllers/docsController', () => ({ getUserReleaseNotes: jest.fn() }));
jest.mock('../services/db', () => ({ taskDb: {} }));
jest.mock('../utils/secretsManager', () => ({
  getGCSPPrivateKey: jest.fn(),
  getSecret: jest.fn().mockResolvedValue('fake-key'),
}));
jest.mock('../utils/s3Utils', () => ({
  uploadFileToS3: jest.fn().mockResolvedValue({ success: false }),
}));

import { calculateCost } from '../services/chatbotService';
import { computeCostMicroUsd } from '../services/usageRecorderService';

const ONE_M = 1_000_000;

describe('chatbotService.calculateCost', () => {
  it('prices gpt-4o from the shared pricing book (real $2.50/1M in, $10/1M out — not the old 10x $25)', () => {
    // 1M prompt tokens alone: real list price is $2.50, the old hardcoded table gave $25.
    expect(calculateCost(ONE_M, 0, 'gpt-4o')).toBeCloseTo(2.5, 6);
    // 1M prompt + 1M completion: $2.50 + $10 = $12.50 (old table: $25 + $12.50 = $37.50).
    expect(calculateCost(ONE_M, ONE_M, 'gpt-4o')).toBeCloseTo(12.5, 6);
  });

  it('prices gpt-4.1 from the shared book ($2/1M in, $8/1M out)', () => {
    expect(calculateCost(ONE_M, 0, 'gpt-4.1')).toBeCloseTo(2, 6);
    expect(calculateCost(ONE_M, ONE_M, 'gpt-4.1')).toBeCloseTo(10, 6);
  });

  it('matches computeCostMicroUsd exactly (single source of truth) for a matched model name', () => {
    const cost = calculateCost(12_345, 6_789, 'gpt-4o');
    const expected = computeCostMicroUsd('gpt-4o', 12_345, 6_789) / ONE_M;
    expect(cost).toBeCloseTo(expected, 9);
  });

  it('returns 0 for an unknown model (unchanged behavior)', () => {
    expect(calculateCost(1000, 1000, 'some-unknown-model')).toBe(0);
  });
});
